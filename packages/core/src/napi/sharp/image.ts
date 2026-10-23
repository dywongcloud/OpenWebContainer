/*
 * The pixel operations of the sharp shim: an image is 8-bit unsigned, interleaved, row-major from the top
 * left, of 1 (grey), 2 (grey and alpha), 3 (sRGB) or 4 (sRGB and alpha) channels, never premultiplied.
 *
 * This is the part libvips does with SIMD and a thread pool; here it is plain JavaScript, and the numbers
 * are the ones vips_shrink/vips_reduce produce: an integer box average for the whole part of a reduction,
 * then the named kernel for what is left, with the kernel widened by the reduce factor. A resample is
 * separable, so a resize runs across rows and then down columns.
 */
import { badExtractArea } from './errors';

/** The only band counts an image can have, which is also what the codecs' own Image type allows. */
export type ChannelCount = 1 | 2 | 3 | 4;

export interface Image {
    width: number;
    height: number;
    /** 1 grey, 2 grey and alpha, 3 sRGB, 4 sRGB and alpha. */
    channels: ChannelCount;
    data: Uint8Array;
}

export function createImage(width: number, height: number, channels: ChannelCount, fill?: number): Image {
    const data = new Uint8Array(width * height * channels);
    if (fill !== undefined) data.fill(fill);
    return { width, height, channels, data };
}

export function cloneImage(image: Image): Image {
    return { width: image.width, height: image.height, channels: image.channels, data: image.data.slice() };
}

/** Copy `src` into `dst` at (left, top); the parts of `src` outside `dst` are dropped. */
export function blit(dst: Image, src: Image, left: number, top: number): void {
    /*
     * A negative offset -- which is what an embed onto a canvas smaller than the image asks for --
     * pushes the top-left corner of the source off the destination, so both the source read and the
     * destination write have to start inside their own image.
     */
    const sx = left < 0 ? -left : 0;
    const sy = top < 0 ? -top : 0;
    const dx = left < 0 ? 0 : left;
    const dy = top < 0 ? 0 : top;
    const w = Math.min(src.width - sx, dst.width - dx);
    const h = Math.min(src.height - sy, dst.height - dy);
    for (let y = 0; y < h; y++) {
        const from = ((y + sy) * src.width + sx) * src.channels;
        const to = ((y + dy) * dst.width + dx) * dst.channels;
        dst.data.set(src.data.subarray(from, from + w * src.channels), to);
    }
}

/* ------------------------------------------------------------------ kernels */

interface Kernel {
    /** Half the width of the filter before it is widened by the reduce factor. */
    support: number;
    /**
     * The support libvips counts the taps of a reduce with: `vips_reduce_get_points`
     * (libvips 8.15, resample/reduceh.cpp) returns `2 * rint(support * shrink) + 1`. It counts
     * LINEAR with a support of 1, and NEAREST with none at all -- a nearest reduce is one tap,
     * wherever the output pixel lands. A reduce takes this many taps whether the kernel reaches
     * that far or not, which is most of what separates its pixels from a plain convolution's.
     */
    reduce: number;
    weight: (x: number) => number;
}

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

function lanczos(a: number): Kernel {
    /* libvips' filter<VIPS_KERNEL_LANCZOS2> tests x >= -a && x <= a, inclusive, and its
       sinc_filter is 1 at 0 and sin(pi*x)/(pi*x) elsewhere. */
    return { support: a, reduce: a, weight: (x) => (Math.abs(x) <= a ? sinc(x) * sinc(x / a) : 0) };
}

/** Catmull-Rom, the two-lobe cubic libvips calls VIPS_KERNEL_CUBIC: its cubic_filter with B = 0, C = 1/2. */
const cubic: Kernel = {
    support: 2,
    reduce: 2,
    weight: (x) => {
        const t = Math.abs(x);
        if (t < 1) return 1.5 * t * t * t - 2.5 * t * t + 1;
        if (t < 2) return -0.5 * t * t * t + 2.5 * t * t - 4 * t + 2;
        return 0;
    }
};

/** Mitchell-Netravali with b = c = 1/3, libvips' cubic_filter with B = C = 1/3. */
const mitchell: Kernel = {
    support: 2,
    reduce: 2,
    weight: (x) => {
        const t = Math.abs(x);
        const b = 1 / 3;
        const c = 1 / 3;
        if (t < 1) return ((12 - 9 * b - 6 * c) * t * t * t + (-18 + 12 * b + 6 * c) * t * t + (6 - 2 * b)) / 6;
        if (t < 2) {
            return ((-b - 6 * c) * t * t * t + (6 * b + 30 * c) * t * t + (-12 * b - 48 * c) * t + (8 * b + 24 * c)) / 6;
        }
        return 0;
    }
};

/** libvips' filter<VIPS_KERNEL_LINEAR>: 1 - |x| for |x| < 1, and exactly 0 at 1. */
const linear: Kernel = { support: 1, reduce: 1, weight: (x) => (Math.abs(x) < 1 ? 1 - Math.abs(x) : 0) };

const KERNELS: Record<string, Kernel> = {
    nearest: { support: 0.5, reduce: 0, weight: () => 1 },
    linear,
    cubic,
    mitchell,
    lanczos2: lanczos(2),
    lanczos3: lanczos(3)
};

export function kernelNames(): string[] {
    return Object.keys(KERNELS);
}

/* ----------------------------------------------------------------- resample */

/** libvips' default `gap` for vips_resize: 2.0 (resample/resize.c, vips_resize_init). */
const RESIZE_GAP = 2;

/**
 * How many output rows a vips_reducev strip holds. libvips generates a reduced image in strips,
 * and vips_reducev_gen restarts its running sum at the top of each one, so the vertical position
 * is not one sum over the whole height the way the horizontal one is. Measured against sharp
 * 0.33.5 on a 64x64 -> 60x60 nearest reduction: strip heights of 4, 8 and 16 all reproduce the
 * source row every output row takes, and 1, 2, 32 and 64 do not; 16 is the one that leaves the
 * fewest differing images over a 3658-case sweep of sizes, fits and kernels.
 *
 * 16 is the strip of an image the caller handed in as pixels -- a raw buffer or a `create` -- which
 * is what the sweep above measured. An image a loader decoded is walked in shorter strips, see
 * REDUCEV_STRIP_DECODED.
 */
const REDUCEV_STRIP = 16;

/**
 * The same strip for an image sharp decoded out of a file, which is not the strip of the same pixels
 * handed in raw: the two differ by one source row at some output rows, and only under `nearest`,
 * whose single tap turns the last bit of the sum into a whole pixel. Measured against sharp 0.33.5
 * over a 64x64 png, a 64x64 jpeg and the same pixels as raw, reduced to n x n for every n from 8 to
 * 64: the decoded image's output rows are the ones a sum restarted every 10 rows takes (0 of 57
 * widths wrong, where 16 leaves 17 and every other height from 1 to 80 leaves at least 9), and the
 * raw one's are the ones a sum restarted every 16 takes (0 of 57). The same 10 holds at 32x32,
 * 48x48, 96x96 and 128x128 (0 of 25, 41, 89 and 121 widths), for 1-, 3- and 4-channel sources, for
 * `fill`, `contain` and a pre-extract, for a jpeg decoded at 1/2 as well as at 1/1, and at every
 * `sharp.concurrency()`; it does not depend on the output format either. What separates the two is
 * the input: a memory image and a loaded one do not hand the reduce the same strips. It is only
 * taken where the reduce's sum starts at its own row 0 -- see where it is chosen in resizeImage.
 */
const REDUCEV_STRIP_DECODED = 10;

/**
 * libvips' vips_shrinkh / vips_shrinkv: blocks of `n` pixels averaged into one. The output is sized
 * with ceil, the edge pixel is copied in so the last block is a full one, and the average is the
 * integer one C computes: (sum + n / 2) / n, truncated.
 */
function boxShrink(image: Image, n: number, horizontal: boolean): Image {
    const srcSize = horizontal ? image.width : image.height;
    const other = horizontal ? image.height : image.width;
    const dstSize = Math.ceil(srcSize / n);
    const ch = image.channels;
    const out = createImage(horizontal ? dstSize : other, horizontal ? other : dstSize, ch);
    const half = Math.floor(n / 2);
    for (let o = 0; o < other; o++) {
        for (let d = 0; d < dstSize; d++) {
            for (let c = 0; c < ch; c++) {
                let sum = 0;
                for (let i = 0; i < n; i++) {
                    const s = Math.min(srcSize - 1, d * n + i);
                    const k = horizontal ? (o * srcSize + s) * ch + c : (s * other + o) * ch + c;
                    sum += image.data[k];
                }
                const j = horizontal ? (o * dstSize + d) * ch + c : (d * other + o) * ch + c;
                out.data[j] = Math.floor((sum + half) / n);
            }
        }
    }
    return out;
}
/**
 * libvips' vips_subsample: every `n`th pixel, and the output sized with floor. vips_resize uses it
 * for the integer part of a NEAREST reduction, where a box average would invent pixels.
 */
