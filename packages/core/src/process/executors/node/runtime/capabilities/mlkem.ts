import { sha3_256, sha3_512, shake128, shake256 } from '@noble/hashes/sha3';
import { base64ToBytes, bytesToBase64 } from '../../../../../network/virtual/host-http';
import { CapabilityHandler } from './types';

/*
 * Host side of ML-KEM (FIPS 203), the post-quantum KEM Node names `ml-kem-768` and `ml-kem-1024`.
 * generateKeyPairSync, encapsulate and decapsulate all run here: the key material never leaves the
 * host, and every byte a caller sees -- SPKI DER, PKCS#8 DER -- is produced and parsed on this
 * side. The arithmetic is the ring Z_3329[X]/(X^256 + 1) of the standard, in 32-bit integers: a
 * product of two residues stays below 2^24, so nothing here needs a bigint.
 *
 * The layout of both DER encodings is OpenSSL's, which is what Node's own exports produce:
 *
 *   SubjectPublicKeyInfo ::= SEQUENCE { AlgorithmIdentifier, BIT STRING ek }
 *   PrivateKeyInfo       ::= SEQUENCE { 0, AlgorithmIdentifier, OCTET STRING SEQUENCE {
 *                                            OCTET STRING (d || z),
 *                                            OCTET STRING (dk_PKE || ek || H(ek) || z) } }
 *
 * The second OCTET STRING is FIPS 203's own dk, 768k + 96 bytes, which is why a PKCS#8 runs to
 * 2498 bytes for ml-kem-768. A key imported from a seed alone (no second OCTET STRING) is accepted
 * too, and expanded here by rerunning key generation from d -- the same thing OpenSSL does.
 *
 * The parameter sets are the ones the host's OpenSSL implements: eta1 is 3 for ml-kem-512 and 2
 * for the other two, and the NTT is the standard's own, whose twiddle factors are zeta^BitRev7(i)
 * rather than the zeta^(2*BitRev7(i)+1) of the round-3 Kyber submission.
 */

/** The polynomial ring: q = 3329, n = 256, zeta = 17. */
const Q = 3329;
const N = 256;
const ZETA = 17;
/** 2^-7 mod q: the seven butterfly stages of the NTT each leave a factor of two behind. */
const NINV = 3303;

type Poly = Int32Array;

