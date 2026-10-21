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

void owc_free(void *ptr) {
    free(ptr);
}
