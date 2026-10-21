/*
 * Brotli one-shot codec, C side. Built with Emscripten as a standalone wasm module (no imports),
 * so the host can instantiate it directly. Built from google/brotli v1.1.0; see "Codecs" in
 * Readme.md for the exact commands. The built wasm, gzipped and written as base64, is what ships.
 *
 * result layout (u32 words): [0] = output pointer, [1] = output length, [2] = detail
 * params: optional array of (key, value) u32 pairs applied with BrotliEncoderSetParameter.
 * return: 0 ok, 1 compress error, 2 decode error, 3 out of memory, 4 needs more input
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <brotli/encode.h>
#include <brotli/decode.h>

#define RES_OK 0
#define RES_COMPRESS 1
#define RES_DECODE 2
#define RES_NOMEM 3
#define RES_MORE_INPUT 4
#define RES_SET_PARAM 6

int owc_brotli_compress(const uint8_t *in, size_t in_len, const uint32_t *params, size_t param_count,
                        uint32_t *result) {
    uint8_t *out;
    size_t cap = in_len == 0 ? 8 : BrotliEncoderMaxCompressedSize(in_len);
    size_t avail_in = in_len;
    size_t avail_out;
    const uint8_t *next_in = in;
    uint8_t *next_out;
    BrotliEncoderState *state;
    size_t i;
    result[0] = 0;
    result[1] = 0;
    result[2] = 0;
    if (cap == 0) cap = 8;
    out = (uint8_t *)malloc(cap);
    if (!out) return RES_NOMEM;

    state = BrotliEncoderCreateInstance(NULL, NULL, NULL);
    if (!state) {
        free(out);
        return RES_NOMEM;
    }
    BrotliEncoderSetParameter(state, BROTLI_PARAM_QUALITY, 11);
    BrotliEncoderSetParameter(state, BROTLI_PARAM_LGWIN, 22);
    for (i = 0; i < param_count; i++) {
        BrotliEncoderSetParameter(state, (BrotliEncoderParameter)params[i * 2], (uint32_t)params[i * 2 + 1]);
    }

    next_out = out;
    avail_out = cap;
    if (!BrotliEncoderCompressStream(state, BROTLI_OPERATION_FINISH, &avail_in, &next_in, &avail_out, &next_out,
                                     NULL) ||
        BrotliEncoderHasMoreOutput(state)) {
        BrotliEncoderDestroyInstance(state);
        free(out);
        return RES_COMPRESS;
    }
    BrotliEncoderDestroyInstance(state);
    result[0] = (uint32_t)(uintptr_t)out;
    result[1] = (uint32_t)(next_out - out);
    return RES_OK;
}

int owc_brotli_decompress(const uint8_t *in, size_t in_len, const uint32_t *params, size_t param_count,
                          uint32_t *result) {
    BrotliDecoderState *state;
    BrotliDecoderResult status;
    uint8_t *out;
    size_t cap = in_len == 0 ? 16 : in_len * 3;
    size_t used = 0;
    size_t avail_in = in_len;
    const uint8_t *next_in = in;
    size_t i;
    result[0] = 0;
    result[1] = 0;
    result[2] = 0;
    if (cap < 64) cap = 64;
    out = (uint8_t *)malloc(cap);
    if (!out) return RES_NOMEM;

    state = BrotliDecoderCreateInstance(NULL, NULL, NULL);
    if (!state) {
        free(out);
        return RES_NOMEM;
    }
    /* The decoder takes two parameters only: ring-buffer reallocation (0) and large window (1). */
    for (i = 0; i < param_count; i++) {
        uint32_t key = params[i * 2];
        if (key != BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION && key != BROTLI_DECODER_PARAM_LARGE_WINDOW) {
            BrotliDecoderDestroyInstance(state);
            free(out);
            return RES_SET_PARAM;
        }
        BrotliDecoderSetParameter(state, (BrotliDecoderParameter)key, (uint32_t)params[i * 2 + 1]);
    }
    for (;;) {
        size_t avail_out = cap - used;
        uint8_t *next_out = out + used;
        status = BrotliDecoderDecompressStream(state, &avail_in, &next_in, &avail_out, &next_out, NULL);
        used = (size_t)(next_out - out);
        if (status == BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT) {
            uint8_t *bigger = (uint8_t *)realloc(out, cap * 2);
            if (!bigger) {
                BrotliDecoderDestroyInstance(state);
                free(out);
                return RES_NOMEM;
            }
            out = bigger;
            cap *= 2;
            continue;
        }
        break;
    }
    if (status != BROTLI_DECODER_RESULT_SUCCESS) {
        int code = (int)BrotliDecoderGetErrorCode(state);
        BrotliDecoderDestroyInstance(state);
        free(out);
        result[2] = (uint32_t)code;
        return status == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT ? RES_MORE_INPUT : RES_DECODE;
    }
    BrotliDecoderDestroyInstance(state);
    result[0] = (uint32_t)(uintptr_t)out;
    result[1] = (uint32_t)used;
    return RES_OK;
}

