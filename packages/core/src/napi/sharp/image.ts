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
    const w = Math.min(src.width, dst.width - left);
    const h = Math.min(src.height, dst.height - top);
    for (let y = 0; y < h; y++) {
        const from = (y * src.width) * src.channels;
        const to = ((y + top) * dst.width + left) * dst.channels;
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
 */
function reduceAxis(image: Image, dstSize: number, shrink: number, extra: number, horizontal: boolean, kernelName: string): Image {
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
    /* libvips walks the output with `X += hshrink` from this start rather than multiplying, and the
       last bit of that sum is which pixel a window lands on: at 16 -> 6 nearest the fourth output
       falls on 11.999999999999998 and so on pixel 11, where (d + 0.5) * shrink says 12. Every
       output row starts again from the same place. */
    for (let o = 0; o < other; o++) {
        let at = 0.5 * shrink - 0.5 - offset;
        for (let d = 0; d < dstSize; d++) {
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
            at += shrink;
        }
    }
    return out;
}

function kernelPass(image: Image, dstSize: number, horizontal: boolean, kernel: Kernel, scale: number): Image {
    const srcSize = horizontal ? image.width : image.height;
    const other = horizontal ? image.height : image.width;
    const ch = image.channels;
    const out = createImage(horizontal ? dstSize : other, horizontal ? other : dstSize, ch);
    /**
     * Where output pixel `d` samples the source, in source pixels.
     *
     * A reduction and an enlargement are not the same mapping, and mixing them up shifts every
     * upscaled image by half a source pixel. Measured against sharp 0.33.5 on a 64x64 ramp whose red
     * channel is 4*x (lanczos3 reproduces a ramp exactly, so out/4 reads the sampled position back):
     * shrinking 64->32/48/24 lands on (d + 0.5) * scale - 0.5, while enlarging 64->128/256 lands on
     * d * scale - 0.5 and 64->96/192/80/100 within one byte of it.
     */
    const centreOf = (d: number): number => (d + (scale >= 1 ? 0.5 : 0)) * scale - 0.5;
    const support = kernel.support * Math.max(1, scale);
    for (let o = 0; o < other; o++) {
        for (let d = 0; d < dstSize; d++) {
            const center = centreOf(d);
            const lo = Math.ceil(center - support);
            const hi = Math.floor(center + support);
            let wsum = 0;
            const weights: number[] = [];
            for (let s = lo; s <= hi; s++) {
                const w = kernel.weight((s - center) / Math.max(1, scale));
                if (w === 0) continue;
                weights.push(w);
                wsum += w;
            }
            if (wsum === 0) wsum = 1;
            for (let c = 0; c < ch; c++) {
                let acc = 0;
                let k = 0;
                for (let s = lo; s <= hi; s++) {
                    const w = kernel.weight((s - center) / Math.max(1, scale));
                    if (w === 0) continue;
                    const si = s < 0 ? 0 : s >= srcSize ? srcSize - 1 : s;
                    const i = horizontal ? (o * srcSize + si) * ch + c : (si * other + o) * ch + c;
                    acc += image.data[i] * w;
                    k++;
                }
                const j = horizontal ? (o * dstSize + d) * ch + c : (d * other + o) * ch + c;
                out.data[j] = Math.max(0, Math.min(255, Math.round(acc / wsum)));
            }
        }
    }
    return out;
}

/** libvips' VIPS_ROUND_UINT: to nearest, halves away from zero. */
function roundU(x: number): number {
    return x > 0 ? Math.floor(x + 0.5) : -Math.floor(-x + 0.5);
}

function resampleAxis(image: Image, shrink: number, horizontal: boolean, kernelName: string): Image {
    const srcSize = horizontal ? image.width : image.height;
    const dstSize = roundU(srcSize / shrink);
    if (dstSize === srcSize) return image;
    const kernel = KERNELS[kernelName] ?? KERNELS.lanczos3;
    if (dstSize > srcSize) {
        /* An enlargement is libvips' vips_affine with the interpolator the kernel names. */
        return kernelPass(image, dstSize, horizontal, kernel, shrink);
    }
    /*
     * vips_resize's `gap` of 2: the integer part of the shrink, as far as it goes with a gap of two
     * still to run, is taken before the kernel sees the image -- a vips_shrink box average for the
     * kernels, and a vips_subsample for NEAREST, which must not be given pixels a box would invent
     * -- and only the residual runs through the kernel. Below a shrink of two there is no integer
     * part at all, which is why a 3x reduction is a pure reduce and a 4x one is not.
     */
    const block = Math.max(1, Math.floor(srcSize / dstSize / RESIZE_GAP));
    const extra = (dstSize * shrink - srcSize) / block;
    let work = image;
    let residual = shrink;
    if (block > 1) {
        work = kernelName === 'nearest'
            ? subsampleAxis(image, block, horizontal)
            : boxShrink(image, block, horizontal);
        residual = shrink / block;
    }
    const workSize = horizontal ? work.width : work.height;
    if (dstSize === workSize) return work;
    return reduceAxis(work, dstSize, residual, extra, horizontal, kernelName);
}

/**
 * A two-axis resample, as libvips' vips_resize orders it: the vertical reduce first, then the
 * horizontal one. Each takes the shrink it was asked for and rounds its own output size off it, so
 * an axis that is only along for the ride -- `cover` with an auto height -- is still reduced at the
 * other axis' factor.
 */
export function resample(image: Image, hshrink: number, vshrink: number, kernel: string): Image {
    let out = resampleAxis(image, vshrink, false, kernel);
    out = resampleAxis(out, hshrink, true, kernel);
    return out;
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
}

/**
 * Where a window of `inner` sits inside `outer` for a compass position, measured against sharp 0.33.5 at
 * 40x30: a crop centres on Math.round of the spare room (5 -> 3, 7 -> 4, 3 -> 2 all minimise the
 * difference from libvips), an embed on Math.floor (room 1/3/5/7 -> 0/1/2/3, read off the padding
 * columns of a contain resize with withoutEnlargement).
 */
function offsetOf(position: number, outer: number, inner: number, crop: boolean): number {
    if (outer <= inner) return 0;
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
            return crop ? Math.round(room / 2) : Math.floor(room / 2);
    }
}

