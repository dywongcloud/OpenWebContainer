import { gunzipSync } from 'fflate';
import { BROTLI_WASM_GZIP_BASE64 } from './brotli-wasm';
import { ZLIB_WASM_GZIP_BASE64 } from './zlib-wasm';
import { ZSTD_WASM_GZIP_BASE64 } from './zstd-wasm';

/**
 * Host side of the brotli, zstd and deflate codecs.
 *
 * All three are C libraries -- google/brotli, facebook/zstd and the zlib Node bundles -- compiled to
 * WebAssembly with Emscripten as standalone modules, which is what makes the container's output
 * byte-identical to Node's: Node's `zlib` is those same libraries. They are the codecs pure
 * JavaScript cannot carry: a complete brotli encoder in JS is megabytes of source, zstd compression
 * has no JS implementation at all, and no JavaScript deflate is zlib's -- fflate is close enough to
 * pass on most inputs and then misses by a byte on the next one, because the zlib Node builds is
 * Chromium's fork, which hashes strings with the ANZAC++ hasher rather than zlib's own. A wasm module is the same idea the container already uses for sql.js and
 * hash-wasm, and here it runs where that work belongs, in the host realm that has real
 * WebAssembly; the guest reaches it through the zlib capability the way it reaches fflate.
 *
 * The modules are Emscripten output, so an instance is ordinary: malloc to place the input, a call
 * that fills a three-word result block (pointer, length, detail), a copy out, and a free. Memory
 * may grow inside the call, so every read of the module's bytes takes a fresh view. The two import
 * functions the encoder module asks for -- a memory-growth notification and WASI's proc_exit --
 * carry no behaviour the codec needs and are stubbed; the decoder module asks for the notification
 * alone.
 */

/** Pairs the guest sends as `options.params`: (parameter key, parameter value). */
export type CodecParams = Array<[number, number]>;

interface WasmExports {
    memory: WebAssembly.Memory;
    malloc(size: number): number;
    owc_free(ptr: number): void;
    [name: string]: any;
}

const RES_OK = 0;
const RES_COMPRESS = 1;
const RES_DECODE = 2;
const RES_NOMEM = 3;
const RES_MORE_INPUT = 4;
const RES_SET_PARAM = 6;

function failure(Kind: ErrorConstructor | RangeErrorConstructor, code: string, message: string, errno?: number): Error {
    return Object.assign(new Kind(message), errno === undefined ? { code } : { code, errno });
}

/** Signed errno for a brotli decoder error code, which the C enum holds as a negative number. */
const signed = (word: number): number => (word & 0x80000000) !== 0 ? word - 0x100000000 : word;

/**
 * ZSTD_ErrorCode to the name Node puts on `err.code`.
 *
 * zstd's own `ZSTD_getErrorName` answers with the readable string ("Unknown frame descriptor"),
 * not with the enum's name, so the name -- which is what Node reports and what zlib.constants
 * also spells out -- comes from this table of zstd 1.5.7's error enum.
 */
const ZSTD_ERROR_NAMES: Record<number, string> = {
    0: 'ZSTD_error_no_error',
    1: 'ZSTD_error_GENERIC',
    10: 'ZSTD_error_prefix_unknown',
    12: 'ZSTD_error_version_unsupported',
    14: 'ZSTD_error_frameParameter_unsupported',
    16: 'ZSTD_error_frameParameter_windowTooLarge',
    20: 'ZSTD_error_corruption_detected',
    22: 'ZSTD_error_checksum_wrong',
    24: 'ZSTD_error_literals_headerWrong',
    30: 'ZSTD_error_dictionary_corrupted',
    32: 'ZSTD_error_dictionary_wrong',
    34: 'ZSTD_error_dictionaryCreation_failed',
    40: 'ZSTD_error_parameter_unsupported',
    41: 'ZSTD_error_parameter_combination_unsupported',
    42: 'ZSTD_error_parameter_outOfBound',
    44: 'ZSTD_error_tableLog_tooLarge',
    46: 'ZSTD_error_maxSymbolValue_tooLarge',
    48: 'ZSTD_error_maxSymbolValue_tooSmall',
    49: 'ZSTD_error_cannotProduce_uncompressedBlock',
    50: 'ZSTD_error_stabilityCondition_notRespected',
    60: 'ZSTD_error_stage_wrong',
    62: 'ZSTD_error_init_missing',
    64: 'ZSTD_error_memory_allocation',
    66: 'ZSTD_error_workSpace_tooSmall',
    70: 'ZSTD_error_dstSize_tooSmall',
    72: 'ZSTD_error_srcSize_wrong',
    74: 'ZSTD_error_dstBuffer_null',
    80: 'ZSTD_error_noForwardProgress_destFull',
    82: 'ZSTD_error_noForwardProgress_inputEmpty',
    100: 'ZSTD_error_frameIndex_tooLarge',
    102: 'ZSTD_error_seekableIO',
    104: 'ZSTD_error_dstBuffer_wrong',
    105: 'ZSTD_error_srcBuffer_wrong',
    106: 'ZSTD_error_sequenceProducer_failed',
    107: 'ZSTD_error_externalSequences_invalid',
    120: 'ZSTD_error_maxCode'
};