function subsampleAxis(image: Image, n: number, horizontal: boolean): Image {
    const srcSize = horizontal ? image.width : image.height;
    const other = horizontal ? image.height : image.width;
    const dstSize = Math.floor(srcSize / n);
    const ch = image.channels;
    const out = createImage(horizontal ? dstSize : other, horizontal ? other : dstSize, ch);
    for (let o = 0; o < other; o++) {
        for (let d = 0; d < dstSize; d++) {
            for (let c = 0; c < ch; c++) {
                const i = horizontal ? (o * srcSize + d * n) * ch + c : (d * n * other + o) * ch + c;
                const j = horizontal ? (o * dstSize + d) * ch + c : (d * other + o) * ch + c;
                out.data[j] = image.data[i];
            }
        }
    }
    return out;
}

/**
 * The two precisions libvips keeps, both of them part of what a reduce's pixels are: 6 bits for the
 * sub-pixel phase a precomputed coefficient table is chosen by, 12 for the fixed-point coefficients
 * in the table itself (vips/interpolate.h, VIPS_TRANSFORM_SHIFT and VIPS_INTERPOLATE_SHIFT).
 */
const TRANSFORM_SHIFT = 6;
const TRANSFORM_SCALE = 1 << TRANSFORM_SHIFT;
const INTERPOLATE_SHIFT = 12;
const INTERPOLATE_SCALE = 1 << INTERPOLATE_SHIFT;

/** C's rint(): to nearest, ties to even. libvips counts taps with it, not with round(). */
function rint(x: number): number {
    const f = Math.floor(x);
    const d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
}

/** libvips' vips_reduce_get_points: how many taps a reduce takes at this shrink. */
function reducePoints(kernel: Kernel, shrink: number): number {
    return 2 * rint(kernel.reduce * shrink) + 1;
}

/** libvips' calculate_coefficients: the kernel at every tap of the window, made to sum to one. */
function reduceMask(kernel: Kernel, n: number, shrink: number, at: number): number[] {
    const half = at + n / 2 - 1;
    const c: number[] = new Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const v = kernel.weight((i - half) / shrink);
        c[i] = v;
        sum += v;
    }
    if (sum !== 0) {
        for (let i = 0; i < n; i++) c[i] /= sum;
    }
    return c;
}

/**
 * libvips' matrixs[]: the same coefficients as fixed-point integers, one set for each of the 65
 * phases, truncated the way C's (short) truncates. The truncation is what stops the coefficients
 * summing to exactly one, and that is libvips' own arithmetic rather than a rounding to hide.
 */
function reduceTable(kernel: Kernel, n: number, shrink: number): number[][] {
    const table: number[][] = [];
    for (let phase = 0; phase <= TRANSFORM_SCALE; phase++) {
        const c = reduceMask(kernel, n, shrink, phase / TRANSFORM_SCALE);
        for (let i = 0; i < n; i++) c[i] = Math.trunc(c[i] * INTERPOLATE_SCALE);
        table.push(c);
    }
    return table;
}

/**
 * One axis of libvips' vips_reduceh / vips_reducev, the arithmetic and all: a window of a fixed
 * number of taps wherever the output pixel falls in the source, coefficients chosen by the phase of
 * that position rounded to 1/64, a sum of fixed-point coefficients rounded by adding half of
 * 1/4096 and shifting, and an image padded at both ends by copying the edge pixel.
 *
 * `extra` is how many source pixels the rounding of the output size leaves unused, before the box
 * shrink below has had its share of them; libvips moves the origin inside the source by half what
 * is left so they are discarded equally from both ends.
 *
 * `clock` is the row the vertical reduce is first asked for, and it is not always 0: vips_reducev
 * generates on demand and clocks its running sum to `r->top`, the top of the region it has been
 * asked to fill, so a request that starts part-way down the image restarts the sum there. The
 * last bit of that sum is which source row an output row lands on, so the same output row takes a
 * different source row depending on where the request began. A crop is what makes the request
 * start part-way down: sharp crops after it resizes, and libvips hands the reduce only the strip
 * of rows the crop keeps. Measured against sharp 0.33.5 on 64x64 -> cover 40xH nearest: the
 * reduce's row 7 is source row 11 when the crop starts at row 2 and source row 12 when it starts
 * at row 3, the two sums reaching 11.999999999999998 and 12.0 respectively. A horizontal reduce
 * has no such clock -- vips_reduceh generates whole rows, so its sum always starts at the left.
 */
function reduceAxis(
    image: Image,
    dstSize: number,
    shrink: number,
    extra: number,
    horizontal: boolean,
    kernelName: string,
    clock = 0,
    strip = REDUCEV_STRIP,
    phase = clock
): Image {
    const srcSize = horizontal ? image.width : image.height;
    const other = horizontal ? image.height : image.width;
    const ch = image.channels;
    const out = createImage(horizontal ? dstSize : other, horizontal ? other : dstSize, ch);
    const kernel = KERNELS[kernelName] ?? KERNELS.lanczos3;
    const n = reducePoints(kernel, shrink);
    const table = reduceTable(kernel, n, shrink);
    /* Rounding the output size down leaves source pixels unused; libvips moves the origin inside
       the source by half that distance so they are discarded equally from both ends. */
    const offset = (1 + extra) / 2 - 1;
    /* Where vips_embed puts the source inside the padded image it interpolates from. */
    const pad = Math.ceil(n / 2) - 1;
    /*
     * vips_reduceh walks the output with `X += hshrink` rather than multiplying, and the last bit
     * of that sum is which pixel a window lands on: at 16 -> 6 nearest the fourth output falls on
     * 11.999999999999998 and so on pixel 11, where (d + 0.5) * shrink says 12. Every output row
     * starts again from the same place.
     *
     * vips_reducev says the same, but its output is generated in strips, so the sum restarts at
     * `(top + 0.5) * shrink - 0.5 - offset` at the top of each strip instead of running the whole
     * height: a 64 -> 60 nearest reduction takes source row 24 for output row 22 -- 22.5 * 64/60
     * is 24 -- while a sum that runs from the top of the image reaches 23.999999999999996 and
     * takes 23, which is what its columns do.
     */
    /*
     * The position every output pixel takes in the source, built once. vips_reducev_gen and
     * vips_reduceh_gen both start their running sum at `(first + 0.5) * shrink - 0.5 - offset`,
     * where `first` is the top -- or the left -- of the region they were asked to fill, and then
     * add the shrink once per pixel. Only the vertical one restarts on the way, at the top of each
     * strip it is asked for; a horizontal reduce is handed whole rows, so its sum runs the width.
     *
     * The pixels before the clock are not part of what was asked for -- a crop has already thrown
     * them away -- so they are walked backwards from the clock with the same step, which is the
     * only thing that keeps the row continuous for a caller that reads all of it.
     *
     * `phase` is which of those requests the first row of the image falls in, and it is not always
     * the clock: a crop is asked for the rows it keeps, so its strips start at the crop's own top
     * and run every `strip` rows from there, while an embed is asked for the canvas from row 0 and
     * reaches the image `top` rows later, so the rows the reduce is asked to refill are the ones
     * `strip` apart MINUS the embed's offset. Measured against sharp 0.33.5 on a 48x32 -> contain
     * 40xH nearest resize, whose vertical reduce is the same 32 -> 27 one at every H: the host's
     * output row 16 is source row 15 at H = 27, 16 at H = 33, 21 at H = 30, 22 at H = 55 and 28 at
     * H = 45, which is a sum restarted at rows 16, 13, 15, 18 and 7/23 -- 16 - 0, 16 - 3, 16 - 1,
     * 32 - 14 and 16 - 9 / 32 - 9 for the five, the embed's own top being 0, 3, 1, 14 and 9.
     */
    const first = Math.min(Math.max(clock, 0), dstSize - 1);
    const sp = strip > 0 ? strip : Number.MAX_SAFE_INTEGER;
    const pos: number[] = new Array(dstSize);
    for (let d = first; d < dstSize; d++) {
        pos[d] = d === first || (d - phase) % sp === 0
            ? (d + 0.5) * shrink - 0.5 - offset
            : pos[d - 1] + shrink;
    }
    for (let d = first - 1; d >= 0; d--) pos[d] = pos[d + 1] - shrink;
    for (let o = 0; o < other; o++) {
        for (let d = 0; d < dstSize; d++) {
            const at = pos[d];
            const start = Math.trunc(at);
            const phase = Math.trunc(at * TRANSFORM_SCALE * 2) & (TRANSFORM_SCALE * 2 - 1);
            const coef = table[(phase + 1) >> 1];
            for (let c = 0; c < ch; c++) {
                let sum = 0;
                for (let i = 0; i < n; i++) {
                    const s = start + i - pad;
                    const si = s < 0 ? 0 : s >= srcSize ? srcSize - 1 : s;
                    const k = horizontal ? (o * srcSize + si) * ch + c : (si * other + o) * ch + c;
                    sum += coef[i] * image.data[k];
                }
                const v = (sum + (INTERPOLATE_SCALE >> 1)) >> INTERPOLATE_SHIFT;
                const j = horizontal ? (o * dstSize + d) * ch + c : (d * other + o) * ch + c;
                out.data[j] = v < 0 ? 0 : v > 255 ? 255 : v;
            }
        }
    }
    return out;
}

