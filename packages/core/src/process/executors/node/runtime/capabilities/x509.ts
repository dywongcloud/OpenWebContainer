import { sha1 } from '@noble/hashes/sha1';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { base64ToBytes, bytesToBase64 } from '../../../../../network/virtual/host-http';
import { CapabilityHandler } from './types';

/*
 * Host side of the guest's `crypto.X509Certificate` (Node 24.15).
 *
 * One DER certificate goes in; every value Node's getters answer with comes out as JSON-serialisable
 * data: byte fields as base64 (`raw`, the public key's SPKI, the legacy `raw`/`pubkey`), dates as ISO
 * strings, and the string forms Node builds through OpenSSL (`subject`, `subjectAltName`,
 * `infoAccess`, `validFrom`, the three fingerprints) exactly as host Node prints them.
 *
 * Two of Node's getters are not values and so are not reproduced here:
 *   - checkHost / checkEmail / checkIP need the caller's name, not the certificate, so `san` carries
 *     the parsed GeneralNames for the guest to match against itself.
 *   - checkPrivateKey / verify need a real key pair check. `publicKey.spki` and the `tbs` plus
 *     `signature` bytes are enough for the guest to reach the host's key capabilities instead.
 *
 * The ASN.1 work is its own minimal DER reader. There is a second one, older and larger, inside
 * ../guest/modules/tls-engine.ts, but that file is a `String.raw` ES5 snippet evaluated inside the
 * QuickJS guest (var, no BigInt, no imports) and can be reached from a host capability only by
 * re-evaluating the whole TLS engine, so the fields Node names are read again here, in TypeScript.
 */

/* ---------------------------------------------------------------------------------------------
 * Errors. Node's own ones, measured against host 24.15: a DER blob that is not a certificate is
 * answered with "no start line", while a PEM block whose body decodes to something else is an
 * ASN.1 error. Each carries a library and a reason; {code, message} is what the guest rebuilds.
 * ------------------------------------------------------------------------------------------ */

type X509FailureKind = 'noStartLine' | 'wrongTag' | 'tooLong' | 'badBase64';

const FAILURES: Record<X509FailureKind, { code: string; message: string; library: string; reason: string }> = {
    noStartLine: {
        code: 'ERR_OSSL_PEM_NO_START_LINE',
        message: 'error:0480006C:PEM routines::no start line',
        library: 'PEM routines',
        reason: 'no start line'
    },
    wrongTag: {
        code: 'ERR_OSSL_ASN1_WRONG_TAG',
        message: 'error:068000A8:asn1 encoding routines::wrong tag',
        library: 'asn1 encoding routines',
        reason: 'wrong tag'
    },
    tooLong: {
        code: 'ERR_OSSL_ASN1_TOO_LONG',
        message: 'error:0680009B:asn1 encoding routines::too long',
        library: 'asn1 encoding routines',
        reason: 'too long'
    },
    badBase64: {
        code: 'ERR_OSSL_PEM_BAD_BASE64_DECODE',
        message: 'error:04800064:PEM routines::bad base64 decode',
        library: 'PEM routines',
        reason: 'bad base64 decode'
    }
};

function x509Fail(kind: X509FailureKind): Error {
    const spec = FAILURES[kind];
    return Object.assign(new Error(spec.message), { code: spec.code, library: spec.library, reason: spec.reason });
}

/** Node answers this one for anything it cannot read as one X.509 certificate. */
const notACertificate = (): Error => x509Fail('noStartLine');

/* ---------------------------------------------------------------------------------------------
 * DER. Only the primitive tags a certificate carries, and only definite lengths.
 * ------------------------------------------------------------------------------------------ */

interface Tlv {
    tag: number;
    start: number;
    vStart: number;
    vEnd: number;
    end: number;
}

function tlvAt(bytes: Uint8Array, at: number, limit: number): Tlv {
    if (at + 2 > limit) throw notACertificate();
    const tag = bytes[at];
    /* A multi-byte tag number is legal BER but never appears in a certificate. */
    if ((tag & 0x1f) === 0x1f) throw notACertificate();
    let at2 = at + 1;
    let length = bytes[at2++];
    if (length & 0x80) {
        const count = length & 0x7f;
        /* 0x80 is the indefinite form, which DER forbids. */
        if (count === 0 || count > 4 || at2 + count > limit) throw notACertificate();
        length = 0;
        for (let i = 0; i < count; i++) length = length * 256 + bytes[at2++];
    }
    if (at2 + length > limit) throw notACertificate();
    return { tag, start: at, vStart: at2, vEnd: at2 + length, end: at2 + length };
}

const childrenOf = (bytes: Uint8Array, from: number, to: number): Tlv[] => {
    const out: Tlv[] = [];
    let at = from;
    while (at < to) {
        const part = tlvAt(bytes, at, to);
        out.push(part);
        at = part.end;
    }
    return out;
};

/** One TLV covering the whole buffer; the tag is checked because every structure here is fixed. */
function onlyTlv(bytes: Uint8Array, tag: number): Tlv {
    const part = tlvAt(bytes, 0, bytes.length);
    if (part.tag !== tag) throw notACertificate();
    return part;
}

function oidRange(bytes: Uint8Array, from: number, to: number): string {
    const parts: number[] = [];
    let value = 0;
    let first = true;
    for (let at = from; at < to; at++) {
        value = value * 128 + (bytes[at] & 0x7f);
        if ((bytes[at] & 0x80) === 0) {
            if (first) {
                const top = value < 80 ? Math.floor(value / 40) : 2;
                parts.push(top, value - top * 40);
                first = false;
            } else {
                parts.push(value);
            }
            value = 0;
        }
    }
    return parts.join('.');
}

