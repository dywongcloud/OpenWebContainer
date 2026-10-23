/*
 * The errors the sharp shim raises. Real sharp raises plain Errors whose message comes from libvips, and
 * lib/is.js copies that message onto the Error the wrapper captured the stack from, so the name the caller
 * sees is always 'Error' and the message is all there is to go on. The shim keeps that shape and says in the
 * message which of three things happened:
 *
 *  - `sharp: unsupported operation ...`  an operation libvips would perform and this shim does not implement.
 *    It is a refusal, never a broken result: no image is returned.
 *  - the message libvips itself uses for bad input, e.g. `Input buffer contains unsupported image format`,
 *    so a caller cannot tell the shim from the add-on by the text.
 *  - `sharp: ...` for anything else the shim cannot do, such as reading a file without a host filesystem.
 */

/** Prefix every refusal carries, so a caller can match on it. */
export const UNSUPPORTED = 'sharp: unsupported operation';

export function unsupportedOperation(what: string): Error {
    return new Error(`${UNSUPPORTED}: ${what} is not implemented by the pure-JavaScript sharp shim`);
}

/** The message libvips gives for bytes it cannot identify, which sharp passes straight through. */
export function unsupportedImageFormat(where: 'buffer' | 'file'): Error {
    return new Error(`Input ${where} contains unsupported image format`);
}

/** The message libvips gives for a header it can read but image data that stops early. */
export function corruptImage(what: string): Error {
    return new Error(`${what}`);
}

export function unsupportedFormat(format: string, direction: 'input' | 'output'): Error {
    return new Error(`${UNSUPPORTED}: ${direction} format ${format}`);
}

export function unsupportedOperationFor(option: string): Error {
    return unsupportedOperation(`option ${option}`);
}

/** The message libvips gives for a region that is not inside the image, which sharp passes through. */
export function badExtractArea(): Error {
    return new Error('extract_area: bad extract area');
}

/** A limit the shim honours exactly as sharp does: 0x3FFF x 0x3FFF pixels by default. */
/**
 * The message libvips gives for an image over limitInputPixels. sharp 0.33.5 passes it through
 * unchanged -- measured, and it carries neither the limit nor the size, which libvips puts in the
 * message of a *pixel limit on the output* instead. Appending " of N (w x h)" here is the one place
 * a caller could tell the shim from the add-on by the text.
 */
export function pixelLimit(_width: number, _height: number, _limit: number): Error {
    return new Error('Input image exceeds pixel limit');
}

export function noHostFileSystem(): Error {
    return new Error('sharp: reading an input file needs the host filesystem, which this add-on host did not provide');
}

export function fileUnreadable(file: string): Error {
    return new Error(`Input file is missing or unreadable: ${file}`);
}
