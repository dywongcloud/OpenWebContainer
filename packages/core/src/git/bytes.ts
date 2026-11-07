import { sha1 } from '@noble/hashes/sha1';
import { deflate, inflate } from 'pako';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(value: string): Uint8Array { return encoder.encode(value); }
export function text(value: Uint8Array): string { return decoder.decode(value); }

export function concat(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
}

export function toHex(bytes: Uint8Array): string {
    let out = '';
    for (const byte of bytes) out += (byte < 16 ? '0' : '') + byte.toString(16);
    return out;
}

export function fromHex(value: string): Uint8Array {
    const out = new Uint8Array(Math.floor(value.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    return out;
}

export function sha1Hex(data: Uint8Array): string { return toHex(sha1(data) as Uint8Array); }
export function sha1Raw(data: Uint8Array): Uint8Array { return sha1(data) as Uint8Array; }

/* RFC1950 zlib framing: git loose objects are zlib streams (0x78 header + Adler-32),
   not the raw RFC1951 streams fflate.deflateSync emits. */
export function zdeflate(data: Uint8Array): Uint8Array { return deflate(data) as Uint8Array; }
export function zinflate(data: Uint8Array): Uint8Array { return inflate(data) as Uint8Array; }

export function u32be(value: number): Uint8Array {
    return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}
export function readU32be(bytes: Uint8Array, off: number): number {
    return (((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0);
}
export function u16be(value: number): Uint8Array { return new Uint8Array([(value >>> 8) & 255, value & 255]); }
export function readU16be(bytes: Uint8Array, off: number): number { return ((bytes[off] << 8) | bytes[off + 1]) >>> 0; }

/* A byte-preserving string: binary stdout (tar) has to travel through CommandResult.stdout,
   which the shell types as string. Every byte 0..255 is one char code. */
export function binaryString(bytes: Uint8Array): string {
    let out = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
        out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
    }
    return out;
}
export function fromBinaryString(value: string): Uint8Array {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 255;
    return out;
}
export function isHexOid(value: string): boolean { return /^[0-9a-f]{40}$/.test(value); }
export function abbrev(oid: string, length = 7): string { return oid.slice(0, length); }