function oidText(bytes: Uint8Array, node: Tlv): string {
    if (node.tag !== 0x06) throw notACertificate();
    return oidRange(bytes, node.vStart, node.vEnd);
}

/** The magnitude of an INTEGER: its content bytes with the sign padding dropped. */
function integerBytes(bytes: Uint8Array, node: Tlv): Uint8Array {
    let at = node.vStart;
    while (node.vEnd - at > 1 && bytes[at] === 0) at++;
    return bytes.subarray(at, node.vEnd);
}

function smallInteger(bytes: Uint8Array, node: Tlv): number {
    let value = 0;
    for (let at = node.vStart; at < node.vEnd; at++) value = value * 256 + bytes[at];
    return value;
}

const bitStringBytes = (bytes: Uint8Array, node: Tlv): Uint8Array => bytes.subarray(node.vStart + 1, node.vEnd);

/* ---------------------------------------------------------------------------------------------
 * Text. Certificate strings are PrintableString, UTF8String, IA5String (SAN dNSName, email, URI,
 * AIA), T61String, BMPString and the rest; Node decodes each as OpenSSL does.
 * ------------------------------------------------------------------------------------------ */

const latin1Of = (bytes: Uint8Array, from: number, to: number): string => {
    let out = '';
    for (let at = from; at < to; at++) out += String.fromCharCode(bytes[at]);
    return out;
};

const utf8Of = (bytes: Uint8Array, from: number, to: number): string => new TextDecoder().decode(bytes.subarray(from, to));

function bmpOf(bytes: Uint8Array, from: number, to: number): string {
    let out = '';
    for (let at = from; at + 1 < to; at += 2) out += String.fromCharCode((bytes[at] << 8) | bytes[at + 1]);
    return out;
}

