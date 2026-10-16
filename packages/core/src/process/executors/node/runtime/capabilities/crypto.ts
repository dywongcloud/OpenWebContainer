import { hmac } from '@noble/hashes/hmac';
import { md5 } from '@noble/hashes/legacy';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha1 } from '@noble/hashes/sha1';
import { sha224, sha256 } from '@noble/hashes/sha256';
import { sha384, sha512 } from '@noble/hashes/sha512';
import { base64ToBytes, bytesToBase64 } from '../../../../../network/virtual/host-http';
import { CapabilityHandler } from './types';

/*
 * Host side of the guest's crypto hashing. createHash, createHmac and pbkdf2Sync run on the host's
 * synchronous hash functions (@noble/hashes), so a digest is one blocking capability call.
 * Bytes travel as base64 because capability arguments are JSON.
 */

type Digest = typeof sha256;

const DIGESTS: Record<string, Digest> = { md5, sha1, sha224, sha256, sha384, sha512 };

function digestFor(name: unknown): Digest {
    const digest = DIGESTS[String(name ?? '').toLowerCase()];
    if (digest === undefined) {
        throw Object.assign(new Error('Digest method not supported'), { code: 'ERR_OSSL_EVP_UNSUPPORTED' });
    }
    return digest;
}

const bytesArg = (value: unknown): Uint8Array => base64ToBytes(typeof value === 'string' ? value : '');

export const CRYPTO_CAPABILITIES: Record<string, CapabilityHandler> = {
    /** Args {algorithm, data}: the digest of the bytes; returns base64. */
    'crypto.digest': (args) => bytesToBase64(digestFor(args?.algorithm)(bytesArg(args?.data))),
    /** Args {algorithm, key, data}: the HMAC of the bytes; returns base64. */
    'crypto.hmac': (args) => bytesToBase64(hmac(digestFor(args?.algorithm), bytesArg(args?.key), bytesArg(args?.data))),
    /** Args {digest, password, salt, iterations, keylen}: the derived key; returns base64. */
    'crypto.pbkdf2': (args) => bytesToBase64(pbkdf2(digestFor(args?.digest), bytesArg(args?.password), bytesArg(args?.salt), {
        c: Number(args?.iterations),
        dkLen: Number(args?.keylen)
    })),
};
