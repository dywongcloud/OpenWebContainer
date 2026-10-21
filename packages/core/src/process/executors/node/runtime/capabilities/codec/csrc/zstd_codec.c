/*
 * Zstd one-shot codec, C side. Built with Emscripten as a standalone wasm module (no imports).
 * Built from facebook/zstd v1.5.7; see "Codecs" in Readme.md for the exact commands. The built wasm,
 * gzipped and written as base64, is what ships next to this file.
 *
 * result layout (u32 words): [0] = output pointer, [1] = output length, [2] = detail
 * params: optional array of (key, value) u32 pairs applied with ZSTD_CCtx_setParameter /
 * ZSTD_DCtx_setParameter. The level, when given, is applied first as ZSTD_c_compressionLevel.
 * return: 0 ok, 1 compress error, 2 decode error, 3 out of memory, 5 unknown parameter,
 *         6 setting the parameter failed
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <zstd.h>

#define RES_OK 0
#define RES_COMPRESS 1
#define RES_DECODE 2
#define RES_NOMEM 3
#define RES_BAD_PARAM 5
#define RES_SET_PARAM 6

/* Node's own default piece size for a zstd stream: 256 KiB. */
#define OWC_ZSTD_DEFAULT_CHUNK 16384

size_t owc_zstd_compress_bound(size_t in_len) {
    return ZSTD_compressBound(in_len);
}

int owc_zstd_compress(const uint8_t *in, size_t in_len, const uint32_t *params, size_t param_count,
                      size_t chunk_size, size_t mode, uint32_t *result) {
    ZSTD_CCtx *ctx;
    size_t cap = ZSTD_compressBound(in_len);
    uint8_t *out;
    size_t used = 0;
    size_t i;
    result[0] = 0;
    result[1] = 0;
    result[2] = 0;
    if (cap == 0) cap = 64;
    out = (uint8_t *)malloc(cap);
    if (!out) return RES_NOMEM;

    ctx = ZSTD_createCCtx();
    if (!ctx) {
        free(out);
        return RES_NOMEM;
    }
    for (i = 0; i < param_count; i++) {
        ZSTD_bounds bounds = ZSTD_cParam_getBounds((ZSTD_cParameter)params[i * 2]);
        size_t rc;
        if (bounds.error) {
            ZSTD_freeCCtx(ctx);
            free(out);
            return RES_BAD_PARAM;
        }
        rc = ZSTD_CCtx_setParameter(ctx, (ZSTD_cParameter)params[i * 2], (int)params[i * 2 + 1]);
        if (ZSTD_isError(rc)) {
            ZSTD_freeCCtx(ctx);
            free(out);
            result[2] = (uint32_t)rc;
            return RES_SET_PARAM;
        }
    }
    /*
     * Fed the way Node feeds its stream: in `chunk_size` pieces with ZSTD_e_continue, then a last
     * empty call with ZSTD_e_end. A single ZSTD_e_end over the whole input is not the same bytes:
     * zstd then knows where the input ends while it is still buffering the first block, and for an
     * input past one chunk that changes what it emits. 256 KiB is Node's own default chunk size;
     * a different piece size changes nothing, only whether the input arrives in one piece or more.
     */
    /*
     * The loop Node's synchronous path runs: the whole input handed to ZSTD_compressStream2 with
     * ZSTD_e_end, into an output buffer of `chunk_size` bytes (Node's Z_DEFAULT_CHUNK, 16 KiB), a
     * fresh buffer each time one fills, until the frame is finished.
     *
     * Both details are visible in the bytes. The output buffer's size decides how much zstd can
     * emit per call, and so where the block boundaries fall: feeding a 300 KB input in one call
     * with a 16 KiB output buffer and with a 4 MB one gives different frames. And the single
     * ZSTD_e_end call carrying the whole input is what lets zstd write the frame's content size,
     * which a stream fed piece by piece leaves unknown.
     */
    {
        ZSTD_outBuffer output;
        ZSTD_inBuffer input;
        size_t chunk = chunk_size == 0 ? OWC_ZSTD_DEFAULT_CHUNK : chunk_size;
        size_t input_pos = 0;
        int ending = mode == 0;
        if (chunk == 0) chunk = 1;
        for (;;) {
            size_t remaining;
            while (cap < used + chunk) {
                uint8_t *bigger = (uint8_t *)realloc(out, cap + chunk);
                if (!bigger) {
                    ZSTD_freeCCtx(ctx);
                    free(out);
                    return RES_NOMEM;
                }
                out = bigger;
                cap += chunk;
            }
            output.dst = out + used;
            output.size = chunk;
            output.pos = 0;
            input.src = in + input_pos;
            input.size = in_len - input_pos;
            input.pos = 0;
            remaining = ZSTD_compressStream2(ctx, &output, &input, ending ? ZSTD_e_end : ZSTD_e_continue);
            used += output.pos;
            input_pos += input.pos;
            if (ZSTD_isError(remaining)) {
                result[2] = (uint32_t)remaining;
                ZSTD_freeCCtx(ctx);
                free(out);
                return RES_COMPRESS;
            }
            /*
             * `remaining == 0` means the frame is finished only after a ZSTD_e_end call: with
             * ZSTD_e_continue, zstd reports 0 as soon as it has buffered the input, having
             * emitted nothing. So a stream spends its input with ZSTD_e_continue and then
             * finishes with ZSTD_e_end, which is exactly what Node's stream does.
             */
            if (ending && remaining == 0) break;
            if (mode == 1 && !ending && input_pos >= in_len) ending = 1;
        }
    }
    ZSTD_freeCCtx(ctx);
    result[0] = (uint32_t)(uintptr_t)out;
    result[1] = (uint32_t)used;
    return RES_OK;
}