function base64ToBytes(text: string): Uint8Array {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

const modules = new Map<string, WasmExports>();

/** Instantiates a codec once per host and keeps it: a module is immutable and safe to reuse. */
function codecModule(key: string, asset: string): WasmExports {
    const cached = modules.get(key);
    if (cached) return cached;
    const source = gunzipSync(base64ToBytes(asset));
    const instance = new WebAssembly.Instance(new WebAssembly.Module(source), {
        env: { emscripten_notify_memory_growth: () => undefined },
        wasi_snapshot_preview1: {
            proc_exit: (code: number) => {
                throw new Error('wasm module exited: ' + code);
            }
        }
    });
    const exports = instance.exports as unknown as WasmExports;
    modules.set(key, exports);
    return exports;
}

const brotliModule = (): WasmExports => codecModule('brotli', BROTLI_WASM_GZIP_BASE64);
const zlibModule = (): WasmExports => codecModule('zlib', ZLIB_WASM_GZIP_BASE64);
const zstdModule = (): WasmExports => codecModule('zstd', ZSTD_WASM_GZIP_BASE64);

/** Reads a NUL-terminated string the module returned, out of its memory. */
function cstring(exports: WasmExports, name: string, code: number): string {
    const at = (exports[name] as (code: number) => number)(code);
    const bytes = new Uint8Array(exports.memory.buffer);
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) end++;
    let text = '';
    for (let i = at; i < end; i++) text += String.fromCharCode(bytes[i]);
    return text;
}

interface CallResult {
    code: number;
    out: Uint8Array;
    /** The library's own error code for a failed call: a brotli decoder error, or a zstd error. */
    detail: number;
}

/** One codec call: input and parameters into the module's memory, result block out, everything freed. */
function callCodec(
    exports: WasmExports,
    name: string,
    data: Uint8Array,
    params: CodecParams | undefined,
    extra: number[] = []
): CallResult {
    const count = params ? params.length : 0;
    const input = exports.malloc(data.length || 1);
    new Uint8Array(exports.memory.buffer).set(data, input);
    let parameters = 0;
    if (count > 0) {
        parameters = exports.malloc(count * 8);
        const view = new DataView(exports.memory.buffer);
        for (let i = 0; i < count; i++) {
            view.setUint32(parameters + i * 8, params![i][0], true);
            view.setUint32(parameters + i * 8 + 4, params![i][1], true);
        }
    }
    const result = exports.malloc(12);
    let code = 0;
    try {
        code = (exports[name] as (...args: number[]) => number)(input, data.length, parameters, count, ...extra, result);
    } finally {
        exports.owc_free(input);
        if (parameters !== 0) exports.owc_free(parameters);
    }
    /* A fresh view either side of the call: the module may have grown its memory while it ran. */
    const view = new DataView(exports.memory.buffer);
    const pointer = view.getUint32(result, true);
    const length = view.getUint32(result + 4, true);
    const detail = view.getUint32(result + 8, true);
    const out = pointer !== 0 && length > 0 ? new Uint8Array(exports.memory.buffer).slice(pointer, pointer + length) : new Uint8Array(0);
    exports.owc_free(pointer);
    exports.owc_free(result);
    return { code, out, detail };
}

