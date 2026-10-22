/*
 * Deflate-family compression codec, C side. Built with Emscripten as a standalone wasm module
 * (no imports). Built from the zlib Node 24.15 itself bundles -- Chromium's fork of zlib 1.3.1,
 * which is `deps/zlib` in nodejs/node at v24.15.0 -- and not from zlib.org's release: the fork
 * replaces INSERT_STRING with the ANZAC++ hasher in contrib/optimizations/insert_string.h, whose
 * own header says the result "is a valid DEFLATE stream, but will differ from canonical zlib
 * output". It does differ, and by exactly the one byte this family was missing. See "Codecs" in
 * Readme.md for the exact commands.
 *
 * result layout (u32 words): [0] = output pointer, [1] = output length, [2] = detail
 * return: 0 ok, 1 compress error, 3 out of memory, 6 initialization failed
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

#define RES_OK 0
#define RES_COMPRESS 1
#define RES_NOMEM 3
#define RES_INIT 6

/*
 * Node's own default `chunkSize`, which is the output buffer it hands deflate and the reason a
 * single `flush()` here can be one deflate call or several: when a call fills the buffer Node calls
 * deflate again with the same flush flag, and zlib -- having set last_flush to -1 on the way out --
 * opens the block again, so the bytes say where the buffer boundaries fell.
 */
#define OWC_ZLIB_CHUNK 16384

/* A deflate stream is a z_stream the host keeps between calls, as Node keeps one per stream. */
typedef struct {
    z_stream s;
} owc_zlib_stream;

void owc_free(void *ptr) {
    free(ptr);
}

/*
 * Opens a compress stream. `window_bits` is zlib's own: 31 for gzip, 15 for the zlib wrapper,
 * -15 for raw. Node asks for memLevel 8 and Z_DEFAULT_STRATEGY when a caller asks for nothing.
 */
owc_zlib_stream *owc_zlib_stream_new(int window_bits, int level, int mem_level, int strategy,
                                     const uint8_t *dict, size_t dict_len, uint32_t *result) {
    owc_zlib_stream *st;
    int err;
    result[0] = 0;
    result[1] = 0;
    result[2] = 0;
    st = (owc_zlib_stream *)malloc(sizeof(owc_zlib_stream));
    if (!st) return 0;
    memset(&st->s, 0, sizeof(z_stream));
    err = deflateInit2(&st->s, level, Z_DEFLATED, window_bits, mem_level, strategy);
    if (err != Z_OK) {
        result[2] = (uint32_t)err;
        free(st);
        return 0;
    }
    if (dict != 0 && dict_len > 0) {
        err = deflateSetDictionary(&st->s, (const Bytef *)dict, (uInt)dict_len);
        if (err != Z_OK) {
            result[2] = (uint32_t)err;
            deflateEnd(&st->s);
            free(st);
            return 0;
        }
    }
    return st;
}

/*
 * One call against an open stream: `flush` is the zlib constant Node would hand the library --
 * Z_NO_FLUSH for a write, Z_FULL_FLUSH for the `flush()` a caller asked for, Z_FINISH for the end
 * -- and what comes back is everything this call produced, possibly nothing. The output buffer
 * starts at deflateBound() and doubles whenever a call fills it.
 */
int owc_zlib_stream_write(owc_zlib_stream *st, const uint8_t *in, size_t in_len, int flush,
                          uint32_t *result) {
    size_t cap;
    size_t total;
    uint8_t *out;
    uint8_t *chunk;
    int err;
    result[0] = 0;
    result[1] = 0;
    result[2] = 0;
    if (!st) return RES_COMPRESS;

    chunk = (uint8_t *)malloc(OWC_ZLIB_CHUNK);
    cap = OWC_ZLIB_CHUNK + 64;
    out = (uint8_t *)malloc(cap);
    if (!chunk || !out) {
        free(chunk);
        free(out);
        return RES_NOMEM;
    }
    total = 0;

    st->s.next_in = (z_const Bytef *)in;
    st->s.avail_in = (uInt)in_len;

    for (;;) {
        size_t produced;
        st->s.next_out = chunk;
        st->s.avail_out = OWC_ZLIB_CHUNK;
        err = deflate(&st->s, flush);
        if (err == Z_STREAM_ERROR) {
            free(chunk);
            free(out);
            result[2] = (uint32_t)err;
            return RES_COMPRESS;
        }
        produced = OWC_ZLIB_CHUNK - (size_t)st->s.avail_out;
        if (total + produced > cap) {
            uint8_t *grown;
            while (total + produced > cap) cap *= 2;
            grown = (uint8_t *)realloc(out, cap);
            if (!grown) {
                free(chunk);
                free(out);
                return RES_NOMEM;
            }
            out = grown;
        }
        if (produced > 0) memcpy(out + total, chunk, produced);
        total += produced;
        if (st->s.avail_out != 0) break;
        /* The buffer filled: Node calls deflate again with the same flush, and so do we. */
    }

    free(chunk);
    result[0] = (uint32_t)(uintptr_t)out;
    result[1] = (uint32_t)total;
    return RES_OK;
}

void owc_zlib_stream_free(owc_zlib_stream *st) {
    if (!st) return;
    deflateEnd(&st->s);
    free(st);
}

/** zlib's own error word for the message Node puts on a failed deflate-family call. */
const char *owc_zlib_error_string(int code) {
    return zError(code);
}
