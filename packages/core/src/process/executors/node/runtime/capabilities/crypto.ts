import { blake2b, blake2s } from '@noble/hashes/blake2';
import { md5 } from '@noble/hashes/legacy';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { scrypt } from '@noble/hashes/scrypt';
import { sha1 } from '@noble/hashes/sha1';
import { sha224, sha256 } from '@noble/hashes/sha256';
import { sha384, sha512 } from '@noble/hashes/sha512';
import { sha512_224, sha512_256 } from '@noble/hashes/sha2';
import { sha3_224, sha3_256, sha3_384, sha3_512, shake128, shake256 } from '@noble/hashes/sha3';
import { cbc, cfb, ctr, ecb, gcm } from '@noble/ciphers/aes';
import { chacha20, chacha20poly1305 } from '@noble/ciphers/chacha';
import { ed25519 as nobleEd25519, x25519 as nobleX25519 } from '@noble/curves/ed25519';
import { ed448 as nobleEd448, x448 as nobleX448 } from '@noble/curves/ed448';
import { p256, p384, p521 } from '@noble/curves/nist';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base64ToBytes, bytesToBase64 } from '../../../../../network/virtual/host-http';
import { CapabilityHandler } from './types';

/*
 * Host side of the guest's crypto hashing and ciphers. createHash, createHmac and pbkdf2Sync run on
 * the host's synchronous hash functions (@noble/hashes); createCipheriv and createDecipheriv keep
 * their state here as well, because @noble/ciphers lives on this side of the capability boundary.
 * synchronous hash functions (@noble/hashes), so a digest is one blocking capability call.
 * Bytes travel as base64 because capability arguments are JSON.
 *
 * Asymmetric keys (Ed25519, X25519, Ed448, X448 and the NIST/SECG curves) live here too: the host
 * holds the key material and hands the guest an integer handle, so a key is never copied into the
 * guest realm. Every encoding a caller sees -- SPKI/PKCS8 PEM and DER, JWK, raw -- is produced and
 * parsed on this side. RSA is not implemented: generating a key pair needs a large random prime
 * search, which no caller can wait for in here.
 */

/* ---------------------------------------------------------------------------------------------
 * SM3 (GM/T 0004-2012), the digest Node names `sm3`. @noble/hashes carries SHA-3, BLAKE2 and
 * RIPEMD-160 but not SM3, so the compression function is here: the SHA-2 shape with SM3's own
 * message expansion, round constants and permutations. Everything stays in 32-bit arithmetic.
 * ------------------------------------------------------------------------------------------ */

const SM3_IV = new Uint32Array([
    0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e
]);

const sm3rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;
const sm3sum = (...xs: number[]): number => xs.reduce((a, b) => (a + b) >>> 0, 0);
const sm3p0 = (x: number): number => (x ^ sm3rotl(x, 9) ^ sm3rotl(x, 17)) >>> 0;
const sm3p1 = (x: number): number => (x ^ sm3rotl(x, 15) ^ sm3rotl(x, 23)) >>> 0;
const sm3ff = (j: number, x: number, y: number, z: number): number =>
    (j < 16 ? x ^ y ^ z : (x & y) | (x & z) | (y & z)) >>> 0;
const sm3gg = (j: number, x: number, y: number, z: number): number =>
    (j < 16 ? x ^ y ^ z : (x & y) | (~x & z)) >>> 0;
/** The round constant: 0x79cc4519 for the first sixteen rounds, 0x7a879d8a for the rest. */
const sm3t = (j: number): number => (j < 16 ? 0x79cc4519 : 0x7a879d8a);

function sm3(message: Uint8Array): Uint8Array {
    const blocks = Math.floor((message.length + 8) / 64) + 1;
    const padded = new Uint8Array(blocks * 64);
    padded.set(message);
    padded[message.length] = 0x80;
    const bits = message.length * 8;
    padded[padded.length - 4] = (bits >>> 24) & 0xff;
    padded[padded.length - 3] = (bits >>> 16) & 0xff;
    padded[padded.length - 2] = (bits >>> 8) & 0xff;
    padded[padded.length - 1] = bits & 0xff;

    const v = Uint32Array.from(SM3_IV);
    const w = new Uint32Array(68);
    const w1 = new Uint32Array(64);
    for (let at = 0; at < padded.length; at += 64) {
        for (let j = 0; j < 16; j++) {
            const b = at + j * 4;
            w[j] = ((padded[b] << 24) | (padded[b + 1] << 16) | (padded[b + 2] << 8) | padded[b + 3]) >>> 0;
        }
        for (let j = 16; j < 68; j++) {
            w[j] = (sm3p1(w[j - 16] ^ w[j - 9] ^ sm3rotl(w[j - 3], 15)) ^ sm3rotl(w[j - 13], 7) ^ w[j - 6]) >>> 0;
        }
        for (let j = 0; j < 64; j++) w1[j] = (w[j] ^ w[j + 4]) >>> 0;

        let a = v[0], b = v[1], c = v[2], d = v[3], e = v[4], f = v[5], g = v[6], h = v[7];
        for (let j = 0; j < 64; j++) {
            const a12 = sm3rotl(a, 12);
            const s1 = sm3rotl(sm3sum(a12, e, sm3rotl(sm3t(j), j)), 7);
            const s2 = (s1 ^ a12) >>> 0;
            const tt1 = sm3sum(sm3ff(j, a, b, c), d, s2, w1[j]);
            const tt2 = sm3sum(sm3gg(j, e, f, g), h, s1, w[j]);
            d = c;
            c = sm3rotl(b, 9);
            b = a;
            a = tt1;
            h = g;
            g = sm3rotl(f, 19);
            f = e;
            e = sm3p0(tt2);
        }
        v[0] = (v[0] ^ a) >>> 0;
        v[1] = (v[1] ^ b) >>> 0;
        v[2] = (v[2] ^ c) >>> 0;
        v[3] = (v[3] ^ d) >>> 0;
        v[4] = (v[4] ^ e) >>> 0;
        v[5] = (v[5] ^ f) >>> 0;
        v[6] = (v[6] ^ g) >>> 0;
        v[7] = (v[7] ^ h) >>> 0;
    }

    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
        out[i * 4] = (v[i] >>> 24) & 0xff;
        out[i * 4 + 1] = (v[i] >>> 16) & 0xff;
        out[i * 4 + 2] = (v[i] >>> 8) & 0xff;
        out[i * 4 + 3] = v[i] & 0xff;
    }
    return out;
}

/* ---------------------------------------------------------------------------------------------
 * Digests. Node's getHashes() is a fixed list of 52 names, most of them OpenSSL aliases of one
 * another ("RSA-SHA256" and "sha256WithRSAEncryption" are both SHA-256), so the table below holds
 * one entry per digest and HASH_NAMES is the list Node answers with, in Node's order.
 * ------------------------------------------------------------------------------------------ */

interface DigestSpec {
    /** The digest of the bytes; dkLen is honoured by the two XOFs and ignored by the rest. */
    fn: (msg: Uint8Array, dkLen: number) => Uint8Array;
    /** The length digest() produces when the caller names none. */
    out: number;
    /** The HMAC block length: the digest's own for SHA-2 and friends, the sponge rate for SHA-3. */
    block: number;
    /** shake128 and shake256 take their length from the caller instead of fixing it. */
    xof?: boolean;
}

const DIGEST_SPECS: Record<string, DigestSpec> = {
    md5: { fn: (m) => md5(m), out: 16, block: 64 },
    sha1: { fn: (m) => sha1(m), out: 20, block: 64 },
    sha224: { fn: (m) => sha224(m), out: 28, block: 64 },
    sha256: { fn: (m) => sha256(m), out: 32, block: 64 },
    sha384: { fn: (m) => sha384(m), out: 48, block: 128 },
    sha512: { fn: (m) => sha512(m), out: 64, block: 128 },
    'sha512-224': { fn: (m) => sha512_224(m), out: 28, block: 128 },
    'sha512-256': { fn: (m) => sha512_256(m), out: 32, block: 128 },
    'sha3-224': { fn: (m) => sha3_224(m), out: 28, block: 144 },
    'sha3-256': { fn: (m) => sha3_256(m), out: 32, block: 136 },
    'sha3-384': { fn: (m) => sha3_384(m), out: 48, block: 104 },
    'sha3-512': { fn: (m) => sha3_512(m), out: 64, block: 72 },
    shake128: { fn: (m, n) => shake128(m, { dkLen: n }), out: 16, block: 168, xof: true },
    shake256: { fn: (m, n) => shake256(m, { dkLen: n }), out: 32, block: 136, xof: true },
    blake2b512: { fn: (m) => blake2b(m, { dkLen: 64 }), out: 64, block: 128 },
    blake2s256: { fn: (m) => blake2s(m, { dkLen: 32 }), out: 32, block: 64 },
    ripemd160: { fn: (m) => ripemd160(m), out: 20, block: 64 },
    sm3: { fn: (m) => sm3(m), out: 32, block: 64 },
    'md5-sha1': { fn: (m) => concatBytes(md5(m), sha1(m)), out: 36, block: 64 }
};

/** Every name in Node 24's getHashes() that is not already a canonical digest name, lowercased. */
const DIGEST_ALIASES: Record<string, string> = {
    'rsa-md5': 'md5',
    'rsa-ripemd160': 'ripemd160',
    'rsa-sha1': 'sha1',
    'rsa-sha1-2': 'sha1',
    'rsa-sha224': 'sha224',
    'rsa-sha256': 'sha256',
    'rsa-sha3-224': 'sha3-224',
    'rsa-sha3-256': 'sha3-256',
    'rsa-sha3-384': 'sha3-384',
    'rsa-sha3-512': 'sha3-512',
    'rsa-sha384': 'sha384',
    'rsa-sha512': 'sha512',
    'rsa-sha512/224': 'sha512-224',
    'rsa-sha512/256': 'sha512-256',
    'rsa-sm3': 'sm3',
    'id-rsassa-pkcs1-v1_5-with-sha3-224': 'sha3-224',
    'id-rsassa-pkcs1-v1_5-with-sha3-256': 'sha3-256',
    'id-rsassa-pkcs1-v1_5-with-sha3-384': 'sha3-384',
    'id-rsassa-pkcs1-v1_5-with-sha3-512': 'sha3-512',
    'md5withrsaencryption': 'md5',
    'sha1withrsaencryption': 'sha1',
    'sha224withrsaencryption': 'sha224',
    'sha256withrsaencryption': 'sha256',
    'sha384withrsaencryption': 'sha384',
    'sha512-224withrsaencryption': 'sha512-224',
    'sha512-256withrsaencryption': 'sha512-256',
    'sha512withrsaencryption': 'sha512',
    'sm3withrsaencryption': 'sm3',
    'ripemd': 'ripemd160',
    'ripemd160withrsa': 'ripemd160',
    'rmd160': 'ripemd160',
    'ssl3-md5': 'md5',
    'ssl3-sha1': 'sha1'
};

/** Node's own order, so getHashes() here answers exactly what the host answers. */
const HASH_NAMES: string[] = [
    'RSA-MD5', 'RSA-RIPEMD160', 'RSA-SHA1', 'RSA-SHA1-2', 'RSA-SHA224', 'RSA-SHA256', 'RSA-SHA3-224',
    'RSA-SHA3-256', 'RSA-SHA3-384', 'RSA-SHA3-512', 'RSA-SHA384', 'RSA-SHA512', 'RSA-SHA512/224',
    'RSA-SHA512/256', 'RSA-SM3', 'blake2b512', 'blake2s256', 'id-rsassa-pkcs1-v1_5-with-sha3-224',
    'id-rsassa-pkcs1-v1_5-with-sha3-256', 'id-rsassa-pkcs1-v1_5-with-sha3-384',
    'id-rsassa-pkcs1-v1_5-with-sha3-512', 'md5', 'md5-sha1', 'md5WithRSAEncryption', 'ripemd',
    'ripemd160', 'ripemd160WithRSA', 'rmd160', 'sha1', 'sha1WithRSAEncryption', 'sha224',
    'sha224WithRSAEncryption', 'sha256', 'sha256WithRSAEncryption', 'sha3-224', 'sha3-256',
    'sha3-384', 'sha3-512', 'sha384', 'sha384WithRSAEncryption', 'sha512', 'sha512-224',
    'sha512-224WithRSAEncryption', 'sha512-256', 'sha512-256WithRSAEncryption', 'sha512WithRSAEncryption',
    'shake128', 'shake256', 'sm3', 'sm3WithRSAEncryption', 'ssl3-md5', 'ssl3-sha1'
];

function digestFor(name: unknown): DigestSpec {
    /* OpenSSL names are case-insensitive, so the alias table is indexed the lowercased name. */
    const key = String(name ?? '').toLowerCase();
    const spec = DIGEST_ALIASES[key] !== undefined ? DIGEST_SPECS[DIGEST_ALIASES[key]] : DIGEST_SPECS[key];
    if (spec === undefined) {
        throw Object.assign(new Error('Digest method not supported'), { code: 'ERR_OSSL_EVP_UNSUPPORTED' });
    }
    return spec;
}

/** The output length a digest() call produces: the XOF's option, or the digest's own. */
function outputLengthFor(spec: DigestSpec, requested: unknown): number {
    if (requested === undefined || requested === null) return spec.out;
    const n = Number(requested);
    if (!spec.xof) {
        throw Object.assign(
            new Error('error:030000B2:digital envelope routines::not XOF or invalid length'),
            { code: 'ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH' }
        );
    }
    if (!Number.isInteger(n) || n < 0) {
        throw Object.assign(new Error('Invalid XOF output length'), { code: 'ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH' });
    }
    return n;
}

const bytesArg = (value: unknown): Uint8Array => base64ToBytes(typeof value === 'string' ? value : '');

/* ---------------------------------------------------------------------------------------------
 * HMAC, PBKDF2 and HKDF, built on the digest table above rather than on @noble's own helpers:
 * @noble's hmac and pbkdf2 take a hash *constructor* they drive instance-by-instance, which fits
 * the library's own hashes and nothing else. SM3, MD5-SHA1 and the SHA-3 family reach these three
 * constructions only through the table, so they are written out here (RFC 2104, PKCS#5, RFC 5869).
 * ------------------------------------------------------------------------------------------ */

/** RFC 2104: H(K ^ opad, H(K ^ ipad, m)), with the key itself hashed first when it is over a block. */
function hmacBytes(spec: DigestSpec, key: Uint8Array, msg: Uint8Array): Uint8Array {
    const k = key.length > spec.block ? spec.fn(key, spec.out) : key;
    const inner = new Uint8Array(spec.block);
    const outer = new Uint8Array(spec.block);
    for (let i = 0; i < spec.block; i++) {
        const byte = i < k.length ? k[i] : 0;
        inner[i] = byte ^ 0x36;
        outer[i] = byte ^ 0x5c;
    }
    return spec.fn(concatBytes(outer, spec.fn(concatBytes(inner, msg), spec.out)), spec.out);
}

/** PKCS#5 v2: dkLen bytes of PRF(password, salt || block counter) iterated c times and folded. */
function pbkdf2Bytes(spec: DigestSpec, password: Uint8Array, salt: Uint8Array, iterations: number, dkLen: number): Uint8Array {
    const blocks = Math.ceil(dkLen / spec.out);
    const out = new Uint8Array(blocks * spec.out);
    for (let block = 1; block <= blocks; block++) {
        const counter = new Uint8Array(4);
        counter[0] = (block >>> 24) & 0xff;
        counter[1] = (block >>> 16) & 0xff;
        counter[2] = (block >>> 8) & 0xff;
        counter[3] = block & 0xff;
        let u = hmacBytes(spec, password, concatBytes(salt, counter));
        const t = Uint8Array.from(u);
        for (let i = 1; i < iterations; i++) {
            u = hmacBytes(spec, password, u);
            for (let j = 0; j < t.length; j++) t[j] ^= u[j];
        }
        out.set(t, (block - 1) * spec.out);
    }
    return out.subarray(0, dkLen);
}

/** RFC 5869: extract a pseudorandom key with the salt, then expand it into keylen bytes. */
function hkdfBytes(spec: DigestSpec, ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, keylen: number): Uint8Array {
    /* An absent salt is HashLen zero bytes; an empty one is the empty string and is used as given. */
    const prk = hmacBytes(spec, salt.length > 0 ? salt : new Uint8Array(spec.out), ikm);
    const blocks = Math.ceil(keylen / spec.out);
    const out = new Uint8Array(blocks * spec.out);
    let t = new Uint8Array(0);
    for (let block = 0; block < blocks; block++) {
        t = hmacBytes(spec, prk, concatBytes(concatBytes(t, info), new Uint8Array([block + 1])));
        out.set(t, block * spec.out);
    }
    return out.subarray(0, keylen);
}

/* ---------------------------------------------------------------------------------------------
 * Ciphers: createCipheriv / createDecipheriv.
 *
 * The guest owns the object Node's callers see; the host owns the key, the chaining value and the
 * bytes buffered between calls, because @noble/ciphers is one-shot per cipher instance and lives
 * on this side of the capability boundary. ECB, CBC, CTR and CFB are emitted in the same chunk
 * sizes OpenSSL uses, so an incremental caller sees Node's byte counts. GCM and ChaCha20-Poly1305
 * cannot be resumed through @noble's one-shot entry points, so they emit at final() instead of at
 * update(); the concatenation of update() and final() is Node's either way.
 * ------------------------------------------------------------------------------------------ */

type CipherMode =
    | 'ecb'
    | 'cbc'
    | 'ctr'
    | 'cfb'
    | 'cfb8'
    | 'cfb1'
    | 'ofb'
    | 'xts'
    | 'gcm'
    | 'cc20p'
    | 'cc20'
    | 'wrap'
    | 'wrappad'
    | 'ccm'
    | 'ocb';

interface CipherSpec {
    mode: CipherMode;
    keyLength: number;
    /** 16 where OpenSSL emits a block at a time, 1 where it emits everything it is given. */
    blockSize: number;
    /** 0 for ECB, an exact length for the rest, -1 for GCM's variable nonce, -2 for a range. */
    ivLength: number;
    /** The ends of that range: CCM takes 7..13 and OCB 1..15, both named by their standards. */
    ivMin?: number;
    ivMax?: number;
    /** CCM and OCB are refused unless createCipheriv is given an authTagLength, which the guest
     *  never passes: Node's own default here is to throw, so these two are listed and no more. */
    needsAuthTagLength?: boolean;
    aead: boolean;
}

const CIPHER_SPECS: Record<string, CipherSpec> = {};
/** The names getCiphers() answers, spelled as OpenSSL spells them. Lookup is case-insensitive. */
const CIPHER_NAMES: string[] = [];

function addCipher(name: string, spec: CipherSpec): void {
    CIPHER_SPECS[name.toLowerCase()] = spec;
    CIPHER_NAMES.push(name);
}