const concatBytes = (parts: Uint8Array[]): Uint8Array => {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

const modq = (x: number): number => {
    const r = x % Q;
    return r < 0 ? r + Q : r;
};

/** BitRev7, the seven-bit reversal that orders the NTT's twiddle factors. */
function bitRev7(i: number): number {
    let r = 0;
    for (let bit = 0; bit < 7; bit++) r = (r << 1) | ((i >> bit) & 1);
    return r;
}

const ZETA_POW = new Int32Array(256);
{
    let a = 1;
    for (let e = 0; e < 256; e++) {
        ZETA_POW[e] = a;
        a = (a * ZETA) % Q;
    }
}
/** zeta^BitRev7(i), the twiddle the i-th butterfly of Algorithm 9 uses. */
const ZETAS = new Int32Array(128);
/** Their inverses, which Algorithm 10 uses in the same order. */
const ZETAS_INV = new Int32Array(128);
/** zeta^(2*BitRev7(i)+1), the constant of the i-th degree-two factor X^2 - gamma_i. */
const GAMMA = new Int32Array(128);
for (let i = 0; i < 128; i++) {
    const e = bitRev7(i);
    ZETAS[i] = ZETA_POW[e];
    ZETAS_INV[i] = ZETA_POW[(256 - e) & 255];
    GAMMA[i] = ZETA_POW[(2 * e + 1) & 255];
}

/** NTT (Algorithm 9): Cooley-Tukey, seven stages, twiddles taken in increasing i. */
function ntt(f: Poly): Poly {
    const a = Int32Array.from(f);
    let i = 1;
    for (let length = 128; length >= 2; length >>= 1) {
        for (let start = 0; start < N; start += 2 * length) {
            const z = ZETAS[i++];
            for (let j = start; j < start + length; j++) {
                const t = (z * a[j + length]) % Q;
                a[j + length] = modq(a[j] - t);
                a[j] = modq(a[j] + t);
            }
        }
    }
    return a;
}

/** NTT^-1 (Algorithm 10): Gentleman-Sande, the same twiddles inverted, stages in reverse. */
function invNtt(f: Poly): Poly {
    const a = Int32Array.from(f);
    for (let length = 2; length <= 128; length <<= 1) {
        const base = 128 / length;
        for (let block = 0; block < base; block++) {
            const z = ZETAS_INV[base + block];
            const start = block * 2 * length;
            for (let j = start; j < start + length; j++) {
                const t = a[j];
                a[j] = modq(t + a[j + length]);
                a[j + length] = (z * modq(t - a[j + length])) % Q;
            }
        }
    }
    for (let j = 0; j < N; j++) a[j] = (a[j] * NINV) % Q;
    return a;
}

/** The product in the NTT domain (Algorithm 12): 128 independent degree-two products. */
function baseMul(a: Poly, b: Poly): Poly {
    const r = new Int32Array(N);
    for (let i = 0; i < 128; i++) {
        r[2 * i] = (a[2 * i] * b[2 * i] + a[2 * i + 1] * b[2 * i + 1] * GAMMA[i]) % Q;
        r[2 * i + 1] = (a[2 * i] * b[2 * i + 1] + a[2 * i + 1] * b[2 * i]) % Q;
    }
    return r;
}

function polyAdd(a: Poly, b: Poly): Poly {
    const r = new Int32Array(N);
    for (let i = 0; i < N; i++) r[i] = modq(a[i] + b[i]);
    return r;
}

/* ---------------------------------------------------------------------------------------------
 * Sampling. PRF is SHAKE256 keyed by a counter byte, XOF is SHAKE128 keyed by two index bytes,
 * and both feed rejection or centred-binomial samplers.
 * ------------------------------------------------------------------------------------------ */

/** PRF_eta(sigma, b) = SHAKE256(sigma || b, 64*eta). */
const prf = (eta: number, sigma: Uint8Array, counter: number): Uint8Array =>
    shake256(concatBytes([sigma, new Uint8Array([counter])]), { dkLen: 64 * eta });

/** XOF(rho, i, j) = SHAKE128(rho || j || i, 840). */
const xof = (rho: Uint8Array, i: number, j: number): Uint8Array =>
    shake128(concatBytes([rho, new Uint8Array([j, i])]), { dkLen: 840 });

/** H: SHA3-256. J: SHAKE256 with a 32-byte output. G: SHA3-512, split into two halves. */
const hashH = (bytes: Uint8Array): Uint8Array => sha3_256(bytes);
const hashJ = (bytes: Uint8Array): Uint8Array => shake256(bytes, { dkLen: 32 });
const hashG = (bytes: Uint8Array): Uint8Array => sha3_512(bytes);

/** SamplePolyCBD_eta (Algorithm 8): bits are taken least significant first out of each byte. */
function samplePolyCbd(eta: number, buffer: Uint8Array): Poly {
    const f = new Int32Array(N);
    for (let i = 0; i < N; i++) {
        let x = 0;
        let y = 0;
        for (let j = 0; j < eta; j++) {
            const at = 2 * i * eta + j;
            x += (buffer[at >> 3] >> (at & 7)) & 1;
            const bt = at + eta;
            y += (buffer[bt >> 3] >> (bt & 7)) & 1;
        }
        f[i] = modq(x - y);
    }
    return f;
}

/** SampleNTT (Algorithm 7): rejection sampling of three-byte groups, two residues each. */
function sampleNtt(buffer: Uint8Array): Poly {
    const a = new Int32Array(N);
    let i = 0;
    let j = 0;
    while (j < N) {
        const d1 = buffer[i] + 256 * (buffer[i + 1] % 16);
        const d2 = Math.floor(buffer[i + 1] / 16) + 16 * buffer[i + 2];
        if (d1 < Q) a[j++] = d1;
        if (d2 < Q && j < N) a[j++] = d2;
        i += 3;
    }
    return a;
}

/* ---------------------------------------------------------------------------------------------
 * Byte encoding and compression. ByteEncode packs d bits per coefficient, least significant
 * first; d = 12 has the packed three-bytes-for-two-coefficients form of its own.
 * ------------------------------------------------------------------------------------------ */

function byteEncode(d: number, f: Poly): Uint8Array {
    const out = new Uint8Array(32 * d);
    if (d === 12) {
        for (let i = 0; i < 128; i++) {
            const a = f[2 * i];
            const b = f[2 * i + 1];
            out[3 * i] = a & 0xff;
            out[3 * i + 1] = ((a >> 8) & 0x0f) | ((b & 0x0f) << 4);
            out[3 * i + 2] = (b >> 4) & 0xff;
        }
        return out;
    }
    const mask = (1 << d) - 1;
    let at = 0;
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < N; i++) {
        acc |= (f[i] & mask) << bits;
        bits += d;
        while (bits >= 8) {
            out[at++] = acc & 0xff;
            acc >>>= 8;
            bits -= 8;
        }
    }
    return out;
}