function brotliFailure(code: number, detail: number): Error {
    if (code === RES_MORE_INPUT) return failure(Error, 'Z_BUF_ERROR', 'unexpected end of file', -5);
    if (code === RES_DECODE) {
        return failure(Error, 'ERR_' + cstring(brotliModule(), 'owc_brotli_error_string', detail), 'Decompression failed', signed(detail));
    }
    if (code === RES_SET_PARAM) return failure(Error, 'ERR_ZLIB_INITIALIZATION_FAILED', 'Initialization failed');
    if (code === RES_NOMEM) return failure(Error, 'Z_MEM_ERROR', 'not enough memory', -4);
    return failure(Error, 'ERR_BROTLI_COMPRESSION_FAILED', 'Compression failed');
}

function zstdFailure(code: number, detail: number): Error {
    if (code === RES_DECODE || code === RES_COMPRESS) {
        const exports = zstdModule();
        /* `detail` is the raw failing result; the code is what Node puts on `errno`. */
        const errno = exports.owc_zstd_error_code(detail) as number;
        const name = ZSTD_ERROR_NAMES[errno] ?? 'ZSTD_error_GENERIC';
        return failure(Error, name, cstring(exports, 'owc_zstd_error_string', errno), errno);
    }
    if (code === RES_SET_PARAM) return failure(Error, 'ERR_ZLIB_INITIALIZATION_FAILED', 'Setting parameter failed');
    if (code === RES_NOMEM) return failure(Error, 'Z_MEM_ERROR', 'not enough memory', -4);
    return failure(Error, 'ERR_ZSTD_COMPRESSION_FAILED', 'Compression failed');
}

/** Compresses with Brotli. `params` holds BROTLI_PARAM_* pairs, applied over quality 11, window 22. */
export function brotliCompress(data: Uint8Array, params?: CodecParams): Uint8Array {
    const result = callCodec(brotliModule(), 'owc_brotli_compress', data, params);
    if (result.code === RES_OK) return result.out;
    throw brotliFailure(result.code, result.detail);
}

/** Decompresses a Brotli stream. `params` holds BROTLI_DECODER_PARAM_* pairs: 0 or 1. */
export function brotliDecompress(data: Uint8Array, params?: CodecParams): Uint8Array {
    const result = callCodec(brotliModule(), 'owc_brotli_decompress', data, params);
    if (result.code === RES_OK) return result.out;
    throw brotliFailure(result.code, result.detail);
}

/**
 * Compresses with Zstandard. `params` holds ZSTD_c_* pairs.
 *
 * Both `chunkSize` and `streamed` are visible in the bytes. `chunkSize` is the output buffer Node
 * hands zstd (its Z_DEFAULT_CHUNK, 16 KiB) and so decides where block boundaries fall. `streamed`
 * is the stream's shape: a stream hands the input over with ZSTD_e_continue and finishes with an
 * empty ZSTD_e_end, while the synchronous calls hand the whole input over with ZSTD_e_end, which is
 * what lets zstd write the content size into the frame header.
 */
export function zstdCompress(data: Uint8Array, params?: CodecParams, chunkSize = 0, streamed = false): Uint8Array {
    const result = callCodec(zstdModule(), 'owc_zstd_compress', data, params, [chunkSize, streamed ? 1 : 0]);
    if (result.code === RES_OK) return result.out;
    throw zstdFailure(result.code, result.detail);
}

/** Decompresses a Zstandard frame. `params` holds ZSTD_d_* pairs. */
export function zstdDecompress(data: Uint8Array, params?: CodecParams): Uint8Array {
    const result = callCodec(zstdModule(), 'owc_zstd_decompress', data, params);
    if (result.code === RES_OK) return result.out;
    throw zstdFailure(result.code, result.detail);
}

/** Whether zstd knows this parameter key, so an unknown one can be named the way Node names it. */
export function zstdParamKnown(compress: boolean, key: number): boolean {
    const exports = zstdModule();
    return (compress ? exports.owc_zstd_cparam_ok(key) : exports.owc_zstd_dparam_ok(key)) === 1;
}