for (const bits of [128, 192, 256]) {
    const keyLength = bits / 8;
    const cbc: CipherSpec = { mode: 'cbc', keyLength, blockSize: 16, ivLength: 16, aead: false };
    const gcm: CipherSpec = { mode: 'gcm', keyLength, blockSize: 1, ivLength: -1, aead: true };
    const ccm: CipherSpec = {
        mode: 'ccm', keyLength, blockSize: 1, ivLength: -2, ivMin: 7, ivMax: 13, aead: true, needsAuthTagLength: true
    };
    const wrap: CipherSpec = { mode: 'wrap', keyLength, blockSize: 1, ivLength: 8, aead: false };
    const wrapPad: CipherSpec = { mode: 'wrappad', keyLength, blockSize: 1, ivLength: 4, aead: false };
    addCipher(`aes-${bits}-ecb`, { mode: 'ecb', keyLength, blockSize: 16, ivLength: 0, aead: false });
    addCipher(`aes-${bits}-cbc`, cbc);
    addCipher(`aes-${bits}-ctr`, { mode: 'ctr', keyLength, blockSize: 1, ivLength: 16, aead: false });
    addCipher(`aes-${bits}-cfb`, { mode: 'cfb', keyLength, blockSize: 1, ivLength: 16, aead: false });
    addCipher(`aes-${bits}-cfb8`, { mode: 'cfb8', keyLength, blockSize: 1, ivLength: 16, aead: false });
    addCipher(`aes-${bits}-cfb1`, { mode: 'cfb1', keyLength, blockSize: 1, ivLength: 16, aead: false });
    addCipher(`aes-${bits}-ofb`, { mode: 'ofb', keyLength, blockSize: 1, ivLength: 16, aead: false });
    addCipher(`aes-${bits}-gcm`, gcm);
    addCipher(`aes-${bits}-ccm`, ccm);
    addCipher(`aes-${bits}-ocb`, {
        mode: 'ocb', keyLength, blockSize: 1, ivLength: -2, ivMin: 1, ivMax: 15, aead: true, needsAuthTagLength: true
    });
    /* OpenSSL carries no aes-192-xts: the tweak key would be a 192-bit half, and neither the
       standard nor the provider defines one. */
    if (bits !== 192) addCipher(`aes-${bits}-xts`, { mode: 'xts', keyLength: keyLength * 2, blockSize: 1, ivLength: 16, aead: false });
    /* The aliases OpenSSL answers: the bare size is CBC, and id-aes* is the cipher's own OID name,
       which keeps the upper-case tag its OID carries. */
    addCipher(`aes${bits}`, cbc);
    addCipher(`id-aes${bits}-GCM`, gcm);
    addCipher(`id-aes${bits}-CCM`, ccm);
    addCipher(`aes${bits}-wrap`, wrap);
    addCipher(`aes${bits}-wrap-pad`, wrapPad);
    addCipher(`id-aes${bits}-wrap`, wrap);
    addCipher(`id-aes${bits}-wrap-pad`, wrapPad);
}
/* OpenSSL accepts the spelled-out aes-<n>-wrap names as well but does not list them, so they are
   looked up and never answered by getCiphers(). */
function addAlias(name: string, spec: CipherSpec): void {
    CIPHER_SPECS[name.toLowerCase()] = spec;
}

for (const bits of [128, 192, 256]) {
    const keyLength = bits / 8;
    addAlias(`aes-${bits}-wrap`, { mode: 'wrap', keyLength, blockSize: 1, ivLength: 8, aead: false });
    addAlias(`aes-${bits}-wrap-pad`, { mode: 'wrappad', keyLength, blockSize: 1, ivLength: 4, aead: false });
}
/* OpenSSL's chacha20 takes a 16-byte IV: a 32-bit counter first, then the RFC 8439 nonce. */
addCipher('chacha20', { mode: 'cc20', keyLength: 32, blockSize: 1, ivLength: 16, aead: false });
addCipher('chacha20-poly1305', { mode: 'cc20p', keyLength: 32, blockSize: 1, ivLength: 12, aead: true });

/** What Node 24.15's getCipherInfo answers for each name here: nid, mode, the name OpenSSL spells,
 *  blockSize and ivLength, with 0 where the answer carries none. keyLength is the spec's own. */
const CIPHER_INFO: Record<string, [number, string, string, number, number]> = {
    'aes-128-ecb': [418, 'ecb', 'aes-128-ecb', 16, 0],
    'aes-128-cbc': [419, 'cbc', 'aes-128-cbc', 16, 16],
    'aes-128-ctr': [904, 'ctr', 'aes-128-ctr', 1, 16],
    'aes-128-cfb': [421, 'cfb', 'aes-128-cfb', 1, 16],
    'aes-128-cfb8': [653, 'cfb', 'aes-128-cfb8', 1, 16],
    'aes-128-cfb1': [650, 'cfb', 'aes-128-cfb1', 1, 16],
    'aes-128-ofb': [420, 'ofb', 'aes-128-ofb', 1, 16],
    'aes-128-gcm': [895, 'gcm', 'id-aes128-gcm', 1, 12],
    'aes-128-ccm': [896, 'ccm', 'id-aes128-ccm', 1, 12],
    'aes-128-ocb': [958, 'ocb', 'aes-128-ocb', 16, 12],
    'aes-128-xts': [913, 'xts', 'aes-128-xts', 1, 16],
    'aes128': [419, 'cbc', 'aes-128-cbc', 16, 16],
    'id-aes128-gcm': [895, 'gcm', 'id-aes128-gcm', 1, 12],
    'id-aes128-ccm': [896, 'ccm', 'id-aes128-ccm', 1, 12],
    'aes128-wrap': [788, 'wrap', 'id-aes128-wrap', 8, 8],
    'aes128-wrap-pad': [897, 'wrap', 'id-aes128-wrap-pad', 8, 4],
    'id-aes128-wrap': [788, 'wrap', 'id-aes128-wrap', 8, 8],
    'id-aes128-wrap-pad': [897, 'wrap', 'id-aes128-wrap-pad', 8, 4],
    'aes-192-ecb': [422, 'ecb', 'aes-192-ecb', 16, 0],
    'aes-192-cbc': [423, 'cbc', 'aes-192-cbc', 16, 16],
    'aes-192-ctr': [905, 'ctr', 'aes-192-ctr', 1, 16],
    'aes-192-cfb': [425, 'cfb', 'aes-192-cfb', 1, 16],
    'aes-192-cfb8': [654, 'cfb', 'aes-192-cfb8', 1, 16],
    'aes-192-cfb1': [651, 'cfb', 'aes-192-cfb1', 1, 16],
    'aes-192-ofb': [424, 'ofb', 'aes-192-ofb', 1, 16],
    'aes-192-gcm': [898, 'gcm', 'id-aes192-gcm', 1, 12],
    'aes-192-ccm': [899, 'ccm', 'id-aes192-ccm', 1, 12],
    'aes-192-ocb': [959, 'ocb', 'aes-192-ocb', 16, 12],
    'aes192': [423, 'cbc', 'aes-192-cbc', 16, 16],
    'id-aes192-gcm': [898, 'gcm', 'id-aes192-gcm', 1, 12],
    'id-aes192-ccm': [899, 'ccm', 'id-aes192-ccm', 1, 12],
    'aes192-wrap': [789, 'wrap', 'id-aes192-wrap', 8, 8],
    'aes192-wrap-pad': [900, 'wrap', 'id-aes192-wrap-pad', 8, 4],
    'id-aes192-wrap': [789, 'wrap', 'id-aes192-wrap', 8, 8],
    'id-aes192-wrap-pad': [900, 'wrap', 'id-aes192-wrap-pad', 8, 4],
    'aes-256-ecb': [426, 'ecb', 'aes-256-ecb', 16, 0],
    'aes-256-cbc': [427, 'cbc', 'aes-256-cbc', 16, 16],
    'aes-256-ctr': [906, 'ctr', 'aes-256-ctr', 1, 16],
    'aes-256-cfb': [429, 'cfb', 'aes-256-cfb', 1, 16],
    'aes-256-cfb8': [655, 'cfb', 'aes-256-cfb8', 1, 16],
    'aes-256-cfb1': [652, 'cfb', 'aes-256-cfb1', 1, 16],
    'aes-256-ofb': [428, 'ofb', 'aes-256-ofb', 1, 16],
    'aes-256-gcm': [901, 'gcm', 'id-aes256-gcm', 1, 12],
    'aes-256-ccm': [902, 'ccm', 'id-aes256-ccm', 1, 12],
    'aes-256-ocb': [960, 'ocb', 'aes-256-ocb', 16, 12],
    'aes-256-xts': [914, 'xts', 'aes-256-xts', 1, 16],
    'aes256': [427, 'cbc', 'aes-256-cbc', 16, 16],
    'id-aes256-gcm': [901, 'gcm', 'id-aes256-gcm', 1, 12],
    'id-aes256-ccm': [902, 'ccm', 'id-aes256-ccm', 1, 12],
    'aes256-wrap': [790, 'wrap', 'id-aes256-wrap', 8, 8],
    'aes256-wrap-pad': [903, 'wrap', 'id-aes256-wrap-pad', 8, 4],
    'id-aes256-wrap': [790, 'wrap', 'id-aes256-wrap', 8, 8],
    'id-aes256-wrap-pad': [903, 'wrap', 'id-aes256-wrap-pad', 8, 4],
    /* The spelled-out wrap names OpenSSL answers but does not list: getCipherInfo knows them. */
    'aes-128-wrap': [788, 'wrap', 'id-aes128-wrap', 8, 8],
    'aes-128-wrap-pad': [897, 'wrap', 'id-aes128-wrap-pad', 8, 4],
    'aes-192-wrap': [789, 'wrap', 'id-aes192-wrap', 8, 8],
    'aes-192-wrap-pad': [900, 'wrap', 'id-aes192-wrap-pad', 8, 4],
    'aes-256-wrap': [790, 'wrap', 'id-aes256-wrap', 8, 8],
    'aes-256-wrap-pad': [903, 'wrap', 'id-aes256-wrap-pad', 8, 4],
    'chacha20': [1019, 'stream', 'chacha20', 0, 16],
    'chacha20-poly1305': [1018, 'stream', 'chacha20-poly1305', 0, 12]
};

/**
 * Node's getCipherInfo: undefined for a name no cipher here carries, and for one whose keyLength or
 * ivLength a caller asked for is not the cipher's own. A nid names the cipher as a name does.
 */
function cipherInfo(nameOrNid: unknown, options: any): Record<string, unknown> | undefined {
    const key = typeof nameOrNid === 'number'
        ? Object.keys(CIPHER_INFO).find((name) => CIPHER_INFO[name][0] === nameOrNid)
        : typeof nameOrNid === 'string' ? nameOrNid.toLowerCase() : undefined;
    if (key === undefined) return undefined;
    const entry = CIPHER_INFO[key];
    const spec = CIPHER_SPECS[key];
    if (spec === undefined) return undefined;
    const keyLength = spec.keyLength;
    const ivLength = entry[4];
    if (options !== undefined && options !== null) {
        if (options.keyLength !== undefined && options.keyLength !== null && Number(options.keyLength) !== keyLength) return undefined;
        if (options.ivLength !== undefined && options.ivLength !== null && Number(options.ivLength) !== ivLength) return undefined;
    }
    /* The field order is the one host Node 24.15's JSON answers with. */
    const info: Record<string, unknown> = { mode: entry[1], name: entry[2], nid: entry[0] };
    if (entry[3] !== 0) info.blockSize = entry[3];
    if (ivLength !== 0) info.ivLength = ivLength;
    info.keyLength = keyLength;
    return info;
}

/** GCM accepts a nonce of almost any length in Node; @noble draws the line at 8 bytes. */
const GCM_MIN_IV = 8;
const TAG_LENGTH = 16;
const BLOCK = 16;
/** A cipher a process abandoned without calling final() is dropped rather than kept forever. */
const OPEN_CIPHER_LIMIT = 256;

interface CipherState {
    spec: CipherSpec;
    direction: 'encrypt' | 'decrypt';
    key: Uint8Array;
    /** CBC and CFB chaining value, CTR counter block, or the AEAD nonce. */
    iv: Uint8Array;
    /** CTR only: how many bytes of the current counter block are already spent. */
    counterOffset: number;
    /** CFB only: the ciphertext of the block being filled, and E(register) while it is open. */
    chainBuf: Uint8Array;
    keystream: Uint8Array | null;
    pending: Uint8Array;
    autoPadding: boolean;
    /** Whether any data has been through update(): AAD cannot be set after it has. */
    updated: boolean;
    /** XTS and the two key wraps answer once and refuse a second update, as OpenSSL does. */
    emitted: boolean;
    aad: Uint8Array;
    tag?: Uint8Array;
    /** 16 unless createCipheriv was given an authTagLength, which Node honours for GCM and for
     *  chacha20-poly1305: the tag a caller reads is the first that many bytes of the full one. */
    tagLength: number;
}

const CIPHER_STATE = new Map<number, CipherState>();
let nextCipherId = 1;

/**
 * Node distinguishes these by constructor, and the capability envelope carries a code and a message
 * but not a class, so the class travels as a property the guest rebuilds from. `code: null` marks an
 * error Node raises without a code at all, such as a failed AEAD tag check.
 */
function cipherFail(code: string | null, message: string, kind: 'Error' | 'RangeError' | 'TypeError' = 'Error'): never {
    const Ctor = kind === 'RangeError' ? RangeError : kind === 'TypeError' ? TypeError : Error;
    throw Object.assign(new Ctor(message), { code: code ?? 'ERR_CAPABILITY', owcErrorClass: kind, owcUncoded: code === null });
}

const invalidKeyLength = () => cipherFail('ERR_CRYPTO_INVALID_KEYLEN', 'Invalid key length', 'RangeError');
const invalidIv = () => cipherFail('ERR_CRYPTO_INVALID_IV', 'Invalid initialization vector', 'TypeError');
const invalidState = (op: string) => cipherFail('ERR_CRYPTO_INVALID_STATE', `Invalid state for operation ${op}`);
const wrongFinalBlock = () => cipherFail('ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH', 'error:1C80006B:Provider routines::wrong final block length');
const badDecrypt = () => cipherFail('ERR_OSSL_BAD_DECRYPT', 'error:1C800064:Provider routines::bad decrypt');
const authFailure = () => cipherFail(null, 'Unsupported state or unable to authenticate data');

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** Advances CTR's 16-byte big-endian counter by the blocks `consumed` bytes spanned. */
function advanceCounter(state: CipherState, consumed: number): void {
    let add = Math.floor(consumed / BLOCK);
    for (let i = BLOCK - 1; i >= 0 && add > 0; i--) {
        const sum = state.iv[i] + (add % 256);
        state.iv[i] = sum % 256;
        add = Math.floor(add / 256) + Math.floor(sum / 256);
    }
    state.counterOffset = consumed % BLOCK;
}

/** One pass over whole blocks, padding off: the caller pads, or holds a block back, itself. */
function transformBlocks(state: CipherState, bytes: Uint8Array): Uint8Array {
    const { spec, key } = state;
    const encrypt = state.direction === 'encrypt';
    if (bytes.length === 0) return new Uint8Array(0);
    if (spec.mode === 'ofb' || spec.mode === 'cfb8' || spec.mode === 'cfb1' || spec.mode === 'cc20') {
        return streamBytes(state, bytes);
    }
    switch (spec.mode) {
        case 'ecb': {
            const cipher = ecb(key, { disablePadding: true });
            return encrypt ? cipher.encrypt(bytes) : cipher.decrypt(bytes);
        }
        case 'cbc': {
            const cipher = cbc(key, state.iv, { disablePadding: true });
            const out = encrypt ? cipher.encrypt(bytes) : cipher.decrypt(bytes);
            if (out.length >= BLOCK) state.iv = (encrypt ? out : bytes).slice(-BLOCK);
            return out;
        }
        case 'cfb': {
            /*
             * CFB's keystream block is E(register), and the register becomes the ciphertext block
             * once one is complete, so a call that ends mid-block leaves the rest of that block for
             * the next call. Bytes are emitted as they arrive, as OpenSSL emits them.
             */
            const out = new Uint8Array(bytes.length);
            let at = 0;
            while (at < bytes.length) {
                if (state.keystream === null) state.keystream = aesBlock(state);
                const take = Math.min(BLOCK - state.counterOffset, bytes.length - at);
                for (let j = 0; j < take; j++) {
                    const produced = bytes[at + j] ^ state.keystream[state.counterOffset + j];
                    out[at + j] = produced;
                    state.chainBuf[state.counterOffset + j] = encrypt ? produced : bytes[at + j];
                }
                state.counterOffset += take;
                at += take;
                if (state.counterOffset === BLOCK) {
                    state.iv = state.chainBuf.slice(0, BLOCK);
                    state.counterOffset = 0;
                    state.keystream = null;
                }
            }
            return out;
        }
        default: {
            const blocks = Math.ceil((state.counterOffset + bytes.length) / BLOCK);
            const stream = ctr(key, state.iv).encrypt(new Uint8Array(blocks * BLOCK));
            const out = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ stream[state.counterOffset + i];
            advanceCounter(state, state.counterOffset + bytes.length);
            return out;
        }
    }
}

/** The raw AES block encryption of the current register or counter: ECB over one block, padding off.
 *  @noble's cipher objects are one-shot, so each block gets its own. */
function aesBlock(state: CipherState): Uint8Array {
    return ecb(state.key, { disablePadding: true }).encrypt(state.iv);
}

/* Streaming modes OpenSSL answers with everything it is given. OFB feeds the keystream block back
 * into the register; CFB8 shifts the register one byte at a time and CFB8's one-bit cousin one bit
 * at a time, each inserting the byte or bit it produced (or consumed) at the low end; and ChaCha20
 * counts blocks from the counter OpenSSL takes as the first four bytes of the IV. */

/** One pass over whole blocks, padding off: the caller pads, or holds a block back, itself. */
function streamBytes(state: CipherState, bytes: Uint8Array): Uint8Array {
    const key = state.key;
    const encrypt = state.direction === 'encrypt';
    const out = new Uint8Array(bytes.length);
    switch (state.spec.mode) {
        case 'ofb': {
            for (let i = 0; i < bytes.length; i++) {
                if (state.counterOffset === 0) {
                    state.keystream = ecb(key, { disablePadding: true }).encrypt(state.iv);
                    state.iv = Uint8Array.from(state.keystream);
                }
                out[i] = bytes[i] ^ state.keystream![state.counterOffset];
                state.counterOffset = (state.counterOffset + 1) % BLOCK;
            }
            return out;
        }
        case 'cfb8': {
            const reg = Uint8Array.from(state.iv);
            for (let i = 0; i < bytes.length; i++) {
                const produced = bytes[i] ^ ecb(key, { disablePadding: true }).encrypt(reg)[0];
                out[i] = produced;
                reg.copyWithin(0, 1);
                reg[BLOCK - 1] = encrypt ? produced : bytes[i];
            }
            state.iv = reg;
            return out;
        }
        case 'cfb1': {
            const reg = Uint8Array.from(state.iv);
            for (let i = 0; i < bytes.length; i++) {
                let byte = 0;
                for (let b = 7; b >= 0; b--) {
                    const bit = ((bytes[i] >> b) & 1) ^ ((ecb(key, { disablePadding: true }).encrypt(reg)[0] >> 7) & 1);
                    byte = (byte << 1) | bit;
                    for (let j = 0; j < BLOCK - 1; j++) reg[j] = ((reg[j] << 1) | ((reg[j + 1] >> 7) & 1)) & 0xff;
                    reg[BLOCK - 1] = ((reg[BLOCK - 1] << 1) | (encrypt ? bit : (bytes[i] >> b) & 1)) & 0xff;
                }
                out[i] = byte;
            }
            state.iv = reg;
            return out;
        }
        default: {
            const nonce = state.iv;
            const stream = chacha20(key, nonce, bytes, undefined, state.counterOffset);
            state.counterOffset += Math.ceil(bytes.length / 64);
            return stream;
        }
    }
}