function byteDecode(d: number, bytes: Uint8Array): Poly {
    const f = new Int32Array(N);
    if (d === 12) {
        for (let i = 0; i < 128; i++) {
            f[2 * i] = bytes[3 * i] + 256 * (bytes[3 * i + 1] & 0x0f);
            f[2 * i + 1] = ((bytes[3 * i + 1] >> 4) & 0x0f) + 16 * bytes[3 * i + 2];
        }
        return f;
    }
    const mask = (1 << d) - 1;
    let at = 0;
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < N; i++) {
        while (bits < d) {
            acc |= bytes[at++] << bits;
            bits += 8;
        }
        f[i] = acc & mask;
        acc >>>= d;
        bits -= d;
    }
    return f;
}

/** Compress_d (Algorithm 4): round(2^d * x / q) mod 2^d, with the half rounded up. */
const compress = (d: number, x: number): number =>
    Math.floor((((x % Q) << (d + 1)) + Q) / (2 * Q)) & ((1 << d) - 1);

/** Decompress_d (Algorithm 5): round(q * y / 2^d). */
const decompress = (d: number, y: number): number => Math.floor(((Q * y) << 1) / (1 << (d + 1)) + 0.5);

function compressPoly(d: number, f: Poly): Poly {
    const r = new Int32Array(N);
    for (let i = 0; i < N; i++) r[i] = compress(d, f[i]);
    return r;
}

function decompressPoly(d: number, f: Poly): Poly {
    const r = new Int32Array(N);
    for (let i = 0; i < N; i++) r[i] = decompress(d, f[i]);
    return r;
}

/* ---------------------------------------------------------------------------------------------
 * Parameter sets. k is the module rank, eta1/eta2 the noise widths and du/dv the ciphertext
 * compression; oid is 2.16.840.1.101.3.4.4.n, the algorithm identifier the DER carries.
 * ------------------------------------------------------------------------------------------ */

interface MlKemParams {
    name: string;
    k: number;
    eta1: number;
    eta2: number;
    du: number;
    dv: number;
    oid: Uint8Array;
}

const ML_KEM_PARAMS: MlKemParams[] = [
    { name: 'ml-kem-512', k: 2, eta1: 3, eta2: 2, du: 10, dv: 4, oid: new Uint8Array([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x04, 0x01]) },
    { name: 'ml-kem-768', k: 3, eta1: 2, eta2: 2, du: 10, dv: 4, oid: new Uint8Array([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x04, 0x02]) },
    { name: 'ml-kem-1024', k: 4, eta1: 2, eta2: 2, du: 11, dv: 5, oid: new Uint8Array([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x04, 0x03]) }
];

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
};

function paramsForMode(mode: unknown): MlKemParams {
    const found = ML_KEM_PARAMS.find((p) => p.name === mode);
    if (found !== undefined) return found;
    throw mlkemFail(
        'ERR_INVALID_ARG_VALUE',
        `The argument 'options.type' is invalid. Received '${String(mode)}'`,
        'TypeError'
    );
}

function paramsForOid(oid: Uint8Array): MlKemParams {
    const found = ML_KEM_PARAMS.find((p) => sameBytes(p.oid, oid));
    if (found !== undefined) return found;
    throw mlkemFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid ASN.1: unknown ML-KEM algorithm');
}

function mlkemFail(code: string, message: string, kind: 'Error' | 'TypeError' | 'RangeError' = 'Error'): never {
    const Ctor = kind === 'RangeError' ? RangeError : kind === 'TypeError' ? TypeError : Error;
    throw Object.assign(new Ctor(message), { code, owcErrorClass: kind });
}

