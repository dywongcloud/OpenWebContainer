/**
 * Guest-side `stream`, `stream/promises`, `stream/consumers`, `readline` and
 * `readline/promises`.
 * Ported from the observable behaviour of Node 24's lib/internal/streams and
 * lib/readline for the commonly used surface. Plain JavaScript inside a String.raw
 * snippet: no backticks and no template interpolation. The four factories share one
 * core, built lazily on first require, so readline can reuse the stream helpers.
 */
export const SRC = String.raw`
var owcStreamCoreCache = null;

function owcStreamCore() {
  if (owcStreamCoreCache === null) owcStreamCoreCache = owcBuildStreamCore();
  return owcStreamCoreCache;
}

BF.stream = function () {
  return owcStreamCore().stream;
};
BF['stream/promises'] = function () {
  return owcStreamCore().streamPromises;
};
BF['stream/consumers'] = function () {
  return owcStreamCore().streamConsumers;
};
BF.readline = function () {
  return owcStreamCore().readline;
};
BF['readline/promises'] = function () {
  return owcStreamCore().readlinePromises;
};

function owcBuildStreamCore() {
  var EventEmitter = requireBuiltin('events');
  var Buf = requireBuiltin('buffer').Buffer;
  var defaultHighWaterMark = 65536;
  var defaultObjectHighWaterMark = 16;
  var KNOWN_ENCODINGS = { utf8: true, utf16le: true, latin1: true, ascii: true, base64: true, base64url: true, hex: true };
  var kRlState = Symbol('owcReadlineState');
  var kTransformCallback = Symbol('owcTransformCallback');

  function owcErr(Ctor, code, message) {
    var err = new Ctor(message);
    err.code = code;
    return err;
  }

  function describeReceived(value) {
    if (value === null || value === undefined) return ' Received ' + value;
    /* Node names a function by its own name and prints nothing for one that has none, so an
       anonymous function is "Received function " with the name left empty and not "<anonymous>". */
    if (typeof value === 'function') return ' Received function ' + (value.name || '');
    if (typeof value === 'object') {
      if (value.constructor && value.constructor.name) return ' Received an instance of ' + value.constructor.name;
      return ' Received ' + Object.prototype.toString.call(value);
    }
    var shown = typeof value === 'string' ? "'" + (value.length > 25 ? value.slice(0, 25) + '...' : value) + "'" : String(value);
    return ' Received type ' + typeof value + ' (' + shown + ')';
  }

  function argTypeError(name, expected, value) {
    return owcErr(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "' + name + '" argument must be ' + expected + '.' + describeReceived(value));
  }

  /* Node calls a name that is not a plain identifier a property, not an argument: the message a
     validate of an element or a nested field carries says "property" where a parameter says
     "argument". */
  function propTypeError(name, expected, value) {
    return owcErr(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "' + name + '" property must be ' + expected + '.' + describeReceived(value));
  }

  function errWriteAfterEnd() {
    return owcErr(Error, 'ERR_STREAM_WRITE_AFTER_END', 'write after end');
  }
  function errPushAfterEof() {
    return owcErr(Error, 'ERR_STREAM_PUSH_AFTER_EOF', 'stream.push() after EOF');
  }
  function errUnshiftAfterEnd() {
    return owcErr(Error, 'ERR_STREAM_UNSHIFT_AFTER_END_EVENT', 'stream.unshift() after end event');
  }
  function errNotImplemented(method) {
    return owcErr(Error, 'ERR_METHOD_NOT_IMPLEMENTED', 'The ' + method + ' method is not implemented');
  }
  function errPrematureClose() {
    return owcErr(Error, 'ERR_STREAM_PREMATURE_CLOSE', 'Premature close');
  }
  function errDestroyed(op) {
    return owcErr(Error, 'ERR_STREAM_DESTROYED', 'Cannot call ' + op + ' after a stream was destroyed');
  }
  function errAlreadyFinished(op) {
    return owcErr(Error, 'ERR_STREAM_ALREADY_FINISHED', 'Cannot call ' + op + ' after a stream was finished');
  }
  function errNullValues() {
    return owcErr(TypeError, 'ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
  }
  function errMultipleCallback() {
    return owcErr(Error, 'ERR_MULTIPLE_CALLBACK', 'Callback called multiple times');
  }
  function errUnknownEncoding(enc) {
    return owcErr(TypeError, 'ERR_UNKNOWN_ENCODING', 'Unknown encoding: ' + enc);
  }
  function errUseAfterClose() {
    return owcErr(Error, 'ERR_USE_AFTER_CLOSE', 'readline was closed');
  }

  function normalizeEncoding(enc) {
    /* Node's internal normalise treats a missing encoding as utf8: setEncoding(null),
       setEncoding(undefined) and setEncoding('') all end up decoding utf8 rather than throwing. */
    if (enc === null || enc === undefined || enc === '') return 'utf8';
    var e = String(enc).toLowerCase();
    if (e === 'utf-8') return 'utf8';
    if (e === 'ucs2' || e === 'ucs-2' || e === 'utf-16le') return 'utf16le';
    if (e === 'binary') return 'latin1';
    return e;
  }

  // Incremental string decoder: keeps an incomplete trailing sequence until the next chunk.
  function createDecoder(enc) {
    var e = normalizeEncoding(enc);
    if (KNOWN_ENCODINGS[e] !== true) throw errUnknownEncoding(enc);
    var pending = null;

    function toBytes(chunk) {
      var bytes = Buf.isBuffer(chunk) ? chunk : Buf.from(chunk);
      if (pending === null || pending.length === 0) return bytes;
      var joined = Buf.concat([pending, bytes]);
      pending = null;
      return joined;
    }

    function utf8Cut(bytes) {
      var n = bytes.length;
      for (var back = 1; back <= 4 && back <= n; back++) {
        var b = bytes[n - back];
        if ((b & 0xc0) === 0x80) continue;
        var need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
        return back < need ? n - back : n;
      }
      return n;
    }

    function cutFor(bytes) {
      if (e === 'utf8') return utf8Cut(bytes);
      if (e === 'utf16le') {
        var cut = bytes.length - (bytes.length % 2);
        if (cut >= 2) {
          var unit = bytes[cut - 2] | (bytes[cut - 1] << 8);
          if (unit >= 0xd800 && unit <= 0xdbff) cut -= 2;
        }
        return cut;
      }
      if (e === 'base64' || e === 'base64url') return bytes.length - (bytes.length % 3);
      return bytes.length;
    }

    return {
      encoding: e,
      write: function (chunk) {
        if (typeof chunk === 'string') return chunk;
        var bytes = toBytes(chunk);
        var cut = cutFor(bytes);
        if (cut < bytes.length) pending = bytes.slice(cut);
        return cut === 0 ? '' : bytes.slice(0, cut).toString(e);
      },
      end: function (chunk) {
        var out = chunk === undefined || chunk === null ? '' : this.write(chunk);
        if (pending !== null && pending.length > 0) {
          out += e === 'utf8' ? '�' : pending.toString(e);
          pending = null;
        }
        return out;
      }
    };
  }

  function offListener(target, type, fn) {
    if (target && typeof target.removeListener === 'function') target.removeListener(type, fn);
  }

  function emitSafe(target, type) {
    if (target && typeof target.emit === 'function') {
      return target.emit.apply(target, Array.prototype.slice.call(arguments, 1));
    }
    return false;
  }

  function listenerCountOf(target, type) {
    return target && typeof target.listenerCount === 'function' ? target.listenerCount(type) : 0;
  }

  function nextPowerOfTwo(n) {
    var v = 1;
    while (v < n) v *= 2;
    return v;
  }

  function pickHighWaterMark(opts, duplexKey, objectMode) {
    var v = duplexKey && opts[duplexKey] !== undefined && opts[duplexKey] !== null ? opts[duplexKey] : opts.highWaterMark;
    if (v !== undefined && v !== null) return v;
    return objectMode ? defaultObjectHighWaterMark : defaultHighWaterMark;
  }

  function getDefaultHighWaterMark(objectMode) {
    return objectMode ? defaultObjectHighWaterMark : defaultHighWaterMark;
  }

  function setDefaultHighWaterMark(objectMode, value) {
    if (typeof value !== 'number') throw argTypeError('value', 'of type number', value);
    if (!Number.isInteger(value)) {
      throw owcErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "value" is out of range. It must be an integer. Received ' + value);
    }
    if (value < 0 || value > 9007199254740991) {
      throw owcErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "value" is out of range. It must be >= 0 && <= 9007199254740991. Received ' + value);
    }
    if (objectMode) defaultObjectHighWaterMark = value;
    else defaultHighWaterMark = value;
  }

  /* Node 24 keeps every boolean ReadableState/WritableState flag in *one* integer behind the
     private Symbol(kState): a fresh readable state owns only highWaterMark, buffer, bufferIndex,
     length, pipes and awaitDrainWriters plus that symbol, and a fresh writable state only
     highWaterMark, length, corked, onwrite, writelen, bufferedIndex and pendingcb plus
     Symbol(kState) and Symbol(kBufferedValue). Every flag lives on the prototype as a getter over
     one bit, and a flag whose value is not a boolean (errored, decoder, encoding, defaultEncoding,
     writecb, afterWriteTickInfo, buffered, the on-finished list) parks its value behind a second
     symbol that only appears once the flag is first set. The bit numbers and the prototype order
     below are copied from internal/streams/utils.js, readable.js and writable.js, so the integer
     and the key order match the host exactly. */
  var kState = Symbol('kState');
  var kErroredValue = Symbol('kErroredValue');
  var kDefaultEncodingValue = Symbol('kDefaultEncodingValue');
  var kDecoderValue = Symbol('kDecoderValue');
  var kEncodingValue = Symbol('kEncodingValue');
  var kOnFinishedValue = Symbol('kOnFinishedValue');
  var kWriteCbValue = Symbol('kWriteCbValue');
  var kAfterWriteTickInfoValue = Symbol('kAfterWriteTickInfoValue');
  var kBufferedValue = Symbol('kBufferedValue');

  // Shared by both states (internal/streams/utils.js).
  var kObjectMode = 1 << 0;
  var kErrorEmitted = 1 << 1;
  var kAutoDestroy = 1 << 2;
  var kEmitClose = 1 << 3;
  var kDestroyed = 1 << 4;
  var kClosed = 1 << 5;
  var kCloseEmitted = 1 << 6;
  var kErrored = 1 << 7;
  var kConstructed = 1 << 8;

  var R_ENDED = 1 << 9;
  var R_END_EMITTED = 1 << 10;
  var R_READING = 1 << 11;
  var R_SYNC = 1 << 12;
  var R_NEED_READABLE = 1 << 13;
  var R_EMITTED_READABLE = 1 << 14;
  var R_READABLE_LISTENING = 1 << 15;
  var R_RESUME_SCHEDULED = 1 << 16;
  var R_MULTI_AWAIT_DRAIN = 1 << 17;
  var R_READING_MORE = 1 << 18;
  var R_DATA_EMITTED = 1 << 19;
  var R_DEFAULT_UTF8 = 1 << 20;
  var R_DECODER = 1 << 21;
  var R_ENCODING = 1 << 22;
  var R_HAS_FLOWING = 1 << 23;
  var R_FLOWING = 1 << 24;
  var R_HAS_PAUSED = 1 << 25;
  var R_PAUSED = 1 << 26;

  var W_SYNC = 1 << 9;
  var W_FINAL_CALLED = 1 << 10;
  var W_NEED_DRAIN = 1 << 11;
  var W_ENDING = 1 << 12;
  var W_FINISHED = 1 << 13;
  var W_DECODE_STRINGS = 1 << 14;
  var W_WRITING = 1 << 15;
  var W_BUFFER_PROCESSING = 1 << 16;
  var W_PREFINISHED = 1 << 17;
  var W_ALL_BUFFERS = 1 << 18;
  var W_ALL_NOOP = 1 << 19;
  var W_ON_FINISHED = 1 << 20;
  var W_HAS_WRITABLE = 1 << 21;
  var W_WRITABLE = 1 << 22;
  var W_DEFAULT_UTF8 = 1 << 24;
  var W_WRITE_CB = 1 << 25;
  var W_EXPECT_WRITE_CB = 1 << 26;
  var W_AFTER_WRITE_TICK_INFO = 1 << 27;
  var kBuffered = 1 << 29;
  var W_ENDED = 1 << 30;

  function bitAccessor(bit) {
    return {
      enumerable: false,
      configurable: true,
      get: function () { return (this[kState] & bit) !== 0; },
      set: function (value) { if (value) this[kState] |= bit; else this[kState] &= ~bit; }
    };
  }

  function valueAccessor(bit, valueKey, empty) {
    return {
      enumerable: false,
      configurable: true,
      get: function () { return (this[kState] & bit) !== 0 ? this[valueKey] : empty; },
      set: function (value) {
        this[valueKey] = value;
        if (value) this[kState] |= bit;
        else this[kState] &= ~bit;
      }
    };
  }

  function nop() {}

  var ArrayPrototypeSlice = Array.prototype.slice;

  // ---------------------------------------------------------------- ReadableState

  function ReadableState() {}
  Object.defineProperties(ReadableState.prototype, {
    objectMode: bitAccessor(kObjectMode),
    ended: bitAccessor(R_ENDED),
    endEmitted: bitAccessor(R_END_EMITTED),
    reading: bitAccessor(R_READING),
    constructed: bitAccessor(kConstructed),
    sync: bitAccessor(R_SYNC),
    needReadable: bitAccessor(R_NEED_READABLE),
    emittedReadable: bitAccessor(R_EMITTED_READABLE),
    readableListening: bitAccessor(R_READABLE_LISTENING),
    resumeScheduled: bitAccessor(R_RESUME_SCHEDULED),
    errorEmitted: bitAccessor(kErrorEmitted),
    emitClose: bitAccessor(kEmitClose),
    autoDestroy: bitAccessor(kAutoDestroy),
    destroyed: bitAccessor(kDestroyed),
    closed: bitAccessor(kClosed),
    closeEmitted: bitAccessor(kCloseEmitted),
    multiAwaitDrain: bitAccessor(R_MULTI_AWAIT_DRAIN),
    readingMore: bitAccessor(R_READING_MORE),
    dataEmitted: bitAccessor(R_DATA_EMITTED),
    errored: {
      enumerable: false,
      configurable: true,
      get: function () { return (this[kState] & kErrored) !== 0 ? this[kErroredValue] : null; },
      set: function (value) {
        if (value) {
          this[kErroredValue] = value;
          this[kState] |= kErrored;
        } else {
          this[kState] &= ~kErrored;
        }
      }
    },
    defaultEncoding: {
      enumerable: false,
      configurable: true,
      get: function () { return (this[kState] & R_DEFAULT_UTF8) !== 0 ? 'utf8' : this[kDefaultEncodingValue]; },
      set: function (value) {
        if (value === 'utf8' || value === 'utf-8') this[kState] |= R_DEFAULT_UTF8;
        else {
          this[kState] &= ~R_DEFAULT_UTF8;
          this[kDefaultEncodingValue] = value;
        }
      }
    },
    decoder: valueAccessor(R_DECODER, kDecoderValue, null),
    encoding: valueAccessor(R_ENCODING, kEncodingValue, null),
    flowing: {
      enumerable: false,
      configurable: true,
      get: function () { return (this[kState] & R_HAS_FLOWING) !== 0 ? (this[kState] & R_FLOWING) !== 0 : null; },
      set: function (value) {
        if (value === null || value === undefined) this[kState] &= ~(R_HAS_FLOWING | R_FLOWING);
        else if (value) this[kState] |= (R_HAS_FLOWING | R_FLOWING);
        else {
          this[kState] |= R_HAS_FLOWING;
          this[kState] &= ~R_FLOWING;
        }
      }
    },
    pipesCount: {
      enumerable: false,
      configurable: true,
      get: function () { return this.pipes.length; }
    },
    paused: {
      enumerable: false,
      configurable: true,
      get: function () { return (this[kState] & R_PAUSED) !== 0; },
      set: function (value) {
        this[kState] |= R_HAS_PAUSED;
        if (value) this[kState] |= R_PAUSED;
        else this[kState] &= ~R_PAUSED;
      }
    }
  });

  function makeReadableState(options, isDuplex) {
    var opts = options || {};
    var objectMode = !!(opts.objectMode || (isDuplex && opts.readableObjectMode));
    var state = Object.create(ReadableState.prototype);
    state[kState] = kEmitClose | kAutoDestroy | kConstructed | R_SYNC;
    if (objectMode) state[kState] |= kObjectMode;
    state.highWaterMark = pickHighWaterMark(opts, isDuplex ? 'readableHighWaterMark' : null, objectMode);
    state.buffer = [];
    state.bufferIndex = 0;
    state.length = 0;
    state.pipes = [];
    if (opts.emitClose === false) state[kState] &= ~kEmitClose;
    if (opts.autoDestroy === false) state[kState] &= ~kAutoDestroy;
    var defaultEncoding = opts.defaultEncoding;
    if (defaultEncoding === null || defaultEncoding === undefined || defaultEncoding === 'utf8' || defaultEncoding === 'utf-8') {
      state[kState] |= R_DEFAULT_UTF8;
    } else if (KNOWN_ENCODINGS[normalizeEncoding(defaultEncoding)]) {
      state.defaultEncoding = defaultEncoding;
    } else {
      throw errUnknownEncoding(defaultEncoding);
    }
    state.awaitDrainWriters = null;
    if (opts.encoding) {
      state.decoder = createDecoder(opts.encoding);
      state.encoding = opts.encoding;
    }
    return state;
  }

  // The encoding a stream decodes with, normalised; null when it delivers buffers.
  function stateEncodingName(state) {
    return state.decoder ? state.decoder.encoding : null;
  }

  function WritableState() {}
  Object.defineProperties(WritableState.prototype, {
    objectMode: bitAccessor(kObjectMode),
    finalCalled: bitAccessor(W_FINAL_CALLED),
    needDrain: bitAccessor(W_NEED_DRAIN),
    ending: bitAccessor(W_ENDING),
    ended: bitAccessor(W_ENDED),
    finished: bitAccessor(W_FINISHED),
    destroyed: bitAccessor(kDestroyed),
    decodeStrings: bitAccessor(W_DECODE_STRINGS),
    writing: bitAccessor(W_WRITING),
    sync: bitAccessor(W_SYNC),
    bufferProcessing: bitAccessor(W_BUFFER_PROCESSING),
    constructed: bitAccessor(kConstructed),
    prefinished: bitAccessor(W_PREFINISHED),
    errorEmitted: bitAccessor(kErrorEmitted),
    emitClose: bitAccessor(kEmitClose),
    autoDestroy: bitAccessor(kAutoDestroy),
    closed: bitAccessor(kClosed),
    closeEmitted: bitAccessor(kCloseEmitted),
    allBuffers: bitAccessor(W_ALL_BUFFERS),
    allNoop: bitAccessor(W_ALL_NOOP),
    errored: {
      enumerable: false,
      configurable: true,
      get: function () { return (this[kState] & kErrored) !== 0 ? this[kErroredValue] : null; },
      set: function (value) {
        if (value) {
          this[kErroredValue] = value;
          this[kState] |= kErrored;
        } else {
          this[kState] &= ~kErrored;
        }
      }
    },
    writable: {
      enumerable: false,
      configurable: true,
      get: function () { return (this[kState] & W_HAS_WRITABLE) !== 0 ? (this[kState] & W_WRITABLE) !== 0 : undefined; },
      set: function (value) {
        if (value === null || value === undefined) this[kState] &= ~(W_HAS_WRITABLE | W_WRITABLE);
        else if (value) this[kState] |= (W_HAS_WRITABLE | W_WRITABLE);
        else {
          this[kState] |= W_HAS_WRITABLE;
          this[kState] &= ~W_WRITABLE;
        }
      }
    },
    defaultEncoding: {
      enumerable: false,
      configurable: true,
      get: function () { return (this[kState] & W_DEFAULT_UTF8) !== 0 ? 'utf8' : this[kDefaultEncodingValue]; },
      set: function (value) {
        if (value === 'utf8' || value === 'utf-8') this[kState] |= W_DEFAULT_UTF8;
        else {
          this[kState] &= ~W_DEFAULT_UTF8;
          this[kDefaultEncodingValue] = value;
        }
      }
    },
    writecb: valueAccessor(W_WRITE_CB, kWriteCbValue, nop),
    afterWriteTickInfo: valueAccessor(W_AFTER_WRITE_TICK_INFO, kAfterWriteTickInfoValue, null),
    buffered: valueAccessor(kBuffered, kBufferedValue, [])
  });
  /* Kept byte-for-byte with internal/streams/writable.js: an inspected writable state prints this
     function's source, so its own text is part of the observable surface. */
  WritableState.prototype.getBuffer = function getBuffer() {
  return (this[kState] & kBuffered) === 0 ? [] : ArrayPrototypeSlice(this.buffered, this.bufferedIndex);
}

  Object.defineProperty(WritableState.prototype, 'bufferedRequestCount', {
    enumerable: false,
    configurable: true,
    get: function () { return (this[kState] & kBuffered) === 0 ? 0 : this[kBufferedValue].length - this.bufferedIndex; }
  });

  /* The on-finished list is the one flag Node parks behind a second symbol without an accessor of
     its own, so it is reached through these two helpers rather than through state.onFinished. */
  function onFinishedPush(state, cb) {
    if (state[kOnFinishedValue] === null || state[kOnFinishedValue] === undefined) state[kOnFinishedValue] = [];
    state[kState] |= W_ON_FINISHED;
    state[kOnFinishedValue].push(cb);
  }

  function onFinishedTake(state) {
    var list = state[kOnFinishedValue];
    if (list === null || list === undefined) return [];
    state[kOnFinishedValue] = null;
    state[kState] &= ~W_ON_FINISHED;
    return list;
  }

  /* state.buffered is a fresh empty array until something is buffered, so a push has to go through
     the setter to make the array real. */
  function bufferedPush(state, item) {
    if ((state[kState] & kBuffered) === 0) state.buffered = [];
    state[kBufferedValue].push(item);
  }

  function resetBuffer(state) {
    state[kBufferedValue] = null;
    state.bufferedIndex = 0;
    state[kState] |= W_ALL_BUFFERS | W_ALL_NOOP;
    state[kState] &= ~kBuffered;
  }

  function makeWritableState(options, isDuplex, stream) {
    var opts = options || {};
    var objectMode = !!(opts.objectMode || (isDuplex && opts.writableObjectMode));
    var state = Object.create(WritableState.prototype);
    state[kState] = W_SYNC | kConstructed | kEmitClose | kAutoDestroy;
    if (objectMode) state[kState] |= kObjectMode;
    state.highWaterMark = pickHighWaterMark(opts, isDuplex ? 'writableHighWaterMark' : null, objectMode);
    if (opts.decodeStrings !== false) state[kState] |= W_DECODE_STRINGS;
    if (opts.emitClose === false) state[kState] &= ~kEmitClose;
    if (opts.autoDestroy === false) state[kState] &= ~kAutoDestroy;
    var defaultEncoding = opts.defaultEncoding === undefined ? null : opts.defaultEncoding;
    if (defaultEncoding === null || defaultEncoding === undefined || defaultEncoding === 'utf8' || defaultEncoding === 'utf-8') {
      state[kState] |= W_DEFAULT_UTF8;
    } else if (KNOWN_ENCODINGS[normalizeEncoding(defaultEncoding)]) {
      state.defaultEncoding = defaultEncoding;
    } else {
      throw errUnknownEncoding(defaultEncoding);
    }
    state.length = 0;
    state.corked = 0;
    state.onwrite = onwriteFor(stream);
    state.writelen = 0;
    resetBuffer(state);
    state.pendingcb = 0;
    return state;
  }

  function checkErrored(err, w, r) {
    if (!err) return;
    if (w && !w.errored) w.errored = err;
    if (r && !r.errored) r.errored = err;
  }

  function emitErrorNT(self, err) {
    var r = self._readableState;
    var w = self._writableState;
    if ((w && w.errorEmitted) || (r && r.errorEmitted)) return;
    if (w) w.errorEmitted = true;
    if (r) r.errorEmitted = true;
    self.emit('error', err);
  }

  function emitCloseNT(self) {
    var r = self._readableState;
    var w = self._writableState;
    if (r) r.closeEmitted = true;
    if (w) w.closeEmitted = true;
    if ((w && w.emitClose) || (r && r.emitClose)) self.emit('close');
  }

  function emitErrorCloseNT(self, err) {
    emitErrorNT(self, err);
    emitCloseNT(self);
  }

  function runDestroy(self, err, cb) {
    var called = false;
    function onDestroy(e) {
      if (called) return;
      called = true;
      var r = self._readableState;
      var w = self._writableState;
      checkErrored(e, w, r);
      if (w) w.closed = true;
      if (r) r.closed = true;
      if (typeof cb === 'function') cb(e);
      if (e) process.nextTick(emitErrorCloseNT, self, e);
      else process.nextTick(emitCloseNT, self);
    }
    try {
      self._destroy(err || null, onDestroy);
    } catch (thrown) {
      onDestroy(thrown);
    }
  }

  function destroyImpl(err, cb) {
    var r = this._readableState;
    var w = this._writableState;
    if ((w && w.destroyed) || (r && r.destroyed)) {
      if (typeof cb === 'function') cb();
      return this;
    }
    checkErrored(err, w, r);
    if (w) w.destroyed = true;
    if (r) r.destroyed = true;
    runDestroy(this, err, cb);
    return this;
  }

  function errorOrDestroy(stream, err, sync) {
    var r = stream._readableState;
    var w = stream._writableState;
    if ((w && w.destroyed) || (r && r.destroyed)) return;
    if ((r && r.autoDestroy) || (w && w.autoDestroy)) {
      stream.destroy(err);
    } else if (err) {
      if (w && !w.errored) w.errored = err;
      if (r && !r.errored) r.errored = err;
      if (sync) process.nextTick(emitErrorNT, stream, err);
      else emitErrorNT(stream, err);
    }
  }

  function Stream(options) {
    EventEmitter.call(this, options);
  }
  Object.setPrototypeOf(Stream.prototype, EventEmitter.prototype);
  Object.setPrototypeOf(Stream, EventEmitter);

  // Legacy pipe for EventEmitter-based streams that predate the Readable class.
  Stream.prototype.pipe = function (dest, options) {
    var source = this;
    var ended = false;
    function ondata(chunk) {
      if (dest.write(chunk) === false && typeof source.pause === 'function') source.pause();
    }
    function ondrain() {
      if (typeof source.resume === 'function') source.resume();
    }
    function onend() {
      if (ended) return;
      ended = true;
      if (typeof dest.end === 'function') dest.end();
    }
    function onclose() {
      if (ended) return;
      ended = true;
      if (typeof dest.destroy === 'function') dest.destroy();
    }
    source.on('data', ondata);
    dest.on('drain', ondrain);
    if (!options || options.end !== false) {
      source.on('end', onend);
      source.on('close', onclose);
    }
    emitSafe(dest, 'pipe', source);
    return dest;
  };
  /* Node declares eventNames on Stream.prototype itself (internal/streams/legacy.js), so the
     own keys of Stream.prototype are constructor, pipe and eventNames. */
  Stream.prototype.eventNames = function () {
    var names = [];
    var events = this._events || {};
    var keys = Object.getOwnPropertyNames(events);
    if (typeof Object.getOwnPropertySymbols === 'function') keys = keys.concat(Object.getOwnPropertySymbols(events));
    for (var i = 0; i < keys.length; i++) {
      var at = events[keys[i]];
      if (typeof at === 'function' || (Array.isArray(at) && at.length > 0)) names.push(keys[i]);
    }
    return names;
  };

  // ---------------------------------------------------------------- Readable

  /* Async construction is opt in, so a stream starts out constructed; one that was given a
     construct callback is not, and stays that way until the callback runs (internal/streams/destroy). */
  var kConstructEvent = Symbol('kConstruct');

  function readableOnConstructed(stream) {
    var state = stream._readableState;
    if (state && state.needReadable) maybeReadMore(stream, state);
  }

  function writableOnConstructed(stream) {
    var state = stream._writableState;
    if (!state) return;
    if (!state.writing) clearBuffer(stream, state);
    if (state.ending) finishMaybe(stream, state);
  }

  function constructStream(stream, onConstructed) {
    if (typeof stream._construct !== 'function') return;
    var r = stream._readableState;
    var w = stream._writableState;
    if (r) r.constructed = false;
    if (w) w.constructed = false;
    stream.once(kConstructEvent, onConstructed);
    /* Duplex runs this once per side; the second call only adds a listener. */
    if (listenerCountOf(stream, kConstructEvent) > 1) return;
    process.nextTick(function () {
      var called = false;
      function done(err) {
        if (called) {
          errorOrDestroy(stream, err || errMultipleCallback());
          return;
        }
        called = true;
        if (r) r.constructed = true;
        if (w) w.constructed = true;
        if (err) errorOrDestroy(stream, err, true);
        else stream.emit(kConstructEvent);
      }
      try {
        stream._construct(function (err) { process.nextTick(done, err); });
      } catch (err) {
        process.nextTick(done, err);
      }
    });
  }

  function Readable(options) {
    if (!(this instanceof Readable)) return new Readable(options);
    /* Node seeds the listener map with the five events a readable stream uses most before
       EventEmitter.init runs: init sees a defined _events and skips its own, so a fresh stream owns
       no _eventsCount. */
    if (this._events === undefined) {
      this._events = { close: undefined, error: undefined, data: undefined, end: undefined, readable: undefined };
    }
    this._readableState = makeReadableState(options, this instanceof Duplex);
    if (options) {
      if (typeof options.read === 'function') this._read = options.read;
      if (typeof options.destroy === 'function') this._destroy = options.destroy;
      if (typeof options.construct === 'function') this._construct = options.construct;
      if (options.signal) addAbortSignal(options.signal, this);
    }
    Stream.call(this, options);
    if (this._construct !== undefined && this._construct !== null) {
      var self = this;
      constructStream(this, function () { readableOnConstructed(self); });
    }
  }
  Object.setPrototypeOf(Readable.prototype, Stream.prototype);
  Object.setPrototypeOf(Readable, Stream);

  function emitReadable(stream) {
    var state = stream._readableState;
    state.needReadable = false;
    if (!state.emittedReadable) {
      state.emittedReadable = true;
      process.nextTick(emitReadableNT, stream);
    }
  }

  function emitReadableNT(stream) {
    var state = stream._readableState;
    if (!state.destroyed && !state.errored && (state.length || state.ended)) {
      stream.emit('readable');
      state.emittedReadable = false;
    }
    state.needReadable = !state.flowing && !state.ended && state.length <= state.highWaterMark;
    flow(stream);
  }

  function maybeReadMore(stream, state) {
    if (!state.readingMore) {
      state.readingMore = true;
      process.nextTick(maybeReadMoreNT, stream, state);
    }
  }

  function maybeReadMoreNT(stream, state) {
    while (!state.reading && !state.ended && (state.length < state.highWaterMark || (state.flowing && state.length === 0))) {
      var len = state.length;
      stream.read(0);
      if (len === state.length) break;
    }
    state.readingMore = false;
  }

  function flow(stream) {
    var state = stream._readableState;
    while (state.flowing && stream.read() !== null);
  }

  function addChunk(stream, state, chunk, addToFront) {
    if (state.flowing && state.length === 0 && !state.sync && listenerCountOf(stream, 'data') > 0) {
      state.dataEmitted = true;
      stream.emit('data', chunk);
    } else {
      state.length += state.objectMode ? 1 : chunk.length;
      if (addToFront) state.buffer.unshift(chunk);
      else state.buffer.push(chunk);
      if (state.needReadable) emitReadable(stream);
    }
    maybeReadMore(stream, state);
  }

  function onEofChunk(stream, state) {
    if (state.ended) return;
    if (state.decoder) {
      var tail = state.decoder.end();
      if (tail && tail.length) {
        state.buffer.push(tail);
        state.length += state.objectMode ? 1 : tail.length;
      }
    }
    state.ended = true;
    if (state.sync) {
      emitReadable(stream);
    } else {
      state.needReadable = false;
      state.emittedReadable = true;
      emitReadableNT(stream);
    }
  }

  function readableAddChunk(stream, chunk, encoding, addToFront) {
    var state = stream._readableState;
    var err = null;
    if (!state.objectMode) {
      if (typeof chunk === 'string') {
        encoding = encoding || state.defaultEncoding;
        if (stateEncodingName(state) !== encoding) {
          if (addToFront && state.encoding) {
            chunk = Buf.from(chunk, encoding).toString(stateEncodingName(state));
          } else {
            chunk = Buf.from(chunk, encoding);
            encoding = '';
          }
        }
      } else if (chunk instanceof Uint8Array) {
        if (!Buf.isBuffer(chunk)) chunk = Buf.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        encoding = '';
      } else if (chunk !== undefined && chunk !== null) {
        err = argTypeError('chunk', 'of type string or an instance of Buffer, TypedArray, or DataView', chunk);
      }
    }
    if (err) {
      errorOrDestroy(stream, err);
    } else if (chunk === null) {
      state.reading = false;
      onEofChunk(stream, state);
    } else if (state.objectMode || (chunk && chunk.length > 0)) {
      if (addToFront) {
        if (state.endEmitted) errorOrDestroy(stream, errUnshiftAfterEnd());
        else if (state.destroyed || state.errored) return false;
        else addChunk(stream, state, chunk, true);
      } else if (state.ended) {
        errorOrDestroy(stream, errPushAfterEof());
      } else if (state.destroyed || state.errored) {
        return false;
      } else {
        state.reading = false;
        if (state.decoder && !encoding) {
          chunk = state.decoder.write(chunk);
          if (state.objectMode || chunk.length !== 0) addChunk(stream, state, chunk, false);
          else maybeReadMore(stream, state);
        } else {
          addChunk(stream, state, chunk, false);
        }
      }
    } else if (!addToFront) {
      state.reading = false;
      maybeReadMore(stream, state);
    }
    return !state.ended && (state.length < state.highWaterMark || state.length === 0);
  }

  function howMuchToRead(n, state) {
    if (n <= 0 || (state.length === 0 && state.ended)) return 0;
    if (state.objectMode) return 1;
    if (Number.isNaN(n)) {
      if (state.flowing && state.length) return state.buffer[0].length;
      return state.length;
    }
    if (n <= state.length) return n;
    return state.ended ? state.length : 0;
  }

  // Removes n bytes (or characters when decoding) from the front of the buffer.
  function takeFromBuffer(n, state) {
    var parts = [];
    var remaining = n;
    while (remaining > 0 && state.buffer.length > 0) {
      var head = state.buffer[0];
      if (head.length <= remaining) {
        parts.push(head);
        state.buffer.shift();
        remaining -= head.length;
      } else {
        parts.push(head.slice(0, remaining));
        state.buffer[0] = head.slice(remaining);
        remaining = 0;
      }
    }
    if (state.decoder) return parts.join('');
    return parts.length === 1 ? parts[0] : Buf.concat(parts, n - remaining);
  }

  function fromList(n, state) {
    if (state.length === 0) return null;
    var ret;
    if (state.objectMode) {
      ret = state.buffer.shift();
    } else if (!n || n >= state.length) {
      if (state.decoder) ret = state.buffer.join('');
      else if (state.buffer.length === 1) ret = state.buffer[0];
      else ret = Buf.concat(state.buffer, state.length);
      state.buffer = [];
    } else {
      ret = takeFromBuffer(n, state);
    }
    return ret;
  }

  function endReadable(stream) {
    var state = stream._readableState;
    if (!state.endEmitted) {
      state.ended = true;
      process.nextTick(endReadableNT, state, stream);
    }
  }

  function endReadableNT(state, stream) {
    if (!state.errored && !state.closeEmitted && !state.endEmitted && state.length === 0) {
      state.endEmitted = true;
      stream.emit('end');
      if (stream.allowHalfOpen === false && stream.writable) {
        process.nextTick(endWritableNT, stream);
      } else if (state.autoDestroy) {
        var wState = stream._writableState;
        var autoDestroy = !wState || (wState.autoDestroy && (wState.finished || wState.writable === false));
        if (autoDestroy) stream.destroy();
      }
    }
  }

  function endWritableNT(stream) {
    if (stream.writable) stream.end();
  }

  Readable.prototype.push = function (chunk, encoding) {
    return readableAddChunk(this, chunk, encoding, false);
  };

  Readable.prototype.unshift = function (chunk, encoding) {
    return readableAddChunk(this, chunk, encoding, true);
  };

  Readable.prototype._read = function () {
    throw errNotImplemented('_read()');
  };

  Readable.prototype._destroy = function (err, cb) {
    cb(err);
  };

  Readable.prototype.read = function (n) {
    var state = this._readableState;
    if (n === undefined || n === null) n = NaN;
    else if (typeof n !== 'number') n = Number.parseInt(n, 10);
    var nOrig = n;
    if (n > state.highWaterMark && !state.objectMode) state.highWaterMark = nextPowerOfTwo(n);
    if (n !== 0) state.emittedReadable = false;
    if (n === 0 && state.needReadable && ((state.highWaterMark !== 0 ? state.length >= state.highWaterMark : state.length > 0) || state.ended)) {
      if (state.length === 0 && state.ended) endReadable(this);
      else emitReadable(this);
      return null;
    }
    n = howMuchToRead(n, state);
    if (n === 0 && state.ended) {
      if (state.length === 0) endReadable(this);
      return null;
    }
    var doRead = state.needReadable;
    if (state.length === 0 || state.length - n < state.highWaterMark) doRead = true;
    if (state.ended || state.reading || state.destroyed || state.errored) {
      doRead = false;
    } else if (doRead) {
      state.reading = true;
      state.sync = true;
      if (state.length === 0) state.needReadable = true;
      try {
        this._read(state.highWaterMark);
      } catch (err) {
        errorOrDestroy(this, err);
      }
      state.sync = false;
      if (!state.reading) n = howMuchToRead(nOrig, state);
    }
    var ret = n > 0 ? fromList(n, state) : null;
    if (ret === null) {
      state.needReadable = state.length <= state.highWaterMark;
      n = 0;
    } else {
      state.length -= n;
      pipeExtras(state).awaitDrain = [];
    }
    if (state.length === 0) {
      if (!state.ended) state.needReadable = true;
      if (nOrig !== n && state.ended) endReadable(this);
    }
    if (ret !== null && !state.errorEmitted && !state.closeEmitted) {
      state.dataEmitted = true;
      this.emit('data', ret);
    }
    return ret;
  };

  Readable.prototype.setEncoding = function (enc) {
    var state = this._readableState;
    var decoder = createDecoder(enc);
    state.decoder = decoder;
    state.encoding = decoder.encoding;
    var content = '';
    for (var i = 0; i < state.buffer.length; i++) content += decoder.write(state.buffer[i]);
    state.buffer = content.length > 0 ? [content] : [];
    state.length = content.length;
    return this;
  };

  function resumeNT(stream, state) {
    if (!state.reading) stream.read(0);
    state.resumeScheduled = false;
    stream.emit('resume');
    flow(stream);
    if (state.flowing && !state.reading) stream.read(0);
  }

  Readable.prototype.resume = function () {
    var state = this._readableState;
    if (!state.flowing) {
      state.flowing = !state.readableListening;
      if (!state.resumeScheduled) {
        state.resumeScheduled = true;
        process.nextTick(resumeNT, this, state);
      }
    }
    state.paused = false;
    return this;
  };

  Readable.prototype.pause = function () {
    var state = this._readableState;
    if (state.flowing !== false) {
      state.flowing = false;
      this.emit('pause');
    }
    state.paused = true;
    return this;
  };

  Readable.prototype.isPaused = function () {
    var state = this._readableState;
    return state.paused === true || (state.paused !== false && state.flowing === false);
  };

  function updateReadableListening(self) {
    var state = self._readableState;
    state.readableListening = self.listenerCount('readable') > 0;
    if (state.resumeScheduled && state.paused === false) state.flowing = true;
    else if (self.listenerCount('data') > 0) self.resume();
    else if (!state.readableListening) state.flowing = null;
  }

  Readable.prototype.on = function (ev, fn) {
    var res = EventEmitter.prototype.on.call(this, ev, fn);
    var state = this._readableState;
    if (ev === 'data') {
      state.readableListening = this.listenerCount('readable') > 0;
      if (state.flowing !== false) this.resume();
    } else if (ev === 'readable') {
      if (!state.endEmitted && !state.readableListening) {
        state.readableListening = true;
        state.needReadable = true;
        state.flowing = false;
        state.emittedReadable = false;
        if (state.length) emitReadable(this);
        else if (!state.reading) process.nextTick(readNT, this);
      }
    }
    return res;
  };
  Readable.prototype.addListener = Readable.prototype.on;

  function readNT(self) {
    self.read(0);
  }

  Readable.prototype.removeListener = function (ev, fn) {
    var res = EventEmitter.prototype.removeListener.call(this, ev, fn);
    if (ev === 'readable') process.nextTick(updateReadableListening, this);
    return res;
  };
  Readable.prototype.off = Readable.prototype.removeListener;

  /* pipe() keeps the per-destination cleanup hooks and the drain waiters off the state entirely, in
     a WeakMap: the host keeps neither, so even a state that has been a pipe source owns no extra key
     of its own beyond Symbol(kState). */
  var pipeExtrasOf = typeof WeakMap === 'function' ? new WeakMap() : null;
  function pipeExtras(state) {
    var extras = pipeExtrasOf === null ? null : pipeExtrasOf.get(state);
    if (extras === null || extras === undefined) {
      extras = { hooks: [], awaitDrain: [] };
      if (pipeExtrasOf !== null) pipeExtrasOf.set(state, extras);
      else state.owcPipeExtras = extras;
    }
    return extras;
  }

  function pipeOnDrain(src, dest) {
    return function () {
      var state = src._readableState;
      var extras = pipeExtras(state);
      extras.awaitDrain = extras.awaitDrain.filter(function (d) { return d !== dest; });
      if (extras.awaitDrain.length === 0 && listenerCountOf(src, 'data') > 0) src.resume();
    };
  }

  Readable.prototype.pipe = function (dest, pipeOpts) {
    var src = this;
    var state = this._readableState;
    state.pipes.push(dest);
    var doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;
    var cleanedUp = false;
    var ondrain = pipeOnDrain(src, dest);

    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      offListener(dest, 'close', onclose);
      offListener(dest, 'finish', onfinish);
      offListener(dest, 'drain', ondrain);
      offListener(dest, 'error', onerror);
      offListener(dest, 'unpipe', onunpipe);
      offListener(src, 'end', onend);
      offListener(src, 'end', unpipe);
      offListener(src, 'data', ondata);
      var extras = pipeExtras(state);
      extras.hooks = extras.hooks.filter(function (hook) { return hook.dest !== dest; });
    }

    function unpipe() {
      src.unpipe(dest);
    }

    function onunpipe(readable) {
      if (readable === src) cleanup();
    }

    function onend() {
      dest.end();
    }

    function ondata(chunk) {
      // A destination that rejects the chunk (a non-objectMode sink fed objects, say) throws out of
      // write(); Node turns that into the destination's 'error', never an uncaught exception.
      var wrote;
      try {
        wrote = dest.write(chunk);
      } catch (er) {
        errorOrDestroy(dest, er);
        return;
      }
      if (wrote === false) pauseSource();
    }

    function pauseSource() {
      if (!cleanedUp) {
        if (state.pipes.length === 1 && state.pipes[0] === dest) {
          pipeExtras(state).awaitDrain = [dest];
        } else if (state.pipes.indexOf(dest) !== -1) {
          pipeExtras(state).awaitDrain.push(dest);
        }
        src.pause();
      }
    }

    function onerror(er) {
      unpipe();
      offListener(dest, 'error', onerror);
      if (listenerCountOf(dest, 'error') === 0) {
        var ds = dest._writableState || dest._readableState;
        if (ds && !ds.errorEmitted) errorOrDestroy(dest, er);
        else emitSafe(dest, 'error', er);
      }
    }

    function onclose() {
      offListener(dest, 'finish', onfinish);
      unpipe();
    }

    function onfinish() {
      offListener(dest, 'close', onclose);
      unpipe();
    }

    pipeExtras(state).hooks.push({ dest: dest, cleanup: cleanup });
    if (typeof dest.prependListener === 'function') dest.prependListener('error', onerror);
    else dest.on('error', onerror);
    if (doEnd) {
      if (state.endEmitted) process.nextTick(onend);
      else src.once('end', onend);
    } else {
      if (state.endEmitted) process.nextTick(unpipe);
      else src.once('end', unpipe);
    }
    dest.on('unpipe', onunpipe);
    dest.on('drain', ondrain);
    src.on('data', ondata);
    if (typeof dest.once === 'function') {
      dest.once('close', onclose);
      dest.once('finish', onfinish);
    }
    emitSafe(dest, 'pipe', src);
    if (dest.writableNeedDrain === true) {
      if (state.flowing) pauseSource();
    } else if (!state.flowing) {
      src.resume();
    }
    return dest;
  };

  Readable.prototype.unpipe = function (dest) {
    var state = this._readableState;
    if (state.pipes.length === 0) return this;
    if (dest === undefined || dest === null) {
      var dests = state.pipes;
      var hooks = pipeExtras(state).hooks.slice();
      state.pipes = [];
      pipeExtras(state).hooks = [];
      this.pause();
      for (var i = 0; i < hooks.length; i++) hooks[i].cleanup();
      for (var j = 0; j < dests.length; j++) emitSafe(dests[j], 'unpipe', this, { hasUnpiped: false });
      return this;
    }
    var index = state.pipes.indexOf(dest);
    if (index === -1) return this;
    state.pipes.splice(index, 1);
    pipeExtras(state).hooks.filter(function (hook) { return hook.dest === dest; }).forEach(function (hook) { hook.cleanup(); });
    if (state.pipes.length === 0) this.pause();
    emitSafe(dest, 'unpipe', this, { hasUnpiped: false });
    return this;
  };

  function createReadableIterator(stream, options) {
    var destroyOnReturn = !options || options.destroyOnReturn !== false;
    var state = stream._readableState;
    var waiter = null;
    var failure = null;
    var finished = false;

    function wake() {
      if (waiter !== null) {
        var resume = waiter;
        waiter = null;
        resume();
      }
    }
    function onError(err) {
      failure = err;
      wake();
    }
    stream.on('readable', wake);
    stream.on('end', wake);
    stream.on('error', onError);
    stream.on('close', wake);

    function cleanup() {
      finished = true;
      offListener(stream, 'readable', wake);
      offListener(stream, 'end', wake);
      offListener(stream, 'error', onError);
      offListener(stream, 'close', wake);
    }

    return {
      next: function () {
        return new Promise(function (resolve, reject) {
          function attempt() {
            if (failure !== null) {
              var err = failure;
              failure = null;
              cleanup();
              reject(err);
              return;
            }
            if (finished) {
              resolve({ value: undefined, done: true });
              return;
            }
            var chunk = stream.read();
            if (chunk !== null) {
              resolve({ value: chunk, done: false });
              return;
            }
            if (state.endEmitted) {
              cleanup();
              resolve({ value: undefined, done: true });
              return;
            }
            if (state.closeEmitted || state.destroyed) {
              /* A destroy that carries an error emits 'error' on a later tick. Reject only once that
                 emission has had its listener, so a for-await loop takes the error instead of the
                 process dying of an unhandled one. */
              if (state.errored !== null && state.errored !== undefined && !state.errorEmitted && !state.closeEmitted) {
                waiter = attempt;
                return;
              }
              cleanup();
              reject(state.errored || errPrematureClose());
              return;
            }
            waiter = attempt;
          }
          attempt();
        });
      },
      return: function (value) {
        cleanup();
        if (destroyOnReturn) stream.destroy();
        return Promise.resolve({ value: value, done: true });
      },
      [Symbol.asyncIterator]: function () {
        return this;
      }
    };
  }

  Readable.prototype[Symbol.asyncIterator] = function () {
    return createReadableIterator(this);
  };

  /* Node's readable.iterator(options) is the async iterator a for-await loop uses, handed back
     directly: a caller who wants the stream to survive a break asks for destroyOnReturn false. */
  Readable.prototype.iterator = function (options) {
    return createReadableIterator(this, options);
  };

  /* readable.wrap(stream) drives this stream from an old-style one -- a stream with data, end and
     error events but nothing to read on demand -- pausing the source when this stream's buffer is
     full and resuming it when the reader asks for more. */
  Readable.prototype.wrap = function (src) {
    var self = this;
    var paused = false;
    src.on('data', function (chunk) {
      if (!self.push(chunk)) {
        paused = true;
        if (typeof src.pause === 'function') src.pause();
      }
    });
    src.on('end', function () { self.push(null); });
    src.on('error', function (err) { self.emit('error', err); });
    src.on('close', function () { self.emit('close'); });
    src.on('destroy', function () { self.emit('close'); });
    this._read = function () {
      if (paused) {
        paused = false;
        if (typeof src.resume === 'function') src.resume();
      }
    };
    return this;
  };

  /* readable.compose(stream, options): the same body conversion stream.compose starts with, with this
     stream as the first source. Node validates options and its signal, then composes; the options
     object itself is not a stream in the chain, so only the two streams are handed to compose. */
  Readable.prototype.compose = function (stream, options) {
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object') throw argTypeError('options', 'of type object', options);
      checkSignalProp(options.signal);
    }
    return compose(this, stream);
  };

  Readable.prototype.toArray = async function (options) {
    var signal = checkOperatorOptions(options);
    var out = [];
    var iterator = this[Symbol.asyncIterator]();
    for (;;) {
      if (signal !== undefined && signal !== null && signal.aborted) throw abortErrorFor(signal);
      var step = await iterator.next();
      if (step.done) break;
      out.push(step.value);
    }
    return out;
  };

  Readable.from = function (iterable, opts) {
    if (typeof iterable === 'string' || Buf.isBuffer(iterable)) {
      return new Readable(Object.assign({ objectMode: true }, opts, {
        read: function () {
          this.push(iterable);
          this.push(null);
        }
      }));
    }
    var isAsync = false;
    var iterator;
    if (iterable && typeof iterable[Symbol.asyncIterator] === 'function') {
      isAsync = true;
      iterator = iterable[Symbol.asyncIterator]();
    } else if (iterable && typeof iterable[Symbol.iterator] === 'function') {
      iterator = iterable[Symbol.iterator]();
    } else {
      throw argTypeError('iterable', 'an instance of Iterable', iterable);
    }
    var readable = new Readable(Object.assign({ objectMode: true, highWaterMark: 1 }, opts));
    var reading = false;

    async function closeIterator(error) {
      var hadError = error !== undefined && error !== null;
      if (hadError && typeof iterator.throw === 'function') {
        var thrown = await iterator.throw(error);
        await thrown.value;
        if (thrown.done) return;
      }
      if (typeof iterator.return === 'function') {
        var returned = await iterator.return();
        await returned.value;
      }
    }

    async function pump() {
      for (;;) {
        try {
          var step = isAsync ? await iterator.next() : iterator.next();
          if (step.done) {
            readable.push(null);
          } else {
            var res = step.value && typeof step.value.then === 'function' ? await step.value : step.value;
            if (res === null) {
              reading = false;
              throw errNullValues();
            } else if (readable.push(res)) {
              continue;
            } else {
              reading = false;
            }
          }
        } catch (err) {
          readable.destroy(err);
        }
        break;
      }
    }

    readable._read = function () {
      if (!reading) {
        reading = true;
        pump();
      }
    };
    readable._destroy = function (error, cb) {
      closeIterator(error).then(function () {
        process.nextTick(cb, error);
      }, function (closeErr) {
        process.nextTick(cb, closeErr || error);
      });
    };
    return readable;
  };

  // ---------------------------------------------------------------- iterator helpers (Node operators)

  function makeAsyncIterator(next, ret) {
    var it = {
      next: next,
      return: function (value) {
        if (typeof ret === 'function') return ret(value);
        return Promise.resolve({ value: value, done: true });
      }
    };
    it[Symbol.asyncIterator] = function () {
      return this;
    };
    return it;
  }

  function asyncIteratorOf(value) {
    if (value && typeof value[Symbol.asyncIterator] === 'function') return value[Symbol.asyncIterator]();
    var syncIter = value[Symbol.iterator]();
    return makeAsyncIterator(function () {
      var step = syncIter.next();
      return Promise.resolve(step.value).then(function (v) {
        return { value: v, done: step.done };
      });
    }, null);
  }

  function operatorStream(next, ret) {
    return Readable.from(makeAsyncIterator(next, ret));
  }

  function checkOperatorFn(fn) {
    if (typeof fn !== 'function') throw argTypeError('fn', 'of type function', fn);
  }

  // Node names the reducer 'reducer' and the signal property 'options.signal' in every operator.
  function checkOperatorOptions(options) {
    if (options !== undefined && typeof options !== 'object') throw argTypeError('options', 'of type object', options);
    var signal = options === undefined || options === null ? undefined : options.signal;
    checkSignalProp(signal);
    return signal;
  }

  function checkSignalProp(signal) {
    if (signal === undefined || signal === null) return;
    if (!signal || typeof signal !== 'object' || !('aborted' in signal)) {
      throw owcErr(TypeError, 'ERR_INVALID_ARG_TYPE',
        'The "options.signal" property must be an instance of AbortSignal.' + describeReceived(signal));
    }
  }

  // A step taken while the signal is already aborted fails at once with the signal's abort error.
  function abortStep(signal) {
    if (signal !== undefined && signal !== null && signal.aborted) {
      return Promise.reject(abortErrorFor(signal));
    }
    return null;
  }

  /* Node coerces the limit with Number(): '2' is 2 and 'abc', null, undefined and NaN are all 0,
     while anything negative (including the string '-1') is out of range. The reported name is
     "number", not "limit", and the reported value is the coerced one. */
  function limitOf(limit) {
    var n = Number(limit);
    if (Number.isNaN(n)) return 0;
    if (n < 0) {
      throw owcErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "number" is out of range. It must be >= 0. Received ' + n);
    }
    return n;
  }

  Readable.prototype.map = function (fn, options) {
    checkOperatorFn(fn);
    var signal = checkOperatorOptions(options);
    var inner = this[Symbol.asyncIterator]();
    return operatorStream(function () {
      var aborted = abortStep(signal);
      if (aborted !== null) return aborted;
      return inner.next().then(function (step) {
        if (step.done) return step;
        return Promise.resolve(fn(step.value, { signal: signal })).then(function (v) {
          return { value: v, done: false };
        });
      });
    }, function (value) {
      return inner.return(value);
    });
  };

  Readable.prototype.filter = function (fn, options) {
    checkOperatorFn(fn);
    var signal = checkOperatorOptions(options);
    var inner = this[Symbol.asyncIterator]();
    var pull = function () {
      var aborted = abortStep(signal);
      if (aborted !== null) return aborted;
      return inner.next().then(function (step) {
        if (step.done) return step;
        return Promise.resolve(fn(step.value, { signal: signal })).then(function (keep) {
          return keep ? { value: step.value, done: false } : pull();
        });
      });
    };
    return operatorStream(pull, function (value) {
      return inner.return(value);
    });
  };

  Readable.prototype.flatMap = function (fn, options) {
    checkOperatorFn(fn);
    var inner = this[Symbol.asyncIterator]();
    var signal = options && options.signal;
    var sub = null;
    var pull = function () {
      if (sub !== null) {
        return sub.next().then(function (s) {
          if (!s.done) return s;
          sub = null;
          return pull();
        });
      }
      return inner.next().then(function (step) {
        if (step.done) return step;
        return Promise.resolve(fn(step.value, { signal: signal })).then(function (res) {
          sub = asyncIteratorOf(res);
          return pull();
        });
      });
    };
    return operatorStream(pull, function (value) {
      if (sub !== null && typeof sub.return === 'function') sub.return();
      return inner.return(value);
    });
  };

  Readable.prototype.drop = function (limit, options) {
    var signal = checkOperatorOptions(options);
    var toDrop = limitOf(limit);
    var inner = this[Symbol.asyncIterator]();
    var pull = function () {
      var aborted = abortStep(signal);
      if (aborted !== null) return aborted;
      return inner.next().then(function (step) {
        if (step.done) return step;
        return toDrop-- > 0 ? pull() : step;
      });
    };
    return operatorStream(pull, function (value) {
      return inner.return(value);
    });
  };

  Readable.prototype.take = function (limit, options) {
    var signal = checkOperatorOptions(options);
    var left = limitOf(limit);
    var inner = this[Symbol.asyncIterator]();
    return operatorStream(function () {
      var aborted = abortStep(signal);
      if (aborted !== null) return aborted;
      if (left-- <= 0) return Promise.resolve({ value: undefined, done: true });
      return inner.next();
    }, function (value) {
      return inner.return(value);
    });
  };

  Readable.prototype.forEach = async function (fn, options) {
    checkOperatorFn(fn);
    var signal = checkOperatorOptions(options);
    var inner = this[Symbol.asyncIterator]();
    for (;;) {
      if (signal !== undefined && signal !== null && signal.aborted) throw abortErrorFor(signal);
      var step = await inner.next();
      if (step.done) return undefined;
      await fn(step.value, { signal: signal });
    }
  };

  Readable.prototype.some = async function (fn) {
    checkOperatorFn(fn);
    var inner = this[Symbol.asyncIterator]();
    for (;;) {
      var step = await inner.next();
      if (step.done) return false;
      if (await fn(step.value, {})) {
        await inner.return();
        return true;
      }
    }
  };

  Readable.prototype.every = async function (fn) {
    checkOperatorFn(fn);
    var inner = this[Symbol.asyncIterator]();
    for (;;) {
      var step = await inner.next();
      if (step.done) return true;
      if (!(await fn(step.value, {}))) {
        await inner.return();
        return false;
      }
    }
  };

  Readable.prototype.find = async function (fn) {
    checkOperatorFn(fn);
    var inner = this[Symbol.asyncIterator]();
    for (;;) {
      var step = await inner.next();
      if (step.done) return undefined;
      if (await fn(step.value, {})) {
        await inner.return();
        return step.value;
      }
    }
  };

  /* Node raises an internal ReduceAwareErrMissingArgs subclass, so both the constructor name
     and the code of the reduce-without-initial-value error are observable. */
  function ReduceAwareErrMissingArgs(message) {
    var e = new TypeError(message);
    Object.setPrototypeOf(e, ReduceAwareErrMissingArgs.prototype);
    e.code = 'ERR_MISSING_ARGS';
    return e;
  }
  ReduceAwareErrMissingArgs.prototype = Object.create(TypeError.prototype, {
    constructor: { value: ReduceAwareErrMissingArgs, writable: true, configurable: true }
  });
  function makeReduceAwareErrMissingArgs() {
    return new ReduceAwareErrMissingArgs('Reduce of an empty stream requires an initial value');
  }

  Readable.prototype.reduce = async function (fn, initialValue, options) {
    if (typeof fn !== 'function') throw argTypeError('reducer', 'of type function', fn);
    checkOperatorOptions(options);
    var inner = this[Symbol.asyncIterator]();
    var hasInitial = arguments.length > 1;
    var acc = initialValue;
    for (;;) {
      var step = await inner.next();
      if (step.done) break;
      if (!hasInitial) {
        acc = step.value;
        hasInitial = true;
      } else {
        acc = await fn(acc, step.value, {});
      }
    }
    if (!hasInitial) {
      throw makeReduceAwareErrMissingArgs();
    }
    return acc;
  };

  Object.defineProperty(Readable.prototype, 'readable', {
    get: function () {
      var r = this._readableState;
      return !!r && r.readable !== false && !r.destroyed && !r.errorEmitted && !r.endEmitted;
    },
    set: function (value) {
      if (this._readableState) this._readableState.readable = !!value;
    },
    configurable: true
  });
  Object.defineProperty(Readable.prototype, 'readableEncoding', {
    get: function () {
      var r = this._readableState;
      return r && r.encoding !== undefined ? r.encoding : null;
    },
    configurable: true
  });
  Object.defineProperty(Readable.prototype, 'readableEnded', {
    get: function () { return !!this._readableState && this._readableState.endEmitted; },
    configurable: true
  });
  Object.defineProperty(Readable.prototype, 'readableFlowing', {
    get: function () { return this._readableState.flowing; },
    set: function (value) { this._readableState.flowing = value; },
    configurable: true
  });
  Object.defineProperty(Readable.prototype, 'readableLength', {
    get: function () { return this._readableState.length; },
    configurable: true
  });
  Object.defineProperty(Readable.prototype, 'readableHighWaterMark', {
    get: function () { return this._readableState.highWaterMark; },
    configurable: true
  });
  Object.defineProperty(Readable.prototype, 'readableObjectMode', {
    get: function () { return this._readableState.objectMode; },
    configurable: true
  });
  function defineSharedGetters(proto) {
    Object.defineProperty(proto, 'errored', {
      get: function () {
        var r = this._readableState;
        var w = this._writableState;
        return (r && r.errored) || (w && w.errored) || null;
      },
      configurable: true
    });
    Object.defineProperty(proto, 'closed', {
      get: function () {
        var r = this._readableState;
        var w = this._writableState;
        return !!((r && r.closeEmitted) || (w && w.closeEmitted));
      },
      configurable: true
    });
    Object.defineProperty(proto, 'destroyed', {
      get: function () {
        var r = this._readableState;
        var w = this._writableState;
        return !!((r && r.destroyed) || (w && w.destroyed));
      },
      set: function (value) {
        var r = this._readableState;
        var w = this._writableState;
        if (r) r.destroyed = value;
        if (w) w.destroyed = value;
      },
      configurable: true
    });
  }
  defineSharedGetters(Readable.prototype);

  /* Node's deprecated _undestroy re-opens a destroyed stream: it resets the flags destroyImpl
     set without touching the buffer or the pipes. */
  Readable.prototype._undestroy = function () {
    var r = this._readableState;
    var w = this._writableState;
    if (r) {
      r.closed = false;
      r.closeEmitted = false;
      r.destroyed = false;
      r.errored = null;
      r.errorEmitted = false;
      r.reading = false;
      r.ended = r.readable === false;
      r.endEmitted = r.readable === false;
    }
    if (w) {
      w.destroyed = false;
      w.closed = false;
      w.closeEmitted = false;
      w.errored = null;
      w.errorEmitted = false;
      w.finalCalled = false;
      w.prefinished = false;
      w.ended = w.writable === false;
      w.ending = w.writable === false;
      w.finished = w.writable === false;
    }
  };
  Object.defineProperty(Readable.prototype, 'readableBuffer', {
    get: function () { var r = this._readableState; return r ? r.buffer : undefined; },
    set: function (value) { if (this._readableState) this._readableState.buffer = value; },
    configurable: true
  });
  Readable.prototype.removeAllListeners = function (ev) {
    var res = EventEmitter.prototype.removeAllListeners.apply(this, arguments);
    if (ev === 'readable' || ev === undefined) process.nextTick(updateReadableListening, this);
    return res;
  };

  // ---------------------------------------------------------------- Writable

  function Writable(options) {
    var isDuplex = this instanceof Duplex;
    if (!isDuplex && !(this instanceof Writable)) return new Writable(options);
    /* Same shaped listener map as the readable side, with the five events a writable stream uses. */
    if (this._events === undefined) {
      this._events = { close: undefined, error: undefined, prefinish: undefined, finish: undefined, drain: undefined };
    }
    this._writableState = makeWritableState(options, isDuplex, this);
    if (options) {
      if (typeof options.write === 'function') this._write = options.write;
      if (typeof options.writev === 'function') this._writev = options.writev;
      if (typeof options.destroy === 'function') this._destroy = options.destroy;
      if (typeof options.final === 'function') this._final = options.final;
      if (typeof options.construct === 'function') this._construct = options.construct;
      if (options.signal) addAbortSignal(options.signal, this);
    }
    Stream.call(this, options);
    if (this._construct !== undefined && this._construct !== null) {
      var self = this;
      constructStream(this, function () { writableOnConstructed(self); });
    }
  }
  Object.setPrototypeOf(Writable.prototype, Stream.prototype);
  Object.setPrototypeOf(Writable, Stream);

  Object.defineProperty(Writable, Symbol.hasInstance, {
    value: function (object) {
      if (Function.prototype[Symbol.hasInstance].call(this, object)) return true;
      if (this !== Writable) return false;
      return !!object && object._writableState !== undefined;
    }
  });

  function onwriteFor(stream) {
    return function (er) {
      onwrite(stream, er);
    };
  }

  function needFinish(state) {
    return state.ending && !state.destroyed && state.length === 0 && !state.errored && state.buffered.length === 0 &&
      !state.finished && !state.writing && !state.errorEmitted && !state.closeEmitted;
  }

  function finishStream(stream, state) {
    state.pendingcb--;
    state.finished = true;
    var callbacks = onFinishedTake(state);
    for (var i = 0; i < callbacks.length; i++) callbacks[i](null);
    stream.emit('finish');
    if (state.autoDestroy) {
      var rState = stream._readableState;
      var autoDestroy = !rState || (rState.autoDestroy && (rState.endEmitted || rState.readable === false));
      if (autoDestroy) stream.destroy();
    }
  }

  function finishDeferred(stream, state) {
    if (needFinish(state)) finishStream(stream, state);
    else state.pendingcb--;
  }

  function errorBuffer(state) {
    if (state.writing) return;
    var items = state.buffered.splice(0);
    state.length = 0;
    for (var i = 0; i < items.length; i++) {
      state.pendingcb--;
      items[i].callback(state.errored || errDestroyed('write'));
    }
  }

  function prefinish(stream, state) {
    if (!state.prefinished && !state.finalCalled) {
      if (typeof stream._final === 'function' && !state.destroyed) {
        state.finalCalled = true;
        callFinal(stream, state);
      } else {
        state.prefinished = true;
        stream.emit('prefinish');
      }
    }
  }

  function callFinal(stream, state) {
    var called = false;
    function onFinal(err) {
      if (called) {
        errorOrDestroy(stream, errMultipleCallback());
        return;
      }
      called = true;
      state.pendingcb--;
      if (err) {
        var callbacks = onFinishedTake(state);
        for (var i = 0; i < callbacks.length; i++) callbacks[i](err);
        errorOrDestroy(stream, err, state.sync);
      } else if (needFinish(state)) {
        state.prefinished = true;
        stream.emit('prefinish');
        state.pendingcb++;
        process.nextTick(finishStream, stream, state);
      }
    }
    state.sync = true;
    state.pendingcb++;
    try {
      stream._final(onFinal);
    } catch (err) {
      onFinal(err);
    }
    state.sync = false;
  }

  function finishMaybe(stream, state, sync) {
    if (needFinish(state)) {
      prefinish(stream, state);
      if (state.pendingcb === 0) {
        if (sync) {
          state.pendingcb++;
          process.nextTick(finishDeferred, stream, state);
        } else if (needFinish(state)) {
          state.pendingcb++;
          finishStream(stream, state);
        }
      }
    }
  }

  function afterWrite(stream, state, count, cb) {
    var needDrain = !state.ending && !stream.destroyed && state.length === 0 && state.needDrain;
    if (needDrain) {
      state.needDrain = false;
      stream.emit('drain');
    }
    while (count-- > 0) {
      state.pendingcb--;
      cb(null);
    }
    if (state.destroyed) errorBuffer(state);
    finishMaybe(stream, state);
  }

  function afterWriteNT(stream, state, count, cb) {
    afterWrite(stream, state, count, cb);
  }

  function onwriteError(stream, state, er, cb, count) {
    state.pendingcb -= count;
    while (count-- > 0) cb(er);
    errorBuffer(state);
    errorOrDestroy(stream, er);
  }

  function onwrite(stream, er) {
    var state = stream._writableState;
    /* Node keeps "a write callback is expected" as its own bit, so a second call to onwrite for one
       write is the ERR_MULTIPLE_CALLBACK case rather than a nop replay. */
    if ((state[kState] & W_EXPECT_WRITE_CB) === 0) {
      errorOrDestroy(stream, errMultipleCallback());
      return;
    }
    var sync = state.sync;
    var cb = (state[kState] & W_WRITE_CB) !== 0 ? state[kWriteCbValue] : nop;
    /* A writev batch carries how many buffered writes it settles on the callback itself, so the
       count needs no field of its own on the state. */
    var count = (cb && cb.owcWriteCount) || 1;
    state.writecb = null;
    state[kState] &= ~(W_WRITING | W_EXPECT_WRITE_CB);
    state.length -= state.writelen;
    state.writelen = 0;
    if (er) {
      if (!state.errored) state.errored = er;
      if (stream._readableState && !stream._readableState.errored) stream._readableState.errored = er;
      if (sync) process.nextTick(onwriteError, stream, state, er, cb, count);
      else onwriteError(stream, state, er, cb, count);
    } else {
      if (state.buffered.length > 0) clearBuffer(stream, state);
      if (sync) process.nextTick(afterWriteNT, stream, state, count, cb);
      else afterWrite(stream, state, count, cb);
    }
  }

  function doWrite(stream, state, writev, len, chunk, encoding, cb, count) {
    state.writelen = len;
    state.writecb = cb;
    if (count > 1 && typeof cb === 'function') cb.owcWriteCount = count;
    state[kState] |= W_WRITING | W_SYNC | W_EXPECT_WRITE_CB;
    if (state.destroyed) state.onwrite(errDestroyed('write'));
    else if (writev) stream._writev(chunk, state.onwrite);
    else stream._write(chunk, encoding, state.onwrite);
    state[kState] &= ~W_SYNC;
  }

  function clearBuffer(stream, state) {
    if (state.corked || state.bufferProcessing || state.destroyed) return;
    if (state.buffered.length === 0) return;
    state.bufferProcessing = true;
    if (state.buffered.length > 1 && typeof stream._writev === 'function') {
      var items = state.buffered.splice(0);
      var total = 0;
      for (var k = 0; k < items.length; k++) total += state.objectMode ? 1 : items[k].chunk.length;
      var batch = items.map(function (item) { return { chunk: item.chunk, encoding: item.encoding }; });
      var settledIndex = 0;
      var fanout = function (err) {
        items[settledIndex++].callback(err);
      };
      doWrite(stream, state, true, total, batch, '', fanout, items.length);
    } else {
      while (state.buffered.length > 0 && !state.writing) {
        var item = state.buffered.shift();
        var len = state.objectMode ? 1 : item.chunk.length;
        doWrite(stream, state, false, len, item.chunk, item.encoding, item.callback, 1);
      }
    }
    state.bufferProcessing = false;
  }

  function writeOrBuffer(stream, state, chunk, encoding, callback) {
    var len = state.objectMode ? 1 : chunk.length;
    state.length += len;
    var ret = state.length < state.highWaterMark;
    if (!ret) state.needDrain = true;
    if (state.writing || state.corked || state.errored || state.destroyed) {
      bufferedPush(state, { chunk: chunk, encoding: encoding, callback: callback });
    } else {
      doWrite(stream, state, false, len, chunk, encoding, callback, 1);
    }
    return ret && !state.errored && !state.destroyed;
  }

  // Shared by write() and end(): returns true, false, or an Error to report.
  function writeImpl(stream, chunk, encoding, cb) {
    var state = stream._writableState;
    if (typeof encoding === 'function') {
      cb = encoding;
      encoding = state.defaultEncoding;
    } else {
      if (!encoding) encoding = state.defaultEncoding;
      else if (encoding !== 'buffer' && !KNOWN_ENCODINGS[normalizeEncoding(encoding)]) throw errUnknownEncoding(encoding);
      if (typeof cb !== 'function') cb = nop;
    }
    if (chunk === null) {
      throw errNullValues();
    } else if (!state.objectMode) {
      if (typeof chunk === 'string') {
        if (state.decodeStrings !== false) {
          chunk = Buf.from(chunk, encoding);
          encoding = 'buffer';
        }
      } else if (chunk instanceof Buf) {
        encoding = 'buffer';
      } else if (chunk instanceof Uint8Array) {
        chunk = Buf.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        encoding = 'buffer';
      } else {
        throw argTypeError('chunk', 'of type string or an instance of Buffer, TypedArray, or DataView', chunk);
      }
    }
    var err = null;
    if (state.ending) err = errWriteAfterEnd();
    else if (state.destroyed) err = errDestroyed('write');
    if (err) {
      process.nextTick(cb, err);
      errorOrDestroy(stream, err, true);
      return err;
    }
    state.pendingcb++;
    return writeOrBuffer(stream, state, chunk, encoding, cb);
  }


  Writable.prototype.write = function (chunk, encoding, cb) {
    return writeImpl(this, chunk, encoding, cb) === true;
  };

  Writable.prototype.end = function (chunk, encoding, cb) {
    var state = this._writableState;
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === 'function') {
      cb = encoding;
      encoding = null;
    }
    var err = null;
    if (chunk !== null && chunk !== undefined) {
      var ret = writeImpl(this, chunk, encoding);
      if (ret instanceof Error) err = ret;
    }
    if (state.corked) {
      state.corked = 1;
      this.uncork();
    }
    if (err) {
      // the write error was already reported
    } else if (!state.errored && !state.ending) {
      state.ending = true;
      finishMaybe(this, state, true);
      state.ended = true;
    } else if (state.finished) {
      err = errAlreadyFinished('end');
    } else if (state.destroyed) {
      err = errDestroyed('end');
    }
    if (typeof cb === 'function') {
      if (err || state.finished) process.nextTick(cb, err);
      else onFinishedPush(state, cb);
    }
    return this;
  };

  Writable.prototype.cork = function () {
    this._writableState.corked++;
  };

  Writable.prototype.uncork = function () {
    var state = this._writableState;
    if (state.corked) {
      state.corked--;
      if (!state.writing) clearBuffer(this, state);
    }
  };

  Writable.prototype.setDefaultEncoding = function (enc) {
    var e = typeof enc === 'string' ? enc.toLowerCase() : enc;
    if (!KNOWN_ENCODINGS[normalizeEncoding(e)]) throw errUnknownEncoding(enc);
    this._writableState.defaultEncoding = e;
    return this;
  };

  Writable.prototype._write = function (chunk, encoding, cb) {
    if (typeof this._writev === 'function') this._writev([{ chunk: chunk, encoding: encoding }], cb);
    else throw errNotImplemented('_write()');
  };

  Writable.prototype._destroy = function (err, cb) {
    cb(err);
  };
  Writable.prototype.destroy = destroyImpl;
  Readable.prototype.destroy = destroyImpl;

  function defineWritableGetters(proto) {
    Object.defineProperty(proto, 'writable', {
      get: function () {
        var w = this._writableState;
        return !!w && w.writable !== false && !w.destroyed && !w.errored && !w.ending && !w.ended;
      },
      set: function (value) {
        if (this._writableState) this._writableState.writable = !!value;
      },
      configurable: true
    });
    Object.defineProperty(proto, 'writableEnded', {
      get: function () { return !!this._writableState && this._writableState.ending; },
      configurable: true
    });
    Object.defineProperty(proto, 'writableFinished', {
      get: function () { return !!this._writableState && this._writableState.finished; },
      configurable: true
    });
    Object.defineProperty(proto, 'writableLength', {
      get: function () { return this._writableState.length; },
      configurable: true
    });
    Object.defineProperty(proto, 'writableHighWaterMark', {
      get: function () { return this._writableState.highWaterMark; },
      configurable: true
    });
    Object.defineProperty(proto, 'writableObjectMode', {
      get: function () { return this._writableState.objectMode; },
      configurable: true
    });
    Object.defineProperty(proto, 'writableNeedDrain', {
      get: function () {
        var w = this._writableState;
        return !!w && !w.destroyed && !w.ending && w.needDrain;
      },
      configurable: true
    });
    Object.defineProperty(proto, 'writableCorked', {
      get: function () { return this._writableState.corked; },
      configurable: true
    });
  }
  defineWritableGetters(Writable.prototype);
  defineSharedGetters(Writable.prototype);

  Writable.prototype._undestroy = Readable.prototype._undestroy;
  /* Node declares _writev as an own null property: a stream opts in by assigning its own. */
  Writable.prototype._writev = null;
  Object.defineProperty(Writable.prototype, 'writableBuffer', {
    get: function () { var w = this._writableState; return w ? w.buffered : undefined; },
    set: function (value) { if (this._writableState) this._writableState.buffered = value; },
    configurable: true
  });
  Object.defineProperty(Writable.prototype, 'writableAborted', {
    get: function () {
      var w = this._writableState;
      if (!w) return false;
      return (!!w.destroyed || !!w.errored) && !w.finished;
    },
    configurable: true
  });
  Writable.prototype.pipe = function () {
    destroyImpl.call(this, owcErr(Error, 'ERR_STREAM_CANNOT_PIPE', 'Cannot pipe, not readable'));
  };

  // ---------------------------------------------------------------- Duplex

  function Duplex(options) {
    if (!(this instanceof Duplex)) return new Duplex(options);
    /* Duplex builds both states itself and only then lets EventEmitter finish the job, so a duplex
       owns no _read/_write until an option supplies them and _maxListeners lands last. */
    if (this._events === undefined) {
      this._events = {
        close: undefined,
        error: undefined,
        prefinish: undefined,
        finish: undefined,
        drain: undefined,
        data: undefined,
        end: undefined,
        readable: undefined
      };
    }
    this._readableState = makeReadableState(options, true);
    this._writableState = makeWritableState(options, true, this);
    if (options) {
      this.allowHalfOpen = options.allowHalfOpen !== false;
      if (options.readable === false) {
        this._readableState.readable = false;
        this._readableState.ended = true;
        this._readableState.endEmitted = true;
      }
      if (options.writable === false) {
        this._writableState.writable = false;
        this._writableState.ending = true;
        this._writableState.ended = true;
        this._writableState.finished = true;
      }
      if (typeof options.read === 'function') this._read = options.read;
      if (typeof options.write === 'function') this._write = options.write;
      if (typeof options.writev === 'function') this._writev = options.writev;
      if (typeof options.destroy === 'function') this._destroy = options.destroy;
      if (typeof options.final === 'function') this._final = options.final;
      if (typeof options.construct === 'function') this._construct = options.construct;
      if (options.signal) addAbortSignal(options.signal, this);
    } else {
      this.allowHalfOpen = true;
    }
    Stream.call(this, options);
    if (this._construct !== undefined && this._construct !== null) {
      var self = this;
      constructStream(this, function () {
        readableOnConstructed(self);
        writableOnConstructed(self);
      });
    }
  }
  Object.setPrototypeOf(Duplex.prototype, Readable.prototype);
  Object.setPrototypeOf(Duplex, Readable);
  /* Node re-declares every Writable member on Duplex.prototype except the destroy/error/closed
     group, so those names are own on Duplex rather than inherited from Readable. */
  var DUPLEX_INHERIT_SKIP = { constructor: true, _destroy: true, _undestroy: true, closed: true, errored: true, pipe: true, writableAborted: true };
  Object.getOwnPropertyNames(Writable.prototype).forEach(function (method) {
    if (DUPLEX_INHERIT_SKIP[method] === true) return;
    Object.defineProperty(Duplex.prototype, method, Object.getOwnPropertyDescriptor(Writable.prototype, method));
  });
  defineWritableGetters(Duplex.prototype);
  /* Duplex.from: the same bodies Readable.from does not take -- a function, a promise and a
     { readable, writable } pair -- over the same converter compose uses, so a generator function,
     Duplex.from(Promise.resolve('pz')) and Duplex.from({ readable, writable }) all work as on a
     host. Inherited from Readable it answered Readable.from and rejected all three as iterables. */
  Duplex.from = function (body) {
    return duplexFrom(body);
  };

  // ---------------------------------------------------------------- Transform

  function Transform(options) {
    if (!(this instanceof Transform)) return new Transform(options);
    Duplex.call(this, options);
    this._readableState.sync = false;
    this[kTransformCallback] = null;
    if (options) {
      if (typeof options.transform === 'function') this._transform = options.transform;
      if (typeof options.flush === 'function') this._flush = options.flush;
    }
  }
  Object.setPrototypeOf(Transform.prototype, Duplex.prototype);
  Object.setPrototypeOf(Transform, Duplex);

  Transform.prototype._transform = function () {
    throw errNotImplemented('_transform()');
  };

  Transform.prototype._write = function (chunk, encoding, callback) {
    var self = this;
    var rState = this._readableState;
    var wState = this._writableState;
    var length = rState.length;
    this._transform(chunk, encoding, function (err, val) {
      if (err) {
        callback(err);
        return;
      }
      if (val !== undefined && val !== null) self.push(val);
      if (wState.ended || length === rState.length || rState.length < rState.highWaterMark) callback();
      else self[kTransformCallback] = callback;
    });
  };

  Transform.prototype._read = function () {
    if (this[kTransformCallback]) {
      var callback = this[kTransformCallback];
      this[kTransformCallback] = null;
      callback();
    }
  };

  Transform.prototype._final = function (cb) {
    var self = this;
    if (typeof this._flush === 'function' && !this.destroyed) {
      this._flush(function (er, data) {
        if (er) {
          if (cb) cb(er);
          else self.destroy(er);
          return;
        }
        if (data !== undefined && data !== null) self.push(data);
        self.push(null);
        if (cb) cb();
      });
    } else {
      this.push(null);
      if (cb) cb();
    }
  };

  // ---------------------------------------------------------------- PassThrough

  function PassThrough(options) {
    if (!(this instanceof PassThrough)) return new PassThrough(options);
    Transform.call(this, options);
  }
  Object.setPrototypeOf(PassThrough.prototype, Transform.prototype);
  Object.setPrototypeOf(PassThrough, Transform);
  PassThrough.prototype._transform = function (chunk, encoding, cb) {
    cb(null, chunk);
  };

  // ---------------------------------------------------------------- finished / pipeline

  function finishedImpl(stream, options, callback) {
    var opts = options || {};
    var rState = stream._readableState;
    var wState = stream._writableState;
    var readable = opts.readable !== undefined ? !!opts.readable : rState !== undefined;
    var writable = opts.writable !== undefined ? !!opts.writable : wState !== undefined;
    var rDone = !readable || (rState !== undefined && rState.endEmitted === true);
    var wDone = !writable || (wState !== undefined && wState.finished === true);
    var called = false;
    var listeners = [];
    var signal = opts.signal === undefined || opts.signal === null ? null : opts.signal;
    var onAbort = null;

    function cleanup() {
      for (var i = 0; i < listeners.length; i++) offListener(stream, listeners[i][0], listeners[i][1]);
      listeners = [];
      if (onAbort !== null && signal !== null) signal.removeEventListener('abort', onAbort);
    }
    function done(err) {
      if (called) return;
      called = true;
      cleanup();
      callback.call(stream, err);
    }
    function listen(type, fn) {
      stream.on(type, fn);
      listeners.push([type, fn]);
    }
    function check() {
      if (rDone && wDone) done();
    }

    if (readable) {
      listen('end', function () {
        rDone = true;
        check();
      });
    }
    if (writable) {
      listen('finish', function () {
        wDone = true;
        check();
      });
    }
    listen('error', function (err) {
      done(err);
    });
    listen('close', function () {
      if (!rDone || !wDone) done(errPrematureClose());
      else done();
    });

    // finished() takes a signal as pipeline() does: an abort ends the wait with the signal's abort
    // error, at once when it is already aborted.
    if (signal !== null) {
      checkSignalProp(signal);
      onAbort = function () {
        done(abortErrorFor(signal));
      };
      if (signal.aborted) process.nextTick(onAbort);
      else signal.addEventListener('abort', onAbort);
    }

    var storedError = (rState && rState.errored) || (wState && wState.errored) || null;
    var closedAlready = (rState && rState.closeEmitted) || (wState && wState.closeEmitted);
    if (closedAlready) {
      process.nextTick(function () {
        if (storedError) done(storedError);
        else if (rDone && wDone) done();
        else done(errPrematureClose());
      });
    }
    return cleanup;
  }

  function finished(stream, options, callback) {
    var cb = typeof options === 'function' ? options : callback;
    var opts = typeof options === 'function' ? {} : options || {};
    if (typeof cb !== 'function') throw argTypeError('callback', 'of type function', cb);
    if (!isStreamLike(stream)) throw argTypeError('stream', 'an instance of ReadableStream, WritableStream, or Stream', stream);
    return finishedImpl(stream, opts, cb);
  }

  function linkPipe(src, dst) {
    src.pipe(dst, { end: false });
    var endFn = function () {
      dst.end();
    };
    if (src._readableState && src._readableState.endEmitted) process.nextTick(endFn);
    else src.once('end', endFn);
  }

  class AbortError extends Error {
    constructor(message, options) {
      super(message === undefined ? 'The operation was aborted' : message, options);
      this.code = 'ABORT_ERR';
      this.name = 'AbortError';
    }
  }

  // The abort cause is the signal's reason; a signal aborted without a reason gets Node's default cause.
  function abortErrorFor(signal) {
    var reason = signal ? signal.reason : undefined;
    if (reason === undefined) reason = new AbortError('This operation was aborted');
    return new AbortError(undefined, { cause: reason });
  }

  function addAbortSignal(signal, stream) {
    /* typeof null is 'object', so a null signal reaches the operand test and fails as a bad 'in'
       operand, the way it does in Node, while an undefined one fails as a type error. Node's text
       is the one V8 gives for that operand, which this engine words differently. */
    if (signal === null) throw new TypeError("Cannot use 'in' operator to search for 'aborted' in null");
    if (typeof signal !== 'object' || !('aborted' in signal)) {
      throw argTypeError('signal', 'an instance of AbortSignal', signal);
    }
    if (!stream || typeof stream !== 'object' || typeof stream.destroy !== 'function') {
      throw argTypeError('stream', 'an instance of ReadableStream, WritableStream, or Stream', stream);
    }
    var onAbort = function () {
      stream.destroy(abortErrorFor(signal));
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort);
      finishedImpl(stream, {}, function () {
        signal.removeEventListener('abort', onAbort);
      });
    }
    return stream;
  }

  function pipelineImpl(streams, callback, opts) {
    var error = null;
    var pending = streams.length;
    var destroyers = [];
    var completed = false;
    var signal = opts && opts.signal ? opts.signal : null;
    var onAbort = null;

    function finishStep(err) {
      if (completed) return;
      if (err && (error === null || error.code === 'ERR_STREAM_PREMATURE_CLOSE')) error = err;
      pending--;
      if (error !== null) {
        while (destroyers.length > 0) destroyers.shift()(error);
      }
      if (pending === 0) {
        completed = true;
        if (signal !== null) signal.removeEventListener('abort', onAbort);
        process.nextTick(callback, error === null ? undefined : error, undefined);
      }
    }

    function abortPipeline() {
      if (completed) return;
      if (error === null) error = abortErrorFor(signal);
      while (destroyers.length > 0) destroyers.shift()(error);
    }

    if (signal !== null) {
      onAbort = abortPipeline;
      if (signal.aborted) process.nextTick(abortPipeline);
      else signal.addEventListener('abort', onAbort);
    }

    var last = streams.length - 1;
    for (var i = 0; i < streams.length; i++) {
      (function (stream, reading, writing) {
        var settled = false;
        finishedImpl(stream, { readable: reading, writable: writing }, function (err) {
          settled = !err;
          finishStep(err);
        });
        destroyers.push(function (err) {
          if (settled) return;
          settled = true;
          stream.destroy(err || errDestroyed('pipe'));
        });
      })(streams[i], i < last, i > 0);
      if (i > 0) linkPipe(streams[i - 1], streams[i]);
    }
    return streams[last];
  }

  function isStreamLike(value) {
    return !!value && typeof value === 'object' && typeof value.on === 'function';
  }

  function argBodyError(value) {
    return owcErr(TypeError, 'ERR_INVALID_ARG_TYPE',
      'The "body" argument must be of type function or an instance of Blob, ReadableStream, WritableStream, Stream, Iterable, AsyncIterable, or Promise or { readable, writable } pair.' + describeReceived(value));
  }

  function pipelineStart(args, callback, opts) {
    if (args.length === 1 && Array.isArray(args[0])) args = args[0];
    if (args.length < 2) throw owcErr(TypeError, 'ERR_MISSING_ARGS', 'The "streams" argument must be specified');
    for (var i = 0; i < args.length; i++) args[i] = pipelineBody(args[i]);
    return pipelineImpl(args, callback, opts);
  }

  // compose and pipeline both take non-stream bodies: a function becomes a Duplex over its async
  // generator, and a bare (async) iterable becomes a Readable over it.
  function pipelineBody(value) {
    if (isStreamLike(value)) return value;
    if (typeof value === 'function') return funcToDuplex(value);
    if (value && typeof value.then === 'function') return promiseToDuplex(value);
    if (value && (readableTrait(value.readable) || writableTrait(value.writable))) return pairToDuplex(value);
    if (value && (typeof value[Symbol.asyncIterator] === 'function' || typeof value[Symbol.iterator] === 'function')) {
      return Readable.from(value);
    }
    throw argBodyError(value);
  }

  /* A { readable, writable } pair is a body of its own: the two halves become the two sides of one
     Duplex, which is what Duplex.from answers for that shape. */
  function pairToDuplex(pair) {
    var r = pair.readable;
    var w = pair.writable;
    var readable = readableTrait(r);
    var writable = writableTrait(w);
    var d = new Duplex({
      objectMode: !!(r && r.readableObjectMode) || !!(w && w.writableObjectMode),
      readable: readable,
      writable: writable
    });
    if (readable) {
      r.on('end', function () {
        d.push(null);
      });
      r.on('readable', function () {
        d._read();
      });
      d._read = function () {
        for (;;) {
          var chunk = r.read();
          if (chunk === null) return;
          if (!d.push(chunk)) return;
        }
      };
    }
    if (writable) {
      d._write = function (chunk, encoding, callback) {
        if (w.write(chunk, encoding)) callback();
        else w.once('drain', callback);
      };
      d._final = function (callback) {
        w.end(callback);
      };
    }
    return d;
  }

  // A promise body settles into one chunk: whatever it resolves to is pushed once, as it is.
  function promiseToDuplex(value) {
    var out = new Duplex({
      objectMode: true,
      read: function () {},
      /* What is written to it goes nowhere: a promise is a source, so a promise body in the middle
         of a composed chain takes the link before it and answers with its own value instead. */
      write: function (chunk, encoding, callback) {
        callback();
      },
      final: function (callback) {
        callback();
      }
    });
    Promise.resolve(value).then(function (settled) {
      if (!isStreamLike(settled)) {
        out.push(settled);
        out.push(null);
        return;
      }
      out._read = function () {
        settled.resume();
      };
      settled.on('data', function (chunk) {
        if (!out.push(chunk)) settled.pause();
      });
      settled.on('end', function () {
        out.push(null);
      });
      settled.on('error', function (err) {
        out.destroy(err);
      });
    }, function (err) {
      out.destroy(err);
    });
    return out;
  }

  /* What a body function answered with is a body in its own right, and Node reads it the same way it
     reads one handed to compose: a string or a Buffer is one chunk, an iterable is its values, a
     stream is the next link, and anything else is not a body at all. */
  function bodyValue(value) {
    if (isStreamLike(value)) return value;
    if (typeof value === 'string' || Buf.isBuffer(value)) return Readable.from(value);
    if (value && typeof value.then === 'function') return promiseToDuplex(value);
    if (value && (readableTrait(value.readable) || writableTrait(value.writable))) return pairToDuplex(value);
    if (value && typeof value[Symbol.asyncIterator] === 'function') return Readable.from(value);
    if (value && typeof value[Symbol.iterator] === 'function') return Readable.from(value);
    throw owcErr(TypeError, 'ERR_INVALID_RETURN_VALUE',
      'Expected Iterable, AsyncIterable or AsyncFunction to be returned from the "body" function but got '
      + describeReceived(value).replace(/^ Received /, '') + '.');
  }

  function readableTrait(value) {
    return !!value && typeof value === 'object' && value.readable !== false && typeof value.read === 'function';
  }

  function writableTrait(value) {
    return !!value && typeof value === 'object' && value.writable !== false && typeof value.write === 'function';
  }

  /* Node's ERR_INVALID_ARG_VALUE prints the value itself, not its class: a stream that lands in the
     wrong position of a compose is dumped whole, cut at 128 characters. */
  function inspectValue(value) {
    try {
      return requireBuiltin('util').inspect(value);
    } catch (failure) {
      return String(value);
    }
  }

  function traitError(index, value, reason) {
    var shown = inspectValue(value);
    if (shown.length > 128) shown = shown.slice(0, 128) + '...';
    return owcErr(TypeError, 'ERR_INVALID_ARG_VALUE',
      "The argument 'streams[" + index + "]' must be " + reason + '. Received ' + shown);
  }

  // Duplex.from(fn): the writable side feeds the generator's argument, the readable side yields it.
  function iteratorToDuplex(iterator, source) {
    var duplex = new Duplex({
      objectMode: true,
      write: function (chunk, encoding, callback) {
        if (source.write(chunk, encoding)) callback();
        else source.once('drain', callback);
      },
      final: function (callback) {
        source.end();
        callback();
      },
      read: function () {
        pull();
      }
    });
    var pulling = false;
    function pull() {
      if (pulling) return;
      pulling = true;
      Promise.resolve(iterator.next()).then(function (step) {
        pulling = false;
        if (step.done) duplex.push(null);
        else duplex.push(step.value);
      }, function (err) {
        pulling = false;
        duplex.destroy(err);
      });
    }
    return duplex;
  }

  /* Node calls a function that takes no argument at once and takes what it answers as the next link
     in the chain; one that takes the source is a generator over it, and what it answers is read as
     an iterable even when it is a stream. */
  /* An async function body has to answer null or undefined: anything else is an unhandled
     ERR_INVALID_RETURN_VALUE on the host, thrown out of the promise's own reaction and not out of
     the duplex, and it is that rejection -- not the stream -- that ends the process. */
  function nullyBodyError(val) {
    return owcErr(TypeError, 'ERR_INVALID_RETURN_VALUE',
      'Expected nully to be returned from the "body" function but got ' + describeReceived(val).replace(/^ Received /, '') + '.');
  }

  function checkAsyncBody(answered) {
    if (answered === null || typeof answered !== 'object') return;
    if (typeof answered.next === 'function' || typeof answered.then !== 'function') return;
    answered.then(function (val) {
      if (val !== null && val !== undefined) throw nullyBodyError(val);
    });
  }

  function funcToDuplex(fn) {
    if (typeof fn !== 'function') return fn;
    if (fn.length === 0) {
      var made = fn();
      checkAsyncBody(made);
      if (made === null || typeof made !== 'object') return bodyValue(made);
      if (typeof made.next === 'function') return iteratorToDuplex(made, new PassThrough({ objectMode: true }));
      return bodyValue(made);
    }
    var source = new PassThrough({ objectMode: true });
    var iterator = fn(source);
    checkAsyncBody(iterator);
    if (iterator === null || typeof iterator !== 'object') return bodyValue(iterator);
    if (typeof iterator.next !== 'function') {
      /* A string or a Buffer answered by a body of one argument is one chunk, as Node reads it, and
         not an iterable of characters or of bytes. */
      if (typeof iterator === 'string' || Buf.isBuffer(iterator)) return bodyValue(iterator);
      if (typeof iterator[Symbol.asyncIterator] === 'function') iterator = iterator[Symbol.asyncIterator]();
      else if (typeof iterator[Symbol.iterator] === 'function') iterator = iterator[Symbol.iterator]();
      else return bodyValue(iterator);
    }
    return iteratorToDuplex(iterator, source);
  }

  function duplexFrom(value) {
    if (typeof value === 'function') return funcToDuplex(value);
    if (isStreamLike(value)) {
      var readable = readableTrait(value);
      var writable = writableTrait(value);
      if (readable && writable) return value;
      var wrapper = new Duplex({
        objectMode: !!(value.readableObjectMode || value.writableObjectMode),
        readable: readable,
        writable: writable
      });
      if (readable) {
        value.on('end', function () {
          wrapper.push(null);
        });
        value.on('readable', function () {
          wrapper._read();
        });
        wrapper._read = function () {
          for (;;) {
            var chunk = value.read();
            if (chunk === null) return;
            if (!wrapper.push(chunk)) return;
          }
        };
      }
      if (writable) {
        wrapper._write = function (chunk, encoding, callback) {
          if (value.write(chunk, encoding)) callback();
          else value.once('drain', callback);
        };
        wrapper._final = function (callback) {
          value.end(callback);
        };
      }
      return wrapper;
    }
    return pipelineBody(value);
  }

  function compose() {
    var streams = Array.prototype.slice.call(arguments);
    if (streams.length === 0) throw owcErr(TypeError, 'ERR_MISSING_ARGS', 'The "streams" argument must be specified');
    if (streams.length === 1) return duplexFrom(streams[0]);
    if (typeof streams[0] === 'function') streams[0] = funcToDuplex(streams[0]);
    var last = streams.length - 1;
    // A generator function is a body wherever it stands, not only at either end: in the middle it is
    // the transform between the two streams around it.
    for (var m = 0; m < streams.length; m++) {
      if (typeof streams[m] === 'function') streams[m] = funcToDuplex(streams[m]);
      /* A promise is a body wherever it stands too, and what it settles to is the link. */
      else if (streams[m] && typeof streams[m].then === 'function') streams[m] = promiseToDuplex(streams[m]);
    }
    for (var n = 0; n < streams.length; n++) {
      var item = streams[n];
      if (!item || typeof item !== 'object') continue;
      if (n < last && !readableTrait(item)) throw traitError(n, item, 'readable');
      if (n > 0 && !writableTrait(item)) throw traitError(n, item, 'writable');
    }
    var head = streams[0];
    var tail = streams[last];
    var writable = writableTrait(head);
    var readable = readableTrait(tail);
    var d = new Duplex({
      writableObjectMode: !!(head && head.writableObjectMode),
      readableObjectMode: !!(tail && tail.readableObjectMode),
      writable: writable,
      readable: readable
    });
    var ondrain = null;
    var onfinish = null;
    var onreadable = null;
    function composeError(er) {
      if (!d.destroyed) d.destroy(er);
    }
    for (var i = 1; i < streams.length; i++) linkPipe(streams[i - 1], streams[i]);
    // Node holds the composed duplex to the fate of its parts: an error on any one of them is the
    // composed stream's error, so 'compose(...).toArray()' rejects instead of the part erroring
    // where nobody can hear it.
    for (var e = 0; e < streams.length; e++) {
      var part = streams[e];
      if (part && typeof part.on === 'function') part.on('error', composeError);
    }
    if (writable) {
      d._write = function (chunk, encoding, callback) {
        if (head.write(chunk, encoding)) callback();
        else ondrain = callback;
      };
      d._final = function (callback) {
        head.end();
        onfinish = callback;
      };
      head.on('drain', function () {
        if (ondrain) {
          var cb = ondrain;
          ondrain = null;
          cb();
        }
      });
      head.on('finish', function () {
        if (onfinish) {
          var cb = onfinish;
          onfinish = null;
          cb();
        }
      });
    }
    if (readable) {
      tail.on('readable', function () {
        if (onreadable) {
          var cb = onreadable;
          onreadable = null;
          cb();
        }
      });
      tail.on('end', function () {
        if (!d.destroyed) d.push(null);
      });
      d._read = function () {
        for (;;) {
          var chunk = tail.read();
          if (chunk === null) {
            onreadable = d._read;
            return;
          }
          if (!d.push(chunk)) return;
        }
      };
    } else {
      d._read = function () {};
    }
    return d;
  }

  function pipeline() {
    var args = Array.prototype.slice.call(arguments);
    var callback = args.length > 0 && typeof args[args.length - 1] === 'function' ? args.pop() : null;
    if (typeof callback !== 'function') throw propTypeError('streams[stream.length - 1]', 'of type function', args[args.length - 1]);
    return pipelineStart(args, callback, null);
  }

  var streamPromises = {
    pipeline: function () {
      var args = Array.prototype.slice.call(arguments);
      var opts = null;
      var last = args[args.length - 1];
      if (last && typeof last === 'object' && !isStreamLike(last) && !Array.isArray(last)) opts = args.pop();
      return new Promise(function (resolve, reject) {
        checkSignalProp(opts === null || opts === undefined ? undefined : opts.signal);
        pipelineStart(args, function (err) {
          if (err) reject(err);
          else resolve();
        }, opts);
      });
    },
    finished: function (stream, options) {
      return new Promise(function (resolve, reject) {
        finishedImpl(stream, options || {}, function (err) {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  };

  function streamIsDestroyed(stream) {
    if (!stream || typeof stream !== 'object') return null;
    var r = stream._readableState;
    var w = stream._writableState;
    if (r === undefined && w === undefined) return null;
    return !!((w && w.destroyed) || (r && r.destroyed));
  }

  function streamIsReadable(stream) {
    if (!stream || typeof stream !== 'object' || typeof stream.readable !== 'boolean') return null;
    if (streamIsDestroyed(stream)) return false;
    var r = stream._readableState;
    return !!(stream.readable && !(r && r.endEmitted));
  }

  function streamIsWritable(stream) {
    if (!stream || typeof stream !== 'object' || typeof stream.writable !== 'boolean') return null;
    if (streamIsDestroyed(stream)) return false;
    var w = stream._writableState;
    return !!(stream.writable && !(w && w.finished));
  }

  // Node reads the 'errorEmitted' gate: an error counts once its 'error' event has been delivered.
  function streamIsErrored(stream) {
    if (!stream || typeof stream !== 'object') return false;
    var r = stream._readableState;
    var w = stream._writableState;
    /* Node 24 exposes no readableErrored or writableErrored: it reads the 'errorEmitted' gate, so
       an error counts once its 'error' event has been delivered. */
    return !!((r && r.errorEmitted) ?? (w && w.errorEmitted) ?? (r && r.errored) ?? (w && w.errored));
  }

  function streamIsDisturbed(stream) {
    if (!stream || typeof stream !== 'object') return false;
    return !!(stream.readableDidRead || stream.readableAborted);
  }

  Object.defineProperty(Readable.prototype, 'readableDidRead', {
    get: function () {
      return !!(this._readableState && this._readableState.dataEmitted);
    },
    configurable: true
  });
  Object.defineProperty(Readable.prototype, 'readableAborted', {
    get: function () {
      var r = this._readableState;
      return !!(r && (r.destroyed || r.errored) && !r.endEmitted);
    },
    configurable: true
  });

  /* duplexPair: two duplexes wired to each other, so what one is written with the other reads.
     Each side's write pushes straight into the other's readable buffer and waits for that side to
     ask for more before it takes another chunk; ending one side ends the other's readable half. */
  /* The two sides Node's duplexPair answers are instances of its own DuplexSide subclass of Duplex,
     so that is the name a caller reads off them, and _read/_write/_final are methods on that
     subclass's prototype rather than properties of each side: a side owns no underscore methods. */
  var kDuplexSideCallback = Symbol('Callback');
  var kDuplexSideOther = Symbol('owcOtherSide');

  function DuplexSide(options) {
    if (!(this instanceof DuplexSide)) return new DuplexSide(options);
    Duplex.call(this, options);
    this[kDuplexSideCallback] = null;
    this[kDuplexSideOther] = null;
  }
  Object.setPrototypeOf(DuplexSide.prototype, Duplex.prototype);
  Object.setPrototypeOf(DuplexSide, Duplex);
  DuplexSide.prototype._read = function () {
    var callback = this[kDuplexSideCallback];
    if (callback) {
      this[kDuplexSideCallback] = null;
      callback();
    }
  };
  DuplexSide.prototype._write = function (chunk, encoding, callback) {
    var other = this[kDuplexSideOther];
    if (chunk.length === 0) process.nextTick(callback);
    else {
      other.push(chunk);
      other[kDuplexSideCallback] = callback;
    }
  };
  DuplexSide.prototype._final = function (callback) {
    var other = this[kDuplexSideOther];
    other.on('end', callback);
    other.push(null);
  };

  function duplexPair(options) {
    var opts = options || {};
    var side0 = new DuplexSide({ objectMode: !!opts.objectMode, highWaterMark: opts.highWaterMark });
    var side1 = new DuplexSide({ objectMode: !!opts.objectMode, highWaterMark: opts.highWaterMark });
    side0[kDuplexSideOther] = side1;
    side1[kDuplexSideOther] = side0;
    return [side0, side1];
  }

  // ---------------------------------------------------------------- web streams

  /* Node bridges its streams and the web's with toWeb and fromWeb: a web reader pulls through the
     node stream's async iterator, and a web writer's write, close and abort drive write, end and
     destroy. A byte stream crosses as bytes -- a Buffer or Uint8Array unchanged, a string encoded --
     while an object-mode stream hands its values over as they are. */
  function webChunkOf(value, objectMode) {
    if (objectMode) return value;
    if (value instanceof Uint8Array) return value;
    if (typeof value === 'string') return typeof TextEncoder === 'function' ? new TextEncoder().encode(value) : Buf.from(value);
    return value;
  }
  function nodeChunkOf(value) {
    if (value instanceof Buf) return value;
    if (value instanceof Uint8Array) return Buf.from(value.buffer, value.byteOffset, value.byteLength);
    return value;
  }
  function isWebReadable(value) {
    return !!value && typeof value === 'object' && typeof value.getReader === 'function';
  }
  function isWebWritable(value) {
    return !!value && typeof value === 'object' && typeof value.getWriter === 'function';
  }
  function webStreamsMissing(what, value) {
    if (typeof ReadableStream !== 'function') return owcErr(Error, 'ERR_INVALID_ARG_TYPE', 'The web stream API is not available in this runtime');
    return argTypeError(what, 'an instance of ' + what, value);
  }

  Readable.toWeb = function (stream) {
    if (typeof ReadableStream !== 'function') throw webStreamsMissing('ReadableStream', stream);
    var it = createReadableIterator(stream, null);
    var objectMode = !!(stream && stream._readableState && stream._readableState.objectMode);
    var ended = false;
    return new ReadableStream({
      pull: function (controller) {
        return it.next().then(function (step) {
          if (step.done) {
            ended = true;
            controller.close();
            return;
          }
          controller.enqueue(webChunkOf(step.value, objectMode));
        }, function (err) { controller.error(err); });
      },
      cancel: function () {
        if (!ended && typeof it.return === 'function') it.return();
        return undefined;
      }
    });
  };

  Readable.fromWeb = function (readableStream, options) {
    if (!isWebReadable(readableStream)) throw webStreamsMissing('ReadableStream', readableStream);
    var reader = readableStream.getReader();
    var opts = {};
    if (options) for (var key in options) opts[key] = options[key];
    opts.read = function () {
      var self = this;
      reader.read().then(function (step) {
        if (step.done) self.push(null);
        else self.push(nodeChunkOf(step.value));
      }, function (err) { self.destroy(err); });
    };
    if (typeof opts.destroy !== 'function') {
      opts.destroy = function (err, cb) {
        try { reader.cancel(); } catch (e) { /* a web stream already closed rejects the cancel */ }
        cb(err);
      };
    }
    return new Readable(opts);
  };

  Writable.toWeb = function (stream) {
    if (typeof WritableStream !== 'function') throw webStreamsMissing('WritableStream', stream);
    return new WritableStream({
      write: function (chunk) {
        return new Promise(function (resolve, reject) {
          stream.write(nodeChunkOf(chunk), function (err) { if (err) reject(err); else resolve(); });
        });
      },
      close: function () {
        return new Promise(function (resolve, reject) {
          stream.on('error', reject);
          stream.end(function () { resolve(); });
        });
      },
      abort: function (reason) { stream.destroy(reason); }
    });
  };

  Writable.fromWeb = function (writableStream, options) {
    if (!isWebWritable(writableStream)) throw webStreamsMissing('WritableStream', writableStream);
    var writer = writableStream.getWriter();
    var opts = {};
    if (options) for (var key in options) opts[key] = options[key];
    opts.write = function (chunk, encoding, cb) {
      writer.write(chunk).then(function () { cb(); }, function (err) { cb(err); });
    };
    if (typeof opts.final !== 'function') {
      opts.final = function (cb) {
        writer.close().then(function () { cb(); }, function (err) { cb(err); });
      };
    }
    if (typeof opts.destroy !== 'function') {
      opts.destroy = function (err, cb) {
        try { writer.abort(err); } catch (e) { /* already closed */ }
        cb(err);
      };
    }
    return new Writable(opts);
  };

  /* Duplex.toWeb hands back the two halves Node names -- the readable as a ReadableStream and the
     writable as a WritableStream -- both over the one duplex. */
  Duplex.toWeb = function (stream) {
    return { readable: Readable.toWeb(stream), writable: Writable.toWeb(stream) };
  };

  Duplex.fromWeb = function (pair, options) {
    var readable = pair && pair.readable;
    var writable = pair && pair.writable;
    if (!isWebReadable(readable)) throw webStreamsMissing('ReadableStream', readable);
    if (!isWebWritable(writable)) throw webStreamsMissing('WritableStream', writable);
    var reader = readable.getReader();
    var writer = writable.getWriter();
    var opts = {};
    if (options) for (var key in options) opts[key] = options[key];
    opts.read = function () {
      var self = this;
      reader.read().then(function (step) {
        if (step.done) self.push(null);
        else self.push(nodeChunkOf(step.value));
      }, function (err) { self.destroy(err); });
    };
    opts.write = function (chunk, encoding, cb) {
      writer.write(chunk).then(function () { cb(); }, function (err) { cb(err); });
    };
    if (typeof opts.final !== 'function') {
      opts.final = function (cb) {
        writer.close().then(function () { cb(); }, function (err) { cb(err); });
      };
    }
    opts.destroy = function (err, cb) {
      try { reader.cancel(); } catch (e) { /* already closed */ }
      try { writer.abort(err); } catch (e) { /* already closed */ }
      cb(err);
    };
    return new Duplex(opts);
  };

  /*
   * The order these are assigned in is the order Object.keys(require('node:stream')) reads them
   * back in, and a host's order is not alphabetical: its five predicates come first, then the
   * constructors and helpers, then 'promises', 'Stream', and the three underscore helpers last.
   */
  Stream.isDestroyed = streamIsDestroyed;
  Stream.isDisturbed = streamIsDisturbed;
  Stream.isErrored = streamIsErrored;
  Stream.isReadable = streamIsReadable;
  Stream.isWritable = streamIsWritable;
  Stream.Readable = Readable;
  Stream.Writable = Writable;
  Stream.Duplex = Duplex;
  Stream.Transform = Transform;
  Stream.PassThrough = PassThrough;
  Stream.duplexPair = duplexPair;
  Stream.pipeline = pipeline;
  Stream.addAbortSignal = addAbortSignal;
  Stream.finished = finished;
  /*
   * The four a host's stream module exports beside these and this one did not: 'destroy' is the
   * destroy a caller hands a stream -- an aborted signal's handler gives it one -- and the three
   * underscore helpers are what Node's own consumers of bytes ask for, so a package that reads
   * 'require('stream')._isUint8Array' to classify a chunk found undefined here and went to a branch
   * a host never takes.
   */
  Stream.destroy = function (stream, err) {
    if (!stream || streamIsDestroyed(stream)) return;
    if (typeof stream.destroy !== 'function') return;
    stream.destroy(err);
  };
  Stream.compose = compose;
  Stream.setDefaultHighWaterMark = setDefaultHighWaterMark;
  Stream.getDefaultHighWaterMark = getDefaultHighWaterMark;
  Stream.promises = streamPromises;
  Stream.Stream = Stream;
  Stream._isArrayBufferView = function (value) { return ArrayBuffer.isView(value); };
  Stream._isUint8Array = function (value) { return value instanceof Uint8Array; };
  Stream._uint8ArrayToBuffer = function (chunk) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  };

  // ---------------------------------------------------------------- readline

  function writeOutput(self, text) {
    if (self.output !== null && self.output !== undefined) self.output.write(text);
  }

  /* The history holds the lines the interface has read, most recent first, as Node's does: an empty
     line is not remembered, and a historySize of 0 remembers nothing. */
  function addHistory(self, line) {
    if (line.length === 0 || self.historySize === 0) return;
    var h = self[kRlState].history;
    if (h.length === 0 || h[0] !== line) {
      h.unshift(line);
      if (h.length > self.historySize) h.pop();
    }
  }

  /* A finished line goes to the question waiting for one, or to the 'line' event. */
  function dispatchLine(self, line) {
    var st = self[kRlState];
    if (st.questionCallback !== null && st.questionCallback !== undefined) {
      var answer = st.questionCallback;
      st.questionCallback = null;
      self.setPrompt(st.oldPrompt);
      answer(line);
    } else {
      self.emit('line', line);
    }
  }

  /* Node records history on the terminal path only: _line() remembers the line it finished, while a
     non-terminal interface hands each line straight to _onLine and leaves rl.history empty. */
  function deliverLine(self, line) {
    if (self.terminal) addHistory(self, line);
    if (self.historyIndex !== undefined) self.historyIndex = -1;
    dispatchLine(self, line);
  }

  /* A terminal interface answers the two control keys that end or interrupt a line the way Node's
     does: Ctrl-D on an empty line is end of file and closes the interface, and Ctrl-C raises
     SIGINT. Both are plain characters to a non-terminal interface, which only splits on newlines.
     The filter answers null once it has closed the interface, so nothing more is written to it. */
  function stripTerminalControls(self, text) {
    var st = self[kRlState];
    var out = '';
    var pending = st.lineBuffer.length;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '\x03') {
        self.emit('SIGINT');
        continue;
      }
      if (ch === '\x04') {
        if (pending === 0) {
          st.lineBuffer = '';
          self.close();
          return null;
        }
        continue;
      }
      if (ch === '\n' || ch === '\r') pending = 0;
      else pending++;
      out += ch;
    }
    return out;
  }

  /* The longest common prefix of the hits a completer answers: the text a completion takes. */
  function commonPrefixOf(hits) {
    var prefix = String(hits[0]);
    for (var i = 1; i < hits.length; i++) {
      var other = String(hits[i]);
      var at = 0;
      while (at < prefix.length && at < other.length && prefix.charAt(at) === other.charAt(at)) at++;
      prefix = prefix.slice(0, at);
    }
    return prefix;
  }

  /* One tab, as Node answers it: the completer is asked for the line typed so far and the hits it
     answers are reduced to their longest common prefix, which the line takes when it is longer than
     the text the completer completed on. A completer that answers by returning is used at once; one
     that answers through its callback is used when it calls. */
  function completeOnce(self, line) {
    var taken = line;
    var once = false;
    function take(value) {
      if (once) return;
      once = true;
      var hits = Array.isArray(value) ? value[0] : null;
      if (hits === null || hits === undefined || hits.length === 0) return;
      var on = typeof value[1] === 'string' ? value[1] : line;
      var prefix = commonPrefixOf(hits);
      if (prefix.length > on.length) taken = prefix;
    }
    var direct = self.completer(line, function (err, value) { if (!err) take(value); });
    if (direct !== undefined && direct !== null) take(direct);
    return taken;
  }

  function completeTabs(self, base, chunk, echo) {
    var out = base;
    for (var i = 0; i < chunk.length; i++) {
      var ch = chunk.charAt(i);
      if (ch === '\t' && typeof self.completer === 'function') {
        var completed = completeOnce(self, out);
        if (completed !== out) echo(completed.slice(out.length));
        out = completed;
        continue;
      }
      out += ch;
      /* The characters that join the line are echoed; the keys that end it are not. */
      if (ch !== '\n' && ch !== '\r') echo(ch);
    }
    return out;
  }

  function normalWrite(self, b, key) {
    if (b === undefined || b === null) return;
    var st = self[kRlState];
    var text = st.decoder.write(b);
    if (self.terminal) {
      text = stripTerminalControls(self, text);
      if (text === null) return;
    }
    if (st.sawReturnAt !== 0 && Date.now() - st.sawReturnAt <= self.crlfDelay) {
      if (text.charCodeAt(0) === 10) text = text.slice(1);
      st.sawReturnAt = 0;
    }
    /* Only a real tab *key* completes: a plain write() inserts the text it was given whole, tab
       included, so rl.write('a\\t') leaves the line as 'a\\t' and never calls the completer. */
    var completing = self.terminal && !!key && key.name === 'tab' && typeof self.completer === 'function';
    if (self.terminal && completing) {
      /* A terminal interface echoes the line as it is built, as Node's does: the characters typed
         and then the text a completion adds. A non-terminal one writes nothing. */
      text = completeTabs(self, st.lineBuffer, text, function (piece) { writeOutput(self, piece); });
      st.lineBuffer = '';
    } else {
      text = st.lineBuffer + text;
      st.lineBuffer = '';
    }
    var pattern = /\r?\n|\r(?!\n)/g;
    var start = 0;
    var match;
    while ((match = pattern.exec(text)) !== null) {
      var done = text.slice(start, match.index);
      if (self.terminal && !completing && done.length > 0) writeOutput(self, done);
      deliverLine(self, done);
      /* Node ends each line a terminal interface finishes with a newline on the output. */
      if (self.terminal && !completing) writeOutput(self, '\r\n');
      start = pattern.lastIndex;
    }
    var tail = text.slice(start);
    /* Node inserts whatever follows the last line ending even when that is the empty string, so a
       terminal write that ends a line also writes one empty chunk after the newline. */
    if (self.terminal && !completing && text.length > 0) writeOutput(self, tail);
    st.lineBuffer = tail;
    if (text.length > 0 && text.charCodeAt(text.length - 1) === 13) st.sawReturnAt = Date.now();
    /* A terminal interface keeps the line it is reading on the interface, as Node's does: rl.line is
       the text typed so far and rl.cursor the column inside it. A non-terminal one only splits on
       newlines and leaves both alone. */
    if (self.terminal) {
      self.line = st.lineBuffer;
      self.cursor = st.lineBuffer.length;
    }
  }

  function createLineIterator(self) {
    var queue = [];
    var waiting = [];
    var finishedLines = self.closed === true;

    function onLine(line) {
      if (waiting.length > 0) waiting.shift()({ value: line, done: false });
      else queue.push(line);
    }
    function onClose() {
      finishedLines = true;
      offListener(self, 'line', onLine);
      while (waiting.length > 0) waiting.shift()({ value: undefined, done: true });
    }
    self.on('line', onLine);
    self.once('close', onClose);

    return {
      next: function () {
        if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
        if (finishedLines) return Promise.resolve({ value: undefined, done: true });
        return new Promise(function (resolve) {
          waiting.push(resolve);
        });
      },
      return: function () {
        if (!finishedLines) onClose();
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]: function () {
        return this;
      }
    };
  }

  /* Node's HistoryManager (internal/repl/history.js, whose class is named ReplHistory): it owns the
     array the interface exposes and the index of the line being navigated, both behind prototype
     accessors, so a manager carries no own property of its own. */
  var kHistory = Symbol('owcReplHistory');

  function ReplHistory(iface) {
    this[kHistory] = { iface: iface, index: -1, flushing: false, size: iface ? iface.historySize : 30, history: iface ? iface.history : [] };
  }
  ReplHistory.prototype.initialize = function (history) {
    var bag = this[kHistory];
    bag.history = Array.isArray(history) ? history : [];
    bag.index = -1;
  };
  ReplHistory.prototype.addHistory = function () {
    var bag = this[kHistory];
    var line = bag.iface.line === undefined ? '' : bag.iface.line;
    if (line.length === 0 || bag.size === 0) return line;
    if (bag.history.length === 0 || bag.history[0] !== line) {
      bag.history.unshift(line);
      while (bag.history.length > bag.size) bag.history.pop();
    }
    bag.index = -1;
    return line;
  };
  ReplHistory.prototype.canNavigateToNext = function () {
    return this[kHistory].index > -1;
  };
  ReplHistory.prototype.navigateToNext = function () {
    var bag = this[kHistory];
    if (bag.index === -1) return '';
    bag.index--;
    return bag.index === -1 ? '' : bag.history[bag.index];
  };
  ReplHistory.prototype.canNavigateToPrevious = function () {
    var bag = this[kHistory];
    return bag.index < bag.history.length - 1;
  };
  ReplHistory.prototype.navigateToPrevious = function () {
    var bag = this[kHistory];
    bag.index++;
    return bag.history[bag.index];
  };
  Object.defineProperty(ReplHistory.prototype, 'size', {
    get: function () { return this[kHistory].size; },
    set: function (value) { this[kHistory].size = value; },
    configurable: true
  });
  Object.defineProperty(ReplHistory.prototype, 'isFlushing', {
    get: function () { return this[kHistory].flushing; },
    set: function (value) { this[kHistory].flushing = !!value; },
    configurable: true
  });
  Object.defineProperty(ReplHistory.prototype, 'history', {
    get: function () { return this[kHistory].history; },
    set: function (value) { this[kHistory].history = value; },
    configurable: true
  });
  Object.defineProperty(ReplHistory.prototype, 'index', {
    get: function () { return this[kHistory].index; },
    set: function (value) { this[kHistory].index = value; },
    configurable: true
  });

  /* Node's readline Interface extends an internal base class: the public surface (clearLine, close,
     columns, getCursorPos, getPrompt, pause, prompt, resume, setPrompt, setupHistoryManager, write)
     is own on the base prototype, and the legacy Interface.prototype owns only the private
     _-prefixed members plus question. */
  function OwcRlBase() {}
  Object.setPrototypeOf(OwcRlBase.prototype, EventEmitter.prototype);
  Object.setPrototypeOf(OwcRlBase, EventEmitter);
  Object.defineProperty(OwcRlBase.prototype, 'columns', {
    get: function () { return this.output === null || this.output === undefined ? undefined : this.output.columns; },
    configurable: true
  });
  OwcRlBase.prototype.clearLine = function (dir) {
    var code = dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K';
    writeOutput(this, code);
  };
  OwcRlBase.prototype.setupHistoryManager = function (history, historySize) {
    var manager = new ReplHistory(this);
    if (Array.isArray(history)) manager.initialize(history);
    if (typeof historySize === 'number') manager.size = historySize;
    this.historyManager = manager;
  };

  function Interface(input, output, completer, terminal) {
    var opts = input !== null && typeof input === 'object' && input.input !== undefined
      ? input
      : { input: input, output: output, completer: completer, terminal: terminal };
    EventEmitter.call(this);
    var self = this;
    Object.defineProperty(this, kRlState, {
      value: {
        prompt: opts.prompt !== undefined ? String(opts.prompt) : '> ',
        oldPrompt: undefined,
        questionCallback: null,
        lineBuffer: '',
        sawReturnAt: 0,
        sawKeyPress: false,
        previousKey: null,
        prevRows: 0,
        decoder: createDecoder('utf8'),
        lineIterator: null,
        onData: null,
        onEnd: null,
        /* A history handed in with the options seeds the array the interface reads, as Node's does:
           createInterface({ history: ['x', 'y'] }) leaves rl.history holding those two lines. */
        history: Array.isArray(opts.history) ? opts.history.slice() : []
      },
      enumerable: false,
      writable: true,
      configurable: true
    });
    var st = this[kRlState];
    this.input = opts.input;
    this.output = opts.output;
    this.terminal = opts.terminal !== undefined ? !!opts.terminal : !!(opts.output && opts.output.isTTY);
    this.line = '';
    /* Only a terminal interface gets a cursor: on a non-terminal one rl.cursor is not a key of the
       interface at all, and reading it answers undefined, as on the host. */
    if (this.terminal) this.cursor = 0;
    this.tabSize = opts.tabSize !== undefined ? opts.tabSize : 8;
    this.escapeCodeTimeout = opts.escapeCodeTimeout !== undefined ? opts.escapeCodeTimeout : 500;
    /* Node always sets the completer, so it is a key of the interface whether or not one was given. */
    this.completer = typeof opts.completer === 'function' ? opts.completer : undefined;
    this.historySize = opts.historySize !== undefined ? opts.historySize : 30;
    /* The history is the array a caller reads on the interface, so it is the one the state keeps:
       a line recorded later is seen by a caller who already holds rl.history. */
    this.history = st.history;
    this.crlfDelay = opts.crlfDelay ? Math.max(100, opts.crlfDelay) : 100;
    /* The history manager the interface keeps beside the array: historyIndex mirrors its index. */
    this.historyIndex = -1;
    this.historyManager = new ReplHistory(this);
    this.isCompletionEnabled = true;
    this.isFlushing = false;

    st.onData = function (chunk) {
      normalWrite(self, chunk);
    };
    st.onEnd = function () {
      if (st.lineBuffer.length > 0) self.emit('line', st.lineBuffer);
      st.lineBuffer = '';
      self.close();
    };
    this.once('close', function () {
      offListener(self.input, 'data', st.onData);
      offListener(self.input, 'end', st.onEnd);
    });
    this.input.on('data', st.onData);
    this.input.on('end', st.onEnd);
    // A terminal interface decodes keys, as Node's does: the input stream emits 'keypress' and a
    // caller can read the arrow keys, the function keys and the control characters it sends.
    if (this.terminal) emitKeypressEvents(this.input, this);
    if (typeof this.input.resume === 'function') this.input.resume();
  }
  Object.setPrototypeOf(Interface.prototype, OwcRlBase.prototype);
  Object.setPrototypeOf(Interface, OwcRlBase);

  OwcRlBase.prototype.setPrompt = function (prompt) {
    this[kRlState].prompt = String(prompt);
  };

  OwcRlBase.prototype.getPrompt = function () {
    return this[kRlState].prompt;
  };

  /* getCursorPos answers the column and row the cursor sits on, counted from the start of the
     prompt: the prompt and the text of the line before the cursor give the column, and a line that
     fits the terminal's width, or one whose width is unknown, gives no row. */
  OwcRlBase.prototype.getCursorPos = function () {
    var cols = this[kRlState].prompt.length + (this.cursor === undefined ? 0 : this.cursor);
    var columns = this.output === null || this.output === undefined ? undefined : this.output.columns;
    if (typeof columns === 'number' && columns > 0) return { cols: cols % columns, rows: Math.floor(cols / columns) };
    return { cols: cols, rows: 0 };
  };

  /* A terminal interface redraws the line when it prompts, as Node does: back to the first column,
     clear what is below, the prompt and the line being read, then the cursor where the prompt and
     the column inside the line put it. Node leaves the cursor alone for a caller who asks it to. */
  OwcRlBase.prototype.prompt = function (preserveCursor) {
    if (this.paused) this.resume();
    var st = this[kRlState];
    if (!this.terminal) {
      writeOutput(this, st.prompt);
      return;
    }
    if (!preserveCursor) this.cursor = 0;
    var line = this.line === undefined ? '' : this.line;
    /* Four separate writes, as Node's _refreshLine makes: home, clear below, prompt plus the line
       being read, then the cursor where the prompt and the column inside the line put it. */
    writeOutput(this, '\x1b[1G');
    writeOutput(this, '\x1b[0J');
    writeOutput(this, st.prompt + line);
    var pos = this.getCursorPos();
    writeOutput(this, '\x1b[' + (pos.cols + 1) + 'G');
  };

  Interface.prototype.question = function (query, options, cb) {
    var callback = typeof options === 'function' ? options : cb;
    if (this.closed) throw errUseAfterClose();
    /* Node validates options.signal before it writes the query: a signal that is not an AbortSignal
       is refused, and nothing is prompted. */
    if (options !== null && typeof options === 'object' && options.signal !== undefined) {
      checkSignalProp(options.signal);
    }
    var st = this[kRlState];
    if (st.questionCallback !== null) {
      this.prompt();
    } else {
      st.oldPrompt = st.prompt;
      this.setPrompt(query);
      st.questionCallback = typeof callback === 'function' ? callback : null;
      this.prompt();
    }
  };

  /*
   * The private members Node's lib/readline.js declares on Interface.prototype. They are the line
   * editor behind a terminal interface; on the non-terminal path, which is what an in-browser
   * container runs, only _normalWrite, _onLine, _line, _addHistory, _writeToOutput and the
   * accessors carry behaviour. The eight accessors read and write the interface's own state bag.
   */
  function defineRlAccessor(name, field) {
    Object.defineProperty(Interface.prototype, name, {
      get: function () { return this[kRlState][field]; },
      set: function (value) { this[kRlState][field] = value; },
      enumerable: false,
      configurable: true
    });
  }
  defineRlAccessor('_decoder', 'decoder');
  defineRlAccessor('_line_buffer', 'lineBuffer');
  defineRlAccessor('_oldPrompt', 'oldPrompt');
  defineRlAccessor('_previousKey', 'previousKey');
  defineRlAccessor('_prompt', 'prompt');
  defineRlAccessor('_questionCallback', 'questionCallback');
  defineRlAccessor('_sawKeyPress', 'sawKeyPress');
  defineRlAccessor('_sawReturnAt', 'sawReturnAt');

  Interface.prototype._writeToOutput = function (stringToWrite) {
    if (typeof stringToWrite !== 'string') throw argTypeError('stringToWrite', 'of type string', stringToWrite);
    writeOutput(this, stringToWrite);
  };

  Interface.prototype._setRawMode = function (mode) {
    var wasInRawMode = this.input.isRaw;
    if (typeof this.input.setRawMode === 'function') this.input.setRawMode(mode);
    return wasInRawMode;
  };

  Interface.prototype._getCursorPos = OwcRlBase.prototype.getCursorPos;

  /* The column and row a string ends on, counted with the terminal's width: the escape sequences a
     prompt carries are not columns, a newline always costs a row, and a surrogate pair is one. */
  Interface.prototype._getDisplayPos = function (str) {
    var text = typeof str === 'string' ? str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') : '';
    var col = this.columns;
    if (typeof col !== 'number' || col <= 0) col = Infinity;
    var offset = 0;
    var rows = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '\n') {
        rows += Math.ceil(offset / col) || 1;
        offset = 0;
        continue;
      }
      var code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) i++;
      offset++;
      if (offset >= col) {
        rows++;
        offset = 0;
      }
    }
    return { cols: offset, rows: rows };
  };

  function rlCursor(self) {
    if (self.cursor === undefined || self.cursor === null) self.cursor = 0;
    return self.cursor;
  }
  function rlLine(self) {
    if (self.line === undefined || self.line === null) self.line = '';
    return self.line;
  }

  Interface.prototype._insertString = function (c) {
    var line = rlLine(this);
    var at = rlCursor(this);
    if (at < line.length) this.line = line.slice(0, at) + c + line.slice(at);
    else this.line = line + c;
    this.cursor = at + c.length;
    if (this.terminal) this._refreshLine();
  };

  /* A character left of the cursor is one UTF-16 unit, or two when it is half of a surrogate pair. */
  function charSizeLeft(line, at) {
    if (at <= 1) return 1;
    var code = line.charCodeAt(at - 1);
    if (code >= 0xdc00 && code <= 0xdfff) {
      var lead = line.charCodeAt(at - 2);
      if (lead >= 0xd800 && lead <= 0xdbff) return 2;
    }
    return 1;
  }
  function charSizeAt(line, at) {
    var code = line.charCodeAt(at);
    if (code >= 0xd800 && code <= 0xdbff && at + 1 < line.length) return 2;
    return 1;
  }

  Interface.prototype._deleteLeft = function () {
    var line = rlLine(this);
    var at = rlCursor(this);
    if (at <= 0 || line.length === 0) return;
    var size = charSizeLeft(line, at);
    this.line = line.slice(0, at - size) + line.slice(at);
    this.cursor = at - size;
    if (this.terminal) this._refreshLine();
  };

  Interface.prototype._deleteRight = function () {
    var line = rlLine(this);
    var at = rlCursor(this);
    if (at >= line.length) return;
    var size = charSizeAt(line, at);
    this.line = line.slice(0, at) + line.slice(at + size);
    if (this.terminal) this._refreshLine();
  };

  Interface.prototype._deleteLineLeft = function () {
    var line = rlLine(this);
    var at = rlCursor(this);
    this.line = line.slice(at);
    this.cursor = 0;
    if (this.terminal) this._refreshLine();
  };

  Interface.prototype._deleteLineRight = function () {
    var line = rlLine(this);
    var at = rlCursor(this);
    this.line = line.slice(0, at);
    if (this.terminal) this._refreshLine();
  };

  var WORD_LEFT = /^\s*(?:[^\w\s]+|\w+)?/;
  var WORD_RIGHT = /^(?:\s+|[^\w\s]+|\w+)\s*/;

  Interface.prototype._wordLeft = function () {
    var line = rlLine(this);
    var at = rlCursor(this);
    if (at <= 0) return;
    var leading = line.slice(0, at);
    var match = WORD_LEFT.exec(leading);
    var take = match === null ? 1 : match[0].length;
    this.cursor = at - take;
    if (this.terminal) this._refreshLine();
  };

  Interface.prototype._wordRight = function () {
    var line = rlLine(this);
    var at = rlCursor(this);
    if (at >= line.length) return;
    var match = WORD_RIGHT.exec(line.slice(at));
    if (match === null) return;
    this.cursor = at + match[0].length;
    if (this.terminal) this._refreshLine();
  };

  Interface.prototype._deleteWordLeft = function () {
    var line = rlLine(this);
    var at = rlCursor(this);
    if (at <= 0) return;
    var leading = line.slice(0, at);
    var match = WORD_LEFT.exec(leading);
    var take = match === null ? 1 : match[0].length;
    this.line = leading.slice(0, leading.length - take) + line.slice(at);
    this.cursor = at - take;
    if (this.terminal) this._refreshLine();
  };

  Interface.prototype._deleteWordRight = function () {
    var line = rlLine(this);
    var at = rlCursor(this);
    if (at >= line.length) return;
    var trailing = line.slice(at);
    var match = WORD_RIGHT.exec(trailing);
    if (match === null) return;
    this.line = line.slice(0, at) + trailing.slice(match[0].length);
    if (this.terminal) this._refreshLine();
  };

  Interface.prototype._moveCursor = function (dx) {
    if (dx === 0) return;
    var at = rlCursor(this) + dx;
    var line = rlLine(this);
    if (at < 0) at = 0;
    else if (at > line.length) at = line.length;
    this.cursor = at;
    if (this.terminal) this._refreshLine();
  };

  /* The line, redrawn: back to the first column, clear what is below, write the prompt and the line,
     then put the cursor where the prompt and the column inside the line put it. */
  Interface.prototype._refreshLine = function () {
    if (!this.terminal) return;
    var st = this[kRlState];
    var line = st.prompt + rlLine(this);
    var dispPos = this._getDisplayPos(line);
    if (st.prevRows > 0) moveCursor(this.output, 0, -st.prevRows);
    cursorTo(this.output, 0);
    clearScreenDown(this.output);
    writeOutput(this, line);
    var cursorPos = this.getCursorPos();
    if (dispPos.rows > cursorPos.rows) moveCursor(this.output, 0, -(dispPos.rows - cursorPos.rows));
    cursorTo(this.output, cursorPos.cols);
    st.prevRows = dispPos.rows;
    st.prevCols = dispPos.cols;
  };

  Interface.prototype._addHistory = function () {
    var line = rlLine(this);
    addHistory(this, line);
    if (this.historyIndex !== undefined) this.historyIndex = -1;
    return line;
  };

  Interface.prototype._historyNext = function () {
    var mgr = this.historyManager;
    if (mgr !== undefined && mgr !== null) {
      if (!mgr.canNavigateToNext()) return;
      this.line = mgr.navigateToNext();
      this.historyIndex = mgr.index;
    } else {
      if (this.historyIndex <= 0) {
        this.historyIndex = -1;
        this.line = '';
      } else {
        this.historyIndex--;
        this.line = this.history[this.historyIndex];
      }
    }
    this.cursor = rlLine(this).length;
    if (this.terminal) this._refreshLine();
  };

  Interface.prototype._historyPrev = function () {
    var mgr = this.historyManager;
    if (mgr !== undefined && mgr !== null) {
      if (!mgr.canNavigateToPrevious()) return;
      this.line = mgr.navigateToPrevious();
      this.historyIndex = mgr.index;
    } else {
      if (this.historyIndex + 1 >= this.history.length) return;
      this.historyIndex++;
      this.line = this.history[this.historyIndex];
    }
    this.cursor = rlLine(this).length;
    if (this.terminal) this._refreshLine();
  };

  /* The line is finished: it is remembered, the edit buffer is cleared and it is handed to whatever
     is waiting for it, a question's callback or the 'line' event. */
  Interface.prototype._line = function () {
    var line = this._addHistory();
    this.line = '';
    this.cursor = 0;
    if (this.terminal) this.clearLine();
    this._onLine(line);
  };

  Interface.prototype._onLine = function (line) {
    dispatchLine(this, line);
  };

  Interface.prototype._normalWrite = function (b) {
    normalWrite(this, b);
  };

  Interface.prototype._tabComplete = function (lastKeypressWasTab) {
    if (typeof this.completer !== 'function') return;
    var self = this;
    var string = rlLine(this).slice(0, rlCursor(this));
    this.pause();
    this.completer(string, function (err, value) {
      self.resume();
      if (err) {
        self._writeToOutput('Tab completion error: ' + String(err));
        return;
      }
      var hits = Array.isArray(value) ? value[0] : null;
      if (hits === null || hits === undefined || hits.length === 0) {
        if (lastKeypressWasTab === true) self._writeToOutput('\x07');
        return;
      }
      var on = typeof value[1] === 'string' ? value[1] : string;
      var prefix = commonPrefixOf(hits);
      if (prefix.length > on.length) self._insertString(prefix.slice(on.length));
      else if (lastKeypressWasTab === true && hits.length > 1) self._writeToOutput('\r\n' + hits.join('  ') + '\r\n');
    });
  };

  /* One keypress, decoded: the keys that end a line, the keys that edit it, the history keys and the
     two control keys. Anything else is text and joins the line. */
  Interface.prototype._ttyWrite = function (s, key) {
    var st = this[kRlState];
    var previousKey = st.previousKey;
    st.previousKey = key === undefined || key === null ? {} : key;
    if (s === undefined || s === null) return;
    var name = key !== undefined && key !== null && typeof key.name === 'string' ? key.name : '';
    var ctrl = key !== undefined && key !== null ? !!key.ctrl : false;
    var meta = key !== undefined && key !== null ? !!key.meta : false;
    if (name === 'return' || name === 'enter' || s === '\r' || s === '\n') {
      this._line();
      return;
    }
    if (meta && name === 'y') return;
    if (ctrl && name === 'c') {
      this.emit('SIGINT');
      return;
    }
    if (ctrl && name === 'd') {
      if (rlLine(this).length === 0) this.close();
      else this._deleteRight();
      return;
    }
    if (name === 'backspace') {
      this._deleteLeft();
      return;
    }
    if (name === 'delete') {
      this._deleteRight();
      return;
    }
    if (name === 'tab') {
      this._tabComplete(previousKey !== null && previousKey !== undefined && previousKey.name === 'tab');
      return;
    }
    if (name === 'up' || (ctrl && name === 'p')) {
      this._historyPrev();
      return;
    }
    if (name === 'down' || (ctrl && name === 'n')) {
      this._historyNext();
      return;
    }
    if (name === 'left' || (ctrl && name === 'b')) {
      this._moveCursor(-1);
      return;
    }
    if (name === 'right' || (ctrl && name === 'f')) {
      this._moveCursor(1);
      return;
    }
    if (name === 'home' || (ctrl && name === 'a')) {
      this.cursor = 0;
      if (this.terminal) this._refreshLine();
      return;
    }
    if (name === 'end' || (ctrl && name === 'e')) {
      this.cursor = rlLine(this).length;
      if (this.terminal) this._refreshLine();
      return;
    }
    if (ctrl && name === 'u') {
      this._deleteLineLeft();
      return;
    }
    if (ctrl && name === 'k') {
      this._deleteLineRight();
      return;
    }
    if (ctrl && name === 'w') {
      this._deleteWordLeft();
      return;
    }
    if (s.length > 0) this._insertString(s);
  };

  OwcRlBase.prototype.write = function (data, key) {
    if (this.closed) throw errUseAfterClose();
    if (this.paused) this.resume();
    normalWrite(this, data, key);
  };

  OwcRlBase.prototype.pause = function () {
    if (this.paused) return this;
    this.input.pause();
    this.paused = true;
    this.emit('pause');
    return this;
  };

  OwcRlBase.prototype.resume = function () {
    if (!this.paused) return this;
    this.input.resume();
    this.paused = false;
    this.emit('resume');
    return this;
  };

  OwcRlBase.prototype.close = function () {
    if (this.closed) return;
    this.pause();
    this.closed = true;
    this.emit('close');
  };

  Interface.prototype[Symbol.asyncIterator] = function () {
    var st = this[kRlState];
    if (st.lineIterator === null) st.lineIterator = createLineIterator(this);
    return st.lineIterator;
  };

  function writeEscape(stream, data, callback) {
    if (stream === null || stream === undefined) {
      if (typeof callback === 'function') process.nextTick(callback, null);
      return true;
    }
    return stream.write(data, callback);
  }

  function clearLine(stream, dir, callback) {
    var code = dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K';
    return writeEscape(stream, code, callback);
  }

  function clearScreenDown(stream, callback) {
    return writeEscape(stream, '\x1b[0J', callback);
  }

  function cursorTo(stream, x, y, callback) {
    if (typeof y === 'function') {
      callback = y;
      y = undefined;
    }
    if (typeof x !== 'number') throw argTypeError('x', 'of type number', x);
    var code = typeof y !== 'number' ? '\x1b[' + (x + 1) + 'G' : '\x1b[' + (y + 1) + ';' + (x + 1) + 'H';
    return writeEscape(stream, code, callback);
  }

  function moveCursor(stream, dx, dy, callback) {
    var data = '';
    if (dx < 0) data += '\x1b[' + (-dx) + 'D';
    else if (dx > 0) data += '\x1b[' + dx + 'C';
    if (dy < 0) data += '\x1b[' + (-dy) + 'A';
    else if (dy > 0) data += '\x1b[' + dy + 'B';
    return writeEscape(stream, data, callback);
  }

  /*
   * readline.emitKeypressEvents(stream, iface): the stream emits 'keypress' for every key its
   * input carries, with the character and the key record { name, ctrl, meta, shift, sequence,
   * code }, decoded the way Node decodes the bytes a terminal sends. Bytes are decoded as UTF-8
   * as they arrive and an escape sequence split across chunks is held until it is complete, so a
   * key is reported once, in order, with the whole sequence it was written with. A lone escape is
   * not a key: it starts a sequence, as it does in Node.
   */
  var KEY_NAMES = { '\r': 'return', '\n': 'enter', '\t': 'tab', '\b': 'backspace', '\u007f': 'backspace', ' ': 'space' };
  var CSI_LETTERS = { A: 'up', B: 'down', C: 'right', D: 'left', E: 'clear', F: 'end', H: 'home', Z: 'tab' };
  var CSI_TILDES = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home',
    8: 'end', 11: 'f1', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12', 200: 'paste-start' };
  var SS3_LETTERS = { P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };
  var CSI_KEY = /^\x1b+\[([0-9]*)(?:;([0-9]+))?([a-zA-Z~])$/;
  var SS3_KEY = /^\x1b+O([PQRS])$/;
  var META_KEY = /^\x1b([a-zA-Z0-9])$/;

  function keypressName(ch) {
    if (KEY_NAMES[ch] !== undefined) return { name: KEY_NAMES[ch], ctrl: false, shift: false };
    var code = ch.charCodeAt(0);
    if (code < 32) return { name: String.fromCharCode(code + 96), ctrl: true, shift: false };
    if (code >= 65 && code <= 90) return { name: ch.toLowerCase(), ctrl: false, shift: true };
    return { name: ch, ctrl: false, shift: false };
  }

  /* The parameter after the first is the modifier: 1 none, and one bit each for shift, alt and control. */
  function keypressModifiers(param) {
    var bits = (param === undefined ? 1 : Number(param)) - 1;
    return { shift: (bits & 1) !== 0, meta: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
  }

  function keypressOf(text) {
    if (text === '\x1b') return undefined;
    if (text.charAt(0) !== '\x1b') {
      var plain = keypressName(text);
      return { str: text, key: { name: plain.name, ctrl: plain.ctrl, meta: false, shift: plain.shift, sequence: text } };
    }
    var csi = CSI_KEY.exec(text);
    if (csi !== null) {
      var body = csi[1];
      var last = csi[3];
      var mods = keypressModifiers(csi[2]);
      var name = CSI_TILDES[Number(body)];
      var code = '[' + (last === '~' ? body + '~' : last);
      if (last !== '~') {
        name = CSI_LETTERS[last];
        if (last === 'Z') mods.shift = true;
      }
      return { str: undefined, key: { name: name === undefined ? 'undefined' : name, ctrl: mods.ctrl, meta: mods.meta, shift: mods.shift, sequence: text, code: code } };
    }
    var ss3 = SS3_KEY.exec(text);
    if (ss3 !== null) {
      return { str: undefined, key: { name: SS3_LETTERS[ss3[1]], ctrl: false, meta: false, shift: false, sequence: text, code: 'O' + ss3[1] } };
    }
    // O and [ open a longer sequence, so an escape followed by one of them is not a key yet
    if (text.length === 2 && (text.charAt(1) === '[' || text.charAt(1) === 'O')) return undefined;
    var meta = META_KEY.exec(text);
    if (meta !== null) {
      var named = keypressName(meta[1]);
      return { str: undefined, key: { name: named.name, ctrl: named.ctrl, meta: true, shift: named.shift, sequence: text } };
    }
    return undefined;
  }

  var keypressStreams = new WeakMap();

  function emitKeypressEvents(stream, iface) {
    if (stream === null || stream === undefined || typeof stream.on !== 'function') return;
    if (keypressStreams.has(stream)) return;
    keypressStreams.set(stream, { iface: iface === undefined ? null : iface });
    var decoder = createDecoder('utf8');
    var pending = '';
    stream.on('data', function (chunk) {
      var text = decoder.write(chunk);
      for (var i = 0; i < text.length; i++) {
        pending += text.charAt(i);
        var press = keypressOf(pending);
        if (press === undefined) continue;
        stream.emit('keypress', press.str, press.key);
        pending = '';
      }
    });
  }

  var readlineExports = {
    Interface: Interface,
    createInterface: function (input, output, completer, terminal) {
      return new Interface(input, output, completer, terminal);
    },
    clearLine: clearLine,
    clearScreenDown: clearScreenDown,
    cursorTo: cursorTo,
    moveCursor: moveCursor,
    emitKeypressEvents: emitKeypressEvents
  };

  function PromisesInterface(input, output, completer, terminal) {
    Interface.call(this, input, output, completer, terminal);
  }
  Object.setPrototypeOf(PromisesInterface.prototype, Interface.prototype);
  Object.setPrototypeOf(PromisesInterface, Interface);
  PromisesInterface.prototype.question = function (query, options) {
    var self = this;
    return new Promise(function (resolve) {
      Interface.prototype.question.call(self, query, options, resolve);
    });
  };

  /* readline/promises exports a second class of its own, Readline: a cursor-control writer over one
     stream. Each call queues its escape sequence and answers the instance, so the calls chain; the
     queue reaches the stream only on commit(), which answers a promise, or on the next tick when the
     instance was built with autoCommit. rollback() throws the queue away. It is not the Interface:
     the two are unrelated classes that readline/promises exports side by side. */
  function isWritableStreamLike(value) {
    if (!value || typeof value !== 'object') return false;
    if (value._writableState !== undefined) return true;
    return typeof value.write === 'function' && typeof value.end === 'function';
  }
  function validateCursorInt(value, name) {
    if (typeof value !== 'number') throw argTypeError(name, 'of type number', value);
    if (value !== Math.floor(value)) throw owcErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "' + name + '" is out of range. It must be an integer. Received ' + value);
    return value;
  }
  function validateCursorRange(value, name, min, max) {
    validateCursorInt(value, name);
    if (value < min || value > max) {
      throw owcErr(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "' + name + '" is out of range. It must be >= ' + min + ' && <= ' + max + '. Received ' + value);
    }
    return value;
  }

  var readlineWriters = new WeakMap();

  function ReadlineWriter(stream, options) {
    /* Node's Readline is a class, so calling it without new is a TypeError, not a construction. */
    if (!(this instanceof ReadlineWriter)) throw new TypeError("Class constructor Readline cannot be invoked without 'new'");
    if (!isWritableStreamLike(stream)) throw argTypeError('stream', 'an instance of Writable', stream);
    readlineWriters.set(this, {
      stream: stream,
      autoCommit: !!(options && options.autoCommit === true),
      todo: []
    });
  }

  function writerSend(self, data) {
    var rec = readlineWriters.get(self);
    if (rec.autoCommit) process.nextTick(function () { rec.stream.write(data); });
    else rec.todo.push(data);
  }

  ReadlineWriter.prototype.cursorTo = function (x, y) {
    validateCursorInt(x, 'x');
    if (y !== null && y !== undefined) validateCursorInt(y, 'y');
    writerSend(this, y === null || y === undefined ? '\x1b[' + (x + 1) + 'G' : '\x1b[' + (y + 1) + ';' + (x + 1) + 'H');
    return this;
  };
  ReadlineWriter.prototype.moveCursor = function (dx, dy) {
    validateCursorInt(dx, 'dx');
    validateCursorInt(dy, 'dy');
    if (!dx && !dy) return this;
    var data = '';
    if (dx < 0) data += '\x1b[' + -dx + 'D';
    else if (dx > 0) data += '\x1b[' + dx + 'C';
    if (dy < 0) data += '\x1b[' + -dy + 'A';
    else if (dy > 0) data += '\x1b[' + dy + 'B';
    writerSend(this, data);
    return this;
  };
  ReadlineWriter.prototype.clearLine = function (dir) {
    validateCursorRange(dir, 'dir', -1, 1);
    writerSend(this, dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K');
    return this;
  };
  ReadlineWriter.prototype.clearScreenDown = function () {
    writerSend(this, '\x1b[0J');
    return this;
  };
  ReadlineWriter.prototype.commit = function () {
    var rec = readlineWriters.get(this);
    var pending = rec.todo.join('');
    rec.todo = [];
    return new Promise(function (resolve) {
      rec.stream.write(pending, resolve);
    });
  };
  ReadlineWriter.prototype.rollback = function () {
    readlineWriters.get(this).todo = [];
    return this;
  };

  // readline/promises exports the Interface and the Readline writer side by side, as Node 24 does.
  var readlinePromisesExports = {
    Interface: PromisesInterface,
    Readline: ReadlineWriter,
    createInterface: function (input, output, completer, terminal) {
      return new PromisesInterface(input, output, completer, terminal);
    }
  };

  readlineExports.promises = readlinePromisesExports;

  /*
   * stream/consumers: the six ways Node reads a stream whole. Each one drains the stream with a
   * for-await over it, which is what lets a Node readable, a Web stream and a bare async iterable
   * be read the same way, and the four that answer in bytes are built on blob(), whose chunks keep
   * the type each one was written with -- a string, a Buffer or a view.
   */
  function consumersBlob(stream) {
    return (async function () {
      var chunks = [];
      for await (var chunk of stream) chunks.push(chunk);
      return new Blob(chunks);
    })();
  }

  function consumersArrayBuffer(stream) {
    return consumersBlob(stream).then(function (blob) { return blob.arrayBuffer(); });
  }

  /* A chunk that is already a string is appended as it stands; one that is bytes goes through a
     decoder kept across the whole stream, so a character split over two chunks is one character,
     and whatever the decoder still holds is flushed once the stream is out. */
  function consumersText(stream) {
    return (async function () {
      var decoder = new TextDecoder();
      var text = '';
      for await (var chunk of stream) {
        if (typeof chunk === 'string') text += chunk;
        else text += decoder.decode(chunk, { stream: true });
      }
      return text + decoder.decode();
    })();
  }

  function consumersBuffer(stream) {
    return consumersArrayBuffer(stream).then(function (bytes) { return Buf.from(bytes); });
  }

  function consumersBytes(stream) {
    return consumersArrayBuffer(stream).then(function (bytes) { return new Uint8Array(bytes); });
  }

  function consumersJson(stream) {
    return consumersText(stream).then(function (text) { return JSON.parse(text); });
  }

  /* The six are the whole of the module's own exports, and the default export is the six and
     nothing else -- which is what the module's default is already made of, so no 'default' key of
     its own belongs here: a namespace that carried one inside another is one Node does not have. */
  var streamConsumersExports = {
    arrayBuffer: consumersArrayBuffer,
    blob: consumersBlob,
    buffer: consumersBuffer,
    bytes: consumersBytes,
    text: consumersText,
    json: consumersJson
  };

  return {
    stream: Stream,
    streamPromises: streamPromises,
    streamConsumers: streamConsumersExports,
    readline: readlineExports,
    readlinePromises: readlinePromisesExports
  };
}
`;