int owc_zstd_decompress(const uint8_t *in, size_t in_len, const uint32_t *params, size_t param_count,
                        uint32_t *result) {
    ZSTD_DCtx *ctx;
    ZSTD_inBuffer input;
    uint8_t *out;
    size_t cap = in_len == 0 ? 64 : in_len * 4;
    size_t used = 0;
    size_t i;
    result[0] = 0;
    result[1] = 0;
    result[2] = 0;
    if (cap < 64) cap = 64;
    if (in_len == 0) return RES_OK;
    out = (uint8_t *)malloc(cap);
    if (!out) return RES_NOMEM;

    ctx = ZSTD_createDCtx();
    if (!ctx) {
        free(out);
        return RES_NOMEM;
    }
    for (i = 0; i < param_count; i++) {
        ZSTD_bounds bounds = ZSTD_dParam_getBounds((ZSTD_dParameter)params[i * 2]);
        size_t rc;
        if (bounds.error) {
            ZSTD_freeDCtx(ctx);
            free(out);
            return RES_BAD_PARAM;
        }
        rc = ZSTD_DCtx_setParameter(ctx, (ZSTD_dParameter)params[i * 2], (int)params[i * 2 + 1]);
        if (ZSTD_isError(rc)) {
            ZSTD_freeDCtx(ctx);
            free(out);
            result[2] = (uint32_t)rc;
            return RES_SET_PARAM;
        }
    }
    input.src = in;
    input.size = in_len;
    input.pos = 0;
    for (;;) {
        ZSTD_outBuffer output;
        size_t remaining;
        output.dst = out + used;
        output.size = cap - used;
        output.pos = 0;
        remaining = ZSTD_decompressStream(ctx, &output, &input);
        used += output.pos;
        if (ZSTD_isError(remaining)) {
            result[2] = (uint32_t)remaining;
            ZSTD_freeDCtx(ctx);
            free(out);
            return RES_DECODE;
        }
        if (remaining == 0) break;
        if (input.pos >= input.size && output.pos == 0) {
            /* The frame ended before it was complete: the source is short. */
            result[2] = (uint32_t)(0 - (size_t)ZSTD_error_srcSize_wrong);
            ZSTD_freeDCtx(ctx);
            free(out);
            return RES_DECODE;
        }
        {
            uint8_t *bigger = (uint8_t *)realloc(out, cap * 2);
            if (!bigger) {
                ZSTD_freeDCtx(ctx);
                free(out);
                return RES_NOMEM;
            }
            out = bigger;
            cap *= 2;
        }
    }
    ZSTD_freeDCtx(ctx);
    result[0] = (uint32_t)(uintptr_t)out;
    result[1] = (uint32_t)used;
    return RES_OK;
}

/* Whether a parameter key is one zstd knows, so the host can name the offending key as Node does. */
int owc_zstd_cparam_ok(int key) {
    return ZSTD_cParam_getBounds((ZSTD_cParameter)key).error ? 0 : 1;
}

int owc_zstd_dparam_ok(int key) {
    return ZSTD_dParam_getBounds((ZSTD_dParameter)key).error ? 0 : 1;
}

/* The error code behind a failed call, which is what Node reports as `errno`. */
size_t owc_zstd_error_code(size_t result) {
    return (size_t)ZSTD_getErrorCode(result);
}