const randomOf = (count: number): Uint8Array => {
    const out = new Uint8Array(count);
    globalThis.crypto.getRandomValues(out);
    return out;
};

/* ---------------------------------------------------------------------------------------------
 * K-PKE and the KEM itself.
 * ------------------------------------------------------------------------------------------ */

function polySub(a: Poly, b: Poly): Poly {
    const r = new Int32Array(N);
    for (let i = 0; i < N; i++) r[i] = modq(a[i] - b[i]);
    return r;
}

/** The k x k matrix A-hat in the NTT domain, expanded from rho. */
function expandMatrix(p: MlKemParams, rho: Uint8Array): Poly[][] {
    const a: Poly[][] = [];
    for (let i = 0; i < p.k; i++) {
        const row: Poly[] = [];
        for (let j = 0; j < p.k; j++) row.push(sampleNtt(xof(rho, i, j)));
        a.push(row);
    }
    return a;
}

/** ML-KEM.KeyGen_internal (Algorithm 13): everything but the randomness, which is the caller's. */
function keygenInternal(p: MlKemParams, d: Uint8Array): { ek: Uint8Array; dkPke: Uint8Array } {
    const seeded = hashG(concatBytes([d, new Uint8Array([p.k])]));
    const rho = seeded.subarray(0, 32);
    const sigma = seeded.subarray(32, 64);
    const a = expandMatrix(p, rho);

    const s: Poly[] = [];
    const e: Poly[] = [];
    let counter = 0;
    for (let i = 0; i < p.k; i++) s.push(samplePolyCbd(p.eta1, prf(p.eta1, sigma, counter++)));
    for (let i = 0; i < p.k; i++) e.push(samplePolyCbd(p.eta1, prf(p.eta1, sigma, counter++)));
    const sHat = s.map(ntt);
    const eHat = e.map(ntt);

    const tHat: Poly[] = [];
    for (let i = 0; i < p.k; i++) {
        let acc = new Int32Array(N);
        for (let j = 0; j < p.k; j++) {
            const product = baseMul(a[i][j], sHat[j]);
            acc = polyAdd(acc, product);
        }
        tHat.push(polyAdd(acc, eHat[i]));
    }

    const ekParts: Uint8Array[] = [];
    for (let i = 0; i < p.k; i++) ekParts.push(byteEncode(12, tHat[i]));
    ekParts.push(rho);
    const dkParts: Uint8Array[] = [];
    for (let i = 0; i < p.k; i++) dkParts.push(byteEncode(12, sHat[i]));
    return { ek: concatBytes(ekParts), dkPke: concatBytes(dkParts) };
}

/** The FIPS 203 decapsulation key: dk_PKE || ek || H(ek) || z, 768k + 96 bytes. */
function expandDecapsulationKey(p: MlKemParams, d: Uint8Array, z: Uint8Array): { dkPke: Uint8Array; ek: Uint8Array; h: Uint8Array } {
    const { ek, dkPke } = keygenInternal(p, d);
    return { dkPke, ek, h: hashH(ek) };
}

/** K-PKE.Encrypt (Algorithm 14). */
function kpkeEncrypt(p: MlKemParams, ek: Uint8Array, message: Uint8Array, randomness: Uint8Array): Uint8Array {
    const tHat: Poly[] = [];
    for (let i = 0; i < p.k; i++) tHat.push(byteDecode(12, ek.subarray(384 * i, 384 * (i + 1))));
    const rho = ek.subarray(384 * p.k, 384 * p.k + 32);
    const aT = expandMatrix(p, rho);

    const r: Poly[] = [];
    const e1: Poly[] = [];
    let counter = 0;
    for (let i = 0; i < p.k; i++) r.push(samplePolyCbd(p.eta1, prf(p.eta1, randomness, counter++)));
    for (let i = 0; i < p.k; i++) e1.push(samplePolyCbd(p.eta2, prf(p.eta2, randomness, counter++)));
    const e2 = samplePolyCbd(p.eta2, prf(p.eta2, randomness, counter++));
    const rHat = r.map(ntt);

    const u: Poly[] = [];
    for (let i = 0; i < p.k; i++) {
        let acc = new Int32Array(N);
        for (let j = 0; j < p.k; j++) acc = polyAdd(acc, baseMul(aT[j][i], rHat[j]));
        u.push(polyAdd(invNtt(acc), e1[i]));
    }
    const mu = decompressPoly(1, byteDecode(1, message));
    let acc = new Int32Array(N);
    for (let i = 0; i < p.k; i++) acc = polyAdd(acc, baseMul(tHat[i], rHat[i]));
    const v = polyAdd(polyAdd(invNtt(acc), e2), mu);

    const parts: Uint8Array[] = [];
    for (let i = 0; i < p.k; i++) parts.push(byteEncode(p.du, compressPoly(p.du, u[i])));
    parts.push(byteEncode(p.dv, compressPoly(p.dv, v)));
    return concatBytes(parts);
}