/** The largest Zstandard frame `size` input bytes can produce: exposed for callers that size a buffer. */
export function zstdCompressBound(size: number): number {
    return zstdModule().owc_zstd_compress_bound(size) as number;
}

/** The zlib error word to the name Node puts on `err.code`; `zError` gives the message. */
const ZLIB_ERROR_NAMES: Record<number, string> = {
    [-1]: 'Z_ERRNO',
    [-2]: 'Z_STREAM_ERROR',
    [-3]: 'Z_DATA_ERROR',
    [-4]: 'Z_MEM_ERROR',
    [-5]: 'Z_BUF_ERROR',
    [-6]: 'Z_VERSION_ERROR'
};

function deflateFailure(code: number, detail: number): Error {
    if (code === RES_NOMEM) return failure(Error, 'Z_MEM_ERROR', 'not enough memory', -4);
    if (code === RES_SET_PARAM) {
        return failure(Error, 'ERR_ZLIB_INITIALIZATION_FAILED', 'Initialization failed');
    }
    const word = signed(detail);
    const name = ZLIB_ERROR_NAMES[word] ?? 'Z_DATA_ERROR';
    return failure(Error, name, cstring(zlibModule(), 'owc_zlib_error_string', word), word);
}

/** The windowBits zlib spells each deflate-family framing as: gzip is the zlib window plus 16. */
const DEFLATE_WINDOW_BITS: Record<string, number> = { gzip: 31, deflate: 15, 'deflate-raw': -15 };

export interface DeflateStreamOptions {
    format: string;
    level: number;
    dictionary?: Uint8Array;
}

/** Opens a deflate-family compress stream. `level` is zlib's own scale: -1 asks for its default. */
export function deflateStreamOpen(options: DeflateStreamOptions): number {
    const exports = zlibModule();
    const windowBits = DEFLATE_WINDOW_BITS[options.format];
    if (windowBits === undefined) throw failure(Error, 'ERR_INVALID_ARG_VALUE', `unknown zlib stream format: ${options.format}`);
    const dictionary = options.dictionary;
    let dict = 0;
    if (dictionary && dictionary.length > 0) {
        dict = exports.malloc(dictionary.length);
        new Uint8Array(exports.memory.buffer).set(dictionary, dict);
    }
    const result = exports.malloc(12);
    let handle = 0;
    try {
        handle = (exports.owc_zlib_stream_new as (...args: number[]) => number)(
            windowBits,
            Number.isFinite(options.level) ? Math.trunc(options.level) : -1,
            8,
            0,
            dict,
            dictionary ? dictionary.length : 0,
            result
        );
    } finally {
        if (dict !== 0) exports.owc_free(dict);
    }
    if (handle === 0) {
        const detail = new DataView(exports.memory.buffer).getUint32(result + 8, true);
        exports.owc_free(result);
        throw deflateFailure(RES_SET_PARAM, detail);
    }
    exports.owc_free(result);
    const id = nextStreamId++;
    streams.set(id, { kind: 'deflate', handle });
    return id;
}

/**
 * Compresses a whole buffer of deflate-family bytes.
 *
 * This is the synchronous and callback forms, which hand the library everything at once under
 * Z_FINISH; a stream is the same context driven one call at a time instead.
 */
export function deflateCompress(
    format: string,
    data: Uint8Array,
    level: number,
    dictionary?: Uint8Array
): Uint8Array {
    const id = deflateStreamOpen({ format, level, dictionary });
    try {
        return codecStreamWrite(id, data, 4);
    } finally {
        codecStreamClose(id);
    }
}

/**
 * A brotli, zstd or deflate stream: the module's own context, kept alive between the writes that feed it.
 *
 * A stream is not one call. Node hands each write to the library separately, a `flush()` is a call
 * of its own, and the finish is another; each one is visible in the bytes, because a flush ends the
 * block or meta-block that is open. So the stream keeps its context here and the guest drives it one
 * call at a time, rather than buffering the input and compressing it in one go at the end.
 */
interface LiveStream {
    kind: StreamKind;
    handle: number;
}

type StreamKind = 'brotli' | 'zstd' | 'deflate';

const streams = new Map<number, LiveStream>();
let nextStreamId = 1;

