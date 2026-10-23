/*
 * The native binding of sharp 0.33.5 (sharp.node, src/sharp.cc) reimplemented in JavaScript, because
 * libvips cannot run in the guest. createAddon() returns the twelve exports sharp's own JavaScript
 * wrapper reads: lib/constructor.js requires ./sharp for its side effect, lib/input.js calls metadata()
 * and stats(), lib/output.js calls pipeline(), and lib/utility.js reads the rest off the class on load.
 *
 * What it does is decode PNG and JPEG, move pixels around (resize, rotate, flip, flop, extract) and encode
 * PNG, JPEG and raw. Everything else libvips can do is refused: pipeline() and metadata() throw a
 * `sharp: unsupported operation ...` error when an option they do not implement has been changed from the
 * value lib/constructor.js gave it, so a caller gets an error instead of an image with the operation
 * silently missing. See options.ts for the 168 defaults the refusal is measured against.
 *
 * Pure JavaScript: no WebAssembly, no Node built-in. Reading an input file goes through the host
 * filesystem the container hands createAddon (NAPI_HOST.fs), which is the only way out of the guest.
 */
import {
    corruptImage,
    fileUnreadable,
    noHostFileSystem,
    pixelLimit,
    unsupportedFormat,
    unsupportedImageFormat,
    unsupportedOperation,
    unsupportedOperationFor
} from './errors';
import {
    ChannelCount,
    Image,
    ResizeSpec,
    createImage,
    embedImage,
    extractImage,
    flipImage,
    flopImage,
    padBackground,
    canvasImage,
    resizeImage,
    rotateQuarters,
    spaceOf,
    toChannels,
    toSrgb
} from './image';
import { optionsOf, unsupportedInput, unsupportedOption } from './options';
import { JpegInfo, decodeJpeg, encodeJpeg, isJpeg } from './jpeg';
import { PngInfo, decodePng, encodePng, isPng } from './png';

/** The part of the Buffer constructor the add-on needs: a view on bytes that is also a Buffer. */
interface BufferConstructorLike {
    from(arrayBuffer: ArrayBuffer, byteOffset?: number, length?: number): Uint8Array;
}

/** The filesystem the container gives the add-on; only `read` and `write` are used. */
export interface SharpAddonHost {
    fs?: {
        read?: (path: string) => Uint8Array | undefined;
        write?: (path: string, bytes: Uint8Array) => void;
    };
    /** The guest's Buffer, so output can be handed back as a Buffer rather than a bare Uint8Array. */
    Buffer?: BufferConstructorLike;
}

/** What the shim decoded, and everything sharp's metadata() reports about it. */
interface Decoded {
    image: Image;
    format: string;
    size: number;
    density?: number;
    resolutionUnit?: string;
    chromaSubsampling?: string;
    isProgressive?: boolean;
    paletteBitDepth?: number;
    hasProfile: boolean;
    hasAlpha: boolean;
    orientation?: number;
    exif?: Uint8Array;
    background?: { r: number; g: number; b: number };
    comments?: Array<[string, string]>;
}

/** A Buffer, a Uint8Array or any other view: the bytes, without copying when it is already one. */
function bytesOf(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new Error('sharp: input buffer is not a typed array');
}

/**
 * sharp's add-on resolves every buffer output with a Buffer, not a bare Uint8Array: lib/output.js
 * hands the value straight to the caller, so `buf.toString('base64')` has to be a Buffer's, or it
 * returns the bytes as a comma-separated list instead. The view is shared, never copied.
 */