/** libvips' VIPS_ROUND_UINT: to nearest, halves away from zero. */
function roundU(x: number): number {
    return x > 0 ? Math.floor(x + 0.5) : -Math.floor(-x + 0.5);
}

/**
 * libvips' vips_zoom: every pixel becomes an `hn` x `vn` block of itself. vips_resize takes this
 * path for a NEAREST enlargement by a whole number on both axes, which is why a 2x nearest
 * upsize is exact pixel doubling and not a resample at all.
 */
function zoomImage(image: Image, hn: number, vn: number): Image {
    const ch = image.channels;
    const out = createImage(image.width * hn, image.height * vn, ch);
    for (let y = 0; y < out.height; y++) {
        const sy = Math.floor(y / vn);
        for (let x = 0; x < out.width; x++) {
            const from = (sy * image.width + Math.floor(x / hn)) * ch;
            const to = (y * out.width + x) * ch;
            for (let c = 0; c < ch; c++) out.data[to + c] = image.data[from + c];
        }
    }
    return out;
}

/**
 * libvips' `calculate_coefficients_catmull` (resample/templates.h): the four Catmull-Rom
 * coefficients for a position `x` of the way from one pixel to the next, for the taps one before
 * the position, at it, one after it and two after it.
 */
function catmullCoefficients(x: number): number[] {
    const cr1 = 1 - x;
    const cr2 = -0.5 * x;
    const cr3 = cr1 * cr2;
    const cone = cr1 * cr3;
    const cfou = x * cr3;
    const cr4 = cfou - cone;
    return [cone, cr1 - cone + cr4, x - cfou - cr4, cfou];
}

/**
 * libvips' `vips_bicubic_matrixi`: the same coefficients as fixed-point integers for each of the
 * 65 phases, truncated the way C truncates a double into an int. Built once, as it is at class
 * init in bicubic.cpp.
 */
const BICUBIC_TABLE: number[][] = ((): number[][] => {
    const table: number[][] = [];
    for (let phase = 0; phase <= TRANSFORM_SCALE; phase++) {
        table.push(catmullCoefficients(phase / TRANSFORM_SCALE).map((v) => Math.trunc(v * INTERPOLATE_SCALE)));
    }
    return table;
})();

/** libvips' `unsigned_fixed_round`: add half of the coefficient scale, then shift it off. */
function fixedRound(v: number): number {
    return (v + (INTERPOLATE_SCALE >> 1)) >> INTERPOLATE_SHIFT;
}

/** The phase libvips picks a row of coefficients by: the fractional part at 1/64, rounded. */
function coefficientIndex(at: number): number {
    const s = Math.trunc(at * TRANSFORM_SCALE * 2);
    return ((s & (TRANSFORM_SCALE * 2 - 1)) + 1) >> 1;
}

/**
 * libvips' vips_affine as vips_resize drives it (resample/resize.c). Three things about it are
 * not what a resize by a kernel suggests:
 *
 * The interpolator is not the kernel. `vips_resize_interpolate` answers "nearest" for NEAREST,
 * "bilinear" for LINEAR and "bicubic" for everything else -- CUBIC, MITCHELL, LANCZOS2 and
 * LANCZOS3 all upsize with the same Catmull-Rom cubic, which is why a 2x enlargement of one
 * image is byte-identical under all four. Only a reduction tells them apart.
 *
 * Output pixel (x, y) samples the input at `x / hscale - id`, `id` 0.5 for centre convention and
 * 0 for NEAREST, which libvips notes "is always centre"; and the horizontal position is built by
 * adding the inverse scale once per pixel the way affine.c does, never by multiplying, so the
 * last bit of that sum is which pixel a position lands on. It is added to the coordinate inside
 * the border affine.c embeds, which is where that last bit comes from: a 32 -> 48 enlargement
 * lands on 3.5 source pixels at output 6 when the position is built outside the border.
 *
 * And the arithmetic is fixed-point, at 12 bits for the coefficients, so a bilinear value is a
 * sum of four integer coefficients scaled by 1/4096 and a bicubic one is a row of four such sums
 * rounded to integers before the column pass -- not one floating-point sum rounded at the end.
 *
 * `left` is the column the crop that follows this will ask for first, and the horizontal position
 * is built by accumulating the inverse scale from there rather than from column 0, which is the
 * same thing in exact arithmetic and not the same two doubles. Measured against sharp 0.33.5 on
 * 16x8 -> cover 40x30 nearest -- a 60x30 enlargement cropped to 40 -- the enlargement on its own
 * (16x8 -> outside 60x30) agrees byte for byte at every column, and only column 5 of the crop does
 * not: the host reads source column 4 there and a sum built from column 0 reads 3. 16x8 -> cover
 * 17x63 differs the same way at its column 8, and 40x30 -> cover Wx200 nearest at one column for
 * W of 67, 74, 109, 116 and 151; with the sum started where the crop starts, all of them agree.
 */
