/**
 * The PNG encoder. The IDAT stream is a zlib wrapper around a real deflate -- fflate's, at level 6,
 * which is what the guest has and the only deflate a shim with no WebAssembly can run -- so a canvas
 * this shim writes is a compressed PNG of about the add-on's size rather than a stored one twice it.
 * The zlib stream is not libpng's byte for byte, because no JavaScript deflate is zlib's, and libpng's
 * adaptive row filtering is not reproduced either: every scanline is written with filter type 0
 * (None), so a `filters` option in PngConfig is accepted and ignored, and `palette` is refused
 * outright.
 *
 * The chunks are the add-on's own: IHDR, then a bKGD of opaque white, then IDAT, then IEND. cairo
 * writes that bKGD -- 00ff 00ff 00ff, six bytes, the RGB of colour type 6 as three 16-bit values --
 * into every PNG it makes, whatever the canvas holds, measured on canvas 3.2.3 at 4x4, 2x2 and
 * 20x10 over transparent, red and blue pixels alike, so a PNG this shim writes carries it too.
 */
import { zlibSync } from 'fflate';

const CRC_TABLE = (function (): Uint32Array {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes: Uint8Array, from: number, to: number): number {
    let c = 0xffffffff;
    for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** A chunk type and its payload, appended with its length and CRC-32. */
function pushChunk(out: number[], type: string, payload: Uint8Array): void {
    out.push((payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff, (payload.length >>> 8) & 0xff, payload.length & 0xff);
    for (let i = 0; i < 4; i++) out.push(type.charCodeAt(i));
    for (let i = 0; i < payload.length; i++) out.push(payload[i]);
    const body = new Uint8Array(4 + payload.length);
    for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
    body.set(payload, 4);
    const crc = crc32(body, 0, body.length);
    out.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
}

/** cairo's bKGD: opaque white, three 16-bit values, the shape colour type 6 takes. */
const BKGD_WHITE = new Uint8Array([0x00, 0xff, 0x00, 0xff, 0x00, 0xff]);

/* --- row filtering ------------------------------------------------------ *
 * libpng picks a filter per row, and the add-on inherits the choice: a solid row is Sub, every row
 * after it Up, and a row that begins a new block of colour Paeth. Its rule, reproduced here, is the
 * sum of the filtered bytes read as distances from zero -- a byte below 128 counts itself, a byte
 * from 128 up counts 256 minus itself -- and the lowest sum wins, the first of them on a tie.
 *
 * The add-on's own `filters` config does not reach libpng: a 64x64 gradient is 233 bytes whether a
 * caller asks for PNG_FILTER_NONE, PNG_FILTER_UP, PNG_FILTER_SUB or says nothing at all (measured on
 * canvas 3.2.3), so there is nothing for the shim to honour and every row gets the adaptive choice.
 */

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Writes `row` filtered by `filter` into `out`, given the row above it and its own left neighbour,
 * and returns that filter's score: one pass over the row does both, because the encoder tries five
 * filters per row and a guest measures that in seconds on a large canvas.
 */
function applyFilter(filter: number, row: Uint8Array, above: Uint8Array, out: Uint8Array): number {
    const stride = row.length;
    let sum = 0;
    for (let i = 0; i < stride; i++) {
        const left = i >= 4 ? row[i - 4] : 0;
        const up = above[i];
        const corner = i >= 4 ? above[i - 4] : 0;
        const v = filter === 1 ? row[i] - left
            : filter === 2 ? row[i] - up
                : filter === 3 ? row[i] - ((left + up) >> 1)
                    : filter === 4 ? row[i] - paeth(left, up, corner)
                        : row[i];
        const byte = v & 0xff;
        out[i] = byte;
        sum += byte < 128 ? byte : 256 - byte;
    }
    return sum;
}

/** The filtered scanlines: one leading filter byte per row, then the row the filter picked. */
function filteredRows(rgba: Uint8Array, width: number, height: number): Uint8Array {
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    const row = new Uint8Array(stride);
    const above = new Uint8Array(stride);
    const candidate = new Uint8Array(stride);
    const best = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        row.set(rgba.subarray(y * stride, y * stride + stride));
        let bestFilter = 0;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const filter of [0, 1, 2, 3, 4]) {
            const score = applyFilter(filter, row, above, candidate);
            if (score < bestScore) {
                bestScore = score;
                bestFilter = filter;
                best.set(candidate);
                /* Nothing can beat a row that filters to all zeroes, and most rows do. */
                if (score === 0) break;
            }
        }
        const at = y * (stride + 1);
        raw[at] = bestFilter;
        raw.set(best, at + 1);
        above.set(row);
    }
    return raw;
}

/**
 * Encodes straight RGBA bytes, row 0 first, as an 8-bit RGBA PNG (colour type 6, no interlace).
 * `resolution`, when given, becomes a pHYs chunk in pixels per metre.
 */
export function encodePNG(rgba: Uint8Array, width: number, height: number, resolution?: number): Uint8Array {
    const stride = width * 4;
    const raw = filteredRows(rgba, width, height);
    const ihdr = new Uint8Array(13);
    ihdr[0] = (width >>> 24) & 0xff;
    ihdr[1] = (width >>> 16) & 0xff;
    ihdr[2] = (width >>> 8) & 0xff;
    ihdr[3] = width & 0xff;
    ihdr[4] = (height >>> 24) & 0xff;
    ihdr[5] = (height >>> 16) & 0xff;
    ihdr[6] = (height >>> 8) & 0xff;
    ihdr[7] = height & 0xff;
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const out: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    pushChunk(out, 'IHDR', ihdr);
    pushChunk(out, 'bKGD', BKGD_WHITE);
    if (typeof resolution === 'number' && resolution > 0) {
        const ppm = Math.round(resolution / 0.0254);
        const phys = new Uint8Array(9);
        phys[0] = (ppm >>> 24) & 0xff;
        phys[1] = (ppm >>> 16) & 0xff;
        phys[2] = (ppm >>> 8) & 0xff;
        phys[3] = ppm & 0xff;
        phys[4] = (ppm >>> 24) & 0xff;
        phys[5] = (ppm >>> 16) & 0xff;
        phys[6] = (ppm >>> 8) & 0xff;
        phys[7] = ppm & 0xff;
        phys[8] = 1;
        pushChunk(out, 'pHYs', phys);
    }
    pushChunk(out, 'IDAT', zlibSync(raw, { level: 6 }));
    pushChunk(out, 'IEND', new Uint8Array(0));
    return new Uint8Array(out);
}