/** K-PKE.Decrypt (Algorithm 15). */
function kpkeDecrypt(p: MlKemParams, dkPke: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const c1Length = 32 * p.du * p.k;
    const c2Length = 32 * p.dv;
    if (ciphertext.length !== c1Length + c2Length) {
        throw mlkemFail('ERR_CRYPTO_INVALID_CIPHERTEXT', 'Invalid ciphertext length');
    }
    const u: Poly[] = [];
    for (let i = 0; i < p.k; i++) {
        u.push(decompressPoly(p.du, byteDecode(p.du, ciphertext.subarray(32 * p.du * i, 32 * p.du * (i + 1)))));
    }
    const v = decompressPoly(p.dv, byteDecode(p.dv, ciphertext.subarray(c1Length, c1Length + c2Length)));
    const sHat: Poly[] = [];
    for (let i = 0; i < p.k; i++) sHat.push(byteDecode(12, dkPke.subarray(384 * i, 384 * (i + 1))));

    let acc = new Int32Array(N);
    for (let i = 0; i < p.k; i++) acc = polyAdd(acc, baseMul(sHat[i], ntt(u[i])));
    const w = polySub(v, invNtt(acc));
    return byteEncode(1, compressPoly(1, w));
}

/* ---------------------------------------------------------------------------------------------
 * DER: the two encodings OpenSSL writes for an ML-KEM key.
 * ------------------------------------------------------------------------------------------ */

const DER_SEQUENCE = 0x30;
const DER_INTEGER = 0x02;
const DER_BIT_STRING = 0x03;
const DER_OCTET_STRING = 0x04;
const DER_OID = 0x06;

function derLength(n: number): Uint8Array {
    if (n < 0x80) return new Uint8Array([n]);
    const bytes: number[] = [];
    let rest = n;
    while (rest > 0) {
        bytes.unshift(rest & 0xff);
        rest >>= 8;
    }
    return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, content: Uint8Array): Uint8Array {
    return concatBytes([new Uint8Array([tag]), derLength(content.length), content]);
}

const derSequence = (parts: Uint8Array[]): Uint8Array => der(DER_SEQUENCE, concatBytes(parts));
const derOctetString = (bytes: Uint8Array): Uint8Array => der(DER_OCTET_STRING, bytes);
/** BIT STRING: one leading byte saying how many bits of the last byte are unused. */
const derBitString = (bytes: Uint8Array): Uint8Array => der(DER_BIT_STRING, concatBytes([new Uint8Array(1), bytes]));
const derInteger = (value: number): Uint8Array => der(DER_INTEGER, new Uint8Array([value]));
const derOid = (oid: Uint8Array): Uint8Array => der(DER_OID, oid);
const derAlgorithm = (oid: Uint8Array): Uint8Array => derSequence([derOid(oid)]);

interface DerNode {
    tag: number;
    content: Uint8Array;
    children: DerNode[];
}

function derParse(bytes: Uint8Array, at: number, end: number): { node: DerNode; next: number } {
    if (at + 2 > end) throw mlkemFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid ASN.1: truncated element');
    const tag = bytes[at];
    let length = bytes[at + 1];
    let bodyAt = at + 2;
    if (length & 0x80) {
        const count = length & 0x7f;
        if (count === 0 || count > 4) throw mlkemFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid ASN.1: unsupported length');
        length = 0;
        for (let i = 0; i < count; i++) length = length * 256 + bytes[bodyAt + i];
        bodyAt += count;
    }
    if (bodyAt + length > end) throw mlkemFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid ASN.1: truncated element');
    const content = bytes.subarray(bodyAt, bodyAt + length);
    const children: DerNode[] = [];
    if (tag === DER_SEQUENCE || (tag & 0xe0) === 0xa0) {
        let inner = 0;
        while (inner < content.length) {
            const part = derParse(content, inner, content.length);
            children.push(part.node);
            inner = part.next;
        }
    }
    return { node: { tag, content, children }, next: bodyAt + length };
}