function affineImage(image: Image, hscale: number, vscale: number, kernelName: string, left = 0): Image {
    const ch = image.channels;
    const out = createImage(roundU(image.width * hscale), roundU(image.height * vscale), ch);
    const lfirst = Math.min(Math.max(Math.trunc(left), 0), out.width - 1);
    const nearest = kernelName === 'nearest';
    const bilinear = kernelName === 'linear';
    /* window_offset + 1: affine.c embeds the input in a border that wide so the stencil can hang
       off the edge, and hands the interpolator a coordinate inside it. */
    const pad = nearest || bilinear ? 1 : 2;
    const id = nearest ? 0 : 0.5;
    /*
     * The inverse of the scale matrix, the way libvips inverts it. vips__transform_calc_inverse
     * (resample/transform.c) does not take 1/hscale and 1/vscale: it takes the determinant of
     * [[hscale, 0], [0, vscale]], inverts that, and multiplies the adjugate by it, so
     *
     *     ia = (1 / (hscale * vscale)) * vscale        id = (1 / (hscale * vscale)) * hscale
     *
     * and the last bit of those two products is not the last bit of 1/hscale and 1/vscale. Which
     * pixel a position lands on turns on exactly that bit, and the two axes are not independent:
     * a 40x30 -> 200x200 `fill` (scale 5 x 6.6667) and a `cover` (6.6667 x 6.6667) shrink their
     * rows by the same 0.15 in exact arithmetic but not in this one -- measured against sharp
     * 0.33.5, source row 3 starts at output row 20 under `fill` and 21 under `cover`, and 1.0/0.15
     * gives 21 for both.
     */
    const det = hscale * vscale;
    const inverse = 1 / det;
    const iax = inverse * vscale;
    const iay = inverse * hscale;
    const clamp = (i: number, size: number): number => (i < 0 ? 0 : i >= size ? size - 1 : i);
    for (let dy = 0; dy < out.height; dy++) {
        const y = dy * iay - id + pad;
        const iy = Math.trunc(y);
        const cy = bilinear || nearest ? BICUBIC_TABLE[0] : BICUBIC_TABLE[coefficientIndex(y)];
        const Y = Math.trunc((y - iy) * INTERPOLATE_SCALE);
        const Yd = INTERPOLATE_SCALE - Y;
        /* The rows of the stencil, in source pixels: one for nearest, two for bilinear, four. */
        const rows = nearest
            ? [clamp(iy - 1, image.height)]
            : bilinear
                ? [clamp(iy - 1, image.height), clamp(iy, image.height)]
                : [0, 1, 2, 3].map((j) => clamp(iy - 3 + j, image.height));
        const ats: number[] = new Array(out.width);
        for (let dx = lfirst; dx < out.width; dx++) {
            ats[dx] = dx === lfirst ? (pad - id) + lfirst * iax : ats[dx - 1] + iax;
        }
        for (let dx = lfirst - 1; dx >= 0; dx--) ats[dx] = ats[dx + 1] - iax;
        for (let dx = 0; dx < out.width; dx++) {
            const at = ats[dx];
            const ix = Math.trunc(at);
            const cx = bilinear || nearest ? BICUBIC_TABLE[0] : BICUBIC_TABLE[coefficientIndex(at)];
            const X = Math.trunc((at - ix) * INTERPOLATE_SCALE);
            const cols = nearest
                ? [clamp(ix - 1, image.width)]
                : bilinear
                    ? [clamp(ix - 1, image.width), clamp(ix, image.width)]
                    : [0, 1, 2, 3].map((i) => clamp(ix - 3 + i, image.width));
            const c4 = (Y * X) >> INTERPOLATE_SHIFT;
            const c2 = (Yd * X) >> INTERPOLATE_SHIFT;
            const c3 = Y - c4;
            const c1 = Yd - c2;
            for (let c = 0; c < ch; c++) {
                let v: number;
                if (nearest) {
                    v = image.data[(rows[0] * image.width + cols[0]) * ch + c];
                } else if (bilinear) {
                    const p1 = image.data[(rows[0] * image.width + cols[0]) * ch + c];
                    const p2 = image.data[(rows[0] * image.width + cols[1]) * ch + c];
                    const p3 = image.data[(rows[1] * image.width + cols[0]) * ch + c];
                    const p4 = image.data[(rows[1] * image.width + cols[1]) * ch + c];
                    v = (c1 * p1 + c2 * p2 + c3 * p3 + c4 * p4 + (INTERPOLATE_SCALE >> 1)) >> INTERPOLATE_SHIFT;
                } else {
                    /* Rows first, each rounded to an integer, then the column pass over those:
                       bicubic.cpp's bicubic_unsigned_int, which is not one sum of sixteen taps. */
                    const rowAt = (j: number): number => {
                        const row = rows[j] * image.width * ch + c;
                        return fixedRound(
                            cx[0] * image.data[row + cols[0] * ch] +
                            cx[1] * image.data[row + cols[1] * ch] +
                            cx[2] * image.data[row + cols[2] * ch] +
                            cx[3] * image.data[row + cols[3] * ch]
                        );
                    };
                    v = fixedRound(cy[0] * rowAt(0) + cy[1] * rowAt(1) + cy[2] * rowAt(2) + cy[3] * rowAt(3));
                }
                out.data[(dy * out.width + dx) * ch + c] = v < 0 ? 0 : v > 255 ? 255 : v;
            }
        }
    }
    return out;
}

/**
 * One axis of a reduction: the integer part of the shrink, then the residual through the kernel.
 * Returns the image unchanged when the axis is not a reduction -- an enlargement is not a
 * resample of one axis, it is the affine above, which runs after both reductions.
 */
function resampleAxis(image: Image, shrink: number, horizontal: boolean, kernelName: string, clock = 0, strip = REDUCEV_STRIP, phase = clock): Image {
    const srcSize = horizontal ? image.width : image.height;
    /*
     * sharp hands vips_resize `scale`, the reciprocal of the shrink, and every number below comes
     * off that reciprocal rather than off the shrink itself: vips_resize_build calls the reduce
     * with `1.0 / vscale` (resample/resize.c), so the reduce's own shrink is 1 / (1 / shrink), and
     * that round trip is not always the shrink it started from -- 138 of the 1652 (size, target)
     * pairs up to 60 come back an ulp away. The last bit of it is which source pixel a window
     * lands on. Measured against sharp 0.33.5 over all 3304 (size, target) pairs up to 60: this
     * chain reproduces the source pixel every output pixel takes, and the plain shrink misses 19
     * of them, every one a pixel whose position lands exactly on an integer.
     */
    const scale = 1 / shrink;
    const reciprocal = 1 / scale;
    /* A horizontal reduce is handed whole rows, so there is no strip for its sum to restart at. */
    const sp = horizontal ? Number.MAX_SAFE_INTEGER : strip;
    /*
     * vips_resize's `gap` of 2: the integer part of the shrink, as far as it goes with a gap of two
     * still to run, is taken before the kernel sees the image -- a vips_shrink box average for the
     * kernels, and a vips_subsample for NEAREST, which must not be given pixels a box would invent
     * -- and only the residual runs through the kernel. Below a shrink of two there is no integer
     * part at all, which is why a 3x reduction is a pure reduce and a 4x one is not.
     *
     * The integer part is counted off the size the RECIPROCAL asks for, ROUND(Xsize * hscale) --
     * not off the size the shrink does -- and NEAREST and the other kernels take it from different
     * places: NEAREST's subsample is sized in vips_resize itself, before the reduce is called, and
     * the rest is vips_shrinkh inside the reduce's own build.
     */
    if (kernelName === 'nearest') {
        /*
         * NEAREST is the one kernel vips_resize subsamples itself (resample/resize.c) before it
         * calls vips_reduce, so the reduce is handed the subsampled image and counts its own
         * unused pixels off that width -- not off the width before the subsample, and not divided
         * by the subsample. 32 -> 5 nearest lands on source pixels 0, 6, 15, 21, 27 by this
         * arithmetic and on 3, 9, 15, 21, 27 by the other. The residual is `1.0 / (hscale *
         * block)`, the reciprocal of the scale the subsample left, which is not always the
         * residual the shrink divides into.
         */
        const block = Math.max(1, Math.floor(srcSize / roundU(srcSize * scale) / RESIZE_GAP));
        const work = block > 1 ? subsampleAxis(image, block, horizontal) : image;
        const residual = 1 / (scale * block);
        const workSize = horizontal ? work.width : work.height;
        const dstSize = roundU(workSize / residual);
        if (dstSize >= workSize) return work;
        return reduceAxis(work, dstSize, residual, dstSize * residual - workSize, horizontal, kernelName, clock, sp, phase);
    }
    const dstSize = roundU(srcSize / reciprocal);
    if (dstSize >= srcSize) return image;
    const block = Math.max(1, Math.floor(srcSize / dstSize / RESIZE_GAP));
    const extra = dstSize * reciprocal - srcSize;
    const work = block > 1 ? boxShrink(image, block, horizontal) : image;
    const residual = reciprocal / block;
    const workSize = horizontal ? work.width : work.height;
    if (dstSize === workSize) return work;
    /* The unused pixels are the ones the box shrink did not take: vips_reduceh divides them by the
       integer part it has just applied (resample/reduceh.cpp, vips_reduceh_build). */
    return reduceAxis(work, dstSize, residual, extra / block, horizontal, kernelName, clock, sp, phase);
}

/**
 * A two-axis resize the way vips_resize orders it: the vertical reduce, then the horizontal one,
 * then whatever is left as a vips_affine. Each reduce takes the shrink it was asked for and
 * rounds its own output size off it, so an axis that is only along for the ride -- `cover` with
 * an auto height -- is still reduced at the other axis' factor.
 */