/* ---------------------------------------------------------------------------------------------
 * XTS (IEEE 1619) and the two AES key wraps (RFC 3394 and RFC 5649), which OpenSSL answers in one
 * shot: the first update emits everything, final() is empty, and a second update is refused.
 * ------------------------------------------------------------------------------------------ */

/** Multiplication by alpha, x, in GF(2^128) with the bytes read least significant first. */
function xtsTweakStep(tweak: Uint8Array): Uint8Array {
    const out = new Uint8Array(BLOCK);
    let carry = 0;
    for (let i = 0; i < BLOCK; i++) {
        out[i] = ((tweak[i] << 1) | carry) & 0xff;
        carry = (tweak[i] >> 7) & 1;
    }
    if (carry) out[0] ^= 0x87;
    return out;
}

/** XTS carries two keys: the second encrypts the tweak and the first the data. */
function xtsTransform(state: CipherState, data: Uint8Array): Uint8Array {
    const half = state.key.length / 2;
    const dataKey = state.key.subarray(0, half);
    const tweakKey = state.key.subarray(half);
    const encrypt = state.direction === 'encrypt';
    const block = (key: Uint8Array, bytes: Uint8Array) =>
        encrypt
            ? ecb(key, { disablePadding: true }).encrypt(bytes)
            : ecb(key, { disablePadding: true }).decrypt(bytes);
    const out = new Uint8Array(data.length);
    const whole = Math.floor(data.length / BLOCK);
    const rem = data.length % BLOCK;
    let tweak = ecb(tweakKey, { disablePadding: true }).encrypt(state.iv);
    /* A short tail is stolen: the last whole block and the tail share one block, and the whole
       block's ciphertext is cut down to the tail's length and written after the shared one. */
    const full = rem > 0 ? whole - 1 : whole;
    for (let i = 0; i < full; i++) {
        const at = i * BLOCK;
        const masked = new Uint8Array(BLOCK);
        for (let j = 0; j < BLOCK; j++) masked[j] = data[at + j] ^ tweak[j];
        const cc = block(dataKey, masked);
        for (let j = 0; j < BLOCK; j++) out[at + j] = cc[j] ^ tweak[j];
        tweak = xtsTweakStep(tweak);
    }
    if (rem === 0) return out;
    if (encrypt) {
        const at = full * BLOCK;
        const masked = new Uint8Array(BLOCK);
        for (let j = 0; j < BLOCK; j++) masked[j] = data[at + j] ^ tweak[j];
        const cc = block(dataKey, masked);
        for (let j = 0; j < BLOCK; j++) cc[j] ^= tweak[j];
        const next = xtsTweakStep(tweak);
        const stolen = new Uint8Array(BLOCK);
        stolen.set(data.subarray(whole * BLOCK), 0);
        for (let j = rem; j < BLOCK; j++) stolen[j] = cc[j];
        for (let j = 0; j < BLOCK; j++) stolen[j] ^= next[j];
        const cp = block(dataKey, stolen);
        for (let j = 0; j < BLOCK; j++) cp[j] ^= next[j];
        out.set(cp, at);
        out.set(cc.subarray(0, rem), whole * BLOCK);
        return out;
    }
    const at = full * BLOCK;
    const next = xtsTweakStep(tweak);
    const plainTail = new Uint8Array(BLOCK);
    for (let j = 0; j < BLOCK; j++) plainTail[j] = data[at + j] ^ next[j];
    const tail = block(dataKey, plainTail);
    for (let j = 0; j < BLOCK; j++) tail[j] ^= next[j];
    const cc = new Uint8Array(BLOCK);
    cc.set(data.subarray(whole * BLOCK), 0);
    cc.set(tail.subarray(rem), rem);
    const masked = new Uint8Array(BLOCK);
    for (let j = 0; j < BLOCK; j++) masked[j] = cc[j] ^ tweak[j];
    const last = block(dataKey, masked);
    for (let j = 0; j < BLOCK; j++) out[at + j] = last[j] ^ tweak[j];
    out.set(tail.subarray(0, rem), whole * BLOCK);
    return out;
}

/** The wrap counter t as eight bytes, most significant first. */
function wrapCounter(t: number): Uint8Array {
    const out = new Uint8Array(8);
    let rest = t;
    for (let k = 7; k >= 0; k--) {
        out[k] = rest % 256;
        rest = Math.floor(rest / 256);
    }
    return out;
}

function xorInto(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
    return out;
}

/** RFC 3394, with the caller's IV as the starting value rather than the A6A6... default: OpenSSL
 *  answers the wrap ciphers with whatever IV it was handed, and a caller sees that. */
function aesWrap(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
    const n = Math.floor(data.length / 8);
    let a = Uint8Array.from(iv);
    const blocks: Uint8Array[] = [];
    for (let i = 0; i < n; i++) blocks.push(data.subarray(i * 8, i * 8 + 8));
    for (let j = 0; j < 6; j++) {
        for (let i = 0; i < n; i++) {
            const b = ecb(key, { disablePadding: true }).encrypt(concatBytes(a, blocks[i]));
            a = xorInto(b.subarray(0, 8), wrapCounter(n * j + i + 1));
            blocks[i] = b.subarray(8);
        }
    }
    let out = Uint8Array.from(a);
    for (const block of blocks) out = concatBytes(out, block);
    return out;
}

/** The unwrapped bytes and the starting value they authenticate, which RFC 5649 keeps the length in. */
function aesUnwrap(key: Uint8Array, data: Uint8Array): { a: Uint8Array; plain: Uint8Array } {
    const n = Math.floor(data.length / 8) - 1;
    let a = Uint8Array.from(data.subarray(0, 8));
    const blocks: Uint8Array[] = [];
    for (let i = 0; i < n; i++) blocks.push(data.subarray(8 + i * 8, 16 + i * 8));
    for (let j = 5; j >= 0; j--) {
        for (let i = n - 1; i >= 0; i--) {
            const b = ecb(key, { disablePadding: true }).decrypt(concatBytes(xorInto(a, wrapCounter(n * j + i + 1)), blocks[i]));
            a = b.subarray(0, 8);
            blocks[i] = b.subarray(8);
        }
    }
    let out = new Uint8Array(0);
    for (const block of blocks) out = concatBytes(out, block);
    return { a, plain: out };
}

/** RFC 5649: a four-byte alternative IV and the plaintext's own length ahead of the padded data. */
function aesWrapPad(key: Uint8Array, aiv: Uint8Array, data: Uint8Array): Uint8Array {
    const padded = new Uint8Array(Math.max(8, Math.ceil(data.length / 8) * 8));
    padded.set(data, 0);
    const len = data.length;
    const a = concatBytes(aiv, new Uint8Array([(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]));
    if (padded.length === 8) return ecb(key, { disablePadding: true }).encrypt(concatBytes(a, padded));
    return aesWrap(key, a, padded);
}

/** A wrap whose integrity check fails: the words OpenSSL uses for a wrap it cannot unwrap. */
function wrapIntegrity(): never {
    return cipherFail(null, 'Trying to add data in unsupported state');
}

function aesUnwrapPad(key: Uint8Array, aiv: Uint8Array, data: Uint8Array): Uint8Array {
    /* RFC 5649 keeps the AIV's first half for the IV it was wrapped with and puts the plaintext's
       own length in the second, so both come back: a length the padded data cannot hold, or an IV
       that is not the one given, is a wrap this key and IV never produced. */
    if (data.length === 16) {
        const b = ecb(key, { disablePadding: true }).decrypt(data);
        const len = readWrapLength(b, 4);
        if (len > 8) throw wrapIntegrity();
        for (let i = 0; i < 4; i++) if (b[i] !== aiv[i]) throw wrapIntegrity();
        return b.subarray(8, 8 + len);
    }
    const { a, plain } = aesUnwrap(key, data);
    const len = readWrapLength(a, 4);
    if (len > plain.length) throw wrapIntegrity();
    for (let i = 0; i < 4; i++) if (a[i] !== aiv[i]) throw wrapIntegrity();
    return plain.subarray(0, len);
}

/** The four bytes of a wrap's starting value at `at`, most significant first. */
function readWrapLength(bytes: Uint8Array, at: number): number {
    return ((bytes[at] * 16777216) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]) >>> 0;
}

function aeadCipher(state: CipherState) {
    const aad = state.aad.length > 0 ? state.aad : undefined;
    return state.spec.mode === 'gcm'
        ? gcm(state.key, state.iv, aad)
        : chacha20poly1305(state.key, state.iv, aad);
}

/** PKCS#7 removal: a padding byte outside 1..16, or a block that does not end in it, is a bad decrypt. */
function unpad(bytes: Uint8Array): Uint8Array {
    const pad = bytes[bytes.length - 1];
    if (pad < 1 || pad > BLOCK || pad > bytes.length) throw badDecrypt();
    for (let i = bytes.length - pad; i < bytes.length; i++) if (bytes[i] !== pad) throw badDecrypt();
    return bytes.subarray(0, bytes.length - pad);
}

function cipherUpdate(state: CipherState, input: Uint8Array): Uint8Array {
    state.updated = true;
    /* XTS answers in one shot: everything comes back from the first update. */
    if (state.spec.mode === 'xts') {
        if (state.emitted) throw cipherFail(null, 'Trying to add data in unsupported state');
        const all = concatBytes(state.pending, input);
        state.pending = new Uint8Array(0);
        state.emitted = true;
        if (all.length < BLOCK) throw cipherFail(null, 'Trying to add data in unsupported state');
        return xtsTransform(state, all);
    }
    /* A key wrap answers every update on its own, as OpenSSL's does: two updates of sixteen bytes
       are two wraps, not one of thirty-two. RFC 3394 wraps two blocks or more and nothing between,
       so a length that is not a whole number of blocks, or is shorter than two, is refused rather
       than wrapped as far as it goes; empty input wraps nothing and leaves the cipher open. */
    if (state.spec.mode === 'wrap' || state.spec.mode === 'wrappad') {
        const encrypt = state.direction === 'encrypt';
        if (input.length === 0) return new Uint8Array(0);
        if (state.spec.mode === 'wrap') {
            if (input.length < (encrypt ? 16 : 24) || input.length % 8 !== 0) {
                throw cipherFail(null, 'Trying to add data in unsupported state');
            }
        } else if (!encrypt && (input.length < 16 || input.length % 8 !== 0)) {
            throw cipherFail(null, 'Trying to add data in unsupported state');
        }
        if (state.spec.mode === 'wrap') {
            if (!encrypt) {
                const unwrapped = aesUnwrap(state.key, input);
                /* RFC 3394's integrity check: the alternative IV the wrap was made with comes back,
                   and one that does not is a wrap this key and IV never produced. */
                for (let i = 0; i < state.iv.length; i++) {
                    if (unwrapped.a[i] !== state.iv[i]) throw wrapIntegrity();
                }
                return unwrapped.plain;
            }
            return aesWrap(state.key, state.iv, input);
        }
        return encrypt ? aesWrapPad(state.key, state.iv, input) : aesUnwrapPad(state.key, state.iv, input);
    }
    if (state.spec.aead) {
        state.pending = concatBytes(state.pending, input);
        return new Uint8Array(0);
    }
    const total = concatBytes(state.pending, input);
    const block = state.spec.blockSize;
    let emit = Math.floor(total.length / block) * block;
    /* A decrypting block cipher with padding keeps its last whole block: it may hold the padding. */
    if (block === BLOCK && state.direction === 'decrypt' && state.autoPadding && total.length >= BLOCK && total.length % BLOCK === 0) {
        emit -= BLOCK;
    }
    const out = transformBlocks(state, total.subarray(0, emit));
    state.pending = total.subarray(emit);
    return out;
}

function cipherFinal(state: CipherState): { data: Uint8Array; tag?: Uint8Array } {
    const rest = state.pending;
    state.pending = new Uint8Array(0);
    if (state.spec.aead) {
        if (state.direction === 'encrypt') {
            const sealed = aeadCipher(state).encrypt(rest);
            const at = sealed.length - TAG_LENGTH;
            return {
                data: sealed.subarray(0, at),
                tag: sealed.subarray(at, at + state.tagLength)
            };
        }
        if (state.tag === undefined) throw authFailure();
        try {
            return { data: aeadCipher(state).decrypt(concatBytes(rest, state.tag)) };
        } catch {
            throw authFailure();
        }
    }
    if (state.spec.blockSize === BLOCK) {
        if (state.autoPadding) {
            if (state.direction === 'encrypt') {
                const pad = BLOCK - (rest.length % BLOCK);
                const block = new Uint8Array(rest.length + pad);
                block.set(rest, 0);
                block.fill(pad, rest.length);
                return { data: transformBlocks(state, block) };
            }
            if (rest.length === 0 || rest.length % BLOCK !== 0) throw wrongFinalBlock();
            return { data: unpad(transformBlocks(state, rest)) };
        }
        if (rest.length % BLOCK !== 0) throw wrongFinalBlock();
        return { data: rest.length === 0 ? rest : transformBlocks(state, rest) };
    }
    return { data: new Uint8Array(0) };
}

function stateFor(id: unknown, op: string): CipherState {
    const state = CIPHER_STATE.get(Number(id));
    if (state === undefined) throw invalidState(op);
    return state;
}

function openCipher(args: any): { id: number; aead: boolean } {
    const algorithm = String(args?.algorithm ?? '');
    const spec = CIPHER_SPECS[algorithm.toLowerCase()];
    if (spec === undefined) throw cipherFail('ERR_CRYPTO_UNKNOWN_CIPHER', 'Unknown cipher');
    /* Node reports a bad IV before a bad key, and an unknown cipher before either. */
    const iv = typeof args?.iv === 'string' ? base64ToBytes(args.iv) : new Uint8Array(0);
    if (spec.ivLength === 0) {
        if (iv.length !== 0) throw invalidIv();
    } else if (spec.ivLength > 0) {
        if (iv.length !== spec.ivLength) throw invalidIv();
    } else if (spec.ivLength === -1) {
        if (iv.length < GCM_MIN_IV) throw invalidIv();
    } else if (iv.length < (spec.ivMin ?? 0) || iv.length > (spec.ivMax ?? 0)) {
        throw invalidIv();
    }
    /* CCM and OCB answer no tag length of their own, so Node refuses them outright and names the
       cipher it refused. The guest passes no options, so the refusal is unconditional here. */
    if (spec.needsAuthTagLength === true) {
        throw cipherFail('ERR_CRYPTO_INVALID_AUTH_TAG', `authTagLength required for ${algorithm}`, 'TypeError');
    }
    /* Node takes an authTagLength of 4 to 16 for GCM and for chacha20-poly1305 and refuses any
       other, before it looks at the key; a cipher that seals nothing ignores the option. */
    let tagLength = TAG_LENGTH;
    const wanted = args?.options?.authTagLength;
    if (spec.aead && wanted !== undefined && wanted !== null) {
        tagLength = Number(wanted);
        if (tagLength < 4 || tagLength > TAG_LENGTH) {
            throw cipherFail('ERR_CRYPTO_INVALID_AUTH_TAG', `Invalid authentication tag length: ${wanted}`, 'TypeError');
        }
    }
    const key = bytesArg(args?.key);
    if (key.length !== spec.keyLength) throw invalidKeyLength();
    if (spec.mode === 'xts') {
        const half = spec.keyLength / 2;
        let duplicated = true;
        for (let i = 0; i < half; i++) {
            if (key[i] !== key[half + i]) {
                duplicated = false;
                break;
            }
        }
        if (duplicated) throw cipherFail('ERR_OSSL_XTS_DUPLICATED_KEYS', 'error:1C800095:Provider routines::xts duplicated keys');
    }
    if (CIPHER_STATE.size >= OPEN_CIPHER_LIMIT) {
        const oldest = CIPHER_STATE.keys().next().value;
        if (oldest !== undefined) CIPHER_STATE.delete(oldest);
    }
    const id = nextCipherId++;
    /* OpenSSL's chacha20 takes the 16-byte IV as a 32-bit counter and then the RFC 8439 nonce. */
    const nonce = spec.mode === 'cc20' ? iv.subarray(4) : iv;
    const counter = spec.mode === 'cc20' ? iv[0] + iv[1] * 256 + iv[2] * 65536 + iv[3] * 16777216 : 0;
    CIPHER_STATE.set(id, {
        spec,
        direction: args?.direction === 'decrypt' ? 'decrypt' : 'encrypt',
        key,
        iv: nonce,
        counterOffset: counter,
        chainBuf: new Uint8Array(BLOCK),
        keystream: null,
        pending: new Uint8Array(0),
        autoPadding: true,
        updated: false,
        emitted: false,
        aad: new Uint8Array(0),
        tagLength
    });
    return { id, aead: spec.aead };
}

/* ---------------------------------------------------------------------------------------------
 * DER. Keys reach a caller as SPKI or PKCS#8 (PEM or DER) and as JWK, so the host needs to write
 * and read a handful of ASN.1 types: SEQUENCE, INTEGER, OCTET STRING, BIT STRING, OBJECT
 * IDENTIFIER and the one context tag the EC structures use. Only what these encodings need.
 * ------------------------------------------------------------------------------------------ */

const DER_SEQUENCE = 0x30;
const DER_INTEGER = 0x02;
const DER_BIT_STRING = 0x03;
const DER_OCTET_STRING = 0x04;
const DER_NULL = 0x05;
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
    return concatBytes(new Uint8Array([tag]), concatBytes(derLength(content.length), content));
}

/** The parts of a SEQUENCE in order; concatBytes here is the two-argument one above. */
const derSequence = (parts: Uint8Array[]): Uint8Array =>
    der(DER_SEQUENCE, parts.reduce((all, part) => concatBytes(all, part), new Uint8Array(0)));
const derOctetString = (bytes: Uint8Array): Uint8Array => der(DER_OCTET_STRING, bytes);
/** BIT STRING: one leading byte saying how many bits of the last byte are unused. */
const derBitString = (bytes: Uint8Array): Uint8Array => der(DER_BIT_STRING, concatBytes(new Uint8Array([0]), bytes));