const moduleFor = (kind: StreamKind): WasmExports =>
    kind === 'brotli' ? brotliModule() : kind === 'zstd' ? zstdModule() : zlibModule();

const failFor = (kind: StreamKind, code: number, detail: number): Error =>
    kind === 'brotli' ? brotliFailure(code, detail) : kind === 'zstd' ? zstdFailure(code, detail) : deflateFailure(code, detail);

/** The module's own per-call stream entry points, by codec: they all take (handle, input, length, op, result). */
const STREAM_WRITE: Record<StreamKind, string> = {
    brotli: 'owc_brotli_stream_write',
    zstd: 'owc_zstd_stream_write',
    deflate: 'owc_zlib_stream_write'
};

const STREAM_FREE: Record<StreamKind, string> = {
    brotli: 'owc_brotli_stream_free',
    zstd: 'owc_zstd_stream_free',
    deflate: 'owc_zlib_stream_free'
};

/** Opens a stream and returns the id the guest drives it with. `params` are set before any input. */
export function codecStreamOpen(kind: 'brotli' | 'zstd', params?: CodecParams, chunkSize = 0): number {
    const exports = moduleFor(kind);
    const count = params ? params.length : 0;
    let parameters = 0;
    if (count > 0) {
        parameters = exports.malloc(count * 8);
        const view = new DataView(exports.memory.buffer);
        for (let i = 0; i < count; i++) {
            view.setUint32(parameters + i * 8, params![i][0], true);
            view.setUint32(parameters + i * 8 + 4, params![i][1], true);
        }
    }
    const result = exports.malloc(12);
    let handle = 0;
    try {
        handle =
            kind === 'brotli'
                ? (exports.owc_brotli_stream_new as (p: number, n: number, c: number) => number)(parameters, count, chunkSize)
                : (exports.owc_zstd_stream_new as (p: number, n: number, c: number, r: number) => number)(
                      parameters,
                      count,
                      chunkSize,
                      result
                  );
    } finally {
        if (parameters !== 0) exports.owc_free(parameters);
    }
    if (handle === 0) {
        const detail = new DataView(exports.memory.buffer).getUint32(result + 8, true);
        exports.owc_free(result);
        throw failFor(kind, RES_SET_PARAM, detail);
    }
    exports.owc_free(result);
    const id = nextStreamId++;
    streams.set(id, { kind, handle });
    return id;
}

/**
 * One call against an open stream: `op` is the operation Node would hand the library -- process,
 * flush or finish -- and what comes back is everything that call produced, possibly nothing.
 */
export function codecStreamWrite(id: number, data: Uint8Array, op: number): Uint8Array {
    const entry = streams.get(id);
    if (!entry) throw failure(Error, 'ERR_STREAM_DESTROYED', 'zlib stream is closed');
    const exports = moduleFor(entry.kind);
    const input = exports.malloc(data.length || 1);
    new Uint8Array(exports.memory.buffer).set(data, input);
    const result = exports.malloc(12);
    let code = 0;
    try {
        const write = exports[STREAM_WRITE[entry.kind]] as (h: number, i: number, n: number, o: number, r: number) => number;
        code = write(entry.handle, input, data.length, op, result);
    } finally {
        exports.owc_free(input);
    }
    /* A fresh view either side of the call: the module may have grown its memory while it ran. */
    const view = new DataView(exports.memory.buffer);
    const pointer = view.getUint32(result, true);
    const length = view.getUint32(result + 4, true);
    const detail = view.getUint32(result + 8, true);
    const out =
        pointer !== 0 && length > 0 ? new Uint8Array(exports.memory.buffer).slice(pointer, pointer + length) : new Uint8Array(0);
    exports.owc_free(pointer);
    exports.owc_free(result);
    if (code !== RES_OK) throw failFor(entry.kind, code, detail);
    return out;
}

/** Releases a stream's context. Harmless on an id already closed. */
export function codecStreamClose(id: number): void {
    const entry = streams.get(id);
    if (!entry) return;
    streams.delete(id);
    const exports = moduleFor(entry.kind);
    const free = exports[STREAM_FREE[entry.kind]] as (h: number) => void;
    free(entry.handle);
}