export function resample(image: Image, hshrink: number, vshrink: number, kernel: string, vclock = 0, strip = REDUCEV_STRIP, hclock = 0, vphase = vclock): Image {
    let work = image;
    /*
     * Whether a vips_affine will run after the reduces. When one does, it is the last operation in
     * the resize and it prepares the whole strip of rows it interpolates from in one request, so
     * vips_reducev is asked for its full output at once and clocks its running sum once, at row 0:
     * there is no strip for it to restart at, and no crop between it and the affine to start it
     * part-way down. Measured against sharp 0.33.5 at 64x64 -> Wx60 nearest: the reduce takes
     * source row 23 for output row 22 at every W from 65 to 200 -- where an affine follows the
     * 1.0667 vertical reduce -- and row 24 at W = 64, where nothing does. 22.5 * 64/60 is exactly
     * 24, so which of the two it lands on is the last bit of the sum, and a sum restarted at row 16
     * reaches 24.0 where one run from row 0 reaches 23.999999999999996.
     */
    const affine = 1 / hshrink > 1 || 1 / vshrink > 1;
    if (vshrink > 1) {
        work = resampleAxis(work, vshrink, false, kernel, affine ? 0 : vclock, affine ? Number.MAX_SAFE_INTEGER : strip, vphase);
    }
    if (hshrink > 1) work = resampleAxis(work, hshrink, true, kernel, hclock);
    /* Whether either axis actually ran a reduce: see the zoom branch below. */
    const reduced = work !== image;
    const hscale = 1 / hshrink;
    const vscale = 1 / vshrink;
    if (hscale <= 1 && vscale <= 1) return work;
    /*
     * The affine gets 1.0 for an axis that is not being enlarged, not that axis' own scale: the
     * reduce above has already taken it, so handing it to the affine as well would shrink the
     * image twice. resize.c's branches say the same -- the horizontal-only one passes 1.0 as
     * `vscale` and the vertical-only one passes 1.0 as `hscale`. A 40x30 -> 5x200 fill is 5 wide
     * after the reduce, and 1 wide if the affine is given the 0.125 again.
     */
    const ah = hscale > 1 ? hscale : 1;
    const av = vscale > 1 ? vscale : 1;
    /*
     * A whole-number NEAREST enlargement of an image no reduce has touched is vips_zoom, not an
     * affine at all. It is not taken once a reduce has run on the other axis: measured against
     * sharp 0.33.5, 40x30 -> 200x5 fill nearest -- a 6x vertical reduce plus a 5x horizontal
     * enlargement -- comes out of the affine, and vips_zoom's `floor(x / 5)` is one column early
     * at every fifth column (host samples source column 0 at output columns 0-5, zoom at 0-4).
     * Powers of two hide it because 1/2, 1/4 and 1/8 accumulate exactly; 1/5 does not.
     */
    if (kernel === 'nearest' && !reduced && ah === Math.floor(ah) && av === Math.floor(av)) {
        return zoomImage(work, Math.round(ah), Math.round(av));
    }
    return affineImage(work, ah, av, kernel, hclock);
}

/* -------------------------------------------------------------------- resize */

export interface ResizeSpec {
    /** Requested width, or -1 for "whatever the height asks for". */
    width: number;
    height: number;
    /** sharp's canvas: crop (cover), embed (contain), max (inside), min (outside), ignore_aspect (fill). */
    canvas: string;
    withoutEnlargement: boolean;
    withoutReduction: boolean;
    /**
     * sharp's shrink-on-load: it belongs to the decoder, which is where libvips takes it, and never
     * to the resample -- vips_resize reduces with the kernel alone.
     */
    fastShrinkOnLoad: boolean;
    kernel: string;
    /** 0 centre, 1 north, 2 east, 3 south, 4 west, 5 north-east, 6 south-east, 7 south-west, 8 north-west. */
    position: number;
    background: number[];
    /**
     * Whether the rows are reversed between the resample and the crop: a flip(), or a rotate(180).
     * The crop that finishes the resize then reads the reduce's rows from the other end, so the
     * first row it asks for is not the first row of the reduce. A rotate(90) or rotate(270) turns
     * the reduce's rows into the crop's columns, which vips_reduceh never clocks, so the clock
     * stays 0; `transposed` says so.
     */
    flipRows?: boolean;
    transposed?: boolean;
    /**
     * Whether the pipeline carries a vertical mirror or a transposition -- a flip(), a rotate(90) or
     * a rotate(270). Either one leaves libvips asking for the whole image as one tile rather than
     * the fat strips of 16 rows it otherwise walks, so the vertical reduce runs its sum over the
     * full height instead of restarting it at the top of each strip, and never clocks it at all.
     * Measured against sharp 0.33.5 on a 48x48 -> 20x20 nearest resize: on its own the reduce takes
     * source row 42 for output row 17, and under a flip(), a rotate(90) or a rotate(270) it takes
     * 41 -- the row the horizontal reduce takes, which is the one sum with no strip to restart it.
     * A flop() and a rotate(180) leave the rows the reduce walks in order and keep the strips.
     */
    wholeTile?: boolean;
    /**
     * Whether the image was decoded out of a file rather than handed in as pixels: a png or a jpeg
     * against a raw buffer or a `create`. The vertical reduce walks the two in strips of different
     * heights, so the row an output row lands on is not always the same one -- see
     * REDUCEV_STRIP_DECODED.
     */
    decoded?: boolean;
    /**
     * Where the entropy crop landed, and so where the resample has to clock. A gravity crop knows
     * its own left and top before the resample runs -- `offsetOf` reads them off `position` -- but
     * `vips_smartcrop` does not: it writes its whole input to memory to score it, which generates
     * every row from row 0, and only then does `vips_extract_area` ask the resample for the rows
     * the crop keeps. Those rows come from a SECOND render, one whose running sum starts at the
     * crop's own top and left, not at 0 -- so an entropy crop is a gravity crop at whatever offset
     * the scoring picked, and the resample has to be clocked to that offset and not to the centre
     * `offsetOf`'s default answers for a position it does not know.
     *
     * Measured against sharp 0.33.5 on a 96x64 -> cover 33x17 nearest resize: the host's entropy
     * crop is (0, 0) and its 1683 bytes hash 2190852216, byte for byte what `position: 'top'` gives
     * -- the same crop, the same clock -- while `centre`, whose clock is the 3 the default answers,
     * hashes 2277544656. Clocking the resample to the crop the shim itself picked restores that
     * equality at the six shapes it was measured at, and leaves the 46 gravity positions alone.
     */
    cropLeft?: number;
    cropTop?: number;
}

/**
 * Where a window of `inner` sits inside `outer` for a compass position, measured against sharp 0.33.5 at
 * 40x30: a crop centres on Math.round of the spare room (5 -> 3, 7 -> 4, 3 -> 2 all minimise the
 * difference from libvips), an embed on Math.floor (room 1/3/5/7 -> 0/1/2/3, read off the padding
 * columns of a contain resize with withoutEnlargement).
 *
 * An embed's room can be NEGATIVE -- a canvas smaller than the image, which is what withoutReduction
 * leaves behind, since the shrink is clamped to 1 -- and sharp's CalculateEmbedPosition (src/common.cc)
 * divides it with C's integer division, which truncates toward zero: a 40x30 image on a 10x5 canvas
 * sits at (-15, -12), not (-15, -13). libvips then places the image there and clips, so the output is
 * the image shifted, with the part pushed off the edge gone and background in its place.
 */
function offsetOf(position: number, outer: number, inner: number, crop: boolean): number {
    if (crop && outer <= inner) return 0;
    const room = outer - inner;
    switch (position) {
        case 1:
        case 5:
        case 8:
            return 0; // north
        case 3:
        case 6:
        case 7:
            return room; // south
        default:
            return crop ? Math.round(room / 2) : Math.trunc(room / 2);
    }
}

/** The horizontal half of `offsetOf`: 4/7/8 west, 2/5/6 east, else centred. */
function offsetXOf(position: number, outer: number, inner: number, crop: boolean): number {
    if (crop && outer <= inner) return 0;
    const room = outer - inner;
    if (position === 4 || position === 7 || position === 8) return 0;
    if (position === 2 || position === 5 || position === 6) return room;
    return crop ? Math.round(room / 2) : Math.trunc(room / 2);
}

/**
 * sharp's own ResolveShrink (src/common.cc): the shrink each axis is asked for, as a ratio of the
 * source dimension to the requested one. It is asked for before either result dimension is rounded,
 * and the rounded size follows from it -- which is not the same thing as shrinking an axis by
 * srcSize/dstSize: with `cover` and an auto height the vertical reduce runs at the horizontal
 * factor and rounds its own height off that, so the two axes are not independent.
 */
function resolveShrink(
    width: number,
    height: number,
    targetWidth: number,
    targetHeight: number,
    canvas: string,
    withoutEnlargement: boolean,
    withoutReduction: boolean
): { hshrink: number; vshrink: number } {
    let hshrink = 1;
    let vshrink = 1;
    if (targetWidth > 0 && targetHeight > 0) {
        hshrink = width / targetWidth;
        vshrink = height / targetHeight;
        if (canvas === 'crop' || canvas === 'min') {
            if (hshrink < vshrink) vshrink = hshrink;
            else hshrink = vshrink;
        } else if (canvas === 'embed' || canvas === 'max') {
            if (hshrink > vshrink) vshrink = hshrink;
            else hshrink = vshrink;
        }
    } else if (targetWidth > 0) {
        hshrink = width / targetWidth;
        if (canvas !== 'ignore_aspect') vshrink = hshrink;
    } else if (targetHeight > 0) {
        vshrink = height / targetHeight;
        if (canvas !== 'ignore_aspect') hshrink = vshrink;
    }
    if (withoutReduction) {
        hshrink = Math.min(1, hshrink);
        vshrink = Math.min(1, vshrink);
    } else if (withoutEnlargement) {
        hshrink = Math.max(1, hshrink);
        vshrink = Math.max(1, vshrink);
    }
    /* Never shrink an axis away to nothing. */
    hshrink = Math.min(hshrink, width);
    vshrink = Math.min(vshrink, height);
    return { hshrink, vshrink };
}