function universalOf(bytes: Uint8Array, from: number, to: number): string {
    let out = '';
    for (let at = from; at + 3 < to; at += 4) {
        out += String.fromCodePoint((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
    }
    return out;
}

function stringOf(bytes: Uint8Array, node: Tlv): string {
    if (node.tag === 0x0c) return utf8Of(bytes, node.vStart, node.vEnd);
    if (node.tag === 0x1e) return bmpOf(bytes, node.vStart, node.vEnd);
    if (node.tag === 0x1c) return universalOf(bytes, node.vStart, node.vEnd);
    return latin1Of(bytes, node.vStart, node.vEnd);
}

/* ---------------------------------------------------------------------------------------------
 * Object identifiers.
 * ------------------------------------------------------------------------------------------ */

/** OpenSSL's short names, the ones X509_NAME_print_ex writes on the left of the '='. */
const ATTRIBUTE_SHORT_NAMES: Record<string, string> = {
    '2.5.4.3': 'CN',
    '2.5.4.4': 'SN',
    '2.5.4.5': 'serialNumber',
    '2.5.4.6': 'C',
    '2.5.4.7': 'L',
    '2.5.4.8': 'ST',
    '2.5.4.9': 'street',
    '2.5.4.10': 'O',
    '2.5.4.11': 'OU',
    '2.5.4.12': 'title',
    '2.5.4.13': 'description',
    '2.5.4.14': 'searchGuide',
    '2.5.4.15': 'businessCategory',
    '2.5.4.16': 'postalAddress',
    '2.5.4.17': 'postalCode',
    '2.5.4.18': 'postOfficeBox',
    '2.5.4.19': 'physicalDeliveryOfficeName',
    '2.5.4.20': 'telephoneNumber',
    '2.5.4.21': 'telexNumber',
    '2.5.4.22': 'teletexTerminalIdentifier',
    '2.5.4.23': 'facsimileTelephoneNumber',
    '2.5.4.24': 'x121Address',
    '2.5.4.25': 'internationalISDNNumber',
    '2.5.4.26': 'registeredAddress',
    '2.5.4.27': 'destinationIndicator',
    '2.5.4.28': 'preferredDeliveryMehtod',
    '2.5.4.29': 'presentationAddress',
    '2.5.4.30': 'supportedApplicationContext',
    '2.5.4.31': 'member',
    '2.5.4.32': 'owner',
    '2.5.4.33': 'roleOccupant',
    '2.5.4.34': 'seeAlso',
    '2.5.4.35': 'userPassword',
    '2.5.4.36': 'userCertificate',
    '2.5.4.37': 'caCertificate',
    '2.5.4.38': 'authorityRevocationList',
    '2.5.4.39': 'certificateRevocationList',
    '2.5.4.40': 'crossCertificatePair',
    '2.5.4.41': 'name',
    '2.5.4.42': 'GN',
    '2.5.4.43': 'initials',
    '2.5.4.44': 'generationQualifier',
    '2.5.4.45': 'x500UniqueIdentifier',
    '2.5.4.46': 'dnQualifier',
    '2.5.4.47': 'enhancedSearchGuide',
    '2.5.4.48': 'protocolInformation',
    '2.5.4.49': 'distinguishedName',
    '2.5.4.50': 'uniqueMember',
    '2.5.4.51': 'houseIdentifier',
    '2.5.4.52': 'supportedAlgorithms',
    '2.5.4.53': 'deltaRevocationList',
    '2.5.4.54': 'dmdName',
    '2.5.4.65': 'pseudonym',
    '2.5.4.97': 'organizationIdentifier',
    '1.2.840.113549.1.9.1': 'emailAddress',
    '0.9.2342.19200300.100.1.1': 'UID',
    '0.9.2342.19200300.100.1.25': 'DC',
    '1.3.6.1.4.1.311.60.2.1.1': 'jurisdictionL',
    '1.3.6.1.4.1.311.60.2.1.2': 'jurisdictionST',
    '1.3.6.1.4.1.311.60.2.1.3': 'jurisdictionC'
};

/** OpenSSL's long names for the signature algorithms, which is what signatureAlgorithm answers. */
const SIGNATURE_NAMES: Record<string, string> = {
    '1.2.840.113549.1.1.2': 'md2WithRSAEncryption',
    '1.2.840.113549.1.1.3': 'md4WithRSAEncryption',
    '1.2.840.113549.1.1.4': 'md5WithRSAEncryption',
    '1.2.840.113549.1.1.5': 'sha1WithRSAEncryption',
    '1.2.840.113549.1.1.14': 'sha224WithRSAEncryption',
    '1.2.840.113549.1.1.11': 'sha256WithRSAEncryption',
    '1.2.840.113549.1.1.12': 'sha384WithRSAEncryption',
    '1.2.840.113549.1.1.13': 'sha512WithRSAEncryption',
    '1.2.840.113549.1.1.15': 'sha512-224WithRSAEncryption',
    '1.2.840.113549.1.1.16': 'sha512-256WithRSAEncryption',
    '1.2.840.113549.1.1.10': 'rsassaPss',
    '1.2.840.10040.4.3': 'dsa-with-sha1',
    '2.16.840.1.101.3.4.3.1': 'dsa_with_sha224',
    '2.16.840.1.101.3.4.3.2': 'dsa_with_sha256',
    '1.2.840.10045.4.1': 'ecdsa-with-SHA1',
    '1.2.840.10045.4.3.1': 'ecdsa-with-SHA1',
    '1.2.840.10045.4.3.2': 'ecdsa-with-SHA256',
    '1.2.840.10045.4.3.3': 'ecdsa-with-SHA384',
    '1.2.840.10045.4.3.4': 'ecdsa-with-SHA512',
    '1.3.101.112': 'ED25519',
    '1.3.101.113': 'ED448'
};

/** The labels OpenSSL's authorityInfoAccess printing puts before each location. */
const ACCESS_METHOD_LABELS: Record<string, string> = {
    '1.3.6.1.5.5.7.48.1': 'OCSP',
    '1.3.6.1.5.5.7.48.2': 'CA Issuers',
    '1.3.6.1.5.5.7.48.3': 'Time Stamping',
    '1.3.6.1.5.5.7.48.4': 'DVCS',
    '1.3.6.1.5.5.7.48.5': 'CA Repository',
    '1.3.6.1.5.5.7.48.11': 'Signed Object Timestamp'
};

const OID_RSA = '1.2.840.113549.1.1.1';
const OID_RSA_PSS = '1.2.840.113549.1.1.10';
const OID_EC = '1.2.840.10045.2.1';
const OID_ED25519 = '1.3.101.112';
const OID_ED448 = '1.3.101.113';
const OID_X25519 = '1.3.101.110';
const OID_X448 = '1.3.101.111';
const OID_DSA = '1.2.840.10040.4.1';

/** The named curves Node names on both sides: the ASN.1 name, the NIST name and the field size. */
const CURVES: Record<string, { asn1: string; nist?: string; bits: number }> = {
    '1.2.840.10045.3.1.7': { asn1: 'prime256v1', nist: 'P-256', bits: 256 },
    '1.3.132.0.34': { asn1: 'secp384r1', nist: 'P-384', bits: 384 },
    '1.3.132.0.35': { asn1: 'secp521r1', nist: 'P-521', bits: 521 },
    '1.3.132.0.10': { asn1: 'secp256k1', bits: 256 },
    '1.2.840.10045.3.1.1': { asn1: 'prime192v1', nist: 'P-192', bits: 192 },
    '1.3.132.0.33': { asn1: 'secp224r1', nist: 'P-224', bits: 224 },
    '1.3.132.0.36': { asn1: 'sect163k1', nist: 'K-163', bits: 163 },
    '1.2.840.10045.3.0.1': { asn1: 'c2tnb191v1', bits: 191 }
};

/* ---------------------------------------------------------------------------------------------
 * Names.
 * ------------------------------------------------------------------------------------------ */

interface NameEntry {
    oid: string;
    key: string;
    value: string;
}

/*
 * RFC 2253 escaping, which is what X509_NAME_print_ex writes under XN_FLAG_MULTILINE: the seven
 * punctuation characters, a leading '#' or space and a trailing space, each with a backslash.
 * '/', '=' and non-ASCII characters are left alone, which is why "Weird, Inc./Ltd" prints as
 * "Weird\, Inc./Ltd".
 */
function escapeNameValue(value: string): string {
    let out = '';
    for (let at = 0; at < value.length; at++) {
        const char = value[at];
        const needsEscape =
            char === ',' || char === '+' || char === '"' || char === '\\' || char === '<' || char === '>' || char === ';';
        if (needsEscape) out += '\\' + char;
        else if (at === 0 && (char === '#' || char === ' ')) out += '\\' + char;
        else if (at === value.length - 1 && char === ' ') out += '\\' + char;
        else out += char;
    }
    return out;
}

interface ParsedName {
    entries: NameEntry[];
    /** Node's `subject`: "SN=value" lines in certificate order, or undefined for an empty name. */
    text: string | undefined;
    /** Node's toLegacyObject().subject: one key per short name, an array when a name repeats. */
    object: Record<string, string | string[]>;
}

function parseName(bytes: Uint8Array, node: Tlv): ParsedName {
    const entries: NameEntry[] = [];
    const object: Record<string, string | string[]> = {};
    for (const rdn of childrenOf(bytes, node.vStart, node.vEnd)) {
        for (const attribute of childrenOf(bytes, rdn.vStart, rdn.vEnd)) {
            const pair = childrenOf(bytes, attribute.vStart, attribute.vEnd);
            if (pair.length < 2) continue;
            const oid = oidText(bytes, pair[0]);
            const value = stringOf(bytes, pair[1]);
            const key = ATTRIBUTE_SHORT_NAMES[oid] ?? oid;
            entries.push({ oid, key, value });
            const seen = object[key];
            if (seen === undefined) object[key] = value;
            else if (Array.isArray(seen)) seen.push(value);
            else object[key] = [seen, value];
        }
    }
    return {
        entries,
        text: entries.length === 0 ? undefined : entries.map((entry) => entry.key + '=' + escapeNameValue(entry.value)).join('\n'),
        object
    };
}

/** The RFC 2253 form, reversed and comma separated, which is what a DirName in a SAN prints as. */
function nameRfc2253(name: ParsedName): string {
    const parts: string[] = [];
    for (let at = name.entries.length - 1; at >= 0; at--) {
        parts.push(name.entries[at].key + '=' + escapeNameValue(name.entries[at].value));
    }
    return parts.join(',');
}

/* ---------------------------------------------------------------------------------------------
 * Times, hex, addresses.
 * ------------------------------------------------------------------------------------------ */

/** ASN1_TIME_print: "Jan  1 00:00:00 2020 GMT", with the day padded to two with a leading space. */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function timeText(at: number): string {
    const date = new Date(at);
    const day = String(date.getUTCDate()).padStart(2, ' ');
    const pad = (value: number): string => String(value).padStart(2, '0');
    return (
        MONTH_NAMES[date.getUTCMonth()] +
        ' ' +
        day +
        ' ' +
        pad(date.getUTCHours()) +
        ':' +
        pad(date.getUTCMinutes()) +
        ':' +
        pad(date.getUTCSeconds()) +
        ' ' +
        String(date.getUTCFullYear()).padStart(4, '0') +
        ' GMT'
    );
}

function timeAt(bytes: Uint8Array, node: Tlv): number {
    const text = latin1Of(bytes, node.vStart, node.vEnd);
    if (node.tag === 0x17) {
        const parts = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(text);
        if (parts === null) throw notACertificate();
        const two = Number(parts[1]);
        const year = two < 50 ? 2000 + two : 1900 + two;
        return Date.UTC(year, Number(parts[2]) - 1, Number(parts[3]), Number(parts[4]), Number(parts[5]), parts[6] === undefined ? 0 : Number(parts[6]));
    }
    const parts = /^(\d\d\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(?:\.\d+)?Z$/.exec(text);
    if (parts === null) throw notACertificate();
    return Date.UTC(
        Number(parts[1]),
        Number(parts[2]) - 1,
        Number(parts[3]),
        Number(parts[4]),
        Number(parts[5]),
        parts[6] === undefined ? 0 : Number(parts[6])
    );
}

const HEX = '0123456789ABCDEF';

const hexUpper = (bytes: Uint8Array): string => {
    let out = '';
    for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 0x0f];
    return out;
};

/** X509_digest's colon separated upper case form, which is what the three fingerprints are. */
const hexFingerprint = (bytes: Uint8Array): string => Array.from(bytes, (byte) => HEX[byte >> 4] + HEX[byte & 0x0f]).join(':');

/** BN_bn2hex: the magnitude, no sign, no leading zeros, padded to a whole number of bytes. */
function bnHex(bytes: Uint8Array): string {
    let at = 0;
    while (at < bytes.length - 1 && bytes[at] === 0) at++;
    let out = hexUpper(bytes.subarray(at));
    if (out.length === 0) return '0';
    if (out.length % 2 !== 0) out = '0' + out;
    return out;
}

const bitLengthOf = (bytes: Uint8Array): number => {
    if (bytes.length === 0) return 0;
    let top = bytes[0];
    let bits = 0;
    while (top !== 0) {
        bits++;
        top >>= 1;
    }
    return (bytes.length - 1) * 8 + bits;
};

/** OpenSSL prints an IPv6 address as eight uncompressed upper case hex groups. */
function ipText(bytes: Uint8Array): string {
    if (bytes.length === 4) return Array.from(bytes).join('.');
    if (bytes.length === 16) {
        const groups: string[] = [];
        /* A group carries no leading zeros in the text OpenSSL prints: 2001:DB8:0:0:0:0:0:42,
           not 2001:0DB8:0000:0000:0000:0000:0000:0042. */
        for (let at = 0; at < 16; at += 2) groups.push((((bytes[at] << 8) | bytes[at + 1]) >>> 0).toString(16).toUpperCase());
        return groups.join(':');
    }
    return '<invalid>';
}

/** The PEM Node's toString and toJSON answer with: 64 character lines and LF, never CRLF. */
function pemCertificate(der: Uint8Array): string {
    const body = bytesToBase64(der);
    let out = '-----BEGIN CERTIFICATE-----\n';
    for (let at = 0; at < body.length; at += 64) out += body.slice(at, at + 64) + '\n';
    return out + '-----END CERTIFICATE-----\n';
}

/* ---------------------------------------------------------------------------------------------
 * Extensions.
 * ------------------------------------------------------------------------------------------ */

const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_INFO_ACCESS = '1.3.6.1.5.5.7.1.1';

const KEY_USAGE_NAMES = [
    'digitalSignature',
    'nonRepudiation',
    'keyEncipherment',
    'dataEncipherment',
    'keyAgreement',
    'keyCertSign',
    'cRLSign',
    'encipherOnly',
    'decipherOnly'
];

interface GeneralName {
    type: string;
    value: string;
    /** The raw address bytes, for the IP entries a caller wants to match itself. */
    ip?: Uint8Array;
}

/**
 * OpenSSL's GENERAL_NAME_print: a prefix per name type, and "othername:<unsupported>" for the two
 * types it will not render.
 */
function generalNameOf(bytes: Uint8Array, node: Tlv): GeneralName {
    const kind = node.tag & 0x1f;
    if (node.tag === 0x82) return { type: 'DNS', value: latin1Of(bytes, node.vStart, node.vEnd) };
    if (node.tag === 0x87) {
        const address = bytes.subarray(node.vStart, node.vEnd);
        return { type: 'IP Address', value: ipText(address), ip: address };
    }
    if (node.tag === 0x81) return { type: 'email', value: latin1Of(bytes, node.vStart, node.vEnd) };
    if (node.tag === 0x86) return { type: 'URI', value: latin1Of(bytes, node.vStart, node.vEnd) };
    if (kind === 4 && (node.tag & 0x20) !== 0) {
        const inner = childrenOf(bytes, node.vStart, node.vEnd)[0];
        return { type: 'DirName', value: inner === undefined ? '' : nameRfc2253(parseName(bytes, inner)) };
    }
    /* A registeredID is an OID under a context tag, so its content is read past the tag. */
    if (kind === 8) return { type: 'Registered ID', value: oidRange(bytes, node.vStart, node.vEnd) };
    if (kind === 0) return { type: 'othername', value: '<unsupported>' };
    if (kind === 3) return { type: 'X400Name', value: '<unsupported>' };
    if (kind === 5) return { type: 'EdiPartyName', value: '<unsupported>' };
    return { type: 'other', value: '<unsupported>' };
}

/*
 * A SAN entry whose text holds a comma is quoted, and inside the quotes the comma becomes ,,
 * so the comma separated list stays parseable. Only DirName entries have ever been seen quoted.
 */
function sanText(prefixValue: string, value: string): string {
    if (!/[,]/.test(value)) return prefixValue + value;
    const quoted = '"' + value.replace(/[\\"]/g, (char) => '\\' + char).replace(/,/g, '\\u002c') + '"';
    return prefixValue + quoted;
}

interface InfoAccessEntry {
    label: string;
    value: string;
}

/* ---------------------------------------------------------------------------------------------
 * Public keys.
 * ------------------------------------------------------------------------------------------ */

interface PublicKeyInfo {
    spki: Uint8Array;
    asymmetricKeyType: string | undefined;
    asymmetricKeyDetails: Record<string, string | number>;
    /** RSA only. */
    modulus?: Uint8Array;
    exponent?: Uint8Array;
    /** EC only. */
    curve?: { asn1: string; nist?: string; bits: number };
    /** EC only: the point bytes, which is what the legacy object's pubkey holds for a curve. */
    point?: Uint8Array;
}

function parsePublicKey(bytes: Uint8Array, node: Tlv): PublicKeyInfo {
    const spki = bytes.subarray(node.start, node.end);
    const parts = childrenOf(bytes, node.vStart, node.vEnd);
    if (parts.length === 0) throw notACertificate();
    const algorithm = childrenOf(bytes, parts[0].vStart, parts[0].vEnd);
    if (algorithm.length === 0) throw notACertificate();
    const oid = oidText(bytes, algorithm[0]);
    if (parts.length < 2) throw notACertificate();
    const keyBytes = bitStringBytes(bytes, parts[1]);

    if (oid === OID_RSA || oid === OID_RSA_PSS) {
        const sequence = onlyTlv(keyBytes, 0x30);
        const numbers = childrenOf(keyBytes, sequence.vStart, sequence.vEnd);
        if (numbers.length < 2) throw notACertificate();
        const modulus = integerBytes(keyBytes, numbers[0]);
        const exponent = integerBytes(keyBytes, numbers[1]);
        return {
            spki,
            asymmetricKeyType: 'rsa',
            asymmetricKeyDetails: { modulusLength: bitLengthOf(modulus), publicExponent: decimalText(exponent) },
            modulus,
            exponent
        };
    }
    if (oid === OID_EC && algorithm.length > 1 && algorithm[1].tag === 0x06) {
        const curve = CURVES[oidText(bytes, algorithm[1])];
        if (curve === undefined) return { spki, asymmetricKeyType: 'ec', asymmetricKeyDetails: {} };
        const details: Record<string, string | number> = { namedCurve: curve.asn1 };
        return { spki, asymmetricKeyType: 'ec', asymmetricKeyDetails: details, curve, point: keyBytes };
    }
    if (oid === OID_ED25519 || oid === OID_ED448) {
        return { spki, asymmetricKeyType: oid === OID_ED25519 ? 'ed25519' : 'ed448', asymmetricKeyDetails: {} };
    }
    if (oid === OID_X25519 || oid === OID_X448) {
        return { spki, asymmetricKeyType: oid === OID_X25519 ? 'x25519' : 'x448', asymmetricKeyDetails: {} };
    }
    if (oid === OID_DSA) return { spki, asymmetricKeyType: 'dsa', asymmetricKeyDetails: {} };
    return { spki, asymmetricKeyType: undefined, asymmetricKeyDetails: {} };
}

/** Node's asymmetricKeyDetails.publicExponent is a bigint; this is its decimal text. */
function decimalText(bytes: Uint8Array): string {
    const digits: number[] = [0];
    for (const byte of bytes) {
        let carry = byte;
        for (let at = 0; at < digits.length; at++) {
            const value = digits[at] * 256 + carry;
            digits[at] = value % 10;
            carry = Math.floor(value / 10);
        }
        while (carry > 0) {
            digits.push(carry % 10);
            carry = Math.floor(carry / 10);
        }
    }
    let out = '';
    for (let at = digits.length - 1; at >= 0; at--) out += String(digits[at]);
    return out.replace(/^0+(?=\d)/, '');
}

/** The canonical hex of a number: no leading zeros at all, lower case, as "0x10001". */
function canonicalHex(bytes: Uint8Array): string {
    let at = 0;
    while (at < bytes.length - 1 && bytes[at] === 0) at++;
    const out = hexUpper(bytes.subarray(at)).toLowerCase();
    return out.replace(/^0+(?=\d)/, '');
}

/* ---------------------------------------------------------------------------------------------
 * The certificate.
 * ------------------------------------------------------------------------------------------ */

interface ParsedCertificate {
    der: Uint8Array;
    tbs: Uint8Array;
    version: number;
    serial: Uint8Array;
    signatureOid: string;
    signature: Uint8Array;
    subject: ParsedName;
    issuer: ParsedName;
    notBefore: number;
    notAfter: number;
    publicKey: PublicKeyInfo;
    san: GeneralName[] | undefined;
    basicConstraints: { ca: boolean; pathLen: number } | undefined;
    keyUsage: string[] | undefined;
    extendedKeyUsage: string[] | undefined;
    infoAccess: InfoAccessEntry[] | undefined;
}

function parseCertificate(der: Uint8Array): ParsedCertificate {
    const top = onlyTlv(der, 0x30);
    const parts = childrenOf(der, top.vStart, top.vEnd);
    if (parts.length !== 3) throw notACertificate();
    const tbsParts = childrenOf(der, parts[0].vStart, parts[0].vEnd);
    if (tbsParts.length < 6) throw notACertificate();

    let at = 0;
    let version = 1;
    if (tbsParts[0].tag === 0xa0) {
        const inside = childrenOf(der, tbsParts[0].vStart, tbsParts[0].vEnd);
        if (inside.length === 0) throw notACertificate();
        version = smallInteger(der, inside[0]) + 1;
        at = 1;
    }
    if (tbsParts.length < at + 6) throw notACertificate();
    /* TBSCertificate: serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo,
       then the two optional unique IDs and the [3] extensions. */
    const serialNode = tbsParts[at++];
    const issuerNode = tbsParts[at + 1];
    const validityNode = tbsParts[at + 2];
    const subjectNode = tbsParts[at + 3];
    const keyNode = tbsParts[at + 4];

    const validity = childrenOf(der, validityNode.vStart, validityNode.vEnd);
    if (validity.length < 2) throw notACertificate();
    const signatureParts = childrenOf(der, parts[1].vStart, parts[1].vEnd);
    if (signatureParts.length === 0) throw notACertificate();

    const certificate: ParsedCertificate = {
        der: der.subarray(top.start, top.end),
        tbs: der.subarray(parts[0].start, parts[0].end),
        version,
        serial: integerBytes(der, serialNode),
        signatureOid: oidText(der, signatureParts[0]),
        signature: bitStringBytes(der, parts[2]),
        subject: parseName(der, subjectNode),
        issuer: parseName(der, issuerNode),
        notBefore: timeAt(der, validity[0]),
        notAfter: timeAt(der, validity[1]),
        publicKey: parsePublicKey(der, keyNode),
        san: undefined,
        basicConstraints: undefined,
        keyUsage: undefined,
        extendedKeyUsage: undefined,
        infoAccess: undefined
    };

    for (let index = at + 5; index < tbsParts.length; index++) {
        if (tbsParts[index].tag !== 0xa3) continue;
        const wrapper = childrenOf(der, tbsParts[index].vStart, tbsParts[index].vEnd);
        if (wrapper.length === 0) continue;
        readExtensions(der, wrapper[0], certificate);
    }
    return certificate;
}

function readExtensions(bytes: Uint8Array, node: Tlv, certificate: ParsedCertificate): void {
    for (const extension of childrenOf(bytes, node.vStart, node.vEnd)) {
        const fields = childrenOf(bytes, extension.vStart, extension.vEnd);
        if (fields.length === 0) continue;
        const oid = oidText(bytes, fields[0]);
        const body = fields[fields.length - 1];
        if (oid === OID_SUBJECT_ALT_NAME) {
            const names = onlyTlv(bytes.subarray(body.vStart, body.vEnd), 0x30);
            const inner = bytes.subarray(body.vStart, body.vEnd);
            certificate.san = childrenOf(inner, names.vStart, names.vEnd).map((name) => generalNameOf(inner, name));
        } else if (oid === OID_BASIC_CONSTRAINTS) {
            const inner = bytes.subarray(body.vStart, body.vEnd);
            const parts = onlyTlv(inner, 0x30);
            const constraints = { ca: false, pathLen: -1 };
            for (const part of childrenOf(inner, parts.vStart, parts.vEnd)) {
                if (part.tag === 0x01) constraints.ca = inner[part.vStart] !== 0;
                else if (part.tag === 0x02) constraints.pathLen = smallInteger(inner, part);
            }
            certificate.basicConstraints = constraints;
        } else if (oid === OID_KEY_USAGE) {
            const inner = bytes.subarray(body.vStart, body.vEnd);
            const bits = onlyTlv(inner, 0x03);
            const names: string[] = [];
            for (let index = 0; index < KEY_USAGE_NAMES.length; index++) {
                const at = bits.vStart + 1 + Math.floor(index / 8);
                const bit = at < bits.vEnd ? (inner[at] >> (7 - (index % 8))) & 1 : 0;
                if (bit !== 0) names.push(KEY_USAGE_NAMES[index]);
            }
            certificate.keyUsage = names;
        } else if (oid === OID_EXT_KEY_USAGE) {
            const inner = bytes.subarray(body.vStart, body.vEnd);
            const list = onlyTlv(inner, 0x30);
            certificate.extendedKeyUsage = childrenOf(inner, list.vStart, list.vEnd).map((entry) => oidText(inner, entry));
        } else if (oid === OID_INFO_ACCESS) {
            const inner = bytes.subarray(body.vStart, body.vEnd);
            const list = onlyTlv(inner, 0x30);
            const entries: InfoAccessEntry[] = [];
            for (const description of childrenOf(inner, list.vStart, list.vEnd)) {
                const pair = childrenOf(inner, description.vStart, description.vEnd);
                if (pair.length < 2) continue;
                const method = oidText(inner, pair[0]);
                const label = ACCESS_METHOD_LABELS[method] ?? method;
                const location = generalNameOf(inner, pair[1]);
                entries.push({ label: label + ' - ' + location.type, value: location.value });
            }
            certificate.infoAccess = entries;
        }
    }
}

/* ---------------------------------------------------------------------------------------------
 * Node's shapes.
 * ------------------------------------------------------------------------------------------ */

/**
 * X509_check_ca on OpenSSL 3.6: a keyUsage without keyCertSign rules the certificate out first,
 * then basicConstraints decides, and a version 1 certificate -- which can carry no extensions --
 * counts as a CA. A self signed certificate with no basicConstraints is not one.
 */
function isCertificateAuthority(certificate: ParsedCertificate): boolean {
    if (certificate.keyUsage !== undefined && !certificate.keyUsage.includes('keyCertSign')) return false;
    if (certificate.basicConstraints !== undefined) return certificate.basicConstraints.ca;
    return certificate.version === 1;
}

/** The AuthorityInfoAccess text Node prints: one "label: value" per line, no trailing newline. */
function infoAccessText(entries: InfoAccessEntry[]): string {
    return entries.map((entry) => entry.label + ':' + entry.value).join('\n');
}

/** Node splits that text back into an object with the same regular expression (internal/tls/common). */
function infoAccessObject(text: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    text.replace(/([^\n:]*):([^\n]*)(?:\n|$)/g, (_all: string, key: string, value: string) => {
        let rest = value;
        if (rest.charCodeAt(0) === 0x22) {
            try {
                rest = JSON.parse(rest) as string;
            } catch {
                /* The value was not a JSON string after all; Node keeps it as it is. */
            }
        }
        if (key in out) out[key].push(rest);
        else out[key] = [rest];
        return '';
    });
    return out;
}

function legacyObject(certificate: ParsedCertificate): Record<string, unknown> {
    const key = certificate.publicKey;
    const isRsa = key.asymmetricKeyType === 'rsa' && key.modulus !== undefined;
    const isEc = key.asymmetricKeyType === 'ec' && key.curve !== undefined;
    return {
        subject: certificate.subject.object,
        issuer: certificate.issuer.object,
        subjectaltname: subjectAltNameText(certificate),
        infoAccess: certificate.infoAccess === undefined ? undefined : infoAccessObject(infoAccessText(certificate.infoAccess)),
        ca: isCertificateAuthority(certificate),
        modulus: isRsa && key.modulus !== undefined ? hexUpper(key.modulus) : undefined,
        exponent: isRsa && key.exponent !== undefined ? '0x' + canonicalHex(key.exponent) : undefined,
        /* An RSA key reaches the legacy object as its SubjectPublicKeyInfo, a curve key as the
           point bytes alone, and any other key not at all. */
        pubkey: isRsa ? bytesToBase64(key.spki) : isEc && key.point !== undefined ? bytesToBase64(key.point) : undefined,
        bits: isRsa && key.modulus !== undefined ? bitLengthOf(key.modulus) : isEc && key.curve !== undefined ? key.curve.bits : undefined,
        valid_from: timeText(certificate.notBefore),
        valid_to: timeText(certificate.notAfter),
        fingerprint: hexFingerprint(sha1(certificate.der)),
        fingerprint256: hexFingerprint(sha256(certificate.der)),
        fingerprint512: hexFingerprint(sha512(certificate.der)),
        ext_key_usage: certificate.extendedKeyUsage === undefined ? undefined : certificate.extendedKeyUsage.slice(),
        serialNumber: bnHex(certificate.serial),
        raw: bytesToBase64(certificate.der),
        asn1Curve: isEc && key.curve !== undefined ? key.curve.asn1 : undefined,
        nistCurve: isEc && key.curve !== undefined ? key.curve.nist : undefined
    };
}

function subjectAltNameText(certificate: ParsedCertificate): string | undefined {
    if (certificate.san === undefined) return undefined;
    return certificate.san.map((name) => sanText(name.type + ':', name.value)).join(', ');
}

/* ---------------------------------------------------------------------------------------------
 * The exported parser.
 * ------------------------------------------------------------------------------------------ */

/**
 * Every value host Node 24.15's `crypto.X509Certificate` exposes, for one DER certificate.
 *
 * Byte fields are base64 (raw, publicKey.spki, toLegacyObject().raw and .pubkey) and dates are ISO
 * strings (validFromDate, validToDate). A getter Node answers with `undefined` -- an empty subject,
 * a certificate with no subjectAltName, no authorityInfoAccess or no extendedKeyUsage, and always
 * `issuerCertificate` -- is `undefined` here too, so a JSON round trip of this object matches a
 * JSON round trip of Node's own getters key for key.
 *
 * Extras Node has no getter for, each one thing the guest needs and cannot compute again:
 * `keyUsageNames` is the real keyUsage extension (Node's `keyUsage` answers the extended key usage
 * OIDs), `san` is the parsed subjectAltName for the guest's own checkHost/checkEmail/checkIP, and
 * `tbs` plus `signature` are what a signature check needs.
 *
 * Throws an Error carrying `code`, `library` and `reason` for a blob that is not a certificate.
 */
export function parseX509(der: Uint8Array): Record<string, unknown> {
    const bytes = der instanceof Uint8Array ? der : new Uint8Array(der as ArrayLike<number>);
    const certificate = parseCertificate(bytes);
    const pem = pemCertificate(certificate.der);
    const key = certificate.publicKey;
    return {
        raw: bytesToBase64(certificate.der),
        pem,
        subject: certificate.subject.text,
        subjectAltName: subjectAltNameText(certificate),
        issuer: certificate.issuer.text,
        /* Node fills this only for a certificate it took out of a TLS peer chain; a certificate
           built from a buffer never has one, however many certificates the buffer holds. */
        issuerCertificate: undefined,
        infoAccess: certificate.infoAccess === undefined ? undefined : infoAccessText(certificate.infoAccess),
        validFrom: timeText(certificate.notBefore),
        validFromDate: new Date(certificate.notBefore).toISOString(),
        validTo: timeText(certificate.notAfter),
        validToDate: new Date(certificate.notAfter).toISOString(),
        fingerprint: hexFingerprint(sha1(certificate.der)),
        fingerprint256: hexFingerprint(sha256(certificate.der)),
        fingerprint512: hexFingerprint(sha512(certificate.der)),
        /* Node's keyUsage answers the extendedKeyUsage OIDs; keyUsageNames carries the extension. */
        keyUsage: certificate.extendedKeyUsage === undefined ? undefined : certificate.extendedKeyUsage.slice(),
        keyUsageNames: certificate.keyUsage === undefined ? undefined : certificate.keyUsage.slice(),
        serialNumber: bnHex(certificate.serial),
        signatureAlgorithm: SIGNATURE_NAMES[certificate.signatureOid] ?? certificate.signatureOid,
        signatureAlgorithmOid: certificate.signatureOid,
        publicKey: {
            type: 'public',
            asymmetricKeyType: key.asymmetricKeyType,
            asymmetricKeyDetails: key.asymmetricKeyDetails,
            spki: bytesToBase64(key.spki)
        },
        ca: isCertificateAuthority(certificate),
        toJSON: pem,
        toLegacyObject: legacyObject(certificate),
        san:
            certificate.san === undefined
                ? undefined
                : certificate.san.map((name) => ({ type: name.type, value: name.value })),
        version: certificate.version,
        tbs: bytesToBase64(certificate.tbs),
        signature: bytesToBase64(certificate.signature)
    };
}

/* ---------------------------------------------------------------------------------------------
 * Capabilities.
 * ------------------------------------------------------------------------------------------ */

/** The first CERTIFICATE block of a PEM. Throws Node's own error for a body that is not one. */
function derFromPem(text: string): Uint8Array {
    const block = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
    /* A block under any other label, and text with no block at all, are the same to Node. */
    if (block === null) throw x509Fail('noStartLine');
    if (block[1] !== 'CERTIFICATE' && block[1] !== 'X509 CERTIFICATE' && block[1] !== 'TRUSTED CERTIFICATE') {
        throw x509Fail('noStartLine');
    }
    const body = block[2].replace(/\s+/g, '');
    if (body.length === 0 || body.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(body)) throw x509Fail('badBase64');
    let der: Uint8Array;
    try {
        der = base64ToBytes(body);
    } catch {
        throw x509Fail('badBase64');
    }
    checkPemBody(der);
    return der;
}

/**
 * The shape of the body before it is parsed: one TLV that fills it exactly. A body that declares
 * more than it holds is "too long"; anything else that is not one whole element is a wrong tag.
 */
function checkPemBody(der: Uint8Array): void {
    if (der.length < 2) throw x509Fail('wrongTag');
    let at = 2;
    let length = der[1];
    if (length & 0x80) {
        const count = length & 0x7f;
        if (count === 0 || count > 4 || 2 + count > der.length) throw x509Fail('wrongTag');
        length = 0;
        for (let i = 0; i < count; i++) length = length * 256 + der[2 + i];
        at = 2 + count;
    }
    if (at + length !== der.length) throw x509Fail(at + length > der.length ? 'tooLong' : 'wrongTag');
}

function derFromArgs(args: any): Uint8Array {
    const der = args?.der;
    if (typeof der === 'string') {
        /* Node's constructor takes either encoding, and a PEM is text before it is bytes. */
        return der.indexOf('-----BEGIN') === -1 ? base64ToBytes(der) : derFromPem(der);
    }
    if (typeof args?.pem === 'string') return derFromPem(args.pem);
    const badType = (): Error =>
        Object.assign(new Error('The "der" argument must be of type string, Buffer, TypedArray, or DataView.'), {
            code: 'ERR_INVALID_ARG_TYPE'
        });
    if (der === null || der === undefined || typeof der !== 'object') throw badType();
    const bytes = (der as { data?: number[] }).data ?? der;
    if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) throw badType();
    return der instanceof Uint8Array ? der : new Uint8Array(bytes as ArrayLike<number>);
}

/** What the guest turns back into the Error Node throws: its code, message, library and reason. */
function failureOf(error: unknown): Record<string, unknown> {
    const failure = error as { code?: string; message?: string; library?: string; reason?: string };
    const code = typeof failure?.code === 'string' ? failure.code : 'ERR_CRYPTO_INVALID_CERTIFICATE';
    return {
        code,
        message: typeof failure?.message === 'string' ? failure.message : String(failure),
        library: failure?.library,
        reason: failure?.reason
    };
}

export const X509_CAPABILITIES: Record<string, CapabilityHandler> = {
    /** Args {der: base64} (or {pem}); returns parseX509's fields, or {code, message} on failure. */
    'crypto.x509.parse': (args) => {
        let der: Uint8Array;
        let fromPem = false;
        try {
            fromPem = typeof args?.der === 'string' ? args.der.indexOf('-----BEGIN') !== -1 : typeof args?.pem === 'string';
            der = derFromArgs(args);
        } catch (error) {
            return failureOf(error);
        }
        try {
            return parseX509(der);
        } catch (error) {
            /* A PEM body Node has already accepted as one element but cannot read as a certificate
               is answered with "wrong tag", not with the "no start line" a raw DER blob gets. */
            return failureOf(fromPem ? x509Fail('wrongTag') : error);
        }
    }
};