function derRead(bytes: Uint8Array): DerNode {
    return derParse(bytes, 0, bytes.length).node;
}

/** One TLV, or undefined when the bytes are not a TLV at all: a bare seed is not one. */
function tryParse(bytes: Uint8Array): DerNode | undefined {
    try {
        const { node, next } = derParse(bytes, 0, bytes.length);
        return next === bytes.length ? node : undefined;
    } catch {
        return undefined;
    }
}

function derExpect(node: DerNode, tag: number, what: string): DerNode {
    if (node === undefined || node.tag !== tag) throw mlkemFail('ERR_CRYPTO_INVALID_KEYPAIR', `Invalid ASN.1: expected ${what}`);
    return node;
}

/** The algorithm identifier's OID, and the parameters it names. */
function oidOf(node: DerNode): MlKemParams {
    const algorithm = derExpect(node, DER_SEQUENCE, 'AlgorithmIdentifier');
    const oid = derExpect(algorithm.children[0], DER_OID, 'an OBJECT IDENTIFIER');
    return paramsForOid(oid.content);
}

/** SubjectPublicKeyInfo -> ek, the encapsulation key of 384k + 32 bytes. */
function parseSpki(bytes: Uint8Array): { p: MlKemParams; ek: Uint8Array } {
    const outer = derExpect(derRead(bytes), DER_SEQUENCE, 'SubjectPublicKeyInfo');
    const p = oidOf(derExpect(outer.children[0], DER_SEQUENCE, 'AlgorithmIdentifier'));
    const bits = derExpect(outer.children[1], DER_BIT_STRING, 'a BIT STRING');
    if (bits.content.length === 0 || bits.content[0] !== 0) {
        throw mlkemFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid ASN.1: unused bits in the public key');
    }
    const ek = bits.content.subarray(1);
    if (ek.length !== 384 * p.k + 32) throw mlkemFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid ML-KEM public key length');
    return { p, ek };
}

/** PrivateKeyInfo -> d, z and, when the key stores it, the expanded FIPS 203 dk. */
function parsePkcs8(bytes: Uint8Array): { p: MlKemParams; dkPke: Uint8Array; ek: Uint8Array; h: Uint8Array; z: Uint8Array } {
    const outer = derExpect(derRead(bytes), DER_SEQUENCE, 'PrivateKeyInfo');
    if (outer.children.length < 3) throw mlkemFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid ASN.1: PrivateKeyInfo');
    derExpect(outer.children[0], DER_INTEGER, 'a version INTEGER');
    const p = oidOf(derExpect(outer.children[1], DER_SEQUENCE, 'AlgorithmIdentifier'));
    const body = derExpect(outer.children[2], DER_OCTET_STRING, 'a privateKey OCTET STRING').content;

    /* Both forms OpenSSL writes reach here: a bare 64-byte (d || z), that seed wrapped in a single
       OCTET STRING, or a SEQUENCE of the seed and the expanded key. The bare ones are regenerated,
       which is what OpenSSL does with them. */
    let seed: Uint8Array;
    let expanded: Uint8Array | undefined;
    const inner = tryParse(body);
    if (inner !== undefined && inner.tag === DER_SEQUENCE) {
        seed = derExpect(inner.children[0], DER_OCTET_STRING, 'a seed OCTET STRING').content;
        expanded = derExpect(inner.children[1], DER_OCTET_STRING, 'an expanded key OCTET STRING').content;
    } else if (inner !== undefined && inner.tag === DER_OCTET_STRING && inner.content.length === 64) {
        seed = inner.content;
    } else {
        seed = body;
    }
    if (seed.length !== 64) throw mlkemFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid ML-KEM private key length');
    const d = seed.subarray(0, 32);
    const z = seed.subarray(32, 64);

    const dkSize = 384 * p.k;
    const ekSize = 384 * p.k + 32;
    if (expanded !== undefined) {
        if (expanded.length !== 768 * p.k + 96) throw mlkemFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid ML-KEM private key length');
        return {
            p,
            dkPke: expanded.subarray(0, dkSize),
            ek: expanded.subarray(dkSize, dkSize + ekSize),
            h: expanded.subarray(dkSize + ekSize, dkSize + ekSize + 32),
            z: expanded.subarray(dkSize + ekSize + 32)
        };
    }
    const derived = expandDecapsulationKey(p, d, z);
    return { p, dkPke: derived.dkPke, ek: derived.ek, h: derived.h, z };
}