/**
 * The integer libvips is handed as jpegload's `shrink`, and so the `scale_denom` the reduced-size
 * IDCTs in jpeg.ts run at. It is src/pipeline.cc's, quirks and all (v0.33.5):
 *
 *   - the largest of 8, 4 and 2 the COMMON shrink -- the smaller of the two axes -- reaches,
 *     because one `scale_denom` covers the whole frame;
 *   - halved again wherever the shrink is exactly that factor, which sharp files as "known
 *     libjpeg rounding errors". A 64x64 jpeg asked for 32 therefore decodes at 1/1 and is then
 *     resized, while the same jpeg asked for 20 decodes at 1/2; measured against sharp 0.33.5,
 *     `.resize({width:32})` and `.resize({width:24})` are byte-identical to a full decode
 *     followed by the resize, and `.resize({width:20})` is not;
 *   - and taken only when fastShrinkOnLoad is on, which halves the factor it is measured
 *     against: with it off a shrink has to reach 4, 8 or 16 before anything is shrunk on load.
 */
export function shrinkOnLoadOf(
    width: number,
    height: number,
    targetWidth: number,
    targetHeight: number,
    canvas: string,
    withoutEnlargement: boolean,
    withoutReduction: boolean,
    fastShrinkOnLoad: boolean
): number {
    const { hshrink, vshrink } = resolveShrink(
        width,
        height,
        targetWidth,
        targetHeight,
        canvas,
        withoutEnlargement,
        withoutReduction
    );
    const shrink = Math.min(hshrink, vshrink);
    const factor = fastShrinkOnLoad ? 1 : 2;
    let scale = 1;
    if (shrink >= 8 * factor) scale = 8;
    else if (shrink >= 4 * factor) scale = 4;
    else if (shrink >= 2 * factor) scale = 2;
    if (scale > 1 && Math.trunc(shrink) === scale) scale = scale / 2;
    return scale;
}

/**
 * The resample alone, with whether it changed anything. The crop or embed that finishes a resize is
 * `canvasImage`, and sharp runs it later than this: after the flip, flop and rotation, not before.
 *
 * `resized` is sharp's own `shouldResize` -- the resolved shrink moved off 1 on either axis -- which
 * is also what makes libvips premultiply an alpha channel, so the caller needs it.
 */
export function resizeImage(image: Image, spec: ResizeSpec): { image: Image; resized: boolean } {
    const W = image.width;
    const H = image.height;
    if (spec.width < 0 && spec.height < 0) return { image, resized: false };
    const { hshrink, vshrink } = resolveShrink(
        W,
        H,
        spec.width,
        spec.height,
        spec.canvas,
        spec.withoutEnlargement,
        spec.withoutReduction
    );
    const sw = roundU(W / hshrink);
    const sh = roundU(H / vshrink);
    if (sw === W && sh === H) return { image, resized: hshrink !== 1 || vshrink !== 1 };
    /*
     * sharp premultiplies an image that has an alpha band before it resamples it and
     * unpremultiplies afterwards (src/pipeline.cc), which is why a resize of an image whose alpha
     * is not 255 is not the same pixels as a resize of its bands. It is the resample alone that
     * runs on the premultiplied bands: the crop or embed that finishes the resize, and the flip,
     * flop and rotation, all still see unpremultiplied pixels, so the two live here and not in
     * applyOperations.
     */
    const alpha = image.channels === 2 || image.channels === 4;
    const src = alpha ? premultiplyImage(image) : image;
    /* One tile leaves the vertical reduce neither a strip to restart at nor a clock to start from:
       a strip taller than any image is one the top row is the only fresh start in. */
    const tile = spec.wholeTile === true;
    /*
     * What libvips hands the reduce's output to decides whether its running sum is restarted at
     * strips. An affine that enlarges afterwards is the last operation in the resize and reads the
     * whole of the reduce's output in one request, which leaves one sum from row 0; a resize whose
     * reduce output is the image itself is walked in strips. A crop or embed after it does not
     * change that -- measured against sharp 0.33.5 over 4800 resizes, an embed that made the sum
     * continuous fixed 40x30 -> 30x30 contain nearest and broke 18 other contain and inside
     * nearest cases, so the strips stay.
     */
    const follower = tile || 1 / hshrink > 1 || 1 / vshrink > 1;
    const clock = follower ? 0 : verticalClock(spec, sh);
    /*
     * Which row of the reduce's output the operation after it asks to have refilled first, and so
     * which rows its running sum restarts at. A crop asks for the rows it keeps, so the sum restarts
     * at the crop's own top and every `strip` rows from there; an embed is asked for the canvas from
     * row 0 and reaches the image `top` rows into it, so the rows it refills are the ones `strip`
     * apart MINUS that offset, and a resize with nothing after it is asked from row 0. See the
     * measurement on `phase` in reduceAxis.
     */
    const phase = spec.canvas === 'embed' && spec.height > 0
        ? -offsetOf(spec.position, spec.height, sh, false)
        : clock;
    /*
     * A decoded image takes the shorter strip only where the reduce's sum is not being clocked to
     * somewhere other than its own row 0. Where it is -- a crop that keeps the middle or the bottom
     * of a taller reduction -- the two strips were measured against each other over 57 widths each
     * and 16 is the one that leaves fewer wrong (a 64x64 png -> n x n/2 cover nearest: 12 of 57 at
     * 16 against 16 of 57 at 10), and neither is right, so the clocked case keeps the strip it had.
     * Measured against sharp 0.33.5, a 64x64 png -> n x n/2 cover nearest from the top is 0 of 57
     * wrong at 10 and a 48x32 raw one 0 of 57 at 16, so it is the clock and not the crop that
     * decides.
     */
    const strip = spec.decoded === true && clock === 0 ? REDUCEV_STRIP_DECODED : REDUCEV_STRIP;
    const out = resample(
        src,
        hshrink,
        vshrink,
        spec.kernel,
        clock,
        follower ? Number.MAX_SAFE_INTEGER : strip,
        spec.canvas === 'crop' ? horizontalClock(spec, sw) : 0,
        phase
    );
    return {
        image: alpha ? unpremultiplyImage(out) : out,
        resized: hshrink !== 1 || vshrink !== 1
    };
}

/**
 * The column of the reduce's output the crop that follows will ask for first, the horizontal twin
 * of `verticalClock`. vips_reduceh_gen clocks its running sum to `r->left`, the left edge of the
 * region it was asked to fill, so the columns a crop keeps are reached by a sum that starts there
 * and not by one that starts at column 0. Measured against sharp 0.33.5 at 16x8 -> cover 5x5
 * nearest: the crop keeps columns 3 to 7 of the 10-column reduce, and the host's seven is source
 * column 12 -- what a sum started at 3.5 * 1.6 gives, where one started at 0.5 * 1.6 reaches
 * 11.999999999999998 and takes 11, which is also what the same reduce answers when nothing crops
 * it (16x8 -> 10x5 fill nearest agrees at every column).
 */
function horizontalClock(spec: ResizeSpec, sw: number): number {
    if (spec.cropLeft !== undefined) return spec.cropLeft;
    const cw = Math.min(spec.width > 0 ? spec.width : sw, sw);
    if (cw >= sw) return 0;
    return offsetXOf(spec.position, sw, cw, true);
}

/**
 * libvips' vips_premultiply: every band but the last is scaled by the last one. Measured against
 * sharp 0.33.5 over 143 (colour, alpha) pairs: the scale is `floor(band * alpha / 255)`, a plain
 * truncation, and not the `+ 128` a round-to-nearest would add -- a colour of 200 on an alpha of
 * 200 comes back as 198, which only truncation gives.
 */
export function premultiplyImage(image: Image): Image {
    if (image.channels !== 2 && image.channels !== 4) return image;
    const ch = image.channels;
    const out = cloneImage(image);
    const data = image.data;
    for (let i = 0; i < out.data.length; i += ch) {
        const a = data[i + ch - 1];
        for (let c = 0; c < ch - 1; c++) out.data[i + c] = Math.floor((data[i + c] * a) / 255);
    }
    return out;
}

