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

  /* Node's atob and btoa: the web pair, over the base64 a Buffer already reads and writes. btoa
     takes a string of single bytes and atob hands one back, so a character above U+00FF is refused
     here as it is there, and so is a text that is not base64 at all. */
  function b64Error() {
    var err = new Error('Invalid character');
    err.name = 'InvalidCharacterError';
    err.code = 5;
    return err;
  }

  function atobOf(input) {
    /* Node drops ASCII whitespace from the text before it reads it, as the web pair does. */
    var text = String(input).replace(/[\t\n\f\r ]/g, '');
    var body = text.replace(/=+$/, '');
    if (text.length % 4 !== 0 || text.length - body.length > 2 || /[^A-Za-z0-9+/]/.test(body)) throw b64Error();
    return Buffer.from(text, 'base64').toString('latin1');
  }

  function btoaOf(input) {
    var text = String(input);
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) > 0xff) throw b64Error();
    }
    return Buffer.from(text, 'latin1').toString('base64');
  }

  /* Node's File: a Blob with the two fields that make one the value of a form field. */
  var kFileName = Symbol('owcFileName');
  var kFileModified = Symbol('owcFileLastModified');

  class File extends Blob {
    constructor(sources, fileName, options) {
      super(sources, options);
      this[kFileName] = String(fileName);
      var at = options === undefined || options === null ? undefined : options.lastModified;
      this[kFileModified] = typeof at === 'number' && isFinite(at) ? Math.trunc(at) : Date.now();
    }
    get name() {
      return this[kFileName];
    }
    get lastModified() {
      return this[kFileModified];
    }
  }
  Object.defineProperty(File.prototype, Symbol.toStringTag, { value: 'File', configurable: true });

  return {
    Buffer: Buffer,
    kMaxLength: MAX_BUFFER_LENGTH,
    kStringMaxLength: MAX_STRING_LENGTH,
    constants: { MAX_LENGTH: MAX_BUFFER_LENGTH, MAX_STRING_LENGTH: MAX_STRING_LENGTH },
    Blob: Blob,
    File: File,
    /* How much of a Buffer inspect shows before it writes an ellipsis, as on the host. */
    INSPECT_MAX_BYTES: 50,
    atob: atobOf,
    btoa: btoaOf,
    /* The one half of the blob URL store Node keeps: a URL this container never registers, so
       there is nothing for it to resolve, which is what Node answers for one of those too. */
    resolveObjectURL: function () { return undefined; },
    SlowBuffer: function (length) { return Buffer.alloc(Number(length) || 0); },
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
    ENOTSUP: 'operation not supported',
    EBADF: 'bad file descriptor',
    ESPIPE: 'illegal seek',
    ELOOP: 'too many symbolic links encountered'
  };

  /*
   * The errno a host's own error carries, which a package reads as readily as it reads the code. Node
   * reports the platform's number -- the negative of the one errno.h gives -- and EPERM, 1, is the one
   * the -1 any other code used to fall back to happened to get right.
   */
  var ERRNOS = {
    ENOENT: -2,
    EACCES: -13,
    EEXIST: -17,
    ENOTDIR: -20,
    EISDIR: -21,
    EINVAL: -22,
    EBADF: -9,
    ENOTSUP: -45,
    ENOTEMPTY: -66,
    EPERM: -1,
    ESPIPE: -29,
    ELOOP: -62
  };

  function fsError(code, syscall, path) {
    var err = new Error(code + ': ' + DESCRIPTIONS[code] + ', ' + syscall + " '" + path + "'");
    err.errno = ERRNOS[code] === undefined ? -1 : ERRNOS[code];
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
     The link is a name in the tree of its own -- the node a readdir of the directory holding it
     lists -- and what that node carries is a copy of its target's bytes, so a read that does not
     resolve it still sees data. Every call below that acts on the target resolves first: on a
     host, the link is the target for all but the five calls that name the link itself. */
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

  /*
   * The name a path resolves to: every part of it that is a link is replaced by the name that link
   * carries, the way a kernel walks a path -- a link met part of the way along one is followed as
   * surely as the one the path ends at. It is the walk realpath makes, and it is the one every call
   * that acts on what a name points at has to make. Without it a path under a link to a directory is
   * handed to the file system as a name under the link, which is a file, and every question about
   * it is answered ENOENT: an existsSync, a readdirSync, an accessSync and a statfsSync of a link to
   * a directory were all refused, where a host answers for the directory.
   */
  function resolvePath(file) {
    return realPathOf(file).path;
  }

  /*
   * The same walk stopped before the last part: the name an entry has in the directory it really
   * sits in. A rename, a unlink, a rm, an lstat, a lutimes and a readdir entry are all of the entry
   * and not of what it points at -- a host's rename of a link renames the link, and its readdir
   * lists the link -- so those are given this and not resolvePath.
   */
  function resolveParentPath(file) {
    return P.join(resolvePath(P.dirname(file)), P.basename(file));
  }

  /* The name whose bytes a path carries: a link's are the ones its target carries. */
  function bytesNameOf(file) {
    return canonicalOf(resolvePath(file));
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

  /* stat follows every link a path goes through to the name it ends at, the way the kernel does: a
     path whose last part is a link is read as the target, and so is a directory met part of the way
     along one. */
  function statFollowingLinks(file) {
    return statOf(resolvePath(file));
  }

  /*
   * The permission bits a name carries, which is what a read or a write of it is checked against. A
   * file system that reports no mode of its own falls back to the one a host's create leaves behind:
   * 0o644 for a file and 0o755 for a directory.
   */
  function modeBitsOf(st) {
    if (!st) return 0;
    return (st.mode !== undefined ? st.mode : (st.type === 'dir' ? 0o755 : 0o644)) & 0o777;
  }

  /*
   * The directory the four character devices live in is the kernel's on a host, not the user's: a
   * name made in it is refused with EPERM rather than EACCES, and the refusal comes from the file
   * system that mounts it, so a mode check here leaves it to that refusal.
   */
  var DEVICE_DIR = '/dev';

  /*
   * A name made in a directory is checked against that directory's bits, and the directory a mkdir
   * names is the nearest one above the path that is already there -- the whole chain when the mkdir
   * is recursive. A mkdir that was not asked for the parents gets no further than the one directory
   * above it: that one being missing is the ENOENT a host reports, where the parents turning up
   * anyway was this file system's createDirectory making a path instead of a directory.
   */
  function directoryToCreateIn(file, recursive, syscall) {
    var at = P.dirname(file);
    var dir = statFollowingLinks(at);
    while (!dir && recursive) {
      var up = P.dirname(at);
      if (up === at) break;
      at = up;
      dir = statFollowingLinks(at);
    }
    if (!dir) throw fsError('ENOENT', syscall, file);
    if (dir.type !== 'dir') throw fsError('ENOTDIR', syscall, file);
    if (at !== DEVICE_DIR && (modeBitsOf(dir) & 0o200) === 0) throw fsError('EACCES', syscall, file);
  }

  /*
   * A name is made or opened through the directory it sits in, and a host checks the bits of that
   * directory when the name is not there yet: a read or a write of a name that is there is checked
   * against the name's own bits. want is the W_OK/R_OK shape fs.constants gives -- 2 to write, 4 to
   * read -- and the check is made at the open alone, which is why a descriptor opened before a chmod
   * still writes afterwards: a host never rechecks a descriptor it has already handed out.
   */
  /*
   * A name is reached through every directory above it, and a host needs the search bit -- 0o100 --
   * on each one of them: it is what makes a 0000 directory opaque, so that a stat, an open or a read
   * of a name inside it is refused however readable that name is on its own.
   */
  function requireTraverse(file, syscall) {
    var at = P.dirname(toPathString(file));
    for (var hop = 0; hop < 64; hop++) {
      var st = statFollowingLinks(at);
      if (!st || st.type !== 'dir') return;
      if (at !== DEVICE_DIR && (modeBitsOf(st) & 0o100) === 0) throw fsError('EACCES', syscall, file);
      var up = P.dirname(at);
      if (up === at) return;
      at = up;
    }
  }

  /*
   * A name is put into, or taken out of, the directory it sits in, and what a host checks is that
   * directory's write bit -- not the bits of the name itself. A 0555 directory holds a 0644 file
   * that a unlink, a rename, a rmdir, a rm and a symlink or link made in it are all refused for,
   * which is why this is the check those six make and requireAccess is not.
   */
  function requireDirWrite(file, syscall, from, to) {
    var dirPath = P.dirname(toPathString(file));
    var dir = statFollowingLinks(dirPath);
    if (!dir) throw fsError('ENOENT', syscall, file);
    if (dir.type !== 'dir') throw fsError('ENOTDIR', syscall, file);
    if (dirPath !== DEVICE_DIR && (modeBitsOf(dir) & 0o200) === 0) {
      throw from === undefined ? fsError('EACCES', syscall, file) : twoEndError('EACCES', syscall, from, to);
    }
  }

  function requireAccess(file, want, syscall, from, to) {
    requireTraverse(file, syscall);
    var st = statFollowingLinks(file);
    var denied = function () {
      return from === undefined ? fsError('EACCES', syscall, file) : twoEndError('EACCES', syscall, from, to);
    };
    if (st) {
      var bits = modeBitsOf(st);
      if ((want & 2) !== 0 && (bits & 0o200) === 0) throw denied();
      if ((want & 4) !== 0 && (bits & 0o400) === 0) throw denied();
      return;
    }
    var dirPath = P.dirname(file);
    var dir = statFollowingLinks(dirPath);
    if (!dir) throw fsError('ENOENT', syscall, file);
    if (dirPath === DEVICE_DIR) return;
    var dirBits = modeBitsOf(dir);
    if ((want & 2) !== 0 && (dirBits & 0o200) === 0) throw denied();
    if ((want & 4) !== 0 && (dirBits & 0o400) === 0) throw denied();
  }

  /* Node's blocks counts 512-byte blocks while the allocation it reports is in 4096-byte ones: a
     1-byte file holds 8, a 4097-byte one 16, and an empty one none. */
  function blocksOf(size) {
    return Math.ceil(size / 4096) * 8;
  }

  /* Node exports fs.Stats, and packages test a stat with instanceof fs.Stats, so a stat is an
     instance of it. Its own properties are the fourteen numeric fields alone, as on host Node
     24.15: the four dates are getters on fs.Stats.prototype above it, and the seven kind tests on
     a prototype above that, so Object.getOwnPropertyNames(fs.statSync(p)) names no date and no
     test. The type the store recorded travels as a symbol, which no own-name list carries, because
     a mode with no format in it still has to fall back to it. */
  var kStatsType = Symbol('owcStatsType');
  var kStatsLink = Symbol('owcStatsLink');

  function Stats() {}
  Object.defineProperty(Stats.prototype, Symbol.toStringTag, { value: 'Stats', configurable: true });

  var STATS_DATES = ['atime', 'mtime', 'ctime', 'birthtime'];
  for (var sd = 0; sd < STATS_DATES.length; sd++) {
    Object.defineProperty(Stats.prototype, STATS_DATES[sd], {
      configurable: true,
      enumerable: true,
      get: (function (name) {
        return function () { return new Date(Number(this[name + 'Ms'])); };
      })(STATS_DATES[sd])
    });
  }
  /* Node's own helper, which is on fs.Stats.prototype on the host too. */
  Stats.prototype._checkModeProperty = function (property) {
    return (Number(this.mode) & S_IFMT) === property;
  };

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

  /* The seven kind tests, on the prototype above fs.Stats.prototype as they are on the host: a mode
     with a format in it is the authority, and one without falls back to the type the store carries.
     A link is the exception Node makes too -- lstat of one answers isFile() and isDirectory() false
     and isSymbolicLink() true however many bits its mode carries, so the flag lstat was made with
     travels with the stat as a symbol. */
  function statsKind(bit, type, falseForLink) {
    return function () {
      if (falseForLink === true && this[kStatsLink] === true) return false;
      var format = Number(this.mode) & S_IFMT;
      return format === 0 ? this[kStatsType] === type : format === bit;
    };
  }

  var statsKinds = {
    isDirectory: statsKind(S_IFDIR, 'dir', true),
    isFile: statsKind(S_IFREG, 'file', true),
    isBlockDevice: statsKind(S_IFBLK, 'blk', false),
    isCharacterDevice: statsKind(S_IFCHR, 'chr', false),
    isSymbolicLink: function () {
      return this[kStatsLink] === true || (Number(this.mode) & S_IFMT) === S_IFLNK;
    },
    isFIFO: statsKind(S_IFIFO, 'fifo', false),
    isSocket: statsKind(S_IFSOCK, 'sock', false)
  };
  Object.setPrototypeOf(Stats.prototype, statsKinds);

  function makeStats(st, opts, isLink) {
    var bigint = !!(opts && typeof opts === 'object' && opts.bigint);
    // With bigint every numeric field is a BigInt; the four date fields stay Date objects.
    var num = bigint ? function (value) { return BigInt(value); } : function (value) { return value; };
    var mode = st.mode !== undefined ? st.mode : (st.type === 'dir' ? 16877 : (isLink ? 41453 : 33188));
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
      birthtimeMs: num(st.mtimeMs)
    };
    out[kStatsType] = st.type;
    out[kStatsLink] = isLink === true;
    Object.setPrototypeOf(out, Stats.prototype);
    return out;
  }

  var kDirentType = Symbol('owcDirentType');

  function Dirent(name, parentPath, type) {
    this.name = name;
    this.parentPath = parentPath;
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
    var at = resolveParentPath(abs);
    var st = statOf(at) || { type: 'file', size: 0, mtimeMs: 0 };
    return SYMLINKS[at] !== undefined ? { type: 'link', size: st.size, mtimeMs: st.mtimeMs } : st;
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
    return decodeBase64(host.readBase64(bytesNameOf(file)));
  }

  function check(code, syscall, file) {
    if (code) throw fsError(code, syscall, file);
  }

  var fs = {};

  fs.readFileSync = function (p, opts) {
    var file = toPathString(p);
    /* The file a read opens is the one the link names, not the link: its type and its access bits
       are the target's, and so are the bytes that come back. */
    var st = statFollowingLinks(file);
    if (!st) throw fsError('ENOENT', 'open', String(p));
    if (st.type === 'dir') throw fsError('EISDIR', 'read', file);
    requireAccess(file, 4, 'open');
    var enc = optionsEncoding(opts);
    if (enc && normalizeEncoding(enc) === 'utf8') return host.readText(bytesNameOf(file));
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
      var st = statFollowingLinks(file);
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
  /*
   * The mode reaches a call two ways: as the mode of an options object, and as a bare number in the
   * overloads Node kept -- openSync(path, flags, mode) and mkdirSync(path, mode) -- where the number
   * is the whole second or third argument. Both name the same bits, so a number is read here
   * whichever of the two it arrived as.
   */
  var newMode = function (opts, fallback) {
    var asked = typeof opts === 'number' ? opts
      : opts && typeof opts === 'object' && typeof opts.mode === 'number' ? opts.mode : fallback;
    return asked & ~UMASK & 0o7777;
  };

  fs.writeFileSync = function (p, data, opts) {
    var file = toPathString(p);
    var mode = newMode(opts, 0o666);
    var flag = opts && typeof opts === 'object' && opts.flag ? opts.flag : 'w';
    /* A write opens the name for writing, and 'r+' opens it for reading as well: the mode a chmod
       set is checked here, at the open, so a 0444 file is EACCES the way it is on a host. */
    requireAccess(file, (flagLetter(flag) === 'r' || flag.indexOf('+') >= 0 ? 4 : 0) | 2, 'open');
    var bytes;
    if (typeof data === 'string') bytes = encodeString(data, optionsEncoding(opts) || 'utf8');
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = encodeString(String(data), 'utf8');
    /* An append puts the new bytes after the ones already there and leaves those alone. Reading
       the file back to put it in front of them made the cost of one append grow with the file:
       a log that grows by appends paid for every byte it had already written, again, on every
       call, so a 2 MiB log in 512 pieces took minutes where a host takes milliseconds. The file
       system appends, so nothing already written is read or written again. */
    if (flag.charAt(0) === 'a' && statFollowingLinks(file)) {
      check(host.appendBase64(bytesNameOf(file), encodeBase64(bytes)), 'open', file);
      return;
    }
    /* A write of a link is a write of what it names: a host opens the target, so the bytes land
       there and the target's own name is the one that carries them, whether or not it was there
       before the call -- a link to a name nothing has made yet is what makes that name. */
    check(host.writeBase64(bytesNameOf(file), encodeBase64(bytes), mode), 'open', file);
  };

  fs.appendFileSync = function (p, data, opts) {
    fs.writeFileSync(p, data, Object.assign({}, typeof opts === 'object' ? opts : { encoding: opts }, { flag: 'a' }));
  };

  fs.existsSync = function (p) {
    try {
      /* Whether a name is there is whether what it names is there: a link whose target was never
         made is not, which is what a host answers for a dangling one. */
      return statFollowingLinks(toPathString(p)) !== null;
    } catch (err) {
      return false;
    }
  };

  // stat follows a recorded link to its target; lstat reports the link itself.
  fs.statSync = function (p, opts) {
    var file = toPathString(p);
    /* A stat walks the path, so it is the directories above the name that are checked: a name under
       a directory with no search bit is EACCES however readable the name is. */
    requireTraverse(file, 'stat');
    var st = statFollowingLinks(file);
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
    /*
     * A link is reported as itself, whatever its target is: its size is the length of the target it
     * names -- the text symlink was handed, which is not always the path stat follows -- and its
     * mode is the one a host's own lstat of a link reads, 0o120755, until an lchmod gives it
     * another. A link whose target is not there yet has no bytes of its own and Node still reports
     * the link.
     */
    if (linked) {
      var named = LINKTARGETS[file] !== undefined ? LINKTARGETS[file] : SYMLINKS[file];
      st = {
        type: 'file',
        size: String(named).length,
        mtimeMs: st ? st.mtimeMs : 0,
        mode: MODES[file] !== undefined ? MODES[file] : 41453
      };
    }
    if (!st) {
      if (opts && opts.throwIfNoEntry === false) return undefined;
      throw fsError('ENOENT', 'lstat', file);
    }
    return makeStats(st, opts, linked);
  };

  /*
   * rename, copyfile, link and symlink name both ends of what they were asked for in the error they
   * raise -- "rename 'a' -> 'b'" -- which is the pair a caller recognises its own call in.
   */
  function twoEndError(code, syscall, from, to) {
    var err = fsError(code, syscall, to);
    err.message = code + ': ' + DESCRIPTIONS[code] + ', ' + syscall + " '" + from + "' -> '" + to + "'";
    return err;
  }

  // Node names both ends of a symlink in its error: 'symlink '<target>' -> '<link>''.
  function symlinkError(code, from, to) {
    return twoEndError(code, 'symlink', from, to);
  }

  /*
   * Node's rm is its own rimraf walk rather than one binding call, and the error it raises carries the
   * errno number itself where every other call carries its negation, and the path twice: "EACCES,
   * Permission denied: p 'p'".
   */
  function rmAccessError(file) {
    var err = new Error("EACCES, Permission denied: " + file + " '" + file + "'");
    err.errno = 13;
    err.code = 'EACCES';
    err.syscall = 'rm';
    err.path = file;
    return err;
  }

  fs.symlinkSync = function (target, linkPath) {
    var raw = target && typeof target === 'object' && target.href ? target.href : String(target);
    var to = toPathString(linkPath);
    // A relative target names a path beside the link, not one under the working directory: that is
    // where the system resolves it when the link is opened, and where Node leaves it for readlink.
    var from = P.isAbsolute(raw) ? toPathString(raw) : P.resolve(P.dirname(to), raw);
    if (statOf(to)) throw symlinkError('EEXIST', from, to);
    /* The link is a name made in the directory it is put in, and a host refuses one in a directory
       with no write bit for it. */
    requireDirWrite(to, 'symlink', raw, to);
    /*
     * The link is a name in the tree whether or not its target is there: the node is what a readdir
     * of the directory holding it lists, what a mkdir or a symlink of the same name is refused for
     * with EEXIST, and what a unlink or a rm takes away. What it carries is a copy of its target's
     * bytes, since that is what a read that does not resolve -- a shell's cat, say -- has always
     * seen; a directory has none, and a target that is not there yet leaves the node empty, which
     * is what a dangling link is. Nothing below reads the target through that copy: every call
     * resolves the link first, so the copy is never what a caller reaches.
     */
    var targetStat = statFollowingLinks(from);
    var carried = targetStat && targetStat.type === 'file' ? readBytesOf(from) : new Uint8Array(0);
    check(host.writeBase64(to, encodeBase64(carried), 0o755), 'symlink', to);
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
    var st = statFollowingLinks(from);
    if (!st) throw fsError('ENOENT', 'link', String(existingPath));
    if (st.type === 'dir') throw fsError('EPERM', 'link', String(existingPath));
    if (statOf(to)) throw fsError('EEXIST', 'link', String(newPath));
    /* The second name is made in the directory it is put in, so it is that directory's write bit a
       host checks rather than the bits of the name being linked. */
    requireDirWrite(to, 'link', from, to);
    var canonical = bytesNameOf(from);
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
    /* A listing of a link is a listing of the directory it names: the names it hands back are the
       target's, and the entries carry the link's name above them. */
    var at = resolvePath(file);
    var st = statOf(at);
    if (!st) throw fsError('ENOENT', 'scandir', file);
    if (st.type !== 'dir') throw fsError('ENOTDIR', 'scandir', file);
    /* Listing a directory reads it, so a directory with no read bit is EACCES here the way it is on
       a host: the names under it are not readable through it, whatever their own modes are. */
    requireAccess(file, 4, 'scandir');
    var withTypes = !!(opts && typeof opts === 'object' && opts.withFileTypes);
    var recursive = !!(opts && typeof opts === 'object' && opts.recursive);
    var base = typeof p === 'string' ? p : file;
    if (!recursive) {
      var names = sortedEntries(at);
      if (!withTypes) return names;
      return names.map(function (name) {
        return makeDirent(name, direntStatsOf(P.join(at, name)), base);
      });
    }
    // Node's recursive listing is breadth first: one directory's entries in sorted order, then the next level.
    var out = [];
    var queue = [{ abs: at, str: base, rel: '' }];
    for (var q = 0; q < queue.length; q++) {
      var cur = queue[q];
      var kids = sortedEntries(cur.abs);
      for (var k = 0; k < kids.length; k++) {
        var childAbs = P.join(cur.abs, kids[k]);
        var childSt = direntStatsOf(childAbs);
        var childRel = cur.rel === '' ? kids[k] : cur.rel + '/' + kids[k];
        out.push(withTypes ? makeDirent(kids[k], childSt, cur.str) : childRel);
        /* A link to a directory is listed as a link, and Node's walk still descends into it: the
           names it hands back carry the link's name above the target's. */
        var followed = statFollowingLinks(childAbs);
        if (followed && followed.type === 'dir') queue.push({ abs: resolvePath(childAbs), str: P.join(cur.str, kids[k]), rel: childRel });
      }
    }
    return out;
  };

  fs.mkdirSync = function (p, opts) {
    var file = toPathString(p);
    var recursive = !!(opts && typeof opts === 'object' && opts.recursive);
    var existing = statOf(file);
    if (existing) {
      /* A recursive mkdir of a name that is already there is the one case that is not a failure,
         and it is not a failure of a link to a directory either: the directory the link names is
         the one mkdir -p was asked for. */
      if (recursive && (existing.type === 'dir' || (statFollowingLinks(file) || {}).type === 'dir')) return undefined;
      throw fsError('EEXIST', 'mkdir', file);
    }
    directoryToCreateIn(file, recursive, 'mkdir');
    check(host.mkdir(resolvePath(file), newMode(opts, 0o777)), 'mkdir', file);
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
    try { requireDirWrite(file, 'rm'); } catch (err) {
      if (err.code === 'EACCES') throw rmAccessError(file);
      throw err;
    }
    check(host.rm(file, recursive), 'rm', file);
    /* The link's record goes with the name the rm took away; what it pointed at stays. */
    delete SYMLINKS[file];
    delete LINKTARGETS[file];
  };

  fs.rmdirSync = function (p, opts) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'rmdir', file);
    if (st.type !== 'dir') throw fsError('ENOTDIR', 'rmdir', file);
    requireDirWrite(file, 'rmdir');
    check(host.rm(file, !!(opts && opts.recursive)), 'rmdir', file);
  };

  fs.unlinkSync = function (p) {
    var file = toPathString(p);
    var st = statOf(file);
    if (!st) throw fsError('ENOENT', 'unlink', file);
    if (st.type === 'dir') throw fsError('EISDIR', 'unlink', file);
    /* The name goes out of the directory it sits in, and it is that directory a host checks: a 0555
       directory keeps every name in it however writable the name itself is. */
    requireDirWrite(file, 'unlink');
    check(host.rm(file, false), 'unlink', file);
    /* A second name of a file is dropped from the table when its own name goes; the bytes it was
       sharing stay under the name they were written to. */
    delete LINKS[file];
    /* So is the record of a link: what the name pointed at stays, the link itself does not. */
    delete SYMLINKS[file];
    delete LINKTARGETS[file];
  };

  fs.renameSync = function (from, to) {
    var a = toPathString(from);
    var b = toPathString(to);
    /* A rename moves the name and not what it points at, so a link is renamed as the link: the walk
       stops before the last part of the path, which is the name being moved. */
    var at = resolveParentPath(a);
    var bt = resolveParentPath(b);
    if (!statOf(at)) throw fsError('ENOENT', 'rename', a);
    /* A rename takes a name out of the directory it is in and puts one into the directory it is
       moved to, and a host checks the write bit of both. */
    requireDirWrite(at, 'rename', a, b);
    requireDirWrite(bt, 'rename', a, b);
    check(host.rename(at, bt), 'rename', a);
    /* The record follows the name: a link renamed is the same link, at the name it was moved to. */
    if (SYMLINKS[at] !== undefined) { SYMLINKS[bt] = SYMLINKS[at]; delete SYMLINKS[at]; }
    if (LINKTARGETS[at] !== undefined) { LINKTARGETS[bt] = LINKTARGETS[at]; delete LINKTARGETS[at]; }
    if (LINKS[at] !== undefined) { LINKS[bt] = LINKS[at]; delete LINKS[at]; }
  };

  fs.copyFileSync = function (from, to) {
    var src = toPathString(from);
    var dest = toPathString(to);
    if (!statFollowingLinks(src)) throw fsError('ENOENT', 'copyfile', src);
    /* A copy reads one name and writes the other, so both modes are checked: a 0444 destination is
       EACCES the way a host answers it, even though the bytes of it are what the copy replaces. */
    requireAccess(src, 4, 'copyfile', src, dest);
    requireAccess(dest, 2, 'copyfile', src, dest);
    /* The bytes go into what the destination names, not into the link standing there: a copy onto a
       link writes the target and leaves the link a link. */
    check(host.writeBase64(bytesNameOf(dest), encodeBase64(readBytesOf(src))), 'copyfile', src);
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
    var st = statFollowingLinks(src);
    if (!st) throw fsError('ENOENT', 'cp', src);
    if (st.type === 'dir') {
      if (!opts.recursive) throw eisdirError('cp', src);
      if (statOf(dest)) {
        if (opts.errorOnExist) throw fsError('EEXIST', 'cp', dest);
      } else {
        check(host.mkdir(resolvePath(dest), opts.mode === undefined ? newMode(null, 0o777) : opts.mode), 'cp', dest);
      }
      var names = sortedEntries(resolvePath(src));
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
    check(host.writeBase64(bytesNameOf(dest), encodeBase64(readBytesOf(src)), 0o644), 'cp', src);
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
    /* access asks about what the name points at, not about the link standing there. */
    var st = statFollowingLinks(file);
    if (!st) throw fsError('ENOENT', 'access', file);
    var want = mode === undefined || mode === null ? 0 : Number(mode);
    if (want === 0) return;
    var bits = (st.mode !== undefined ? st.mode : (st.type === 'dir' ? 0o755 : 0o644)) & 0o777;
    if (want & 4) { if (!(bits & 0o400)) throw fsError('EACCES', 'access', file); }
    if (want & 2) { if (!(bits & 0o200)) throw fsError('EACCES', 'access', file); }
    if (want & 1) { if (!(bits & 0o100)) throw fsError('EACCES', 'access', file); }
  };

  /*
   * realpath resolves the links a path goes through, which is what the name asks for and what stat
   * already does one hop at a time: a component that is a link is replaced by the target it names and
   * the walk of what is left starts again from there, so a link to a directory carries the names
   * under it and a link to a link is followed to the end. A path with no link in it is the path it
   * was given, normalised, which is all toPathString has already left.
   */
  function realPathOf(file) {
    var out = file;
    var seen = {};
    var linked = false;
    var loop = false;
    for (var pass = 0; pass < 64; pass++) {
      /* A cycle of links is a walk that comes back to a path it already stood on: a host stops there
         with ELOOP rather than going round until the pass count runs out. */
      if (seen['p' + out] !== undefined) { loop = true; break; }
      seen['p' + out] = true;
      var parts = out.split('/').filter(function (s) { return s.length > 0; });
      var replaced = false;
      for (var i = 0; i < parts.length; i++) {
        var link = SYMLINKS['/' + parts.slice(0, i + 1).join('/')];
        if (link === undefined) continue;
        var target = P.resolve(link);
        var tail = parts.slice(i + 1);
        out = tail.length > 0 ? P.resolve(target, tail.join('/')) : target;
        replaced = true;
        linked = true;
        break;
      }
      if (!replaced) break;
    }
    return { path: out, linked: linked, loop: loop };
  }

  /*
   * The error a path that does not resolve carries. A host's realpathScan reaches a name with no link
   * in it through lstat, and the target a link named through the stat of that target -- which is why
   * a dangling link and a cycle are both 'stat' while a plain missing name is 'lstat'. The .native
   * entry point is uv_fs_realpath, and it names realpath in either case. A cycle is ELOOP, not the
   * ENOENT a target that simply is not there is.
   */
  function realPathError(seen, native) {
    if (seen.loop) return fsError('ELOOP', native ? 'realpath' : 'stat', '');
    return fsError('ENOENT', native ? 'realpath' : (seen.linked ? 'stat' : 'lstat'), '');
  }

  function realPathSync(p, native) {
    var file = toPathString(p);
    var resolved = realPathOf(file);
    if (statOf(resolved.path)) return resolved.path;
    var err = realPathError(resolved, native);
    err.path = file;
    err.message = err.code + ': ' + DESCRIPTIONS[err.code] + ', ' + err.syscall + " '" + file + "'";
    throw err;
  }

  fs.realpathSync = function (p) { return realPathSync(p, false); };
  /* Node's .native is the binding entry point behind the JavaScript wrapper: it resolves the same
     path and differs only in the syscall it names when it does not resolve. */
  fs.realpathSync.native = function (p) { return realPathSync(p, true); };

  /*
   * mkdtemp replaces the run of X's at the end of the prefix with random characters -- a template
   * whose X's are still there in the name it hands back is a prefix it never substituted -- and
   * makes the directory 0o700, because a temporary directory is private to the user who asked for
   * it. It is retried while the name is taken, the way mkdtemp(3) is.
   */
  /*
   * mkdtemp hands back the prefix with its run of X's replaced and six more characters after it --
   * the six Node appends to the prefix before it calls mkdtemp(3), which is what makes the template
   * the ENOENT of a missing parent names 'XXXXXX' longer than the prefix was. Substituting only the
   * run the caller wrote is a shorter name: 'three-XXX' comes back with three characters here and
   * with nine on a host.
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
    var width = (run ? run[0].length : 0) + 6;
    /* A mkdtemp whose directory is not there is the ENOENT Node reports against the template -- the
       prefix with the six X's it appends still in it -- and not against one of the names it would
       have tried. */
    if (!statFollowingLinks(P.dirname(toPathString(raw)))) {
      throw fsError('ENOENT', 'mkdtemp', raw + 'XXXXXX');
    }
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

  /*
   * The three descriptors every process starts with, and why they are in the table at all: the
   * table held only the descriptors this file system had opened by name, and no name is ever opened
   * for fd 0, 1 or 2, so a program whose synchronous-output idiom is fs.writeSync(1, text) was
   * answered EBADF -- bad file descriptor -- where a host writes the text to its standard output.
   * A host's own three are what the process was started with, which is a pipe here: a write to 1 or
   * 2 goes out through the same sink process.stdout and process.stderr write to, and a read of 0
   * asks a pipe nobody has filled, which is end of input and not an error. None of them names a
   * file, so every call below that would resolve rec.path skips a stdio descriptor instead.
   *
   * A pipe is what libuv hands a child for its stdio, and the mode fstatSync reads off one carries
   * S_IFSOCK in it because libuv backs that pipe with a socketpair: measured against host node
   * 24.15, fstatSync(1) and fstatSync(2) read 49590 (0o140666) and fstatSync(0) 49298 (0o140222).
   */
  var STDIO_MODES = [49298, 49590, 49590];
  /* A stdio descriptor is born with the process, so the four dates its stat reports are one stamp
     read now rather than four that move under a program that stats it twice. */
  var STDIO_BORN = Date.now();

  function stdioDescriptor(fd) {
    return {
      path: null,
      stdio: fd,
      flags: fd === 0 ? 'r' : 'w',
      device: false,
      bytes: new Uint8Array(0),
      position: 0,
      writable: fd !== 0,
      readable: fd === 0,
      isDir: false,
      dirty: false
    };
  }

  for (var stdioAt = 0; stdioAt <= 2; stdioAt++) DESCRIPTORS[stdioAt] = stdioDescriptor(stdioAt);

  /* The sink a write to fd 1 or fd 2 reaches, which is the one process.stdout and process.stderr
     write to: the two are the same channel, and a byte written through either comes out in order. */
  function stdioWrite(fd, bytes) {
    var text = Buf.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
    if (fd === 1) host.stdout(text); else host.stderr(text);
  }

  /*
   * Node hands back the lowest descriptor that is free: a close puts its number back in the pool and
   * the next open takes it again, so a program that opens and closes in a loop stays at one number
   * instead of walking up without bound. A monotonic counter handed out a new number every time and
   * never gave one back.
   */
  function allocateDescriptor() {
    var fd = 3;
    // The pty fds the node-pty shim hands out start at 1000; never hand a file one of those.
    while (DESCRIPTORS[fd] !== undefined || (globalThis.__owcPtyFds && globalThis.__owcPtyFds[fd] !== undefined)) fd++;
    return fd;
  }

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
    var given = toPathString(p);
    /* An open of a link opens the file the link names, as a host's open(2) does: the descriptor
       that comes back is one on the target, so a write through it reaches the target and the bytes
       it was opened with are the target's. Every part of the path is resolved, so a name under a
       link to a directory opens the file the directory holds. Errors still name the path the caller
       handed over. */
    var file = resolvePath(given);
    var letter = flagLetter(f);
    var creates = letter === 'w' || letter === 'a';
    var st = statOf(file);
    var isDir = !!(st && st.type === 'dir');
    /* What the flags ask for is what the mode is checked against, at the open: 'r' needs the read
       bit, 'w' and 'a' the write bit, and a '+' both. A name that is not there yet is checked
       against the directory it would be made in. */
    requireAccess(file, (letter === 'r' || f.indexOf('+') >= 0 ? 4 : 0) | (letter === 'r' && f.indexOf('+') < 0 ? 0 : 2), 'open');
    /* An 'x' in the flags is O_EXCL: the open is the creation of the name and fails when the name is
       already there, which is how a lock file and a cache write both ask for one writer. */
    if (creates && f.indexOf('x') >= 0 && st) throw fsError('EEXIST', 'open', given);
    if (creates) {
      if (isDir) throw fsError('EISDIR', 'open', given);
      /* A mode belongs to the creation and to nothing else: the name a 'w' truncates keeps the bits
         it already has, the way a host's open(2) applies O_CREAT's mode only when it makes the name.
         The default is the one a host leaves -- 0o666 for a file, masked with the umask. */
      if (!st) check(host.writeBase64(file, encodeBase64(new Uint8Array(0)), newMode(mode, 0o666)), 'open', given);
      else if (letter === 'w') check(host.writeBase64(file, encodeBase64(new Uint8Array(0))), 'open', given);
    } else if (!st) {
      throw fsError('ENOENT', 'open', given);
    }
    var bytes = letter === 'w' || !st || isDir ? new Uint8Array(0) : readBytesOf(file);
    var fd = allocateDescriptor();
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
    /* A stdio descriptor is the channel and not a buffer over one: the bytes go out as they are
       written, at no position and with nothing kept behind them, which is what a host's write(2) to
       a pipe does with them. */
    if (rec.stdio !== undefined) {
      stdioWrite(rec.stdio, bytes);
      return bytes.length;
    }
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
    /*
     * A read of the descriptor 0 takes what the process's standard input carries: it is the read end
     * of the pipe the process was started with, and the same pipe process.stdin reads, so what has
     * been written to it and not taken yet is what a read gets. A read that finds nothing there
     * reports end of input -- 0 bytes, as a host's read of a pipe does -- rather than the EBADF an
     * unopened number would give. The pipe has no position to seek to, so a read that asks for one
     * is ESPIPE, which is what host node 24.15 answers; fd 1 and fd 2 are the write ends and were
     * never readable, so a read of either is the EBADF above.
     */
    if (rec.stdio === 0) {
      if (explicitRead(offset, length, position)) throw noPathError('ESPIPE', 'read');
      var room = Math.max(0, (buffer.length || 0) - off);
      var chunk = stdinTakeBytes(Math.min(len, room));
      var sink = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : buffer;
      for (var s = 0; s < chunk.length; s++) sink[off + s] = chunk[s];
      return chunk.length;
    }
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
    /* A sync of a pipe is not a thing a host can do for it, and it says so: ENOTSUP here, where a
       sync of a file this file system holds is the flush of the buffer behind the descriptor. */
    var rec = descriptorOf(fd, 'fsync');
    if (rec.stdio !== undefined) throw noPathError('ENOTSUP', 'fsync');
    flushDescriptor(rec, 'fsync');
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
    /* The errno a host pairs the code with, which is the one ERRNOS keeps; -1 remains the answer for
       a code the table has none of, as it was. */
    err.errno = ERRNOS[code] !== undefined ? ERRNOS[code] : -1;
    err.code = code;
    err.syscall = syscall;
    return err;
  }

  function descriptorStats(rec) {
    /* A stdio descriptor names no path, so there is no stat of one to fall back on: what it reports
       is the pipe it is, in the one mode a host's fstat of its own stdio reads. */
    if (rec.stdio !== undefined) {
      return makeStats({ type: 'sock', size: 0, mtimeMs: STDIO_BORN, mode: STDIO_MODES[rec.stdio] });
    }
    var st = statOf(rec.path);
    /*
     * A descriptor of a device holds the one chunk a read of it yields -- 4096 bytes of zeroes or of
     * entropy -- and not its size, so the buffer's length is not what to report for it: a host's
     * fstat of an open /dev/zero says 0, and this file system's own statSync of the same path says 0
     * with it. Saying 4096 for one and 0 for the other made the pair contradict each other.
     */
    var size = isCharacterDevice(st) ? st.size : rec.bytes.length;
    return makeStats({
      type: st ? st.type : (rec.isDir ? 'dir' : 'file'),
      size: size,
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

  function resizedBytes(bytes, size) {
    var next = new Uint8Array(size);
    var keep = Math.min(size, bytes.length);
    for (var i = 0; i < keep; i++) next[i] = bytes[i];
    return next;
  }

  /*
   * A truncate changes the file, not the copy of it a descriptor took when the descriptor was
   * opened: one left open across a truncate kept reading the bytes the truncate had removed,
   * where a host's read through the same descriptor stops at the new end of file. Every
   * descriptor of the name is resized with it -- a grow fills with zero bytes, the way ftruncate
   * does -- so the read that follows ends where the host's ends, and a descriptor that is dirty
   * pushes the shortened bytes rather than the ones it held. A device has no bytes for a truncate
   * to resize and a directory is not truncated at all, so neither is touched here. A stdio
   * descriptor is skipped for the same reason: it holds no bytes of a file's, and it has no name
   * for the comparison to be made against.
   */
  function resizeDescriptors(file, size) {
    var canonical = canonicalOf(resolvePath(file));
    var fds = Object.keys(DESCRIPTORS);
    for (var i = 0; i < fds.length; i++) {
      var rec = DESCRIPTORS[fds[i]];
      if (rec.isDir || rec.device || rec.stdio !== undefined || canonicalOf(rec.path) !== canonical) continue;
      rec.bytes = resizedBytes(rec.bytes, size);
      if (rec.position > size) rec.position = size;
    }
  }

  fs.ftruncateSync = function (fd, len) {
    var rec = descriptorOf(fd, 'ftruncate');
    if (!rec.writable) throw noPathError('EINVAL', 'ftruncate');
    /* A host refuses to set the length of a pipe: ftruncate of one is EINVAL, and its error carries
       the syscall and no path, which is the shape noPathError makes. */
    if (rec.stdio !== undefined) throw noPathError('EINVAL', 'ftruncate');
    var size = truncateLength(len);
    resizeDescriptors(rec.path, size);
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
    var rec = descriptorOf(fd, 'fdatasync');
    if (rec.stdio !== undefined) throw noPathError('ENOTSUP', 'fdatasync');
    flushDescriptor(rec, 'fdatasync');
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
    /* Like a chmod, a utimes is of what the name points at: the times go on the target, and the
       link keeps the ones it was made with until a lutimes moves them. */
    var at = resolvePath(file);
    if (!statOf(at)) throw fsError('ENOENT', 'utime', file);
    MTIMES[at] = timeToMs(mtime);
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
  /*
   * A device's kind is the format its mode carries -- S_IFCHR, the bits that make /dev/zero a
   * character device and not a file -- so the mode written here used to overwrite those bits with
   * S_IFREG and leave /dev/zero a regular file that answered isFile() true, where a host refuses the
   * chmod of a node in /dev with EPERM and leaves the device alone. Refusing is what a host does,
   * and it is what keeps the type: no caller reaches the mode it would have overwritten.
   */
  function setModeOf(file, mode, syscall) {
    var st = statOf(file);
    if (!st) return null;
    if (isCharacterDevice(st)) throw fsError('EPERM', syscall, file);
    var bits = typeof mode === 'string' ? parseInt(mode, 8) : Number(mode);
    if (!isFinite(bits)) bits = 0;
    MODES[file] = (st.type === 'dir' ? 16384 : 32768) | (bits & 4095);
    return st;
  }

  fs.chmodSync = function (p, mode) {
    var file = toPathString(p);
    /* A chmod acts on what the name points at, so the mode is recorded against the target: a chmod
       of a link moves the target's bits and leaves the link's own alone, the way a host's does.
       The error still names the path the caller handed over. */
    if (!setModeOf(resolvePath(file), mode, 'chmod')) throw fsError('ENOENT', 'chmod', file);
  };

  fs.fchmodSync = function (fd, mode) {
    var rec = descriptorOf(fd, 'fchmod');
    /* The mode of a pipe is not one a caller sets, and a host's fchmod of one is EINVAL. */
    if (rec.stdio !== undefined) throw noPathError('EINVAL', 'fchmod');
    if (!setModeOf(rec.path, mode, 'fchmod')) throw fsError('ENOENT', 'fchmod', rec.path);
  };

  fs.chownSync = function (p, uid, gid) {
    var file = toPathString(p);
    if (!statFollowingLinks(file)) throw fsError('ENOENT', 'chown', file);
  };

  /* The five calls Node has beside utimes, chown and chmod for the two targets those do not reach:
     a link instead of what it points at, and a descriptor instead of a path. This file system keeps
     no owner of its own, so a chown is the existence check Node makes, and a mode there is no host
     to write through to is kept as chmodSync keeps it. The sweep below gives each its callback and
     promise form, as it does for every other name here that ends in Sync. */
  fs.lutimesSync = function (p, atime, mtime) {
    var file = toPathString(p);
    if (!statOf(file)) throw fsError('ENOENT', 'lutime', file);
    MTIMES[file] = timeToMs(mtime);
  };

  fs.futimesSync = function (fd, atime, mtime) {
    var rec = descriptorOf(fd, 'futime');
    /* The times of a pipe are not a caller's to set either, and a host's futimens of one is EINVAL. */
    if (rec.stdio !== undefined) throw noPathError('EINVAL', 'futime');
    if (!statOf(rec.path)) throw fsError('ENOENT', 'futime', rec.path);
    MTIMES[rec.path] = timeToMs(mtime);
  };

  fs.fchownSync = function (fd, uid, gid) {
    var rec = descriptorOf(fd, 'fchown');
    /* A pipe has an owner and a mode a caller cannot change; a host's fchown of one is EINVAL. */
    if (rec.stdio !== undefined) throw noPathError('EINVAL', 'fchown');
    if (!statOf(rec.path)) throw fsError('ENOENT', 'fchown', rec.path);
  };

  fs.lchownSync = function (p, uid, gid) {
    var file = toPathString(p);
    if (!statOf(file)) throw fsError('ENOENT', 'lchown', file);
  };

  fs.lchmodSync = function (p, mode) {
    var file = toPathString(p);
    if (!setModeOf(file, mode, 'lchmod')) throw fsError('ENOENT', 'open', file);
  };

  /* read streams read the file once and push it in highWaterMark-sized chunks; write streams append each chunk */

  /* Node exports the classes createReadStream and createWriteStream answer with, and the two names
     they carried before, so a stream is an instance of all four. The prototype waits for the first
     stream, because the stream built-in is not loaded when this module is. */
  function ReadStream() {}
  function WriteStream() {}
  var readStreamProto = false;
  var writeStreamProto = false;

  function streamProtoOf(Ctor, Base, ready) {
    if (ready !== true) {
      Ctor.prototype = Object.create(Base.prototype);
      Ctor.prototype.constructor = Ctor;
    }
    return Ctor.prototype;
  }

  fs.ReadStream = ReadStream;
  fs.FileReadStream = ReadStream;
  fs.WriteStream = WriteStream;
  fs.FileWriteStream = WriteStream;

  fs.createReadStream = function (p, opts) {
    var Readable = requireBuiltin('stream').Readable;
    var Buf = requireBuiltin('buffer').Buffer;
    var options = typeof opts === 'string' ? { encoding: opts } : (opts || {});
    /*
     * A descriptor in the options is what makes this a stream over a number the caller already has:
     * createReadStream(null, { fd: 0 }) is the stream a host hands back for the process's own
     * standard input, so there is no name to open and every chunk comes out of a read of that number.
     * Answering it with a stream over a file called 'null' -- which is what a path built out of the
     * null name is -- opened that name and failed ENOENT instead of reading the input.
     */
    var onFd = typeof options.fd === 'number' ? options.fd : null;
    var file = toPathString(p);
    if (onFd !== null) return descriptorReadStream(onFd, options);
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
    var wantsRead = false;
    var stream = new Readable({
      highWaterMark: chunkSize,
      read: function () {
        /* Node's own stream answers no read before its open has run -- the open is a request of its
           own and the read is a second one -- so a chunk reaches nobody in the turn the stream was
           made in, and an immediate armed before the stream still runs first ('ideI' on host node
           24.15, where reading in that turn measured 'deiI'). */
        if (bytes === null) {
          wantsRead = true;
          return;
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
    settleIO(function () {
      if (!statFollowingLinks(file)) {
        stream.destroy(fsError('ENOENT', 'open', file));
        return;
      }
      try {
        bytes = readBytesOf(file);
        if (rangeStart > 0 || rangeEnd !== Infinity) bytes = bytes.subarray(rangeStart, Math.min(rangeEnd + 1, bytes.length));
      } catch (err) {
        stream.destroy(err);
        return;
      }
      stream.emit('open', 3);
      stream.emit('ready');
      /*
       * The read, which is a request of its own and not part of the open: the first chunk reaches the
       * reader in the poll phase of the turn after the one the stream was made in, so an immediate
       * armed with the stream runs before any of it ('ideI' on host node 24.15).
       */
      settleIO(function () {
        if (!wantsRead) return;
        wantsRead = false;
        /* the read that was turned away is still owed, and it is owed outside the turn that asked:
           the cycle it opened is over, so the state that closed it is reset before the read that
           answers it, which is the only way a stream that has stalled waiting reaches its end. */
        if (stream._readableState) stream._readableState.reading = false;
        stream.read(0);
      }, false);
    }, false);
    Object.setPrototypeOf(stream, streamProtoOf(ReadStream, Readable, readStreamProto));
    readStreamProto = true;
    return stream;
  };

  /*
   * A stream over a descriptor the caller already holds: the one a host hands back for
   * createReadStream(null, { fd: 0 }). Nothing is opened -- the number is already open -- so there
   * is no 'open' event and no name on the stream, and each chunk is one read of the number, which
   * on fd 0 is the process's standard input. A read that answers 0 is the end of it, as it is on a
   * pipe a host's stream is reading.
   */
  function descriptorReadStream(fd, options) {
    var Readable = requireBuiltin('stream').Readable;
    var Buf = requireBuiltin('buffer').Buffer;
    var chunkSize = options.highWaterMark || 65536;
    var stream = new Readable({
      highWaterMark: chunkSize,
      read: function () {
        var buf = Buf.alloc(chunkSize);
        var n;
        try {
          n = fs.readSync(fd, buf, 0, chunkSize);
        } catch (err) {
          stream.destroy(err);
          return;
        }
        if (n <= 0) {
          stream.push(null);
          return;
        }
        stream.bytesRead += n;
        stream.push(Buf.from(buf.subarray(0, n)));
      }
    });
    stream.fd = fd;
    stream.path = undefined;
    // like Node, the byte count starts at 0 and holds what the stream has read out of the number
    stream.bytesRead = 0;
    if (options.encoding) stream.setEncoding(options.encoding);
    /* autoClose is on unless a caller turns it off, so a stream that reaches its end closes the
       number behind it, as a host's does: a later read through that number is EBADF. */
    if (options.autoClose !== false) {
      stream.on('end', function () {
        try { fs.closeSync(fd); } catch (err) { stream.destroy(err); }
      });
    }
    Object.setPrototypeOf(stream, streamProtoOf(ReadStream, Readable, readStreamProto));
    readStreamProto = true;
    return stream;
  }

  fs.createWriteStream = function (p, opts) {
    var Writable = requireBuiltin('stream').Writable;
    var options = typeof opts === 'string' ? { encoding: opts } : (opts || {});
    var file = toPathString(p);
    var flags = options.flags || 'w';
    /* A descriptor in the options is what makes this a stream over a number the caller already has:
       createWriteStream(null, { fd: 1 }) is the stream a host hands back for the process's own
       standard output, so there is no name to open or to truncate and every chunk goes through
       fs.writeSync on that number. Answering it with a stream over a file called 'null' -- which is
       what a path built out of the null name is -- wrote the chunk into the file system instead. */
    var onFd = typeof options.fd === 'number' ? options.fd : null;
    var opened = false;
    var waiting = [];
    function writeChunk(chunk, encoding, callback) {
      try {
        if (onFd !== null) {
          stream.bytesWritten += fs.writeSync(onFd, chunk);
        } else {
          fs.appendFileSync(file, chunk);
          stream.bytesWritten += chunk.length;
        }
        callback();
      } catch (err) {
        callback(err);
      }
    }
    var stream = new Writable({
      write: function (chunk, encoding, callback) {
        /* A write is answered the way the file's own requests are: after the open, which is a
           request of its own, so 'close' follows an immediate armed with the stream instead of
           preceding it ('iCI' on host node 24.15, where writing in that turn measured 'CiI'). */
        if (!opened) {
          waiting.push([chunk, encoding, callback]);
          return;
        }
        writeChunk(chunk, encoding, callback);
      }
    });
    stream.path = onFd !== null ? undefined : file;
    stream.bytesWritten = 0;
    /* autoClose is on unless a caller turns it off, so ending a stream over a descriptor closes the
       number behind it, as a host's does: a later write through that number is EBADF. */
    if (onFd !== null && options.autoClose !== false) {
      stream.on('finish', function () {
        try { fs.closeSync(onFd); } catch (err) { stream.destroy(err); }
      });
    }
    /* Like Node, the file is opened when the stream is created and not on the first write: a name the
       mode forbids is an 'error' then, so a caller waiting on 'error' or 'open' is answered instead
       of left waiting on a stream that never opens. A stream over a descriptor has nothing to open,
       because the caller opened it, but the events a caller waits on are still 'open' and 'ready'. */
    settleIO(function () {
      try {
        if (onFd === null) {
          if (flags.charAt(0) === 'w') fs.writeFileSync(file, '');
          else requireAccess(file, 2, 'open');
        }
      } catch (err) {
        stream.destroy(err);
        return;
      }
      opened = true;
      stream.emit('open', onFd === null ? 3 : onFd);
      stream.emit('ready');
      /* the writes the open was waited for: answered in the turn after it, as the file's own
         requests are, so a caller's 'close' follows the immediate armed with the stream */
      settleIO(function () {
        var queued = waiting;
        waiting = [];
        for (var i = 0; i < queued.length; i++) writeChunk(queued[i][0], queued[i][1], queued[i][2]);
      }, false);
    }, false);
    Object.setPrototypeOf(stream, streamProtoOf(WriteStream, Writable, writeStreamProto));
    writeStreamProto = true;
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
    var at = resolvePath(file);
    var st = statOf(at);
    if (!st) throw fsError('ENOENT', 'opendir', file);
    if (st.type !== 'dir') throw fsError('ENOTDIR', 'opendir', file);
    var base = typeof p === 'string' ? p : file;
    var entries = sortedEntries(at).map(function (name) {
      return makeDirent(name, direntStatsOf(P.join(at, name)), base);
    });
    return new Dir(base, entries);
  };

  /*
   * Watchers. A browser has no file system events to wait on, so a watcher is a poll of what the path
   * looks like -- which is how Node's own watchFile works, and how fs.watch works on a platform with
   * no inotify to subscribe to. The poll is the guest's own setTimeout, the only clock there is.
   */
  var WATCH_INTERVAL_MS = 32;
  /* Node's own default interval for watchFile: the prime it picked so two watchers of files with the
     same size drift apart rather than poll in lockstep. */
  var WATCH_FILE_INTERVAL_MS = 5007;
  var WATCH_FILES = {};
  var EMPTY_STAT = { type: 'file', size: 0, mtimeMs: 0 };

  function watchIntervalOf(opts, fallback) {
    var options = typeof opts === 'object' && opts !== null ? opts : {};
    var n = options.interval;
    if (typeof n !== 'number' || !isFinite(n) || n < 1) return fallback;
    return Math.floor(n);
  }

  var WATCH_EMITTER = (function () {
    var mod = requireBuiltin('events');
    return typeof mod === 'function' ? mod : (mod && mod.EventEmitter);
  })();

  /*
   * A watcher is an EventEmitter named FSWatcher with the close, ref and unref Node's own carries --
   * which is all a package reads of one. A host does not export the class on fs, so neither does this.
   */
  function FSWatcher(target) {
    if (WATCH_EMITTER) WATCH_EMITTER.call(this);
    this._owcTarget = target;
    this._owcTimer = null;
    this._owcClosed = false;
    this._owcLast = watchSnapshotOf(target);
  }
  if (WATCH_EMITTER) {
    FSWatcher.prototype = Object.create(WATCH_EMITTER.prototype);
    FSWatcher.prototype.constructor = FSWatcher;
  }
  FSWatcher.prototype.start = function (interval) {
    var self = this;
    if (self._owcClosed) return;
    self._owcTimer = setTimeout(function tick() {
      if (self._owcClosed) return;
      self._owcTimer = setTimeout(tick, interval);
      var now = watchSnapshotOf(self._owcTarget);
      if (watchSignatureOf(self._owcLast) !== watchSignatureOf(now)) watchEmitDiff(self, self._owcLast, now);
      self._owcLast = now;
    }, interval);
  };
  FSWatcher.prototype.close = function () {
    this._owcClosed = true;
    if (this._owcTimer !== null && typeof clearTimeout === 'function') clearTimeout(this._owcTimer);
    this._owcTimer = null;
    this.emit('close');
  };
  FSWatcher.prototype.ref = function () { return this; };
  FSWatcher.prototype.unref = function () { return this; };

  /* What a watched path looks like, as something two polls can be told apart by. The mode is part of
     the signature because a host reports a chmod as a change: the bytes did not move, but the name
     did, and a watcher that waited for a write alone stayed silent through one. */
  function watchSnapshotOf(file) {
    var st = statFollowingLinks(file);
    if (!st) return null;
    if (st.type !== 'dir') return { dir: false, sig: st.size + '/' + st.mtimeMs + '/' + modeBitsOf(st), names: null, sigs: null };
    var names = sortedEntries(file);
    var sigs = {};
    for (var i = 0; i < names.length; i++) {
      var child = statFollowingLinks(P.join(file, names[i]));
      sigs[names[i]] = child ? child.type + '/' + child.size + '/' + child.mtimeMs + '/' + modeBitsOf(child) : '-';
    }
    return { dir: true, sig: null, names: names, sigs: sigs };
  }

  function watchSignatureOf(snap) {
    if (!snap) return '-';
    if (!snap.dir) return 'f' + snap.sig;
    var parts = [];
    for (var i = 0; i < snap.names.length; i++) parts.push(snap.names[i] + '=' + snap.sigs[snap.names[i]]);
    return 'd' + parts.join(',');
  }

  /*
   * A file whose bytes moved is 'change'; in a directory a name that appeared or went is 'rename' and
   * a name whose bytes moved is 'change', which is what a host reports for each. The event a watcher
   * emits is always the one named 'change' -- the event type is the first thing the listener is
   * handed, and the filename, never the path it watched, is the second.
   */
  function watchEmitDiff(w, before, after) {
    if (!before || !after) { w.emit('change', 'rename', P.basename(w._owcTarget)); return; }
    if (!before.dir) { w.emit('change', 'change', P.basename(w._owcTarget)); return; }
    var i;
    var name;
    for (i = 0; i < after.names.length; i++) {
      name = after.names[i];
      if (before.sigs[name] === undefined) w.emit('change', 'rename', name);
      else if (before.sigs[name] !== after.sigs[name]) w.emit('change', 'change', name);
    }
    for (i = 0; i < before.names.length; i++) {
      name = before.names[i];
      if (after.sigs[name] === undefined) w.emit('change', 'rename', name);
    }
  }

  fs.watch = function (filename, opts, listener) {
    var raw = filename && typeof filename === 'object' && filename.href ? filename.href : filename;
    if (typeof raw !== 'string') {
      throw fsArgErr(TypeError, 'ERR_INVALID_ARG_TYPE',
        'The "path" argument must be of type string or an instance of Buffer or URL. Received ' + describeFsArg(filename));
    }
    /* Node stat's the name before it does anything else, and a name that is not there is the ENOENT
       every other call reports: the platform refusal here came first, so the argument check a host
       makes was never reached at all. */
    if (!statFollowingLinks(toPathString(raw))) throw fsError('ENOENT', 'watch', raw);
    var cb = typeof opts === 'function' ? opts : (typeof listener === 'function' ? listener : undefined);
    var watcher = new FSWatcher(toPathString(raw));
    if (cb) watcher.on('change', cb);
    watcher.start(watchIntervalOf(opts, WATCH_INTERVAL_MS));
    return watcher;
  };

  /*
   * What watchFile hands back is a StatWatcher -- named that, an EventEmitter, and carrying ref and
   * unref the way FSWatcher does -- and not the plain record of a poll. A package that adds a
   * listener with .on, or keeps the process alive with .ref, on what watchFile gave it throws on a
   * plain Object, and the class is the surface Node exports for it.
   */
  function StatWatcher(target) {
    if (WATCH_EMITTER) WATCH_EMITTER.call(this);
    this._owcTarget = target;
    this._owcStopped = false;
  }
  if (WATCH_EMITTER) {
    StatWatcher.prototype = Object.create(WATCH_EMITTER.prototype);
    StatWatcher.prototype.constructor = StatWatcher;
  }
  StatWatcher.prototype.start = function () {};
  StatWatcher.prototype.stop = function () { this._owcStopped = true; };
  StatWatcher.prototype.ref = function () { return this; };
  StatWatcher.prototype.unref = function () { return this; };

  /*
   * watchFile is Node's polling watcher, and a poll is the only watcher there can be: it hands the
   * listener the stat it just took and the one it took before, and it does so when the interval
   * between two polls has passed -- 5007 ms when no interval was asked for, which is Node's own
   * default. A stat that is the same as the last one is not a change, so a listener is called once
   * for a write, however many polls went by while it happened.
   */
  fs.watchFile = function (filename, opts, listener) {
    var raw = filename && typeof filename === 'object' && filename.href ? filename.href : filename;
    if (typeof raw !== 'string') {
      throw fsArgErr(TypeError, 'ERR_INVALID_ARG_TYPE',
        'The "path" argument must be of type string or an instance of Buffer or URL. Received ' + describeFsArg(filename));
    }
    var cb = typeof opts === 'function' ? opts : (typeof listener === 'function' ? listener : undefined);
    var file = toPathString(raw);
    var interval = watchIntervalOf(opts, WATCH_FILE_INTERVAL_MS);
    var previous = statFollowingLinks(file);
    var watcher = new StatWatcher(file);
    /* The listener is the one a caller passed and the one unwatchFile stops, so it rides on the
       watcher where a caller can read it back, and the change itself goes out as an event. */
    watcher.listener = cb;
    if (cb) watcher.on('change', cb);
    WATCH_FILES[file] = (WATCH_FILES[file] || []).concat([watcher]);
    (function poll() {
      if (watcher._owcStopped) return;
      setTimeout(poll, interval);
      var current = statFollowingLinks(file);
      var moved = (previous === null) !== (current === null);
      if (!moved && previous !== null && current !== null) {
        moved = previous.mtimeMs !== current.mtimeMs || previous.size !== current.size ||
          previous.type !== current.type;
      }
      if (!moved) return;
      var before = previous;
      previous = current;
      watcher.emit('change', makeStats(current, undefined, false), makeStats(before === null ? EMPTY_STAT : before, undefined, false));
    })();
    return watcher;
  };

  fs.unwatchFile = function (filename, listener) {
    var raw = filename && typeof filename === 'object' && filename.href ? filename.href : filename;
    if (typeof raw !== 'string') return;
    var file = toPathString(raw);
    var list = WATCH_FILES[file];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      if (typeof listener !== 'function' || list[i].listener === listener) list[i].stop();
    }
  };

  // Node's fs.constants on the reference platform, so flag and mode values match exactly.
  fs.constants = {"UV_FS_SYMLINK_DIR":1,"UV_FS_SYMLINK_JUNCTION":2,"O_RDONLY":0,"O_WRONLY":1,"O_RDWR":2,"UV_DIRENT_UNKNOWN":0,"UV_DIRENT_FILE":1,"UV_DIRENT_DIR":2,"UV_DIRENT_LINK":3,"UV_DIRENT_FIFO":4,"UV_DIRENT_SOCKET":5,"UV_DIRENT_CHAR":6,"UV_DIRENT_BLOCK":7,"S_IFMT":61440,"S_IFREG":32768,"S_IFDIR":16384,"S_IFCHR":8192,"S_IFBLK":24576,"S_IFIFO":4096,"S_IFLNK":40960,"S_IFSOCK":49152,"O_CREAT":512,"O_EXCL":2048,"UV_FS_O_FILEMAP":0,"O_NOCTTY":131072,"O_TRUNC":1024,"O_APPEND":8,"O_DIRECTORY":1048576,"O_NOFOLLOW":256,"O_SYNC":128,"O_DSYNC":4194304,"O_SYMLINK":2097152,"O_NONBLOCK":4,"S_IRWXU":448,"S_IRUSR":256,"S_IWUSR":128,"S_IXUSR":64,"S_IRWXG":56,"S_IRGRP":32,"S_IWGRP":16,"S_IXGRP":8,"S_IRWXO":7,"S_IROTH":4,"S_IWOTH":2,"S_IXOTH":1,"F_OK":0,"R_OK":4,"W_OK":2,"X_OK":1,"UV_FS_COPYFILE_EXCL":1,"COPYFILE_EXCL":1,"UV_FS_COPYFILE_FICLONE":2,"COPYFILE_FICLONE":2,"UV_FS_COPYFILE_FICLONE_FORCE":4,"COPYFILE_FICLONE_FORCE":4};
  /* The four access-mode constants Node keeps on fs itself as well as in fs.constants: readable
     there, but not among the names Object.keys(fs) answers, which they are not on the host either. */
  Object.defineProperty(fs, 'F_OK', { value: 0, enumerable: false, configurable: false });
  Object.defineProperty(fs, 'R_OK', { value: 4, enumerable: false, configurable: false });
  Object.defineProperty(fs, 'W_OK', { value: 2, enumerable: false, configurable: false });
  Object.defineProperty(fs, 'X_OK', { value: 1, enumerable: false, configurable: false });

  /*
   * What statfs reports about the file system a path sits on, in the seven numbers Node's own give:
   * a 4096-byte block, a 32 GiB volume with half of it free, and a million inodes with half of
   * those. There is no disk behind this file system to measure, and the numbers a host answers
   * describe its own, so what is reproduced is the shape of the answer -- the keys a package reads
   * -- and a size no package will run out of.
   */
  fs.statfsSync = function (p, opts) {
    var file = toPathString(p === undefined ? '/' : p);
    if (!statFollowingLinks(file)) throw fsError('ENOENT', 'statfs', file);
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
  /* Nor for the calls whose promise form Node has never had, though the callback ones exist: close,
     exists, fchown, fsync, futimes, read, write and writev are all callback-only, and writevSync is
     the pair of the readvSync already named. Without this the promise surface carries eight names a
     host's Object.keys(fs.promises) does not list. */
  var NO_PROMISE = { closeSync: 1, existsSync: 1, fchownSync: 1, fsyncSync: 1, futimesSync: 1, readSync: 1, writeSync: 1, writevSync: 1 };

  /*
   * The calls host node 24.15 answers in more than one round trip, and so settles a turn later than
   * the rest: a readFile opens the file and then reads it, a writeFile opens it and then writes it,
   * and a realpath, a mkdtemp, a cp and the rest each resolve a name or walk a tree before the
   * request that answers the caller. Measured on host node 24.15 against this container, one fresh
   * boot per case and a setImmediate armed before the call: an immediate armed before a readFile
   * runs first there ('iFI') and last here ('FiI'), while a stat, an access, a readdir, a readlink
   * and an open all agree at one turn on both sides ('SiI', 'AiI', 'DiI', 'RiI', 'OiI').
   */
  var CONTENT_SYNC = { readFileSync: 1, writeFileSync: 1, appendFileSync: 1, copyFileSync: 1,
    cpSync: 1, realpathSync: 1, symlinkSync: 1, linkSync: 1, renameSync: 1, truncateSync: 1,
    mkdtempSync: 1, readvSync: 1, mkdirSync: 1, unlinkSync: 1 };
  /*
   * An error the first of those round trips reports comes back on the first turn: a readFile of a
   * path that is not there fails at its open and answers before the immediate ('EiI' on both sides),
   * while one of a directory opens and fails at its read and so still answers after it ('iEI' on
   * host node 24.15). A writeFile onto a read-only directory is the same failure at the same place.
   */
  var OPEN_STAGE = { ENOENT: 1, ENOTDIR: 1, EACCES: 1, EPERM: 1, EROFS: 1, ELOOP: 1,
    ENAMETOOLONG: 1, EMFILE: 1, ENFILE: 1, EBADF: 1, EEXIST: 1, ENOTEMPTY: 1 };
  function contentCost(syncName, error) {
    if (!CONTENT_SYNC[syncName]) return false;
    if (error && OPEN_STAGE[error.code]) return false;
    return true;
  }

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
      settleIO(function () {
        if (error) cb(error);
        else cb(null, result);
      }, contentCost(syncName, error));
    };
    if (!HANDLE_ONLY[syncName] && !NO_PROMISE[syncName]) {
      promises[base] = function () {
        var args = Array.prototype.slice.call(arguments);
        return new Promise(function (resolve, reject) {
          var result;
          var error = null;
          try {
            result = impl.apply(fs, args);
          } catch (err) {
            error = err;
          }
          /*
           * Only the calls host node 24.15 spends a second turn on are settled late here. The others
           * settle as they always did, because a promise's reaction is a microtask and a microtask
           * lands before the check phase on both sides: an 'await fs.promises.stat' armed with an
           * immediate answers first there ('SiI') and did here, while deferring the resolve pushed
           * the reaction behind the immediate instead ('iSI').
           */
          if (!contentCost(syncName, error)) {
            if (error) reject(error);
            else resolve(result);
            return;
          }
          settleIO(function () {
            if (error) reject(error);
            else resolve(result);
          }, true);
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

  /* Node's mkdtempDisposableSync: the same directory mkdtempSync makes, in an object a caller can
     leave a using declaration to close, so the block's end removes it and everything under it. Added after the
     sweep so no callback or promise form is generated for it -- Node has none. */
  fs.mkdtempDisposableSync = function (prefix, options) {
    var dir = fs.mkdtempSync(prefix, options);
    var disposable = {
      path: dir,
      remove: function () { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    disposable[Symbol.dispose] = function () { disposable.remove(); };
    return disposable;
  };

  /* Three names the *Sync sweep cannot generate, which Node keeps on the promise surface all the
     same: the constants bag, the promise form of mkdtempDisposableSync, and watch, whose promise form
     is an async iterator rather than the watcher the callback form hands back. The disposable
     carries Symbol.asyncDispose as well as Symbol.dispose, so a caller can await using it. */
  promises.constants = fs.constants;
  promises.mkdtempDisposable = function (prefix, options) {
    return new Promise(function (resolve, reject) {
      try {
        var dir = fs.mkdtempDisposableSync(prefix, options);
        if (typeof Symbol.asyncDispose === 'symbol') {
          dir[Symbol.asyncDispose] = function () {
            return Promise.resolve(dir.remove());
          };
        }
        resolve(dir);
      } catch (err) {
        reject(err);
      }
    });
  };
  promises.watch = function (filename, opts) {
    /* Node's promise form of watch is an async iterator of the events the watcher emits, and the
       watcher behind it is the one fs.watch hands back. */
    var watcher = fs.watch(filename, typeof opts === 'function' ? undefined : opts);
    var queue = [];
    var waiting = null;
    watcher.on('change', function (eventType, name) {
      var item = { eventType: eventType, filename: name };
      if (waiting !== null) {
        var resolve = waiting;
        waiting = null;
        resolve({ value: item, done: false });
        return;
      }
      queue.push(item);
    });
    var iterator = {
      next: function () {
        if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
        return new Promise(function (resolve) { waiting = resolve; });
      },
      'return': function () {
        watcher.close();
        return Promise.resolve({ value: undefined, done: true });
      },
      'throw': function () {
        watcher.close();
        return Promise.resolve({ value: undefined, done: true });
      }
    };
    iterator[Symbol.asyncIterator] = function () { return iterator; };
    return iterator;
  };

  /* Node's own time conversion, which it exports beside the calls it feeds: a Date or a number of
     seconds to a Unix timestamp, and a type error for anything else. */
  fs._toUnixTimestamp = function (time, name) {
    if (!(time instanceof Date) && typeof time !== 'number') {
      throw fsArgErr(TypeError, 'ERR_INVALID_ARG_TYPE',
        'The "time" argument must be an instance of Date or an Time in seconds. Received ' + describeFsArg(time));
    }
    return Math.floor(timeToMs(time) / 1000);
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