/** INTEGER: minimal two's complement, so a leading byte above 0x7f takes a 0x00 with it. */
function derInteger(bytes: Uint8Array): Uint8Array {
    let at = 0;
    while (at < bytes.length - 1 && bytes[at] === 0) at++;
    let body = bytes.subarray(at);
    if (body.length > 0 && body[0] > 0x7f) body = concatBytes(new Uint8Array([0]), body);
    return der(DER_INTEGER, body.length === 0 ? new Uint8Array([0]) : body);
}

const derIntegerFrom = (value: number): Uint8Array => derInteger(new Uint8Array([value]));

/** OBJECT IDENTIFIER: base-128 sub-identifiers, with the first two folded into one. */
function derOid(dotted: string): Uint8Array {
    const parts = dotted.split('.').map(Number);
    const bytes: number[] = [40 * parts[0] + parts[1]];
    for (const part of parts.slice(2)) {
        const stack: number[] = [part & 0x7f];
        let rest = part >>> 7;
        while (rest > 0) {
            stack.unshift((rest & 0x7f) | 0x80);
            rest >>>= 7;
        }
        bytes.push(...stack);
    }
    return der(DER_OID, new Uint8Array(bytes));
}

/** A context-specific constructed wrapper, the [0] and [1] the EC key structures carry. */
const derContext = (index: number, content: Uint8Array): Uint8Array => der(0xa0 | index, content);

interface DerNode {
    tag: number;
    content: Uint8Array;
    children: DerNode[];
}