/**
 * libvips' vips_unpremultiply: the inverse, and zero wherever the alpha is. Same measurement, and
 * the same truncation -- a colour of 128 on an alpha of 200 comes back as 127, so `floor` and not
 * a round-to-nearest that would send the exact 127.5 up to 128.
 *
 * The scale is a single-precision float, and that is the whole of what separates this from exact
 * arithmetic: libvips divides 255 by the alpha once, in a float, and multiplies by it, so a band
 * that divides out exactly can land one ulp below its own quotient and truncate to one less --
 * colour 255 on an alpha of 7 is 254 and not the 255 a double gives. Measured against sharp 0.33.5
 * over the whole 65536-entry (colour, alpha) grid: `floor(fround(band * fround(255 / alpha)))`
 * reproduces every cell, and the same floor without the two fround()s misses 36 of them, all of
 * them a band that divides out exactly.
 *
 * The value can come out above 255 once a kernel with negative lobes has run, since the bands and
 * the alpha are resampled independently and the two no longer agree; the extra is clipped away,
 * which is what writing it into an 8-bit band does.
 */
export function unpremultiplyImage(image: Image): Image {
    if (image.channels !== 2 && image.channels !== 4) return image;
    const ch = image.channels;
    const out = cloneImage(image);
    const data = image.data;
    for (let i = 0; i < out.data.length; i += ch) {
        const a = data[i + ch - 1];
        const scale = a === 0 ? 0 : Math.fround(255 / a);
        for (let c = 0; c < ch - 1; c++) {
            const v = a === 0 ? 0 : Math.floor(Math.fround(data[i + c] * scale));
            out.data[i + c] = v > 255 ? 255 : v;
        }
    }
    return out;
}

/**
 * The row of the reduce's output the crop that follows will ask for first, or 0 when the crop reads
 * from row 0 or does not crop the height at all. vips_reducev clocks its running sum to the top of
 * the region it is asked to fill, so this is the row its sum restarts at -- see reduceAxis.
 */
function verticalClock(spec: ResizeSpec, sh: number): number {
    if (spec.canvas !== 'crop' || spec.transposed === true) return 0;
    const ch = Math.min(spec.height > 0 ? spec.height : sh, sh);
    if (ch >= sh) return 0;
    if (spec.cropTop !== undefined) return spec.flipRows === true ? sh - spec.cropTop - ch : spec.cropTop;
    const top = offsetOf(spec.position, sh, ch, true);
    return spec.flipRows === true ? sh - top - ch : top;
}

/**
 * libvips' `vips_hist_entropy` (histogram/hist_entropy.c) over the histogram `vips_hist_find` makes
 * of a region: `-sum(p * log2(p))` over the 256 bins, a bin nothing fell into contributing nothing,
 * which is the limit of `p * log2(p)` as p goes to zero.
 *
 * It is taken one band at a time and the bands added, which in exact arithmetic is the same
 * ordering as the pooled `-sum` the C computes -- normalising every bin by pixels * bands instead
 * of by pixels only adds a constant and a factor of one over the band count -- but it is not the
 * same two doubles. Measured against sharp 0.33.5 over 210 entropy crops, the two decide every
 * slice the same way except in two: 80x50 -> 50x50 cover and 100x60 -> 100x10 cover, where the
 * image is a wrapped gradient whose two ends are within an ulp of each other and the host keeps
 * the crop at 0 -- see the note on the sum below, which is what makes those tie.
 */
function histEntropy(image: Image, left: number, top: number, width: number, height: number): number {
    const bins = new Int32Array(256 * image.channels);
    const ch = image.channels;
    for (let y = top; y < top + height; y++) {
        let i = (y * image.width + left) * ch;
        for (let x = left; x < left + width; x++) {
            for (let c = 0; c < ch; c++) bins[image.data[i + c] + c * 256]++;
            i += ch;
        }
    }
    /*
     * The sum is taken over the COUNT VALUES and not over the bins: `-sum(p * log2(p))` is
     * `log2(N) - (1 / N) * sum(count * log2(count))`, and grouping the bins that hold the same
     * count leaves one term per count instead of one per bin. In exact arithmetic the two are the
     * same number either way; in floating point they are not, because a sum of the same terms in a
     * different order is a different double -- and that is what decides a crop that walks over an
     * image whose slices tie.
     *
     * A wrapped gradient is every one of those: shifting a slice along the wrap rotates which bin
     * each value fell into without changing how many bins hold each count, so two slices have the
     * same entropy exactly and libvips keeps the crop at 0, the end its `>` falls through to on a
     * tie. Summed bin by bin, the rotation moves the additions around and the two slices come out
     * an ulp apart, which is enough to walk the crop somewhere else entirely -- a 100x100 wrapped
     * gradient cropped to 40x100 is `cropOffsetLeft` 0 on host and -8 by the bin-order sum.
     * Measured against sharp 0.33.5 over 420 entropy crops of six wrapped gradients at seven
     * sizes: grouping by count leaves 1 of 420 walking to a different end and summing by bin
     * leaves 50 of them.
     *
     * `Math.log2` and not `Math.log(v) / Math.log(2)`: the two are not the same double, and
     * `Math.log` is not even the same double in the guest as it is on the host -- QuickJS 0.32 and
     * V8 answer 5.170483995038151 and 5.170483995038152 for log(176), and 176, 185, 196 and 220 of
     * the first 256 integers differ by an ulp -- while `Math.log2` answers the same for all 4202
     * values measured. A slice's tie is one ulp wide, so the log has to be the host's own.
     */
    let entropy = 0;
    const total = width * height;
    for (let c = 0; c < ch; c++) {
        const tally = new Map<number, number>();
        for (let b = 0; b < 256; b++) {
            const count = bins[b + c * 256];
            if (count > 0) tally.set(count, (tally.get(count) ?? 0) + 1);
        }
        let sum = 0;
        for (const [count, howMany] of [...tally.entries()].sort((a, b) => a[0] - b[0])) {
            sum += howMany * count * Math.log2(count);
        }
        entropy += Math.log2(total) - sum / total;
    }
    return entropy;
}

/**
 * libvips' `vips_smartcrop` with `VIPS_INTERESTING_ENTROPY` (conversion/smartcrop.c): repeatedly
 * take a slice off whichever axis still has the most to lose, score the slice at each end of that
 * axis by the entropy of its histogram, and keep the end that scores higher -- so the crop walks
 * towards the busier half of the image. The slice is a eighth of the distance left to travel on
 * the axis that has furthest to go, and the two axes are trimmed in the same pass.
 */
export function smartcropEntropy(image: Image, width: number, height: number): { left: number; top: number } {
    let left = 0;
    let top = 0;
    let w = image.width;
    let h = image.height;
    const maxSlice = Math.max(
        Math.ceil((image.width - width) / 8),
        Math.ceil((image.height - height) / 8)
    );
    while (w > width || h > height) {
        const sliceW = Math.min(w - width, maxSlice);
        const sliceH = Math.min(h - height, maxSlice);
        if (sliceW > 0) {
            const before = histEntropy(image, left, top, sliceW, h);
            const after = histEntropy(image, left + w - sliceW, top, sliceW, h);
            w -= sliceW;
            if (before < after) left += sliceW;
        }
        if (sliceH > 0) {
            const before = histEntropy(image, left, top, w, sliceH);
            const after = histEntropy(image, left, top + h - sliceH, w, sliceH);
            h -= sliceH;
            if (before < after) top += sliceH;
        }
    }
    return { left, top };
}

/**
 * The crop or embed sharp applies after the resample and after the flip, flop and rotation
 * (src/pipeline.cc: the mirror and `rot` block, then `inputWidth`/`inputHeight` are re-read and the
 * crop/embed runs against those). Measured against sharp 0.33.5 at 40x30:
 *
 * - `.resize(20,10).rotate(90)` is 15x10, not 10x20: the resize gives 20x15, rotate(90) turns that
 *   into 15x20, and only then is it cropped to 20x10 -- which the 15-pixel width clamps to 15.
 * - `.resize({width:20,height:10,fit:'contain'}).rotate(90)` is 20x13: the resize gives 13x10,
 *   rotate(90) turns it into 10x13, and the embed then pads to 20x13.
 *
 * An embed takes the MAXIMUM of the canvas and the image, never the canvas alone: `vips_embed` is
 * handed `std::max(inputWidth, baton->width)`, so a contain resize whose canvas is smaller than the
 * image -- which is what withoutReduction leaves behind, since the shrink is clamped to 1 -- does
 * not crop. 40x30 -> 20x10 contain withoutReduction is 40x30 on host, not 20x10.
 */
