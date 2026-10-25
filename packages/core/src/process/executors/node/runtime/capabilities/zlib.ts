import { CapabilityHandler } from './types';
import { FlateErrorCode, inflateSync } from 'fflate';
import {
    CodecParams,
    brotliCompress,
    brotliDecompress,
    codecStreamClose,
    codecStreamOpen,
    codecStreamWrite,
    deflateCompress,
    deflateStreamOpen,
    zstdCompress,
    zstdDecompress,
    zstdParamKnown
} from './codec';

/**
 * Host operations for the zlib family. Compression of the deflate family -- gzip, deflate and
 * deflate-raw -- is the zlib Node bundles, compiled to wasm: Chromium's fork of zlib 1.3.1, whose
 * deflate output is Node's byte for byte, which no JavaScript deflate is. Decompression stays on
 * fflate, which does the raw DEFLATE work (its `inflateSync` is a raw stream), wrapped in the framing
 * zlib checks and fflate does not: CRC-32 and size for gzip, Adler-32 for zlib, multi-member gzip,
 * the zero-byte stop rule, with zlib's error codes and wording. Brotli and zstd come from wasm
 * codecs, which Node also builds on the same C libraries. Bytes cross the capability boundary as
 * base64 strings because capability arguments are JSON.
 */

type Bytes = Uint8Array;

const Z_NEED_DICT = 2;
const Z_DATA_ERROR = -3;
const Z_BUF_ERROR = -5;

function zlibError(code: string, errno: number, message: string): Error {
    return Object.assign(new Error(message), { code, errno });
}

function dataError(message: string): Error {
    return zlibError('Z_DATA_ERROR', Z_DATA_ERROR, message);
}

function eofError(): Error {
    return zlibError('Z_BUF_ERROR', Z_BUF_ERROR, 'unexpected end of file');
}

/** Maps an fflate failure onto the zlib error Node raises for the same stream. */
function mapFlateError(error: unknown): Error {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if (code === FlateErrorCode.UnexpectedEOF) return eofError();
    if (code === FlateErrorCode.InvalidHeader) return dataError('incorrect header check');
    if (code === FlateErrorCode.InvalidLengthLiteral) return dataError('invalid literal/length code');
    if (code === FlateErrorCode.InvalidDistance) return dataError('invalid distance too far back');
    return dataError(typeof message === 'string' ? message : String(error));
}