/** Parses one TLV and reports where the next one starts; SEQUENCE and context wrappers recurse. */
function derParse(bytes: Uint8Array, at: number, end: number): { node: DerNode; next: number } {
    const tag = bytes[at];
    let length = bytes[at + 1];
    let bodyAt = at + 2;
    if (length & 0x80) {
        const count = length & 0x7f;
        length = 0;
        for (let i = 0; i < count; i++) length = length * 256 + bytes[bodyAt + i];
        bodyAt += count;
    }
    if (bodyAt + length > end) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid ASN.1: truncated element');
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

/* ---------------------------------------------------------------------------------------------
 * PEM: a DER body between a BEGIN and an END line, base64 wrapped at 64 characters.
 * ------------------------------------------------------------------------------------------ */

function pemEncode(label: string, der: Uint8Array): string {
    const body = bytesToBase64(der);
    const lines: string[] = [];
    for (let at = 0; at < body.length; at += 64) lines.push(body.slice(at, at + 64));
    return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function pemDecode(text: string, label: string): Uint8Array {
    const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
    if (match === null) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid PEM: no BEGIN/END block');
    if (match[1] !== label) {
        throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', `Invalid PEM label: expected ${label}, got ${match[1]}`);
    }
    const body = match[2].replace(/[^A-Za-z0-9+/=]/g, '');
    try {
        return base64ToBytes(body);
    } catch {
        throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid PEM: bad base64');
    }
}

const base64url = (bytes: Uint8Array): string =>
    bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromBase64url(text: unknown, field: string): Uint8Array {
    if (typeof text !== 'string') throw keyFail('ERR_CRYPTO_INVALID_JWK', `Invalid JWK: ${field} is not a string`);
    const padded = text.replace(/-/g, '+').replace(/_/g, '/');
    try {
        return base64ToBytes(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    } catch {
        throw keyFail('ERR_CRYPTO_INVALID_JWK', `Invalid JWK: ${field} is not base64url`);
    }
}

/* ---------------------------------------------------------------------------------------------
 * Asymmetric keys. The host keeps every key's bytes and hands the guest an integer handle, so no
 * key material is ever copied into the guest realm. Ed25519, X25519, Ed448, X448 and the four EC
 * curves @noble/curves carries are supported. RSA is not: a key pair needs a large random prime
 * search, and the caller would still be waiting for it.
 * ------------------------------------------------------------------------------------------ */

type KeyKind = 'ed25519' | 'x25519' | 'ed448' | 'x448' | 'ec' | 'rsa' | 'rsa-pss' | 'dsa' | 'dh';

interface EcCurve {
    /** Node's name for the curve, and the JWK name a caller sees. */
    node: string;
    jwk: string;
    oid: string;
    /** Bytes in a coordinate, and in the private scalar once it is padded to the field size. */
    size: number;
    curve: {
        /** The second argument is `false` so the point is uncompressed, the shape SPKI carries. */
        getPublicKey: (priv: Uint8Array, compressed?: boolean) => Uint8Array;
        utils: { randomPrivateKey: () => Uint8Array };
        sign: (msg: Uint8Array, priv: Uint8Array, opts: { lowS: boolean; prehash: boolean; extraEntropy?: Uint8Array }) => { toBytes: (format: string) => Uint8Array };
        verify: (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array, opts: { lowS: boolean; prehash: boolean; format?: 'der' | 'compact' }) => boolean;
        /** Key agreement over the curve, the way Node's diffieHellman over two EC keys asks for it. */
        getSharedSecret: (priv: Uint8Array, pub: Uint8Array, compressed?: boolean) => Uint8Array;
    };
}

const EC_CURVES: Record<string, EcCurve> = {};
for (const [node, jwk, oid, size, curve] of [
    ['prime256v1', 'P-256', '1.2.840.10045.3.1.7', 32, p256],
    ['secp384r1', 'P-384', '1.3.132.0.34', 48, p384],
    ['secp521r1', 'P-521', '1.3.132.0.35', 66, p521],
    ['secp256k1', 'secp256k1', '1.3.132.0.10', 32, secp256k1]
] as [string, string, string, number, EcCurve['curve']][]) {
    EC_CURVES[node] = { node, jwk, oid, size, curve };
}
/* Node answers both spellings of a curve: its own SECG name and the JWK name. */
const EC_CURVE_ALIASES: Record<string, string> = {
    'P-256': 'prime256v1',
    'P-384': 'secp384r1',
    'P-521': 'secp521r1'
};

const EC_PUBLIC_KEY_OID = '1.2.840.10045.2.1';

/** The Edwards and Montgomery curves: their OIDs, seed sizes and @noble entry points. */
const EDWARDS: Record<string, {
    kind: KeyKind;
    oid: string;
    jwk: string;
    seed: number;
    size: number;
    getPublicKey: (priv: Uint8Array) => Uint8Array;
    randomPrivateKey: () => Uint8Array;
    sign?: (msg: Uint8Array, priv: Uint8Array) => Uint8Array;
    verify?: (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array) => boolean;
    /** Key agreement: absent on the two signature curves, which have no ECDH. */
    getSharedSecret?: (priv: Uint8Array, pub: Uint8Array) => Uint8Array;
}> = {
    ed25519: { kind: 'ed25519', oid: '1.3.101.112', jwk: 'Ed25519', seed: 32, size: 32, getPublicKey: (p) => nobleEd25519.getPublicKey(p), randomPrivateKey: () => nobleEd25519.utils.randomPrivateKey(), sign: (m, p) => nobleEd25519.sign(m, p), verify: (s, m, p) => nobleEd25519.verify(s, m, p) },
    x25519: { kind: 'x25519', oid: '1.3.101.110', jwk: 'X25519', seed: 32, size: 32, getPublicKey: (p) => nobleX25519.getPublicKey(p), randomPrivateKey: () => nobleX25519.utils.randomPrivateKey(), getSharedSecret: (a, b) => nobleX25519.getSharedSecret(a, b) },
    ed448: { kind: 'ed448', oid: '1.3.101.113', jwk: 'Ed448', seed: 57, size: 57, getPublicKey: (p) => nobleEd448.getPublicKey(p), randomPrivateKey: () => nobleEd448.utils.randomPrivateKey(), sign: (m, p) => nobleEd448.sign(m, p), verify: (s, m, p) => nobleEd448.verify(s, m, p) },
    x448: { kind: 'x448', oid: '1.3.101.111', jwk: 'X448', seed: 56, size: 56, getPublicKey: (p) => nobleX448.getPublicKey(p), randomPrivateKey: () => nobleX448.utils.randomPrivateKey(), getSharedSecret: (a, b) => nobleX448.getSharedSecret(a, b) }
};

interface KeyRecord {
    type: 'public' | 'private';
    kind: KeyKind;
    /** The EC named curve, for the EC kinds only. */
    curve?: EcCurve;
    /** The integers behind an RSA, DSA or DH key. */
    ints?: IntKey;
    publicBytes?: Uint8Array;
    privateBytes?: Uint8Array;
}

const KEY_STORE = new Map<number, KeyRecord>();
let nextKeyId = 1;
/** Keys a process abandoned are dropped rather than kept forever, as ciphers are below. */
const OPEN_KEY_LIMIT = 256;

function keyFail(code: string, message: string, kind: 'Error' | 'RangeError' | 'TypeError' = 'Error'): never {
    const Ctor = kind === 'RangeError' ? RangeError : kind === 'TypeError' ? TypeError : Error;
    throw Object.assign(new Ctor(message), { code, owcErrorClass: kind });
}

/** PBES2 (RFC 8018): the KDF, the PRFs it may name, and the ciphers a PKCS#8 key is sealed with. */
const OID_PBES2 = '1.2.840.113549.1.5.13';
const OID_PBKDF2 = '1.2.840.113549.1.5.12';
const SEAL_PRFS: Record<string, Parameters<typeof pbkdf2>[0]> = {
    '1.2.840.113549.2.7': sha1,
    '1.2.840.113549.2.8': sha224,
    '1.2.840.113549.2.9': sha256,
    '1.2.840.113549.2.10': sha384,
    '1.2.840.113549.2.11': sha512
};
const SEAL_CIPHERS: Record<string, { keyLength: number; cipher: (key: Uint8Array, iv: Uint8Array) => { decrypt: (data: Uint8Array) => Uint8Array } }> = {
    '2.16.840.1.101.3.4.1.2': { keyLength: 16, cipher: (key, iv) => cbc(key, iv, { disablePadding: true }) },
    '2.16.840.1.101.3.4.1.22': { keyLength: 24, cipher: (key, iv) => cbc(key, iv, { disablePadding: true }) },
    '2.16.840.1.101.3.4.1.42': { keyLength: 32, cipher: (key, iv) => cbc(key, iv, { disablePadding: true }) }
};

/**
 * EncryptedPrivateKeyInfo: the PKCS#8 body sealed by PBES2 over PBKDF2, which is what Node writes
 * when a caller hands `privateKeyEncoding` a passphrase. Unsealing it is the only way such a key
 * can be loaded at all.
 */
function decryptPkcs8(bytes: Uint8Array, passphrase: unknown): Uint8Array {
    const secret = typeof passphrase === 'string'
        ? new TextEncoder().encode(passphrase)
        : passphrase instanceof Uint8Array ? passphrase : undefined;
    /* Node asks the caller for a passphrase when the key is sealed, and fails oddly without one. */
    if (secret === undefined) {
        throw keyFail('ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED', 'error:07880109:common libcrypto routines::interrupted or cancelled');
    }
    const root = derRead(bytes);
    const [algorithm, sealed] = root.children;
    if (root.tag !== DER_SEQUENCE || algorithm === undefined || algorithm.tag !== DER_SEQUENCE || sealed === undefined || sealed.tag !== DER_OCTET_STRING) {
        throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid encrypted PKCS#8');
    }
    if (oidOf(algorithm.children[0]) !== OID_PBES2) {
        throw keyFail('ERR_OSSL_UNSUPPORTED', 'error:1E08010C:DECODER routines::unsupported');
    }
    const [kdf, scheme] = algorithm.children[1].children;
    if (kdf === undefined || scheme === undefined) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid PBES2 parameters');
    if (oidOf(kdf.children[0]) !== OID_PBKDF2) {
        throw keyFail('ERR_OSSL_UNSUPPORTED', 'error:1E08010C:DECODER routines::unsupported');
    }
    const kdfParams = kdf.children[1].children;
    const salt = kdfParams[0].content;
    const iterations = Number(bigOf(kdfParams[1].content));
    /* The PRF is optional and defaults to HMAC-SHA1, the way it does in RFC 8018. */
    const prf = kdfParams[2] === undefined ? SEAL_PRFS['1.2.840.113549.2.7'] : SEAL_PRFS[oidOf(kdfParams[2].children[0])];
    if (prf === undefined) throw keyFail('ERR_OSSL_UNSUPPORTED', 'error:1E08010C:DECODER routines::unsupported');
    const seal = SEAL_CIPHERS[oidOf(scheme.children[0])];
    if (seal === undefined) throw keyFail('ERR_OSSL_UNSUPPORTED', 'error:1E08010C:DECODER routines::unsupported');
    const iv = scheme.children[1].content;
    const key = pbkdf2(prf, secret, salt, { c: iterations, dkLen: seal.keyLength });
    /* A wrong passphrase decrypts to bytes that are almost never valid PKCS#7 padding. */
    return unpad(seal.cipher(key, iv).decrypt(sealed.content));
}

/** The export shape a bare PEM asks for by its label, the way Node reads it. */
function pemKindOf(text: string): string {
    const label = /-----BEGIN ([A-Z0-9 ]*)-----/.exec(text);
    if (label === null) return 'pkcs8';
    if (label[1] === 'EC PRIVATE KEY') return 'sec1';
    if (label[1] === 'PUBLIC KEY') return 'spki';
    return 'pkcs8';
}

function keyFor(id: unknown, op: string): KeyRecord {
    const key = KEY_STORE.get(Number(id));
    if (key === undefined) keyFail('ERR_CRYPTO_INVALID_STATE', `Invalid state for operation ${op}`);
    return key as KeyRecord;
}

function storeKey(record: KeyRecord): number {
    if (KEY_STORE.size >= OPEN_KEY_LIMIT) {
        const oldest = KEY_STORE.keys().next().value;
        if (oldest !== undefined) KEY_STORE.delete(oldest);
    }
    const id = nextKeyId++;
    KEY_STORE.set(id, record);
    return id;
}

function randomOf(count: number): Uint8Array {
    const out = new Uint8Array(count);
    globalThis.crypto.getRandomValues(out);
    return out;
}

/** An EC private scalar padded to the curve's field size, the shape both DER and JWK want. */
function paddedScalar(bytes: Uint8Array, size: number): Uint8Array {
    const out = new Uint8Array(size);
    out.set(bytes.subarray(0, Math.min(bytes.length, size)), size - Math.min(bytes.length, size));
    return out;
}

/** SubjectPublicKeyInfo, the encoding behind a public key's `spki` export. */
function encodeSpki(key: KeyRecord): Uint8Array {
    const ints = intAlgorithmDer(key);
    if (ints !== undefined) {
        /* RSA wraps a PKCS#1 RSAPublicKey; DSA and DH carry their public value as one INTEGER. */
        const body = key.kind === 'rsa' || key.kind === 'rsa-pss'
            ? rsaPublicDer(key.ints as IntKey)
            : derIntegerBig((key.ints as IntKey).y as bigint);
        return derSequence([ints, derBitString(body)]);
    }
    const [algorithm, bits] = key.kind === 'ec'
        ? [derSequence([derOid(EC_PUBLIC_KEY_OID), derOid((key.curve as EcCurve).oid)]), (key.publicBytes as Uint8Array)]
        : [derSequence([derOid(EDWARDS[key.kind].oid)]), (key.publicBytes as Uint8Array)];
    return derSequence([algorithm, derBitString(bits)]);
}

/** OneAsymmetricKey (PKCS#8), the default behind a private key's export. */
function encodePkcs8(key: KeyRecord): Uint8Array {
    const ints = intAlgorithmDer(key);
    if (ints !== undefined) {
        /* RSA wraps a PKCS#1 RSAPrivateKey; DSA and DH carry x alone, since the domain is above. */
        const body = key.kind === 'rsa' || key.kind === 'rsa-pss'
            ? rsaPrivateDer(key.ints as IntKey)
            : derIntegerBig((key.ints as IntKey).x as bigint);
        return derSequence([derIntegerFrom(0), ints, derOctetString(body)]);
    }
    const algorithm = key.kind === 'ec'
        ? derSequence([derOid(EC_PUBLIC_KEY_OID), derOid((key.curve as EcCurve).oid)])
        : derSequence([derOid(EDWARDS[key.kind].oid)]);
    return derSequence([
        derIntegerFrom(0),
        algorithm,
        /* Inside PKCS#8 the curve is named by the algorithm identifier, so RFC 5915 says the
           parameters field is left out; Node's encoder leaves it out too. */
        derOctetString(key.kind === 'ec' ? encodeEcPrivateKey(key, false) : derOctetString(key.privateBytes as Uint8Array))
    ]);
}

/** RFC 5915 ECPrivateKey: version, the padded scalar, the curve OID and the public point. */
function encodeEcPrivateKey(key: KeyRecord, withParameters: boolean): Uint8Array {
    const curve = key.curve as EcCurve;
    const parts = [
        derIntegerFrom(1),
        derOctetString(paddedScalar(key.privateBytes as Uint8Array, curve.size))
    ];
    /* A `sec1` export stands alone, so it carries the curve with it, as Node's does. */
    if (withParameters) parts.push(derContext(0, derOid(curve.oid)));
    parts.push(derContext(1, derBitString(key.publicBytes as Uint8Array)));
    return derSequence(parts);
}

function exportJwk(key: KeyRecord): Record<string, unknown> {
    if (key.kind === 'rsa' || key.kind === 'rsa-pss') {
        const ints = key.ints as IntKey;
        /* Node writes RSA as kty, n, e and then the private parts, and a caller that stringifies
           the export sees that order, so the keys are written in it here. */
        const jwk: Record<string, unknown> = {
            kty: 'RSA',
            n: base64url(bytesOf(ints.n as bigint, modulusSize(ints.n as bigint))),
            e: base64url(minimalBytesOf(ints.e as bigint))
        };
        if (key.type === 'private') {
            const size = modulusSize(ints.n as bigint);
            jwk.d = base64url(bytesOf(ints.d as bigint, size));
            jwk.p = base64url(bytesOf(ints.p as bigint, Math.ceil(size / 2)));
            jwk.q = base64url(bytesOf(ints.q as bigint, Math.ceil(size / 2)));
            jwk.dp = base64url(bytesOf(ints.dp as bigint, Math.ceil(size / 2)));
            jwk.dq = base64url(bytesOf(ints.dq as bigint, Math.ceil(size / 2)));
            jwk.qi = base64url(bytesOf(ints.qi as bigint, Math.ceil(size / 2)));
        }
        return jwk;
    }
    /* DSA and DH have no JWK form at all: Node answers ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE. */
    if (key.kind === 'dsa' || key.kind === 'dh') {
        throw keyFail('ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE', 'Unsupported JWK Key Type.');
    }
    if (key.kind === 'ec') {
        const curve = key.curve as EcCurve;
        const point = key.publicBytes as Uint8Array;
        /* Node emits EC as kty, x, y, crv, d -- and OKP as crv, d, x, kty -- and a caller that
           JSON.stringify's the export sees that order, so the keys are written in it here. */
        const jwk: Record<string, unknown> = {
            kty: 'EC',
            x: base64url(point.subarray(1, 1 + curve.size)),
            y: base64url(point.subarray(1 + curve.size, 1 + 2 * curve.size)),
            crv: curve.jwk
        };
        if (key.type === 'private') jwk.d = base64url(paddedScalar(key.privateBytes as Uint8Array, curve.size));
        return jwk;
    }
    const spec = EDWARDS[key.kind];
    const jwk: Record<string, unknown> = { crv: spec.jwk };
    if (key.type === 'private') jwk.d = base64url(key.privateBytes as Uint8Array);
    jwk.x = base64url(key.publicBytes as Uint8Array);
    jwk.kty = 'OKP';
    return jwk;
}

/** The curve a generateKeyPair or an EC key import names, in Node's own spelling. */
function curveFor(name: unknown): EcCurve {
    const asked = String(name ?? '').toLowerCase();
    const node = EC_CURVE_ALIASES[String(name ?? '')] ?? asked;
    const curve = EC_CURVES[node];
    if (curve === undefined) throw keyFail('ERR_CRYPTO_INVALID_CURVE', 'Invalid EC curve name');
    return curve;
}

/* ---------------------------------------------------------------------------------------------
 * RSA, DSA and DH: the integer kinds. Generating one needs a search for large random primes, and
 * the search is reachable here -- a Miller-Rabin round is one BigInt modular exponentiation, and
 * sieving an arithmetic progression against the small primes leaves about one candidate in twenty
 * to test, which is the difference between a 1024-bit search taking seconds and one taking
 * minutes. The encodings are PKCS#1 inside SPKI and PKCS#8 for RSA, FIPS 186-4 domain parameters
 * for DSA and PKCS#3 for DH.
 * ------------------------------------------------------------------------------------------ */

const OID_RSA = '1.2.840.113549.1.1.1';
const OID_RSA_PSS = '1.2.840.113549.1.1.10';
const OID_DSA = '1.2.840.10040.4.1';
const OID_DH = '1.2.840.113549.1.3.1';

/** The OID each of the integer kinds writes into its algorithm identifier. */
const INT_KIND_OIDS: Record<string, string> = {
    rsa: OID_RSA,
    'rsa-pss': OID_RSA_PSS,
    dsa: OID_DSA,
    dh: OID_DH
};

/**
 * The integers behind an RSA, DSA or DH key, in the spelling PKCS#1, FIPS 186-4 and PKCS#3 give
 * them. The three kinds share the letters -- RSA's primes are p and q and so are DSA's modulus
 * and subprime -- but no key carries both readings, so one bag of names serves all of them.
 */
interface IntKey {
    /** RSA: the modulus, the public exponent and its inverse. */
    n?: bigint; e?: bigint; d?: bigint;
    /** RSA: prime1 and prime2, and the three CRT parts that speed a private-key operation up. */
    p?: bigint; q?: bigint; dp?: bigint; dq?: bigint; qi?: bigint;
    /** DSA and DH: the generator, and the public and private halves of the key. */
    g?: bigint; y?: bigint; x?: bigint;
}

/** The canonical name of a digest, so an RSA signature can write its OID into a DigestInfo. */
function digestNameFor(name: unknown): string {
    const key = String(name ?? '').toLowerCase();
    return DIGEST_ALIASES[key] ?? key;
}

/** INTEGER from a non-negative BigInt: minimal big-endian, with a 0x00 ahead of a set top bit. */
function derIntegerBig(value: bigint): Uint8Array {
    let width = 1;
    while ((value >> BigInt(width * 8)) > 0n) width++;
    const body = bytesOf(value, width);
    return der(DER_INTEGER, body[0] > 0x7f ? concatBytes(new Uint8Array([0]), body) : body);
}

/** A DER INTEGER as a BigInt. Every integer these structures carry is non-negative. */
const intOf = (node: DerNode): bigint => bigOf(node.content);

/** The byte width of an RSA modulus: the size of its signatures, its ciphertexts and its parts. */
const modulusSize = (n: bigint): number => Math.ceil(n.toString(2).length / 8);

function gcd(a: bigint, b: bigint): bigint {
    while (b !== 0n) {
        const rest = a % b;
        a = b;
        b = rest;
    }
    return a < 0n ? -a : a;
}

/** The inverse of `a` modulo `m`, from the extended Euclidean algorithm. */
function modInverse(a: bigint, m: bigint): bigint {
    let [wasValue, nowValue] = [((a % m) + m) % m, m];
    let [wasScale, nowScale] = [1n, 0n];
    while (nowValue !== 0n) {
        const times = wasValue / nowValue;
        [wasValue, nowValue] = [nowValue, wasValue - times * nowValue];
        [wasScale, nowScale] = [nowScale, wasScale - times * nowScale];
    }
    if (wasValue !== 1n) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Not invertible');
    return ((wasScale % m) + m) % m;
}

/** The odd primes below 2^16: enough to strike nineteen in twenty candidates out of a window. */
const SIEVE_PRIMES: number[] = (() => {
    const limit = 65536;
    const composite = new Uint8Array(limit);
    const primes: number[] = [];
    for (let at = 3; at < limit; at += 2) {
        if (composite[at] !== 0) continue;
        primes.push(at);
        for (let mark = at * at; mark < limit; mark += 2 * at) composite[mark] = 1;
    }
    return primes;
})();

/**
 * One window of `count` candidates `a + b*i`, with every candidate a small prime divides struck
 * out, and Miller-Rabin on what survives. `safe` also strikes a candidate whose partner `2v + 1`
 * a small prime divides, which is what finds a safe prime: the sieve leaves about one candidate
 * in twenty to exponentiate, and that is the whole of what makes a 1024-bit search affordable.
 */
function searchProgression(a: bigint, b: bigint, count: number, safe: boolean, rounds: number, accept: (value: bigint) => boolean): bigint | undefined {
    const struck = new Uint8Array(count);
    for (const prime of SIEVE_PRIMES) {
        const r = BigInt(prime);
        const step = b % r;
        if (step !== 0n) {
            let at = Number((((r - (a % r)) % r) * modInverse(step, r)) % r);
            /* A narrow window can hold the small prime itself, and that one is prime: skip it. */
            if (a + b * BigInt(at) === r) at += prime;
            for (let i = at; i < count; i += prime) struck[i] = 1;
        }
        if (!safe) continue;
        /* The partner is 2(a + b*i) + 1, so it walks the same window at twice the step. */
        const twin = (2n * b) % r;
        if (twin === 0n) continue;
        let mate = Number((((r - ((2n * a + 1n) % r)) % r) * modInverse(twin, r)) % r);
        if (2n * (a + b * BigInt(mate)) + 1n === r) mate += prime;
        for (let i = mate; i < count; i += prime) struck[i] = 1;
    }
    for (let i = 0; i < count; i++) {
        if (struck[i] !== 0) continue;
        const value = a + b * BigInt(i);
        if (!isProbablePrime(value, rounds)) continue;
        if (safe && !isProbablePrime(2n * value + 1n, rounds)) continue;
        if (!accept(value)) continue;
        return value;
    }
    return undefined;
}

/** A random odd `bits`-bit starting point with its top `topBits` bits set. */
function primeStart(bits: number, topBits: number): bigint {
    const free = BigInt(bits - topBits);
    const top = ((1n << BigInt(topBits)) - 1n) << free;
    return top | (bigOf(randomOf(Math.ceil(bits / 8))) % (1n << free)) | 1n;
}

/**
 * A probable prime of `bits` bits. `safe` asks for a Sophie Germain prime, whose partner `2p + 1`
 * is prime too and which is what a Diffie-Hellman group is generated from; `coprimeTo` refuses a
 * prime whose predecessor shares a factor with an RSA exponent, since such an exponent inverts.
 */
function searchPrime(bits: number, options: { topBits?: number; safe?: boolean; coprimeTo?: bigint } = {}): bigint {
    const rounds = bits >= 1024 ? 4 : 8;
    const coprimeTo = options.coprimeTo;
    const accept = (value: bigint): boolean => coprimeTo === undefined || gcd(coprimeTo, value - 1n) === 1n;
    for (let window = 0; window < 4096; window++) {
        const start = primeStart(bits, options.topBits ?? 1);
        /* The window stops at 2^bits, so a narrow width never walks into the one above it. */
        const span = ((1n << BigInt(bits)) + 1n - start) / 2n;
        const count = span > 262144n ? 262144 : Number(span < 1n ? 1n : span);
        const found = searchProgression(start, 2n, count, options.safe === true, rounds, accept);
        if (found !== undefined) return found;
    }
    throw dhFail('ERR_CRYPTO_INVALID_STATE', 'Could not find a prime of ' + bits + ' bits');
}

/**
 * FIPS 186-4 A.1: a DSA domain. The subprime q is a fresh prime of `divisorBits` bits, and the
 * modulus p is then q*x + 1 for an even x -- which is another arithmetic progression, so the same
 * sieve serves it -- until that is prime at the width asked for.
 */
function searchDsaDomain(bits: number, divisorBits: number): { p: bigint; q: bigint; g: bigint } {
    const q = searchPrime(divisorBits);
    const rounds = bits >= 1024 ? 4 : 8;
    const step = 2n * q;
    /* p = q*x + 1 has to land in [2^(bits-1), 2^bits), which bounds x on both sides. */
    const lowest = (((1n << BigInt(bits - 1)) + q - 2n) / q) & ~1n;
    const highest = (((1n << BigInt(bits)) - 2n) / q) & ~1n;
    const room = (highest - lowest) / 2n;
    if (room < 1n) throw dhFail('ERR_CRYPTO_INVALID_DH_PARAMETERS', 'Invalid DSA parameter sizes');
    const take = room > 8192n ? 8192n : room;
    for (let window = 0; window < 4096; window++) {
        const offset = room > take ? bigOf(randomOf(Math.ceil(room.toString(2).length / 8))) % (room - take) : 0n;
        const p = searchProgression(q * (lowest + 2n * offset) + 1n, step, Number(take), false, rounds, () => true);
        if (p === undefined) continue;
        /* g = h^((p-1)/q) mod p has order q, and lands on 1 for only one h in q. */
        for (let attempt = 0; attempt < 1000; attempt++) {
            const g = modPow(2n + (bigOf(randomOf(Math.ceil(bits / 8))) % (p - 3n)), (p - 1n) / q, p);
            if (g >= 2n) return { p, q, g };
        }
    }
    throw dhFail('ERR_CRYPTO_INVALID_STATE', 'Could not find DSA parameters of ' + bits + ' bits');
}

/** A fresh RSA key: two primes of half the modulus width, and the exponent pair for them. */
function generateRsa(bits: number, exponent: bigint): IntKey {
    /*
     * Both primes carry their top two bits so their product fills the modulus: two numbers above
     * 2^(h-1) can multiply to less than 2^(2h-1) and lose a bit, but two above 2^(h-0.5) never do.
     */
    const half = bits >> 1;
    const p = searchPrime(half, { topBits: 2, coprimeTo: exponent });
    let q = searchPrime(half, { topBits: 2, coprimeTo: exponent });
    while (q === p) q = searchPrime(half, { topBits: 2, coprimeTo: exponent });
    const n = p * q;
    /* PKCS#1 asks for d = e^-1 mod lambda(n), lambda being the lcm of p-1 and q-1. */
    const lambda = ((p - 1n) * (q - 1n)) / gcd(p - 1n, q - 1n);
    const d = modInverse(exponent, lambda);
    return {
        n,
        e: exponent,
        d,
        p,
        q,
        dp: ((d % (p - 1n)) + (p - 1n)) % (p - 1n),
        dq: ((d % (q - 1n)) + (q - 1n)) % (q - 1n),
        qi: modInverse(q, p)
    };
}

/** A fresh DSA key: the domain, a private exponent below the subprime, and the public g^x mod p. */
function generateDsa(bits: number, divisorBits: number): IntKey {
    const { p, q, g } = searchDsaDomain(bits, divisorBits);
    const x = 1n + (bigOf(randomOf(Math.ceil(divisorBits / 8))) % (q - 1n));
    return { p, q, g, x, y: modPow(g, x, p) };
}

/** A fresh DH key: a safe prime of `bits` bits, the generator, and one exponent in that group. */
function generateDh(bits: number, generator: bigint): IntKey {
    /* OpenSSL generates a safe prime by default, so the subgroup a caller exchanges in is large. */
    const p = 2n * searchPrime(bits - 1, { safe: true }) + 1n;
    const x = 2n + (bigOf(randomOf(Math.ceil(bits / 8))) % (p - 3n));
    return { p, g: generator, x, y: modPow(generator, x, p) };
}

/** PKCS#1 RSAPublicKey: SEQUENCE { modulus, publicExponent }, the body an SPKI wraps. */
const rsaPublicDer = (ints: IntKey): Uint8Array =>
    derSequence([derIntegerBig(ints.n as bigint), derIntegerBig(ints.e as bigint)]);

/** PKCS#1 RSAPrivateKey: version, the modulus, both exponents, both primes and the CRT parts. */
const rsaPrivateDer = (ints: IntKey): Uint8Array => derSequence([
    derIntegerFrom(0),
    derIntegerBig(ints.n as bigint),
    derIntegerBig(ints.e as bigint),
    derIntegerBig(ints.d as bigint),
    derIntegerBig(ints.p as bigint),
    derIntegerBig(ints.q as bigint),
    derIntegerBig(ints.dp as bigint),
    derIntegerBig(ints.dq as bigint),
    derIntegerBig(ints.qi as bigint)
]);

/** The domain parameters an algorithm identifier carries: DSA's p, q and g, or DH's p and g. */
function domainDer(key: KeyRecord): Uint8Array | undefined {
    const ints = key.ints;
    if (ints === undefined) return undefined;
    if (key.kind === 'dsa') return derSequence([derIntegerBig(ints.p as bigint), derIntegerBig(ints.q as bigint), derIntegerBig(ints.g as bigint)]);
    if (key.kind === 'dh') return derSequence([derIntegerBig(ints.p as bigint), derIntegerBig(ints.g as bigint)]);
    return undefined;
}

/** The algorithm identifier an RSA, DSA or DH key writes: the OID, then NULL or the domain. */
function intAlgorithmOid(key: KeyRecord): string | undefined {
    if (key.kind === 'rsa') return OID_RSA;
    if (key.kind === 'rsa-pss') return OID_RSA_PSS;
    if (key.kind === 'dsa') return OID_DSA;
    if (key.kind === 'dh') return OID_DH;
    return undefined;
}

function intAlgorithmDer(key: KeyRecord): Uint8Array | undefined {
    const oid = intAlgorithmOid(key);
    if (oid === undefined) return undefined;
    const domain = domainDer(key);
    /* RSA names no parameters, so it writes NULL the way OpenSSL writes it. */
    return derSequence([derOid(oid), domain === undefined ? der(DER_NULL, new Uint8Array(0)) : domain]);
}

/** The DigestInfo an RSA signature really signs: SEQUENCE { AlgorithmIdentifier, OCTET STRING }. */
const DIGEST_OIDS: Record<string, string> = {
    md5: '1.2.840.113549.2.5',
    sha1: '1.3.14.3.2.26',
    sha224: '2.16.840.1.101.3.4.2.4',
    sha256: '2.16.840.1.101.3.4.2.1',
    sha384: '2.16.840.1.101.3.4.2.2',
    sha512: '2.16.840.1.101.3.4.2.3',
    'sha512-224': '2.16.840.1.101.3.4.2.5',
    'sha512-256': '2.16.840.1.101.3.4.2.6',
    'sha3-224': '2.16.840.1.101.3.4.2.7',
    'sha3-256': '2.16.840.1.101.3.4.2.8',
    'sha3-384': '2.16.840.1.101.3.4.2.9',
    'sha3-512': '2.16.840.1.101.3.4.2.10',
    ripemd160: '1.3.36.3.2.1',
    sm3: '1.2.156.10197.1.401',
    blake2b512: '1.3.6.1.4.1.1722.12.2.1.16',
    blake2s256: '1.3.6.1.4.1.1722.12.2.2.8'
};

function digestInfoDer(name: string, digest: Uint8Array): Uint8Array {
    const oid = DIGEST_OIDS[name];
    if (oid === undefined) throw keyFail('ERR_OSSL_INVALID_DIGEST', 'error:1C80007A:Provider routines::invalid digest');
    return derSequence([derSequence([derOid(oid), der(DER_NULL, new Uint8Array(0))]), derOctetString(digest)]);
}

const xorBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
    return out;
};

/** MGF1 (RFC 8017 B.2): the mask is the hash of the seed with a 32-bit counter appended. */
function mgf1(seed: Uint8Array, length: number, hash: (message: Uint8Array) => Uint8Array): Uint8Array {
    const out = new Uint8Array(length);
    let at = 0;
    for (let counter = 0; at < length; counter++) {
        const block = hash(concatBytes(seed, new Uint8Array([(counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff])));
        for (const byte of block) {
            if (at >= length) break;
            out[at++] = byte;
        }
    }
    return out;
}

/** RSA_PKCS1_PADDING is 1 and RSA_PKCS1_PSS_PADDING is 6, as crypto.constants names them. */
const RSA_PKCS1_PADDING = 1;
const RSA_PKCS1_PSS_PADDING = 6;

/** EMSA-PKCS1-v1_5 (RFC 8017 9.2): 0x00 0x01, then 0xff up to the DigestInfo, then 0x00. */
function emsaPkcs1(t: Uint8Array, size: number): Uint8Array {
    if (t.length + 11 > size) {
        throw keyFail('ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_MODULUS', 'error:0409D06A:rsa routines::data too large for modulus');
    }
    const out = new Uint8Array(size);
    out[0] = 0x00;
    out[1] = 0x01;
    out.fill(0xff, 2, size - t.length - 1);
    out[size - t.length - 1] = 0x00;
    out.set(t, size - t.length);
    return out;
}

/** EMSA-PSS (RFC 8017 9.1): a salted hash, a masked block and a 0xbc trailer. */
function emsaPssEncode(digest: Uint8Array, emBits: number, saltLength: number, hash: (message: Uint8Array) => Uint8Array, hLen: number): Uint8Array {
    const emLen = Math.ceil(emBits / 8);
    if (emLen < hLen + saltLength + 2) {
        throw keyFail('ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_MODULUS', 'error:0409D06A:rsa routines::data too large for modulus');
    }
    const salt = randomOf(saltLength);
    const h = hash(concatBytes(concatBytes(new Uint8Array(8), digest), salt));
    const block = new Uint8Array(emLen - hLen - 1);
    block[block.length - saltLength - 1] = 0x01;
    block.set(salt, block.length - saltLength);
    const masked = xorBytes(block, mgf1(h, block.length, hash));
    /* The 8*emLen - emBits bits above the modulus width are cleared before the block is signed. */
    const spare = 8 * emLen - emBits;
    if (spare > 0) masked[0] &= 0xff >>> spare;
    return concatBytes(concatBytes(masked, h), new Uint8Array([0xbc]));
}

/** EMSA-PSS verification: a negative salt length is AUTO, so the separator is searched for. */
function emsaPssVerify(digest: Uint8Array, em: Uint8Array, emBits: number, saltLength: number, hash: (message: Uint8Array) => Uint8Array, hLen: number): boolean {
    const emLen = Math.ceil(emBits / 8);
    const spare = 8 * emLen - emBits;
    if (em.length < emLen || em[em.length - 1] !== 0xbc) return false;
    if (spare > 0 && (em[0] & ((0xff << (8 - spare)) & 0xff)) !== 0) return false;
    const masked = em.subarray(0, emLen - hLen - 1);
    const h = em.subarray(emLen - hLen - 1, emLen - 1);
    if (masked.length < 1) return false;
    const block = xorBytes(masked, mgf1(h, masked.length, hash));
    if (spare > 0) block[0] &= 0xff >>> spare;
    let at = 0;
    /* AUTO reads the salt length off the block: the 0x01 is the first non-zero from the left. */
    while (at < block.length - 1 && block[at] === 0x00) at++;
    if (block[at] !== 0x01) return false;
    const salt = block.subarray(at + 1);
    if (saltLength >= 0 && salt.length !== saltLength) return false;
    const again = hash(concatBytes(concatBytes(new Uint8Array(8), digest), salt));
    if (again.length !== h.length) return false;
    for (let i = 0; i < again.length; i++) if (again[i] !== h[i]) return false;
    return true;
}

/** The salt length of a PSS signature: the digest width, unless the caller names one. */
function pssSaltLength(saltLength: unknown, hLen: number): number {
    const asked = Number(saltLength);
    if (saltLength === undefined || saltLength === null || !Number.isFinite(asked)) return hLen;
    if (asked === -1) return hLen;
    if (asked === -2) return -2;
    return Math.trunc(asked);
}

/** Signs or verifies with an RSA key: the exponentiation is one BigInt modPow either way. */
function rsaSignWith(ints: IntKey, digest: Uint8Array, name: string, padding: number, saltLength: number): Uint8Array {
    const n = ints.n as bigint;
    const size = modulusSize(n);
    const spec = DIGEST_SPECS[name];
    const hash = (message: Uint8Array): Uint8Array => spec.fn(message, 0);
    const emBits = n.toString(2).length - 1;
    const em = padding === RSA_PKCS1_PSS_PADDING
        ? emsaPssEncode(digest, emBits, saltLength < 0 ? spec.out : saltLength, hash, spec.out)
        : emsaPkcs1(digestInfoDer(name, digest), size);
    const m = bigOf(em);
    if (m >= n) throw keyFail('ERR_OSSL_RSA_DATA_TOO_LARGE', 'error:0409D06A:rsa routines::data too large for modulus');
    return bytesOf(modPow(m, ints.d as bigint, n), size);
}

function rsaVerifyWith(ints: IntKey, digest: Uint8Array, name: string, signature: Uint8Array, padding: number, saltLength: number): boolean {
    const n = ints.n as bigint;
    const size = modulusSize(n);
    /* A signature is exactly as wide as the modulus, and its value is below it. */
    if (signature.length !== size) return false;
    const s = bigOf(signature);
    if (s >= n) return false;
    const em = bytesOf(modPow(s, ints.e as bigint, n), size);
    if (padding === RSA_PKCS1_PSS_PADDING) {
        const spec = DIGEST_SPECS[name];
        if (spec === undefined) return false;
        return emsaPssVerify(digest, em, n.toString(2).length - 1, saltLength, (message) => spec.fn(message, 0), spec.out);
    }
    let t: Uint8Array;
    try {
        t = digestInfoDer(name, digest);
    } catch {
        return false;
    }
    if (em[0] !== 0x00 || em[1] !== 0x01) return false;
    let at = 2;
    while (at < size && em[at] === 0xff) at++;
    if (at !== size - t.length - 1 || em[at] !== 0x00) return false;
    for (let i = 0; i < t.length; i++) if (em[size - t.length + i] !== t[i]) return false;
    return true;
}

/** FIPS 186-4 4.6: the leftmost `bits` of a digest, as an integer, so a short q still signs. */
const bits2int = (digest: Uint8Array, bits: number): bigint => {
    const excess = digest.length * 8 - bits;
    const value = bigOf(digest);
    return excess > 0 ? value >> BigInt(excess) : value;
};

/** DSA: r = (g^k mod p) mod q and s = k^-1 (z + x*r) mod q, written as a DER pair. */
function dsaSignWith(ints: IntKey, digest: Uint8Array): Uint8Array {
    const p = ints.p as bigint;
    const q = ints.q as bigint;
    const g = ints.g as bigint;
    const x = ints.x as bigint;
    const z = bits2int(digest, q.toString(2).length);
    for (let attempt = 0; attempt < 100; attempt++) {
        const k = 1n + (bigOf(randomOf(Math.ceil(q.toString(2).length / 8))) % (q - 1n));
        const r = modPow(g, k, p) % q;
        if (r === 0n) continue;
        const s = (modInverse(k, q) * (z + x * r)) % q;
        if (s === 0n) continue;
        return derSequence([derIntegerBig(r), derIntegerBig(s)]);
    }
    throw keyFail('ERR_CRYPTO_INVALID_STATE', 'DSA signing failed');
}

function dsaVerifyWith(ints: IntKey, digest: Uint8Array, signature: Uint8Array): boolean {
    try {
        const root = derRead(signature);
        if (root.tag !== DER_SEQUENCE || root.children.length !== 2) return false;
        const r = intOf(root.children[0]);
        const s = intOf(root.children[1]);
        const p = ints.p as bigint;
        const q = ints.q as bigint;
        const y = ints.y as bigint;
        if (r <= 0n || r >= q || s <= 0n || s >= q) return false;
        const w = modInverse(s, q);
        const z = bits2int(digest, q.toString(2).length);
        const v = (modPow(ints.g as bigint, (z * w) % q, p) * modPow(y, (r * w) % q, p)) % p % q;
        return v === r;
    } catch {
        return false;
    }
}

function generatePair(type: unknown, options: any): { public: number; private: number } {
    const kind = String(type ?? '').toLowerCase();
    /*
     * Node insists on an options object for the three kinds that take a size -- an RSA modulus, a
     * DSA modulus and a DH prime all need a width, and there is no default to fall back on -- so
     * a call with none is an argument error here too, the way it is on the host.
     */
    if (kind === 'rsa' || kind === 'rsa-pss' || kind === 'dsa' || kind === 'dh') {
        if (options === undefined || options === null || typeof options !== 'object') {
            throw keyFail('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object. Received ' + String(options), 'TypeError');
        }
    }
    if (kind === 'rsa' || kind === 'rsa-pss') {
        if (typeof options?.modulusLength !== 'number') {
            throw keyFail('ERR_INVALID_ARG_TYPE', 'The "options.modulusLength" property must be of type number. Received ' + String(options?.modulusLength), 'TypeError');
        }
        const modulusLength = options.modulusLength;
        if (!Number.isInteger(modulusLength) || modulusLength < 16) {
            throw keyFail('ERR_OUT_OF_RANGE', 'The value of "options.modulusLength" is out of range. It must be >= 16. Received ' + String(options?.modulusLength), 'RangeError');
        }
        const exponent = options?.publicExponent === undefined || options?.publicExponent === null ? 65537n : BigInt(String(options?.publicExponent));
        if (exponent < 3n || (exponent & 1n) === 0n) {
            throw keyFail('ERR_OUT_OF_RANGE', 'The value of "options.publicExponent" is out of range. It must be an odd integer >= 3. Received ' + exponent.toString(), 'RangeError');
        }
        const ints = generateRsa(modulusLength, exponent);
        const size = modulusSize(ints.n as bigint);
        return {
            public: storeKey({ type: 'public', kind, ints, publicBytes: bytesOf(ints.n as bigint, size) }),
            private: storeKey({ type: 'private', kind, ints, publicBytes: bytesOf(ints.n as bigint, size), privateBytes: bytesOf(ints.d as bigint, size) })
        };
    }
    if (kind === 'dsa') {
        if (typeof options?.modulusLength !== 'number') {
            throw keyFail('ERR_INVALID_ARG_TYPE', 'The "options.modulusLength" property must be of type number. Received ' + String(options?.modulusLength), 'TypeError');
        }
        const modulusLength = options.modulusLength;
        const divisorLength = options?.divisorLength === undefined || options?.divisorLength === null ? 224 : Number(options?.divisorLength);
        if (!Number.isInteger(modulusLength) || modulusLength < 32) {
            throw keyFail('ERR_OUT_OF_RANGE', 'The value of "options.modulusLength" is out of range. It must be >= 32. Received ' + String(options?.modulusLength), 'RangeError');
        }
        const ints = generateDsa(modulusLength, divisorLength);
        const size = modulusSize(ints.p as bigint);
        return {
            public: storeKey({ type: 'public', kind, ints, publicBytes: bytesOf(ints.y as bigint, size) }),
            private: storeKey({ type: 'private', kind, ints, publicBytes: bytesOf(ints.y as bigint, size), privateBytes: bytesOf(ints.x as bigint, Math.ceil(divisorLength / 8)) })
        };
    }
    if (kind === 'dh') {
        /* A group, a prime or a prime length: Node asks for one of the three before it generates. */
        if (options?.primeLength === undefined || options?.primeLength === null) {
            throw Object.assign(new Error('At least one of the group, prime, or primeLength options is required'), { code: 'ERR_MISSING_OPTION' });
        }
        const primeLength = Number(options.primeLength);
        if (!Number.isInteger(primeLength) || primeLength < 16) {
            throw keyFail('ERR_OUT_OF_RANGE', 'The value of "options.primeLength" is out of range. It must be >= 16. Received ' + String(options?.primeLength), 'RangeError');
        }
        const ints = generateDh(primeLength, options?.generator === undefined || options?.generator === null ? 2n : BigInt(String(options?.generator)));
        const size = modulusSize(ints.p as bigint);
        return {
            public: storeKey({ type: 'public', kind, ints, publicBytes: bytesOf(ints.y as bigint, size) }),
            private: storeKey({ type: 'private', kind, ints, publicBytes: bytesOf(ints.y as bigint, size), privateBytes: minimalBytesOf(ints.x as bigint) })
        };
    }
    if (Object.prototype.hasOwnProperty.call(EDWARDS, kind)) {
        const spec = EDWARDS[kind];
        const priv = spec.randomPrivateKey();
        const pub = spec.getPublicKey(priv);
        return {
            public: storeKey({ type: 'public', kind: spec.kind, publicBytes: pub }),
            private: storeKey({ type: 'private', kind: spec.kind, publicBytes: pub, privateBytes: priv })
        };
    }
    if (kind === 'ec') {
        const curve = curveFor(options?.namedCurve ?? options?.curve ?? 'prime256v1');
        const priv = curve.curve.utils.randomPrivateKey();
        const pub = curve.curve.getPublicKey(priv, false);
        return {
            public: storeKey({ type: 'public', kind: 'ec', curve, publicBytes: pub }),
            private: storeKey({ type: 'private', kind: 'ec', curve, publicBytes: pub, privateBytes: priv })
        };
    }
    throw keyFail('ERR_INVALID_ARG_VALUE', "The argument 'type' must be a supported key type. Received '" + String(type) + "'");
}

/** The kind of a key from the algorithm OID in its SPKI or PKCS#8 header. */
function kindFromOid(oid: string): { kind: KeyKind; curve?: EcCurve } {
    for (const name of Object.keys(EDWARDS)) {
        if (EDWARDS[name].oid === oid) return { kind: EDWARDS[name].kind };
    }
    for (const name of Object.keys(EC_CURVES)) {
        if (EC_CURVES[name].oid === oid) return { kind: 'ec', curve: EC_CURVES[name] };
    }
    /* The four OIDs with no curve behind them: RSA, RSA-PSS, DSA and DH. */
    for (const name of Object.keys(INT_KIND_OIDS)) {
        if (INT_KIND_OIDS[name] === oid) return { kind: name as KeyKind };
    }
    throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Unsupported key algorithm');
}

function oidOf(node: DerNode): string {
    const content = node.content;
    const parts: number[] = [];
    let value = 0;
    let first = true;
    for (const byte of content) {
        value = (value << 7) | (byte & 0x7f);
        if ((byte & 0x80) === 0) {
            if (first) {
                parts.push(Math.floor(value / 40), value % 40);
                first = false;
            } else parts.push(value);
            value = 0;
        }
    }
    return parts.join('.');
}

/** Pulls an AlgorithmIdentifier apart into the algorithm OID, the EC curve and the DSA/DH domain. */
function algorithmOf(node: DerNode): { kind: KeyKind; curve?: EcCurve; domain?: DerNode } {
    const [oidNode, params] = node.children;
    if (oidNode === undefined || oidNode.tag !== DER_OID) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid key: no algorithm identifier');
    const algorithm = oidOf(oidNode);
    if (algorithm === EC_PUBLIC_KEY_OID) {
        if (params === undefined || params.tag !== DER_OID) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid EC key: no curve');
        return { kind: 'ec', curve: curveForOid(oidOf(params)) };
    }
    /* DSA carries p, q and g and DH carries p and g, and both halves of a key need them. */
    if (algorithm === OID_DSA || algorithm === OID_DH) {
        if (params === undefined || params.tag !== DER_SEQUENCE) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid key: no domain parameters');
        return { kind: algorithm === OID_DSA ? 'dsa' : 'dh', domain: params };
    }
    return kindFromOid(algorithm);
}

/** The p, q and g of a DSA domain or the p and g of a DH one, as integers. */
function domainOf(node: DerNode): { p: bigint; q?: bigint; g: bigint } {
    const parts = node.children;
    if (parts.length < 2 || parts.some((part) => part.tag !== DER_INTEGER)) {
        throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid key: bad domain parameters');
    }
    return { p: intOf(parts[0]), q: parts.length > 2 ? intOf(parts[1]) : undefined, g: intOf(parts[parts.length - 1]) };
}

function curveForOid(oid: string): EcCurve {
    for (const name of Object.keys(EC_CURVES)) {
        if (EC_CURVES[name].oid === oid) return EC_CURVES[name];
    }
    throw keyFail('ERR_CRYPTO_INVALID_CURVE', 'Unsupported EC curve');
}

/** SPKI: SEQUENCE { AlgorithmIdentifier, BIT STRING publicKey }. */
function importSpki(bytes: Uint8Array): KeyRecord {
    const root = derRead(bytes);
    if (root.tag !== DER_SEQUENCE || root.children.length !== 2) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid SPKI');
    const [algorithm, subject] = root.children;
    if (subject.tag !== DER_BIT_STRING || subject.content.length < 1 || subject.content[0] !== 0) {
        throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid SPKI: bad public key bit string');
    }
    const found = algorithmOf(algorithm);
    if (found.kind === 'rsa' || found.kind === 'rsa-pss') {
        const inner = derRead(subject.content.subarray(1));
        if (inner.tag !== DER_SEQUENCE || inner.children.length !== 2) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid RSA public key');
        const ints: IntKey = { n: intOf(inner.children[0]), e: intOf(inner.children[1]) };
        return { type: 'public', kind: found.kind, ints, publicBytes: bytesOf(ints.n as bigint, modulusSize(ints.n as bigint)) };
    }
    if (found.kind === 'dsa' || found.kind === 'dh') {
        const ints: IntKey = { ...(domainOf(found.domain as DerNode)), y: intOf(derRead(subject.content.subarray(1))) };
        return { type: 'public', kind: found.kind, ints, publicBytes: bytesOf(ints.y as bigint, modulusSize(ints.p as bigint)) };
    }
    const pub = subject.content.subarray(1);
    if (found.kind === 'ec') {
        const curve = found.curve as EcCurve;
        if (pub.length !== 1 + 2 * curve.size) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid EC public key length');
        return { type: 'public', kind: 'ec', curve, publicBytes: Uint8Array.from(pub) };
    }
    const spec = EDWARDS[found.kind];
    if (pub.length !== spec.size) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid public key length');
    return { type: 'public', kind: found.kind, publicBytes: Uint8Array.from(pub) };
}

/** PKCS#8: SEQUENCE { version 0, AlgorithmIdentifier, OCTET STRING privateKey }. */
function importPkcs8(bytes: Uint8Array): KeyRecord {
    const root = derRead(bytes);
    if (root.tag !== DER_SEQUENCE || root.children.length < 3) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid PKCS#8');
    const found = algorithmOf(root.children[1]);
    const wrapped = root.children[2];
    if (wrapped.tag !== DER_OCTET_STRING) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid PKCS#8: private key is not an OCTET STRING');
    if (found.kind === 'rsa' || found.kind === 'rsa-pss') {
        const inner = derRead(wrapped.content);
        const parts = inner.children;
        if (inner.tag !== DER_SEQUENCE || parts.length !== 9) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid RSA private key');
        const ints: IntKey = {
            n: intOf(parts[1]),
            e: intOf(parts[2]),
            d: intOf(parts[3]),
            p: intOf(parts[4]),
            q: intOf(parts[5]),
            dp: intOf(parts[6]),
            dq: intOf(parts[7]),
            qi: intOf(parts[8])
        };
        return { type: 'private', kind: found.kind, ints, publicBytes: bytesOf(ints.n as bigint, modulusSize(ints.n as bigint)), privateBytes: bytesOf(ints.d as bigint, modulusSize(ints.n as bigint)) };
    }
    /* Inside PKCS#8 a DSA or DH private key is the bare INTEGER x, with the domain alongside it. */
    if (found.kind === 'dsa' || found.kind === 'dh') {
        const x = intOf(derRead(wrapped.content));
        const domain = domainOf(found.domain as DerNode);
        const ints: IntKey = { ...domain, x, y: modPow(domain.g, x, domain.p) };
        return { type: 'private', kind: found.kind, ints, publicBytes: bytesOf(ints.y as bigint, modulusSize(ints.p as bigint)), privateBytes: minimalBytesOf(x) };
    }
    if (found.kind === 'ec') return importEcPrivateKey(wrapped.content, found.curve as EcCurve);
    /* RFC 8410: the OCTET STRING holds another OCTET STRING with the seed or scalar inside. */
    const inner = derRead(wrapped.content);
    if (inner.tag !== DER_OCTET_STRING) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid PKCS#8: bad private key');
    const spec = EDWARDS[found.kind];
    if (inner.content.length !== spec.seed) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid private key length');
    const priv = Uint8Array.from(inner.content);
    return { type: 'private', kind: found.kind, privateBytes: priv, publicBytes: spec.getPublicKey(priv) };
}

/** RFC 5915 ECPrivateKey inside a PKCS#8 wrapper, or on its own as a `sec1` export. */
function importEcPrivateKey(content: Uint8Array, curve: EcCurve): KeyRecord {
    const root = derRead(content);
    const version = root.children[0];
    const scalar = root.children[1];
    if (root.tag !== DER_SEQUENCE || version === undefined || scalar === undefined || scalar.tag !== DER_OCTET_STRING) {
        throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid EC private key');
    }
    const priv = scalar.content.length > curve.size ? scalar.content.subarray(0, curve.size) : scalar.content;
    return { type: 'private', kind: 'ec', curve, privateBytes: Uint8Array.from(priv), publicBytes: curve.curve.getPublicKey(priv, false) };
}

function importJwk(jwk: any, want: 'public' | 'private'): KeyRecord {
    if (jwk === null || typeof jwk !== 'object') throw keyFail('ERR_CRYPTO_INVALID_JWK', 'Invalid JWK');
    if (jwk.kty === 'RSA') {
        const n = bigOf(fromBase64url(jwk.n, 'n'));
        const size = modulusSize(n);
        const ints: IntKey = { n, e: bigOf(fromBase64url(jwk.e, 'e')) };
        if (want === 'public') return { type: 'public', kind: 'rsa', ints, publicBytes: bytesOf(n, size) };
        const d = bigOf(fromBase64url(jwk.d, 'd'));
        ints.d = d;
        /* The CRT parts are optional in a JWK, and a key that carries them signs the same way. */
        if (typeof jwk.p === 'string' && typeof jwk.q === 'string') {
            ints.p = bigOf(fromBase64url(jwk.p, 'p'));
            ints.q = bigOf(fromBase64url(jwk.q, 'q'));
            ints.dp = typeof jwk.dp === 'string' ? bigOf(fromBase64url(jwk.dp, 'dp')) : ints.d % (ints.p - 1n);
            ints.dq = typeof jwk.dq === 'string' ? bigOf(fromBase64url(jwk.dq, 'dq')) : ints.d % (ints.q - 1n);
            ints.qi = typeof jwk.qi === 'string' ? bigOf(fromBase64url(jwk.qi, 'qi')) : modInverse(ints.q, ints.p);
        }
        return { type: 'private', kind: 'rsa', ints, publicBytes: bytesOf(n, size), privateBytes: bytesOf(d, size) };
    }
    if (jwk.kty === 'EC') {
        const curve = curveFor(jwk.crv);
        if (want === 'public') {
            const x = fromBase64url(jwk.x, 'x');
            const y = fromBase64url(jwk.y, 'y');
            return { type: 'public', kind: 'ec', curve, publicBytes: concatBytes(new Uint8Array([4]), concatBytes(paddedScalar(x, curve.size), paddedScalar(y, curve.size))) };
        }
        const d = fromBase64url(jwk.d, 'd');
        return { type: 'private', kind: 'ec', curve, privateBytes: d, publicBytes: curve.curve.getPublicKey(d, false) };
    }
    if (jwk.kty === 'OKP') {
        const asked = String(jwk.crv ?? '').toLowerCase();
        const spec = Object.keys(EDWARDS).map((k) => EDWARDS[k]).find((s) => s.jwk.toLowerCase() === asked);
        if (spec === undefined) throw keyFail('ERR_CRYPTO_INVALID_JWK', 'Unsupported JWK curve: ' + String(jwk.crv));
        if (want === 'public') {
            const x = fromBase64url(jwk.x, 'x');
            if (x.length !== spec.size) throw keyFail('ERR_CRYPTO_INVALID_JWK', 'Invalid JWK public key length');
            return { type: 'public', kind: spec.kind, publicBytes: x };
        }
        const d = fromBase64url(jwk.d, 'd');
        if (d.length !== spec.seed) throw keyFail('ERR_CRYPTO_INVALID_JWK', 'Invalid JWK private key length');
        return { type: 'private', kind: spec.kind, privateBytes: d, publicBytes: spec.getPublicKey(d) };
    }
    throw keyFail('ERR_CRYPTO_INVALID_JWK', 'Unsupported JWK key type: ' + String(jwk.kty));
}

function signWith(key: KeyRecord, algorithm: unknown, data: Uint8Array, dsaEncoding?: unknown, padding?: unknown, saltLength?: unknown): Uint8Array {
    if (key.type !== 'private') throw keyFail('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', 'Invalid key object type public, expected private.');
    if (key.kind === 'rsa' || key.kind === 'rsa-pss') {
        const name = digestNameFor(algorithm);
        const spec = digestFor(name);
        const mode = Number(padding) === RSA_PKCS1_PSS_PADDING ? RSA_PKCS1_PSS_PADDING : RSA_PKCS1_PADDING;
        return rsaSignWith(key.ints as IntKey, spec.fn(data, 0), name, mode, pssSaltLength(saltLength, spec.out));
    }
    if (key.kind === 'dsa') {
        const name = digestNameFor(algorithm);
        return dsaSignWith(key.ints as IntKey, digestFor(name).fn(data, 0));
    }
    if (key.kind === 'dh') {
        throw keyFail('ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE', 'error:03000096:digital envelope routines::operation not supported for this keytype');
    }
    const spec = EDWARDS[key.kind];
    if (spec !== undefined) {
        /*
         * An Edwards key is pure: it hashes and signs in one step and names no digest, so Node
         * refuses a signature that asks for one, and so does this.
         */
        if (spec.sign === undefined) {
            throw keyFail('ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE', 'error:03000096:digital envelope routines::operation not supported for this keytype');
        }
        if (algorithm !== undefined && algorithm !== null) {
            throw keyFail('ERR_OSSL_INVALID_DIGEST', 'error:1C80007A:Provider routines::invalid digest');
        }
        return spec.sign(data, key.privateBytes as Uint8Array);
    }
    const curve = key.curve as EcCurve;
    /*
     * Node signs the digest, not the message, so the digest is taken here and prehash is off.
     * The nonce is salted with fresh entropy because OpenSSL draws a random one: a caller that
     * signs the same bytes twice sees two different signatures on the host, and here too.
     */
    const digest = digestFor(algorithm).fn(data, 0);
    const signed = curve.curve.sign(digest, key.privateBytes as Uint8Array, { lowS: true, prehash: false, extraEntropy: randomOf(32) });
    /* 'ieee-p1363' is r||s; Node's default is the DER SEQUENCE of the two. */
    return signed.toBytes(dsaEncoding === 'ieee-p1363' ? 'compact' : 'der');
}

function verifyWith(key: KeyRecord, algorithm: unknown, data: Uint8Array, signature: Uint8Array, dsaEncoding?: unknown, padding?: unknown, saltLength?: unknown): boolean {
    if (key.type !== 'public' && key.type !== 'private') return false;
    if (key.kind === 'rsa' || key.kind === 'rsa-pss') {
        const name = digestNameFor(algorithm);
        const spec = DIGEST_SPECS[name];
        if (spec === undefined) return false;
        const mode = Number(padding) === RSA_PKCS1_PSS_PADDING ? RSA_PKCS1_PSS_PADDING : RSA_PKCS1_PADDING;
        /* A PSS check the caller named no salt length for is AUTO, which accepts any salt. */
        return rsaVerifyWith(key.ints as IntKey, spec.fn(data, 0), name, signature, mode, saltLength === undefined || saltLength === null ? -2 : pssSaltLength(saltLength, spec.out));
    }
    if (key.kind === 'dsa') {
        const spec = DIGEST_SPECS[digestNameFor(algorithm)];
        if (spec === undefined) return false;
        return dsaVerifyWith(key.ints as IntKey, spec.fn(data, 0), signature);
    }
    if (key.kind === 'dh') return false;
    const spec = EDWARDS[key.kind];
    if (spec !== undefined) {
        if (spec.verify === undefined) return false;
        if (algorithm !== undefined && algorithm !== null) return false;
        try {
            return spec.verify(signature, data, key.publicBytes as Uint8Array);
        } catch {
            return false;
        }
    }
    const curve = key.curve as EcCurve;
    try {
        const digest = digestFor(algorithm).fn(data, 0);
        /*
         * Node parses the signature in the encoding it was asked for, and @noble would accept
         * either: a 64-byte r||s pair is not a DER SEQUENCE and a DER SEQUENCE is not 64 bytes,
         * so naming the format keeps a compact signature false under the 'der' default the way
         * it is on the host instead of letting the auto-detecting parse pass it.
         */
        const format = dsaEncoding === 'ieee-p1363' ? 'compact' : 'der';
        /* Node accepts a high-S signature, so verification must too; signing still emits a low one. */
        return curve.curve.verify(signature, digest, key.publicBytes as Uint8Array, { lowS: false, prehash: false, format });
    } catch {
        return false;
    }
}

/* ---------------------------------------------------------------------------------------------
 * Diffie-Hellman. The arithmetic is BigInt modular exponentiation, which is fast enough for the
 * key sizes a caller uses. A size with a standard group (RFC 2409 group 1 and 2, RFC 3526 groups
 * 5 and 14-18) gets that group's prime, which is a safe prime of exactly that size; any other
 * size gets a freshly generated probable prime, which is what Node's own generator produces too.
 * ------------------------------------------------------------------------------------------ */

/** RFC 2409 (768, 1024) and RFC 3526 (1536, 2048, 3072, 4096, 6144, 8192) MODP primes, hex. */
/* The primes of RFC 2409 groups 1-2 and RFC 3526 groups 5 and 14-18, by size in bits. */
const MODP_GROUPS: Record<number, string> = {
    768: 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A63A3620FFFFFFFFFFFFFFFF',
    1024: 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF',
    1536: 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA237327FFFFFFFFFFFFFFFF',
    2048: 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF',
    3072: 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF',
    4096: 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C934063199FFFFFFFFFFFFFFFF',
    6144: 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C93402849236C3FAB4D27C7026C1D4DCB2602646DEC9751E763DBA37BDF8FF9406AD9E530EE5DB382F413001AEB06A53ED9027D831179727B0865A8918DA3EDBEBCF9B14ED44CE6CBACED4BB1BDB7F1447E6CC254B332051512BD7AF426FB8F401378CD2BF5983CA01C64B92ECF032EA15D1721D03F482D7CE6E74FEF6D55E702F46980C82B5A84031900B1C9E59E7C97FBEC7E8F323A97A7E36CC88BE0F1D45B7FF585AC54BD407B22B4154AACC8F6D7EBF48E1D814CC5ED20F8037E0A79715EEF29BE32806A1D58BB7C5DA76F550AA3D8A1FBFF0EB19CCB1A313D55CDA56C9EC2EF29632387FE8D76E3C0468043E8F663F4860EE12BF2D5B0B7474D6E694F91E6DCC4024FFFFFFFFFFFFFFFF',
    8192: 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C93402849236C3FAB4D27C7026C1D4DCB2602646DEC9751E763DBA37BDF8FF9406AD9E530EE5DB382F413001AEB06A53ED9027D831179727B0865A8918DA3EDBEBCF9B14ED44CE6CBACED4BB1BDB7F1447E6CC254B332051512BD7AF426FB8F401378CD2BF5983CA01C64B92ECF032EA15D1721D03F482D7CE6E74FEF6D55E702F46980C82B5A84031900B1C9E59E7C97FBEC7E8F323A97A7E36CC88BE0F1D45B7FF585AC54BD407B22B4154AACC8F6D7EBF48E1D814CC5ED20F8037E0A79715EEF29BE32806A1D58BB7C5DA76F550AA3D8A1FBFF0EB19CCB1A313D55CDA56C9EC2EF29632387FE8D76E3C0468043E8F663F4860EE12BF2D5B0B7474D6E694F91E6DBE115974A3926F12FEE5E438777CB6A932DF8CD8BEC4D073B931BA3BC832B68D9DD300741FA7BF8AFC47ED2576F6936BA424663AAB639C5AE4F5683423B4742BF1C978238F16CBE39D652DE3FDB8BEFC848AD922222E04A4037C0713EB57A81A23F0C73473FC646CEA306B4BCBC8862F8385DDFA9D4B7FA2C087E879683303ED5BDD3A062B3CF5B3A278A66D2A13F83F44F82DDF310EE074AB6A364597E899A0255DC164F31CC50846851DF9AB48195DED7EA1B1D510BD7EE74D73FAF36BC31ECFA268359046F4EB879F924009438B481C6CD7889A002ED5EE382BC9190DA6FC026E479558E4475677E9AA9E3050E2765694DFC81F56E880B96E7160C980DD98EDD3DFFFFFFFFFFFFFFFFF',
};

const DH_GROUP_NAMES: Record<string, number> = {
    modp1: 768,
    modp2: 1024,
    modp5: 1536,
    modp14: 2048,
    modp15: 3072,
    modp16: 4096,
    modp17: 6144,
    modp18: 8192
};

const DH_STATE = new Map<number, { prime: bigint; generator: bigint; size: number; privateKey?: bigint; publicKey?: bigint }>();
let nextDhId = 1;
const OPEN_DH_LIMIT = 64;

function dhFail(code: string, message: string, kind: 'Error' | 'RangeError' | 'TypeError' = 'Error'): never {
    const Ctor = kind === 'RangeError' ? RangeError : kind === 'TypeError' ? TypeError : Error;
    throw Object.assign(new Ctor(message), { code, owcErrorClass: kind });
}

function dhFor(id: unknown, op: string) {
    const state = DH_STATE.get(Number(id));
    if (state === undefined) dhFail('ERR_CRYPTO_INVALID_STATE', `Invalid state for operation ${op}`);
    return state as NonNullable<typeof state>;
}

function storeDh(state: { prime: bigint; generator: bigint; size: number }): number {
    if (DH_STATE.size >= OPEN_DH_LIMIT) {
        const oldest = DH_STATE.keys().next().value;
        if (oldest !== undefined) DH_STATE.delete(oldest);
    }
    const id = nextDhId++;
    DH_STATE.set(id, state);
    return id;
}

const bigOf = (bytes: Uint8Array): bigint => {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return value;
};

/** Big-endian bytes of a non-negative integer, left-padded to `size` as Node pads its DH output. */
function bytesOf(value: bigint, size: number): Uint8Array {
    const out = new Uint8Array(size);
    let rest = value;
    for (let at = size - 1; at >= 0; at--) {
        out[at] = Number(rest & 0xffn);
        rest >>= 8n;
    }
    return out;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
    let result = 1n;
    let b = base % modulus;
    let e = exponent;
    while (e > 0n) {
        if (e & 1n) result = (result * b) % modulus;
        b = (b * b) % modulus;
        e >>= 1n;
    }
    return result;
}

/*
 * The width OpenSSL gives a fresh DH private exponent: twice the finite-field security strength
 * of the prime, with its top bit set, so a 2048-bit group answers a 29-byte exponent rather than
 * a full-width one. Primes of 1024 bits and below get the whole width instead.
 */
const DH_EXPONENT_BITS: ReadonlyArray<readonly [number, number]> = [
    [8192, 400], [6144, 376], [4096, 320], [3072, 280], [2048, 232], [1536, 200]
];

function randomExponent(prime: bigint): bigint {
    const primeBits = prime.toString(2).length;
    let bits = primeBits - 1;
    for (const [at, width] of DH_EXPONENT_BITS) {
        if (primeBits >= at) {
            bits = Math.min(width, primeBits - 1);
            break;
        }
    }
    if (bits < 2) bits = 2;
    const half = 1n << BigInt(bits - 1);
    let value = half | (bigOf(randomOf(Math.ceil(bits / 8))) % half);
    if (value < 2n) value = 2n;
    return value;
}

/** The shortest big-endian form of a non-negative integer: no leading zero byte. */
function minimalBytesOf(value: bigint): Uint8Array {
    if (value === 0n) return new Uint8Array([0]);
    let width = 1;
    while ((value >> BigInt(width * 8)) > 0n) width++;
    return bytesOf(value, width);
}

/** Miller-Rabin: `rounds` witnesses on an odd candidate; a composite fails at least three in four. */
function isProbablePrime(candidate: bigint, rounds: number): boolean {
    const small = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
    for (const p of small) {
        if (candidate === p) return true;
        if (candidate % p === 0n) return false;
    }
    let d = candidate - 1n;
    let s = 0;
    while ((d & 1n) === 0n) {
        d >>= 1n;
        s++;
    }
    for (let round = 0; round < rounds; round++) {
        const witness = 2n + bigOf(randomOf(8)) % (candidate - 4n);
        let x = modPow(witness, d, candidate);
        if (x === 1n || x === candidate - 1n) continue;
        let composite = true;
        for (let i = 1; i < s; i++) {
            x = (x * x) % candidate;
            if (x === candidate - 1n) {
                composite = false;
                break;
            }
        }
        if (composite) return false;
    }
    return true;
}

/** A random odd `bits`-bit number with its top bit set, tested until one is probably prime. */
function randomPrime(bits: number): bigint {
    /* The sieved search, so a 1024-bit prime for a Diffie-Hellman group takes seconds, not minutes. */
    return searchPrime(bits);
}

/** The prime for a size: the standard group when there is one, a fresh probable prime otherwise. */
function primeOfBits(bits: number): bigint {
    const standard = MODP_GROUPS[bits];
    if (standard !== undefined) return BigInt('0x' + standard);
    if (!Number.isInteger(bits) || bits < 8 || bits > 4096) {
        throw dhFail('ERR_OUT_OF_RANGE', 'The value of "primeLength" is out of range. It must be >= 8 && <= 4096. Received ' + String(bits), 'RangeError');
    }
    return randomPrime(bits);
}

/** The generator: the caller's number or bytes, 2 when the caller names none (as Node defaults). */
function generatorOf(value: unknown, asNumber: unknown): bigint {
    if (value === undefined || value === null) return 2n;
    if (asNumber === true) return BigInt(Math.trunc(Number(value)));
    if (typeof value === 'string') return bigOf(bytesArg(value));
    throw dhFail('ERR_INVALID_ARG_TYPE', 'The "generator" argument must be of type number, string, Buffer, TypedArray, or DataView.');
}

export const CRYPTO_CAPABILITIES: Record<string, CapabilityHandler> = {
    'crypto.digest': (args) => {
        const spec = digestFor(args?.algorithm);
        return bytesToBase64(spec.fn(bytesArg(args?.data), outputLengthFor(spec, args?.outputLength)));
    },
    /** Args {algorithm, key, data}: the HMAC of the bytes; returns base64. */
    'crypto.hmac': (args) => {
        const spec = digestFor(args?.algorithm);
        /* Node's OpenSSL cannot HMAC through an XOF either: it fails with an empty error string. */
        if (spec.xof === true) throw new Error('error:00000000:lib(0)::reason(0)');
        return bytesToBase64(hmacBytes(spec, bytesArg(args?.key), bytesArg(args?.data)));
    },
    /** Args {}: the digest names getHashes() answers with, in Node's order. */
    'crypto.hashes': () => HASH_NAMES.slice(),
    /** Args {digest, password, salt, iterations, keylen}: the derived key; returns base64. */
    'crypto.pbkdf2': (args) => {
        const spec = digestFor(args?.digest);
        return bytesToBase64(pbkdf2Bytes(spec, bytesArg(args?.password), bytesArg(args?.salt), Number(args?.iterations), Number(args?.keylen)));
    },
    /** Args {password, salt, keylen, N, r, p, maxmem}: the scrypt derived key; returns base64. */
    'crypto.scrypt': (args) => {
        /*
         * Node reaches its default for a parameter it is handed as zero: N:0 derives with the
         * default cost, r:0 with the default block size, p:0 with the default parallelism and
         * maxmem:0 with the default budget, so a degenerate value derives a key rather than
         * throwing -- N:16,r:1,p:0 and N:16,r:1,p:1 are the same eight bytes on the host.
         */
        const N = args?.N ? Number(args?.N) : 16384;
        const r = args?.r ? Number(args?.r) : 8;
        const p = args?.p ? Number(args?.p) : 1;
        const maxmem = args?.maxmem ? Number(args?.maxmem) : 32 * 1024 * 1024;
        /*
         * Node rejects a parameter set before it derives anything: N must be a power of two above
         * one, r and p must be positive, and the whole 128*N*r working set must fit in maxmem.
         */
        if (!(N > 1) || (N & (N - 1)) !== 0 || !(r > 0) || !(p > 0)) {
            throw Object.assign(new Error('Invalid scrypt params'), { code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' });
        }
        /* A working set that will not fit is the one failure Node names a cause for. */
        if (128 * N * r > maxmem) {
            throw Object.assign(
                new Error('Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded'),
                { code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' }
            );
        }
        const keylen = Number(args?.keylen);
        if (!Number.isInteger(keylen) || keylen < 0) {
            throw Object.assign(new Error('The value of "keylen" is out of range. It must be >= 0. Received ' + String(args?.keylen)), { code: 'ERR_OUT_OF_RANGE' });
        }
        return bytesToBase64(scrypt(bytesArg(args?.password), bytesArg(args?.salt), { N, r, p, dkLen: keylen }));
    },
    /** Args {algorithm, ikm, salt, info, keylen}: the HKDF output; returns base64. */
    'crypto.hkdf': (args) => {
        const spec = digestFor(args?.algorithm);
        const keylen = Number(args?.keylen);
        if (!Number.isInteger(keylen) || keylen <= 0 || keylen > 255 * spec.out) {
            throw Object.assign(
                new Error('The value of "keylen" is out of range. It must be > 0 && <= ' + 255 * spec.out + '. Received ' + String(args?.keylen)),
                { code: 'ERR_OUT_OF_RANGE' }
            );
        }
        return bytesToBase64(hkdfBytes(
            spec,
            bytesArg(args?.ikm),
            args?.salt === undefined || args?.salt === null ? new Uint8Array(0) : bytesArg(args?.salt),
            args?.info === undefined || args?.info === null ? new Uint8Array(0) : bytesArg(args?.info),
            keylen
        ));
    },
    /** Args {}: the cipher names createCipheriv and createDecipheriv accept, in Node's own order:
     *  host Node 24.15 answers them sorted, where this table is built a family at a time. */
    'crypto.ciphers': () => CIPHER_NAMES.slice().sort(),
    /** Args {nameOrNid, keyLength?, ivLength?}: Node's getCipherInfo, or undefined for a name here
     *  no cipher carries or a length the cipher does not have. */
    'crypto.cipher.info': (args) => cipherInfo(args?.nameOrNid, args?.options),
    /** Args {algorithm, direction, key, iv}: validates key and IV, opens a host cipher; returns {id, aead}. */
    'crypto.cipher.open': (args) => openCipher(args),
    /** Args {id, data}: the bytes this call emits; aead modes emit nothing until final. Returns base64. */
    'crypto.cipher.update': (args) => bytesToBase64(cipherUpdate(stateFor(args?.id, 'update'), bytesArg(args?.data))),
    /** Args {id}: the last bytes, with padding added or removed. Returns {data, tag?}. Releases the state. */
    'crypto.cipher.final': (args) => {
        const state = stateFor(args?.id, 'final');
        const result = cipherFinal(state);
        CIPHER_STATE.delete(Number(args?.id));
        return { data: bytesToBase64(result.data), tag: result.tag === undefined ? undefined : bytesToBase64(result.tag) };
    },
    /** Args {id, aad}: the additional authenticated data of an AEAD cipher; only before any data. */
    'crypto.cipher.setAAD': (args) => {
        const state = stateFor(args?.id, 'setAAD');
        if (!state.spec.aead || state.updated) invalidState('setAAD');
        state.aad = bytesArg(args?.aad);
        return true;
    },
    /** Args {id, tag}: the authentication tag a decrypting AEAD cipher checks its input against. */
    'crypto.cipher.setAuthTag': (args) => {
        const state = stateFor(args?.id, 'setAuthTag');
        if (!state.spec.aead) invalidState('setAuthTag');
        state.tag = bytesArg(args?.tag);
        return true;
    },
    /** Args {id, on}: whether ECB and CBC add and remove PKCS#7 padding. */
    'crypto.cipher.setAutoPadding': (args) => {
        stateFor(args?.id, 'setAutoPadding').autoPadding = args?.on !== false;
        return true;
    },

    /* -----------------------------------------------------------------------------------------
     * Asymmetric keys. The guest holds handles, never key material.
     * -------------------------------------------------------------------------------------- */

    /** Args {type, options}: a fresh key pair; returns {public, private} handles. */
    'crypto.key.generate': (args) => generatePair(args?.type, args?.options),
    /** Args {id}: what the guest's KeyObject getters answer. */
    'crypto.key.info': (args) => {
        const key = keyFor(args?.id, 'key.info');
        const ints = key.ints;
        let details: Record<string, unknown> = {};
        if (key.kind === 'rsa' || key.kind === 'rsa-pss') {
            /* Node answers publicExponent as a BigInt, so the width travels as text and the
               guest's own BigInt is what a caller actually sees on asymmetricKeyDetails. */
            details = { modulusLength: (ints?.n as bigint).toString(2).length, publicExponent: (ints?.e as bigint).toString() };
        } else if (key.kind === 'dsa') {
            details = { modulusLength: (ints?.p as bigint).toString(2).length, divisorLength: (ints?.q as bigint).toString(2).length };
        }
        return {
            type: key.type,
            asymmetricKeyType: key.kind === 'ec' ? 'ec' : key.kind,
            asymmetricKeyDetails: key.kind === 'ec' ? { namedCurve: (key.curve as EcCurve).node } : details
        };
    },
    /** Args {id, format, type}: the exported key, as base64 (pem/der) or as a JWK object. */
    'crypto.key.export': (args) => {
        const key = keyFor(args?.id, 'key.export');
        const format = String(args?.format ?? 'pem');
        if (format === 'jwk') return { jwk: exportJwk(key) };
        const kind = String(args?.type ?? (key.type === 'public' ? 'spki' : 'pkcs8')).toLowerCase();
        if (key.type === 'private' && (kind === 'spki' || kind === 'raw')) {
            throw keyFail('ERR_INVALID_ARG_VALUE', `The property 'options.type' is invalid. Received '${kind}'`, 'TypeError');
        }
        let der: Uint8Array;
        let label: string;
        if (key.type === 'public') {
            if (kind !== 'spki') throw keyFail('ERR_CRYPTO_INVALID_KEY_TYPE', 'Unsupported public key format: ' + kind);
            der = encodeSpki(key);
            label = 'PUBLIC KEY';
        } else if (kind === 'pkcs8') {
            der = encodePkcs8(key);
            label = 'PRIVATE KEY';
        } else if (kind === 'sec1' && key.kind === 'ec') {
            der = encodeEcPrivateKey(key, true);
            label = 'EC PRIVATE KEY';
        } else {
            throw keyFail('ERR_CRYPTO_INVALID_KEY_TYPE', 'Unsupported private key format: ' + kind);
        }
        return format === 'der' ? { bytes: bytesToBase64(der) } : { bytes: bytesToBase64(new TextEncoder().encode(pemEncode(label, der))) };
    },
    /** Args {format, type, bytes, jwk}: imports a key and returns its handle. */
    'crypto.key.import': (args) => {
        const want = String(args?.want ?? 'public');
        if (args?.jwk !== undefined && args?.jwk !== null) {
            return { id: storeKey(importJwk(args?.jwk, want === 'private' ? 'private' : 'public')) };
        }
        const bytes = bytesArg(args?.bytes);
        const text = new TextDecoder().decode(bytes);
        const pem = text.includes('-----BEGIN');
        /* Node reads the label when the caller names no format, so an EC PRIVATE KEY imports as sec1. */
        const kind = String(args?.type ?? (pem ? pemKindOf(text) : (want === 'private' ? 'pkcs8' : 'spki'))).toLowerCase();
        const sealed = pem && /-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text);
        if (kind === 'spki') return { id: storeKey(importSpki(pem ? pemDecode(text, 'PUBLIC KEY') : bytes)) };
        if (kind === 'pkcs8') {
            const plain = sealed ? decryptPkcs8(pemDecode(text, 'ENCRYPTED PRIVATE KEY'), args?.passphrase) : pem ? pemDecode(text, 'PRIVATE KEY') : bytes;
            return { id: storeKey(importPkcs8(plain)) };
        }
        if (kind === 'sec1') {
            const der = text.includes('-----BEGIN') ? pemDecode(text, 'EC PRIVATE KEY') : bytes;
            const root = derRead(der);
            const oidNode = root.children.find((child) => child.tag === 0xa0 && child.children.length === 1 && child.children[0].tag === DER_OID);
            if (oidNode === undefined) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid SEC1 key: no curve');
            return { id: storeKey(importEcPrivateKey(der, curveForOid(oidOf(oidNode.children[0])))) };
        }
        throw keyFail('ERR_CRYPTO_INVALID_KEY_TYPE', 'Unsupported key format: ' + kind);
    },
    /** Args {a, b}: whether two handles name the same key material. */
    'crypto.key.equal': (args) => {
        const a = keyFor(args?.a, 'key.equal');
        const b = keyFor(args?.b, 'key.equal');
        if (a === b) return true;
        const left = a.type === 'private' ? a.privateBytes : a.publicBytes;
        const right = b.type === 'private' ? b.privateBytes : b.publicBytes;
        if (left === undefined || right === undefined || left.length !== right.length) return false;
        if (a.kind !== b.kind || a.type !== b.type) return false;
        for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
        return true;
    },
    /** Args {id}: the public half of a private key handle, as a public handle of its own. */
    'crypto.key.public': (args) => {
        const key = keyFor(args?.id, 'key.public');
        if (key.type !== 'private') {
            throw keyFail('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', `Invalid key object type ${key.type}, expected private.`);
        }
        if (key.publicBytes === undefined) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Key has no public half');
        return { id: storeKey({ type: 'public', kind: key.kind, curve: key.curve, ints: key.ints, publicBytes: Uint8Array.from(key.publicBytes) }) };
    },
    /** Args {id, algorithm, data, dsaEncoding, padding, saltLength}: the signature; returns base64. */
    'crypto.key.sign': (args) => bytesToBase64(signWith(keyFor(args?.id, 'key.sign'), args?.algorithm, bytesArg(args?.data), args?.dsaEncoding, args?.padding, args?.saltLength)),
    /*
     * Primality. Node answers checkPrime from a Miller-Rabin search with `checks` witnesses, and
     * generatePrime by drawing odd candidates of the width asked for until one passes; a safe prime
     * also needs (p-1)/2 prime. The search is BigInt arithmetic, so it is quick for the widths a
     * caller probes with and slow for the 1024-bit halves an RSA key would need.
     */
    /** Args {value, valueIsBigInt, checks}: whether the candidate is a probable prime. */
    'crypto.checkPrime': (args) => {
        const value = args?.valueIsBigInt === true ? BigInt(String(args?.value ?? '0')) : bigOf(bytesArg(args?.value));
        const checks = args?.checks === undefined ? 32 : Number(args?.checks);
        if (value < 2n) return { prime: false };
        return { prime: isProbablePrime(value, checks < 1 ? 1 : checks) };
    },
    /** Args {bits, safe, bigint}: a fresh probable prime of that width, as base64 and as text. */
    'crypto.generatePrime': (args) => {
        const bits = Number(args?.bits);
        if (!Number.isInteger(bits) || bits < 2) {
            throw keyFail('ERR_OUT_OF_RANGE', 'The value of "primeLength" is out of range. It must be >= 2. Received ' + String(args?.bits), 'RangeError');
        }
        const safe = args?.safe === true;
        for (let attempt = 0; attempt < 100000; attempt++) {
            const candidate = randomPrime(bits);
            if (safe && !isProbablePrime((candidate - 1n) / 2n, 8)) continue;
            return { bytes: bytesToBase64(bytesOf(candidate, Math.ceil(bits / 8))), value: candidate.toString() };
        }
        throw keyFail('ERR_CRYPTO_INVALID_STATE', 'Could not find a prime of ' + bits + ' bits');
    },    /** Args {id, algorithm, data, signature, dsaEncoding, padding, saltLength}: whether it checks out. */
    'crypto.key.verify': (args) => verifyWith(keyFor(args?.id, 'key.verify'), args?.algorithm, bytesArg(args?.data), bytesArg(args?.signature), args?.dsaEncoding, args?.padding, args?.saltLength),

    /* -----------------------------------------------------------------------------------------
     * Diffie-Hellman.
     * -------------------------------------------------------------------------------------- */

    /** Args {bits, generator, generatorIsNumber} or {prime, generator, generatorIsNumber}: a handle. */
    'crypto.dh.create': (args) => {
        const prime = args?.prime === undefined || args?.prime === null
            ? primeOfBits(Number(args?.bits))
            : bigOf(bytesArg(args?.prime));
        if (prime < 3n) throw dhFail('ERR_CRYPTO_INVALID_DH_PARAMETERS', 'Invalid prime');
        const generator = generatorOf(args?.generator, args?.generatorIsNumber);
        const size = Math.ceil(prime.toString(16).length / 2);
        return { id: storeDh({ prime, generator, size }) };
    },
    /** Args {name}: a standard MODP group by name; returns a handle. */
    'crypto.dh.group': (args) => {
        const bits = DH_GROUP_NAMES[String(args?.name ?? '')];
        if (bits === undefined) throw dhFail('ERR_CRYPTO_UNKNOWN_DH_GROUP', 'Unknown DH group');
        const prime = BigInt('0x' + MODP_GROUPS[bits]);
        return { id: storeDh({ prime, generator: 2n, size: Math.ceil(prime.toString(16).length / 2) }) };
    },
    /** Args {id}: the prime and generator, as base64, with the byte size both are padded to. */
    'crypto.dh.info': (args) => {
        const state = dhFor(args?.id, 'dh.info');
        return {
            prime: bytesToBase64(bytesOf(state.prime, state.size)),
            generator: bytesToBase64(bytesOf(state.generator, 1)),
            size: state.size
        };
    },
    /** Args {id}: the key pair this side uses; returns {public, private} as base64. */
    'crypto.dh.keys': (args) => {
        const state = dhFor(args?.id, 'dh.keys');
        if (state.privateKey === undefined) {
            state.privateKey = randomExponent(state.prime);
            state.publicKey = modPow(state.generator, state.privateKey, state.prime);
        }
        return {
            /* Node pads a prime and a public key to the prime's width but leaves a private
               exponent bare, so a 2048-bit group reports a 29-byte private key. */
            public: bytesToBase64(bytesOf(state.publicKey as bigint, state.size)),
            private: bytesToBase64(minimalBytesOf(state.privateKey as bigint))
        };
    },
    /** Args {id, public, private}: sets one or both of this side's keys. */
    'crypto.dh.set': (args) => {
        const state = dhFor(args?.id, 'dh.set');
        if (typeof args?.private === 'string') {
            state.privateKey = bigOf(bytesArg(args?.private));
            state.publicKey = modPow(state.generator, state.privateKey, state.prime);
        }
        if (typeof args?.public === 'string') state.publicKey = bigOf(bytesArg(args?.public));
        return true;
    },
    /** Args {id, public}: the shared secret; returns base64. */
    'crypto.dh.secret': (args) => {
        const state = dhFor(args?.id, 'dh.secret');
        if (state.privateKey === undefined) throw dhFail('ERR_CRYPTO_INVALID_STATE', 'Invalid state for operation computeSecret');
        const other = bigOf(bytesArg(args?.public));
        /* Node rejects a peer key at 0, 1 or the prime itself before it exponentiates. */
        if (other < 2n || other >= state.prime - 1n) {
            throw dhFail('ERR_CRYPTO_INVALID_PUBLIC_KEY', 'Invalid public key');
        }
        return bytesToBase64(bytesOf(modPow(other, state.privateKey, state.prime), state.size));
    },
    /** Args {prime, private, public}: the low-level shared secret Node's diffieHellman() answers. */
    /*
     * ECDH: the shared secret of a private key and a peer's public key, over X25519, X448 or an
     * EC curve. Node's diffieHellman takes key objects for these and a prime for the classic
     * finite-field form, and the exponentiation here is the curve's own.
     */
    /** Args {private, public}: two key handles; returns base64. */
    'crypto.dh.ecdh': (args) => {
        const priv = keyFor(args?.private, 'dh.ecdh');
        const pub = keyFor(args?.public, 'dh.ecdh');
        if (priv.type !== 'private') throw keyFail('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', 'Invalid key object type public, expected private.');
        /* A classic DH agreement: both sides have to share the one group, and Node says so. */
        if (priv.kind === 'dh' || pub.kind === 'dh') {
            if (priv.kind !== 'dh' || pub.kind !== 'dh') throw keyFail('ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS', 'Incompatible key types');
            const mine = priv.ints as IntKey;
            const theirs = pub.ints as IntKey;
            if (mine.p !== theirs.p || mine.g !== theirs.g) {
                throw keyFail('ERR_OSSL_MISMATCHING_DOMAIN_PARAMETERS', 'error:1C8000CB:Provider routines::mismatching domain parameters');
            }
            const other = theirs.y as bigint;
            if (other < 2n || other >= (mine.p as bigint) - 1n) throw keyFail('ERR_CRYPTO_INVALID_PUBLIC_KEY', 'Invalid public key');
            return bytesToBase64(bytesOf(modPow(other, mine.x as bigint, mine.p as bigint), modulusSize(mine.p as bigint)));
        }
        if (pub.kind !== priv.kind) throw keyFail('ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS', 'Incompatible key types');
        if (priv.kind === 'ec') {
            const curve = priv.curve as EcCurve;
            if (curve !== (pub.curve as EcCurve)) throw keyFail('ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS', 'Incompatible curves');
            /* Node hands back the x-coordinate alone, which is what follows the 0x04 point header. */
            const point = curve.curve.getSharedSecret(priv.privateBytes as Uint8Array, pub.publicBytes as Uint8Array, false);
            return bytesToBase64(point.subarray(1, 1 + curve.size));
        }
        const spec = EDWARDS[priv.kind];
        if (spec === undefined || spec.getSharedSecret === undefined) {
            throw keyFail('ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE', 'error:03000096:digital envelope routines::operation not supported for this keytype');
        }
        return bytesToBase64(spec.getSharedSecret(priv.privateBytes as Uint8Array, pub.publicBytes as Uint8Array));
    },
};