const char *owc_brotli_error_string(int code) {
    return BrotliDecoderErrorString((BrotliDecoderErrorCode)code);
}

/*
 * Streaming: an encoder the host keeps between calls, fed exactly the way Node feeds its own.
 *
 * A stream is not one call: Node hands each write to the library with BROTLI_OPERATION_PROCESS, a
 * `flush()` is a call with BROTLI_OPERATION_FLUSH, and the end is one with BROTLI_OPERATION_FINISH.
 * The operations are visible in the bytes -- a flush ends the meta-block that is open, which is what
 * makes a flushed stream longer than the same input compressed in one go -- so matching Node means
 * keeping the encoder and making the same calls.
 *
 * `chunk` is Node's `chunkSize` output buffer and `used` its offset into it, which survives from one
 * write to the next until the buffer fills, as there.
 */
typedef struct {
    BrotliEncoderState *state;
    uint8_t *out;
    size_t chunk;
    size_t used;
} owc_brotli_stream;

owc_brotli_stream *owc_brotli_stream_new(const uint32_t *params, size_t param_count, size_t chunk_size) {
    owc_brotli_stream *s;
    size_t i;
    s = (owc_brotli_stream *)malloc(sizeof(owc_brotli_stream));
    if (!s) return 0;
    s->state = BrotliEncoderCreateInstance(NULL, NULL, NULL);
    if (!s->state) {
        free(s);
        return 0;
    }
    s->chunk = chunk_size == 0 ? 16384 : chunk_size;
    if (s->chunk < 64) s->chunk = 64;
    s->used = 0;
    s->out = (uint8_t *)malloc(s->chunk);
    if (!s->out) {
        BrotliEncoderDestroyInstance(s->state);
        free(s);
        return 0;
    }
    BrotliEncoderSetParameter(s->state, BROTLI_PARAM_QUALITY, 11);
    BrotliEncoderSetParameter(s->state, BROTLI_PARAM_LGWIN, 22);
    for (i = 0; i < param_count; i++) {
        BrotliEncoderSetParameter(s->state, (BrotliEncoderParameter)params[i * 2], (uint32_t)params[i * 2 + 1]);
    }
    return s;
}

void owc_brotli_stream_free(owc_brotli_stream *s) {
    if (!s) return;
    BrotliEncoderDestroyInstance(s->state);
    free(s->out);
    free(s);
}

/*
 * One write, or one flush, or the finish. `op` is the BrotliEncoderOperation. The bytes this call
 * produced are returned as one buffer the caller frees; they are copied out because Node's own
 * buffer is handed on and replaced once it fills.
 */
int owc_brotli_stream_write(owc_brotli_stream *s, const uint8_t *in, size_t in_len, size_t op, uint32_t *result) {
    size_t avail_in = in_len;
    const uint8_t *next_in = in;
    uint8_t *acc;
    size_t acc_cap;
    size_t acc_len = 0;
    result[0] = 0;
    result[1] = 0;
    result[2] = 0;
    acc_cap = s->chunk + 64;
    acc = (uint8_t *)malloc(acc_cap);
    if (!acc) return RES_NOMEM;
    for (;;) {
        size_t avail_out = s->chunk - s->used;
        size_t avail_out_after;
        uint8_t *next_out = s->out + s->used;
        for (;;) {
            size_t before = avail_out;
            size_t produced;
            BrotliEncoderCompressStream(s->state, (BrotliEncoderOperation)op, &avail_in, &next_in, &avail_out,
                                        &next_out, NULL);
            produced = before - avail_out;
            if (produced > 0) {
                if (acc_len + produced > acc_cap) {
                    uint8_t *bigger = (uint8_t *)realloc(acc, acc_cap + produced + s->chunk);
                    if (!bigger) {
                        free(acc);
                        return RES_NOMEM;
                    }
                    acc = bigger;
                    acc_cap += produced + s->chunk;
                }
                memcpy(acc + acc_len, next_out - produced, produced);
                acc_len += produced;
            }
            s->used += produced;
            /* Drain while there is more to give and room to give it in; a full buffer goes back up. */
            if (avail_out == 0 || !BrotliEncoderHasMoreOutput(s->state)) break;
        }
        avail_out_after = avail_out;
        if (avail_out_after == 0 || s->used >= s->chunk) s->used = 0;
        if (avail_out_after == 0) continue;
        break;
    }
    result[0] = (uint32_t)(uintptr_t)acc;
    result[1] = (uint32_t)acc_len;
    return RES_OK;
}

void owc_free(void *ptr) {
    free(ptr);
}