function bufferOf(host: SharpAddonHost | undefined, bytes: Uint8Array): Uint8Array {
    const ctor = host?.Buffer ?? (globalThis as { Buffer?: BufferConstructorLike }).Buffer;
    if (!ctor || typeof ctor.from !== 'function') return bytes;
    return ctor.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

/** sharp's angle, as the quarter turns rotateQuarters takes: to nearest, wrapped into 0..3. */
function quartersOf(angle: number): number {
    if (angle % 360 === 0) return 0;
    return ((Math.round(angle / 90) % 4) + 4) % 4;
}

function numberOption(options: Record<string, unknown>, key: string, fallback: number): number {
    const value = options[key];
    return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function arrayOption(options: Record<string, unknown>, key: string, fallback: number[]): number[] {
    const value = options[key];
    return Array.isArray(value) ? (value as number[]).map((v) => (typeof v === 'number' ? v : 0)) : fallback;
}

/* -------------------------------------------------------------------- input */

/** The only band counts there are; a pixel buffer of any other stride is not an image this shim has. */
function channelCount(value: number): ChannelCount {
    if (value === 1 || value === 2 || value === 3 || value === 4) return value;
    throw new Error('Expected between 1 and 4 channels');
}

function imageFromCreate(input: Record<string, unknown>): Image {
    const width = Math.floor(Number(input.createWidth));
    const height = Math.floor(Number(input.createHeight));
    const channels = channelCount(Math.floor(Number(input.createChannels)));
    if (!(width > 0 && height > 0 && channels >= 1 && channels <= 4)) {
        throw new Error('Expected valid width, height and channels to create a new input image');
    }
    const background = padBackground(arrayOption(input, 'createBackground', [0, 0, 0, 255]), channels);
    const image = createImage(width, height, channels);
    for (let i = 0; i < image.data.length; i += channels) {
        for (let c = 0; c < channels; c++) image.data[i + c] = background[c];
    }
    return image;
}

function imageFromRaw(input: Record<string, unknown>, bytes: Uint8Array): Image {
    const width = Math.floor(Number(input.rawWidth));
    const height = Math.floor(Number(input.rawHeight));
    const channels = channelCount(Math.floor(Number(input.rawChannels)));
    const want = width * height * channels;
    if (bytes.length < want) {
        throw corruptImage('Input buffer has corrupt header');
    }
    return { width, height, channels, data: bytesOf(bytes.slice(0, want)) };
}

function decodeBytes(bytes: Uint8Array): Decoded {
    if (isPng(bytes)) {
        const { image, info } = decodePng(bytes);
        return decodedFromPng(image, info, bytes.length);
    }
    if (isJpeg(bytes)) {
        const { image, info } = decodeJpeg(bytes);
        return decodedFromJpeg(image, info, bytes.length);
    }
    throw unsupportedImageFormat('buffer');
}

function decodedFromPng(image: Image, info: PngInfo, size: number): Decoded {
    return {
        image,
        format: 'png',
        size,
        density: info.density,
        resolutionUnit: info.resolutionUnit,
        isProgressive: info.isProgressive,
        paletteBitDepth: info.paletteBitDepth,
        hasProfile: info.hasProfile,
        hasAlpha: info.hasAlpha,
        background: info.background,
        comments: info.comments
    };
}

/**
 * A JPEG always leaves the decoder with a resolution: libvips defaults one to 72 dpi when the file
 * names none at all, and the shim reports that. A resolution the file DOES name is another matter --
 * below one pixel per millimetre libvips keeps no density, though it still reports the unit the file
 * gave. So a jpeg whose EXIF says 25 dpi (25999/1000 says 26, which is why the value is rounded the
 * way `GetDensity` in src/common.cc rounds it) reports `resolutionUnit: 'inch'` and no density, while
 * the same file with its EXIF and ICC stripped reports 72. Measured against host sharp 0.33.5 at 1,
 * 20, 25, 26, 72 and 300 dpi, in the file's EXIF and with no resolution at all.
 *
 * A PNG reports a density only when its pHYs says so, and no unit either way: the `resolutionUnit`
 * host reports for a png comes from the resolution unit of its EXIF, never from pHYs.
 */
function densityOf(density: number | undefined): number | undefined {
    if (typeof density !== 'number' || !isFinite(density)) return 72;
    return density > 25.4 ? Math.round(density) : undefined;
}

function decodedFromJpeg(image: Image, info: JpegInfo, size: number): Decoded {
    return {
        image,
        format: 'jpeg',
        size,
        density: densityOf(info.density),
        resolutionUnit: info.resolutionUnit,
        chromaSubsampling: info.chromaSubsampling,
        isProgressive: info.isProgressive,
        hasProfile: info.hasProfile,
        hasAlpha: false,
        orientation: info.orientation,
        exif: info.exif
    };
}

function readFile(host: SharpAddonHost | undefined, file: string): Uint8Array {
    if (!host || !host.fs || typeof host.fs.read !== 'function') throw noHostFileSystem();
    const bytes = host.fs.read(file);
    if (bytes === undefined) throw fileUnreadable(file);
    return bytesOf(bytes);
}

/** Load the input descriptor sharp built: a created image, raw pixels, a Buffer, or a file. */
function decodeInput(options: Record<string, unknown>, host: SharpAddonHost | undefined): Decoded {
    const input = optionsOf(options.input);
    const unsupported = unsupportedInput(input);
    if (unsupported !== null) throw unsupportedOperationFor('input.' + unsupported);
    if (input.createWidth !== undefined) {
        const image = imageFromCreate(input);
        // libvips has no file behind an image it was told to create, so sharp reports its format as
        // 'raw' -- the same format a raw pixel buffer reports -- and never a size. Measured against
        // sharp 0.33.5: metadata() of sharp({create:{...}}) is {format:'raw', width, height, space,
        // channels, depth:'uchar', isProgressive:false, hasProfile:false, hasAlpha}, and an output
        // with no toFormat() behind it comes out raw, not png.
        return {
            image,
            format: 'raw',
            size: image.data.length,
            isProgressive: false,
            hasProfile: false,
            hasAlpha: image.channels === 2 || image.channels === 4
        };
    }
    if (input.rawWidth !== undefined) {
        const raw = input.buffer !== undefined ? bytesOf(input.buffer) : readFile(host, String(input.file));
        const image = imageFromRaw(input, raw);
        // isProgressive is on a raw input's metadata too: libvips reports false for every image that is
        // not a progressive jpeg, and the shim dropped it here, which left Object.keys() one short
        // (10 where a raw-pixel input reports 11).
        return { image, format: 'raw', size: raw.length, isProgressive: false, hasProfile: false, hasAlpha: image.channels === 2 || image.channels === 4 };
    }
    if (input.buffer !== undefined) {
        const bytes = bytesOf(input.buffer);
        if (bytes.length === 0) throw new Error('Input Buffer is empty');
        return decodeBytes(bytes);
    }
    if (input.file !== undefined) {
        const bytes = readFile(host, String(input.file));
        if (!isPng(bytes) && !isJpeg(bytes)) throw unsupportedImageFormat('file');
        return decodeBytes(bytes);
    }
    throw new Error('Invalid input');
}

/* ------------------------------------------------------------------ pipeline */

/**
 * Pre-extract, resize, then flip, flop and rotate, then the crop or embed that finishes the resize,
 * then the post-extract - unless the rotation comes first.
 *
 * The order is src/pipeline.cc's, and the crop/embed coming after the rotation is not cosmetic:
 * sharp re-reads `inputWidth`/`inputHeight` after `rot` and crops against those, so
 * `.resize(20,10).rotate(90)` on a 40x30 input is 15x10 on host (20x15 resized, 15x20 rotated, then
 * cropped to 20x10, which the 15-pixel width clamps) and not the 10x20 a crop-first order gives.
 */
function applyOperations(image: Image, options: Record<string, unknown>): { image: Image; resized: boolean } {
    let out = image;
    const rotationFirst = options.rotateBeforePreExtract === true;
    let resized = false;
    const orient = (): void => {
        if (options.flip === true) out = flipImage(out);
        if (options.flop === true) out = flopImage(out);
        const angle = numberOption(options, 'angle', 0);
        if (angle % 360 !== 0) {
            const quarters = ((Math.round(angle / 90) % 4) + 4) % 4;
            out = rotateQuarters(out, quarters, arrayOption(options, 'rotationBackground', [0, 0, 0, 255]));
        }
    };
    const spec: ResizeSpec = {
        width: numberOption(options, 'width', -1),
        height: numberOption(options, 'height', -1),
        canvas: String(options.canvas ?? 'crop'),
        withoutEnlargement: options.withoutEnlargement === true,
        withoutReduction: options.withoutReduction === true,
        fastShrinkOnLoad: options.fastShrinkOnLoad !== false,
        kernel: String(options.kernel ?? 'lanczos3'),
        position: numberOption(options, 'position', 0),
        background: arrayOption(options, 'resizeBackground', [0, 0, 0, 255]),
        /* How the flip, flop and rotation below leave the rows the crop will read, so the vertical
           reduce can clock its sum where the crop starts asking. */
        flipRows: (options.flip === true) !== (quartersOf(numberOption(options, 'angle', 0)) === 2),
        transposed: quartersOf(numberOption(options, 'angle', 0)) === 1 || quartersOf(numberOption(options, 'angle', 0)) === 3
    };
    if (rotationFirst) orient();
    if (numberOption(options, 'widthPre', -1) >= 0 || numberOption(options, 'heightPre', -1) >= 0) {
        out = extractImage(
            out,
            numberOption(options, 'leftOffsetPre', 0),
            numberOption(options, 'topOffsetPre', 0),
            numberOption(options, 'widthPre', out.width),
            numberOption(options, 'heightPre', out.height)
        );
    }
    if (spec.width >= 0 || spec.height >= 0) {
        const step = resizeImage(out, spec);
        out = step.image;
        resized = step.resized;
    }
    if (!rotationFirst) orient();
    if (spec.width >= 0 || spec.height >= 0) {
        out = canvasImage(out, spec);
    }
    if (numberOption(options, 'widthPost', -1) >= 0 || numberOption(options, 'heightPost', -1) >= 0) {
        out = extractImage(
            out,
            numberOption(options, 'leftOffsetPost', 0),
            numberOption(options, 'topOffsetPost', 0),
            numberOption(options, 'widthPost', out.width),
            numberOption(options, 'heightPost', out.height)
        );
    }
    return { image: out, resized };
}

function encodeOutput(image: Image, options: Record<string, unknown>, inputFormat: string): { format: string; data: Uint8Array; channels: number } {
    let format = String(options.formatOut ?? 'input');
    // 'input' keeps whatever the input was, so a raw or created image comes out raw and a jpeg comes
    // out jpeg; only a png (and an input format with no raw form) falls back to png. Measured against
    // sharp 0.33.5: create and raw inputs with no toFormat() both report info.format 'raw'.
    if (format === 'input') format = inputFormat === 'jpeg' || inputFormat === 'raw' ? inputFormat : 'png';
    if (format === 'jpeg') {
        const quality = Math.max(1, Math.min(100, numberOption(options, 'jpegQuality', 80)));
        const chroma = String(options.jpegChromaSubsampling ?? '4:2:0');
        if (chroma !== '4:4:4' && chroma !== '4:2:0' && chroma !== '4:2:2') throw unsupportedFormat('jpeg ' + chroma, 'output');
        const rgb = image.channels === 4 || image.channels === 3 ? toChannels(image, 3) : toChannels(image, 1);
        // A jpeg has no alpha band, so the bands the encoder wrote -- 3, or 1 for a greyscale input --
        // are the channels sharp reports, not the bands the image had going in. Without this a
        // 16x8 RGBA png written as jpeg reports channels 4 where sharp 0.33.5 reports 3, while the
        // bytes themselves reopen as 3 on both sides: the info is the wrong one, not the file.
        return { format, data: encodeJpeg(rgb, quality, chroma), channels: rgb.channels };
    }
    if (format === 'png') {
        return { format, data: encodePng(image), channels: image.channels };
    }
    if (format === 'raw') {
        return { format, data: image.data, channels: image.channels };
    }
    throw unsupportedFormat(format, 'output');
}

/* ------------------------------------------------------------------ metadata */

/**
 * sharp reports `size` for Buffer and Stream input only, never for a file it opened itself.
 *
 * The keys come out in src/metadata.cc's order -- format, size, width, height, space, channels,
 * depth, density, chromaSubsampling, isProgressive, paletteBitDepth, resolutionUnit, background,
 * hasProfile, hasAlpha, orientation, exif, icc, comments -- because `Object.keys(metadata())` is
 * observable and sharp 0.33.5 answers in that order.
 */
function metadataOf(decoded: Decoded, fromBuffer: boolean): Record<string, unknown> {
    const meta: Record<string, unknown> = {
        format: decoded.format
    };
    if (fromBuffer) meta.size = decoded.size;
    meta.width = decoded.image.width;
    meta.height = decoded.image.height;
    meta.space = spaceOf(decoded.image.channels);
    meta.channels = decoded.image.channels;
    meta.depth = 'uchar';
    if (decoded.density !== undefined) meta.density = decoded.density;
    if (decoded.chromaSubsampling !== undefined) meta.chromaSubsampling = decoded.chromaSubsampling;
    if (decoded.isProgressive !== undefined) meta.isProgressive = decoded.isProgressive;
    if (decoded.paletteBitDepth !== undefined) meta.paletteBitDepth = decoded.paletteBitDepth;
    if (decoded.resolutionUnit !== undefined) meta.resolutionUnit = decoded.resolutionUnit;
    if (decoded.background !== undefined) meta.background = decoded.background;
    meta.hasProfile = decoded.hasProfile;
    meta.hasAlpha = decoded.hasAlpha;
    if (decoded.orientation !== undefined) meta.orientation = decoded.orientation;
    if (decoded.exif !== undefined) meta.exif = decoded.exif;
    if (decoded.comments !== undefined) meta.comments = decoded.comments;
    return meta;
}

/* ------------------------------------------------------------------- exports */

/**
 * `sharp.format`: what the libvips build behind a sharp install can read and write, in the order
 * lib/utility.js's own table lists them. It is a property of the build, not of this shim's codecs,
 * so it answers what sharp 0.33.5 against libvips 8.15.3 answers -- webp and heif readable and
 * writable, svg read-only, dz write-only, vips file-only, jpeg carrying its four suffixes and its
 * two aliases -- while a format this shim cannot actually encode is still refused where it counts,
 * by `formatOut` in options.ts. Measured against host sharp 0.33.5, key for key.
 */
interface FormatFlags {
    input: { file: boolean; buffer: boolean; stream: boolean; fileSuffix?: string[] };
    output: { file: boolean; buffer: boolean; stream: boolean; alias?: string[] };
}

const FORMAT_TABLE: Array<[string, FormatFlags]> = [
    ['jpeg', { input: { file: true, buffer: true, stream: true, fileSuffix: ['.jpg', '.jpeg', '.jpe', '.jfif'] },
               output: { file: true, buffer: true, stream: true, alias: ['jpe', 'jpg'] } }],
    ['png', { input: { file: true, buffer: true, stream: true, fileSuffix: ['.png'] },
              output: { file: true, buffer: true, stream: true } }],
    ['webp', { input: { file: true, buffer: true, stream: true, fileSuffix: ['.webp'] },
               output: { file: true, buffer: true, stream: true } }],
    ['tiff', { input: { file: true, buffer: true, stream: true, fileSuffix: ['.tif', '.tiff'] },
               output: { file: true, buffer: true, stream: true, alias: ['tif'] } }],
    ['magick', { input: { file: false, buffer: false, stream: false }, output: { file: false, buffer: false, stream: false } }],
    ['openslide', { input: { file: false, buffer: false, stream: false }, output: { file: false, buffer: false, stream: false } }],
    ['dz', { input: { file: false, buffer: false, stream: false }, output: { file: true, buffer: true, stream: true } }],
    ['ppm', { input: { file: false, buffer: false, stream: false }, output: { file: false, buffer: false, stream: false } }],
    ['fits', { input: { file: false, buffer: false, stream: false }, output: { file: false, buffer: false, stream: false } }],
    ['gif', { input: { file: true, buffer: true, stream: true, fileSuffix: ['.gif'] },
              output: { file: true, buffer: true, stream: true } }],
    ['svg', { input: { file: true, buffer: true, stream: true, fileSuffix: ['.svg', '.svgz', '.svg.gz'] },
              output: { file: false, buffer: false, stream: false } }],
    ['heif', { input: { file: true, buffer: true, stream: true, fileSuffix: ['.avif'] },
               output: { file: true, buffer: true, stream: true, alias: ['avif'] } }],
    ['pdf', { input: { file: false, buffer: false, stream: false }, output: { file: false, buffer: false, stream: false } }],
    ['vips', { input: { file: true, buffer: false, stream: false, fileSuffix: ['.v', '.vips'] },
               output: { file: true, buffer: false, stream: false } }],
    ['jp2k', { input: { file: false, buffer: false, stream: false },
               output: { file: false, buffer: false, stream: false, alias: ['j2c', 'j2k', 'jp2', 'jpx'] } }],
    ['jxl', { input: { file: false, buffer: false, stream: false }, output: { file: false, buffer: false, stream: false } }],
    ['raw', { input: { file: false, buffer: true, stream: true }, output: { file: false, buffer: true, stream: true } }]
];

function formatTable(): Record<string, unknown> {
    const table: Record<string, unknown> = {};
    for (const [id, flags] of FORMAT_TABLE) {
        const input: Record<string, unknown> = { file: flags.input.file, buffer: flags.input.buffer, stream: flags.input.stream };
        if (flags.input.fileSuffix !== undefined) input.fileSuffix = flags.input.fileSuffix;
        const output: Record<string, unknown> = { file: flags.output.file, buffer: flags.output.buffer, stream: flags.output.stream };
        if (flags.output.alias !== undefined) output.alias = flags.output.alias;
        table[id] = { id, input, output };
    }
    return table;
}

/**
 * `sharp.concurrency` and `sharp.simd` are a setting and its reading, not two constants:
 * `sharp.concurrency(4)` sets the size of the pool libvips uses and `sharp.concurrency()` reads it
 * back, and `sharp.simd(true)` turns the vector path on. Both used to answer a fixed value and
 * ignore their argument, so a caller that set either one read the old answer straight back.
 *
 * The count starts at the number of CPUs, which is libvips' own default and the number host sharp
 * 0.33.5 reports here; this shim still runs on one thread, so the number is the setting libvips
 * would be handed and not a claim about threads it runs. `simd` starts `false` and stays false
 * until a caller turns it on: the shim is scalar, and reporting `true` would claim a vector unit
 * it has not got, which is the one part of host sharp's answer this does not follow.
 */
declare const requireBuiltin: ((name: string) => unknown) | undefined;
declare const require: ((name: string) => unknown) | undefined;

function cpuCount(): number {
    try {
        let os: any;
        if (typeof requireBuiltin === 'function') os = requireBuiltin('os');
        if (!os) {
            const proc: any = (globalThis as any).process;
            if (proc && typeof proc.getBuiltinModule === 'function') os = proc.getBuiltinModule('os');
        }
        if (!os && typeof require === 'function') os = require('os');
        const n = os && typeof os.cpus === 'function' ? os.cpus().length : 0;
        return n > 0 ? n : 1;
    } catch {
        return 1;
    }
}

let concurrencySetting: number | undefined;
let simdSetting = false;

/** The pool size libvips would be given: the count of CPUs until a caller sets it otherwise. */
function concurrencyOf(n?: number): number {
    if (typeof n === 'number' && Number.isFinite(n) && n >= 1) concurrencySetting = Math.floor(n);
    if (concurrencySetting === undefined) concurrencySetting = cpuCount();
    return concurrencySetting;
}

/**
 * The add-on's exports. sharp's wrapper calls metadata, stats and pipeline with (options, callback); the
 * rest it reads once on load.
 */
export function createAddon(host: SharpAddonHost = {}): object {
    function metadata(options: unknown, callback: (err: Error | null, meta?: unknown) => void): void {
        let meta: Record<string, unknown>;
        try {
            const opts = optionsOf(options);
            const bad = unsupportedOption(opts);
            if (bad !== null) throw unsupportedOperationFor(bad);
            meta = metadataOf(decodeInput(opts, host), optionsOf(opts.input).buffer !== undefined);
        } catch (error) {
            callback(error as Error);
            return;
        }
        callback(null, meta);
    }

    function stats(_options: unknown, _callback: (err: Error | null, stats?: unknown) => void): void {
        // stats() needs a full decode plus an entropy, a Laplacian sharpness and a 4096-bin dominant
        // colour that only libvips computes; rather than invent them, refuse.
        _callback(unsupportedOperation('stats()'));
    }

    function pipeline(options: unknown, callback: (err: Error | null, data?: unknown, info?: unknown) => void): void {
        let data: unknown;
        let info: Record<string, unknown>;
        let fileOut = '';
        let bytes = new Uint8Array(0);
        try {
            const opts = optionsOf(options);
            const bad = unsupportedOption(opts);
            if (bad !== null) throw unsupportedOperationFor(bad);
            const decoded = decodeInput(opts, host);
            const input = optionsOf(opts.input);
            const limit = Number(input.limitInputPixels ?? 268402689);
            if (limit > 0 && decoded.image.width * decoded.image.height > limit) {
                throw pixelLimit(decoded.image.width, decoded.image.height, limit);
            }
            const { image: worked, resized } = applyOperations(decoded.image, opts);
            // The pipeline ends in sRGB, so one band comes out as three and two as four: this is
            // what makes an 8x8x1 raw input 48 bytes of 4x4 raw output and not 16.
            const image = toSrgb(worked);
            const encoded = encodeOutput(image, opts, decoded.format);
            bytes = encoded.data;
            fileOut = String(opts.fileOut ?? '');
            /*
             * The keys and their order are src/pipeline.cc's OnOK: format, width, height, channels,
             * then `depth` -- but only for a raw output, where vips_enum_nick names the band format
             * -- then premultiplied, then the crop offset and attention centre when the crop ran
             * through vips_smartcrop, then `size` last of all. `Object.keys(info)` is observable,
             * and sharp 0.33.5 answers in that order.
             */
            info = {
                format: encoded.format,
                width: image.width,
                height: image.height,
                channels: encoded.channels
            };
            if (encoded.format === 'raw') info.depth = 'uchar';
            /*
             * sharp's `shouldPremultiplyAlpha` (src/pipeline.cc): an image with an alpha band
             * that a resize actually ran on. libvips premultiplies before the resample and
             * unpremultiplies after it, and the flag says which of the two the pixels came out
             * of -- true for a 16x16x4 -> 8x8 reduction, a 48x32 RGBA png -> 24, and every
             * cover/contain/inside/outside resize of an image with alpha; false for a
             * 3-channel resize, for no operation at all, and for a rotate(90) with no resize.
             */
            info.premultiplied = (decoded.image.channels === 2 || decoded.image.channels === 4) && resized;
            /*
             * No cropOffsetLeft / cropOffsetTop: sharp sets `hasCropOffset` only inside the
             * attention/entropy branch of its crop (src/pipeline.cc), off the `-left`/`-top`
             * vips_smartcrop hands back. A gravity crop -- which is the only crop this shim
             * has -- reports neither field on sharp 0.33.5, including a 64x64 jpeg -> 16
             * downsize that never crops and an enlargement that reports nothing to crop.
             */
            info.size = bytes.length;
            if (fileOut !== '') {
                // A raw file is not a format sharp can write to disk: the extension names the format,
                // and .raw names none, so the add-on is never reached and sharp itself refuses with
                // "Unsupported output format <path>". The shim's own format table says the same thing
                // (raw output.file is false), so refuse rather than write bytes no reader can open.
                if (encoded.format === 'raw') throw unsupportedFormat(fileOut, 'output');
                if (!host || !host.fs || typeof host.fs.write !== 'function') throw noHostFileSystem();
                host.fs.write(fileOut, bytes);
                // A file write resolves with the info object, not the bytes: lib/output.js passes the
                // add-on's first value to the caller unchanged, so toFile() gets {format,width,...},
                // and a caller destructuring {width, height} off it sees undefined otherwise.
                data = info;
            } else {
                data = bufferOf(host, bytes);
            }
        } catch (error) {
            callback(error as Error);
            return;
        }
        callback(null, data, info);
    }

    return {
        metadata,
        stats,
        pipeline,
        // libvips' own limits, which sharp sets at load (lib/utility.js: "Default cache settings of 50MB,
        // 20 files, 100 items") and cache() reports back as the three maxima. Reporting 0 for them made
        // this the one sharp answer that is wrong rather than refused: a caller sizing against
        // cache().items.max saw 0 where the add-on says 100. current and high stay 0 -- the shim keeps
        // no operation cache, so nothing has been cached here.
        cache: () => ({ memory: { current: 0, high: 0, max: 50 }, files: { current: 0, max: 20 }, items: { current: 0, max: 100 } }),
        concurrency: (n?: number) => concurrencyOf(n),
        counters: () => ({ queue: 0, process: 0 }),
        simd: (on?: boolean) => {
            if (typeof on === 'boolean') simdSetting = on;
            return simdSetting;
        },
        // libvips 8.15.3 is what sharp 0.33.5's add-on is built against, and what this shim stands in for;
        // no libvips is loaded.
        libvipsVersion: () => ({ semver: '8.15.3', isGlobal: false, isWasm: false }),
        format: formatTable,
        block: () => undefined,
        _maxColourDistance: () => {
            throw unsupportedOperation('_maxColourDistance()');
        },
        _isUsingJemalloc: () => false
    };
}
