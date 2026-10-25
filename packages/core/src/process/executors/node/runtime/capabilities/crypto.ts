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
    /*
     * The hyphenated and 'sha2-' spellings OpenSSL's own name table answers. They are absent from
     * getHashes(), which lists canonical names only, but a createHash, an hmac, an hkdf and a
     * sign all reach the digest through this table and so accept them.
     */
    'sha-1': 'sha1',
    'sha-224': 'sha224',
    'sha-256': 'sha256',
    'sha-384': 'sha384',
    'sha-512': 'sha512',
    'sha-512/224': 'sha512-224',
    'sha-512/256': 'sha512-256',
    'sha2-224': 'sha224',
    'sha2-256': 'sha256',
    'sha2-384': 'sha384',
    'sha2-512': 'sha512',
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

/**
 * The digest an hkdf call names. Node's hkdf resolves the name through the same table a createHash
 * does -- 'sha-256' derives exactly what 'sha256' does -- but it reports an unresolvable one as
 * ERR_CRYPTO_INVALID_DIGEST naming the value, where a createHash of that name answers the bare
 * 'Digest method not supported'.
 */
function hkdfDigestFor(name: unknown): DigestSpec {
    const key = String(name ?? '').toLowerCase();
    const spec = DIGEST_SPECS[DIGEST_ALIASES[key] ?? key];
    if (spec === undefined) {
        throw keyFail('ERR_CRYPTO_INVALID_DIGEST', 'Invalid digest: ' + String(name ?? ''), 'TypeError');
    }
    return spec;
}

/** The output length a digest() call produces: the XOF's option, or the digest's own. */
function outputLengthFor(spec: DigestSpec, requested: unknown): number {
    if (requested === undefined || requested === null) return spec.out;
    /*
     * An outputLength handed to a digest that is not an XOF is simply ignored: the option is the
     * XOF's alone, so createHash('sha512', { outputLength: 64 }) answers the ordinary 64-byte
     * digest rather than the 'not XOF or invalid length' refusal OpenSSL's getter would give.
     */
    if (!spec.xof) return spec.out;
    const n = Number(requested);
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
    | 'ocb'
    | 'cmswrap';

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
    /** The block cipher behind the name, where it is not the AES @noble carries: 'des2' and
     *  'des3' are DES's two-key and three-key ladders, and the rest name their own cipher. */
    primitive?: string;
    /** 8 for the DES ladders, whose block is half AES's; 16 for everything else. */
    blockBytes?: number;
}

/**
 * The names OpenSSL's object database still resolves but its default provider refuses: BF, DES,
 * SEED, IDEA, RC2, RC4, CAST5 and DESX. Node answers one of these with OpenSSL's own message
 * rather than 'Unknown cipher', and getCipherInfo still describes it, so both are carried here.
 */
const LEGACY_CIPHER_INFO: Record<string, [number, string, string, number, number, number]> = {
    'bf-cbc': [91, 'cbc', 'bf-cbc', 8, 8, 16],
    'bf-cfb': [93, 'cfb', 'bf-cfb', 1, 8, 16],
    'bf-ecb': [92, 'ecb', 'bf-ecb', 8, 0, 16],
    'bf-ofb': [94, 'ofb', 'bf-ofb', 1, 8, 16],
    'cast5-cbc': [108, 'cbc', 'cast5-cbc', 8, 8, 16],
    'cast5-cfb': [110, 'cfb', 'cast5-cfb', 1, 8, 16],
    'cast5-ecb': [109, 'ecb', 'cast5-ecb', 8, 0, 16],
    'cast5-ofb': [111, 'ofb', 'cast5-ofb', 1, 8, 16],
    'des-cbc': [31, 'cbc', 'des-cbc', 8, 8, 8],
    'des-cfb': [30, 'cfb', 'des-cfb', 1, 8, 8],
    'des-cfb1': [656, 'cfb', 'des-cfb1', 1, 8, 8],
    'des-cfb8': [657, 'cfb', 'des-cfb8', 1, 8, 8],
    'des-ecb': [29, 'ecb', 'des-ecb', 8, 0, 8],
    'des-ofb': [45, 'ofb', 'des-ofb', 1, 8, 8],
    'desx-cbc': [80, 'cbc', 'desx-cbc', 8, 8, 24],
    'idea-cbc': [34, 'cbc', 'idea-cbc', 8, 8, 16],
    'idea-cfb': [35, 'cfb', 'idea-cfb', 1, 8, 16],
    'idea-ecb': [36, 'ecb', 'idea-ecb', 8, 0, 16],
    'idea-ofb': [46, 'ofb', 'idea-ofb', 1, 8, 16],
    'rc2-40-cbc': [98, 'cbc', 'rc2-40-cbc', 8, 8, 5],
    'rc2-64-cbc': [166, 'cbc', 'rc2-64-cbc', 8, 8, 8],
    'rc2-cbc': [37, 'cbc', 'rc2-cbc', 8, 8, 16],
    'rc2-cfb': [39, 'cfb', 'rc2-cfb', 1, 8, 16],
    'rc2-ecb': [38, 'ecb', 'rc2-ecb', 8, 0, 16],
    'rc2-ofb': [40, 'ofb', 'rc2-ofb', 1, 8, 16],
    'rc4': [5, 'stream', 'rc4', 0, 0, 16],
    'rc4-40': [97, 'stream', 'rc4-40', 0, 0, 5],
    'rc4-hmac-md5': [915, 'stream', 'rc4-hmac-md5', 0, 0, 16],
    'seed-cbc': [777, 'cbc', 'seed-cbc', 16, 16, 16],
    'seed-cfb': [779, 'cfb', 'seed-cfb', 1, 16, 16],
    'seed-ecb': [776, 'ecb', 'seed-ecb', 16, 0, 16],
    'seed-ofb': [778, 'ofb', 'seed-ofb', 1, 16, 16],
};

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