const CRC_TABLE: Uint32Array = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32Of(bytes: Bytes): number {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function adler32Of(bytes: Bytes): number {
    let a = 1;
    let b = 0;
    let i = 0;
    while (i < bytes.length) {
        const end = Math.min(i + 5552, bytes.length);
        for (; i < end; i++) {
            a += bytes[i];
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
}

function u32le(bytes: Bytes, at: number): number {
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function u32be(bytes: Bytes, at: number): number {
    return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function concatBytes(parts: Bytes[]): Bytes {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}

/*
 * fflate never compares the two length words of a stored block, and zlib always does: LEN and its
 * complement NLEN, read straight after the block header. Where fflate takes a zero pair as an empty
 * stored block and carries on into whatever follows, zlib stops there -- so a frame corrupted in its
 * deflate body is reported as 'invalid stored block lengths' on the host and as something else here,
 * different again depending on how far fflate got before it gave up.
 *
 * This walks the block structure the way zlib does -- bit by bit, blocks in order, Huffman blocks
 * decoded far enough to find where each ends -- and answers whether a stored block whose two length
 * words disagree is the first thing zlib would reject. It raises nothing else: an invalid block
 * type, a bad Huffman code, a distance reaching back past the start of the output or an end of
 * input is left to fflate, which already agrees with Node on all of them. It runs only once fflate
 * has failed, so a stream that inflates costs nothing.
 */
const WALK_STOP = new Error('deflate walk abandoned');

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Bits of a deflate stream, least significant bit of each byte first, as zlib reads them. */
class BitStream {
    private readonly data: Bytes;
    private at = 0;
    private bit = 0;
    /** Bytes of output the blocks so far have produced: how far back a distance may reach. */
    written = 0;

    constructor(data: Bytes) {
        this.data = data;
    }

    bits(count: number): number {
        let value = 0;
        for (let i = 0; i < count; i++) {
            if (this.at >= this.data.length) throw WALK_STOP;
            value |= ((this.data[this.at] >> this.bit) & 1) << i;
            if (++this.bit === 8) {
                this.bit = 0;
                this.at++;
            }
        }
        return value;
    }

    /** Discards the rest of the current byte: a stored block starts on a byte boundary. */
    align(): void {
        if (this.bit !== 0) {
            this.bit = 0;
            this.at++;
        }
    }

    skip(count: number): void {
        this.align();
        this.at += count;
        if (this.at > this.data.length) throw WALK_STOP;
    }
}

/** A canonical Huffman table: one symbol per code, ordered by code length as zlib builds it. */
interface HuffmanTable {
    counts: Int32Array;
    symbols: Int32Array;
}

function huffmanTable(lengths: number[]): HuffmanTable {
    const counts = new Int32Array(16);
    for (const length of lengths) if (length > 0) counts[length]++;
    let left = 1;
    for (let len = 1; len <= 15; len++) {
        left = (left << 1) - counts[len];
        if (left < 0) throw WALK_STOP;
    }
    const offsets = new Int32Array(16);
    for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len] + counts[len];
    const symbols = new Int32Array(lengths.length);
    for (let sym = 0; sym < lengths.length; sym++) if (lengths[sym] > 0) symbols[offsets[lengths[sym]]++] = sym;
    return { counts, symbols };
}

function decodeSymbol(stream: BitStream, table: HuffmanTable): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
        code |= stream.bits(1);
        const count = table.counts[len];
        if (code - first < count) return table.symbols[index + (code - first)];
        index += count;
        first = (first + count) << 1;
        code <<= 1;
    }
    throw WALK_STOP;
}

const FIXED_LITERALS = huffmanTable(
    (() => {
        const lengths = new Array(288).fill(8);
        for (let sym = 0; sym < 144; sym++) lengths[sym] = 8;
        for (let sym = 144; sym < 256; sym++) lengths[sym] = 9;
        for (let sym = 256; sym < 280; sym++) lengths[sym] = 7;
        for (let sym = 280; sym < 288; sym++) lengths[sym] = 8;
        return lengths;
    })()
);
const FIXED_DISTANCES = huffmanTable(new Array(30).fill(5));

function dynamicTables(stream: BitStream): HuffmanTable[] {
    const literals = stream.bits(5) + 257;
    const distances = stream.bits(5) + 1;
    const codeLengths = stream.bits(4) + 4;
    const lengths = new Array(19).fill(0);
    for (let i = 0; i < codeLengths; i++) lengths[CODE_LENGTH_ORDER[i]] = stream.bits(3);
    const table = huffmanTable(lengths);
    const all = new Array(literals + distances).fill(0);
    let at = 0;
    while (at < all.length) {
        const sym = decodeSymbol(stream, table);
        if (sym < 16) {
            all[at++] = sym;
        } else if (sym === 16) {
            if (at === 0) throw WALK_STOP;
            const repeat = 3 + stream.bits(2);
            const value = all[at - 1];
            for (let i = 0; i < repeat; i++) all[at++] = value;
        } else if (sym === 17) {
            for (let i = 0; i < 3 + stream.bits(3); i++) all[at++] = 0;
        } else {
            for (let i = 0; i < 11 + stream.bits(7); i++) all[at++] = 0;
        }
    }
    if (at > all.length) throw WALK_STOP;
    return [huffmanTable(all.slice(0, literals)), huffmanTable(all.slice(literals))];
}

/** Walks one Huffman-coded block to its end-of-block symbol, counting the output it stands for. */
function walkBlock(stream: BitStream, literals: HuffmanTable, distances: HuffmanTable): void {
    for (;;) {
        const sym = decodeSymbol(stream, literals);
        if (sym < 256) {
            stream.written++;
            continue;
        }
        if (sym === 256) return;
        const index = sym - 257;
        if (index >= LENGTH_BASE.length) throw WALK_STOP;
        const length = LENGTH_BASE[index] + stream.bits(LENGTH_EXTRA[index]);
        const distanceIndex = decodeSymbol(stream, distances);
        if (distanceIndex >= DISTANCE_BASE.length) throw WALK_STOP;
        const distance = DISTANCE_BASE[distanceIndex] + stream.bits(DISTANCE_EXTRA[distanceIndex]);
        /* A match reaching back further than anything written is zlib's own error, and fflate's. */
        if (distance > stream.written) throw WALK_STOP;
        stream.written += length;
    }
}

function storedBlockLengthMismatch(bytes: Bytes): boolean {
    const stream = new BitStream(bytes);
    try {
        for (;;) {
            const last = stream.bits(1);
            const type = stream.bits(2);
            if (type === 0) {
                stream.align();
                const length = stream.bits(16);
                const complement = stream.bits(16);
                if (length !== (~complement & 0xffff)) return true;
                stream.written += length;
                stream.skip(length);
            } else if (type === 1) {
                walkBlock(stream, FIXED_LITERALS, FIXED_DISTANCES);
            } else if (type === 2) {
                const tables = dynamicTables(stream);
                walkBlock(stream, tables[0], tables[1]);
            } else {
                return false;
            }
            if (last !== 0) return false;
        }
    } catch (error) {
        if (error === WALK_STOP) return false;
        throw error;
    }
}

/** Raw DEFLATE inflate. Empty input is an unexpected end, as zlib reports it. */
function inflateRaw(bytes: Bytes, dictionary?: Bytes): Bytes {
    if (bytes.length === 0) throw eofError();
    try {
        return inflateSync(bytes, dictionary ? { dictionary } : undefined);
    } catch (error) {
        if (storedBlockLengthMismatch(bytes)) throw dataError('invalid stored block lengths');
        throw mapFlateError(error);
    }
}

function inflatesCleanly(bytes: Bytes, dictionary?: Bytes): boolean {
    try {
        inflateSync(bytes, dictionary ? { dictionary } : undefined);
        return true;
    } catch {
        return false;
    }
}

/**
 * Length of the deflate stream at the start of `bytes`: the shortest prefix that inflates without an
 * unexpected end. fflate ignores bytes after the final block, so this bisection is exact. It runs only
 * on failure paths, where the trailer position cannot be read from the output alone.
 */
function deflateStreamLength(bytes: Bytes, dictionary?: Bytes): number {
    let lo = 1;
    let hi = bytes.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (inflatesCleanly(bytes.subarray(0, mid), dictionary)) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

function skipZeroTerminated(data: Bytes, pos: number): number {
    let at = pos;
    while (at < data.length && data[at] !== 0) at++;
    if (at >= data.length) throw eofError();
    return at + 1;
}

/** Index of the deflate payload of the gzip member at `start`, validated in zlib's order. */
function gzipPayloadStart(data: Bytes, start: number): number {
    if (data.length - start < 2) throw eofError();
    if (data[start] !== 0x1f || data[start + 1] !== 0x8b) throw dataError('incorrect header check');
    if (data.length - start < 10) throw eofError();
    if (data[start + 2] !== 8) throw dataError('unknown compression method');
    const flags = data[start + 3];
    if (flags & 0xe0) throw dataError('unknown header flags set');
    let pos = start + 10;
    if (flags & 0x04) {
        if (pos + 2 > data.length) throw eofError();
        pos += 2 + (data[pos] | (data[pos + 1] << 8));
    }
    if (flags & 0x08) pos = skipZeroTerminated(data, pos);
    if (flags & 0x10) pos = skipZeroTerminated(data, pos);
    if (flags & 0x02) pos += 2;
    if (pos > data.length) throw eofError();
    return pos;
}

/**
 * One gzip member. fflate ignores bytes after the final block, so the output is the member's alone; the
 * trailer is the first position, at or after the shortest possible deflate stream, whose CRC-32 and size
 * match. That first match is the true trailer even when the next member repeats this one's checksum.
 * When nothing matches, the exact deflate end is found by bisection, which gives zlib's error.
 */
function gunzipMember(data: Bytes, payload: number): { out: Bytes; end: number } {
    const out = inflateRaw(data.subarray(payload));
    const crc = crc32Of(out);
    const size = out.length % 0x100000000;
    for (let at = payload + 2; at + 8 <= data.length; at++) {
        if (u32le(data, at) === crc && u32le(data, at + 4) === size) return { out, end: at + 8 };
    }
    const trailer = payload + deflateStreamLength(data.subarray(payload));
    if (trailer + 8 > data.length) throw eofError();
    if (u32le(data, trailer) !== crc) throw dataError('incorrect data check');
    throw dataError('incorrect length check');
}

/** gunzip: concatenated members are read in order; a zero byte after a member ends the stream, as in zlib. */
function gunzipAll(data: Bytes): Bytes {
    const parts: Bytes[] = [];
    let start = 0;
    for (;;) {
        const member = gunzipMember(data, gzipPayloadStart(data, start));
        parts.push(member.out);
        start = member.end;
        if (start >= data.length || data[start] === 0) break;
    }
    return parts.length === 1 ? parts[0] : concatBytes(parts);
}

/** inflate: zlib framing, Adler-32 trailer, optional preset dictionary. */
function zlibInflate(data: Bytes, dictionary?: Bytes): Bytes {
    if (data.length < 2) throw eofError();
    const cmf = data[0];
    const flg = data[1];
    if (((cmf << 8) | flg) % 31 !== 0) throw dataError('incorrect header check');
    if ((cmf & 0x0f) !== 8) throw dataError('unknown compression method');
    if (cmf >>> 4 > 7) throw dataError('invalid window size');
    let payload = 2;
    if (flg & 0x20) {
        if (data.length < 6) throw eofError();
        if (dictionary === undefined) throw zlibError('Z_NEED_DICT', Z_NEED_DICT, 'Missing dictionary');
        if (adler32Of(dictionary) !== u32be(data, 2)) throw zlibError('Z_NEED_DICT', Z_NEED_DICT, 'Bad dictionary');
        payload = 6;
    }
    const out = inflateRaw(data.subarray(payload), dictionary);
    const sum = adler32Of(out);
    for (let at = payload + 2; at + 4 <= data.length; at++) {
        if (u32be(data, at) === sum) return out;
    }
    const trailer = payload + deflateStreamLength(data.subarray(payload), dictionary);
    if (trailer + 4 > data.length) throw eofError();
    throw dataError('incorrect data check');
}

/** unzip: gzip when the first two bytes are the gzip magic, zlib otherwise (as zlib's auto-detect). */
function unzipAll(data: Bytes, dictionary?: Bytes): Bytes {
    return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b ? gunzipAll(data) : zlibInflate(data, dictionary);
}

/** The (key, value) pairs a guest collected from `options.params`, already validated there. */
function paramPairs(value: unknown): CodecParams | undefined {
    if (!Array.isArray(value)) return undefined;
    const pairs: CodecParams = [];
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        pairs.push([Number(entry[0]), Number(entry[1])]);
    }
    return pairs.length > 0 ? pairs : undefined;
}

/** zstd names the offending key when a parameter is unknown; the guest cannot know zstd's set. */
function zstdParams(value: unknown, compress: boolean): CodecParams | undefined {
    const pairs = paramPairs(value);
    if (!pairs) return undefined;
    for (const [key] of pairs) {
        if (!zstdParamKnown(compress, key)) {
            throw Object.assign(new RangeError(key + ' is not a valid zstd parameter'), { code: 'ERR_ZSTD_INVALID_PARAM' });
        }
    }
    return pairs;
}

function inflateBytes(format: string, data: Bytes, dictionary?: Bytes, params?: CodecParams): Bytes {
    switch (format) {
        case 'gzip':
            return gunzipAll(data);
        case 'deflate':
            return zlibInflate(data, dictionary);
        case 'deflate-raw':
            return inflateRaw(data, dictionary);
        case 'unzip':
            return unzipAll(data, dictionary);
        case 'brotli':
            return brotliDecompress(data, params);
        case 'zstd':
            return zstdDecompress(data, params, dictionary);
        default:
            throw new Error(`unknown zlib format: ${format}`);
    }
}

/** The formats whose compression is zlib's own; `unzip` is a decompress-only format. */
const DEFLATE_FORMATS = new Set(['gzip', 'deflate', 'deflate-raw']);

/**
 * Compresses one buffer. Level -1 is zlib's default, which it picks itself; brotli and zstd take
 * parameters instead, and `chunkSize` and `streamed` are zstd's own two shapes.
 */
function deflateBytes(
    format: string,
    data: Bytes,
    level: number,
    dictionary?: Bytes,
    params?: CodecParams,
    chunkSize = 0,
    streamed = false
): Bytes {
    switch (format) {
        case 'gzip':
        case 'deflate':
        case 'deflate-raw':
            return deflateCompress(format, data, typeof level === 'number' ? level : -1, dictionary);
        case 'brotli':
            return brotliCompress(data, params);
        case 'zstd':
            return zstdCompress(data, params, chunkSize, streamed, dictionary);
        default:
            throw new Error(`unknown zlib format: ${format}`);
    }
}

function base64ToBytes(text: string): Bytes {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

function bytesToBase64(bytes: Bytes): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

const argBytes = (value: unknown): Bytes => base64ToBytes(typeof value === 'string' ? value : '');
const argDictionary = (value: unknown): Bytes | undefined => (typeof value === 'string' ? base64ToBytes(value) : undefined);

/** Zlib host operations: compress and decompress whole buffers, and drive a compress stream. */
export const ZLIB_CAPABILITIES: Record<string, CapabilityHandler> = {
    'zlib.compress': (args) => {
        const format = String(args.format);
        const params = format === 'zstd' ? zstdParams(args.params, true) : paramPairs(args.params);
        const chunk = typeof args.chunkSize === 'number' && args.chunkSize > 0 ? Math.trunc(args.chunkSize) : 0;
        return bytesToBase64(
            deflateBytes(
                format,
                argBytes(args.data),
                typeof args.level === 'number' ? args.level : -1,
                argDictionary(args.dictionary),
                params,
                chunk,
                args.streamed === true
            )
        );
    },
    'zlib.decompress': (args) => {
        const format = String(args.format);
        const params = format === 'zstd' ? zstdParams(args.params, false) : paramPairs(args.params);
        return bytesToBase64(inflateBytes(format, argBytes(args.data), argDictionary(args.dictionary), params));
    },
    /* A compress stream, driven one write, flush or finish at a time. */
    'zlib.streamOpen': (args) => {
        const format = String(args.format);
        if (DEFLATE_FORMATS.has(format)) {
            return deflateStreamOpen({
                format,
                level: typeof args.level === 'number' ? args.level : -1,
                dictionary: argDictionary(args.dictionary)
            });
        }
        if (format !== 'brotli' && format !== 'zstd') throw new Error(`unknown zlib stream format: ${format}`);
        const params = format === 'zstd' ? zstdParams(args.params, true) : paramPairs(args.params);
        const chunk = typeof args.chunkSize === 'number' && args.chunkSize > 0 ? Math.trunc(args.chunkSize) : 0;
        return codecStreamOpen(format, params, chunk, argDictionary(args.dictionary));
    },
    'zlib.streamWrite': (args) => bytesToBase64(codecStreamWrite(Number(args.id), argBytes(args.data), Number(args.op))),
    'zlib.streamClose': (args) => {
        codecStreamClose(Number(args.id));
        return true;
    }
};