/** The horizontal half of `offsetOf`: 4/7/8 west, 2/5/6 east, else centred. */
function offsetXOf(position: number, outer: number, inner: number, crop: boolean): number {
    if (outer <= inner) return 0;
    const room = outer - inner;
    if (position === 4 || position === 7 || position === 8) return 0;
    if (position === 2 || position === 5 || position === 6) return room;
    return crop ? Math.round(room / 2) : Math.floor(room / 2);
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
 * The dimensions and the crop or pad that sharp's resize produces, measured against sharp 0.33.5 at
 * 40x30: cover/contain/inside/outside/fill over (20,10), (20,-1), (-1,10), (60,40), (60,-1), (-1,60), (40,30)
 * and (10,10), with and without withoutEnlargement.
 */
export function resizeImage(image: Image, spec: ResizeSpec): Image {
    const W = image.width;
    const H = image.height;
    if (spec.width < 0 && spec.height < 0) return image;
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
    const scaled = sw === W && sh === H ? image : resample(image, hshrink, vshrink, spec.kernel);
    if (spec.canvas === 'crop') {
        const w = spec.width > 0 ? Math.min(spec.width, scaled.width) : scaled.width;
        const h = spec.height > 0 ? Math.min(spec.height, scaled.height) : scaled.height;
        if (w === scaled.width && h === scaled.height) return scaled;
        return extractImage(
            scaled,
            offsetXOf(spec.position, scaled.width, w, true),
            offsetOf(spec.position, scaled.height, h, true),
            w,
            h
        );
    }
    if (spec.canvas === 'embed') {
        const w = spec.width > 0 ? spec.width : scaled.width;
        const h = spec.height > 0 ? spec.height : scaled.height;
        if (w === scaled.width && h === scaled.height) return scaled;
        return embedImage(
            scaled,
            w,
            h,
            offsetXOf(spec.position, w, scaled.width, false),
            offsetOf(spec.position, h, scaled.height, false),
            spec.background
        );
    }
    return scaled;
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
            } else {
                out.data[d] = image.data[s];
                out.data[d + 1] = image.data[s + 1] ?? image.data[s];
                out.data[d + 2] = image.data[s + 2] ?? image.data[s];
            }
        } else {
            out.data[d] = image.channels === 3 ? image.data[s] : image.data[s];
            out.data[d + 1] = image.channels === 3 ? image.data[s + 1] : image.data[s];
            out.data[d + 2] = image.channels === 3 ? image.data[s + 2] : image.data[s];
            out.data[d + 3] = image.channels === 2 ? image.data[s + 1] : 255;
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