/* Node's OpenSSL carries four block ciphers AES is not: DES in its two-key and three-key
   ladders (des-ede, des-ede3), ARIA, SM4 and Camellia. Each is registered in every mode Node
   answers for it, with the block width OpenSSL pads to and the primitive that runs it. */
    addCipher('aria-128-cbc', { mode: 'cbc', keyLength: 16, blockSize: 16, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-128-ccm', { mode: 'ccm', keyLength: 16, blockSize: 1, ivLength: -2, ivMin: 7, ivMax: 13, needsAuthTagLength: true, aead: true, primitive: 'aria' });
    addCipher('aria-128-cfb', { mode: 'cfb', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-128-cfb1', { mode: 'cfb1', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-128-cfb8', { mode: 'cfb8', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-128-ctr', { mode: 'ctr', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-128-ecb', { mode: 'ecb', keyLength: 16, blockSize: 16, ivLength: 0, aead: false, primitive: 'aria' });
    addCipher('aria-128-gcm', { mode: 'gcm', keyLength: 16, blockSize: 1, ivLength: 12, aead: true, primitive: 'aria' });
    addCipher('aria-128-ofb', { mode: 'ofb', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-192-cbc', { mode: 'cbc', keyLength: 24, blockSize: 16, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-192-ccm', { mode: 'ccm', keyLength: 24, blockSize: 1, ivLength: -2, ivMin: 7, ivMax: 13, needsAuthTagLength: true, aead: true, primitive: 'aria' });
    addCipher('aria-192-cfb', { mode: 'cfb', keyLength: 24, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-192-cfb1', { mode: 'cfb1', keyLength: 24, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-192-cfb8', { mode: 'cfb8', keyLength: 24, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-192-ctr', { mode: 'ctr', keyLength: 24, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-192-ecb', { mode: 'ecb', keyLength: 24, blockSize: 16, ivLength: 0, aead: false, primitive: 'aria' });
    addCipher('aria-192-gcm', { mode: 'gcm', keyLength: 24, blockSize: 1, ivLength: 12, aead: true, primitive: 'aria' });
    addCipher('aria-192-ofb', { mode: 'ofb', keyLength: 24, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-256-cbc', { mode: 'cbc', keyLength: 32, blockSize: 16, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-256-ccm', { mode: 'ccm', keyLength: 32, blockSize: 1, ivLength: -2, ivMin: 7, ivMax: 13, needsAuthTagLength: true, aead: true, primitive: 'aria' });
    addCipher('aria-256-cfb', { mode: 'cfb', keyLength: 32, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-256-cfb1', { mode: 'cfb1', keyLength: 32, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-256-cfb8', { mode: 'cfb8', keyLength: 32, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-256-ctr', { mode: 'ctr', keyLength: 32, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria-256-ecb', { mode: 'ecb', keyLength: 32, blockSize: 16, ivLength: 0, aead: false, primitive: 'aria' });
    addCipher('aria-256-gcm', { mode: 'gcm', keyLength: 32, blockSize: 1, ivLength: 12, aead: true, primitive: 'aria' });
    addCipher('aria-256-ofb', { mode: 'ofb', keyLength: 32, blockSize: 1, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria128', { mode: 'cbc', keyLength: 16, blockSize: 16, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria192', { mode: 'cbc', keyLength: 24, blockSize: 16, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('aria256', { mode: 'cbc', keyLength: 32, blockSize: 16, ivLength: 16, aead: false, primitive: 'aria' });
    addCipher('camellia-128-cbc', { mode: 'cbc', keyLength: 16, blockSize: 16, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-128-cfb', { mode: 'cfb', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-128-cfb1', { mode: 'cfb1', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-128-cfb8', { mode: 'cfb8', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-128-ctr', { mode: 'ctr', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-128-ecb', { mode: 'ecb', keyLength: 16, blockSize: 16, ivLength: 0, aead: false, primitive: 'camellia' });
    addCipher('camellia-128-ofb', { mode: 'ofb', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-192-cbc', { mode: 'cbc', keyLength: 24, blockSize: 16, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-192-cfb', { mode: 'cfb', keyLength: 24, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-192-cfb1', { mode: 'cfb1', keyLength: 24, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-192-cfb8', { mode: 'cfb8', keyLength: 24, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-192-ctr', { mode: 'ctr', keyLength: 24, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-192-ecb', { mode: 'ecb', keyLength: 24, blockSize: 16, ivLength: 0, aead: false, primitive: 'camellia' });
    addCipher('camellia-192-ofb', { mode: 'ofb', keyLength: 24, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-256-cbc', { mode: 'cbc', keyLength: 32, blockSize: 16, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-256-cfb', { mode: 'cfb', keyLength: 32, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-256-cfb1', { mode: 'cfb1', keyLength: 32, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-256-cfb8', { mode: 'cfb8', keyLength: 32, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-256-ctr', { mode: 'ctr', keyLength: 32, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia-256-ecb', { mode: 'ecb', keyLength: 32, blockSize: 16, ivLength: 0, aead: false, primitive: 'camellia' });
    addCipher('camellia-256-ofb', { mode: 'ofb', keyLength: 32, blockSize: 1, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia128', { mode: 'cbc', keyLength: 16, blockSize: 16, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia192', { mode: 'cbc', keyLength: 24, blockSize: 16, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('camellia256', { mode: 'cbc', keyLength: 32, blockSize: 16, ivLength: 16, aead: false, primitive: 'camellia' });
    addCipher('des-ede', { mode: 'ecb', keyLength: 16, blockSize: 8, ivLength: 0, blockBytes: 8, aead: false, primitive: 'des2' });
    addCipher('des-ede-cbc', { mode: 'cbc', keyLength: 16, blockSize: 8, ivLength: 8, blockBytes: 8, aead: false, primitive: 'des2' });
    addCipher('des-ede-cfb', { mode: 'cfb', keyLength: 16, blockSize: 1, ivLength: 8, blockBytes: 8, aead: false, primitive: 'des2' });
    addCipher('des-ede-ecb', { mode: 'ecb', keyLength: 16, blockSize: 8, ivLength: 0, blockBytes: 8, aead: false, primitive: 'des2' });
    addCipher('des-ede-ofb', { mode: 'ofb', keyLength: 16, blockSize: 1, ivLength: 8, blockBytes: 8, aead: false, primitive: 'des2' });
    addCipher('des-ede3', { mode: 'ecb', keyLength: 24, blockSize: 8, ivLength: 0, blockBytes: 8, aead: false, primitive: 'des3' });
    addCipher('des-ede3-cbc', { mode: 'cbc', keyLength: 24, blockSize: 8, ivLength: 8, blockBytes: 8, aead: false, primitive: 'des3' });
    addCipher('des-ede3-cfb', { mode: 'cfb', keyLength: 24, blockSize: 1, ivLength: 8, blockBytes: 8, aead: false, primitive: 'des3' });
    addCipher('des-ede3-cfb1', { mode: 'cfb1', keyLength: 24, blockSize: 1, ivLength: 8, blockBytes: 8, aead: false, primitive: 'des3' });
    addCipher('des-ede3-cfb8', { mode: 'cfb8', keyLength: 24, blockSize: 1, ivLength: 8, blockBytes: 8, aead: false, primitive: 'des3' });
    addCipher('des-ede3-ecb', { mode: 'ecb', keyLength: 24, blockSize: 8, ivLength: 0, blockBytes: 8, aead: false, primitive: 'des3' });
    addCipher('des-ede3-ofb', { mode: 'ofb', keyLength: 24, blockSize: 1, ivLength: 8, blockBytes: 8, aead: false, primitive: 'des3' });
    addCipher('des3', { mode: 'cbc', keyLength: 24, blockSize: 8, ivLength: 8, blockBytes: 8, aead: false, primitive: 'des3' });
    addCipher('des3-wrap', { mode: 'cmswrap', keyLength: 24, blockSize: 1, ivLength: 0, blockBytes: 8, aead: false, primitive: 'des3' });
    addCipher('id-smime-alg-CMS3DESwrap', { mode: 'cmswrap', keyLength: 24, blockSize: 1, ivLength: 0, blockBytes: 8, aead: false, primitive: 'des3' });
    addCipher('sm4', { mode: 'cbc', keyLength: 16, blockSize: 16, ivLength: 16, aead: false, primitive: 'sm4' });
    addCipher('sm4-cbc', { mode: 'cbc', keyLength: 16, blockSize: 16, ivLength: 16, aead: false, primitive: 'sm4' });
    addCipher('sm4-cfb', { mode: 'cfb', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'sm4' });
    addCipher('sm4-ctr', { mode: 'ctr', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'sm4' });
    addCipher('sm4-ecb', { mode: 'ecb', keyLength: 16, blockSize: 16, ivLength: 0, aead: false, primitive: 'sm4' });
    addCipher('sm4-ofb', { mode: 'ofb', keyLength: 16, blockSize: 1, ivLength: 16, aead: false, primitive: 'sm4' });

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
    'aria-128-cbc': [1066, 'cbc', 'aria-128-cbc', 16, 16],
    'aria-128-ccm': [1120, 'ccm', 'aria-128-ccm', 1, 12],
    'aria-128-cfb': [1067, 'cfb', 'aria-128-cfb', 1, 16],
    'aria-128-cfb1': [1080, 'cfb', 'aria-128-cfb1', 1, 16],
    'aria-128-cfb8': [1083, 'cfb', 'aria-128-cfb8', 1, 16],
    'aria-128-ctr': [1069, 'ctr', 'aria-128-ctr', 1, 16],
    'aria-128-ecb': [1065, 'ecb', 'aria-128-ecb', 16, 0],
    'aria-128-gcm': [1123, 'gcm', 'aria-128-gcm', 1, 12],
    'aria-128-ofb': [1068, 'ofb', 'aria-128-ofb', 1, 16],
    'aria-192-cbc': [1071, 'cbc', 'aria-192-cbc', 16, 16],
    'aria-192-ccm': [1121, 'ccm', 'aria-192-ccm', 1, 12],
    'aria-192-cfb': [1072, 'cfb', 'aria-192-cfb', 1, 16],
    'aria-192-cfb1': [1081, 'cfb', 'aria-192-cfb1', 1, 16],
    'aria-192-cfb8': [1084, 'cfb', 'aria-192-cfb8', 1, 16],
    'aria-192-ctr': [1074, 'ctr', 'aria-192-ctr', 1, 16],
    'aria-192-ecb': [1070, 'ecb', 'aria-192-ecb', 16, 0],
    'aria-192-gcm': [1124, 'gcm', 'aria-192-gcm', 1, 12],
    'aria-192-ofb': [1073, 'ofb', 'aria-192-ofb', 1, 16],
    'aria-256-cbc': [1076, 'cbc', 'aria-256-cbc', 16, 16],
    'aria-256-ccm': [1122, 'ccm', 'aria-256-ccm', 1, 12],
    'aria-256-cfb': [1077, 'cfb', 'aria-256-cfb', 1, 16],
    'aria-256-cfb1': [1082, 'cfb', 'aria-256-cfb1', 1, 16],
    'aria-256-cfb8': [1085, 'cfb', 'aria-256-cfb8', 1, 16],
    'aria-256-ctr': [1079, 'ctr', 'aria-256-ctr', 1, 16],
    'aria-256-ecb': [1075, 'ecb', 'aria-256-ecb', 16, 0],
    'aria-256-gcm': [1125, 'gcm', 'aria-256-gcm', 1, 12],
    'aria-256-ofb': [1078, 'ofb', 'aria-256-ofb', 1, 16],
    'aria128': [1066, 'cbc', 'aria-128-cbc', 16, 16],
    'aria192': [1071, 'cbc', 'aria-192-cbc', 16, 16],
    'aria256': [1076, 'cbc', 'aria-256-cbc', 16, 16],
    'camellia-128-cbc': [751, 'cbc', 'camellia-128-cbc', 16, 16],
    'camellia-128-cfb': [757, 'cfb', 'camellia-128-cfb', 1, 16],
    'camellia-128-cfb1': [760, 'cfb', 'camellia-128-cfb1', 1, 16],
    'camellia-128-cfb8': [763, 'cfb', 'camellia-128-cfb8', 1, 16],
    'camellia-128-ctr': [963, 'ctr', 'camellia-128-ctr', 1, 16],
    'camellia-128-ecb': [754, 'ecb', 'camellia-128-ecb', 16, 0],
    'camellia-128-ofb': [766, 'ofb', 'camellia-128-ofb', 1, 16],
    'camellia-192-cbc': [752, 'cbc', 'camellia-192-cbc', 16, 16],
    'camellia-192-cfb': [758, 'cfb', 'camellia-192-cfb', 1, 16],
    'camellia-192-cfb1': [761, 'cfb', 'camellia-192-cfb1', 1, 16],
    'camellia-192-cfb8': [764, 'cfb', 'camellia-192-cfb8', 1, 16],
    'camellia-192-ctr': [967, 'ctr', 'camellia-192-ctr', 1, 16],
    'camellia-192-ecb': [755, 'ecb', 'camellia-192-ecb', 16, 0],
    'camellia-192-ofb': [767, 'ofb', 'camellia-192-ofb', 1, 16],
    'camellia-256-cbc': [753, 'cbc', 'camellia-256-cbc', 16, 16],
    'camellia-256-cfb': [759, 'cfb', 'camellia-256-cfb', 1, 16],
    'camellia-256-cfb1': [762, 'cfb', 'camellia-256-cfb1', 1, 16],
    'camellia-256-cfb8': [765, 'cfb', 'camellia-256-cfb8', 1, 16],
    'camellia-256-ctr': [971, 'ctr', 'camellia-256-ctr', 1, 16],
    'camellia-256-ecb': [756, 'ecb', 'camellia-256-ecb', 16, 0],
    'camellia-256-ofb': [768, 'ofb', 'camellia-256-ofb', 1, 16],
    'camellia128': [751, 'cbc', 'camellia-128-cbc', 16, 16],
    'camellia192': [752, 'cbc', 'camellia-192-cbc', 16, 16],
    'camellia256': [753, 'cbc', 'camellia-256-cbc', 16, 16],
    'des-ede': [32, 'ecb', 'des-ede', 8, 0],
    'des-ede-cbc': [43, 'cbc', 'des-ede-cbc', 8, 8],
    'des-ede-cfb': [60, 'cfb', 'des-ede-cfb', 1, 8],
    'des-ede-ecb': [32, 'ecb', 'des-ede', 8, 0],
    'des-ede-ofb': [62, 'ofb', 'des-ede-ofb', 1, 8],
    'des-ede3': [33, 'ecb', 'des-ede3', 8, 0],
    'des-ede3-cbc': [44, 'cbc', 'des-ede3-cbc', 8, 8],
    'des-ede3-cfb': [61, 'cfb', 'des-ede3-cfb', 1, 8],
    'des-ede3-cfb1': [658, 'cfb', 'des-ede3-cfb1', 1, 8],
    'des-ede3-cfb8': [659, 'cfb', 'des-ede3-cfb8', 1, 8],
    'des-ede3-ecb': [33, 'ecb', 'des-ede3', 8, 0],
    'des-ede3-ofb': [63, 'ofb', 'des-ede3-ofb', 1, 8],
    'des3': [44, 'cbc', 'des-ede3-cbc', 8, 8],
    'des3-wrap': [246, 'wrap', 'id-smime-alg-cms3deswrap', 8, 0],
    'id-smime-alg-cms3deswrap': [246, 'wrap', 'id-smime-alg-cms3deswrap', 8, 0],
    'sm4': [1134, 'cbc', 'sm4-cbc', 16, 16],
    'sm4-cbc': [1134, 'cbc', 'sm4-cbc', 16, 16],
    'sm4-cfb': [1137, 'cfb', 'sm4-cfb', 1, 16],
    'sm4-ctr': [1139, 'ctr', 'sm4-ctr', 1, 16],
    'sm4-ecb': [1133, 'ecb', 'sm4-ecb', 16, 0],
    'sm4-ofb': [1135, 'ofb', 'sm4-ofb', 1, 16],
    'chacha20': [1019, 'stream', 'chacha20', 0, 16],
    'chacha20-poly1305': [1018, 'stream', 'chacha20-poly1305', 0, 12]
};

/** SM4's S-box (GB/T 32907), as OpenSSL carries it. */
const SM4_S = new Uint8Array([
    0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2,
    0x28, 0xfb, 0x2c, 0x05, 0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3,
    0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99, 0x9c, 0x42, 0x50, 0xf4,
    0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62,
    0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa,
    0x75, 0x8f, 0x3f, 0xa6, 0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba,
    0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8, 0x68, 0x6b, 0x81, 0xb2,
    0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35,
    0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b,
    0x01, 0x21, 0x78, 0x87, 0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52,
    0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e, 0xea, 0xbf, 0x8a, 0xd2,
    0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1,
    0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30,
    0xf5, 0x8c, 0xb1, 0xe3, 0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60,
    0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f, 0xd5, 0xdb, 0x37, 0x45,
    0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51,
    0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41,
    0x1f, 0x10, 0x5a, 0xd8, 0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd,
    0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0, 0x89, 0x69, 0x97, 0x4a,
    0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84,
    0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e,
    0xd7, 0xcb, 0x39, 0x48,
]);
/** SM4's family key and the thirty-two round constants it xors into the schedule. */
const SM4_FK = new Uint32Array([
    0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc,
]);
const SM4_CK = new Uint32Array([
    0x00070e15, 0x1c232a31, 0x383f464d, 0x545b6269, 0x70777e85, 0x8c939aa1,
    0xa8afb6bd, 0xc4cbd2d9, 0xe0e7eef5, 0xfc030a11, 0x181f262d, 0x343b4249,
    0x50575e65, 0x6c737a81, 0x888f969d, 0xa4abb2b9, 0xc0c7ced5, 0xdce3eaf1,
    0xf8ff060d, 0x141b2229, 0x30373e45, 0x4c535a61, 0x686f767d, 0x848b9299,
    0xa0a7aeb5, 0xbcc3cad1, 0xd8dfe6ed, 0xf4fb0209, 0x10171e25, 0x2c333a41,
    0x484f565d, 0x646b7279,
]);
/** Camellia's first S-box (RFC 3657); the other three are rotations of it. */
const CAMELLIA_S1 = new Uint8Array([
    0x70, 0x82, 0x2c, 0xec, 0xb3, 0x27, 0xc0, 0xe5, 0xe4, 0x85, 0x57, 0x35,
    0xea, 0x0c, 0xae, 0x41, 0x23, 0xef, 0x6b, 0x93, 0x45, 0x19, 0xa5, 0x21,
    0xed, 0x0e, 0x4f, 0x4e, 0x1d, 0x65, 0x92, 0xbd, 0x86, 0xb8, 0xaf, 0x8f,
    0x7c, 0xeb, 0x1f, 0xce, 0x3e, 0x30, 0xdc, 0x5f, 0x5e, 0xc5, 0x0b, 0x1a,
    0xa6, 0xe1, 0x39, 0xca, 0xd5, 0x47, 0x5d, 0x3d, 0xd9, 0x01, 0x5a, 0xd6,
    0x51, 0x56, 0x6c, 0x4d, 0x8b, 0x0d, 0x9a, 0x66, 0xfb, 0xcc, 0xb0, 0x2d,
    0x74, 0x12, 0x2b, 0x20, 0xf0, 0xb1, 0x84, 0x99, 0xdf, 0x4c, 0xcb, 0xc2,
    0x34, 0x7e, 0x76, 0x05, 0x6d, 0xb7, 0xa9, 0x31, 0xd1, 0x17, 0x04, 0xd7,
    0x14, 0x58, 0x3a, 0x61, 0xde, 0x1b, 0x11, 0x1c, 0x32, 0x0f, 0x9c, 0x16,
    0x53, 0x18, 0xf2, 0x22, 0xfe, 0x44, 0xcf, 0xb2, 0xc3, 0xb5, 0x7a, 0x91,
    0x24, 0x08, 0xe8, 0xa8, 0x60, 0xfc, 0x69, 0x50, 0xaa, 0xd0, 0xa0, 0x7d,
    0xa1, 0x89, 0x62, 0x97, 0x54, 0x5b, 0x1e, 0x95, 0xe0, 0xff, 0x64, 0xd2,
    0x10, 0xc4, 0x00, 0x48, 0xa3, 0xf7, 0x75, 0xdb, 0x8a, 0x03, 0xe6, 0xda,
    0x09, 0x3f, 0xdd, 0x94, 0x87, 0x5c, 0x83, 0x02, 0xcd, 0x4a, 0x90, 0x33,
    0x73, 0x67, 0xf6, 0xf3, 0x9d, 0x7f, 0xbf, 0xe2, 0x52, 0x9b, 0xd8, 0x26,
    0xc8, 0x37, 0xc6, 0x3b, 0x81, 0x96, 0x6f, 0x4b, 0x13, 0xbe, 0x63, 0x2e,
    0xe9, 0x79, 0xa7, 0x8c, 0x9f, 0x6e, 0xbc, 0x8e, 0x29, 0xf5, 0xf9, 0xb6,
    0x2f, 0xfd, 0xb4, 0x59, 0x78, 0x98, 0x06, 0x6a, 0xe7, 0x46, 0x71, 0xba,
    0xd4, 0x25, 0xab, 0x42, 0x88, 0xa2, 0x8d, 0xfa, 0x72, 0x07, 0xb9, 0x55,
    0xf8, 0xee, 0xac, 0x0a, 0x36, 0x49, 0x2a, 0x68, 0x3c, 0x38, 0xf1, 0xa4,
    0x40, 0x28, 0xd3, 0x7b, 0xbb, 0xc9, 0x43, 0xc1, 0x15, 0xe3, 0xad, 0xf4,
    0x77, 0xc7, 0x80, 0x9e,
]);
/** ARIA's S-box 1 (RFC 5794): the first is AES's own. */
const ARIA_SB1 = new Uint8Array([
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b,
    0xfe, 0xd7, 0xab, 0x76, 0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0,
    0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0, 0xb7, 0xfd, 0x93, 0x26,
    0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2,
    0xeb, 0x27, 0xb2, 0x75, 0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0,
    0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84, 0x53, 0xd1, 0x00, 0xed,
    0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f,
    0x50, 0x3c, 0x9f, 0xa8, 0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5,
    0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2, 0xcd, 0x0c, 0x13, 0xec,
    0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14,
    0xde, 0x5e, 0x0b, 0xdb, 0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c,
    0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79, 0xe7, 0xc8, 0x37, 0x6d,
    0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f,
    0x4b, 0xbd, 0x8b, 0x8a, 0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e,
    0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e, 0xe1, 0xf8, 0x98, 0x11,
    0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f,
    0xb0, 0x54, 0xbb, 0x16,
]);
/** ARIA's S-box 2 (RFC 5794): the first is AES's own. */
const ARIA_SB2 = new Uint8Array([
    0xe2, 0x4e, 0x54, 0xfc, 0x94, 0xc2, 0x4a, 0xcc, 0x62, 0x0d, 0x6a, 0x46,
    0x3c, 0x4d, 0x8b, 0xd1, 0x5e, 0xfa, 0x64, 0xcb, 0xb4, 0x97, 0xbe, 0x2b,
    0xbc, 0x77, 0x2e, 0x03, 0xd3, 0x19, 0x59, 0xc1, 0x1d, 0x06, 0x41, 0x6b,
    0x55, 0xf0, 0x99, 0x69, 0xea, 0x9c, 0x18, 0xae, 0x63, 0xdf, 0xe7, 0xbb,
    0x00, 0x73, 0x66, 0xfb, 0x96, 0x4c, 0x85, 0xe4, 0x3a, 0x09, 0x45, 0xaa,
    0x0f, 0xee, 0x10, 0xeb, 0x2d, 0x7f, 0xf4, 0x29, 0xac, 0xcf, 0xad, 0x91,
    0x8d, 0x78, 0xc8, 0x95, 0xf9, 0x2f, 0xce, 0xcd, 0x08, 0x7a, 0x88, 0x38,
    0x5c, 0x83, 0x2a, 0x28, 0x47, 0xdb, 0xb8, 0xc7, 0x93, 0xa4, 0x12, 0x53,
    0xff, 0x87, 0x0e, 0x31, 0x36, 0x21, 0x58, 0x48, 0x01, 0x8e, 0x37, 0x74,
    0x32, 0xca, 0xe9, 0xb1, 0xb7, 0xab, 0x0c, 0xd7, 0xc4, 0x56, 0x42, 0x26,
    0x07, 0x98, 0x60, 0xd9, 0xb6, 0xb9, 0x11, 0x40, 0xec, 0x20, 0x8c, 0xbd,
    0xa0, 0xc9, 0x84, 0x04, 0x49, 0x23, 0xf1, 0x4f, 0x50, 0x1f, 0x13, 0xdc,
    0xd8, 0xc0, 0x9e, 0x57, 0xe3, 0xc3, 0x7b, 0x65, 0x3b, 0x02, 0x8f, 0x3e,
    0xe8, 0x25, 0x92, 0xe5, 0x15, 0xdd, 0xfd, 0x17, 0xa9, 0xbf, 0xd4, 0x9a,
    0x7e, 0xc5, 0x39, 0x67, 0xfe, 0x76, 0x9d, 0x43, 0xa7, 0xe1, 0xd0, 0xf5,
    0x68, 0xf2, 0x1b, 0x34, 0x70, 0x05, 0xa3, 0x8a, 0xd5, 0x79, 0x86, 0xa8,
    0x30, 0xc6, 0x51, 0x4b, 0x1e, 0xa6, 0x27, 0xf6, 0x35, 0xd2, 0x6e, 0x24,
    0x16, 0x82, 0x5f, 0xda, 0xe6, 0x75, 0xa2, 0xef, 0x2c, 0xb2, 0x1c, 0x9f,
    0x5d, 0x6f, 0x80, 0x0a, 0x72, 0x44, 0x9b, 0x6c, 0x90, 0x0b, 0x5b, 0x33,
    0x7d, 0x5a, 0x52, 0xf3, 0x61, 0xa1, 0xf7, 0xb0, 0xd6, 0x3f, 0x7c, 0x6d,
    0xed, 0x14, 0xe0, 0xa5, 0x3d, 0x22, 0xb3, 0xf8, 0x89, 0xde, 0x71, 0x1a,
    0xaf, 0xba, 0xb5, 0x81,
]);
/** ARIA's S-box 3 (RFC 5794): the first is AES's own. */
const ARIA_SB3 = new Uint8Array([
    0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e,
    0x81, 0xf3, 0xd7, 0xfb, 0x7c, 0xe3, 0x39, 0x82, 0x9b, 0x2f, 0xff, 0x87,
    0x34, 0x8e, 0x43, 0x44, 0xc4, 0xde, 0xe9, 0xcb, 0x54, 0x7b, 0x94, 0x32,
    0xa6, 0xc2, 0x23, 0x3d, 0xee, 0x4c, 0x95, 0x0b, 0x42, 0xfa, 0xc3, 0x4e,
    0x08, 0x2e, 0xa1, 0x66, 0x28, 0xd9, 0x24, 0xb2, 0x76, 0x5b, 0xa2, 0x49,
    0x6d, 0x8b, 0xd1, 0x25, 0x72, 0xf8, 0xf6, 0x64, 0x86, 0x68, 0x98, 0x16,
    0xd4, 0xa4, 0x5c, 0xcc, 0x5d, 0x65, 0xb6, 0x92, 0x6c, 0x70, 0x48, 0x50,
    0xfd, 0xed, 0xb9, 0xda, 0x5e, 0x15, 0x46, 0x57, 0xa7, 0x8d, 0x9d, 0x84,
    0x90, 0xd8, 0xab, 0x00, 0x8c, 0xbc, 0xd3, 0x0a, 0xf7, 0xe4, 0x58, 0x05,
    0xb8, 0xb3, 0x45, 0x06, 0xd0, 0x2c, 0x1e, 0x8f, 0xca, 0x3f, 0x0f, 0x02,
    0xc1, 0xaf, 0xbd, 0x03, 0x01, 0x13, 0x8a, 0x6b, 0x3a, 0x91, 0x11, 0x41,
    0x4f, 0x67, 0xdc, 0xea, 0x97, 0xf2, 0xcf, 0xce, 0xf0, 0xb4, 0xe6, 0x73,
    0x96, 0xac, 0x74, 0x22, 0xe7, 0xad, 0x35, 0x85, 0xe2, 0xf9, 0x37, 0xe8,
    0x1c, 0x75, 0xdf, 0x6e, 0x47, 0xf1, 0x1a, 0x71, 0x1d, 0x29, 0xc5, 0x89,
    0x6f, 0xb7, 0x62, 0x0e, 0xaa, 0x18, 0xbe, 0x1b, 0xfc, 0x56, 0x3e, 0x4b,
    0xc6, 0xd2, 0x79, 0x20, 0x9a, 0xdb, 0xc0, 0xfe, 0x78, 0xcd, 0x5a, 0xf4,
    0x1f, 0xdd, 0xa8, 0x33, 0x88, 0x07, 0xc7, 0x31, 0xb1, 0x12, 0x10, 0x59,
    0x27, 0x80, 0xec, 0x5f, 0x60, 0x51, 0x7f, 0xa9, 0x19, 0xb5, 0x4a, 0x0d,
    0x2d, 0xe5, 0x7a, 0x9f, 0x93, 0xc9, 0x9c, 0xef, 0xa0, 0xe0, 0x3b, 0x4d,
    0xae, 0x2a, 0xf5, 0xb0, 0xc8, 0xeb, 0xbb, 0x3c, 0x83, 0x53, 0x99, 0x61,
    0x17, 0x2b, 0x04, 0x7e, 0xba, 0x77, 0xd6, 0x26, 0xe1, 0x69, 0x14, 0x63,
    0x55, 0x21, 0x0c, 0x7d,
]);
/** ARIA's S-box 4 (RFC 5794): the first is AES's own. */
const ARIA_SB4 = new Uint8Array([
    0x30, 0x68, 0x99, 0x1b, 0x87, 0xb9, 0x21, 0x78, 0x50, 0x39, 0xdb, 0xe1,
    0x72, 0x09, 0x62, 0x3c, 0x3e, 0x7e, 0x5e, 0x8e, 0xf1, 0xa0, 0xcc, 0xa3,
    0x2a, 0x1d, 0xfb, 0xb6, 0xd6, 0x20, 0xc4, 0x8d, 0x81, 0x65, 0xf5, 0x89,
    0xcb, 0x9d, 0x77, 0xc6, 0x57, 0x43, 0x56, 0x17, 0xd4, 0x40, 0x1a, 0x4d,
    0xc0, 0x63, 0x6c, 0xe3, 0xb7, 0xc8, 0x64, 0x6a, 0x53, 0xaa, 0x38, 0x98,
    0x0c, 0xf4, 0x9b, 0xed, 0x7f, 0x22, 0x76, 0xaf, 0xdd, 0x3a, 0x0b, 0x58,
    0x67, 0x88, 0x06, 0xc3, 0x35, 0x0d, 0x01, 0x8b, 0x8c, 0xc2, 0xe6, 0x5f,
    0x02, 0x24, 0x75, 0x93, 0x66, 0x1e, 0xe5, 0xe2, 0x54, 0xd8, 0x10, 0xce,
    0x7a, 0xe8, 0x08, 0x2c, 0x12, 0x97, 0x32, 0xab, 0xb4, 0x27, 0x0a, 0x23,
    0xdf, 0xef, 0xca, 0xd9, 0xb8, 0xfa, 0xdc, 0x31, 0x6b, 0xd1, 0xad, 0x19,
    0x49, 0xbd, 0x51, 0x96, 0xee, 0xe4, 0xa8, 0x41, 0xda, 0xff, 0xcd, 0x55,
    0x86, 0x36, 0xbe, 0x61, 0x52, 0xf8, 0xbb, 0x0e, 0x82, 0x48, 0x69, 0x9a,
    0xe0, 0x47, 0x9e, 0x5c, 0x04, 0x4b, 0x34, 0x15, 0x79, 0x26, 0xa7, 0xde,
    0x29, 0xae, 0x92, 0xd7, 0x84, 0xe9, 0xd2, 0xba, 0x5d, 0xf3, 0xc5, 0xb0,
    0xbf, 0xa4, 0x3b, 0x71, 0x44, 0x46, 0x2b, 0xfc, 0xeb, 0x6f, 0xd5, 0xf6,
    0x14, 0xfe, 0x7c, 0x70, 0x5a, 0x7d, 0xfd, 0x2f, 0x18, 0x83, 0x16, 0xa5,
    0x91, 0x1f, 0x05, 0x95, 0x74, 0xa9, 0xc1, 0x5b, 0x4a, 0x85, 0x6d, 0x13,
    0x07, 0x4f, 0x4e, 0x45, 0xb2, 0x0f, 0xc9, 0x1c, 0xa6, 0xbc, 0xec, 0x73,
    0x90, 0x7b, 0xcf, 0x59, 0x8f, 0xa1, 0xf9, 0x2d, 0xf2, 0xb1, 0x00, 0x94,
    0x37, 0x9f, 0xd0, 0x2e, 0x9c, 0x6e, 0x28, 0x3f, 0x80, 0xf0, 0x3d, 0xd3,
    0x25, 0x8a, 0xb5, 0xe7, 0x42, 0xb3, 0xc7, 0xea, 0xf7, 0x4c, 0x11, 0x33,
    0x03, 0xa2, 0xac, 0x60,
]);
/** ARIA's key-schedule constant 1. */
const ARIA_C1 = new Uint8Array([
    0x51, 0x7c, 0xc1, 0xb7, 0x27, 0x22, 0x0a, 0x94, 0xfe, 0x13, 0xab, 0xe8,
    0xfa, 0x9a, 0x6e, 0xe0,
]);
/** ARIA's key-schedule constant 2. */
const ARIA_C2 = new Uint8Array([
    0x6d, 0xb1, 0x4a, 0xcc, 0x9e, 0x21, 0xc8, 0x20, 0xff, 0x28, 0xb1, 0xd5,
    0xef, 0x5d, 0xe2, 0xb0,
]);
/** ARIA's key-schedule constant 3. */
const ARIA_C3 = new Uint8Array([
    0xdb, 0x92, 0x37, 0x1d, 0x21, 0x26, 0xe9, 0x70, 0x03, 0x24, 0x97, 0x75,
    0x04, 0xe8, 0xc9, 0x0e,
]);

/* ---------------------------------------------------------------------------------------------
 * The block ciphers behind the names Node's OpenSSL answers that AES is not: DES in its two-key
 * and three-key ladders, ARIA, SM4 and Camellia. @noble carries AES alone, so these are written
 * here against FIPS 46-3, RFC 5794, GB/T 32907 and RFC 3657, and each one is witnessed against
 * host Node 24.15 over every mode it can be opened in.
 * ------------------------------------------------------------------------------------------ */

/** A block cipher's own encryption and decryption of one block, and the block's width in bytes. */
interface BlockPrimitive {
    size: number;
    encrypt(key: Uint8Array, block: Uint8Array): Uint8Array;
    decrypt(key: Uint8Array, block: Uint8Array): Uint8Array;
}

/** DES (FIPS 46-3): the initial and final permutations, the expansion, the P permutation, the two
 *  key permutations, the sixteen shifts, and the eight S-boxes. */
const DES_IP = new Uint8Array([
    58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
    62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
    57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
    61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7
]);
const DES_FP = new Uint8Array([
    40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
    38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
    36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
    34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25
]);
const DES_E = new Uint8Array([
    32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11,
    12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21,
    20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1
]);
const DES_P = new Uint8Array([
    16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
    2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25
]);
const DES_PC1 = new Uint8Array([
    57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
    10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
    63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
    14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4
]);
const DES_PC2 = new Uint8Array([
    14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
    23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
    41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
    44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32
]);
const DES_SHIFTS = new Uint8Array([1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]);
const DES_SBOX = [
    new Uint8Array([
        14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
        0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
        4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
        15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13
    ]),
    new Uint8Array([
        15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
        3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
        0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
        13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9
    ]),
    new Uint8Array([
        10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
        13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
        13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
        1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12
    ]),
    new Uint8Array([
        7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
        13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
        10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
        3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14
    ]),
    new Uint8Array([
        2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
        14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
        4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
        11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3
    ]),
    new Uint8Array([
        12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
        10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
        9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
        4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13
    ]),
    new Uint8Array([
        4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
        13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
        1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
        6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12
    ]),
    new Uint8Array([
        13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
        1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
        7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
        2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11
    ])
];

/** Bit `i` of a big-endian byte string, counted from the most significant bit of byte 0. */
function bitAt(bytes: Uint8Array, i: number): number {
    return (bytes[i >> 3] >> (7 - (i & 7))) & 1;
}

/** The bits of `table` read out of `bytes`: one output byte per eight bits, most significant first. */
function permuteBits(bytes: Uint8Array, table: Uint8Array): Uint8Array {
    const out = new Uint8Array(Math.ceil(table.length / 8));
    for (let i = 0; i < table.length; i++) out[i >> 3] |= bitAt(bytes, table[i] - 1) << (7 - (i & 7));
    return out;
}

/** DES's sixteen 48-bit round keys, in the order encryption walks them. */
function desRoundKeys(key: Uint8Array): Uint8Array[] {
    const cd = new Uint8Array(56);
    for (let i = 0; i < 56; i++) cd[i] = bitAt(key, DES_PC1[i] - 1);
    let c = cd.subarray(0, 28);
    let d = cd.subarray(28, 56);
    const keys: Uint8Array[] = [];
    for (let round = 0; round < 16; round++) {
        const shift = DES_SHIFTS[round];
        const nc = new Uint8Array(28);
        const nd = new Uint8Array(28);
        for (let i = 0; i < 28; i++) { nc[i] = c[(i + shift) % 28]; nd[i] = d[(i + shift) % 28]; }
        c = nc;
        d = nd;
        const k = new Uint8Array(48);
        for (let i = 0; i < 48; i++) k[i] = DES_PC2[i] - 1 < 28 ? c[DES_PC2[i] - 1] : d[DES_PC2[i] - 29];
        const packed = new Uint8Array(6);
        for (let i = 0; i < 48; i++) packed[i >> 3] |= k[i] << (7 - (i & 7));
        keys.push(packed);
    }
    return keys;
}

/** DES's F function: expand, xor the round key, eight S-boxes, then P. */
function desFeistel(r: Uint8Array, k: Uint8Array): Uint8Array {
    const expanded = new Uint8Array(48);
    for (let i = 0; i < 48; i++) expanded[i] = bitAt(r, DES_E[i] - 1);
    const keyed = new Uint8Array(48);
    for (let i = 0; i < 48; i++) keyed[i] = expanded[i] ^ ((k[i >> 3] >> (7 - (i & 7))) & 1);
    const substituted = new Uint8Array(32);
    for (let s = 0; s < 8; s++) {
        const row = keyed[s * 6] * 2 + keyed[s * 6 + 5];
        const col = keyed[s * 6 + 1] * 8 + keyed[s * 6 + 2] * 4 + keyed[s * 6 + 3] * 2 + keyed[s * 6 + 4];
        const value = DES_SBOX[s][row * 16 + col];
        for (let b = 0; b < 4; b++) substituted[s * 4 + b] = (value >> (3 - b)) & 1;
    }
    const out = new Uint8Array(4);
    for (let i = 0; i < 32; i++) out[i >> 3] |= substituted[DES_P[i] - 1] << (7 - (i & 7));
    return out;
}

/** One DES block. The key is eight bytes, of which the parity bits are ignored as OpenSSL ignores
 *  them, and the sixteen round keys are walked backwards to decrypt. */
function desBlock(key: Uint8Array, block: Uint8Array, direction: 'encrypt' | 'decrypt'): Uint8Array {
    const keys = desRoundKeys(key);
    const ip = permuteBits(block, DES_IP);
    let left = ip.subarray(0, 4);
    let right = ip.subarray(4, 8);
    for (let round = 0; round < 16; round++) {
        const k = keys[direction === 'encrypt' ? round : 15 - round];
        const f = desFeistel(right, k);
        const next = new Uint8Array(4);
        for (let i = 0; i < 4; i++) next[i] = left[i] ^ f[i];
        left = right;
        right = next;
    }
    return permuteBits(concatBytes(right, left), DES_FP);
}

/** DES's EDE ladders: three-key with K3 = K1 for the two-key spelling. Encrypt is E-D-E, so
 *  decrypt is the same three calls in the other order with the other operations. */
function desEdeBlock(key: Uint8Array, block: Uint8Array, direction: 'encrypt' | 'decrypt'): Uint8Array {
    const k1 = key.subarray(0, 8);
    const k2 = key.subarray(8, 16);
    const k3 = key.length >= 24 ? key.subarray(16, 24) : key.subarray(0, 8);
    if (direction === 'encrypt') {
        return desBlock(k3, desBlock(k2, desBlock(k1, block, 'encrypt'), 'decrypt'), 'encrypt');
    }
    return desBlock(k1, desBlock(k2, desBlock(k3, block, 'decrypt'), 'encrypt'), 'decrypt');
}

const rotl8 = (x: number, n: number): number => ((x << n) | (x >>> (8 - n))) & 0xff;

/* ------------------------------------------ ARIA (RFC 5794) ------------------------------------------ */

/** ARIA's diffusion layer: every output byte is the xor of seven input bytes. */
const ARIA_A: number[][] = [
    [3, 4, 6, 8, 9, 13, 14], [2, 5, 7, 8, 9, 12, 15], [1, 4, 6, 10, 11, 12, 15], [0, 5, 7, 10, 11, 13, 14],
    [0, 2, 5, 8, 11, 14, 15], [1, 3, 4, 9, 10, 14, 15], [0, 2, 7, 9, 10, 12, 13], [1, 3, 6, 8, 11, 12, 13],
    [0, 1, 4, 7, 10, 13, 15], [0, 1, 5, 6, 11, 12, 14], [2, 3, 5, 6, 8, 13, 15], [2, 3, 4, 7, 9, 12, 14],
    [1, 2, 6, 7, 9, 11, 12], [0, 3, 6, 7, 8, 10, 13], [0, 3, 4, 5, 9, 11, 14], [1, 2, 4, 5, 8, 10, 15]
];

function ariaA(out: Uint8Array, x: Uint8Array): void {
    for (let i = 0; i < 16; i++) {
        let v = 0;
        for (const j of ARIA_A[i]) v ^= x[j];
        out[i] = v;
    }
}

/** The odd and even substitution layers: each xors the round key in and then maps the bytes. */
function ariaSl1(out: Uint8Array, x: Uint8Array, rk: Uint8Array): void {
    for (let i = 0; i < 16; i += 4) {
        out[i] = ARIA_SB1[x[i] ^ rk[i]];
        out[i + 1] = ARIA_SB2[x[i + 1] ^ rk[i + 1]];
        out[i + 2] = ARIA_SB3[x[i + 2] ^ rk[i + 2]];
        out[i + 3] = ARIA_SB4[x[i + 3] ^ rk[i + 3]];
    }
}

function ariaSl2(out: Uint8Array, x: Uint8Array, rk: Uint8Array): void {
    for (let i = 0; i < 16; i += 4) {
        out[i] = ARIA_SB3[x[i] ^ rk[i]];
        out[i + 1] = ARIA_SB4[x[i + 1] ^ rk[i + 1]];
        out[i + 2] = ARIA_SB1[x[i + 2] ^ rk[i + 2]];
        out[i + 3] = ARIA_SB2[x[i + 3] ^ rk[i + 3]];
    }
}

function ariaFO(out: Uint8Array, d: Uint8Array, rk: Uint8Array): void {
    const y = new Uint8Array(16);
    ariaSl1(y, d, rk);
    ariaA(out, y);
}

function ariaFE(out: Uint8Array, d: Uint8Array, rk: Uint8Array): void {
    const y = new Uint8Array(16);
    ariaSl2(y, d, rk);
    ariaA(out, y);
}

/** A right rotation of a 128-bit value by `n` bits, xored with `with`, as OpenSSL's key schedule
 *  builds its round keys. */
function ariaRotate(out: Uint8Array, n: number, z: Uint8Array, withBytes: Uint8Array): void {
    const bytes = Math.floor(n / 8);
    const bits = n % 8;
    const t = new Uint8Array(16);
    for (let i = 0; i < 16; i++) t[(i + bytes) % 16] = z[i];
    for (let i = 0; i < 16; i++) {
        out[i] = (((t[i] >> bits) | ((t[i === 0 ? 15 : i - 1] << (8 - bits)) & 0xff)) & 0xff) ^ withBytes[i];
    }
}

/** ARIA's key schedule: twelve rounds for a 128-bit key, fourteen for 192 and sixteen for 256. */
function ariaSchedule(key: Uint8Array, direction: 'encrypt' | 'decrypt'): Uint8Array[] {
    const bits = key.length * 8;
    const rounds = bits === 128 ? 12 : bits === 192 ? 14 : 16;
    const ck1 = bits === 128 ? ARIA_C1 : bits === 192 ? ARIA_C2 : ARIA_C3;
    const ck2 = bits === 128 ? ARIA_C2 : bits === 192 ? ARIA_C3 : ARIA_C1;
    const ck3 = bits === 128 ? ARIA_C3 : bits === 192 ? ARIA_C1 : ARIA_C2;
    const kr = new Uint8Array(16);
    if (bits === 192) kr.set(key.subarray(16, 24), 0);
    else if (bits === 256) kr.set(key.subarray(16, 32), 0);
    const w0 = Uint8Array.from(key.subarray(0, 16));
    const w1 = new Uint8Array(16);
    const w2 = new Uint8Array(16);
    const w3 = new Uint8Array(16);
    const t = new Uint8Array(16);
    ariaFO(w3, w0, ck1);
    for (let i = 0; i < 16; i++) w1[i] = w3[i] ^ kr[i];
    ariaFE(w3, w1, ck2);
    for (let i = 0; i < 16; i++) w2[i] = w3[i] ^ w0[i];
    ariaFO(t, w2, ck3);
    for (let i = 0; i < 16; i++) w3[i] = t[i] ^ w1[i];
    const ek: Uint8Array[] = [];
    for (let i = 0; i < 17; i++) ek.push(new Uint8Array(16));
    /* OpenSSL's rotnr(o, xor, z) is o = rotr(z, n) xor xor: the value rotated is the second of the
       pair and the one xored in is the first, which is the order the schedule names them in. */
    ariaRotate(ek[0], 19, w1, w0);
    ariaRotate(ek[1], 19, w2, w1);
    ariaRotate(ek[2], 19, w3, w2);
    ariaRotate(ek[3], 19, w0, w3);
    ariaRotate(ek[4], 31, w1, w0);
    ariaRotate(ek[5], 31, w2, w1);
    ariaRotate(ek[6], 31, w3, w2);
    ariaRotate(ek[7], 31, w0, w3);
    ariaRotate(ek[8], 67, w1, w0);
    ariaRotate(ek[9], 67, w2, w1);
    ariaRotate(ek[10], 67, w3, w2);
    ariaRotate(ek[11], 67, w0, w3);
    ariaRotate(ek[12], 97, w1, w0);
    if (rounds > 12) {
        ariaRotate(ek[13], 97, w2, w1);
        ariaRotate(ek[14], 97, w3, w2);
        if (rounds > 14) {
            ariaRotate(ek[15], 97, w0, w3);
            ariaRotate(ek[16], 109, w1, w0);
        }
    }
    if (direction === 'encrypt') return ek;
    /* Decryption walks the same rounds backwards, with the diffusion layer over each inner key. */
    const dk: Uint8Array[] = [];
    for (let i = 0; i < 17; i++) dk.push(new Uint8Array(16));
    dk[0] = ek[rounds];
    for (let i = 1; i < rounds; i++) ariaA(dk[i], ek[rounds - i]);
    dk[rounds] = ek[0];
    return dk;
}

function ariaBlock(key: Uint8Array, block: Uint8Array, direction: 'encrypt' | 'decrypt'): Uint8Array {
    const rounds = key.length === 16 ? 12 : key.length === 24 ? 14 : 16;
    const keys = ariaSchedule(key, direction);
    const p = Uint8Array.from(block.subarray(0, 16));
    for (let i = 0; i < rounds - 2; i += 2) {
        ariaFO(p, p, keys[i]);
        ariaFE(p, p, keys[i + 1]);
    }
    ariaFO(p, p, keys[rounds - 2]);
    const out = new Uint8Array(16);
    ariaSl2(out, p, keys[rounds - 1]);
    for (let i = 0; i < 16; i++) out[i] ^= keys[rounds][i];
    return out;
}

/* ------------------------------------------ SM4 (GB/T 32907) ------------------------------------------ */

function readWord(bytes: Uint8Array, at: number): number {
    return ((bytes[at * 4] * 16777216) + (bytes[at * 4 + 1] << 16) + (bytes[at * 4 + 2] << 8) + bytes[at * 4 + 3]) >>> 0;
}

function writeWord(bytes: Uint8Array, at: number, value: number): void {
    bytes[at * 4] = (value >>> 24) & 0xff;
    bytes[at * 4 + 1] = (value >>> 16) & 0xff;
    bytes[at * 4 + 2] = (value >>> 8) & 0xff;
    bytes[at * 4 + 3] = value & 0xff;
}

const sm4Rotate = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;

/** tau and the two linear maps built on it: L for the rounds, L' for the schedule. */
function sm4Tau(x: number): number {
    return ((SM4_S[(x >>> 24) & 0xff] << 24) | (SM4_S[(x >>> 16) & 0xff] << 16) | (SM4_S[(x >>> 8) & 0xff] << 8) | SM4_S[x & 0xff]) >>> 0;
}

function sm4L(x: number): number {
    const b = sm4Tau(x);
    return (b ^ sm4Rotate(b, 2) ^ sm4Rotate(b, 10) ^ sm4Rotate(b, 18) ^ sm4Rotate(b, 24)) >>> 0;
}

function sm4LKey(x: number): number {
    const b = sm4Tau(x);
    return (b ^ sm4Rotate(b, 13) ^ sm4Rotate(b, 23)) >>> 0;
}

function sm4Block(key: Uint8Array, block: Uint8Array, direction: 'encrypt' | 'decrypt'): Uint8Array {
    const k = new Uint32Array(4);
    for (let i = 0; i < 4; i++) k[i] = readWord(key, i) ^ SM4_FK[i];
    const rk = new Uint32Array(32);
    for (let i = 0; i < 32; i++) {
        rk[i] = k[0] ^ sm4LKey(k[1] ^ k[2] ^ k[3] ^ SM4_CK[i]);
        k[0] = k[1];
        k[1] = k[2];
        k[2] = k[3];
        k[3] = rk[i];
    }
    const x = new Uint32Array(36);
    for (let i = 0; i < 4; i++) x[i] = readWord(block, i);
    for (let i = 0; i < 32; i++) {
        const roundKey = rk[direction === 'encrypt' ? i : 31 - i];
        x[i + 4] = (x[i] ^ sm4L(x[i + 1] ^ x[i + 2] ^ x[i + 3] ^ roundKey)) >>> 0;
    }
    const out = new Uint8Array(16);
    for (let i = 0; i < 4; i++) writeWord(out, i, x[35 - i]);
    return out;
}

/* ------------------------------------------ Camellia (RFC 3657) ------------------------------------------ */

const U64_MASK = (1n << 64n) - 1n;

function bytesToU64(bytes: Uint8Array, at: number): bigint {
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(bytes[at + i]);
    return v;
}

function u64ToBytes(value: bigint, out: Uint8Array, at: number): void {
    let v = value & U64_MASK;
    for (let i = 7; i >= 0; i--) {
        out[at + i] = Number(v & 0xffn);
        v >>= 8n;
    }
}

/** The eight masks the P function multiplies a substituted byte by; they are sparse enough that no
 *  carry ever crosses a byte, so the product is the byte broadcast across its lanes. */
const CAMELLIA_M = [
    0x0101010001000001n, 0x0001010101010000n, 0x0100010100010100n, 0x0101000100000101n,
    0x0001010100010101n, 0x0100010101000101n, 0x0101000101010001n, 0x0101010001010100n
];

/** Camellia's F function: the four S-boxes, the second and third of which are rotations of the
 *  first, and then P over the eight bytes they answer. */
function camelliaF(v: bigint, k: bigint): bigint {
    const x = (v ^ k) & U64_MASK;
    const b: number[] = [];
    for (let i = 0; i < 8; i++) b.push(Number((x >> BigInt(56 - 8 * i)) & 0xffn));
    const z = [
        CAMELLIA_S1[b[0]],
        rotl8(CAMELLIA_S1[b[1]], 1),
        rotl8(CAMELLIA_S1[b[2]], 7),
        CAMELLIA_S1[rotl8(b[3], 1)],
        rotl8(CAMELLIA_S1[b[4]], 1),
        rotl8(CAMELLIA_S1[b[5]], 7),
        CAMELLIA_S1[rotl8(b[6], 1)],
        CAMELLIA_S1[b[7]]
    ];
    let r = 0n;
    for (let i = 0; i < 8; i++) r = (r ^ (CAMELLIA_M[i] * BigInt(z[i]))) & U64_MASK;
    return r;
}

const rotl32 = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;

function camelliaFL(v: bigint, k: bigint): bigint {
    let x1 = Number((v >> 32n) & 0xffffffffn);
    let x2 = Number(v & 0xffffffffn);
    const k1 = Number((k >> 32n) & 0xffffffffn);
    const k2 = Number(k & 0xffffffffn);
    x2 = (x2 ^ rotl32(x1 & k1, 1)) >>> 0;
    x1 = (x1 ^ (x2 | k2)) >>> 0;
    return (BigInt(x1) << 32n) | BigInt(x2);
}

function camelliaFLInv(v: bigint, k: bigint): bigint {
    let x1 = Number((v >> 32n) & 0xffffffffn);
    let x2 = Number(v & 0xffffffffn);
    const k1 = Number((k >> 32n) & 0xffffffffn);
    const k2 = Number(k & 0xffffffffn);
    x1 = (x1 ^ (x2 | k2)) >>> 0;
    x2 = (x2 ^ rotl32(x1 & k1, 1)) >>> 0;
    return (BigInt(x1) << 32n) | BigInt(x2);
}

/** The high and low halves of a 128-bit value rotated left, as the key schedule names them. */
function rotate128(hi: bigint, lo: bigint, shift: number): [bigint, bigint] {
    const s = shift >= 64 ? shift - 64 : shift;
    return [
        ((hi << BigInt(s)) | (lo >> BigInt(64 - s))) & U64_MASK,
        ((hi >> BigInt(64 - s)) | (lo << BigInt(s))) & U64_MASK
    ];
}

/** Camellia's subkeys: KL and KR from the key, and KA and KB derived from them under the six
 *  sigma constants, then the rotations the rounds walk. */
function camelliaSchedule(key: Uint8Array): bigint[] {
    const klH = bytesToU64(key, 0);
    const klL = bytesToU64(key, 8);
    const krH = key.length >= 24 ? bytesToU64(key, 16) : 0n;
    const krL = key.length === 32 ? bytesToU64(key, 24) : key.length === 24 ? (~krH) & U64_MASK : 0n;
    const sigma = [0xA09E667F3BCC908Bn, 0xB67AE8584CAA73B2n, 0xC6EF372FE94F82BEn,
        0x54FF53A5F1D36F1Cn, 0x10E527FADE682D1Dn, 0xB05688C2B3E6C1FDn];
    let d1 = klH ^ krH;
    let d2 = klL ^ krL;
    d2 ^= camelliaF(d1, sigma[0]);
    d1 ^= camelliaF(d2, sigma[1]);
    d1 ^= klH;
    d2 ^= klL;
    d2 ^= camelliaF(d1, sigma[2]);
    d1 ^= camelliaF(d2, sigma[3]);
    const kaH = d1 & U64_MASK;
    const kaL = d2 & U64_MASK;
    d1 = kaH ^ krH;
    d2 = kaL ^ krL;
    d2 ^= camelliaF(d1, sigma[4]);
    d1 ^= camelliaF(d2, sigma[5]);
    const kbH = d1 & U64_MASK;
    const kbL = d2 & U64_MASK;
    const sk: bigint[] = [];
    const push = (h: bigint, l: bigint, shift: number, swapped: boolean): void => {
        const [hi, lo] = rotate128(h, l, shift);
        if (swapped) { sk.push(lo); sk.push(hi); } else { sk.push(hi); sk.push(lo); }
    };
    if (key.length === 16) {
        /* The 128-bit schedule is not a list of matched pairs: KA's 45-bit rotation is followed by
           KL's 60-bit low half, and everything from 77 bits on is written low half first. */
        const hi = (h: bigint, l: bigint, shift: number): bigint => rotate128(h, l, shift)[0];
        const lo = (h: bigint, l: bigint, shift: number): bigint => rotate128(h, l, shift)[1];
        sk.push(klH, klL, kaH, kaL,
            hi(klH, klL, 15), lo(klH, klL, 15),
            hi(kaH, kaL, 15), lo(kaH, kaL, 15),
            hi(kaH, kaL, 30), lo(kaH, kaL, 30),
            hi(klH, klL, 45), lo(klH, klL, 45),
            hi(kaH, kaL, 45), lo(klH, klL, 60),
            hi(kaH, kaL, 60), lo(kaH, kaL, 60),
            lo(klH, klL, 77), hi(klH, klL, 77),
            lo(klH, klL, 94), hi(klH, klL, 94),
            lo(kaH, kaL, 94), hi(kaH, kaL, 94),
            lo(klH, klL, 111), hi(klH, klL, 111),
            lo(kaH, kaL, 111), hi(kaH, kaL, 111));
    } else {
        sk.push(klH, klL, kbH, kbL);
        push(krH, krL, 15, false);
        push(kaH, kaL, 15, false);
        push(krH, krL, 30, false);
        push(kbH, kbL, 30, false);
        push(klH, klL, 45, false);
        push(kaH, kaL, 45, false);
        push(klH, klL, 60, false);
        push(krH, krL, 60, false);
        push(kbH, kbL, 60, false);
        push(klH, klL, 77, true);
        push(kaH, kaL, 77, true);
        push(krH, krL, 94, true);
        push(kaH, kaL, 94, true);
        push(klH, klL, 111, true);
        push(kbH, kbL, 111, true);
    }
    return sk;
}

function camelliaBlock(key: Uint8Array, block: Uint8Array, direction: 'encrypt' | 'decrypt'): Uint8Array {
    const sk = camelliaSchedule(key);
    const rounds = key.length === 16 ? 9 : 12;
    const out = new Uint8Array(16);
    let d1 = bytesToU64(block, 0);
    let d2 = bytesToU64(block, 8);
    if (direction === 'encrypt') {
        let at = 0;
        d1 ^= sk[at++];
        d2 ^= sk[at++];
        d2 ^= camelliaF(d1, sk[at++]);
        d1 ^= camelliaF(d2, sk[at++]);
        for (let r = 1; r !== rounds - 1; r++) {
            if (r % 3 === 0) {
                d1 = camelliaFL(d1, sk[at++]);
                d2 = camelliaFLInv(d2, sk[at++]);
            }
            d2 ^= camelliaF(d1, sk[at++]);
            d1 ^= camelliaF(d2, sk[at++]);
        }
        d2 ^= camelliaF(d1, sk[at++]);
        d1 ^= camelliaF(d2, sk[at++]);
        d2 ^= sk[at++];
        d1 ^= sk[at++];
    } else {
        let at = sk.length - 1;
        d2 ^= sk[at--];
        d1 ^= sk[at--];
        d2 ^= camelliaF(d1, sk[at--]);
        d1 ^= camelliaF(d2, sk[at--]);
        for (let r = 1; r !== rounds - 1; r++) {
            if (r % 3 === 0) {
                d1 = camelliaFL(d1, sk[at--]);
                d2 = camelliaFLInv(d2, sk[at--]);
            }
            d2 ^= camelliaF(d1, sk[at--]);
            d1 ^= camelliaF(d2, sk[at--]);
        }
        d2 ^= camelliaF(d1, sk[at--]);
        d1 ^= camelliaF(d2, sk[at--]);
        d1 ^= sk[at--];
        d2 ^= sk[at];
    }
    u64ToBytes(d2, out, 0);
    u64ToBytes(d1, out, 8);
    return out;
}

/* ---------------------------------------------------------------------------------------------- */

const AES_PRIMITIVE: BlockPrimitive = {
    /* 16 as a literal: BLOCK is declared below, and this one runs when the module loads. */
    size: 16,
    encrypt: (key, block) => ecb(key, { disablePadding: true }).encrypt(block),
    decrypt: (key, block) => ecb(key, { disablePadding: true }).decrypt(block)
};

const BLOCK_PRIMITIVES: Record<string, BlockPrimitive> = {
    des2: { size: 8, encrypt: (key, block) => desEdeBlock(key, block, 'encrypt'), decrypt: (key, block) => desEdeBlock(key, block, 'decrypt') },
    des3: { size: 8, encrypt: (key, block) => desEdeBlock(key, block, 'encrypt'), decrypt: (key, block) => desEdeBlock(key, block, 'decrypt') },
    aria: { size: 16, encrypt: (key, block) => ariaBlock(key, block, 'encrypt'), decrypt: (key, block) => ariaBlock(key, block, 'decrypt') },
    sm4: { size: 16, encrypt: (key, block) => sm4Block(key, block, 'encrypt'), decrypt: (key, block) => sm4Block(key, block, 'decrypt') },
    camellia: { size: 16, encrypt: (key, block) => camelliaBlock(key, block, 'encrypt'), decrypt: (key, block) => camelliaBlock(key, block, 'decrypt') }
};

function primitiveOf(spec: CipherSpec): BlockPrimitive {
    return spec.primitive === undefined ? AES_PRIMITIVE : BLOCK_PRIMITIVES[spec.primitive];
}

/** The width a cipher pads to: 8 for the DES ladders, 16 everywhere else. */
function blockBytesOf(spec: CipherSpec): number {
    return spec.blockBytes ?? BLOCK;
}

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
    if (entry === undefined || spec === undefined) {
        /* A legacy name answers what OpenSSL's object database says about it. */
        const legacy = LEGACY_CIPHER_INFO[key];
        if (legacy === undefined) return undefined;
        if (options !== undefined && options !== null) {
            if (options.keyLength !== undefined && options.keyLength !== null && Number(options.keyLength) !== legacy[5]) return undefined;
            if (options.ivLength !== undefined && options.ivLength !== null && Number(options.ivLength) !== legacy[4]) return undefined;
        }
        return cipherInfoFields(legacy[0], legacy[1], legacy[2], legacy[3], legacy[4], legacy[5]);
    }
    const keyLength = spec.keyLength;
    const ivLength = entry[4];
    if (options !== undefined && options !== null) {
        if (options.keyLength !== undefined && options.keyLength !== null && Number(options.keyLength) !== keyLength) return undefined;
        if (options.ivLength !== undefined && options.ivLength !== null && Number(options.ivLength) !== ivLength) return undefined;
    }
    /* The field order is the one host Node 24.15's JSON answers with. */
    return cipherInfoFields(entry[0], entry[1], entry[2], entry[3], ivLength, keyLength);
}

/** Node's answer as a caller reads it: a field is left out where OpenSSL carries none. */
function cipherInfoFields(nid: number, mode: string, name: string, blockSize: number, ivLength: number, keyLength: number)
    : Record<string, unknown> {
    const info: Record<string, unknown> = { mode, name, nid };
    if (blockSize !== 0) info.blockSize = blockSize;
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
    /** AEAD only: how many bytes of output earlier update() calls have already handed back, so
     *  each one emits just the bytes its own input produced, as an OpenSSL AEAD does. */
    aeadEmitted: number;
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
    /* DES, ARIA, SM4 and Camellia run their own modes here; AES keeps the @noble path below. */
    if (spec.primitive !== undefined) return genericBlocks(state, bytes);
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
    if (state.spec.primitive !== undefined) return genericBlocks(state, bytes);
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
function aesWrap(p: BlockPrimitive, key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
    const n = Math.floor(data.length / 8);
    let a = Uint8Array.from(iv);
    const blocks: Uint8Array[] = [];
    for (let i = 0; i < n; i++) blocks.push(data.subarray(i * 8, i * 8 + 8));
    for (let j = 0; j < 6; j++) {
        for (let i = 0; i < n; i++) {
            const b = p.encrypt(key, concatBytes(a, blocks[i]));
            a = xorInto(b.subarray(0, 8), wrapCounter(n * j + i + 1));
            blocks[i] = b.subarray(8);
        }
    }
    let out = Uint8Array.from(a);
    for (const block of blocks) out = concatBytes(out, block);
    return out;
}

/** The unwrapped bytes and the starting value they authenticate, which RFC 5649 keeps the length in. */
function aesUnwrap(p: BlockPrimitive, key: Uint8Array, data: Uint8Array): { a: Uint8Array; plain: Uint8Array } {
    const n = Math.floor(data.length / 8) - 1;
    let a = Uint8Array.from(data.subarray(0, 8));
    const blocks: Uint8Array[] = [];
    for (let i = 0; i < n; i++) blocks.push(data.subarray(8 + i * 8, 16 + i * 8));
    for (let j = 5; j >= 0; j--) {
        for (let i = n - 1; i >= 0; i--) {
            const b = p.decrypt(key, concatBytes(xorInto(a, wrapCounter(n * j + i + 1)), blocks[i]));
            a = b.subarray(0, 8);
            blocks[i] = b.subarray(8);
        }
    }
    let out = new Uint8Array(0);
    for (const block of blocks) out = concatBytes(out, block);
    return { a, plain: out };
}

/** RFC 5649: a four-byte alternative IV and the plaintext's own length ahead of the padded data. */
function aesWrapPad(p: BlockPrimitive, key: Uint8Array, aiv: Uint8Array, data: Uint8Array): Uint8Array {
    const padded = new Uint8Array(Math.max(8, Math.ceil(data.length / 8) * 8));
    padded.set(data, 0);
    const len = data.length;
    const a = concatBytes(aiv, new Uint8Array([(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]));
    if (padded.length === 8) return p.encrypt(key, concatBytes(a, padded));
    return aesWrap(p, key, a, padded);
}

/* The CMS 3DES key wrap (RFC 3217): an eight-byte integrity check value ahead of the content,
 * the whole sealed in CBC, and then the blocks written back to front with the IV the wrap started
 * from. OpenSSL draws that IV afresh for every call, so what a caller gets differs each time and
 * only the width is fixed: sixteen bytes more than went in. */

function cmsBlocks(data: Uint8Array): Uint8Array[] {
    const blocks: Uint8Array[] = [];
    for (let at = 0; at < data.length; at += 8) blocks.push(data.subarray(at, at + 8));
    return blocks;
}

function cmsReverse(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length);
    const blocks = cmsBlocks(data);
    for (let i = 0; i < blocks.length; i++) out.set(blocks[i], (blocks.length - 1 - i) * 8);
    return out;
}

function cmsCbc(state: CipherState, iv: Uint8Array, data: Uint8Array, decrypt: boolean): Uint8Array {
    const p = primitiveOf(state.spec);
    const block = (bytes: Uint8Array): Uint8Array => decrypt ? p.decrypt(state.key, bytes) : p.encrypt(state.key, bytes);
    const out = new Uint8Array(data.length);
    let chain = Uint8Array.from(iv);
    for (let at = 0; at < data.length; at += 8) {
        const source = data.subarray(at, at + 8);
        const opened = decrypt ? block(source) : block(xorInto(source, chain));
        for (let i = 0; i < 8; i++) out[at + i] = decrypt ? opened[i] ^ chain[i] : opened[i];
        chain = decrypt ? Uint8Array.from(source) : Uint8Array.from(out.subarray(at, at + 8));
    }
    return out;
}

function cmsWrap(state: CipherState, data: Uint8Array): Uint8Array {
    const iv = randomOf(8);
    const icv = sha1(data).subarray(0, 8);
    return concatBytes(iv, cmsReverse(cmsCbc(state, iv, concatBytes(icv, data), false)));
}

function cmsUnwrap(state: CipherState, data: Uint8Array): Uint8Array {
    if (data.length < 24 || data.length % 8 !== 0) throw wrapIntegrity();
    const iv = data.subarray(0, 8);
    const opened = cmsCbc(state, iv, cmsReverse(data.subarray(8)), true);
    const content = opened.subarray(8);
    const icv = sha1(content).subarray(0, 8);
    for (let i = 0; i < 8; i++) if (icv[i] !== opened[i]) throw wrapIntegrity();
    return content;
}

/** A wrap whose integrity check fails: the words OpenSSL uses for a wrap it cannot unwrap. */
function wrapIntegrity(): never {
    return cipherFail(null, 'Trying to add data in unsupported state');
}

function aesUnwrapPad(p: BlockPrimitive, key: Uint8Array, aiv: Uint8Array, data: Uint8Array): Uint8Array {
    /* RFC 5649 keeps the AIV's first half for the IV it was wrapped with and puts the plaintext's
       own length in the second, so both come back: a length the padded data cannot hold, or an IV
       that is not the one given, is a wrap this key and IV never produced. */
    if (data.length === 16) {
        const b = p.decrypt(key, data);
        const len = readWrapLength(b, 4);
        if (len > 8) throw wrapIntegrity();
        for (let i = 0; i < 4; i++) if (b[i] !== aiv[i]) throw wrapIntegrity();
        return b.subarray(8, 8 + len);
    }
    const { a, plain } = aesUnwrap(p, key, data);
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

/** The bytes an AEAD hands back for `bytes` of input: the seal of that many zeros is the keystream
 *  itself, and both of these seal by XOR, so the stream is the same in either direction and does
 *  not depend on what is being sealed. */
function aeadXor(state: CipherState, bytes: Uint8Array): Uint8Array {
    if (bytes.length === 0) return new Uint8Array(0);
    const stream = aeadCipher(state).encrypt(new Uint8Array(bytes.length));
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ stream[i];
    return out;
}

/** PKCS#7 removal: a padding byte outside 1..16, or a block that does not end in it, is a bad decrypt. */
function unpad(bytes: Uint8Array, width: number = BLOCK): Uint8Array {
    const pad = bytes[bytes.length - 1];
    if (pad < 1 || pad > width || pad > bytes.length) throw badDecrypt();
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
    if (state.spec.mode === 'cmswrap') {
        if (input.length === 0) return new Uint8Array(0);
        return state.direction === 'encrypt' ? cmsWrap(state, input) : cmsUnwrap(state, input);
    }
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
                const unwrapped = aesUnwrap(primitiveOf(state.spec), state.key, input);
                /* RFC 3394's integrity check: the alternative IV the wrap was made with comes back,
                   and one that does not is a wrap this key and IV never produced. */
                for (let i = 0; i < state.iv.length; i++) {
                    if (unwrapped.a[i] !== state.iv[i]) throw wrapIntegrity();
                }
                return unwrapped.plain;
            }
            return aesWrap(primitiveOf(state.spec), state.key, state.iv, input);
        }
        return encrypt ? aesWrapPad(primitiveOf(state.spec), state.key, state.iv, input) : aesUnwrapPad(primitiveOf(state.spec), state.key, state.iv, input);
    }
    if (state.spec.aead) {
        /* CCM needs the message's whole length before it can seal any of it, so Node answers a
           second update with the state OpenSSL's own CCM leaves. */
        if (state.spec.mode === 'ccm' && input.length > 0 && state.aeadEmitted + state.pending.length > 0) {
            throw cipherFail(null, 'Trying to add data in unsupported state');
        }
        /*
         * An AEAD emits as it goes, the way OpenSSL's does: every byte a caller hands in comes
         * back from the update that carried it, and only the tag waits for final(). Both of these
         * seal by XOR, so the keystream over the bytes so far is the seal of that many zero bytes
         * and is the same stream however the input was split across calls.
         */
        state.pending = concatBytes(state.pending, input);
        /*
         * SP800-38C's L is the width of the length field and is 15 less the nonce's own length,
         * so the longest message a CCM cipher can seal is 2^(8L) - 1: a 13-byte nonce holds
         * 65535 bytes and one byte more is 'Invalid message length', the RangeError Node raises,
         * while the same 65536 bytes under a 12-byte nonce (L = 3) seal without complaint.
         */
        if (state.spec.mode === 'ccm' && state.pending.length > Math.pow(2, 8 * (15 - state.iv.length)) - 1) {
            throw cipherFail('ERR_CRYPTO_INVALID_MESSAGELEN', 'Invalid message length', 'RangeError');
        }
        const out = aeadData(state, state.pending);
        /* OCB seals a block only once it is whole: the bytes a partial block becomes depend on
           where the message ends, so they are held back rather than answered early and wrong. */
        const emit = state.spec.mode === 'ocb' ? Math.floor(out.length / BLOCK) * BLOCK : out.length;
        const fresh = out.subarray(state.aeadEmitted, emit);
        state.aeadEmitted = emit;
        return fresh;
    }
    const total = concatBytes(state.pending, input);
    const block = state.spec.blockSize;
    const width = blockBytesOf(state.spec);
    let emit = Math.floor(total.length / block) * block;
    /* A decrypting block cipher with padding keeps its last whole block: it may hold the padding. */
    if (block > 1 && state.direction === 'decrypt' && state.autoPadding && total.length >= width && total.length % width === 0) {
        emit -= width;
    }
    const out = transformBlocks(state, total.subarray(0, emit));
    state.pending = total.subarray(emit);
    return out;
}

function cipherFinal(state: CipherState): { data: Uint8Array; tag?: Uint8Array } {
    const rest = state.pending;
    state.pending = new Uint8Array(0);
    if (state.spec.aead) {
        const run = aeadRun(state, rest);
        if (state.direction === 'encrypt') {
            /* The tag is taken over the whole plaintext, not over the part this call emits, so it
               is the seal of everything that went in. */
            return {
                data: run.data.subarray(state.aeadEmitted),
                tag: run.tag.subarray(0, state.tagLength)
            };
        }
        if (state.tag === undefined) throw authFailure();
        /*
         * A caller who asked for a tag shorter than the sixteen the AEAD computes is checking the
         * leading bytes of it, and CCM's and OCB's own tags are already the length asked for.
         */
        for (let i = 0; i < state.tagLength; i++) if (run.tag[i] !== state.tag[i]) throw authFailure();
        return { data: run.data.subarray(state.aeadEmitted) };
    }
    const width = blockBytesOf(state.spec);
    if (state.spec.blockSize > 1) {
        if (state.autoPadding) {
            if (state.direction === 'encrypt') {
                const pad = width - (rest.length % width);
                const block = new Uint8Array(rest.length + pad);
                block.set(rest, 0);
                block.fill(pad, rest.length);
                return { data: transformBlocks(state, block) };
            }
            if (rest.length === 0 || rest.length % width !== 0) throw wrongFinalBlock();
            return { data: unpad(transformBlocks(state, rest), width) };
        }
        if (rest.length % width !== 0) throw wrongFinalBlock();
        return { data: rest.length === 0 ? rest : transformBlocks(state, rest) };
    }
    return { data: new Uint8Array(0) };
}

/**
 * The modes over a block cipher this file carries itself: everything OpenSSL opens DES, ARIA, SM4
 * and Camellia in. The state fields are the ones the AES path keeps — the chaining value or
 * register in `iv`, how much of the current block is spent in `counterOffset` — so a call split
 * across two updates behaves the way it does for AES.
 */
function genericBlocks(state: CipherState, bytes: Uint8Array): Uint8Array {
    const p = primitiveOf(state.spec);
    const n = p.size;
    const encrypt = state.direction === 'encrypt';
    const E = (block: Uint8Array): Uint8Array => p.encrypt(state.key, block);
    const D = (block: Uint8Array): Uint8Array => p.decrypt(state.key, block);
    const out = new Uint8Array(bytes.length);
    switch (state.spec.mode) {
        case 'ecb': {
            for (let at = 0; at < bytes.length; at += n) {
                const block = bytes.subarray(at, at + n);
                out.set(encrypt ? E(block) : D(block), at);
            }
            return out;
        }
        case 'cbc': {
            for (let at = 0; at < bytes.length; at += n) {
                const block = bytes.subarray(at, at + n);
                if (encrypt) {
                    const sealed = E(xorInto(block, state.iv));
                    out.set(sealed, at);
                    state.iv = Uint8Array.from(sealed);
                } else {
                    const opened = D(block);
                    for (let j = 0; j < n; j++) out[at + j] = opened[j] ^ state.iv[j];
                    state.iv = Uint8Array.from(block);
                }
            }
            return out;
        }
        case 'cfb': {
            let at = 0;
            while (at < bytes.length) {
                if (state.keystream === null) state.keystream = E(state.iv);
                const take = Math.min(n - state.counterOffset, bytes.length - at);
                for (let j = 0; j < take; j++) {
                    const produced = bytes[at + j] ^ state.keystream![state.counterOffset + j];
                    out[at + j] = produced;
                    state.chainBuf[state.counterOffset + j] = encrypt ? produced : bytes[at + j];
                }
                state.counterOffset += take;
                at += take;
                if (state.counterOffset === n) {
                    state.iv = state.chainBuf.slice(0, n);
                    state.counterOffset = 0;
                    state.keystream = null;
                }
            }
            return out;
        }
        case 'cfb8': {
            const reg = Uint8Array.from(state.iv);
            for (let i = 0; i < bytes.length; i++) {
                const produced = bytes[i] ^ E(reg)[0];
                out[i] = produced;
                reg.copyWithin(0, 1);
                reg[n - 1] = encrypt ? produced : bytes[i];
            }
            state.iv = reg;
            return out;
        }
        case 'cfb1': {
            const reg = Uint8Array.from(state.iv);
            for (let i = 0; i < bytes.length; i++) {
                let byte = 0;
                for (let b = 7; b >= 0; b--) {
                    const bit = ((bytes[i] >> b) & 1) ^ ((E(reg)[0] >> 7) & 1);
                    byte = (byte << 1) | bit;
                    for (let j = 0; j < n - 1; j++) reg[j] = ((reg[j] << 1) | ((reg[j + 1] >> 7) & 1)) & 0xff;
                    reg[n - 1] = ((reg[n - 1] << 1) | (encrypt ? bit : (bytes[i] >> b) & 1)) & 0xff;
                }
                out[i] = byte;
            }
            state.iv = reg;
            return out;
        }
        case 'ofb': {
            for (let i = 0; i < bytes.length; i++) {
                if (state.counterOffset === 0) {
                    state.keystream = E(state.iv);
                    state.iv = Uint8Array.from(state.keystream);
                }
                out[i] = bytes[i] ^ state.keystream![state.counterOffset];
                state.counterOffset = (state.counterOffset + 1) % n;
            }
            return out;
        }
        default: {
            /* CTR: the whole counter block is the register, and each block advances it by one. */
            const blocks = Math.ceil((state.counterOffset + bytes.length) / n);
            const stream = new Uint8Array(blocks * n);
            const counter = Uint8Array.from(state.iv);
            for (let b = 0; b < blocks; b++) {
                stream.set(E(counter), b * n);
                for (let i = n - 1; i >= 0; i--) {
                    counter[i] = (counter[i] + 1) & 0xff;
                    if (counter[i] !== 0) break;
                }
            }
            for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ stream[state.counterOffset + i];
            state.counterOffset = (state.counterOffset + bytes.length) % n;
            return out;
        }
    }
}

/* ---------------------------------------------------------------------------------------------
 * CCM (SP800-38C) and OCB3 (RFC 7253), the two AEADs OpenSSL answers that @noble does not carry.
 * CCM seals a CBC-MAC over a length-prefixed header and the message and masks it with the
 * keystream block the zero counter gives; OCB3 masks each block with an offset chained by
 * doublings in GF(2^128) and seals a checksum of the blocks it saw.
 * ------------------------------------------------------------------------------------------ */

function padToBlockSize(bytes: Uint8Array, size: number): Uint8Array {
    if (bytes.length % size === 0) return bytes;
    const out = new Uint8Array(Math.ceil(bytes.length / size) * size);
    out.set(bytes, 0);
    return out;
}

/** The last `width` bytes of a big-endian counter block, as CCM lays them out. */
function ccmCounterBlock(base: Uint8Array, width: number, value: number): Uint8Array {
    const block = Uint8Array.from(base);
    let rest = value;
    for (let i = block.length - 1; i >= block.length - width; i--) {
        block[i] = rest % 256;
        rest = Math.floor(rest / 256);
    }
    return block;
}

/** CCM's counter-mode keystream over `message`: the same stream either way round. */
function ccmCounter(state: CipherState, message: Uint8Array): Uint8Array {
    const p = primitiveOf(state.spec);
    const width = 15 - state.iv.length;
    const a0 = new Uint8Array(p.size);
    a0[0] = width - 1;
    a0.set(state.iv, 1);
    const out = new Uint8Array(message.length);
    for (let at = 0, counter = 1; at < message.length; at += p.size, counter++) {
        const stream = p.encrypt(state.key, ccmCounterBlock(a0, width, counter));
        const take = Math.min(p.size, message.length - at);
        for (let j = 0; j < take; j++) out[at + j] = message[at + j] ^ stream[j];
    }
    return out;
}

function ccmRun(state: CipherState, message: Uint8Array): { data: Uint8Array; tag: Uint8Array } {
    const p = primitiveOf(state.spec);
    const width = 15 - state.iv.length;
    const tagLength = state.tagLength;
    /* The MAC is taken over the plaintext in both directions, so a decryption unseals first. */
    const plain = state.direction === 'encrypt' ? message : ccmCounter(state, message);
    const b0 = new Uint8Array(p.size);
    b0[0] = (state.aad.length > 0 ? 64 : 0) + 8 * Math.floor((tagLength - 2) / 2) + (width - 1);
    b0.set(state.iv, 1);
    const sized = ccmCounterBlock(b0, width, plain.length);
    let mac = p.encrypt(state.key, sized);
    if (state.aad.length > 0) {
        const header = padToBlockSize(
            concatBytes(new Uint8Array([(state.aad.length >>> 8) & 0xff, state.aad.length & 0xff]), state.aad), p.size);
        for (let at = 0; at < header.length; at += p.size) mac = p.encrypt(state.key, xorInto(mac, header.subarray(at, at + p.size)));
    }
    const padded = padToBlockSize(plain, p.size);
    for (let at = 0; at < padded.length; at += p.size) mac = p.encrypt(state.key, xorInto(mac, padded.subarray(at, at + p.size)));
    const a0 = new Uint8Array(p.size);
    a0[0] = width - 1;
    a0.set(state.iv, 1);
    const mask = p.encrypt(state.key, a0);
    const tag = new Uint8Array(tagLength);
    for (let i = 0; i < tagLength; i++) tag[i] = mac[i] ^ mask[i];
    return { data: state.direction === 'encrypt' ? ccmCounter(state, message) : plain, tag };
}

/** Doubling in GF(2^128) under x^128 + x^7 + x^2 + x + 1, the step OCB chains its offsets by. */
function ocbDouble(block: Uint8Array): Uint8Array {
    const out = new Uint8Array(BLOCK);
    const carry = (block[0] >> 7) & 1;
    /* Each byte takes the top bit of the one after it, so the block shifts towards its most
       significant end, and a bit carried off that end subtracts the field's polynomial. */
    for (let i = 0; i < BLOCK - 1; i++) out[i] = ((block[i] << 1) | (block[i + 1] >> 7)) & 0xff;
    out[BLOCK - 1] = ((block[BLOCK - 1] << 1) ^ (carry === 1 ? 0x87 : 0)) & 0xff;
    return out;
}

/** How many of the low bits of `i` are zero: OCB masks block i with the ntz(i)-th doubling. */
function ocbTrailingZeros(i: number): number {
    let n = 0;
    while (i % 2 === 0) {
        n++;
        i /= 2;
    }
    return n;
}

/** L_* , L_$ and the doublings L_0.. : OCB's key-dependent values. */
function ocbLValues(state: CipherState, count: number): { star: Uint8Array; dollar: Uint8Array; doublings: Uint8Array[] } {
    const p = primitiveOf(state.spec);
    const star = p.encrypt(state.key, new Uint8Array(BLOCK));
    const dollar = ocbDouble(star);
    const doublings: Uint8Array[] = [ocbDouble(dollar)];
    for (let i = 1; i <= count; i++) doublings.push(ocbDouble(doublings[i - 1]));
    return { star, dollar, doublings };
}

/** The offset OCB starts from: the nonce padded the way RFC 7253 pads it, sealed, stretched to
 * 192 bits and then read from the bit the nonce's own low six bits name. */
function ocbOffset(state: CipherState, tagLength: number): Uint8Array {
    const p = primitiveOf(state.spec);
    const nonce = new Uint8Array(BLOCK);
    /*
     * Nonce = num2str(TAGLEN mod 128, 7) || zeros(120 - bitlen(N)) || 1 || N, so the seven tag
     * bits sit at the head, the marker bit sits at bit 127 - bitlen(N) and N itself is flush
     * against the tail -- a 12-byte nonce is the case that puts the marker at byte 3 and N at
     * byte 4, but the layout moves with the nonce's own length, from 1 byte to 15.
     */
    const bits = state.iv.length * 8;
    nonce[0] = ((tagLength * 8) % 128) << 1;
    const marker = 127 - bits;
    nonce[marker >> 3] |= 1 << (7 - (marker & 7));
    nonce.set(state.iv, BLOCK - state.iv.length);
    const bottom = state.iv[state.iv.length - 1] & 0x3f;
    const ktopInput = Uint8Array.from(nonce);
    ktopInput[BLOCK - 1] &= 0xc0;
    const ktop = p.encrypt(state.key, ktopInput);
    let stretch = 0n;
    for (let i = 0; i < 24; i++) {
        const byte = i < BLOCK ? ktop[i] : ktop[i - BLOCK] ^ ktop[i - BLOCK + 1];
        stretch = (stretch << 8n) | BigInt(byte);
    }
    const window = (stretch >> BigInt(64 - bottom)) & ((1n << 128n) - 1n);
    const out = new Uint8Array(BLOCK);
    let rest = window;
    for (let i = BLOCK - 1; i >= 0; i--) {
        out[i] = Number(rest & 0xffn);
        rest >>= 8n;
    }
    return out;
}

/** OCB's PMAC over the associated data: zeros(128) when there is none, as the RFC promises. */
function ocbHash(state: CipherState): Uint8Array {
    const p = primitiveOf(state.spec);
    const { star, doublings } = ocbLValues(state, Math.ceil(state.aad.length / BLOCK) + 1);
    const whole = Math.floor(state.aad.length / BLOCK);
    const tail = state.aad.length - whole * BLOCK;
    let sum = new Uint8Array(BLOCK);
    let offset = new Uint8Array(BLOCK);
    for (let i = 1; i <= whole; i++) {
        offset = xorInto(offset, doublings[ocbTrailingZeros(i)]);
        sum = xorInto(sum, p.encrypt(state.key, xorInto(state.aad.subarray((i - 1) * BLOCK, i * BLOCK), offset)));
    }
    if (tail > 0) {
        const offsetStar = xorInto(offset, star);
        const padded = new Uint8Array(BLOCK);
        padded.set(state.aad.subarray(whole * BLOCK), 0);
        padded[tail] = 0x80;
        sum = xorInto(sum, p.encrypt(state.key, xorInto(padded, offsetStar)));
    }
    return sum;
}

function ocbRun(state: CipherState, message: Uint8Array): { data: Uint8Array; tag: Uint8Array } {
    const p = primitiveOf(state.spec);
    const tagLength = state.tagLength;
    const { star, dollar, doublings } = ocbLValues(state, Math.ceil(message.length / BLOCK) + 1);
    let offset = ocbOffset(state, tagLength);
    const whole = Math.floor(message.length / BLOCK);
    const tail = message.length - whole * BLOCK;
    const encrypt = state.direction === 'encrypt';
    const data = new Uint8Array(message.length);
    let checksum = new Uint8Array(BLOCK);
    for (let i = 1; i <= whole; i++) {
        offset = xorInto(offset, doublings[ocbTrailingZeros(i)]);
        const block = message.subarray((i - 1) * BLOCK, i * BLOCK);
        /* Sealing encrypts the block under its offset and xors the offset back; opening decrypts
           it and does the same. Both name the plaintext block, which is what the checksum and the
           tag are taken over, and the ciphertext block, which is what comes out. */
        const plain = encrypt ? block : xorInto(p.decrypt(state.key, xorInto(block, offset)), offset);
        const sealed = encrypt ? xorInto(p.encrypt(state.key, xorInto(block, offset)), offset) : block;
        data.set(encrypt ? sealed : plain, (i - 1) * BLOCK);
        checksum = xorInto(checksum, plain);
    }
    let offsetStar = offset;
    if (tail > 0) {
        offsetStar = xorInto(offset, star);
        const pad = p.encrypt(state.key, offsetStar);
        const at = whole * BLOCK;
        const part = message.subarray(at);
        const outPart = new Uint8Array(tail);
        for (let i = 0; i < tail; i++) outPart[i] = part[i] ^ pad[i];
        data.set(outPart, at);
        const padded = new Uint8Array(BLOCK);
        padded.set(encrypt ? part : outPart, 0);
        padded[tail] = 0x80;
        checksum = xorInto(checksum, padded);
    }
    const raw = p.encrypt(state.key, xorInto(xorInto(checksum, offsetStar), dollar));
    return { data, tag: xorInto(raw.subarray(0, tagLength), ocbHash(state).subarray(0, tagLength)) };
}

/* ---------------------------------------------------------------------------------------------
 * GCM (SP800-38D) over a block cipher @noble does not carry: GHASH in GF(2^128) and the counter
 * mode it seals with. The AES names keep @noble's own GCM; ARIA's has no other way in.
 * ------------------------------------------------------------------------------------------ */

/** One multiplication in GF(2^128) under x^128 + x^7 + x^2 + x + 1, bit by bit from the top. */
function ghashMultiply(x: Uint8Array, y: Uint8Array): Uint8Array {
    const out = new Uint8Array(BLOCK);
    const v = Uint8Array.from(y);
    for (let i = 0; i < 128; i++) {
        if (((x[i >> 3] >> (7 - (i & 7))) & 1) === 1) for (let j = 0; j < BLOCK; j++) out[j] ^= v[j];
        const low = v[BLOCK - 1] & 1;
        let carry = 0;
        for (let j = 0; j < BLOCK; j++) {
            const next = (v[j] >> 1) | carry;
            carry = (v[j] & 1) === 1 ? 0x80 : 0;
            v[j] = next;
        }
        if (low === 1) v[0] ^= 0xe1;
    }
    return out;
}

function ghash(h: Uint8Array, blocks: Uint8Array): Uint8Array {
    let y = new Uint8Array(BLOCK);
    for (let at = 0; at < blocks.length; at += BLOCK) {
        const block = padToBlockSize(blocks.subarray(at, at + BLOCK), BLOCK);
        for (let j = 0; j < BLOCK; j++) y[j] ^= block[j];
        y = ghashMultiply(y, h);
    }
    return y;
}

/** GCM counts in the counter block's last 32 bits. */
function gcmIncrement(counter: Uint8Array): void {
    for (let i = BLOCK - 1; i >= BLOCK - 4; i--) {
        counter[i] = (counter[i] + 1) & 0xff;
        if (counter[i] !== 0) break;
    }
}

function gcmRun(state: CipherState, bytes: Uint8Array): { data: Uint8Array; tag: Uint8Array } {
    const p = primitiveOf(state.spec);
    const E = (block: Uint8Array): Uint8Array => p.encrypt(state.key, block);
    const h = E(new Uint8Array(BLOCK));
    const j0 = new Uint8Array(BLOCK);
    if (state.iv.length === 12) {
        j0.set(state.iv, 0);
        j0[BLOCK - 1] = 1;
    } else {
        /* A nonce of any other length is hashed with its own bit length beside it. */
        const tail = new Uint8Array(BLOCK);
        let nonceBits = BigInt(state.iv.length) * 8n;
        for (let i = BLOCK - 1; i >= BLOCK - 8; i--) { tail[i] = Number(nonceBits & 0xffn); nonceBits >>= 8n; }
        j0.set(ghash(h, concatBytes(padToBlockSize(state.iv, BLOCK), tail)), 0);
    }
    const gctr = (start: Uint8Array, data: Uint8Array): Uint8Array => {
        const counter = Uint8Array.from(start);
        const out = new Uint8Array(data.length);
        for (let at = 0; at < data.length; at += BLOCK) {
            const stream = E(counter);
            const take = Math.min(BLOCK, data.length - at);
            for (let i = 0; i < take; i++) out[at + i] = data[at + i] ^ stream[i];
            gcmIncrement(counter);
        }
        return out;
    };
    const counter0 = Uint8Array.from(j0);
    gcmIncrement(counter0);
    const plain = state.direction === 'encrypt' ? bytes : gctr(counter0, bytes);
    const cipher = state.direction === 'encrypt' ? gctr(counter0, bytes) : bytes;
    const lengths = new Uint8Array(BLOCK);
    let bits = BigInt(state.aad.length) * 8n;
    for (let i = 7; i >= 0; i--) { lengths[i] = Number(bits & 0xffn); bits >>= 8n; }
    bits = BigInt(cipher.length) * 8n;
    for (let i = BLOCK - 1; i >= BLOCK - 8; i--) { lengths[i] = Number(bits & 0xffn); bits >>= 8n; }
    const s = ghash(h, concatBytes(concatBytes(padToBlockSize(state.aad, BLOCK), padToBlockSize(cipher, BLOCK)), lengths));
    const mask = E(j0);
    const tag = new Uint8Array(TAG_LENGTH);
    for (let i = 0; i < TAG_LENGTH; i++) tag[i] = s[i] ^ mask[i];
    return { data: state.direction === 'encrypt' ? cipher : plain, tag };
}

/** The bytes an AEAD hands back for `bytes` of input: the whole plaintext or ciphertext so far,
 *  which for a caller who split a message across updates is what the tail of it asks for. */
function aeadData(state: CipherState, bytes: Uint8Array): Uint8Array {
    if (state.spec.mode === 'ccm') return ccmRun(state, bytes).data;
    if (state.spec.mode === 'ocb') return ocbRun(state, bytes).data;
    if (state.spec.mode === 'gcm' && state.spec.primitive !== undefined) return gcmRun(state, bytes).data;
    return aeadXor(state, bytes);
}

/** That answer and the tag that goes with it, which for GCM and ChaCha20-Poly1305 is the seal of
 *  the plaintext, and for CCM and OCB is the mode's own. */
function aeadRun(state: CipherState, bytes: Uint8Array): { data: Uint8Array; tag: Uint8Array } {
    if (state.spec.mode === 'ccm') return ccmRun(state, bytes);
    if (state.spec.mode === 'ocb') return ocbRun(state, bytes);
    if (state.spec.primitive !== undefined && state.spec.mode === 'gcm') return gcmRun(state, bytes);
    const data = aeadXor(state, bytes);
    /* The tag seals the plaintext, never the ciphertext: encrypting, that is what came in;
       decrypting, it is what the keystream just recovered. */
    const plain = state.direction === 'encrypt' ? bytes : data;
    const sealed = aeadCipher(state).encrypt(plain);
    return { data, tag: sealed.subarray(sealed.length - TAG_LENGTH) };
}

function stateFor(id: unknown, op: string): CipherState {
    const state = CIPHER_STATE.get(Number(id));
    if (state === undefined) throw invalidState(op);
    return state;
}

function openCipher(args: any): { id: number; aead: boolean } {
    const algorithm = String(args?.algorithm ?? '');
    const spec = CIPHER_SPECS[algorithm.toLowerCase()];
    if (spec === undefined) {
        /* A name OpenSSL's object database knows but its default provider no longer carries: Node
           answers with OpenSSL's own refusal, not with an unknown cipher. */
        if (LEGACY_CIPHER_INFO[algorithm.toLowerCase()] !== undefined) {
            throw cipherFail('ERR_OSSL_EVP_UNSUPPORTED', 'error:0308010C:digital envelope routines::unsupported');
        }
        throw cipherFail('ERR_CRYPTO_UNKNOWN_CIPHER', 'Unknown cipher');
    }
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
    /* CCM and OCB answer no tag length of their own: Node refuses them outright unless a caller
       names one, and honours the one it is given for the rest. */
    const wanted = args?.options?.authTagLength;
    if (spec.needsAuthTagLength === true && (wanted === undefined || wanted === null)) {
        throw cipherFail('ERR_CRYPTO_INVALID_AUTH_TAG', `authTagLength required for ${algorithm}`, 'TypeError');
    }
    /* Node takes an authTagLength of 4 to 16 for GCM and for chacha20-poly1305 and refuses any
       other, before it looks at the key; a cipher that seals nothing ignores the option. */
    let tagLength = TAG_LENGTH;
    if (spec.aead && wanted !== undefined && wanted !== null) {
        tagLength = Number(wanted);
        /*
         * OCB takes 0 to 16 -- a tag length of 0 opens a cipher that then takes no data, no AAD
         * and names no tag, the state OpenSSL leaves it in -- while CCM takes only an even length
         * (SP800-38C has no odd tag, so the odd ones are refused before anything else is looked
         * at, including the plaintextLength that AAD asks for). GCM and chacha20 keep 4 to 16.
         */
        const shortest = spec.mode === 'ocb' ? 0 : 4;
        const evenOnly = spec.mode === 'ccm';
        if (tagLength < shortest || tagLength > TAG_LENGTH || (evenOnly && tagLength % 2 !== 0)) {
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
        aeadEmitted: 0,
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
    /** An 'rsa-pss' key generated with a digest or a salt length named: what its details answer. */
    pss?: { hashAlgorithm: string; mgf1HashAlgorithm: string; saltLength: number };
}

const KEY_STORE = new Map<number, KeyRecord>();
let nextKeyId = 1;
/** Keys a process abandoned are dropped rather than kept forever, as ciphers are below. */
const OPEN_KEY_LIMIT = 256;

function keyFail(code: string | null, message: string, kind: 'Error' | 'RangeError' | 'TypeError' = 'Error'): never {
    const Ctor = kind === 'RangeError' ? RangeError : kind === 'TypeError' ? TypeError : Error;
    throw Object.assign(new Ctor(message), { code: code ?? 'ERR_CAPABILITY', owcErrorClass: kind, owcUncoded: code === null });
}

/**
 * How Node names what it was handed at the end of an ERR_INVALID_ARG_TYPE: "type string ('x')" for
 * text, "type number (1)" for any other primitive, and "an instance of ArrayBuffer" for an object.
 * An ERR_OUT_OF_RANGE prints the bare value instead, so only the argument errors use this.
 */
function receivedLike(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return `type string ('${value}')`;
    if (typeof value !== 'object' && typeof value !== 'function') return `type ${typeof value} (${String(value)})`;
    const made = (value as { constructor?: { name?: string } }).constructor;
    const named = made !== null && made !== undefined && typeof made.name === 'string' ? made.name : null;
    return named === null || named === '' ? 'an instance of Object' : `an instance of ${named}`;
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
    /* DSA, DH and 'rsa-pss' have no JWK form at all: an 'rsa-pss' key is an RSA key with a
       restricted padding, and Node answers ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE for all three. */
    if (key.kind === 'rsa-pss' || key.kind === 'dsa' || key.kind === 'dh') {
        throw keyFail('ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE', 'Unsupported JWK Key Type.');
    }
    if (key.kind === 'rsa') {
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
    if (curve === undefined) throw keyFail('ERR_CRYPTO_INVALID_CURVE', 'Invalid EC curve name', 'TypeError');
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
    /* An odd width needs one prime a bit wider than the other: 513 bits is a 257-bit prime times a
       256-bit one, and two equal halves could never reach past 512. */
    const wide = half + (bits & 1);
    const p = searchPrime(wide, { topBits: 2, coprimeTo: exponent });
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

/**
 * A key pair over a prime that was fixed rather than generated: a named MODP group, or a prime a
 * caller handed in. OpenSSL keeps a `length` on such a group and draws the private exponent at
 * that width, so generateKeyPairSync('dh', {group}) and {prime} both answer a PKCS#8 whose private
 * value is 29 bytes at 2048 bits, where {primeLength} -- which generates the parameters and the
 * key together -- answers a full-width one. Measured against host Node 24.15.
 */
function dhFromPrime(p: bigint, g: bigint): IntKey {
    const x = randomExponent(p, true);
    return { p, g, x, y: modPow(g, x, p) };
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
        /* A salt the encoded message cannot hold is 'data too large for key size', the refusal
           OpenSSL's RSA signing path names, not the 'too large for modulus' a raw block gives. */
        throw keyFail('ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE', 'error:0200006E:rsa routines::data too large for key size');
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
    /* No salt length named at all is AUTO -- the longest salt that fits -- and not the digest's
       own width: a host signature made with none verifies against 222 at 2048 bits and sha256 and
       against nothing else, which is emLen - hLen - 2. */
    if (saltLength === undefined) return -2;
    if (saltLength === null || !Number.isFinite(asked)) return hLen;
    if (asked === -1) return hLen;
    if (asked === -2) return -2;
    return Math.trunc(asked);
}

/** How Node prints the value it refused at the end of an ERR_INVALID_ARG_VALUE: bare for a number,
 *  quoted for text, and the object itself -- '{}' -- for anything with keys. */
function invalidValueText(value: unknown): string {
    if (typeof value === 'string') return `'${value}'`;
    if (typeof value === 'object' && value !== null) {
        try {
            return JSON.stringify(value) ?? 'an instance of Object';
        } catch {
            return 'an instance of Object';
        }
    }
    return String(value);
}

/**
 * Node reads a salt length as an int32 whether or not the key or the padding has anything to do
 * with PSS, and it reads it before it looks at either: a value that is not a whole number in that
 * range is refused over an RSA key, over an Edwards one and over a public key alike.
 */
function saltLengthArg(saltLength: unknown): number | undefined {
    if (saltLength === undefined) return undefined;
    if (typeof saltLength !== 'number' || !Number.isInteger(saltLength) || saltLength < -2147483648 || saltLength > 2147483647) {
        throw keyFail('ERR_INVALID_ARG_VALUE', "The property 'options.saltLength' is invalid. Received " + invalidValueText(saltLength), 'TypeError');
    }
    return saltLength;
}

/** The floor OpenSSL puts under a PSS salt length: -4 signs, and -5 does not. */
function pssSaltFloor(salt: number | undefined, mode: number): void {
    if (mode !== RSA_PKCS1_PSS_PADDING || salt === undefined || salt > -5) return;
    throw keyFail('ERR_OSSL_INVALID_SALT_LENGTH', 'error:1C800070:Provider routines::invalid salt length');
}

/** Signs or verifies with an RSA key: the exponentiation is one BigInt modPow either way. */
/**
 * The bytes a signature is taken over. A named digest is hashed; no algorithm at all -- the form
 * crypto.sign(null, ...) asks for -- reaches Node's default, SHA-256, for an RSA, a DSA and an EC
 * key. An Edwards key never gets here: it is pure, and refuses a digest of any kind.
 */
const DEFAULT_DIGEST = 'sha256';
function noDigestBytes(data: Uint8Array, algorithm: unknown): Uint8Array {
    const spec = digestFor(algorithm === undefined || algorithm === null ? DEFAULT_DIGEST : algorithm);
    /*
     * A signature has to run over a digest of a known width, and an XOF has none: OpenSSL's
     * digest lookup finds shake128 and shake256 but refuses to sign with either, which is the
     * 'invalid digest' crypto.sign('shake128', data, ecKey) answers on the host.
     */
    if (spec.xof === true) throw keyFail('ERR_OSSL_INVALID_DIGEST', 'error:1C80007A:Provider routines::invalid digest');
    return spec.fn(data, 0);
}

function rsaSignWith(ints: IntKey, digest: Uint8Array, name: string, padding: number, saltLength: number): Uint8Array {
    const n = ints.n as bigint;
    const size = modulusSize(n);
    const spec = DIGEST_SPECS[name];
    const hash = (message: Uint8Array): Uint8Array => spec.fn(message, 0);
    const emBits = n.toString(2).length - 1;
    /* AUTO (-2) and MAX (-3) are the longest salt the block has room for, which is what OpenSSL
       writes when a call named no salt length and what it checks when a check names AUTO. */
    const salt = saltLength === -2 || saltLength === -3
        ? Math.ceil(emBits / 8) - spec.out - 2
        : saltLength < 0 ? spec.out : saltLength;
    const em = padding === RSA_PKCS1_PSS_PADDING
        ? emsaPssEncode(digest, emBits, salt, hash, spec.out)
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

/* ---------------------------------------------------------------------------------------------
 * The raw RSA surface: privateEncrypt, publicDecrypt, publicEncrypt and privateDecrypt. There is
 * no digest in the way -- the caller's own bytes are padded, exponentiated and unpadded, which is
 * what makes privateEncrypt the width of the modulus and publicDecrypt the bytes it was given.
 * Node's defaults differ by direction and not by name: a private encrypt and a public decrypt are
 * PKCS#1 v1.5 (block type 1, the signing padding), while a public encrypt and a private decrypt
 * are OAEP with SHA-1 and no label, which is why the same 2048-bit key takes 245 bytes one way
 * and 214 the other.
 * ------------------------------------------------------------------------------------------ */

/** RSA_NO_PADDING is 3 and RSA_PKCS1_OAEP_PADDING is 4, as crypto.constants names them. */
const RSA_NO_PADDING = 3;
const RSA_PKCS1_OAEP_PADDING = 4;

const rsaDataTooLarge = () => keyFail('ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE', 'error:0200006E:rsa routines::data too large for key size');
const rsaDataTooSmall = () => keyFail('ERR_OSSL_RSA_DATA_TOO_SMALL_FOR_KEY_SIZE', 'error:0200007A:rsa routines::data too small for key size');
const rsaInvalidPadding = () => keyFail('ERR_OSSL_RSA_INVALID_PADDING', 'error:0200008A:rsa routines::invalid padding');
const rsaOaepDecoding = () => keyFail('ERR_OSSL_RSA_OAEP_DECODING_ERROR', 'error:02000079:rsa routines::oaep decoding error');

function rsaDigestFor(name: unknown): DigestSpec {
    /* An OAEP block is built with a digest the caller names, SHA-1 when it names none. */
    const spec = DIGEST_SPECS[digestNameFor(name === undefined || name === null ? 'sha1' : name)];
    if (spec === undefined) throw keyFail('ERR_OSSL_EVP_UNSUPPORTED', 'Digest method not supported');
    return spec;
}

/** PKCS#1 v1.5 encryption padding (RFC 8017 7.2): 0x00, the block type, a filler, 0x00, the data. */
function rsaPadV15(data: Uint8Array, size: number, type: number): Uint8Array {
    if (data.length + 11 > size) throw rsaDataTooLarge();
    const out = new Uint8Array(size);
    out[0] = 0x00;
    out[1] = type;
    if (type === 1) {
        out.fill(0xff, 2, size - data.length - 1);
    } else {
        /* A type 2 filler is random and never zero, so the scan that reads it back stops where
           the padding ends: a zero byte is the delimiter and not part of the filler. */
        const filler = randomOf(size - data.length - 3);
        for (let i = 0; i < filler.length; i++) out[2 + i] = filler[i] === 0 ? 1 : filler[i];
    }
    out[size - data.length - 1] = 0x00;
    out.set(data, size - data.length);
    return out;
}

function rsaUnpadV15(em: Uint8Array, size: number, type: number): Uint8Array {
    if (size < 11 || em[0] !== 0x00 || em[1] !== type) throw rsaInvalidPadding();
    let at = 2;
    /* Eight bytes of filler at the least, which is what OpenSSL's own scan of the block insists
       on. A type 1 filler is a run of 0xff up to the delimiter; a type 2 one is every byte up to
       it, because a type 2 filler is random and only the delimiter is known to be zero. */
    if (type === 1) {
        while (at < size && em[at] === 0xff) at++;
    } else {
        while (at < size && em[at] !== 0x00) at++;
    }
    if (at < 10 || em[at] !== 0x00) throw rsaInvalidPadding();
    return em.subarray(at + 1);
}

/** RSAES-OAEP (RFC 8017 7.1): a masked seed over a masked data block, each under MGF1. */
function rsaPadOaep(data: Uint8Array, size: number, spec: DigestSpec, label: Uint8Array): Uint8Array {
    const hLen = spec.out;
    /* An OAEP block is always the digest's own length, so no XOF length is asked for here. */
    const hash = (message: Uint8Array): Uint8Array => spec.fn(message, 0);
    if (data.length > size - 2 * hLen - 2) throw rsaDataTooLarge();
    const lHash = hash(label);
    const filler = new Uint8Array(size - data.length - 2 * hLen - 2);
    const db = concatBytes(concatBytes(lHash, filler), concatBytes(new Uint8Array([0x01]), data));
    const seed = randomOf(hLen);
    const maskedDb = xorBytes(db, mgf1(seed, size - hLen - 1, hash));
    const maskedSeed = xorBytes(seed, mgf1(maskedDb, hLen, hash));
    return concatBytes(new Uint8Array([0x00]), concatBytes(maskedSeed, maskedDb));
}

function rsaUnpadOaep(em: Uint8Array, size: number, spec: DigestSpec, label: Uint8Array): Uint8Array {
    const hLen = spec.out;
    const hash = (message: Uint8Array): Uint8Array => spec.fn(message, 0);
    if (size < 2 * hLen + 2 || em[0] !== 0x00) throw rsaOaepDecoding();
    const maskedSeed = em.subarray(1, 1 + hLen);
    const maskedDb = em.subarray(1 + hLen);
    const seed = xorBytes(maskedSeed, mgf1(maskedDb, hLen, hash));
    const db = xorBytes(maskedDb, mgf1(seed, size - hLen - 1, hash));
    const lHash = hash(label);
    for (let i = 0; i < hLen; i++) if (db[i] !== lHash[i]) throw rsaOaepDecoding();
    let at = hLen;
    while (at < db.length && db[at] === 0x00) at++;
    if (at >= db.length || db[at] !== 0x01) throw rsaOaepDecoding();
    return db.subarray(at + 1);
}

/**
 * Args {id, op, data, padding, oaepHash, oaepLabel}: one raw RSA operation. `op` is one of
 * private-encrypt, public-decrypt, public-encrypt and private-decrypt.
 */
function rsaRawWith(key: KeyRecord, op: string, data: Uint8Array, padding: unknown, oaepHash: unknown, oaepLabel: Uint8Array): Uint8Array {
    if (key.kind !== 'rsa' && key.kind !== 'rsa-pss') {
        throw keyFail('ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE', 'error:03000096:digital envelope routines::operation not supported for this keytype');
    }
    const sealing = op === 'private-encrypt' || op === 'private-decrypt';
    if (sealing && key.type !== 'private') {
        throw keyFail('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', 'Invalid key object type ' + key.type + ', expected private.', 'TypeError');
    }
    const ints = key.ints as IntKey;
    const n = ints.n as bigint;
    const size = modulusSize(n);
    const oaepByDefault = op === 'public-encrypt' || op === 'private-decrypt';
    const mode = padding === undefined || padding === null
        ? (oaepByDefault ? RSA_PKCS1_OAEP_PADDING : RSA_PKCS1_PADDING)
        : Number(padding);
    const exponent = (sealing ? ints.d : ints.e) as bigint;
    if (mode !== RSA_PKCS1_PADDING && mode !== RSA_PKCS1_OAEP_PADDING && mode !== RSA_NO_PADDING) {
        throw keyFail('ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE', 'error:1C8000A5:Provider routines::illegal or unsupported padding mode');
    }
    if (op === 'private-encrypt' || op === 'public-encrypt') {
        let em: Uint8Array;
        if (mode === RSA_NO_PADDING) {
            /* A raw block is the modulus' own width, no wider and no narrower. */
            if (data.length < size) throw rsaDataTooSmall();
            if (data.length > size) throw rsaDataTooLarge();
            em = data;
        } else if (mode === RSA_PKCS1_OAEP_PADDING) {
            em = rsaPadOaep(data, size, rsaDigestFor(oaepHash), oaepLabel);
        } else {
            em = rsaPadV15(data, size, sealing ? 1 : 2);
        }
        const m = bigOf(em);
        if (m >= n) throw rsaDataTooLarge();
        return bytesOf(modPow(m, exponent, n), size);
    }
    if (data.length !== size) throw rsaDataTooSmall();
    const c = bigOf(data);
    if (c >= n) throw rsaDataTooLarge();
    const em = bytesOf(modPow(c, exponent, n), size);
    if (mode === RSA_NO_PADDING) return em;
    if (mode === RSA_PKCS1_OAEP_PADDING) return rsaUnpadOaep(em, size, rsaDigestFor(oaepHash), oaepLabel);
    /* A private decrypt reads the block type a public encrypt wrote, and a public one the type a
       private encrypt wrote: 2 one way and 1 the other, as OpenSSL's own two padding calls pair. */
    return rsaUnpadV15(em, size, op === 'private-decrypt' ? 2 : 1);
}

/** FIPS 186-4 4.6: the leftmost `bits` of a digest, as an integer, so a short q still signs. */
const bits2int = (digest: Uint8Array, bits: number): bigint => {
    const excess = digest.length * 8 - bits;
    const value = bigOf(digest);
    return excess > 0 ? value >> BigInt(excess) : value;
};

/** DSA: r = (g^k mod p) mod q and s = k^-1 (z + x*r) mod q, as a DER pair or as r||s. */
function dsaSignWith(ints: IntKey, digest: Uint8Array, encoding: string): Uint8Array {
    const p = ints.p as bigint;
    const q = ints.q as bigint;
    const g = ints.g as bigint;
    const x = ints.x as bigint;
    const z = bits2int(digest, q.toString(2).length);
    /* 'ieee-p1363' is r||s, each padded to q's own width; Node's default is the DER SEQUENCE. */
    const size = Math.ceil(q.toString(2).length / 8);
    for (let attempt = 0; attempt < 100; attempt++) {
        const k = 1n + (bigOf(randomOf(Math.ceil(q.toString(2).length / 8))) % (q - 1n));
        const r = modPow(g, k, p) % q;
        if (r === 0n) continue;
        const s = (modInverse(k, q) * (z + x * r)) % q;
        if (s === 0n) continue;
        if (encoding === 'ieee-p1363') return concatBytes(bytesOf(r, size), bytesOf(s, size));
        return derSequence([derIntegerBig(r), derIntegerBig(s)]);
    }
    throw keyFail('ERR_CRYPTO_INVALID_STATE', 'DSA signing failed');
}

function dsaVerifyWith(ints: IntKey, digest: Uint8Array, signature: Uint8Array, encoding: string): boolean {
    try {
        const q = ints.q as bigint;
        let r: bigint;
        let s: bigint;
        if (encoding === 'ieee-p1363') {
            /* A compact signature is exactly two halves of q's width; anything else is not one. */
            const size = Math.ceil(q.toString(2).length / 8);
            if (signature.length !== size * 2) return false;
            r = bigOf(signature.subarray(0, size));
            s = bigOf(signature.subarray(size));
        } else {
            const root = derRead(signature);
            if (root.tag !== DER_SEQUENCE || root.children.length !== 2) return false;
            r = intOf(root.children[0]);
            s = intOf(root.children[1]);
        }
        const p = ints.p as bigint;
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

/*
 * The PSS parameters an 'rsa-pss' key answers on asymmetricKeyDetails: the digest, the MGF1
 * digest (the same one unless another was named) and the salt length (the digest's own width
 * unless one was named). A key generated with none of the three named carries none of them, so
 * a bare generateKeyPairSync('rsa-pss') answers a modulus and an exponent and nothing else.
 */
function pssParamsOf(options: any): { hashAlgorithm: string; mgf1HashAlgorithm: string; saltLength: number } | undefined {
    const named = options?.hashAlgorithm ?? options?.hash;
    const mgf1 = options?.mgf1HashAlgorithm;
    const salt = options?.saltLength;
    if (named === undefined && mgf1 === undefined && salt === undefined) return undefined;
    const hash = digestNameFor(String(named ?? 'sha1'));
    return {
        hashAlgorithm: hash,
        mgf1HashAlgorithm: mgf1 === undefined ? hash : digestNameFor(String(mgf1)),
        saltLength: salt === undefined ? (DIGEST_SPECS[hash]?.out ?? 20) : Number(salt)
    };
}

function generatePair(type: unknown, options: any): { public: number; private: number } {
    /* Node reads the key type as text before it looks it up, so a number is a type error and not
       the 'supported key type' refusal a name it does not know answers. */
    if (typeof type !== 'string') {
        throw keyFail('ERR_INVALID_ARG_TYPE', 'The "type" argument must be of type string. Received ' + receivedLike(type), 'TypeError');
    }
    const kind = String(type ?? '').toLowerCase();
    /*
     * Node insists on an options object for the kinds that take a size -- an RSA modulus, a DSA
     * modulus, a DH prime and an EC curve all need something named -- so a call with none is an
     * argument error here too, the way it is on the host.
     */
    if (kind === 'rsa' || kind === 'rsa-pss' || kind === 'dsa' || kind === 'dh' || kind === 'ec') {
        if (options === undefined || options === null || typeof options !== 'object') {
            throw keyFail('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object. Received ' + receivedLike(options), 'TypeError');
        }
    }
    if (kind === 'rsa' || kind === 'rsa-pss') {
        if (typeof options?.modulusLength !== 'number') {
            throw keyFail('ERR_INVALID_ARG_TYPE', 'The "options.modulusLength" property must be of type number. Received ' + receivedLike(options?.modulusLength), 'TypeError');
        }
        const modulusLength = options.modulusLength;
        if (!Number.isInteger(modulusLength)) {
            throw keyFail('ERR_OUT_OF_RANGE', 'The value of "options.modulusLength" is out of range. It must be an integer. Received ' + String(modulusLength), 'RangeError');
        }
        /* Node bounds a modulus by what an uint32 can hold before it reaches OpenSSL's own floor:
           -1 is out of range where 256 is merely too small a key. */
        if (modulusLength < 0 || modulusLength > 4294967295) {
            throw keyFail('ERR_OUT_OF_RANGE', 'The value of "options.modulusLength" is out of range. It must be >= 0 && <= 4294967295. Received ' + String(modulusLength), 'RangeError');
        }
        /* OpenSSL's own floor for an RSA modulus, and the uncoded error it answers below it. */
        if (modulusLength < 512) {
            throw keyFail(null, 'error:1C8000AB:Provider routines::key size too small');
        }
        /*
         * A public exponent is a number or nothing: Node takes its word for the value and lets
         * OpenSSL refuse one it will not use, which is an even exponent, one below 3, or a string
         * handed in where a number was asked for.
         */
        const givenExponent = options?.publicExponent;
        if (givenExponent !== undefined && givenExponent !== null && typeof givenExponent !== 'number') {
            throw keyFail('ERR_INVALID_ARG_TYPE', 'The "options.publicExponent" property must be of type number. Received ' + receivedLike(givenExponent), 'TypeError');
        }
        const exponent = givenExponent === undefined || givenExponent === null ? 65537n : BigInt(String(givenExponent));
        if (exponent < 3n || (exponent & 1n) === 0n) {
            throw keyFail(null, 'error:020000B2:rsa routines::pub exponent out of range');
        }
        const ints = generateRsa(modulusLength, exponent);
        const size = modulusSize(ints.n as bigint);
        const pss = kind === 'rsa-pss' ? pssParamsOf(options) : undefined;
        return {
            public: storeKey({ type: 'public', kind, ints, pss, publicBytes: bytesOf(ints.n as bigint, size) }),
            private: storeKey({ type: 'private', kind, ints, pss, publicBytes: bytesOf(ints.n as bigint, size), privateBytes: bytesOf(ints.d as bigint, size) })
        };
    }
    if (kind === 'dsa') {
        if (typeof options?.modulusLength !== 'number') {
            throw keyFail('ERR_INVALID_ARG_TYPE', 'The "options.modulusLength" property must be of type number. Received ' + receivedLike(options?.modulusLength), 'TypeError');
        }
        const modulusLength = options.modulusLength;
        if (!Number.isInteger(modulusLength)) {
            throw keyFail('ERR_OUT_OF_RANGE', 'The value of "options.modulusLength" is out of range. It must be an integer. Received ' + String(modulusLength), 'RangeError');
        }
        /* DSA reaches its provider below 512 bits and fails there, which is not a range error. */
        if (modulusLength < 512) {
            throw keyFail(null, 'error:030000E9:digital envelope routines::provider keymgmt failure');
        }
        const divisorLength = options?.divisorLength === undefined || options?.divisorLength === null ? 224 : options?.divisorLength;
        if (typeof divisorLength !== 'number') {
            throw keyFail('ERR_INVALID_ARG_TYPE', 'The "options.divisorLength" property must be of type number. Received ' + receivedLike(divisorLength), 'TypeError');
        }
        /* OpenSSL's own floor for a DSA modulus: below 1024 it has no FFC parameters to offer, and
           below 512 its provider will not even start. */
        if (modulusLength < 512) {
            throw keyFail(null, 'error:030000E9:digital envelope routines::provider keymgmt failure');
        }
        if (modulusLength < 1024) {
            throw keyFail(null, 'error:05000072:dsa routines::bad ffc parameters');
        }
        /* FIPS 186-4 offers a DSA subgroup of 160, 224 or 256 bits and no other width, so any other
           divisor length never reaches the search: OpenSSL's provider has no parameters to offer. */
        if (divisorLength !== 160 && divisorLength !== 224 && divisorLength !== 256) {
            throw keyFail(null, 'error:030000E9:digital envelope routines::provider keymgmt failure');
        }
        const ints = generateDsa(modulusLength, Number(divisorLength));
        const size = modulusSize(ints.p as bigint);
        return {
            public: storeKey({ type: 'public', kind, ints, publicBytes: bytesOf(ints.y as bigint, size) }),
            private: storeKey({ type: 'private', kind, ints, publicBytes: bytesOf(ints.y as bigint, size), privateBytes: bytesOf(ints.x as bigint, Math.ceil(divisorLength / 8)) })
        };
    }
    if (kind === 'dh') {
        /*
         * A group, a prime or a prime length: Node asks for one of the three before it generates,
         * and a group fixes the parameters outright, so a prime, a prime length or a generator
         * beside it is refused rather than ignored.
         */
        const group = options?.group;
        const prime = options?.prime;
        const primeLength = options?.primeLength;
        const hasGroup = group !== undefined && group !== null;
        const hasPrime = prime !== undefined && prime !== null;
        const hasPrimeLength = primeLength !== undefined && primeLength !== null;
        if (hasGroup) {
            if (typeof group !== 'string') {
                throw keyFail('ERR_INVALID_ARG_TYPE', 'The "options.group" property must be of type string. Received ' + receivedLike(group), 'TypeError');
            }
            const clash = hasPrime ? 'prime'
                : hasPrimeLength ? 'primeLength'
                    : (options?.generator === undefined || options?.generator === null) ? null : 'generator';
            if (clash !== null) {
                throw keyFail('ERR_INCOMPATIBLE_OPTION_PAIR', 'Option "group" cannot be used in combination with option "' + clash + '"', 'TypeError');
            }
            const bits = DH_GROUP_NAMES[group];
            if (bits === undefined) throw keyFail('ERR_CRYPTO_UNKNOWN_DH_GROUP', 'Unknown DH group');
            /* A named group carries its own prime and generator, and a private exponent of the
               width OpenSSL gives one: the short exponent, not a full-width draw over p. */
            const ints = dhFromPrime(BigInt('0x' + MODP_GROUPS[bits]), 2n);
            const size = modulusSize(ints.p as bigint);
            return {
                public: storeKey({ type: 'public', kind, ints, publicBytes: bytesOf(ints.y as bigint, size) }),
                private: storeKey({ type: 'private', kind, ints, publicBytes: bytesOf(ints.y as bigint, size), privateBytes: minimalBytesOf(ints.x as bigint) })
            };
        }
        if (!hasPrime && !hasPrimeLength) {
            throw keyFail('ERR_MISSING_OPTION', 'At least one of the group, prime, or primeLength options is required', 'TypeError');
        }
        if (hasPrime) {
            /* A prime a caller named is bytes on the wire and a big integer here; a generator of 2
               is the default, and the exponent is the short one a fixed prime gets. */
            const ints = dhFromPrime(bigOf(bytesArg(prime)), options?.generator === undefined || options?.generator === null ? 2n : BigInt(String(options?.generator)));
            const size = modulusSize(ints.p as bigint);
            return {
                public: storeKey({ type: 'public', kind, ints, publicBytes: bytesOf(ints.y as bigint, size) }),
                private: storeKey({ type: 'private', kind, ints, publicBytes: bytesOf(ints.y as bigint, size), privateBytes: minimalBytesOf(ints.x as bigint) })
            };
        }
        if (typeof primeLength !== 'number') {
            throw keyFail('ERR_INVALID_ARG_TYPE', 'The "options.primeLength" property must be of type number. Received ' + receivedLike(primeLength), 'TypeError');
        }
        /* OpenSSL's own floor for a DH modulus, and the uncoded error it answers below it: a DH
           group needs 512 bits, which is where Node's own 'modulus too small' boundary sits. */
        if (!Number.isInteger(primeLength) || primeLength < 512) {
            throw keyFail(null, 'error:0280007E:Diffie-Hellman routines::modulus too small');
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
        /* Node carries no default curve: an 'ec' pair has to name one, and a value that is not
           even text is a type error naming 'options.namedCurve', not an unusable curve name. */
        const namedCurve = options?.namedCurve === undefined || options?.namedCurve === null ? options?.curve : options?.namedCurve;
        if (typeof namedCurve !== 'string') {
            throw keyFail('ERR_INVALID_ARG_TYPE', 'The "options.namedCurve" property must be of type string. Received ' + receivedLike(namedCurve), 'TypeError');
        }
        const curve = curveFor(options?.namedCurve ?? options?.curve ?? 'prime256v1');
        const priv = curve.curve.utils.randomPrivateKey();
        const pub = curve.curve.getPublicKey(priv, false);
        return {
            public: storeKey({ type: 'public', kind: 'ec', curve, publicBytes: pub }),
            private: storeKey({ type: 'private', kind: 'ec', curve, publicBytes: pub, privateBytes: priv })
        };
    }
    throw keyFail('ERR_INVALID_ARG_VALUE', "The argument 'type' must be a supported key type. Received '" + String(type) + "'", 'TypeError');
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

/** What OpenSSL's own decoder answers for key material it can find no decoder for. */
const decodeFail = () => keyFail('ERR_OSSL_UNSUPPORTED', 'error:1E08010C:DECODER routines::unsupported');

function importKeyMaterial(args: any): { id: number } {
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
    /*
     * A caller that asked for a private key and handed over a public one gets no key at all: Node's
     * decoder is asked for a private key and finds nothing it can decode, which is the same failure
     * as handing it garbage rather than a usable-key-of-the-wrong-kind error.
     */
    if (want === 'private' && kind === 'spki') throw decodeFail();
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

/**
 * The signature encoding a caller asked for. Node names 'der' and 'ieee-p1363' and refuses every
 * other value before it looks at the key at all -- even an Edwards key, which hashes and signs in
 * one step and never reaches an encoding -- and it prints the value the way util.inspect does.
 */
function dsaEncodingFor(value: unknown): 'der' | 'ieee-p1363' {
    if (value === undefined || value === null) return 'der';
    const name = typeof value === 'string' ? value : String(value);
    if (name !== 'der' && name !== 'ieee-p1363') {
        const shown = typeof value === 'string' ? "'" + name + "'" : typeof value === 'object' && value !== null ? JSON.stringify(value) : name;
        throw keyFail('ERR_INVALID_ARG_VALUE', "The property 'options.dsaEncoding' is invalid. Received " + shown, 'TypeError');
    }
    return name;
}

/**
 * The padding a sign or a verify runs under. Node reads the default off the key type: an
 * 'rsa-pss' key is a PSS key, so a caller who names no padding gets PSS, and one who names
 * PKCS#1 v1.5 is refused outright with OpenSSL's own words. A plain 'rsa' key defaults to v1.5
 * and takes PSS when a caller asks for it.
 */
function rsaModeFor(padding: unknown, kind: string): number {
    const named = padding === undefined || padding === null ? undefined : Number(padding);
    if (kind === 'rsa-pss') {
        if (named !== undefined && named !== RSA_PKCS1_PSS_PADDING) {
            throw keyFail('ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE', 'error:1C8000A5:Provider routines::illegal or unsupported padding mode');
        }
        return RSA_PKCS1_PSS_PADDING;
    }
    return named === RSA_PKCS1_PSS_PADDING ? RSA_PKCS1_PSS_PADDING : RSA_PKCS1_PADDING;
}

function signWith(key: KeyRecord, algorithm: unknown, data: Uint8Array, dsaEncoding?: unknown, padding?: unknown, saltLength?: unknown, fromSign = false): Uint8Array {
    const salt = saltLengthArg(saltLength);
    const encoding = dsaEncodingFor(dsaEncoding);
    if (key.type !== 'private') throw keyFail('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', 'Invalid key object type ' + key.type + ', expected private.', 'TypeError');
    /*
     * An XOF has no fixed width, so no signature scheme that needs one can run on it: an RSA or a
     * DSA key names 'digest not allowed', where an EC key answers the plainer 'invalid digest'.
     */
    if (key.kind === 'rsa' || key.kind === 'rsa-pss' || key.kind === 'dsa') {
        const named = DIGEST_SPECS[digestNameFor(algorithm === undefined || algorithm === null ? DEFAULT_DIGEST : algorithm)];
        if (named?.xof === true) throw keyFail('ERR_OSSL_DIGEST_NOT_ALLOWED', 'error:1C8000AE:Provider routines::digest not allowed');
    }
    if (key.kind === 'rsa' || key.kind === 'rsa-pss') {
        const mode = rsaModeFor(padding, key.kind);
        /*
         * A null algorithm names no digest at all: Node hands the data straight to the padding, so
         * what is signed is the PKCS#1 v1.5 block of the bytes themselves, with no DigestInfo
         * wrapped around them. crypto.sign(null, ...) is how a caller asks for that raw signature.
         */
        const name = digestNameFor(algorithm === undefined || algorithm === null ? DEFAULT_DIGEST : algorithm);
        const spec = digestFor(name);
        pssSaltFloor(salt, mode);
        return rsaSignWith(key.ints as IntKey, spec.fn(data, 0), name, mode, pssSaltLength(salt, spec.out));
    }
    if (key.kind === 'dsa') {
        /* A null algorithm signs the data as it stands, which is the digest it would have fed in. */
        return dsaSignWith(key.ints as IntKey, noDigestBytes(data, algorithm), encoding);
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
        /*
         * A digest named for a pure key is refused either way, but the two callers name it
         * differently: crypto.sign() reaches OpenSSL's own digest check, while a Sign object --
         * which cannot be built without naming an algorithm -- never gets that far and answers
         * the plainer "Unsupported crypto operation" host Node 24.15 gives it.
         */
        if (algorithm !== undefined && algorithm !== null) {
            if (fromSign) throw keyFail('ERR_CRYPTO_UNSUPPORTED_OPERATION', 'Unsupported crypto operation');
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
    const digest = noDigestBytes(data, algorithm);
        /*
         * Node's own ECDSA signature is not normalised to a low S: OpenSSL draws a nonce and takes
         * the S it gets, so about half of a host's signatures carry a high one, which is what makes
         * the DER length it emits 70, 71 or 72 bytes in the 1:2:1 the arithmetic predicts. Forcing
         * a low S here would pin it to 70 or 71 and never 72, which is a distribution a caller can
         * tell apart from the host's over a handful of signatures. Verification accepts either.
         */
        const signed = curve.curve.sign(digest, key.privateBytes as Uint8Array, { lowS: false, prehash: false, extraEntropy: randomOf(32) });
    /* 'ieee-p1363' is r||s; Node's default is the DER SEQUENCE of the two. */
    return signed.toBytes(encoding === 'ieee-p1363' ? 'compact' : 'der');
}

function verifyWith(key: KeyRecord, algorithm: unknown, data: Uint8Array, signature: Uint8Array, dsaEncoding?: unknown, padding?: unknown, saltLength?: unknown, fromVerify = false): boolean {
    const salt = saltLengthArg(saltLength);
    const encoding = dsaEncodingFor(dsaEncoding);
    if (key.type !== 'public' && key.type !== 'private') return false;
    if (key.kind === 'rsa' || key.kind === 'rsa-pss') {
        const mode = rsaModeFor(padding, key.kind);
        const name = digestNameFor(algorithm === undefined || algorithm === null ? DEFAULT_DIGEST : algorithm);
        const spec = DIGEST_SPECS[name];
        if (spec === undefined) return false;
        /* A PSS check the caller named no salt length for is AUTO, which accepts any salt. */
        pssSaltFloor(salt, mode);
        return rsaVerifyWith(key.ints as IntKey, spec.fn(data, 0), name, signature, mode, salt === undefined ? -2 : pssSaltLength(salt, spec.out));
    }
    if (key.kind === 'dsa') {
        if (algorithm !== undefined && algorithm !== null && DIGEST_SPECS[digestNameFor(algorithm)] === undefined) return false;
        return dsaVerifyWith(key.ints as IntKey, noDigestBytes(data, algorithm), signature, encoding);
    }
    if (key.kind === 'dh') return false;
    const spec = EDWARDS[key.kind];
    if (spec !== undefined) {
        if (spec.verify === undefined) return false;
        /*
         * An Edwards key is pure: it hashes and signs in one step and names no digest, so a
         * signature that asks for one is refused rather than answered false. The one-shot
         * crypto.verify reaches the digest check and names it; a Verify object, which cannot be
         * built without naming an algorithm, answers "Unsupported crypto operation" instead,
         * which is the record host Node 24.15 gives a createVerify() over an Edwards key.
         */
        if (algorithm !== undefined && algorithm !== null) {
            if (fromVerify) throw keyFail('ERR_CRYPTO_UNSUPPORTED_OPERATION', 'Unsupported crypto operation');
            throw keyFail('ERR_OSSL_INVALID_DIGEST', 'error:1C80007A:Provider routines::invalid digest');
        }
        try {
            return spec.verify(signature, data, key.publicBytes as Uint8Array);
        } catch {
            return false;
        }
    }
    const curve = key.curve as EcCurve;
    /* The digest is taken outside the catch: an XOF has no width to sign or check against, and
       that is a refusal Node raises -- 'invalid digest' -- not a signature that fails to check. */
    const digest = noDigestBytes(data, algorithm);
    /*
     * A Verify object parses the signature in the encoding it was asked for, and a pair that is
     * not exactly two coordinates wide is not an 'ieee-p1363' pair at all, so Node refuses it
     * with 'Malformed signature' instead of answering false -- the one throw in a verify that
     * otherwise only ever answers a boolean. The one-shot crypto.verify answers false for the
     * very same pair, which is the asymmetry the fromVerify flag exists to carry, and a 'der'
     * parse is never malformed: an unparseable SEQUENCE is simply false.
     */
    if (fromVerify === true && encoding === 'ieee-p1363' && signature.length !== curve.size * 2) {
        throw keyFail('ERR_CRYPTO_OPERATION_FAILED', 'Malformed signature');
    }
    try {
        /*
         * Node parses the signature in the encoding it was asked for, and @noble would accept
         * either: a 64-byte r||s pair is not a DER SEQUENCE and a DER SEQUENCE is not 64 bytes,
         * so naming the format keeps a compact signature false under the 'der' default the way
         * it is on the host instead of letting the auto-detecting parse pass it.
         */
        const format = encoding === 'ieee-p1363' ? 'compact' : 'der';
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

const DH_STATE = new Map<number, { prime: bigint; generator: bigint; size: number; privateKey?: bigint; publicKey?: bigint; generated?: boolean }>();
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

/**
 * The bits OpenSSL's DH_check answers, which Node reports as a DiffieHellman's `verifyError`:
 * P_NOT_PRIME for a modulus that is not one, P_NOT_SAFE_PRIME for a prime whose (p-1)/2 is not
 * one, NOT_SUITABLE_GENERATOR for a generator that squares to 1 -- or that is out of the range
 * a generator has to sit in -- and the 128 Node adds for every modulus under OpenSSL's own
 * 512-bit floor. Measured against host Node 24.15 over the primes below 100 and the MODP groups.
 */
function dhVerifyError(prime: bigint, generator: bigint): number {
    const bits = prime.toString(2).length;
    let code = bits < 512 ? 128 : 0;
    /* Trial division first: it is what catches a composite modulus without a single exponentiation. */
    let composite = prime < 2n;
    if (!composite) {
        for (const small of SIEVE_PRIMES) {
            if (prime === BigInt(small)) break;
            if (prime % BigInt(small) === 0n) {
                composite = true;
                break;
            }
        }
    }
    if (composite || !isProbablePrime(prime, bits >= 4096 ? 1 : bits >= 1024 ? 4 : 8)) return code | 1;
    const sub = (prime - 1n) >> 1n;
    if (sub < 2n || !isProbablePrime(sub, bits >= 4096 ? 1 : bits >= 1024 ? 4 : 8)) code |= 2;
    if (generator <= 1n || generator >= prime || modPow(generator, 2n, prime) === 1n) code |= 8;
    return code;
}

/** `generated`: whether OpenSSL made these parameters, which is when it also fixes the width of
 *  the private exponent. A prime a caller hands in, or a named MODP group, has no such width. */
function storeDh(state: { prime: bigint; generator: bigint; size: number; generated?: boolean }): number {
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
 * a full-width one. Measured against host Node 24.15 by generateKeys() on createDiffieHellman(L)
 * for L from 512 to 2560: the exponent is 125 bits at 512, 150 from 600, 175 from 950, 200 from
 * 1150, 225 from 1700 and 250 from 2560, and the same size always answers the same width, so the
 * top bit really is forced rather than left to the draw.
 */
const DH_EXPONENT_BITS: ReadonlyArray<readonly [number, number]> = [
    [8192, 400], [6144, 376], [4096, 320], [3072, 280], [2560, 250], [2048, 225],
    [1700, 225], [1536, 200], [1150, 200], [950, 175], [600, 150], [512, 125]
];

function randomExponent(prime: bigint, generated: boolean): bigint {
    const primeBits = prime.toString(2).length;
    let bits = primeBits - 1;
    /* Only a group OpenSSL generated carries the shorter exponent: a prime a caller named, or a
       standard MODP group, gets one drawn over the prime's whole width. */
    if (generated) {
        for (const [at, width] of DH_EXPONENT_BITS) {
            if (primeBits >= at) {
                bits = Math.min(width, primeBits - 1);
                break;
            }
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

/** The prime for a size: a fresh probable prime of exactly that width, which is what Node's own
 *  generator answers. Node never falls back to a standard group here, however closely one matches
 *  the size asked for, and a width the generator refuses is an argument error rather than a
 *  fallback. The search is the sieved one, so a 1024-bit prime takes a second, not a minute. */
function primeOfBits(bits: number): bigint {
    if (!Number.isInteger(bits)) {
        throw dhFail('ERR_OUT_OF_RANGE', 'The value of "sizeOrKey" is out of range. It must be an integer. Received ' + String(bits), 'RangeError');
    }
    /* Two bits or fewer is no modulus at all, and OpenSSL names that before it generates. */
    if (bits <= 1) throw dhFail('ERR_OSSL_DH_MODULUS_TOO_SMALL', 'error:0280007E:Diffie-Hellman routines::modulus too small');
    /* Below OpenSSL's own 512-bit floor for a generated modulus, generation fails outright. */
    if (bits < 512) throw dhFail('ERR_INVALID_ARG_VALUE', 'Invalid DH parameters', 'TypeError');
    if (bits > 4096) {
        throw dhFail('ERR_OUT_OF_RANGE', 'The value of "primeLength" is out of range. It must be >= 8 && <= 4096. Received ' + String(bits), 'RangeError');
    }
    /*
     * A generated modulus is a safe prime, p = 2q+1 with q prime, which is what OpenSSL's own
     * DH_generate_parameters writes and what makes DH_check report 0 for it. Node's DiffieHellman
     * is refused a key pair when the check fails, so a plain prime would leave generateKeys()
     * throwing 'Key generation failed' for every group this call made.
     */
    return 2n * searchPrime(bits - 1, { safe: true }) + 1n;
}

/** The generator: the caller's number or bytes, 2 when the caller names none (as Node defaults). */
function generatorOf(value: unknown, asNumber: unknown): bigint {
    if (value === undefined || value === null) return 2n;
    if (asNumber === true) {
        const g = BigInt(Math.trunc(Number(value)));
        /* A generator of 1 generates nothing, and OpenSSL names it before it makes a group; a
           zero is the 'no generator' Node reads as its own default of 2. */
        if (g === 1n) throw dhFail('ERR_OSSL_DH_BAD_GENERATOR', 'error:02800065:Diffie-Hellman routines::bad generator');
        return g < 2n ? 2n : g;
    }
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
        /* Node's OpenSSL cannot HMAC through an XOF either: it fails with an empty error string,
           and with no code at all, which is what keyFail(null, ...) leaves on the error. */
        if (spec.xof === true) throw keyFail(null, 'error:00000000:lib(0)::reason(0)');
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
        const spec = hkdfDigestFor(args?.algorithm);
        const keylen = Number(args?.keylen);
        if (!Number.isInteger(keylen) || keylen <= 0 || keylen > 255 * spec.out) {
            /* Node bounds the length with a RangeError and names the value it was handed. */
            throw keyFail('ERR_OUT_OF_RANGE', 'The value of "keylen" is out of range. It must be > 0 && <= ' + 255 * spec.out + '. Received ' + String(args?.keylen), 'RangeError');
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
    'crypto.cipher.update': (args) => {
        const state = stateFor(args?.id, 'update');
        /* An OCB cipher opened with a tag length of 0 takes no data at all, which is the same
           'unsupported state' OpenSSL's own OCB answers once it has refused to seal anything. */
        if (state.spec.mode === 'ocb' && state.tagLength === 0) {
            throw cipherFail(null, 'Trying to add data in unsupported state');
        }
        return bytesToBase64(cipherUpdate(state, bytesArg(args?.data)));
    },
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
        /*
         * OCB is the one AEAD here that takes its associated data at any time and in any number
         * of pieces: OpenSSL appends each call's bytes to the ones before it, so two calls of
         * 'x' and 'y' are the AAD 'xy', and the order against update() does not change the tag
         * (OCB keeps the data's own offset chain and the AAD's own PMAC apart). A cipher opened
         * with a tag length of 0 is the exception: it takes no AAD at all.
         */
        const ocb = state.spec.mode === 'ocb';
        if (ocb) {
            if (state.tagLength === 0) invalidState('setAAD');
        } else if (!state.spec.aead || state.updated) {
            invalidState('setAAD');
        }
        /* Node refuses associated data for CCM outright: it asks for a plaintextLength it has no
           way to supply from here, so the message is the one OpenSSL's CCM cannot take. */
        if (state.spec.mode === 'ccm') {
            throw cipherFail('ERR_MISSING_ARGS', 'options.plaintextLength required for CCM mode with AAD', 'TypeError');
        }
        /* A second call appends, which is what OpenSSL does for GCM and OCB both. */
        state.aad = concatBytes(state.aad, bytesArg(args?.aad));
        return true;
    },
    /** Args {id, tag}: the authentication tag a decrypting AEAD cipher checks its input against.
     *  Node takes only a tag of the length the cipher was opened with and names the one it got. */
    'crypto.cipher.setAuthTag': (args) => {
        const state = stateFor(args?.id, 'setAuthTag');
        if (!state.spec.aead) invalidState('setAuthTag');
        const tag = bytesArg(args?.tag);
        if (tag.length !== state.tagLength) {
            throw cipherFail('ERR_CRYPTO_INVALID_AUTH_TAG', `Invalid authentication tag length: ${tag.length}`, 'TypeError');
        }
        state.tag = tag;
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
            if (key.pss !== undefined) details = { ...details, ...key.pss };
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
        /* PKCS#1 is the RSA pair of formats: an RSAPublicKey, and an RSAPrivateKey of its own. */
        const rsaPkcs1 = kind === 'pkcs1' && (key.kind === 'rsa' || key.kind === 'rsa-pss');
        if (key.type === 'public') {
            if (rsaPkcs1) {
                der = rsaPublicDer(key.ints as IntKey);
                label = 'RSA PUBLIC KEY';
            } else if (kind !== 'spki') {
                throw keyFail('ERR_CRYPTO_INVALID_KEY_TYPE', 'Unsupported public key format: ' + kind);
            } else {
                der = encodeSpki(key);
                label = 'PUBLIC KEY';
            }
        } else if (rsaPkcs1) {
            der = rsaPrivateDer(key.ints as IntKey);
            label = 'RSA PRIVATE KEY';
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
    /** Args {bytes, format, type, passphrase, want}: imports a key and returns its handle. */
    'crypto.key.import': (args) => {
        /*
         * Material Node cannot decode is one error, whatever went wrong inside the parse: its
         * OpenSSL decoder finds no decoder for it at all and answers 'DECODER routines::unsupported',
         * so the particular reason this runtime's own parser reached is folded into that answer.
         * A key that is decoded but is the wrong kind -- an encrypted one with no passphrase, say --
         * keeps its own error, because that one the host does name.
         */
        try {
            return importKeyMaterial(args);
        } catch (error) {
            const code = (error as { code?: unknown } | null)?.code;
            if (code === undefined || code === 'ERR_CRYPTO_INVALID_KEYPAIR' || code === 'ERR_CRYPTO_INVALID_KEY_TYPE') throw decodeFail();
            throw error;
        }
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
    'crypto.key.sign': (args) => bytesToBase64(signWith(keyFor(args?.id, 'key.sign'), args?.algorithm, bytesArg(args?.data), args?.dsaEncoding, args?.padding, args?.saltLength, args?.fromSign === true)),
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
        /* Node names this argument "size", and bounds it by what an int32 can hold, not by two. */
        if (!Number.isInteger(bits) || bits < 1 || bits > 2147483647) {
            throw keyFail('ERR_OUT_OF_RANGE', 'The value of "size" is out of range. It must be >= 1 && <= 2147483647. Received ' + String(args?.bits), 'RangeError');
        }
        const safe = args?.safe === true;
        for (let attempt = 0; attempt < 100000; attempt++) {
            const candidate = randomPrime(bits);
            if (safe && !isProbablePrime((candidate - 1n) / 2n, 8)) continue;
            return { bytes: bytesToBase64(bytesOf(candidate, Math.ceil(bits / 8))), value: candidate.toString() };
        }
        throw keyFail('ERR_CRYPTO_INVALID_STATE', 'Could not find a prime of ' + bits + ' bits');
    },    /** Args {id, algorithm, data, signature, dsaEncoding, padding, saltLength}: whether it checks out. */
    'crypto.key.verify': (args) => verifyWith(keyFor(args?.id, 'key.verify'), args?.algorithm, bytesArg(args?.data), bytesArg(args?.signature), args?.dsaEncoding, args?.padding, args?.saltLength, args?.fromVerify === true),

    /* -----------------------------------------------------------------------------------------
     * Diffie-Hellman.
     * -------------------------------------------------------------------------------------- */

    /** Args {bits, generator, generatorIsNumber} or {prime, generator, generatorIsNumber}: a handle. */
    'crypto.dh.create': (args) => {
        const prime = args?.prime === undefined || args?.prime === null
            ? primeOfBits(Number(args?.bits))
            : bigOf(bytesArg(args?.prime));
        /*
         * An empty prime is the one group OpenSSL accepts and then has no p for: construction
         * succeeds and only reading the prime back answers, with 'p is null'.
         */
        const empty = !(args?.prime === undefined || args?.prime === null) && bytesArg(args?.prime).length === 0;
        if (!empty && prime < 3n) throw dhFail('ERR_CRYPTO_INVALID_DH_PARAMETERS', 'Invalid prime');
        const generator = generatorOf(args?.generator, args?.generatorIsNumber);
        const size = Math.ceil(prime.toString(16).length / 2);
        return { id: storeDh({ prime, generator, size, generated: args?.prime === undefined || args?.prime === null }) };
    },
    /** Args {name}: a standard MODP group by name; returns a handle. */
    'crypto.dh.group': (args) => {
        const bits = DH_GROUP_NAMES[String(args?.name ?? '')];
        if (bits === undefined) throw dhFail('ERR_CRYPTO_UNKNOWN_DH_GROUP', 'Unknown DH group');
        const prime = BigInt('0x' + MODP_GROUPS[bits]);
        return { id: storeDh({ prime, generator: 2n, size: Math.ceil(prime.toString(16).length / 2), generated: false }) };
    },
    /** Args {id}: the prime and generator, as base64, with the byte size both are padded to. */
    'crypto.dh.info': (args) => {
        const state = dhFor(args?.id, 'dh.info');
        /* The group an empty prime left behind has no p to read, which is what Node reports. */
        if (state.prime === 0n) throw dhFail('ERR_CRYPTO_INVALID_STATE', 'p is null');
        return {
            prime: bytesToBase64(bytesOf(state.prime, state.size)),
            generator: bytesToBase64(bytesOf(state.generator, 1)),
            size: state.size
        };
    },
    /** Args {id}: the key pair this side uses; returns {public, private} as base64. */
    'crypto.dh.keys': (args) => {
        const state = dhFor(args?.id, 'dh.keys');
        /* Node runs the group through DH_check before it makes a key pair from it and refuses
           outright when the check names anything at all -- a modulus too small, one that is not
           prime, one that is not a safe prime, or a generator that does not generate. */
        if (dhVerifyError(state.prime, state.generator) !== 0) {
            throw dhFail('ERR_CRYPTO_OPERATION_FAILED', 'Key generation failed');
        }
        /* The public half is always derived from the private one: Node's generateKeys() computes
           g^private mod p even when a public key was set by hand beforehand, so a caller who set
           one and then asked for a pair gets the one that belongs to the private key it chose. */
        if (state.privateKey === undefined) state.privateKey = randomExponent(state.prime, state.generated === true);
        state.publicKey = modPow(state.generator, state.privateKey, state.prime);
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
        const given = bytesArg(args?.public);
        const other = bigOf(given);
        /*
         * Node sizes the peer's key against this side's prime before it exponentiates: a key with
         * no bytes at all is 'too small', and one the prime cannot hold -- a longer buffer, or a
         * value up at the prime itself -- is 'too large', both of them ERR_CRYPTO_INVALID_KEYLEN
         * RangeErrors rather than the 'invalid public key' a key in range but out of bounds gets.
         */
        if (given.length === 0 || other < 2n) throw dhFail('ERR_CRYPTO_INVALID_KEYLEN', 'Supplied key is too small', 'RangeError');
        /* Node rejects a peer key at the prime itself, or in a buffer longer than the prime, as
           'too large' before it exponentiates. */
        if (other >= (state.prime as bigint) - 1n) throw dhFail('ERR_CRYPTO_INVALID_KEYLEN', 'Supplied key is too large', 'RangeError');
        return bytesToBase64(bytesOf(modPow(other, state.privateKey, state.prime), state.size));
    },
    /** Args {id, op, data, padding, oaepHash, oaepLabel}: one raw RSA operation; base64 bytes. */
    'crypto.rsa.raw': (args) => bytesToBase64(rsaRawWith(
        keyFor(args?.id, 'rsa.raw'),
        String(args?.op ?? ''),
        bytesArg(args?.data),
        args?.padding,
        args?.oaepHash,
        typeof args?.oaepLabel === 'string' ? bytesArg(args?.oaepLabel) : new Uint8Array(0)
    )),
    /** Args {id}: the DH_check bits; read when a caller asks a DiffieHellman for `verifyError`. */
    'crypto.dh.verify': (args) => {
        const state = dhFor(args?.id, 'dh.verify');
        return { code: dhVerifyError(state.prime, state.generator) };
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
        /* Node names both key types when it cannot agree between them, in the order it was handed
           them: 'x25519 and ec', 'x25519 and rsa', and even 'ed25519 and ed25519'. */
        const dhIncompatible = (): never =>
            keyFail('ERR_CRYPTO_INCOMPATIBLE_KEY', `Incompatible key types for Diffie-Hellman: ${priv.kind} and ${pub.kind}`);
        if (priv.type !== 'private') throw keyFail('ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', `Invalid key object type ${priv.type}, expected private.`, 'TypeError');
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
        if (pub.kind !== priv.kind) throw dhIncompatible();
        if (priv.kind === 'ec') {
            const curve = priv.curve as EcCurve;
            if (curve !== (pub.curve as EcCurve)) throw keyFail('ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS', 'Incompatible curves');
            /* Node hands back the x-coordinate alone, which is what follows the 0x04 point header. */
            const point = curve.curve.getSharedSecret(priv.privateBytes as Uint8Array, pub.publicBytes as Uint8Array, false);
            return bytesToBase64(point.subarray(1, 1 + curve.size));
        }
        const spec = EDWARDS[priv.kind];
        /* ed25519 and ed448 sign and do not agree: Node names the two types it was handed rather
           than the 'operation not supported for this keytype' the pair would give on its own. */
        if (spec === undefined || spec.getSharedSecret === undefined) throw dhIncompatible();
        return bytesToBase64(spec.getSharedSecret(priv.privateBytes as Uint8Array, pub.publicBytes as Uint8Array));
    },
};
