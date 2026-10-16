/*
 * The argument conversions of the sodium-native add-on: what node-addon-api's Napi::TypedArray and the
 * add-on's own SN_ARGV / SN_ASSERT_LENGTH macros do. Every message here was read off the real add-on
 * (sodium-native 4.3.3 on Node 24.15) by passing it the offending argument, never written from the
 * C headers: an argument that is not a typed array fails with a TypeError naming the parameter, a
 * length assertion fails with a plain Error naming both the parameter and the constant, and a call
 * with fewer arguments than the binding declares fails with a TypeError naming the binding.
 */

/** The stable code every unimplemented binding throws with. */
export const UNSUPPORTED_CODE = 'ERR_OWC_NAPI_SODIUM_UNSUPPORTED';

/** The error an unimplemented binding throws: named, so a caller can grep the code out of the message. */
export function unsupportedError(name: string, reason: string): Error {
    const error = new Error(
        'sodium-native: ' + name + ' is not implemented by the owc JavaScript shim (' + reason + ') [' + UNSUPPORTED_CODE + ']'
    );
    (error as { code?: string }).code = UNSUPPORTED_CODE;
    return error;
}

/** A binding function as Napi::Function::New makes it: no name, length 0, any arguments. */
export function napiFunction(impl: (args: IArguments) => unknown): Function {
    const fn = function () {
        return impl(arguments);
    };
    Object.defineProperty(fn, 'name', { value: '' });
    return fn;
}

/**
 * Napi::TypedArray over a value napi_is_typedarray accepted. A DataView is an ArrayBuffer view but
 * not a typed array, so the add-on rejects it with the same message as a number.
 */
export function typedArray(value: unknown, name: string): Uint8Array {
    if (!ArrayBuffer.isView(value) || value instanceof DataView) {
        throw new TypeError(name + ' must be an instance of TypedArray');
    }
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/** An optional trailing typed array: absent means a zero-length one, which is what the binding sees. */
export function optionalTypedArray(value: unknown, name: string): Uint8Array {
    if (value === undefined) return new Uint8Array(0);
    return typedArray(value, name);
}

/** SN_ARGV: the binding declares `count` arguments and rejects fewer. */
export function argv(args: IArguments, count: number, name: string): void {
    if (args.length < count) throw new TypeError(name + ' requires ' + count + ' argument(s)');
}

/**
 * SN_ARGV_OPTS: the binding declares a range of argument counts, but only the lower bound is enforced
 * - the add-on accepts a crypto_generichash call carrying a fourth argument, measured. An optional
 * argument that is absent is not the same thing as one that is present and empty.
 */
export function argvOpts(args: IArguments, min: number, name: string): void {
    if (args.length < min) throw new TypeError(name + ' requires ' + min + ' argument(s)');
}

/** SN_ASSERT_LENGTH: `<name>` must be exactly `constantName` bytes long. */
export function assertLength(size: number, expected: number, name: string, constantName: string): void {
    if (size !== expected) throw new Error('"' + name + '" must be ' + constantName + ' bytes long');
}

/** SN_ASSERT_MIN_LENGTH: `<name>` must be at least `constantName` bytes long. */
export function assertMinLength(size: number, min: number, name: string, constantName: string): void {
    if (size < min) throw new Error('"' + name + '" must be at least ' + constantName + ' bytes long');
}

/** SN_ASSERT_MAX_LENGTH: `<name>` must be at most `constantName` bytes long. */
export function assertMaxLength(size: number, max: number, name: string, constantName: string): void {
    if (size > max) throw new Error('"' + name + '" must be at most ' + constantName + ' bytes long');
}

/** SN_THROWS with a message the add-on writes out verbatim, constants and all. */
export function throws(condition: boolean, message: string): void {
    if (condition) throw new Error(message);
}

/** Napi::Number to uint32_t. */
export function uint32(value: unknown, name: string): number {
    if (typeof value !== 'number') throw new TypeError(name + ' must be an instance of Number');
    return value >>> 0;
}

/** Copies bytes into a caller-owned buffer, which is always big enough by the time this runs. */
export function write(dest: Uint8Array, source: Uint8Array): void {
    dest.set(source.subarray(0, dest.length));
}