/*
 * Streaming: a context the host keeps between calls, fed exactly the way Node feeds its own.
 *
 * A stream cannot be a one-shot call: Node hands each write to the library separately and only
 * finishes at the end, and a `flush()` in between is a call of its own. Those calls are visible in
 * the bytes -- zstd ends a block, or a whole frame, where the stream was flushed -- so the only way
 * to match Node is to keep the context and make the same calls.
 *
 * `chunk` is Node's `chunkSize`: the size of the output buffer it hands the library, and `used`
 * Node's own offset into that buffer, which survives from one write to the next until the buffer
 * fills. Both are kept because how much room the library gets per call can show in the output.
 */
typedef struct {
    ZSTD_CCtx *cctx;
    uint8_t *out;
    size_t chunk;
    size_t used;
} owc_zstd_stream;

owc_zstd_stream *owc_zstd_stream_new(const uint32_t *params, size_t param_count, size_t chunk_size,
                                    uint32_t *result) {
    owc_zstd_stream *s;
    size_t i;
    result[0] = 0;
    result[1] = 0;
    result[2] = 0;
    s = (owc_zstd_stream *)malloc(sizeof(owc_zstd_stream));
    if (!s) return 0;
    s->cctx = ZSTD_createCCtx();
    if (!s->cctx) {
        free(s);
        return 0;
    }
    s->chunk = chunk_size == 0 ? OWC_ZSTD_DEFAULT_CHUNK : chunk_size;
    if (s->chunk < 64) s->chunk = 64;
    s->used = 0;
    s->out = (uint8_t *)malloc(s->chunk ? s->chunk : 1);
    if (!s->out) {
        ZSTD_freeCCtx(s->cctx);
        free(s);
        return 0;
    }
    for (i = 0; i < param_count; i++) {
        ZSTD_bounds bounds = ZSTD_cParam_getBounds((ZSTD_cParameter)params[i * 2]);
        size_t rc;
        if (bounds.error) {
            ZSTD_freeCCtx(s->cctx);
            free(s->out);
            free(s);
            return 0;
        }
        rc = ZSTD_CCtx_setParameter(s->cctx, (ZSTD_cParameter)params[i * 2], (int)params[i * 2 + 1]);
        if (ZSTD_isError(rc)) {
            result[2] = (uint32_t)rc;
            ZSTD_freeCCtx(s->cctx);
            free(s->out);
            free(s);
            return 0;
        }
    }
    return s;
}

void owc_zstd_stream_free(owc_zstd_stream *s) {
    if (!s) return;
    ZSTD_freeCCtx(s->cctx);
    free(s->out);
    free(s);
}

/*
 * One write, or one flush, or the finish: the same loop Node's `processChunk` runs over one chunk.
 * `op` is the ZSTD_EndDirective. The bytes produced by this call are returned as one buffer, which
 * the caller frees; they are copied out because Node's buffer is handed on and replaced.
 */
int owc_zstd_stream_write(owc_zstd_stream *s, const uint8_t *in, size_t in_len, size_t op, uint32_t *result) {
    const uint8_t *next_in = in;
    size_t avail_in = in_len;
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
        ZSTD_inBuffer input;
        ZSTD_outBuffer output;
        size_t avail_out = s->chunk - s->used;
        size_t avail_out_after;
        size_t remaining;
        input.src = next_in;
        input.size = avail_in;
        input.pos = 0;
        output.dst = s->out + s->used;
        output.size = avail_out;
        output.pos = 0;
        remaining = ZSTD_compressStream2(s->cctx, &output, &input, (ZSTD_EndDirective)op);
        if (output.pos > 0) {
            if (acc_len + output.pos > acc_cap) {
                uint8_t *bigger = (uint8_t *)realloc(acc, acc_cap + output.pos + s->chunk);
                if (!bigger) {
                    free(acc);
                    return RES_NOMEM;
                }
                acc = bigger;
                acc_cap += output.pos + s->chunk;
            }
            memcpy(acc + acc_len, s->out + s->used, output.pos);
            acc_len += output.pos;
        }
        s->used += output.pos;
        next_in += input.pos;
        avail_in -= input.pos;
        if (ZSTD_isError(remaining)) {
            free(acc);
            result[2] = (uint32_t)remaining;
            return RES_COMPRESS;
        }
        avail_out_after = avail_out - output.pos;
        /* Node replaces the buffer once it is full, and keeps going while the last call filled it. */
        if (avail_out_after == 0 || s->used >= s->chunk) s->used = 0;
        if (avail_out_after == 0) continue;
        break;
    }
    result[0] = (uint32_t)(uintptr_t)acc;
    result[1] = (uint32_t)acc_len;
    return RES_OK;
}

const char *owc_zstd_error_name(size_t code) {
    return ZSTD_getErrorName(code);
}

const char *owc_zstd_error_string(size_t code) {
    return ZSTD_getErrorString((ZSTD_ErrorCode)code);
}

void owc_free(void *ptr) {
    free(ptr);
}