/* ---------------------------------------------------------------------------------------------
 * The three operations a caller sees.
 * ------------------------------------------------------------------------------------------ */

export type MlKemMode = 'ml-kem-768' | 'ml-kem-1024';

/** generateKeyPairSync(mode) with both halves exported as DER: SPKI and PKCS#8. */
export function mlkemKeygen(mode: MlKemMode): { publicKey: Uint8Array; privateKey: Uint8Array } {
    const p = paramsForMode(mode);
    const d = randomOf(32);
    const z = randomOf(32);
    const { ek, dkPke } = keygenInternal(p, d);
    const h = hashH(ek);
    const publicKey = derSequence([derAlgorithm(p.oid), derBitString(ek)]);
    const privateKey = derSequence([
        derInteger(0),
        derAlgorithm(p.oid),
        derOctetString(derSequence([derOctetString(concatBytes([d, z])), derOctetString(concatBytes([dkPke, ek, h, z]))]))
    ]);
    return { publicKey, privateKey };
}

/** encapsulate(publicKey): a shared key and the ciphertext that carries it. */
export function mlkemEncapsulate(spki: Uint8Array): { ciphertext: Uint8Array; sharedKey: Uint8Array } {
    const { p, ek } = parseSpki(spki);
    const message = randomOf(32);
    const seeded = hashG(concatBytes([message, hashH(ek)]));
    const sharedKey = seeded.subarray(0, 32);
    const randomness = seeded.subarray(32, 64);
    return { ciphertext: kpkeEncrypt(p, ek, message, randomness), sharedKey };
}

/** decapsulate(privateKey, ciphertext): the shared key, or an implicit-rejection key on failure. */
export function mlkemDecapsulate(ciphertext: Uint8Array, pkcs8: Uint8Array): Uint8Array {
    const { p, dkPke, ek, h, z } = parsePkcs8(pkcs8);
    const message = kpkeDecrypt(p, dkPke, ciphertext);
    const seeded = hashG(concatBytes([message, h]));
    const sharedKey = seeded.subarray(0, 32);
    const randomness = seeded.subarray(32, 64);
    const expected = kpkeEncrypt(p, ek, message, randomness);
    /* A ciphertext that does not re-encrypt to itself is rejected implicitly: the shared key is
       derived from z instead, so a caller cannot tell a rejection from a success by its error. */
    if (expected.length !== ciphertext.length) return hashJ(concatBytes([z, ciphertext]));
    for (let i = 0; i < expected.length; i++) {
        if (expected[i] !== ciphertext[i]) return hashJ(concatBytes([z, ciphertext]));
    }
    return sharedKey;
}

/** The capability surface: bytes travel as base64, because capability arguments are JSON. */
export const MLKEM_CAPABILITIES: Record<string, CapabilityHandler> = {
    /** Args {mode}: a fresh key pair, as {publicKey, privateKey} in base64 DER. */
    'crypto.mlkem.keygen': (args) => {
        const pair = mlkemKeygen(args?.mode);
        return { publicKey: bytesToBase64(pair.publicKey), privateKey: bytesToBase64(pair.privateKey) };
    },
    /** Args {publicKey: base64 SPKI}: {ciphertext, sharedKey} in base64. */
    'crypto.mlkem.encapsulate': (args) => {
        const result = mlkemEncapsulate(base64ToBytes(String(args?.publicKey ?? '')));
        return { ciphertext: bytesToBase64(result.ciphertext), sharedKey: bytesToBase64(result.sharedKey) };
    },
    /** Args {ciphertext: base64, privateKey: base64 PKCS#8}: {sharedKey} in base64. */
    'crypto.mlkem.decapsulate': (args) => ({
        sharedKey: bytesToBase64(mlkemDecapsulate(base64ToBytes(String(args?.ciphertext ?? '')), base64ToBytes(String(args?.privateKey ?? ''))))
    })
};