export function canvasImage(image: Image, spec: ResizeSpec): Image {
    const w = spec.width > 0 ? spec.width : image.width;
    const h = spec.height > 0 ? spec.height : image.height;
    if (spec.canvas === 'crop') {
        const cw = Math.min(w, image.width);
        const ch = Math.min(h, image.height);
        if (cw === image.width && ch === image.height) return image;
        return extractImage(
            image,
            offsetXOf(spec.position, image.width, cw, true),
            offsetOf(spec.position, image.height, ch, true),
            cw,
            ch
        );
    }
    if (spec.canvas === 'embed') {
        const ew = Math.max(w, image.width);
        const eh = Math.max(h, image.height);
        /* The offsets come off the canvas the caller asked for, not off the max: a canvas smaller
           than the image gives a negative offset, and the image is shifted and clipped rather than
           padded (see offsetOf). */
        const left = offsetXOf(spec.position, w, image.width, false);
        const top = offsetOf(spec.position, h, image.height, false);
        if (ew === image.width && eh === image.height && left === 0 && top === 0) return image;
        return embedImage(image, ew, eh, left, top, spec.background);
    }
    return image;
}

/* ------------------------------------------------------- geometry operations */

/**
 * The region of `width` x `height` at (left, top). A region that hangs off the edge is refused, as
 * libvips refuses it: `extract_area: bad extract area` (measured on sharp 0.33.5). Clamping instead
 * would hand back a smaller image than the caller asked for and say nothing, which is the one thing
 * worse than a refusal here.
 */
export function extractImage(image: Image, left: number, top: number, width: number, height: number): Image {
    const l = Math.floor(left);
    const t = Math.floor(top);
    const w = Math.floor(width);
    const h = Math.floor(height);
    if (l < 0 || t < 0 || l + w > image.width || t + h > image.height) throw badExtractArea();
    const out = createImage(w, h, image.channels);
    const rowBytes = w * image.channels;
    for (let y = 0; y < h; y++) {
        const from = ((y + t) * image.width + l) * image.channels;
        out.data.set(image.data.subarray(from, from + rowBytes), y * rowBytes);
    }
    return out;
}

/** Place the image in a `width` x `height` canvas filled with `background`. */
export function embedImage(image: Image, width: number, height: number, left: number, top: number, background: number[]): Image {
    const channels = image.channels;
    const out = createImage(width, height, channels);
    const bg = padBackground(background, channels);
    for (let i = 0; i < out.data.length; i += channels) {
        for (let c = 0; c < channels; c++) out.data[i + c] = bg[c];
    }
    blit(out, image, left, top);
    return out;
}

/** sharp's background is [r, g, b, alpha]; a grey image takes the first value, alpha the last. */
export function padBackground(background: number[], channels: ChannelCount): number[] {
    const b = background ?? [0, 0, 0, 255];
    if (channels === 1) return [b[0] ?? 0];
    if (channels === 2) return [b[0] ?? 0, b[3] ?? 255];
    if (channels === 3) return [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0];
    return [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 255];
}

/**
 * `angle` quarter turns, counter-clockwise in libvips' sense: sharp 0.33.5 rotate(90) on a 40x30 image
 * puts the source bottom-left pixel at the output top-left, rotate(270) the top-right.
 */
export function rotateQuarters(image: Image, quarters: number, background: number[]): Image {
    const q = ((quarters % 4) + 4) % 4;
    if (q === 0) return image;
    const swap = q === 1 || q === 3;
    const w = swap ? image.height : image.width;
    const h = swap ? image.width : image.height;
    const out = createImage(w, h, image.channels);
    const ch = image.channels;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let sx: number;
            let sy: number;
            if (q === 2) {
                sx = image.width - 1 - x;
                sy = image.height - 1 - y;
            } else if (q === 1) {
                sx = y;
                sy = image.height - 1 - x;
            } else {
                sx = image.width - 1 - y;
                sy = x;
            }
            const from = (sy * image.width + sx) * ch;
            const to = (y * w + x) * ch;
            for (let c = 0; c < ch; c++) out.data[to + c] = image.data[from + c];
        }
    }
    return out;
}

/** flip(): top becomes bottom. */
export function flipImage(image: Image): Image {
    const out = createImage(image.width, image.height, image.channels);
    const ch = image.channels;
    const rowBytes = image.width * ch;
    for (let y = 0; y < image.height; y++) {
        const from = y * rowBytes;
        const to = (image.height - 1 - y) * rowBytes;
        out.data.set(image.data.subarray(from, from + rowBytes), to);
    }
    return out;
}

/** flop(): left becomes right. */
export function flopImage(image: Image): Image {
    const out = createImage(image.width, image.height, image.channels);
    const ch = image.channels;
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const from = (y * image.width + x) * ch;
            const to = (y * image.width + (image.width - 1 - x)) * ch;
            for (let c = 0; c < ch; c++) out.data[to + c] = image.data[from + c];
        }
    }
    return out;
}

/**
 * sharp's pipeline ends in sRGB -- `colourspace` is 'srgb' and `colourspacePipeline` 'last' from
 * lib/constructor.js, and an option the shim does not implement is refused rather than honoured --
 * so an image of fewer than three bands is promoted before it reaches an encoder: one band becomes
 * three with the same value in each, and two become four with the second band as alpha.
 *
 * Measured against sharp 0.33.5: an 8x8x1 raw buffer gives 192 bytes of raw output (8*8*3), not
 * 64, and an 8x8x2 one 256, while three and four bands are unchanged; the same promotion reaches
 * the PNG (colour type 2 for one band, 6 for two) and the JPEG (three components either way), and
 * `info.channels` reports it. Only `metadata()`, which reads the input, still says one band and
 * `b-w`.
 */
export function toSrgb(image: Image): Image {
    if (image.channels >= 3) return image;
    const out = createImage(image.width, image.height, image.channels === 1 ? 3 : 4);
    const n = image.width * image.height;
    for (let i = 0; i < n; i++) {
        const s = i * image.channels;
        const g = image.data[s];
        if (out.channels === 3) {
            out.data[i * 3] = g;
            out.data[i * 3 + 1] = g;
            out.data[i * 3 + 2] = g;
        } else {
            out.data[i * 4] = g;
            out.data[i * 4 + 1] = g;
            out.data[i * 4 + 2] = g;
            out.data[i * 4 + 3] = image.data[s + 1];
        }
    }
    return out;
}

/** Drop or add an alpha channel, and go to or from grey, so an encoder gets the bands it needs. */
export function toChannels(image: Image, channels: ChannelCount): Image {
    if (channels === image.channels) return image;
    const out = createImage(image.width, image.height, channels);
    const n = image.width * image.height;
    for (let i = 0; i < n; i++) {
        const s = i * image.channels;
        const d = i * channels;
        if (channels === 1) {
            out.data[d] = image.channels === 2 ? image.data[s] : greyOf(image.data[s], image.data[s + 1], image.data[s + 2]);
        } else if (channels === 2) {
            out.data[d] = image.channels === 1 ? image.data[s] : greyOf(image.data[s], image.data[s + 1], image.data[s + 2]);
            out.data[d + 1] = image.channels === 4 ? image.data[s + 3] : 255;
        } else if (channels === 3) {
            if (image.channels === 4) {
                out.data[d] = image.data[s];
                out.data[d + 1] = image.data[s + 1];
                out.data[d + 2] = image.data[s + 2];
            } else if (image.channels === 3) {
                out.data[d] = image.data[s];
                out.data[d + 1] = image.data[s + 1];
                out.data[d + 2] = image.data[s + 2];
            } else {
                /* One band, or two: there is no second or third band to read, so a grey pixel is
                   that value in each of the three -- not the next pixel along, which is what
                   reading `s + 1` out of a one-band image would give. */
                const g = image.data[s];
                out.data[d] = g;
                out.data[d + 1] = g;
                out.data[d + 2] = g;
            }
        } else {
            if (image.channels === 3) {
                out.data[d] = image.data[s];
                out.data[d + 1] = image.data[s + 1];
                out.data[d + 2] = image.data[s + 2];
                out.data[d + 3] = 255;
            } else if (image.channels === 2) {
                const g = image.data[s];
                out.data[d] = g;
                out.data[d + 1] = g;
                out.data[d + 2] = g;
                out.data[d + 3] = image.data[s + 1];
            } else {
                const g = image.data[s];
                out.data[d] = g;
                out.data[d + 1] = g;
                out.data[d + 2] = g;
                out.data[d + 3] = 255;
            }
        }
    }
    return out;
}

/** Rec. 601 luma, the conversion sharp uses when it drops to one band. */
export function greyOf(r: number, g: number, b: number): number {
    return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

/** The number of bands sharp's metadata reports for an image. */
export function spaceOf(channels: number): string {
    return channels <= 2 ? 'b-w' : 'srgb';
}
