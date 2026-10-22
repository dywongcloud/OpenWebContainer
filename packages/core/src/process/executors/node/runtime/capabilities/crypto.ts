import { blake2b, blake2s } from '@noble/hashes/blake2';
import { md5 } from '@noble/hashes/legacy';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { scrypt } from '@noble/hashes/scrypt';
import { sha1 } from '@noble/hashes/sha1';
import { sha224, sha256 } from '@noble/hashes/sha256';
import { sha384, sha512 } from '@noble/hashes/sha512';
import { sha512_224, sha512_256 } from '@noble/hashes/sha2';
import { sha3_224, sha3_256, sha3_384, sha3_512, shake128, shake256 } from '@noble/hashes/sha3';
import { cbc, cfb, ctr, ecb, gcm } from '@noble/ciphers/aes';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
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
    if (!Number.isInteger(n) || n <= 0) {
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

type CipherMode = 'ecb' | 'cbc' | 'ctr' | 'cfb' | 'gcm' | 'cc20p';

interface CipherSpec {
    mode: CipherMode;
    keyLength: number;
    /** 16 where OpenSSL emits a block at a time, 1 where it emits everything it is given. */
    blockSize: number;
    /** 0 for ECB, an exact length for the rest, -1 for GCM's variable nonce. */
    ivLength: number;
    aead: boolean;
}

const CIPHER_SPECS: Record<string, CipherSpec> = {};
for (const bits of [128, 192, 256]) {
    const keyLength = bits / 8;
    CIPHER_SPECS[`aes-${bits}-ecb`] = { mode: 'ecb', keyLength, blockSize: 16, ivLength: 0, aead: false };
    CIPHER_SPECS[`aes-${bits}-cbc`] = { mode: 'cbc', keyLength, blockSize: 16, ivLength: 16, aead: false };
    CIPHER_SPECS[`aes-${bits}-ctr`] = { mode: 'ctr', keyLength, blockSize: 1, ivLength: 16, aead: false };
    CIPHER_SPECS[`aes-${bits}-cfb`] = { mode: 'cfb', keyLength, blockSize: 1, ivLength: 16, aead: false };
    CIPHER_SPECS[`aes-${bits}-gcm`] = { mode: 'gcm', keyLength, blockSize: 1, ivLength: -1, aead: true };
}
CIPHER_SPECS['chacha20-poly1305'] = { mode: 'cc20p', keyLength: 32, blockSize: 1, ivLength: 12, aead: true };

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
    aad: Uint8Array;
    tag?: Uint8Array;
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

/** The raw AES block encryption of the current register or counter: ECB over one block, padding off. */
function aesBlock(state: CipherState): Uint8Array {
    return ecb(state.key, { disablePadding: true }).encrypt(state.iv);
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
            return { data: sealed.subarray(0, sealed.length - TAG_LENGTH), tag: sealed.subarray(sealed.length - TAG_LENGTH) };
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
    const spec = CIPHER_SPECS[String(args?.algorithm ?? '').toLowerCase()];
    if (spec === undefined) throw cipherFail('ERR_CRYPTO_UNKNOWN_CIPHER', 'Unknown cipher');
    /* Node reports a bad IV before a bad key, and an unknown cipher before either. */
    const iv = typeof args?.iv === 'string' ? base64ToBytes(args.iv) : new Uint8Array(0);
    if (spec.ivLength === 0) {
        if (iv.length !== 0) throw invalidIv();
    } else if (spec.ivLength > 0) {
        if (iv.length !== spec.ivLength) throw invalidIv();
    } else if (iv.length < GCM_MIN_IV) {
        throw invalidIv();
    }
    const key = bytesArg(args?.key);
    if (key.length !== spec.keyLength) throw invalidKeyLength();
    if (CIPHER_STATE.size >= OPEN_CIPHER_LIMIT) {
        const oldest = CIPHER_STATE.keys().next().value;
        if (oldest !== undefined) CIPHER_STATE.delete(oldest);
    }
    const id = nextCipherId++;
    CIPHER_STATE.set(id, {
        spec,
        direction: args?.direction === 'decrypt' ? 'decrypt' : 'encrypt',
        key,
        iv,
        counterOffset: 0,
        chainBuf: new Uint8Array(BLOCK),
        keystream: null,
        pending: new Uint8Array(0),
        autoPadding: true,
        updated: false,
        aad: new Uint8Array(0)
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

type KeyKind = 'ed25519' | 'x25519' | 'ed448' | 'x448' | 'ec';

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
        verify: (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array, opts: { lowS: boolean; prehash: boolean }) => boolean;
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
}> = {
    ed25519: { kind: 'ed25519', oid: '1.3.101.112', jwk: 'Ed25519', seed: 32, size: 32, getPublicKey: (p) => nobleEd25519.getPublicKey(p), randomPrivateKey: () => nobleEd25519.utils.randomPrivateKey(), sign: (m, p) => nobleEd25519.sign(m, p), verify: (s, m, p) => nobleEd25519.verify(s, m, p) },
    x25519: { kind: 'x25519', oid: '1.3.101.110', jwk: 'X25519', seed: 32, size: 32, getPublicKey: (p) => nobleX25519.getPublicKey(p), randomPrivateKey: () => nobleX25519.utils.randomPrivateKey() },
    ed448: { kind: 'ed448', oid: '1.3.101.113', jwk: 'Ed448', seed: 57, size: 57, getPublicKey: (p) => nobleEd448.getPublicKey(p), randomPrivateKey: () => nobleEd448.utils.randomPrivateKey(), sign: (m, p) => nobleEd448.sign(m, p), verify: (s, m, p) => nobleEd448.verify(s, m, p) },
    x448: { kind: 'x448', oid: '1.3.101.111', jwk: 'X448', seed: 56, size: 56, getPublicKey: (p) => nobleX448.getPublicKey(p), randomPrivateKey: () => nobleX448.utils.randomPrivateKey() }
};

interface KeyRecord {
    type: 'public' | 'private';
    kind: KeyKind;
    /** The EC named curve, for the EC kinds only. */
    curve?: EcCurve;
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
    const [algorithm, bits] = key.kind === 'ec'
        ? [derSequence([derOid(EC_PUBLIC_KEY_OID), derOid((key.curve as EcCurve).oid)]), (key.publicBytes as Uint8Array)]
        : [derSequence([derOid(EDWARDS[key.kind].oid)]), (key.publicBytes as Uint8Array)];
    return derSequence([algorithm, derBitString(bits)]);
}

/** OneAsymmetricKey (PKCS#8), the default behind a private key's export. */
function encodePkcs8(key: KeyRecord): Uint8Array {
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
    if (key.kind === 'ec') {
        const curve = key.curve as EcCurve;
        const point = key.publicBytes as Uint8Array;
        const jwk: Record<string, unknown> = {
            kty: 'EC',
            crv: curve.jwk,
            x: base64url(point.subarray(1, 1 + curve.size)),
            y: base64url(point.subarray(1 + curve.size, 1 + 2 * curve.size))
        };
        if (key.type === 'private') jwk.d = base64url(paddedScalar(key.privateBytes as Uint8Array, curve.size));
        return jwk;
    }
    const spec = EDWARDS[key.kind];
    const jwk: Record<string, unknown> = {
        kty: 'OKP',
        crv: spec.jwk,
        x: base64url(key.publicBytes as Uint8Array)
    };
    if (key.type === 'private') jwk.d = base64url(key.privateBytes as Uint8Array);
    return jwk;
}

/** The curve a generateKeyPair or an EC key import names, in Node's own spelling. */
function curveFor(name: unknown): EcCurve {
    const asked = String(name ?? '').toLowerCase();
    const node = EC_CURVE_ALIASES[String(name ?? '')] ?? asked;
    const curve = EC_CURVES[node];
    if (curve === undefined) throw keyFail('ERR_CRYPTO_INVALID_CURVE', 'Invalid EC curve name: ' + String(name));
    return curve;
}

function generatePair(type: unknown, options: any): { public: number; private: number } {
    const kind = String(type ?? '').toLowerCase();
    if (kind === 'rsa' || kind === 'rsa-pss' || kind === 'dh' || kind === 'dsa') {
        throw keyFail(
            'ERR_CRYPTO_UNSUPPORTED_OPERATION',
            `${kind} key generation is not available: this runtime has no large-prime search (RSA, DSA, DH)`
        );
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
    throw keyFail('ERR_CRYPTO_INVALID_KEY_TYPE', 'Unknown key type: ' + String(type));
}

/** The kind of a key from the algorithm OID in its SPKI or PKCS#8 header. */
function kindFromOid(oid: string): { kind: KeyKind; curve?: EcCurve } {
    for (const name of Object.keys(EDWARDS)) {
        if (EDWARDS[name].oid === oid) return { kind: EDWARDS[name].kind };
    }
    for (const name of Object.keys(EC_CURVES)) {
        if (EC_CURVES[name].oid === oid) return { kind: 'ec', curve: EC_CURVES[name] };
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

/** Pulls an AlgorithmIdentifier apart into the algorithm OID and, for EC, the curve OID. */
function algorithmOf(node: DerNode): { kind: KeyKind; curve?: EcCurve } {
    const [oidNode, params] = node.children;
    if (oidNode === undefined || oidNode.tag !== DER_OID) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid key: no algorithm identifier');
    const algorithm = oidOf(oidNode);
    if (algorithm === EC_PUBLIC_KEY_OID) {
        if (params === undefined || params.tag !== DER_OID) throw keyFail('ERR_CRYPTO_INVALID_KEYPAIR', 'Invalid EC key: no curve');
        return { kind: 'ec', curve: curveForOid(oidOf(params)) };
    }
    return kindFromOid(algorithm);
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

function signWith(key: KeyRecord, algorithm: unknown, data: Uint8Array): Uint8Array {
    if (key.type !== 'private') throw keyFail('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', 'Invalid key object type public, expected private.');
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
    return signed.toBytes('der');
}

function verifyWith(key: KeyRecord, algorithm: unknown, data: Uint8Array, signature: Uint8Array): boolean {
    if (key.type !== 'public' && key.type !== 'private') return false;
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
        /* Node accepts a high-S signature, so verification must too; signing still emits a low one. */
        return curve.curve.verify(signature, digest, key.publicBytes as Uint8Array, { lowS: false, prehash: false });
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
    const rounds = bits >= 1024 ? 4 : 8;
    for (let attempt = 0; attempt < 100000; attempt++) {
        const candidate = bigOf(randomOf(Math.ceil(bits / 8)));
        const trimmed = (candidate % (1n << BigInt(bits - 1))) | (1n << BigInt(bits - 1)) | 1n;
        if (isProbablePrime(trimmed, rounds)) return trimmed;
    }
    throw dhFail('ERR_CRYPTO_INVALID_STATE', 'Could not find a prime of ' + bits + ' bits');
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
        const N = args?.N === undefined ? 16384 : Number(args?.N);
        const r = args?.r === undefined ? 8 : Number(args?.r);
        const p = args?.p === undefined ? 1 : Number(args?.p);
        const maxmem = args?.maxmem === undefined ? 32 * 1024 * 1024 : Number(args?.maxmem);
        /*
         * Node rejects a parameter set before it derives anything: N must be a power of two above
         * one, r and p must be positive, and the whole 128*N*r working set must fit in maxmem.
         */
        if (!(N > 1) || (N & (N - 1)) !== 0 || !(r > 0) || !(p > 0) || 128 * N * r > maxmem) {
            throw Object.assign(new Error('Invalid scrypt params'), { code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' });
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
    /** Args {}: the cipher names createCipheriv and createDecipheriv accept. */
    'crypto.ciphers': () => Object.keys(CIPHER_SPECS),
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
        return {
            type: key.type,
            asymmetricKeyType: key.kind === 'ec' ? 'ec' : key.kind,
            asymmetricKeyDetails: key.kind === 'ec' ? { namedCurve: (key.curve as EcCurve).node } : {}
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
        const kind = String(args?.type ?? (want === 'private' ? 'pkcs8' : 'spki')).toLowerCase();
        /* A PEM body is base64 text inside BEGIN/END lines; DER is the raw bytes. */
        const text = new TextDecoder().decode(bytes);
        if (kind === 'spki') return { id: storeKey(importSpki(text.includes('-----BEGIN') ? pemDecode(text, 'PUBLIC KEY') : bytes)) };
        if (kind === 'pkcs8') return { id: storeKey(importPkcs8(text.includes('-----BEGIN') ? pemDecode(text, 'PRIVATE KEY') : bytes)) };
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
    /** Args {id, algorithm, data}: the signature of a digest or message; returns base64. */
    'crypto.key.sign': (args) => bytesToBase64(signWith(keyFor(args?.id, 'key.sign'), args?.algorithm, bytesArg(args?.data))),
    /** Args {id, algorithm, data, signature}: whether the signature checks out. */
    'crypto.key.verify': (args) => verifyWith(keyFor(args?.id, 'key.verify'), args?.algorithm, bytesArg(args?.data), bytesArg(args?.signature)),

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
    'crypto.dh.compute': (args) => {
        const prime = bigOf(bytesArg(args?.prime));
        const priv = bigOf(bytesArg(args?.private));
        const pub = bigOf(bytesArg(args?.public));
        const size = Math.ceil(prime.toString(16).length / 2);
        return bytesToBase64(bytesOf(modPow(pub, priv, prime), size));
    },
};
