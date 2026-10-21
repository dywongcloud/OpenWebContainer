/**
 * Guest-side byte codecs (utf-8, base64, hex, latin1, utf16le). Plain JavaScript
 * executed inside the QuickJS context; shared by buffer, util and fs.
 * Written as a String.raw snippet: no backticks and no template interpolation.
 */
export const CODEC_SRC = String.raw`
var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeUtf8(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    } else if (c >= 0xd800 && c <= 0xdfff) {
      c = 0xfffd;
    }
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return new Uint8Array(out);
}

function isCont(b) {
  return b !== undefined && (b & 0xc0) === 0x80;
}

function decodeUtf8(bytes, start, end) {
  var i = start || 0;
  var stop = end === undefined ? bytes.length : end;
  var parts = [];
  while (i < stop) {
    var b = bytes[i];
    if (b < 0x80) {
      parts.push(String.fromCharCode(b));
      i++;
      continue;
    }
    var need = 0;
    var cp = 0;
    var lower = 0x80;
    var upper = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      if (b === 0xe0) lower = 0xa0;
      if (b === 0xed) upper = 0x9f;
      need = 2;
      cp = b & 0x0f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      if (b === 0xf0) lower = 0x90;
      if (b === 0xf4) upper = 0x8f;
      need = 3;
      cp = b & 0x07;
    } else {
      parts.push('\ufffd');
      i++;
      continue;
    }
    i++;
    var seen = 0;
    var valid = true;
    while (seen < need) {
      if (i >= stop) {
        valid = false;
        break;
      }
      var c = bytes[i];
      if (c < lower || c > upper) {
        valid = false;
        break;
      }
      lower = 0x80;
      upper = 0xbf;
      cp = (cp << 6) | (c & 0x3f);
      seen++;
      i++;
    }
    if (!valid) {
      parts.push('\ufffd');
      continue;
    }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      parts.push(String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)));
    } else {
      parts.push(String.fromCharCode(cp));
    }
  }
  return parts.join('');
}

var B64_PAIRS = null;
var B64_DEC = null;

/* Two base64 characters per 12 bits, built once: encoding then concatenates two short strings
   per three bytes instead of pushing one character at a time into an array as long as the output. */
function b64Pairs() {
  if (B64_PAIRS !== null) return B64_PAIRS;
  var p = new Array(4096);
  for (var i = 0; i < 4096; i++) p[i] = B64_ALPHABET.charAt(i >> 6) + B64_ALPHABET.charAt(i & 63);
  B64_PAIRS = p;
  return p;
}

/* Character code to its 6-bit value, -1 for anything that is not base64: decoding then looks a
   character up instead of scanning the 64-character alphabet for every one of them. */
function b64DecTable() {
  if (B64_DEC !== null) return B64_DEC;
  var t = new Array(256);
  for (var i = 0; i < 256; i++) t[i] = -1;
  for (var j = 0; j < 64; j++) t[B64_ALPHABET.charCodeAt(j)] = j;
  t[45] = 62;
  t[95] = 63;
  B64_DEC = t;
  return t;
}

function encodeBase64(bytes) {
  var p = b64Pairs();
  var len = bytes.length;
  var rem = len % 3;
  var full = len - rem;
  var parts = [];
  var part = '';
  var groups = 0;
  var i = 0;
  var n;
  while (i < full) {
    n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    part += p[n >> 12] + p[n & 4095];
    i += 3;
    if (++groups === 1024) { parts.push(part); part = ''; groups = 0; }
  }
  if (rem === 1) {
    n = bytes[i] << 16;
    part += p[n >> 12] + '==';
  } else if (rem === 2) {
    n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    part += p[n >> 12] + B64_ALPHABET.charAt((n >> 6) & 63) + '=';
  }
  parts.push(part);
  return parts.join('');
}

function decodeBase64(str) {
  var t = b64DecTable();
  var len = str.length;
  var out = new Uint8Array(((len + 3) >> 2) * 3);
  var o = 0;
  var i = 0;
  /* Four whole characters at a time, while every one of them is a base64 character. */
  var limit = len - 3;
  while (i < limit) {
    var a = str.charCodeAt(i);
    var b = str.charCodeAt(i + 1);
    var c = str.charCodeAt(i + 2);
    var d = str.charCodeAt(i + 3);
    if (a > 255 || b > 255 || c > 255 || d > 255) break;
    var v0 = t[a];
    var v1 = t[b];
    var v2 = t[c];
    var v3 = t[d];
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) break;
    var n = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
    i += 4;
  }
  /* The rest: padding, newlines and url-safe characters, one character at a time. */
  var buf = 0;
  var bits = 0;
  for (; i < len; i++) {
    var code = str.charCodeAt(i);
    var v = code < 256 ? t[code] : -1;
    if (v < 0) continue;
    buf = ((buf << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

function encodeHex(bytes) {
  var out = [];
  for (var i = 0; i < bytes.length; i++) {
    out.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16));
  }
  return out.join('');
}

function decodeHex(str) {
  var out = [];
  for (var i = 0; i + 1 < str.length; i += 2) {
    var v = parseInt(str.substr(i, 2), 16);
    if (isNaN(v)) break;
    out.push(v);
  }
  return new Uint8Array(out);
}

function normalizeEncoding(enc) {
  var e = String(enc === undefined || enc === null ? 'utf8' : enc).toLowerCase();
  if (e === 'utf-8') return 'utf8';
  if (e === 'binary') return 'latin1';
  if (e === 'utf-16le' || e === 'ucs2' || e === 'ucs-2') return 'utf16le';
  return e;
}

function encodeString(str, enc) {
  var e = normalizeEncoding(enc);
  if (e === 'utf8') return encodeUtf8(str);
  if (e === 'hex') return decodeHex(str);
  if (e === 'base64' || e === 'base64url') return decodeBase64(str);
  if (e === 'latin1' || e === 'ascii') {
    var l = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) l[i] = str.charCodeAt(i) & 0xff;
    return l;
  }
  if (e === 'utf16le') {
    var u = new Uint8Array(str.length * 2);
    for (var j = 0; j < str.length; j++) {
      var code = str.charCodeAt(j);
      u[j * 2] = code & 0xff;
      u[j * 2 + 1] = code >> 8;
    }
    return u;
  }
  throw new TypeError('Unknown encoding: ' + enc);
}

function decodeBytes(bytes, enc, start, end) {
  var e = normalizeEncoding(enc);
  var s = start || 0;
  var t = end === undefined ? bytes.length : end;
  if (e === 'utf8') return decodeUtf8(bytes, s, t);
  var view = bytes.subarray ? bytes.subarray(s, t) : bytes.slice(s, t);
  if (e === 'hex') return encodeHex(view);
  if (e === 'base64') return encodeBase64(view);
  if (e === 'base64url') return encodeBase64(view).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (e === 'latin1') {
    var l = [];
    for (var i = 0; i < view.length; i++) l.push(String.fromCharCode(view[i]));
    return l.join('');
  }
  if (e === 'ascii') {
    var a = [];
    for (var k = 0; k < view.length; k++) a.push(String.fromCharCode(view[k] & 0x7f));
    return a.join('');
  }
  if (e === 'utf16le') {
    var w = [];
    for (var m = 0; m + 1 < view.length; m += 2) w.push(String.fromCharCode(view[m] | (view[m + 1] << 8)));
    return w.join('');
  }
  throw new TypeError('Unknown encoding: ' + enc);
}
`;
