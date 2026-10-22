/**
 * Guest-side `buffer` (Buffer on a Uint8Array prototype chain) and `fs` built-ins.
 * fs is sync-first over the host bridge; callback and promise forms wrap the sync
 * implementation. Plain JavaScript inside a String.raw snippet.
 */
export const BUFFER_FS_SRC = String.raw`
BF.buffer = function () {
  function Buffer(arg, encodingOrOffset, length) {
    /*
     * Node's deprecated Buffer(size) / new Buffer(size): a number is a byte count, not a value to
     * copy, and it allocates zero-filled as Buffer.alloc does. tar 2.2.2 (a tar-pack dependency, on
     * the create-react-app path) allocates its end-of-archive marker with new Buffer(512), so a
     * number here is a length. Buffer.from keeps rejecting it: from() has never taken a size.
     */
    if (typeof arg === 'number') return Buffer.alloc(arg);
    return Buffer.from(arg, encodingOrOffset, length);
  }
  Buffer.prototype = Object.create(Uint8Array.prototype);
  Buffer.prototype.constructor = Buffer;

  function wrapBytes(bytes) {
    Object.setPrototypeOf(bytes, Buffer.prototype);
    return bytes;
  }

  Buffer.from = function (value, encodingOrOffset, length) {
    if (typeof value === 'string') return wrapBytes(encodeString(value, encodingOrOffset || 'utf8'));
    if (value instanceof ArrayBuffer) {
      var offset = encodingOrOffset || 0;
      var len = length === undefined ? value.byteLength - offset : length;
      return wrapBytes(new Uint8Array(value, offset, len));
    }
    if (ArrayBuffer.isView(value)) {
      var copy = new Uint8Array(value.byteLength);
      copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return wrapBytes(copy);
    }
    if (Array.isArray(value)) {
      var arr = new Uint8Array(value.length);
      for (var i = 0; i < value.length; i++) arr[i] = value[i] & 0xff;
      return wrapBytes(arr);
    }
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
    throw new TypeError('The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array');
  };

  Buffer.alloc = function (size, fill, encoding) {
    var bytes = wrapBytes(new Uint8Array(size));
    if (fill !== undefined && fill !== 0) bytes.fill(fill, 0, size, encoding);
    return bytes;
  };
  Buffer.allocUnsafe = Buffer.alloc;
  Buffer.allocUnsafeSlow = Buffer.alloc;

  Buffer.isBuffer = function (value) {
    return value instanceof Buffer;
  };
  Buffer.isEncoding = function (encoding) {
    var known = ['utf8', 'utf-8', 'hex', 'base64', 'base64url', 'ascii', 'latin1', 'binary', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le'];
    return typeof encoding === 'string' && known.indexOf(encoding.toLowerCase()) >= 0;
  };
  Buffer.byteLength = function (value, encoding) {
    if (typeof value === 'string') return encodeString(value, encoding || 'utf8').length;
    return value.byteLength;
  };
  Buffer.concat = function (list, totalLength) {
    var total = 0;
    for (var i = 0; i < list.length; i++) total += list[i].length;
    var size = totalLength === undefined ? total : totalLength;
    var out = wrapBytes(new Uint8Array(size));
    var pos = 0;
    for (var j = 0; j < list.length && pos < size; j++) {
      var chunk = list[j];
      var take = Math.min(chunk.length, size - pos);
      /* set() copies the piece in one go; an element at a time costs a loop iteration per byte,
         which is what made joining the chunks of a large body the slowest thing in a read. */
      if (take > 0 && typeof chunk.subarray === 'function') out.set(take === chunk.length ? chunk : chunk.subarray(0, take), pos);
      else for (var k = 0; k < take; k++) out[pos + k] = chunk[k];
      pos += take;
    }
    return out;
  };
  Buffer.compare = function (a, b) {
    return Buffer.prototype.compare.call(a, b);
  };

  Buffer.prototype.toString = function (encoding, start, end) {
    return decodeBytes(this, encoding || 'utf8', start, end);
  };
  Buffer.prototype.toJSON = function () {
    return { type: 'Buffer', data: Array.from(this) };
  };
  Buffer.prototype.equals = function (other) {
    return this.compare(other) === 0;
  };
  Buffer.prototype.compare = function (other) {
    var n = Math.min(this.length, other.length);
    for (var i = 0; i < n; i++) {
      if (this[i] !== other[i]) return this[i] < other[i] ? -1 : 1;
    }
    if (this.length === other.length) return 0;
    return this.length < other.length ? -1 : 1;
  };
  Buffer.prototype.slice = function (start, end) {
    return wrapBytes(Uint8Array.prototype.subarray.call(this, start, end));
  };
  Buffer.prototype.subarray = Buffer.prototype.slice;
  Buffer.prototype.write = function (string, offset, encoding) {
    var start = typeof offset === 'number' ? offset : 0;
    var bytes = encodeString(string, encoding || 'utf8');
    var written = 0;
    for (var i = 0; i < bytes.length && start + i < this.length; i++) {
      this[start + i] = bytes[i];
      written++;
    }
    return written;
  };
  Buffer.prototype.fill = function (value, offset, end, encoding) {
    var start = typeof offset === 'number' ? offset : 0;
    var stop = typeof end === 'number' ? end : this.length;
    if (typeof offset === 'string') encoding = offset;
    if (typeof value === 'number') {
      /* One byte repeated: the native fill writes the whole range in one pass, where an element at
         a time costs a loop iteration per byte -- filling 16 MiB that way took a second. */
      Uint8Array.prototype.fill.call(this, value & 0xff, start, stop);
      return this;
    }
    var pattern = typeof value === 'string' ? encodeString(value, encoding || 'utf8') : value;
    if (pattern.length === 0) return this;
    for (var i = start, k = 0; i < stop; i++, k = (k + 1) % pattern.length) this[i] = pattern[k];
    return this;
  };
  Buffer.prototype.indexOf = function (value, byteOffset, encoding) {
    var needle = typeof value === 'number' ? Uint8Array.of(value & 0xff)
      : typeof value === 'string' ? encodeString(value, encoding || 'utf8') : value;
    var from = typeof byteOffset === 'number' ? (byteOffset < 0 ? Math.max(0, this.length + byteOffset) : byteOffset) : 0;
    for (var i = from; i + needle.length <= this.length; i++) {
      var match = true;
      for (var j = 0; j < needle.length; j++) {
        if (this[i + j] !== needle[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  };
  Buffer.prototype.includes = function (value, byteOffset, encoding) {
    return this.indexOf(value, byteOffset, encoding) !== -1;
  };
  Buffer.prototype.lastIndexOf = function (value, byteOffset, encoding) {
    var needle = typeof value === 'number' ? Uint8Array.of(value & 0xff)
      : typeof value === 'string' ? encodeString(value, encoding || 'utf8') : value;
    var from = typeof byteOffset === 'number' ? byteOffset : this.length - needle.length;
    for (var i = Math.min(from, this.length - needle.length); i >= 0; i--) {
      var match = true;
      for (var j = 0; j < needle.length; j++) {
        if (this[i + j] !== needle[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  };
  Buffer.prototype.readUInt8 = function (offset) {
    return this[offset || 0];
  };
  Buffer.prototype.readInt8 = function (offset) {
    var v = this[offset || 0];
    return v > 127 ? v - 256 : v;
  };
  Buffer.prototype.readUInt16BE = function (offset) {
    var o = offset || 0;
    return (this[o] << 8) | this[o + 1];
  };
  Buffer.prototype.readUInt16LE = function (offset) {
    var o = offset || 0;
    return this[o] | (this[o + 1] << 8);
  };
  Buffer.prototype.readInt16BE = function (offset) {
    var v = this.readUInt16BE(offset);
    return v > 0x7fff ? v - 0x10000 : v;
  };
  Buffer.prototype.readInt16LE = function (offset) {
    var v = this.readUInt16LE(offset);
    return v > 0x7fff ? v - 0x10000 : v;
  };
  Buffer.prototype.writeUInt16BE = function (value, offset) {
    var o = offset || 0;
    this[o] = (value >>> 8) & 0xff;
    this[o + 1] = value & 0xff;
    return o + 2;
  };
  Buffer.prototype.writeUInt16LE = function (value, offset) {
    var o = offset || 0;
    this[o] = value & 0xff;
    this[o + 1] = (value >>> 8) & 0xff;
    return o + 2;
  };
  Buffer.prototype.readInt32BE = function (offset) {
    return this.readUInt32BE(offset) | 0;
  };
  Buffer.prototype.readInt32LE = function (offset) {
    return this.readUInt32LE(offset) | 0;
  };
  Buffer.prototype.writeUInt8 = function (value, offset) {
    this[offset || 0] = value & 0xff;
    return (offset || 0) + 1;
  };
  Buffer.prototype.readUInt32BE = function (offset) {
    var o = offset || 0;
    return ((this[o] << 24) >>> 0) + (this[o + 1] << 16) + (this[o + 2] << 8) + this[o + 3];
  };
  Buffer.prototype.readUInt32LE = function (offset) {
    var o = offset || 0;
    return ((this[o + 3] << 24) >>> 0) + (this[o + 2] << 16) + (this[o + 1] << 8) + this[o];
  };
  Buffer.prototype.writeUInt32BE = function (value, offset) {
    var o = offset || 0;
    this[o] = (value >>> 24) & 0xff;
    this[o + 1] = (value >>> 16) & 0xff;
    this[o + 2] = (value >>> 8) & 0xff;
    this[o + 3] = value & 0xff;
    return o + 4;
  };
  Buffer.prototype.writeUInt32LE = function (value, offset) {
    var o = offset || 0;
    this[o] = value & 0xff;
    this[o + 1] = (value >>> 8) & 0xff;
    this[o + 2] = (value >>> 16) & 0xff;
    this[o + 3] = (value >>> 24) & 0xff;
    return o + 4;
  };
  Buffer.poolSize = 8192;

  var MAX_BUFFER_LENGTH = 9007199254740991;
  var MAX_STRING_LENGTH = 536870888;

  function bufErr(Kind, code, message) {
    var err = new Kind(message);
    err.code = code;
    return err;
  }

  function describeArg(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'function') return 'function ' + value.name;
    if (typeof value === 'object') return 'an instance of ' + ((value.constructor && value.constructor.name) || 'Object');
    if (typeof value === 'string') return "type string ('" + value + "')";
    return 'type ' + typeof value + ' (' + String(value) + ')';
  }

  function checkOffset(buf, offset, size) {
    var o = offset === undefined ? 0 : offset;
    if (typeof o !== 'number') throw bufErr(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "offset" argument must be of type number. Received ' + describeArg(o));
    if (o !== Math.floor(o)) throw bufErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "offset" is out of range. It must be an integer. Received ' + o);
    if (buf.length - size < 0) throw bufErr(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', 'Attempt to access memory outside buffer bounds');
    if (o < 0 || o > buf.length - size) {
      throw bufErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "offset" is out of range. It must be >= 0 and <= ' + (buf.length - size) + '. Received ' + o);
    }
    return o;
  }

  function viewOf(buf) {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  Buffer.prototype.readFloatLE = function (offset) {
    return viewOf(this).getFloat32(checkOffset(this, offset, 4), true);
  };
  Buffer.prototype.readFloatBE = function (offset) {
    return viewOf(this).getFloat32(checkOffset(this, offset, 4), false);
  };
  Buffer.prototype.readDoubleLE = function (offset) {
    return viewOf(this).getFloat64(checkOffset(this, offset, 8), true);
  };
  Buffer.prototype.readDoubleBE = function (offset) {
    return viewOf(this).getFloat64(checkOffset(this, offset, 8), false);
  };
  Buffer.prototype.writeFloatLE = function (value, offset) {
    var o = checkOffset(this, offset, 4);
    viewOf(this).setFloat32(o, value, true);
    return o + 4;
  };
  Buffer.prototype.writeFloatBE = function (value, offset) {
    var o = checkOffset(this, offset, 4);
    viewOf(this).setFloat32(o, value, false);
    return o + 4;
  };
  Buffer.prototype.writeDoubleLE = function (value, offset) {
    var o = checkOffset(this, offset, 8);
    viewOf(this).setFloat64(o, value, true);
    return o + 8;
  };
  Buffer.prototype.writeDoubleBE = function (value, offset) {
    var o = checkOffset(this, offset, 8);
    viewOf(this).setFloat64(o, value, false);
    return o + 8;
  };

  Buffer.prototype.readBigInt64LE = function (offset) {
    return viewOf(this).getBigInt64(checkOffset(this, offset, 8), true);
  };
  Buffer.prototype.readBigInt64BE = function (offset) {
    return viewOf(this).getBigInt64(checkOffset(this, offset, 8), false);
  };
  Buffer.prototype.readBigUInt64LE = function (offset) {
    return viewOf(this).getBigUint64(checkOffset(this, offset, 8), true);
  };
  Buffer.prototype.readBigUInt64BE = function (offset) {
    return viewOf(this).getBigUint64(checkOffset(this, offset, 8), false);
  };
  Buffer.prototype.writeBigInt64LE = function (value, offset) {
    var o = checkOffset(this, offset, 8);
    viewOf(this).setBigInt64(o, value, true);
    return o + 8;
  };
  Buffer.prototype.writeBigInt64BE = function (value, offset) {
    var o = checkOffset(this, offset, 8);
    viewOf(this).setBigInt64(o, value, false);
    return o + 8;
  };
  Buffer.prototype.writeBigUInt64LE = function (value, offset) {
    var o = checkOffset(this, offset, 8);
    viewOf(this).setBigUint64(o, value, true);
    return o + 8;
  };
  Buffer.prototype.writeBigUInt64BE = function (value, offset) {
    var o = checkOffset(this, offset, 8);
    viewOf(this).setBigUint64(o, value, false);
    return o + 8;
  };

  Buffer.prototype.writeInt8 = function (value, offset) {
    var o = checkOffset(this, offset, 1);
    this[o] = value & 0xff;
    return o + 1;
  };
  Buffer.prototype.writeInt16LE = function (value, offset) {
    var o = checkOffset(this, offset, 2);
    viewOf(this).setInt16(o, value, true);
    return o + 2;
  };
  Buffer.prototype.writeInt16BE = function (value, offset) {
    var o = checkOffset(this, offset, 2);
    viewOf(this).setInt16(o, value, false);
    return o + 2;
  };
  Buffer.prototype.writeInt32LE = function (value, offset) {
    var o = checkOffset(this, offset, 4);
    viewOf(this).setInt32(o, value, true);
    return o + 4;
  };
  Buffer.prototype.writeInt32BE = function (value, offset) {
    var o = checkOffset(this, offset, 4);
    viewOf(this).setInt32(o, value, false);
    return o + 4;
  };

  function byteLengthOf(byteLength) {
    if (typeof byteLength !== 'number' || byteLength !== Math.floor(byteLength) || byteLength < 1 || byteLength > 6) {
      throw bufErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "byteLength" is out of range. It must be >= 1 and <= 6. Received ' + byteLength);
    }
    return byteLength;
  }

  function readUintVar(buf, offset, byteLength, little) {
    var bl = byteLengthOf(byteLength);
    var o = checkOffset(buf, offset, bl);
    var val = 0;
    for (var i = 0; i < bl; i++) {
      val = val * 256 + buf[little ? o + bl - 1 - i : o + i];
    }
    return val;
  }

  function readIntVar(buf, offset, byteLength, little) {
    var bl = byteLengthOf(byteLength);
    var val = readUintVar(buf, offset, bl, little);
    var limit = Math.pow(2, 8 * bl - 1);
    return val >= limit ? val - 2 * limit : val;
  }

  function writeUintVar(buf, value, offset, byteLength, little) {
    var bl = byteLengthOf(byteLength);
    var max = Math.pow(2, 8 * bl);
    if (typeof value !== 'number' || value < 0 || value >= max) {
      throw bufErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "value" is out of range. It must be >= 0 and <= ' + (max - 1) + '. Received ' + value);
    }
    var o = checkOffset(buf, offset, bl);
    var v = value;
    for (var i = 0; i < bl; i++) {
      buf[little ? o + i : o + bl - 1 - i] = v % 256;
      v = Math.floor(v / 256);
    }
    return o + bl;
  }

  function writeIntVar(buf, value, offset, byteLength, little) {
    var bl = byteLengthOf(byteLength);
    var limit = Math.pow(2, 8 * bl - 1);
    if (typeof value !== 'number' || value < -limit || value >= limit) {
      throw bufErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "value" is out of range. It must be >= ' + (-limit) + ' and <= ' + (limit - 1) + '. Received ' + value);
    }
    return writeUintVar(buf, value < 0 ? value + 2 * limit : value, offset, bl, little);
  }

  Buffer.prototype.readUIntLE = function (offset, byteLength) {
    return readUintVar(this, offset, byteLength, true);
  };
  Buffer.prototype.readUIntBE = function (offset, byteLength) {
    return readUintVar(this, offset, byteLength, false);
  };
  Buffer.prototype.readIntLE = function (offset, byteLength) {
    return readIntVar(this, offset, byteLength, true);
  };
  Buffer.prototype.readIntBE = function (offset, byteLength) {
    return readIntVar(this, offset, byteLength, false);
  };
  Buffer.prototype.writeUIntLE = function (value, offset, byteLength) {
    return writeUintVar(this, value, offset, byteLength, true);
  };
  Buffer.prototype.writeUIntBE = function (value, offset, byteLength) {
    return writeUintVar(this, value, offset, byteLength, false);
  };
  Buffer.prototype.writeIntLE = function (value, offset, byteLength) {
    return writeIntVar(this, value, offset, byteLength, true);
  };
  Buffer.prototype.writeIntBE = function (value, offset, byteLength) {
    return writeIntVar(this, value, offset, byteLength, false);
  };

  function swapBytes(buf, size) {
    if (buf.length % size !== 0) {
      throw bufErr(RangeError, 'ERR_INVALID_BUFFER_SIZE', 'Buffer size must be a multiple of ' + (size * 8) + '-bits');
    }
    for (var i = 0; i < buf.length; i += size) {
      for (var a = i, b = i + size - 1; a < b; a++, b--) {
        var t = buf[a];
        buf[a] = buf[b];
        buf[b] = t;
      }
    }
    return buf;
  }
  Buffer.prototype.swap16 = function () {
    return swapBytes(this, 2);
  };
  Buffer.prototype.swap32 = function () {
    return swapBytes(this, 4);
  };
  Buffer.prototype.swap64 = function () {
    return swapBytes(this, 8);
  };

  Buffer.prototype.copy = function (target, targetStart, sourceStart, sourceEnd) {
    var ts = targetStart === undefined ? 0 : targetStart;
    var ss = sourceStart === undefined ? 0 : sourceStart;
    var se = sourceEnd === undefined ? this.length : Math.min(sourceEnd, this.length);
    if (ss >= se || ts >= target.length) return 0;
    var n = Math.min(se - ss, target.length - ts);
    Uint8Array.prototype.set.call(target, Uint8Array.prototype.subarray.call(this, ss, ss + n), ts);
    return n;
  };

  Buffer.prototype.readUint8 = Buffer.prototype.readUInt8;
  Buffer.prototype.readUint16LE = Buffer.prototype.readUInt16LE;
  Buffer.prototype.readUint16BE = Buffer.prototype.readUInt16BE;
  Buffer.prototype.readUint32LE = Buffer.prototype.readUInt32LE;
  Buffer.prototype.readUint32BE = Buffer.prototype.readUInt32BE;
  Buffer.prototype.readUintLE = Buffer.prototype.readUIntLE;
  Buffer.prototype.readUintBE = Buffer.prototype.readUIntBE;
  Buffer.prototype.readBigUint64LE = Buffer.prototype.readBigUInt64LE;
  Buffer.prototype.readBigUint64BE = Buffer.prototype.readBigUInt64BE;
  Buffer.prototype.writeUint8 = Buffer.prototype.writeUInt8;
  Buffer.prototype.writeUint16LE = Buffer.prototype.writeUInt16LE;
  Buffer.prototype.writeUint16BE = Buffer.prototype.writeUInt16BE;
  Buffer.prototype.writeUint32LE = Buffer.prototype.writeUInt32LE;
  Buffer.prototype.writeUint32BE = Buffer.prototype.writeUInt32BE;
  Buffer.prototype.writeUintLE = Buffer.prototype.writeUIntLE;
  Buffer.prototype.writeUintBE = Buffer.prototype.writeUIntBE;
  Buffer.prototype.writeBigUint64LE = Buffer.prototype.writeBigUInt64LE;
  Buffer.prototype.writeBigUint64BE = Buffer.prototype.writeBigUInt64BE;

  function writeEncoded(buf, str, enc, offset, length) {
    var bytes = encodeString(String(str), enc);
    var o = offset === undefined ? 0 : offset;
    var room = buf.length - o;
    var max = length === undefined ? room : Math.min(length, room);
    var n = Math.min(bytes.length, max);
    Uint8Array.prototype.set.call(buf, bytes.subarray(0, n), o);
    return n;
  }

  ['ascii', 'base64', 'base64url', 'hex', 'latin1', 'ucs2', 'utf8'].forEach(function (name) {
    var enc = name === 'ucs2' ? 'utf16le' : name;
    Buffer.prototype[name + 'Slice'] = function (start, end) {
      return decodeBytes(this, enc, start, end);
    };
    Buffer.prototype[name + 'Write'] = function (string, offset, length) {
      return writeEncoded(this, string, enc, offset, length);
    };
  });

  Buffer.prototype.toLocaleString = Buffer.prototype.toString;
  Object.defineProperty(Buffer.prototype, 'parent', {
    enumerable: true,
    configurable: true,
    get: function () {
      return this.buffer;
    }
  });
  Object.defineProperty(Buffer.prototype, 'offset', {
    enumerable: true,
    configurable: true,
    get: function () {
      return this.byteOffset;
    }
  });
  Buffer.of = function () {
    return Buffer.from(Array.prototype.slice.call(arguments));
  };
  Buffer.copyBytesFrom = function (view, offset, length) {
    var size = view.BYTES_PER_ELEMENT || 1;
    var start = offset === undefined ? 0 : offset;
    var count = length === undefined ? view.length - start : length;
    return Buffer.from(new Uint8Array(view.buffer, view.byteOffset + start * size, count * size));
  };

  var kBlobBytes = Symbol('owcBlobBytes');
  var kBlobType = Symbol('owcBlobType');
  var kBlobParts = Symbol('owcBlobParts');

  function makeBlobStream(parts) {
    var Ctor = typeof globalThis !== 'undefined' && typeof globalThis.ReadableStream === 'function'
      ? globalThis.ReadableStream : null;
    if (Ctor !== null) {
      return new Ctor({
        start: function (controller) {
          for (var i = 0; i < parts.length; i++) controller.enqueue(parts[i].slice());
          controller.close();
        }
      });
    }
    var pos = 0;
    function ReadableStream() {}
    Object.defineProperty(ReadableStream, 'name', { value: 'ReadableStream', configurable: true });
    var stream = new ReadableStream();
    stream.getReader = function () {
      return {
        read: function () {
          if (pos >= parts.length) return Promise.resolve({ value: undefined, done: true });
          return Promise.resolve({ value: parts[pos++].slice(), done: false });
        },
        releaseLock: function () {},
        cancel: function () { return Promise.resolve(); }
      };
    };
    stream[Symbol.asyncIterator] = function () {
      return {
        next: function () {
          if (pos >= parts.length) return Promise.resolve({ value: undefined, done: true });
          return Promise.resolve({ value: parts[pos++].slice(), done: false });
        },
        [Symbol.asyncIterator]: function () { return this; }
      };
    };
    return stream;
  }

  function blobType(value) {
    var text = String(value);
    return /^[\x20-\x7e]*$/.test(text) ? text.toLowerCase() : '';
  }

  function blobIndex(value, size, fallback) {
    if (value === undefined) return fallback;
    var n = Math.trunc(Number(value));
    if (Number.isNaN(n)) return 0;
    if (n < 0) return Math.max(size + n, 0);
    return Math.min(n, size);
  }

  class Blob {
    constructor(sources, options) {
      var list = Array.from(sources === undefined ? [] : sources);
      var parts = [];
      var total = 0;
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var bytes;
        if (item instanceof Blob) bytes = item[kBlobBytes];
        else if (ArrayBuffer.isView(item)) bytes = new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
        else if (item instanceof ArrayBuffer) bytes = new Uint8Array(item);
        else bytes = encodeString(String(item), 'utf8');
        parts.push(bytes);
        total += bytes.length;
      }
      var out = new Uint8Array(total);
      var pos = 0;
      for (var j = 0; j < parts.length; j++) {
        out.set(parts[j], pos);
        pos += parts[j].length;
      }
      this[kBlobBytes] = out;
      this[kBlobParts] = parts.filter(function (part) { return part.length > 0; });
      this[kBlobType] = options && options.type !== undefined ? blobType(options.type) : '';
    }
    get size() {
      return this[kBlobBytes].length;
    }
    get type() {
      return this[kBlobType];
    }
    /* Node yields one chunk per non-empty source part; the reader is the web ReadableStream the
       runtime already installs, or a small stand-in with the same surface when it is absent. */
    stream() {
      return makeBlobStream(this[kBlobParts]);
    }
    text() {
      return Promise.resolve(decodeBytes(this[kBlobBytes], 'utf8'));
    }
    arrayBuffer() {
      return Promise.resolve(this[kBlobBytes].slice().buffer);
    }
    bytes() {
      return Promise.resolve(this[kBlobBytes].slice());
    }
    slice(start, end, contentType) {
      var size = this[kBlobBytes].length;
      var s = blobIndex(start, size, 0);
      var e = blobIndex(end, size, size);
      var type = contentType === undefined ? '' : blobType(contentType);
      return makeBlob(this[kBlobBytes].slice(s, Math.max(e, s)), type);
    }
  }
  Object.defineProperty(Blob.prototype, Symbol.toStringTag, { value: 'Blob', configurable: true });

  function makeBlob(bytes, type) {
    var blob = Object.create(Blob.prototype);
    blob[kBlobBytes] = bytes;
    blob[kBlobParts] = bytes.length > 0 ? [bytes] : [];
    blob[kBlobType] = type;
    return blob;
  }

  var TRANSCODE_ENCODINGS = {
    ascii: 'ascii', latin1: 'latin1', binary: 'latin1',
    ucs2: 'utf16le', 'ucs-2': 'utf16le', utf16le: 'utf16le', 'utf-16le': 'utf16le',
    utf8: 'utf8', 'utf-8': 'utf8'
  };

  function transcodeName(enc) {
    var key = String(enc).toLowerCase();
    return Object.prototype.hasOwnProperty.call(TRANSCODE_ENCODINGS, key) ? TRANSCODE_ENCODINGS[key] : null;
  }

  function transcode(source, fromEnc, toEnc) {
    if (!ArrayBuffer.isView(source) && !(source instanceof ArrayBuffer)) {
      throw bufErr(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "source" argument must be an instance of Buffer or Uint8Array. Received ' + describeArg(source));
    }
    var from = transcodeName(fromEnc);
    var to = transcodeName(toEnc);
    if (from === null || to === null) {
      throw bufErr(Error, 'U_ILLEGAL_ARGUMENT_ERROR', 'Unable to transcode Buffer [U_ILLEGAL_ARGUMENT_ERROR]');
    }
    var bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    var text = decodeBytes(bytes, from);
    var out;
    if (to === 'utf8' || to === 'utf16le') {
      out = encodeString(text, to);
    } else {
      // latin1 and ascii cannot hold every code point: each unrepresentable one becomes '?', as ICU substitutes it
      var limit = to === 'ascii' ? 128 : 256;
      var points = Array.from(text);
      out = new Uint8Array(points.length);
      for (var i = 0; i < points.length; i++) {
        var cp = points[i].codePointAt(0);
        out[i] = cp < limit ? cp : 63;
      }
    }
    return wrapBytes(out);
  }

  /* Node's isUtf8 and isAscii take an ArrayBuffer, a Buffer or a TypedArray: a DataView is not one,
     even though it is a view, so it is rejected with the same message a string gets. */
  function inputBytes(value) {
    if (value instanceof DataView) {
      throw bufErr(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "input" argument must be an instance of ArrayBuffer, Buffer, or TypedArray. Received ' + describeArg(value));
    }
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw bufErr(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "input" argument must be an instance of ArrayBuffer, Buffer, or TypedArray. Received ' + describeArg(value));
  }

  // Strict UTF-8: no overlong forms, no surrogates, nothing above U+10FFFF.
  function utf8Valid(bytes) {
    var i = 0;
    var n = bytes.length;
    while (i < n) {
      var b = bytes[i];
      if (b < 0x80) {
        i++;
        continue;
      }
      var need;
      var cp;
      var min;
      if (b >= 0xc2 && b <= 0xdf) {
        need = 1;
        cp = b & 0x1f;
        min = 0x80;
      } else if (b >= 0xe0 && b <= 0xef) {
        need = 2;
        cp = b & 0x0f;
        min = 0x800;
      } else if (b >= 0xf0 && b <= 0xf4) {
        need = 3;
        cp = b & 0x07;
        min = 0x10000;
      } else {
        return false;
      }
      if (i + need >= n) return false;
      for (var k = 1; k <= need; k++) {
        var c = bytes[i + k];
        if ((c & 0xc0) !== 0x80) return false;
        cp = cp * 64 + (c & 0x3f);
      }
      if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
      i += need + 1;
    }
    return true;
  }

  function isUtf8(input) {
    return utf8Valid(inputBytes(input));
  }

  function isAscii(input) {
    var bytes = inputBytes(input);
    for (var i = 0; i < bytes.length; i++) {
      if (bytes[i] > 0x7f) return false;
    }
    return true;
  }

  return {
    Buffer: Buffer,
    kMaxLength: MAX_BUFFER_LENGTH,
    kStringMaxLength: MAX_STRING_LENGTH,
    constants: { MAX_LENGTH: MAX_BUFFER_LENGTH, MAX_STRING_LENGTH: MAX_STRING_LENGTH },
    Blob: Blob,
    transcode: transcode,
    isUtf8: isUtf8,
    isAscii: isAscii
  };
};

BF.fs = function () {
  var P = requireBuiltin('path');
  var Buf = requireBuiltin('buffer').Buffer;

  var DESCRIPTIONS = {
    ENOENT: 'no such file or directory',
    EACCES: 'permission denied',
    EEXIST: 'file already exists',
    EISDIR: 'illegal operation on a directory',
    ENOTDIR: 'not a directory',
    ENOTEMPTY: 'directory not empty',
    EINVAL: 'invalid argument',
    EBADF: 'bad file descriptor'
  };

  function fsError(code, syscall, path) {
    var err = new Error(code + ': ' + DESCRIPTIONS[code] + ', ' + syscall + " '" + path + "'");
    err.errno = code === 'ENOENT' ? -2 : -1;
    err.code = code;
    err.syscall = syscall;
    err.path = path;
    return err;
  }

  function toPathString(p) {
    var s = p && typeof p === 'object' && p.href ? p.href : String(p);
    if (s.indexOf('file://') === 0) s = decodeURIComponent(s.slice(7));
    return P.resolve(s);
  }

  /*
   * utimesSync has no host file system to write its times through to, so the time it sets is kept
   * here and folded into every later stat of that path: that is what Node makes observable, and it
   * is what utimes is for.
   */
  var MTIMES = {};
  /*
   * chmod has no host file system to write its bits through to either, so the mode it sets is kept
   * here beside the times and folded into every later stat of that path. A mode nothing reads back
   * is a no-op that reports success, which is worse than a refusal.
   */
  var MODES = {};

  function statOf(file) {
    var raw = host.statJSON(canonicalOf(file));
    if (raw === null) return null;
    var st = JSON.parse(raw);
    var override = MTIMES[file];
    var withTime = override === undefined ? st : { type: st.type, size: st.size, mtimeMs: override };
    var mode = MODES[file];
    var out = mode === undefined ? withTime
      : { type: withTime.type, size: withTime.size, mtimeMs: withTime.mtimeMs, mode: mode };
    out.ino = inoOf(file);
    out.nlink = nlinkOf(file);
    return out;
  }

  function optionsEncoding(opts) {
    if (typeof opts === 'string') return opts;
    if (opts && typeof opts === 'object' && opts.encoding) return opts.encoding;
    return undefined;
  }

  // Node checks the type of a range bound first, then that it is an integer within the safe range.
  function describeFsArg(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'function') return 'function ' + value.name;
    if (typeof value === 'object') return 'an instance of ' + ((value.constructor && value.constructor.name) || 'Object');
    if (typeof value === 'string') return "type string ('" + value + "')";
    return 'type ' + typeof value + ' (' + String(value) + ')';
  }

  function fsArgErr(Kind, code, message) {
    var err = new Kind(message);
    err.code = code;
    return err;
  }

  function checkRange(value, name) {
    if (typeof value !== 'number') {
      throw fsArgErr(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "' + name + '" argument must be of type number. Received ' + describeFsArg(value));
    }
    if (value !== Math.floor(value)) {
      throw fsArgErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "' + name + '" is out of range. It must be an integer. Received ' + value);
    }
    if (value < 0 || value > 9007199254740991) {
      throw fsArgErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "' + name + '" is out of range. It must be >= 0 && <= 9007199254740991. Received ' + value);
    }
    return value;
  }

  function owcRange(name, mustBe, value) {
    return fsArgErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "' + name + '" is out of range. It must be ' + mustBe + '. Received ' + value);
  }

  /* The descriptor layer's path based view has no inodes, so a symlink is recorded against the
     path it was created at: lstat reports the link, stat follows it, and readlink names its target.
     The link itself holds a copy of the target's bytes, so a read through it sees the same data. */
  var SYMLINKS = {};
  /* readlink hands back the target exactly as symlink wrote it, which is not always the path stat
     follows: a relative target is written verbatim and resolved beside the link. */
  var LINKTARGETS = {};

  /*
   * Hard links, and the inode numbers that come with them. This file system has no inode table of
   * its own, so the two are tables kept here: LINKS names, for a second name of a file, the first
   * name whose bytes it shares, and INODES gives every file a number that survives a write and
   * differs from every other file's -- which is all ino is for. Every read and write of a linked
   * name goes through canonicalOf to the bytes it shares, so a write through one name is read
   * back through the other, and nlink counts the names a file has.
   */
  var LINKS = {};
  var INODES = {};
  var INO_NEXT = 1;

  /* The name a file's bytes live under: itself, unless it is a second name of another file's. */
  function canonicalOf(file) {
    var at = file;
    for (var hop = 0; LINKS[at] !== undefined && hop < 64; hop++) at = LINKS[at];
    return at;
  }

  function inoOf(file) {
    var canonical = canonicalOf(file);
    if (INODES[canonical] === undefined) INODES[canonical] = INO_NEXT++;
    return INODES[canonical];
  }

  /* How many names a file has: its own, plus every name recorded as a second one of it. */
  function nlinkOf(file) {
    var canonical = canonicalOf(file);
    var count = 1;
    var names = Object.keys(LINKS);
    for (var i = 0; i < names.length; i++) if (LINKS[names[i]] === canonical) count++;
    return count;
  }

  /* Node's blocks counts 512-byte blocks while the allocation it reports is in 4096-byte ones: a
     1-byte file holds 8, a 4097-byte one 16, and an empty one none. */
  function blocksOf(size) {
    return Math.ceil(size / 4096) * 8;
  }

  /* Node exports fs.Stats, and packages test a stat with instanceof fs.Stats, so a stat is an
     instance of it; every field still sits on the instance, exactly as it did before. */
  function Stats() {}
  Object.defineProperty(Stats.prototype, Symbol.toStringTag, { value: 'Stats', configurable: true });

  /* The bits of st_mode that say what a path is, and the value each kind leaves in them. A mode the
     file system already carries is the authority -- it is what makes a character device a device and
     not a file -- and only a mode with no format in it falls back to the type the store reports. */
  var S_IFMT = 61440;
  var S_IFREG = 32768;
  var S_IFDIR = 16384;
  var S_IFLNK = 40960;
  var S_IFCHR = 8192;
  var S_IFBLK = 24576;
  var S_IFIFO = 4096;
  var S_IFSOCK = 49152;

  function makeStats(st, opts, isLink) {
    var bigint = !!(opts && typeof opts === 'object' && opts.bigint);
    // With bigint every numeric field is a BigInt; the four date fields stay Date objects.
    var num = bigint ? function (value) { return BigInt(value); } : function (value) { return value; };
    var mtime = new Date(st.mtimeMs);
    var mode = st.mode !== undefined ? st.mode : (st.type === 'dir' ? 16877 : (isLink ? 41471 : 33188));
    var format = Number(mode) & S_IFMT;
    /* The kind a mode says, or -- with no format in it -- the one the store recorded. */
    var kindOf = function (bit, type) { return format === 0 ? st.type === type : format === bit; };
    var out = {
      dev: num(0),
      mode: num(mode),
      nlink: num(st.nlink !== undefined ? st.nlink : 1),
      uid: num(0),
      gid: num(0),
      rdev: num(0),
      blksize: num(4096),
      ino: num(st.ino !== undefined ? st.ino : 0),
      size: num(st.size),
      blocks: num(blocksOf(st.size)),
      atimeMs: num(st.mtimeMs),
      mtimeMs: num(st.mtimeMs),
      ctimeMs: num(st.mtimeMs),
      birthtimeMs: num(st.mtimeMs),
      atime: mtime,
      mtime: mtime,
      ctime: mtime,
      birthtime: mtime,
      isFile: function () { return !isLink && kindOf(S_IFREG, 'file'); },
      isDirectory: function () { return !isLink && kindOf(S_IFDIR, 'dir'); },
      isSymbolicLink: function () { return !!isLink; },
      isBlockDevice: function () { return format === S_IFBLK; },
      isCharacterDevice: function () { return format === S_IFCHR; },
      isFIFO: function () { return format === S_IFIFO; },
      isSocket: function () { return format === S_IFSOCK; }
    };
    Object.setPrototypeOf(out, Stats.prototype);
    return out;
  }

  var kDirentType = Symbol('owcDirentType');

  function Dirent(name, parentPath, type) {
    this.name = name;
    this.parentPath = parentPath;
    this.path = parentPath;
    this[kDirentType] = type;
  }
  Dirent.prototype.isFile = function () { return this[kDirentType] === 'file'; };
  Dirent.prototype.isDirectory = function () { return this[kDirentType] === 'dir'; };
  Dirent.prototype.isSymbolicLink = function () { return this[kDirentType] === 'link'; };
  Dirent.prototype.isBlockDevice = function () { return false; };
  // A character device is its own kind here, as it is in Node: readdir of /dev with file types
  // names every one of the four a character device on a host, and a Dirent that called one a file
  // made isCharacterDevice() of the entries false.
  Dirent.prototype.isCharacterDevice = function () { return this[kDirentType] === 'chr'; };
  Dirent.prototype.isFIFO = function () { return false; };
  Dirent.prototype.isSocket = function () { return false; };
  Object.defineProperty(Dirent.prototype, Symbol.toStringTag, { value: 'Dirent', configurable: true });

  // A path recorded as a symlink is reported as one by readdir and opendir, as Node does.
  function direntStatsOf(abs) {
    var st = statOf(abs) || { type: 'file', size: 0, mtimeMs: 0 };
    return SYMLINKS[abs] !== undefined ? { type: 'link', size: st.size, mtimeMs: st.mtimeMs } : st;
  }

  /* The kind the file system recorded is only dir or file; what makes a device a device is the
     S_IFCHR its mode carries, which is how its own Stats tells one apart and how a host reads one. */
  function isCharacterDevice(st) {
    return st !== null && st !== undefined && st.mode !== undefined && (Number(st.mode) & 61440) === 8192;
  }

  function makeDirent(name, st, parentPath) {
    return new Dirent(name, parentPath, st.type === 'link' ? 'link' : (st.type === 'dir' ? 'dir' : isCharacterDevice(st) ? 'chr' : 'file'));
  }

  function readBytesOf(file) {
    return decodeBase64(host.readBase64(canonicalOf(file)));
  }

  function check(code, syscall, file) {
    if (code) throw fsError(code, syscall, file);
  }

  var fs = {};

  fs.readFileSync = function (p, opts) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'open', String(p));
    if (st.type === 'dir') throw fsError('EISDIR', 'read', file);
    var enc = optionsEncoding(opts);
    if (enc && normalizeEncoding(enc) === 'utf8') return host.readText(canonicalOf(file));
    var bytes = readBytesOf(file);
    if (enc) return decodeBytes(bytes, enc);
    return Buf.from(bytes);
  };

  /*
   * openAsBlob hands the file back as a Blob, which is what a fetch of a file: URL and a browser
   * package both expect of it. This engine has no Blob of its own, so what resolves is an object
   * with the size and type of one and the arrayBuffer, text and slice of one; the promise
   * around it is what Node returns, and a missing file rejects with the ENOENT Node reports.
   */
  function blobOf(data, type) {
    return {
      size: data.length,
      type: type,
      arrayBuffer: function () {
        var copy = new Uint8Array(data.length);
        copy.set(data);
        return Promise.resolve(copy.buffer);
      },
      text: function () { return Promise.resolve(decodeBytes(data, 'utf8')); },
      slice: function (start, end, contentType) {
        var from = start === undefined ? 0 : (start < 0 ? Math.max(0, data.length + start) : start);
        var to = end === undefined ? data.length : (end < 0 ? Math.max(from, data.length + end) : end);
        return blobOf(data.subarray(from, to), typeof contentType === 'string' ? contentType : '');
      }
    };
  }

  fs.openAsBlob = function (p, opts) {
    var file = toPathString(p);
    var type = opts && typeof opts === 'object' && typeof opts.type === 'string' ? opts.type : '';
    return new Promise(function (resolve, reject) {
      var st = statOf(file);
      if (!st) { reject(fsError('ENOENT', 'open', String(p))); return; }
      if (st.type === 'dir') { reject(fsError('EISDIR', 'open', file)); return; }
      resolve(blobOf(readBytesOf(file), type));
    });
  };

  /*
   * The mode a new name gets. Node applies the mode a call asks for once, when the name is created,
   * and masks it with the process umask -- 0o022, the shell's default and this machine's -- so a
   * bare mkdirSync lands 0o755 and a bare writeFileSync 0o644, while 0o600 or 0o750 asked for
   * explicitly survive. Ignoring both, which this did, leaves every file world readable and every
   * directory world writable: writeFileSync with mode 0o600 came back 0o644.
   */
  var UMASK = 0o022;
  var newMode = function (opts, fallback) {
    var asked = opts && typeof opts === 'object' && typeof opts.mode === 'number' ? opts.mode : fallback;
    return asked & ~UMASK & 0o7777;
  };

  fs.writeFileSync = function (p, data, opts) {
    var file = toPathString(p);
    var mode = newMode(opts, 0o666);
    var flag = opts && typeof opts === 'object' && opts.flag ? opts.flag : 'w';
    var bytes;
    if (typeof data === 'string') bytes = encodeString(data, optionsEncoding(opts) || 'utf8');
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = encodeString(String(data), 'utf8');
    if (flag.charAt(0) === 'a' && statOf(file)) {
      var existing = readBytesOf(file);
      var merged = new Uint8Array(existing.length + bytes.length);
      merged.set(existing, 0);
      merged.set(bytes, existing.length);
      bytes = merged;
    }
    check(host.writeBase64(canonicalOf(file), encodeBase64(bytes), mode), 'open', file);
  };

  fs.appendFileSync = function (p, data, opts) {
    fs.writeFileSync(p, data, Object.assign({}, typeof opts === 'object' ? opts : { encoding: opts }, { flag: 'a' }));
  };

  fs.existsSync = function (p) {
    try {
      return statOf(toPathString(p)) !== null;
    } catch (err) {
      return false;
    }
  };

  // stat follows a recorded link to its target; lstat reports the link itself.
  fs.statSync = function (p, opts) {
    var file = toPathString(p);
    for (var hop = 0; SYMLINKS[file] !== undefined && hop < 32; hop++) file = SYMLINKS[file];
    var st = statOf(file);
    if (!st) {
      if (opts && opts.throwIfNoEntry === false) return undefined;
      throw fsError('ENOENT', 'stat', toPathString(p));
    }
    return makeStats(st, opts, false);
  };

  fs.lstatSync = function (p, opts) {
    var file = toPathString(p);
    var st = statOf(file);
    var linked = SYMLINKS[file] !== undefined;
    /* A link whose target is not there yet has no bytes of its own, and Node still reports the
       link: its size is the length of the target it names. */
    if (!st) {
      if (!linked) {
        if (opts && opts.throwIfNoEntry === false) return undefined;
        throw fsError('ENOENT', 'lstat', file);
      }
      var named = LINKTARGETS[file] !== undefined ? LINKTARGETS[file] : SYMLINKS[file];
      st = { type: 'file', size: String(named).length, mtimeMs: 0 };
    }
    return makeStats(st, opts, linked);
  };

  // Node names both ends of a symlink in its error: 'symlink '<target>' -> '<link>''.
  function symlinkError(code, from, to) {
    var err = fsError(code, 'symlink', to);
    err.message = code + ': ' + DESCRIPTIONS[code] + ', symlink ' + "'" + from + "' -> '" + to + "'";
    return err;
  }

  fs.symlinkSync = function (target, linkPath) {
    var raw = target && typeof target === 'object' && target.href ? target.href : String(target);
    var to = toPathString(linkPath);
    // A relative target names a path beside the link, not one under the working directory: that is
    // where the system resolves it when the link is opened, and where Node leaves it for readlink.
    var from = P.isAbsolute(raw) ? toPathString(raw) : P.resolve(P.dirname(to), raw);
    if (statOf(to)) throw symlinkError('EEXIST', from, to);
    /* A link is a name, not a copy, and a host lets it name a target that is not there yet: that is
       a dangling link, and it is what a link to a file another step creates looks like. Only a
       target that is a file carries bytes across, since a directory has none. */
    var targetStat = statOf(from);
    if (targetStat && targetStat.type === 'file') {
      check(host.writeBase64(to, encodeBase64(readBytesOf(from))), 'symlink', to);
    }
    SYMLINKS[to] = from;
    LINKTARGETS[to] = raw;
  };

  /*
   * A hard link: a second name for the bytes one name already holds. This file system has no inode
   * for two names to share, so the new name is put in the tree as a file -- which is what makes it
   * visible to a readdir, to the shell and to every lookup that asks whether it is there -- and
   * recorded as a second name of the bytes the first one holds, so a read of either sees what a
   * write to the other put there and stat gives both the same ino and an nlink of 2. What it
   * cannot do is what ext4 does when the last name goes: the hold on the bytes is the first
   * name's, and removing that one leaves the others reading the copy made here.
   */
  fs.linkSync = function (existingPath, newPath) {
    var from = toPathString(existingPath);
    var to = toPathString(newPath);
    var st = statOf(from);
    if (!st) throw fsError('ENOENT', 'link', String(existingPath));
    if (st.type === 'dir') throw fsError('EPERM', 'link', String(existingPath));
    if (statOf(to)) throw fsError('EEXIST', 'link', String(newPath));
    var canonical = canonicalOf(from);
    var raw = host.readBase64(canonical);
    if (raw === null) throw fsError('ENOENT', 'link', String(existingPath));
    check(host.writeBase64(to, raw, 0o644), 'link', to);
    LINKS[to] = canonical;
  };

  fs.readlinkSync = function (p) {
    var file = toPathString(p);
    var target = LINKTARGETS[file];
    if (target === undefined) target = SYMLINKS[file];
    if (target !== undefined) return target;
    if (!statOf(file)) throw fsError('ENOENT', 'readlink', file);
    throw fsError('EINVAL', 'readlink', file);
  };

  // The host lists in creation order; Node (scandir with strcmp) lists sorted, so sort here.
  function sortedEntries(dir) {
    return JSON.parse(host.readdirJSON(dir)).slice().sort();
  }

  fs.readdirSync = function (p, opts) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'scandir', file);
    if (st.type !== 'dir') throw fsError('ENOTDIR', 'scandir', file);
    var withTypes = !!(opts && typeof opts === 'object' && opts.withFileTypes);
    var recursive = !!(opts && typeof opts === 'object' && opts.recursive);
    var base = typeof p === 'string' ? p : file;
    if (!recursive) {
      var names = sortedEntries(file);
      if (!withTypes) return names;
      return names.map(function (name) {
        return makeDirent(name, direntStatsOf(P.join(file, name)), base);
      });
    }
    // Node's recursive listing is breadth first: one directory's entries in sorted order, then the next level.
    var out = [];
    var queue = [{ abs: file, str: base, rel: '' }];
    for (var q = 0; q < queue.length; q++) {
      var cur = queue[q];
      var kids = sortedEntries(cur.abs);
      for (var k = 0; k < kids.length; k++) {
        var childAbs = P.join(cur.abs, kids[k]);
        var childSt = direntStatsOf(childAbs);
        var childRel = cur.rel === '' ? kids[k] : cur.rel + '/' + kids[k];
        out.push(withTypes ? makeDirent(kids[k], childSt, cur.str) : childRel);
        if (childSt.type === 'dir') queue.push({ abs: childAbs, str: P.join(cur.str, kids[k]), rel: childRel });
      }
    }
    return out;
  };

  fs.mkdirSync = function (p, opts) {
    var file = toPathString(p);
    var recursive = !!(opts && typeof opts === 'object' && opts.recursive);
    var existing = statOf(file);
    if (existing) {
      if (recursive && existing.type === 'dir') return undefined;
      throw fsError('EEXIST', 'mkdir', file);
    }
    check(host.mkdir(file, newMode(opts, 0o777)), 'mkdir', file);
    return recursive ? file : undefined;
  };

  /* Node refuses to rm a directory without the recursive option before it looks at what is inside
     it: ERR_FS_EISDIR, where a removal that got as far as the entries reports ENOTEMPTY instead. */
  function eisdirError(syscall, file) {
    var err = new Error('Path is a directory: ' + syscall + ' returned EISDIR (is a directory) ' + file);
    err.code = 'ERR_FS_EISDIR';
    err.errno = -21;
    err.syscall = syscall;
    err.path = file;
    return err;
  }

  fs.rmSync = function (p, opts) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) {
      if (opts && opts.force) return;
      throw fsError('ENOENT', 'rm', file);
    }
    var recursive = !!(opts && opts.recursive);
    if (st.type === 'dir' && !recursive) throw eisdirError('rm', file);
    check(host.rm(file, recursive), 'rm', file);
  };

  fs.rmdirSync = function (p, opts) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'rmdir', file);
    if (st.type !== 'dir') throw fsError('ENOTDIR', 'rmdir', file);
    check(host.rm(file, !!(opts && opts.recursive)), 'rmdir', file);
  };

  fs.unlinkSync = function (p) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'unlink', file);
    if (st.type === 'dir') throw fsError('EISDIR', 'unlink', file);
    check(host.rm(file, false), 'unlink', file);
    /* A second name of a file is dropped from the table when its own name goes; the bytes it was
       sharing stay under the name they were written to. */
    delete LINKS[file];
  };

  fs.renameSync = function (from, to) {
    var a = toPathString(from);
    if (!statOf(a)) throw fsError('ENOENT', 'rename', a);
    check(host.rename(a, toPathString(to)), 'rename', a);
  };

  fs.copyFileSync = function (from, to) {
    var src = toPathString(from);
    if (!statOf(src)) throw fsError('ENOENT', 'copyfile', src);
    check(host.writeBase64(toPathString(to), encodeBase64(readBytesOf(src))), 'copyfile', src);
  };

  /*
   * cpSync is copyFileSync over a tree: recursive for a directory, force to overwrite a
   * destination that is already there (errorOnExist is its opposite, and Node refuses when both
   * are asked for), filter to skip a path, dereference to copy the bytes a symlink points at
   * rather than the link, and mode for what a copied directory is created with. A destination
   * that does not exist is created, and copying a directory without recursive is the EISDIR
   * Node reports rather than a copy of nothing.
   */
  function cpOne(src, dest, opts, seen) {
    if (typeof opts.filter === 'function' && !opts.filter(src, dest)) return;
    var st = statOf(src);
    if (!st) throw fsError('ENOENT', 'cp', src);
    if (st.type === 'dir') {
      if (!opts.recursive) throw eisdirError('cp', src);
      if (statOf(dest)) {
        if (opts.errorOnExist) throw fsError('EEXIST', 'cp', dest);
      } else {
        check(host.mkdir(dest, opts.mode === undefined ? newMode(null, 0o777) : opts.mode), 'cp', dest);
      }
      var names = sortedEntries(src);
      for (var i = 0; i < names.length; i++) {
        cpOne(P.join(src, names[i]), P.join(dest, names[i]), opts, seen);
      }
      return;
    }
    var linked = SYMLINKS[src] !== undefined;
    if (linked && !opts.dereference) {
      if (!opts.force && statOf(dest)) throw fsError('EEXIST', 'cp', dest);
      fs.symlinkSync(LINKTARGETS[src] !== undefined ? LINKTARGETS[src] : SYMLINKS[src], dest);
      return;
    }
    if (!opts.force && statOf(dest)) throw fsError('EEXIST', 'cp', dest);
    check(host.writeBase64(dest, encodeBase64(readBytesOf(src)), 0o644), 'cp', src);
  }

  fs.cpSync = function (src, dest, opts) {
    var options = opts === undefined || opts === null ? {} : opts;
    if (typeof options !== 'object') throw fsArgErr(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object. Received ' + describeFsArg(options));
    if (options.force && options.errorOnExist) {
      throw fsArgErr(TypeError, 'ERR_INVALID_ARG_VALUE', 'The "options.force" and "options.errorOnExist" options are mutually exclusive');
    }
    cpOne(toPathString(src), toPathString(dest), {
      recursive: !!options.recursive,
      force: !!options.force,
      errorOnExist: !!options.errorOnExist,
      dereference: !!options.dereference,
      filter: typeof options.filter === 'function' ? options.filter : undefined,
      mode: typeof options.mode === 'number' ? options.mode : undefined
    }, {});
  };

  /*
   * access asks whether the mode bits allow what the caller asked for, which is what a host does
   * against one user's own bits: there is no other uid here to be. F_OK is a plain existence test,
   * and a mode of 0 is F_OK however it is spelled.
   */
  fs.accessSync = function (p, mode) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'access', file);
    var want = mode === undefined || mode === null ? 0 : Number(mode);
    if (want === 0) return;
    var bits = (st.mode !== undefined ? st.mode : (st.type === 'dir' ? 0o755 : 0o644)) & 0o777;
    if (want & 4) { if (!(bits & 0o400)) throw fsError('EACCES', 'access', file); }
    if (want & 2) { if (!(bits & 0o200)) throw fsError('EACCES', 'access', file); }
    if (want & 1) { if (!(bits & 0o100)) throw fsError('EACCES', 'access', file); }
  };

  fs.realpathSync = function (p) {
    var file = toPathString(p);
    if (!statOf(file)) throw fsError('ENOENT', 'realpath', file);
    return file;
  };

  /*
   * mkdtemp replaces the run of X's at the end of the prefix with random characters -- a template
   * whose X's are still there in the name it hands back is a prefix it never substituted -- and
   * makes the directory 0o700, because a temporary directory is private to the user who asked for
   * it. It is retried while the name is taken, the way mkdtemp(3) is.
   */
  var TEMP_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var TRAILING_XS = /X+$/;
  function randomName(stem, width) {
    var out = stem;
    for (var i = 0; i < width; i++) out += TEMP_ALPHABET.charAt(Math.floor(Math.random() * TEMP_ALPHABET.length));
    return out;
  }
  fs.mkdtempSync = function (prefix) {
    var raw = String(prefix);
    var run = TRAILING_XS.exec(raw);
    var stem = run ? raw.slice(0, run.index) : raw;
    var width = run ? run[0].length : 6;
    var name;
    do { name = randomName(stem, width); } while (statOf(name));
    fs.mkdirSync(name, { mode: 0o700 });
    return name;
  };

  /*
   * Descriptors. The file system behind these calls is path based, so a descriptor is a small
   * integer handle over a byte buffer: 'r' starts from the file's bytes, 'w' starts empty and
   * truncates the file at once, 'a' starts from the file's bytes with the position at the end, and
   * a descriptor opened for writing pushes its buffer through the ordinary write path when it is
   * synced and again when it is closed. create-next-app writes every file this way: openSync,
   * writeSync, fsyncSync, closeSync, then chmodSync and chownSync on the temporary file.
   */
  var VALID_FLAGS = ['r', 'r+', 'rs', 'sr', 'rs+', 'sr+', 'w', 'wx', 'w+', 'wx+', 'xw', 'xw+', 'a', 'ax', 'a+', 'ax+', 'xa', 'xa+'];

  function badFlagError(flags) {
    var err = new TypeError("The argument 'flags' is invalid. Received '" + String(flags) + "'");
    err.code = 'ERR_INVALID_ARG_VALUE';
    return err;
  }

  function badFdError(syscall) {
    var err = new Error('EBADF: bad file descriptor, ' + syscall);
    err.errno = -9;
    err.code = 'EBADF';
    err.syscall = syscall;
    return err;
  }

  // Node accepts r, w and a with + (read and write), x (exclusive) and s (sync) modifiers: the
  // first r/w/a letter decides the mode, so 'wx' writes and 'ax+' appends and reads.
  function flagLetter(flags) {
    var f = String(flags);
    return f.charAt(0) === 'r' || f.charAt(0) === 'w' || f.charAt(0) === 'a' ? f.charAt(0) : f.charAt(1);
  }

  var DESCRIPTORS = {};
  var nextDescriptor = 3;

  function descriptorOf(fd, syscall) {
    var rec = typeof fd === 'number' ? DESCRIPTORS[fd] : undefined;
    if (rec === undefined) throw badFdError(syscall);
    return rec;
  }

  function writeBytes(data, encoding) {
    if (typeof data === 'string') return encodeString(data, encoding || 'utf8');
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView');
  }

  function flushDescriptor(rec, syscall) {
    if (!rec.dirty) return;
    check(host.writeBase64(rec.path, encodeBase64(rec.bytes)), syscall, rec.path);
    rec.dirty = false;
  }

  fs.openSync = function (p, flags, mode) {
    var f = flags === undefined || flags === null ? 'r' : String(flags);
    if (VALID_FLAGS.indexOf(f) < 0) throw badFlagError(flags);
    var file = toPathString(p);
    var letter = flagLetter(f);
    var creates = letter === 'w' || letter === 'a';
    var st = statOf(file);
    var isDir = !!(st && st.type === 'dir');
    if (creates) {
      if (isDir) throw fsError('EISDIR', 'open', file);
      if (letter === 'w' || !st) check(host.writeBase64(file, encodeBase64(new Uint8Array(0))), 'open', file);
    } else if (!st) {
      throw fsError('ENOENT', 'open', file);
    }
    var bytes = letter === 'w' || !st || isDir ? new Uint8Array(0) : readBytesOf(file);
    var fd = nextDescriptor++;
    // The pty fds the node-pty shim hands out start at 1000; never hand a file one of those.
    while (DESCRIPTORS[fd] !== undefined || (globalThis.__owcPtyFds && globalThis.__owcPtyFds[fd] !== undefined)) fd = nextDescriptor++;
    DESCRIPTORS[fd] = {
      path: file,
      flags: f,
      device: !isDir && !!st && isCharacterDevice(st),
      bytes: bytes,
      position: letter === 'a' ? bytes.length : 0,
      writable: creates || f.indexOf('+') >= 0,
      readable: letter === 'r' || f.indexOf('+') >= 0,
      isDir: isDir,
      dirty: creates || f.indexOf('+') >= 0
    };
    return fd;
  };

  fs.writeSync = function (fd, data, position, encoding) {
    var rec = descriptorOf(fd, 'write');
    if (!rec.writable) throw badFdError('write');
    var bytes;
    var at;
    var explicit;
    if (typeof data === 'string') {
      bytes = writeBytes(data, typeof encoding === 'string' ? encoding : typeof position === 'string' ? position : 'utf8');
      at = typeof position === 'number' ? position : rec.position;
      explicit = typeof position === 'number';
    } else {
      // writeSync(fd, buffer[, offset[, length[, position]]])
      var view = writeBytes(data);
      var offset = typeof position === 'number' ? position : 0;
      var length = typeof encoding === 'number' ? encoding : view.length - offset;
      bytes = view.subarray(offset, offset + length);
      at = typeof arguments[4] === 'number' ? arguments[4] : rec.position;
      explicit = typeof arguments[4] === 'number';
    }
    if (bytes.length === 0) return 0;
    if (at + bytes.length > rec.bytes.length) {
      var grown = new Uint8Array(at + bytes.length);
      grown.set(rec.bytes, 0);
      rec.bytes = grown;
    }
    rec.bytes.set(bytes, at);
    if (!explicit) rec.position = at + bytes.length;
    rec.dirty = true;
    return bytes.length;
  };

  fs.readSync = function (fd, buffer, offset, length, position) {
    var rec = descriptorOf(fd, 'read');
    if (!rec.readable) throw badFdError('read');
    if (rec.isDir) throw fsError('EISDIR', 'read', rec.path);
    var opts = offset && typeof offset === 'object' ? offset : null;
    var off = opts ? opts.offset || 0 : typeof offset === 'number' ? offset : 0;
    var len = opts ? (opts.length === undefined ? buffer.length - off : opts.length)
      : (typeof length === 'number' ? length : buffer.length - off);
    var at = opts ? (typeof opts.position === 'number' ? opts.position : rec.position)
      : (typeof position === 'number' ? position : rec.position);
    /* A device has no bytes of its own, so the chunk openSync read of it -- 4096 of them -- was
       all a descriptor ever had: a second readSync past it reported end of file, and a guest that
       looped drawing entropy from /dev/zero or /dev/urandom got one chunk and then stopped, where
       a host never reaches an end at all. Each read asks the device for more. A device that is at
       end of file, /dev/null, hands back nothing, which is the end it really has. */
    if (rec.device) {
      var limit = Math.min(len, (buffer.length || 0) - off);
      var target2 = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : buffer;
      var got = 0;
      var rounds = 0;
      while (got < limit && rounds++ < 64) {
        var chunk = readBytesOf(rec.path);
        if (chunk.length === 0) break;
        var take = Math.min(chunk.length, limit - got);
        for (var j = 0; j < take; j++) target2[off + got + j] = chunk[j];
        got += take;
      }
      if (!explicitRead(offset, length, position)) rec.position = at + got;
      return got;
    }
    var available = rec.bytes.length - at;
    if (available <= 0 || len <= 0) return 0;
    var n = Math.min(len, available, buffer.length - off);
    var target = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : buffer;
    for (var i = 0; i < n; i++) target[off + i] = rec.bytes[at + i];
    if (!explicitRead(offset, length, position)) rec.position = at + n;
    return n;
  };

  function explicitRead(offset, length, position) {
    if (offset && typeof offset === 'object') return typeof offset.position === 'number';
    return typeof position === 'number';
  }

  fs.fsyncSync = function (fd) {
    flushDescriptor(descriptorOf(fd, 'fsync'), 'fsync');
  };

  fs.closeSync = function (fd) {
    var rec = descriptorOf(fd, 'close');
    flushDescriptor(rec, 'close');
    delete DESCRIPTORS[fd];
  };

  /*
   * The rest of the descriptor family. A descriptor's size is the size of the buffer it holds, so
   * fstatSync reports the bytes written so far even before closeSync has pushed them through, and
   * ftruncateSync resizes that buffer: shorten it, or grow it the way Node grows a file, with zero
   * bytes up to the new length. Node refuses to truncate a descriptor that was not opened for
   * writing with EINVAL, and its error carries the syscall but no path.
   */
  function noPathError(code, syscall) {
    var err = new Error(code + ': ' + (DESCRIPTIONS[code] || code) + ', ' + syscall);
    err.errno = -1;
    err.code = code;
    err.syscall = syscall;
    return err;
  }

  function descriptorStats(rec) {
    var st = statOf(rec.path);
    return makeStats({
      type: st ? st.type : (rec.isDir ? 'dir' : 'file'),
      size: rec.bytes.length,
      mtimeMs: st ? st.mtimeMs : 0,
      mode: st ? st.mode : undefined
    });
  }

  fs.fstatSync = function (fd, opts) {
    return descriptorStats(descriptorOf(fd, 'fstat'));
  };

  function truncateLength(len) {
    if (len === undefined) return 0;
    if (typeof len !== 'number' || len !== Math.floor(len) || len < 0) {
      var err = new RangeError('The value of "len" is out of range. It must be an integer. Received ' + String(len));
      err.code = 'ERR_OUT_OF_RANGE';
      throw err;
    }
    return len;
  }

  fs.ftruncateSync = function (fd, len) {
    var rec = descriptorOf(fd, 'ftruncate');
    if (!rec.writable) throw noPathError('EINVAL', 'ftruncate');
    var size = truncateLength(len);
    var next = new Uint8Array(size);
    var keep = Math.min(size, rec.bytes.length);
    for (var i = 0; i < keep; i++) next[i] = rec.bytes[i];
    rec.bytes = next;
    if (rec.position > size) rec.position = size;
    rec.dirty = true;
  };

  /* The same truncation by name: truncateSync was the one call of the pair the file system did not
     have, so a package that shortens a file by path threw "not a function" where the host shortened
     it. It is the descriptor form over an 'r+' open, so a path that is not there fails with the
     ENOENT the open gives -- the same error, with the same path, that Node reports. */
  fs.truncateSync = function (p, len) {
    var size = truncateLength(len);
    var fd = fs.openSync(p, 'r+');
    try {
      fs.ftruncateSync(fd, size);
    } finally {
      fs.closeSync(fd);
    }
  };

  fs.fchmodSync = function (fd, mode) {
    var rec = descriptorOf(fd, 'fchmod');
    if (!statOf(rec.path)) throw fsError('ENOENT', 'fchmod', rec.path);
  };

  fs.fdatasyncSync = function (fd) {
    flushDescriptor(descriptorOf(fd, 'fdatasync'), 'fdatasync');
  };

  // Node takes a Date, a number of seconds or a numeric string; anything it cannot read is now.
  function timeToMs(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return Math.floor(value * 1000);
    var n = Number(value);
    if (value === undefined || value === null || (typeof n === 'number' && isNaN(n))) return Date.now();
    return Math.floor(n * 1000);
  }

  fs.utimesSync = function (p, atime, mtime) {
    var file = toPathString(p);
    if (!statOf(file)) throw fsError('ENOENT', 'utime', file);
    MTIMES[file] = timeToMs(mtime);
  };

  // One read across several buffers: the descriptor's position runs on through all of them, and
  // the count is the total, exactly as Node reports it.
  fs.readvSync = function (fd, buffers, position) {
    var rec = descriptorOf(fd, 'read');
    if (!rec.readable) throw badFdError('read');
    if (rec.isDir) throw fsError('EISDIR', 'read', rec.path);
    var at = typeof position === 'number' ? position : rec.position;
    var total = 0;
    for (var i = 0; i < buffers.length; i++) {
      var buf = buffers[i];
      var target = ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;
      var available = rec.bytes.length - (at + total);
      if (available <= 0) break;
      var n = Math.min(target.length, available);
      for (var j = 0; j < n; j++) target[j] = rec.bytes[at + total + j];
      total += n;
    }
    if (typeof position !== 'number') rec.position = at + total;
    return total;
  };

  /*
   * writev, the other half of the pair: several buffers written in order to one descriptor, from
   * its position or from the one it was given, and the count is the total written, as in Node.
   */
  fs.writevSync = function (fd, buffers, position) {
    var rec = descriptorOf(fd, 'write');
    if (!rec.writable) throw badFdError('write');
    if (rec.isDir) throw fsError('EISDIR', 'write', rec.path);
    var at = typeof position === 'number' ? position : rec.position;
    var total = 0;
    for (var i = 0; i < buffers.length; i++) {
      var buf = buffers[i];
      if (buf.length === 0) continue;
      total += fs.writeSync(fd, buf, 0, buf.length, at + total);
    }
    if (typeof position !== 'number') rec.position = at + total;
    return total;
  };

  // A mode is kept per path, with the type bits Node puts above it: statSync is what makes the
  // change observable, and a chmod no later stat reports is a no-op that reports success.
  function setModeOf(file, mode) {
    var st = statOf(file);
    if (!st) return null;
    var bits = typeof mode === 'string' ? parseInt(mode, 8) : Number(mode);
    if (!isFinite(bits)) bits = 0;
    MODES[file] = (st.type === 'dir' ? 16384 : 32768) | (bits & 4095);
    return st;
  }

  fs.chmodSync = function (p, mode) {
    var file = toPathString(p);
    if (!setModeOf(file, mode)) throw fsError('ENOENT', 'chmod', file);
  };

  fs.fchmodSync = function (fd, mode) {
    var rec = descriptorOf(fd, 'fchmod');
    if (!setModeOf(rec.path, mode)) throw fsError('ENOENT', 'fchmod', rec.path);
  };

  fs.chownSync = function (p, uid, gid) {
    var file = toPathString(p);
    if (!statOf(file)) throw fsError('ENOENT', 'chown', file);
  };

  /* read streams read the file once and push it in highWaterMark-sized chunks; write streams append each chunk */
  fs.createReadStream = function (p, opts) {
    var Readable = requireBuiltin('stream').Readable;
    var Buf = requireBuiltin('buffer').Buffer;
    var options = typeof opts === 'string' ? { encoding: opts } : (opts || {});
    var file = toPathString(p);
    var chunkSize = options.highWaterMark || 65536;
    /* Node validates the range when the stream is constructed, so a bad start or end throws before
       a chunk is ever read. */
    var rangeStart = 0;
    var rangeEnd = Infinity;
    if (options.start !== undefined) {
      rangeStart = checkRange(options.start, 'start');
      if (options.end !== undefined && options.end !== Infinity) {
        rangeEnd = checkRange(options.end, 'end');
        if (rangeStart > rangeEnd) {
          throw owcRange('start', '<= "end" (here: ' + rangeEnd + ')', rangeStart);
        }
      }
    } else if (options.end !== undefined && options.end !== Infinity) {
      rangeEnd = checkRange(options.end, 'end');
    }
    var bytes = null;
    var offset = 0;
    var stream = new Readable({
      highWaterMark: chunkSize,
      read: function () {
        if (bytes === null) {
          try {
            bytes = readBytesOf(file);
            if (rangeStart > 0 || rangeEnd !== Infinity) bytes = bytes.subarray(rangeStart, Math.min(rangeEnd + 1, bytes.length));
          } catch (err) {
            stream.destroy(err);
            return;
          }
        }
        if (offset >= bytes.length) {
          stream.push(null);
          return;
        }
        var end = Math.min(offset + chunkSize, bytes.length);
        var chunk = Buf.from(bytes.subarray(offset, end));
        offset = end;
        stream.bytesRead += chunk.length;
        stream.push(chunk);
      }
    });
    stream.path = file;
    // Node reports 0 before the first read and the byte count of the range afterwards.
    stream.bytesRead = 0;
    if (options.encoding) stream.setEncoding(options.encoding);
    // like Node, the file is opened when the stream is created: a missing file is an 'error' even with no reader
    setImmediate(function () {
      if (!statOf(file)) {
        stream.destroy(fsError('ENOENT', 'open', file));
        return;
      }
      stream.emit('open', 3);
      stream.emit('ready');
    });
    return stream;
  };

  fs.createWriteStream = function (p, opts) {
    var Writable = requireBuiltin('stream').Writable;
    var options = typeof opts === 'string' ? { encoding: opts } : (opts || {});
    var file = toPathString(p);
    var flags = options.flags || 'w';
    var opened = false;
    var stream = new Writable({
      write: function (chunk, encoding, callback) {
        try {
          if (!opened) {
            opened = true;
            if (flags.charAt(0) === 'w') fs.writeFileSync(file, '');
            stream.emit('open', 3);
            stream.emit('ready');
          }
          fs.appendFileSync(file, chunk);
          stream.bytesWritten += chunk.length;
          callback();
        } catch (err) {
          callback(err);
        }
      }
    });
    stream.path = file;
    stream.bytesWritten = 0;
    return stream;
  };

  function dirClosedError() {
    var err = new Error('Directory handle was closed');
    err.code = 'ERR_DIR_CLOSED';
    return err;
  }

  function Dir(dirPath, entries) {
    this.path = dirPath;
    this._entries = entries;
    this._index = 0;
    this._closed = false;
  }

  Dir.prototype.readSync = function () {
    if (this._closed) throw dirClosedError();
    if (this._index >= this._entries.length) return null;
    return this._entries[this._index++];
  };

  Dir.prototype.read = function (callback) {
    var result = null;
    var error = null;
    try {
      result = this.readSync();
    } catch (err) {
      error = err;
    }
    if (typeof callback === 'function') {
      queueMicrotask(function () {
        if (error) callback(error);
        else callback(null, result);
      });
      return undefined;
    }
    return new Promise(function (resolve, reject) {
      if (error) reject(error);
      else resolve(result);
    });
  };

  Dir.prototype.closeSync = function () {
    if (this._closed) throw dirClosedError();
    this._closed = true;
  };

  Dir.prototype.close = function (callback) {
    var error = null;
    try {
      this.closeSync();
    } catch (err) {
      error = err;
    }
    if (typeof callback === 'function') {
      queueMicrotask(function () {
        callback(error);
      });
      return undefined;
    }
    return new Promise(function (resolve, reject) {
      if (error) reject(error);
      else resolve();
    });
  };

  Dir.prototype[Symbol.asyncIterator] = function () {
    var dir = this;
    var it = {
      next: function () {
        return new Promise(function (resolve, reject) {
          try {
            var entry = dir.readSync();
            if (entry === null) {
              dir._closed = true;
              resolve({ value: undefined, done: true });
            } else {
              resolve({ value: entry, done: false });
            }
          } catch (err) {
            reject(err);
          }
        });
      },
      return: function () {
        dir._closed = true;
        return Promise.resolve({ value: undefined, done: true });
      }
    };
    it[Symbol.asyncIterator] = function () {
      return this;
    };
    return it;
  };

  fs.Dir = Dir;
  fs.Dirent = Dirent;
  fs.Stats = Stats;

  fs.opendirSync = function (p) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'opendir', file);
    if (st.type !== 'dir') throw fsError('ENOTDIR', 'opendir', file);
    var base = typeof p === 'string' ? p : file;
    var entries = sortedEntries(file).map(function (name) {
      return makeDirent(name, direntStatsOf(P.join(file, name)), base);
    });
    return new Dir(base, entries);
  };

  // The browser has no file system events, so watching fails loudly instead of returning a dead watcher.
  function watchUnavailable(api) {
    var err = new TypeError(api + ' is not supported on this runtime: the browser cannot watch the file system');
    err.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
    return err;
  }
  fs.watch = function () {
    throw watchUnavailable('fs.watch');
  };
  fs.watchFile = function () {
    throw watchUnavailable('fs.watchFile');
  };
  fs.unwatchFile = function () {};

  // Node's fs.constants on the reference platform, so flag and mode values match exactly.
  fs.constants = {"UV_FS_SYMLINK_DIR":1,"UV_FS_SYMLINK_JUNCTION":2,"O_RDONLY":0,"O_WRONLY":1,"O_RDWR":2,"UV_DIRENT_UNKNOWN":0,"UV_DIRENT_FILE":1,"UV_DIRENT_DIR":2,"UV_DIRENT_LINK":3,"UV_DIRENT_FIFO":4,"UV_DIRENT_SOCKET":5,"UV_DIRENT_CHAR":6,"UV_DIRENT_BLOCK":7,"S_IFMT":61440,"S_IFREG":32768,"S_IFDIR":16384,"S_IFCHR":8192,"S_IFBLK":24576,"S_IFIFO":4096,"S_IFLNK":40960,"S_IFSOCK":49152,"O_CREAT":512,"O_EXCL":2048,"UV_FS_O_FILEMAP":0,"O_NOCTTY":131072,"O_TRUNC":1024,"O_APPEND":8,"O_DIRECTORY":1048576,"O_NOFOLLOW":256,"O_SYNC":128,"O_DSYNC":4194304,"O_SYMLINK":2097152,"O_NONBLOCK":4,"S_IRWXU":448,"S_IRUSR":256,"S_IWUSR":128,"S_IXUSR":64,"S_IRWXG":56,"S_IRGRP":32,"S_IWGRP":16,"S_IXGRP":8,"S_IRWXO":7,"S_IROTH":4,"S_IWOTH":2,"S_IXOTH":1,"F_OK":0,"R_OK":4,"W_OK":2,"X_OK":1,"UV_FS_COPYFILE_EXCL":1,"COPYFILE_EXCL":1,"UV_FS_COPYFILE_FICLONE":2,"COPYFILE_FICLONE":2,"UV_FS_COPYFILE_FICLONE_FORCE":4,"COPYFILE_FICLONE_FORCE":4};
  fs.F_OK = 0;
  fs.R_OK = 4;
  fs.W_OK = 2;
  fs.X_OK = 1;

  /*
   * What statfs reports about the file system a path sits on, in the seven numbers Node's own give:
   * a 4096-byte block, a 32 GiB volume with half of it free, and a million inodes with half of
   * those. There is no disk behind this file system to measure, and the numbers a host answers
   * describe its own, so what is reproduced is the shape of the answer -- the keys a package reads
   * -- and a size no package will run out of.
   */
  fs.statfsSync = function (p, opts) {
    var file = toPathString(p === undefined ? '/' : p);
    if (!statOf(file)) throw fsError('ENOENT', 'statfs', file);
    var bigint = !!(opts && typeof opts === 'object' && opts.bigint);
    var num = bigint ? function (value) { return BigInt(value); } : function (value) { return value; };
    return {
      type: num(61267),
      bsize: num(4096),
      blocks: num(8388608),
      bfree: num(4194304),
      bavail: num(4194304),
      files: num(1048576),
      ffree: num(524288)
    };
  };

  /*
   * fs.promises.open resolves to one of these and not to the bare integer fs.open hands back: a
   * FileHandle carries its descriptor and reads and writes through it, and its fd reads -1 once the
   * handle is closed, so every use after closeSync is EBADF. Each method is the descriptor call
   * above wrapped in a promise, which is all Node's own handle is.
   */
  function FileHandle(fd) {
    this.fd = fd;
  }

  function handleCall(work) {
    try {
      return Promise.resolve(work());
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function viewFor(buf) {
    return ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;
  }

  FileHandle.prototype.read = function (buffer, offset, length, position) {
    var self = this;
    var opts = buffer && typeof buffer === 'object' && !ArrayBuffer.isView(buffer) ? buffer : null;
    var buf = opts ? opts.buffer : buffer;
    var off = opts ? (opts.offset || 0) : (typeof offset === 'number' ? offset : 0);
    var len = opts ? (opts.length === undefined ? buf.length - off : opts.length)
      : (typeof length === 'number' ? length : buf.length - off);
    var at = opts ? opts.position : position;
    return handleCall(function () {
      var n = at === undefined || at === null
        ? fs.readSync(self.fd, buf, off, len)
        : fs.readSync(self.fd, buf, off, len, at);
      return { bytesRead: n, buffer: buf };
    });
  };

  FileHandle.prototype.readv = function (buffers, position) {
    var self = this;
    return handleCall(function () {
      var n = position === undefined || position === null
        ? fs.readvSync(self.fd, buffers)
        : fs.readvSync(self.fd, buffers, position);
      return { bytesRead: n, buffers: buffers };
    });
  };

  FileHandle.prototype.write = function (buffer, offset, length, position) {
    var self = this;
    if (typeof buffer === 'string') {
      var enc = typeof offset === 'string' ? offset : typeof length === 'string' ? length : undefined;
      var strAt = typeof offset === 'number' ? offset : typeof length === 'number' ? length
        : typeof position === 'number' ? position : undefined;
      return handleCall(function () {
        var n = strAt === undefined ? fs.writeSync(self.fd, buffer, undefined, enc)
          : fs.writeSync(self.fd, buffer, strAt, enc);
        return { bytesWritten: n, buffer: buffer };
      });
    }
    var off = typeof offset === 'number' ? offset : 0;
    var len = typeof length === 'number' ? length : viewFor(buffer).length - off;
    return handleCall(function () {
      var n = position === undefined || position === null
        ? fs.writeSync(self.fd, buffer, off, len)
        : fs.writeSync(self.fd, buffer, off, len, position);
      return { bytesWritten: n, buffer: buffer };
    });
  };

  FileHandle.prototype.writev = function (buffers, position) {
    var self = this;
    return handleCall(function () {
      var written = 0;
      var rec = descriptorOf(self.fd, 'write');
      var at = typeof position === 'number' ? position : rec.position;
      for (var i = 0; i < buffers.length; i++) {
        var chunk = viewFor(buffers[i]);
        var n = fs.writeSync(self.fd, chunk, 0, chunk.length, at + written);
        written += n;
      }
      return { bytesWritten: written, buffers: buffers };
    });
  };

  FileHandle.prototype.writeFile = function (data, options) {
    var self = this;
    return handleCall(function () {
      var bytes = writeBytes(data, optionsEncoding(options));
      // Writes from the handle's position and leaves it past what was written, as Node does.
      fs.writeSync(self.fd, bytes, 0, bytes.length);
      return undefined;
    });
  };

  FileHandle.prototype.readFile = function (options) {
    var self = this;
    return handleCall(function () {
      var rec = descriptorOf(self.fd, 'read');
      var bytes = rec.bytes.subarray(rec.position);
      rec.position = rec.bytes.length;
      var enc = optionsEncoding(options);
      return enc ? decodeBytes(bytes, enc) : Buf.from(bytes);
    });
  };

  FileHandle.prototype.appendFile = function (data, options) {
    var self = this;
    return handleCall(function () {
      var rec = descriptorOf(self.fd, 'write');
      var bytes = writeBytes(data, optionsEncoding(options));
      fs.writeSync(self.fd, bytes, 0, bytes.length, rec.bytes.length);
      rec.position = rec.bytes.length;
      return undefined;
    });
  };

  FileHandle.prototype.close = function () {
    var self = this;
    return handleCall(function () {
      fs.closeSync(self.fd);
      self.fd = -1;
      return undefined;
    });
  };

  FileHandle.prototype.stat = function (opts) {
    var self = this;
    return handleCall(function () { return fs.fstatSync(self.fd, opts); });
  };

  FileHandle.prototype.truncate = function (len) {
    var self = this;
    return handleCall(function () { fs.ftruncateSync(self.fd, len === undefined ? 0 : len); });
  };

  FileHandle.prototype.datasync = function () {
    var self = this;
    return handleCall(function () { fs.fdatasyncSync(self.fd); });
  };

  FileHandle.prototype.sync = function () {
    var self = this;
    return handleCall(function () { fs.fsyncSync(self.fd); });
  };

  FileHandle.prototype.chmod = function (mode) {
    var self = this;
    return handleCall(function () { fs.fchmodSync(self.fd, mode); });
  };

  FileHandle.prototype.chown = function (uid, gid) {
    var self = this;
    return handleCall(function () { fs.chownSync(descriptorOf(self.fd, 'fchown').path, uid, gid); });
  };

  FileHandle.prototype.utimes = function (atime, mtime) {
    var self = this;
    return handleCall(function () { fs.utimesSync(descriptorOf(self.fd, 'futimes').path, atime, mtime); });
  };

  /*
   * The *Sync sweep below would hand promises.open the integer fs.openSync returns; Node hands back
   * a handle, so open is replaced here once the sweep has run. Node has no promise form for the f*
   * descriptor calls or for readv either: those live on the handle alone.
   */
  var HANDLE_ONLY = { fstatSync: 1, fchmodSync: 1, ftruncateSync: 1, fdatasyncSync: 1, readvSync: 1 };

  var names = Object.keys(fs);
  var promises = {};
  fs.promises = promises;
  names.forEach(function (syncName) {
    if (syncName.slice(-4) !== 'Sync') return;
    var base = syncName.slice(0, -4);
    var impl = fs[syncName];
    fs[base] = function () {
      var args = Array.prototype.slice.call(arguments);
      var cb = args.pop();
      if (typeof cb !== 'function') throw new TypeError('The "cb" argument must be of type function');
      var result;
      var error = null;
      try {
        result = impl.apply(fs, args);
      } catch (err) {
        error = err;
      }
      queueMicrotask(function () {
        if (error) cb(error);
        else cb(null, result);
      });
    };
    if (!HANDLE_ONLY[syncName]) {
      promises[base] = function () {
        var args = Array.prototype.slice.call(arguments);
        return new Promise(function (resolve, reject) {
          try {
            resolve(impl.apply(fs, args));
          } catch (err) {
            reject(err);
          }
        });
      };
    }
  });
  promises.open = function (p, flags, mode) {
    return new Promise(function (resolve, reject) {
      try {
        resolve(new FileHandle(fs.openSync(p, flags, mode)));
      } catch (err) {
        reject(err);
      }
    });
  };
  fs.exists = function (p, cb) {
    var found = fs.existsSync(p);
    queueMicrotask(function () { cb(found); });
  };
  /*
   * fs.write by descriptor. The file system here is path based and has no descriptors, except for
   * the pty fds the node-pty shim registers in globalThis.__owcPtyFds: node-pty's
   * lib/unixTerminal.js writes a pty's input with fs.write(fd, buffer, offset, callback), so a
   * write to one of those fds goes to the child's stdin and reports the bytes it took. Any other
   * fd goes through the descriptor layer above, which reports EBADF for one it does not know.
   */
  fs.write = function (fd, buffer, offset, length, position, callback) {
    // The callback is the last argument whatever the form: fs.write(fd, buffer[, offset[, length[,
    // position]]], cb) and fs.write(fd, string[, position[, encoding]], cb).
    var last = arguments.length > 1 ? arguments[arguments.length - 1] : undefined;
    var done = typeof last === 'function' ? last : null;
    var table = globalThis.__owcPtyFds;
    var rec = table && typeof fd === 'number' ? table[fd] : undefined;
    if (rec !== undefined && rec.write !== undefined) {
      var bytes = ArrayBuffer.isView(buffer) ? Buf.from(buffer.buffer, buffer.byteOffset, buffer.byteLength) : Buf.from(String(buffer));
      var from = Number(offset) > 0 ? Number(offset) : 0;
      var written = rec.write(bytes.slice(from).toString('utf8'));
      if (done) queueMicrotask(function () { done(null, written); });
      return;
    }
    var args = Array.prototype.slice.call(arguments, 1);
    if (done) args.pop();
    var error = null;
    var count = 0;
    try {
      count = fs.writeSync.apply(fs, [fd].concat(args));
    } catch (err) {
      error = err;
    }
    if (done) queueMicrotask(function () { done(error, count); });
    else if (error) throw error;
  };
  /*
   * Node hangs a .native on realpath and on realpathSync: the binding entry points behind the
   * JavaScript wrappers, which resolve the same path without the cache the wrapper keeps. Both
   * resolve the same path here, so each .native is its own function again. fs-extra reads
   * typeof fs.realpath.native at load time and warns, loudly, when it is not a function.
   */
  fs.realpath.native = fs.realpath;
  fs.realpathSync.native = fs.realpathSync;
  return fs;
};

BF.constants = function () {
  var fsConstants = requireBuiltin('fs').constants;
  var out = {};
  Object.keys(fsConstants).forEach(function (key) {
    out[key] = fsConstants[key];
  });
  return out;
};

BF['fs/promises'] = function () {
  return requireBuiltin('fs').promises;
};
`;
