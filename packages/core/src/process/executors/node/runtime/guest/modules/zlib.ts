/**
 * Guest-side `zlib` built-in for the in-browser Node runtime. Sync, callback and stream forms share
 * the host's zlib capabilities: the zlib Node bundles, compiled to wasm, for the deflate family's
 * compression -- no JavaScript deflate is that zlib's output -- fflate for its raw DEFLATE on the way
 * back in, and wasm codecs for brotli and zstd, which have no JavaScript implementation worth their
 * size. Plain JavaScript inside a String.raw snippet: no backticks
 * and no template interpolation.
 */
export const SRC = String.raw`
BF['zlib'] = function () {
  var Buf = requireBuiltin('buffer').Buffer;
  var SYNC_INPUT = 'of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer';
  var CHUNK_INPUT = 'of type string or an instance of Buffer, TypedArray, or DataView';

  var CONSTANTS = {
    Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5,
    Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3,
    Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
    Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
    Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
    ZLIB_VERNUM: 4880, DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6,
    UNZIP: 7, BROTLI_DECODE: 8, BROTLI_ENCODE: 9, ZSTD_DECOMPRESS: 11, ZSTD_COMPRESS: 10,
    Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15, Z_MIN_CHUNK: 64,
    Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9,
    Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
    BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2,
    BROTLI_OPERATION_EMIT_METADATA: 3, BROTLI_PARAM_MODE: 0, BROTLI_MODE_GENERIC: 0,
    BROTLI_MODE_TEXT: 1, BROTLI_MODE_FONT: 2, BROTLI_DEFAULT_MODE: 0, BROTLI_PARAM_QUALITY: 1,
    BROTLI_MIN_QUALITY: 0, BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11, BROTLI_PARAM_LGWIN: 2,
    BROTLI_MIN_WINDOW_BITS: 10, BROTLI_MAX_WINDOW_BITS: 24, BROTLI_LARGE_MAX_WINDOW_BITS: 30,
    BROTLI_DEFAULT_WINDOW: 22, BROTLI_PARAM_LGBLOCK: 3, BROTLI_MIN_INPUT_BLOCK_BITS: 16,
    BROTLI_MAX_INPUT_BLOCK_BITS: 24, BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
    BROTLI_PARAM_SIZE_HINT: 5, BROTLI_PARAM_LARGE_WINDOW: 6, BROTLI_PARAM_NPOSTFIX: 7,
    BROTLI_PARAM_NDIRECT: 8, BROTLI_DECODER_RESULT_ERROR: 0, BROTLI_DECODER_RESULT_SUCCESS: 1,
    BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2, BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
    BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0, BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
    BROTLI_DECODER_NO_ERROR: 0, BROTLI_DECODER_SUCCESS: 1, BROTLI_DECODER_NEEDS_MORE_INPUT: 2,
    BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3, BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1,
    BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2, BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3,
    BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4, BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5,
    BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6, BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7,
    BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8, BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9,
    BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10, BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11,
    BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12, BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13,
    BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14, BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15,
    BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16, BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19,
    BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20, BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21,
    BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22, BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25,
    BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26, BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27,
    BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30, BROTLI_DECODER_ERROR_UNREACHABLE: -31,
    ZSTD_e_continue: 0, ZSTD_e_flush: 1, ZSTD_e_end: 2, ZSTD_fast: 1, ZSTD_dfast: 2, ZSTD_greedy: 3,
    ZSTD_lazy: 4, ZSTD_lazy2: 5, ZSTD_btlazy2: 6, ZSTD_btopt: 7, ZSTD_btultra: 8, ZSTD_btultra2: 9,
    ZSTD_c_compressionLevel: 100, ZSTD_c_windowLog: 101, ZSTD_c_hashLog: 102, ZSTD_c_chainLog: 103,
    ZSTD_c_searchLog: 104, ZSTD_c_minMatch: 105, ZSTD_c_targetLength: 106, ZSTD_c_strategy: 107,
    ZSTD_c_enableLongDistanceMatching: 160, ZSTD_c_ldmHashLog: 161, ZSTD_c_ldmMinMatch: 162,
    ZSTD_c_ldmBucketSizeLog: 163, ZSTD_c_ldmHashRateLog: 164, ZSTD_c_contentSizeFlag: 200,
    ZSTD_c_checksumFlag: 201, ZSTD_c_dictIDFlag: 202, ZSTD_c_nbWorkers: 400, ZSTD_c_jobSize: 401,
    ZSTD_c_overlapLog: 402, ZSTD_d_windowLogMax: 100, ZSTD_CLEVEL_DEFAULT: 3,
    ZSTD_error_no_error: 0, ZSTD_error_GENERIC: 1, ZSTD_error_prefix_unknown: 10,
    ZSTD_error_version_unsupported: 12, ZSTD_error_frameParameter_unsupported: 14,
    ZSTD_error_frameParameter_windowTooLarge: 16, ZSTD_error_corruption_detected: 20,
    ZSTD_error_checksum_wrong: 22, ZSTD_error_literals_headerWrong: 24, ZSTD_error_dictionary_corrupted: 30,
    ZSTD_error_dictionary_wrong: 32, ZSTD_error_dictionaryCreation_failed: 34,
    ZSTD_error_parameter_unsupported: 40, ZSTD_error_parameter_combination_unsupported: 41,
    ZSTD_error_parameter_outOfBound: 42, ZSTD_error_tableLog_tooLarge: 44,
    ZSTD_error_maxSymbolValue_tooLarge: 46, ZSTD_error_maxSymbolValue_tooSmall: 48,
    ZSTD_error_stabilityCondition_notRespected: 50, ZSTD_error_stage_wrong: 60, ZSTD_error_init_missing: 62,
    ZSTD_error_memory_allocation: 64, ZSTD_error_workSpace_tooSmall: 66, ZSTD_error_dstSize_tooSmall: 70,
    ZSTD_error_srcSize_wrong: 72, ZSTD_error_dstBuffer_null: 74, ZSTD_error_noForwardProgress_destFull: 80,
    ZSTD_error_noForwardProgress_inputEmpty: 82
  };

  var CODE_NAMES = [['Z_OK', 0], ['Z_STREAM_END', 1], ['Z_NEED_DICT', 2], ['Z_ERRNO', -1], ['Z_STREAM_ERROR', -2],
   ['Z_DATA_ERROR', -3], ['Z_MEM_ERROR', -4], ['Z_BUF_ERROR', -5], ['Z_VERSION_ERROR', -6]];
  var CODES = {};
  CODE_NAMES.forEach(function (pair) { CODES[pair[0]] = pair[1]; });
  CODE_NAMES.forEach(function (pair) { if (pair[1] >= 0) CODES[pair[1]] = pair[0]; });
  CODE_NAMES.forEach(function (pair) { if (pair[1] < 0) CODES[pair[1]] = pair[0]; });
  Object.freeze(CODES);

  // Base64 for the host transport. Table driven, so a megabyte moves in well under a second; the
  // codec's indexOf-based versions cost several times more on the same bytes.
  var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_VALUE = new Int16Array(128);
  for (var b64 = 0; b64 < 128; b64++) B64_VALUE[b64] = -1;
  for (var b64i = 0; b64i < 64; b64i++) B64_VALUE[B64_ALPHABET.charCodeAt(b64i)] = b64i;

  function toBase64(bytes) {
    var parts = [];
    var codes = [];
    var n = bytes.length;
    var i = 0;
    for (; i + 2 < n; i += 3) {
      var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      codes.push(B64_ALPHABET.charCodeAt((v >> 18) & 63), B64_ALPHABET.charCodeAt((v >> 12) & 63),
        B64_ALPHABET.charCodeAt((v >> 6) & 63), B64_ALPHABET.charCodeAt(v & 63));
      if (codes.length >= 8192) {
        parts.push(String.fromCharCode.apply(null, codes));
        codes = [];
      }
    }
    var rest = n - i;
    if (rest === 1) {
      var v1 = bytes[i] << 16;
      codes.push(B64_ALPHABET.charCodeAt((v1 >> 18) & 63), B64_ALPHABET.charCodeAt((v1 >> 12) & 63), 61, 61);
    } else if (rest === 2) {
      var v2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      codes.push(B64_ALPHABET.charCodeAt((v2 >> 18) & 63), B64_ALPHABET.charCodeAt((v2 >> 12) & 63),
        B64_ALPHABET.charCodeAt((v2 >> 6) & 63), 61);
    }
    parts.push(String.fromCharCode.apply(null, codes));
    return parts.join('');
  }

  function fromBase64(text) {
    var out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
    var len = 0;
    var acc = 0;
    var bits = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      var v = c < 128 ? B64_VALUE[c] : -1;
      if (v < 0) continue;
      acc = ((acc << 6) | v) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[len++] = (acc >> bits) & 0xff;
      }
    }
    return out.slice(0, len);
  }

  function failure(Kind, code, message) {
    var err = new Kind(message);
    err.code = code;
    return err;
  }

  function describeReceived(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'function') return 'function ' + value.name;
    if (typeof value === 'object') return 'an instance of ' + ((value.constructor && value.constructor.name) || 'Object');
    return 'type ' + typeof value + ' (' + (typeof value === 'string' ? "'" + value + "'" : String(value)) + ')';
  }

  function argTypeError(name, expected, value) {
    var noun = name.indexOf('options.') === 0 ? ' property' : ' argument';
    return failure(TypeError, 'ERR_INVALID_ARG_TYPE',
      'The "' + name + '"' + noun + ' must be ' + expected + '. Received ' + describeReceived(value));
  }

  function inputBytes(value, name, expected, allowArrayBuffer) {
    if (typeof value === 'string') return encodeUtf8(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (allowArrayBuffer && value instanceof ArrayBuffer) return new Uint8Array(value);
    throw argTypeError(name, expected, value);
  }

  function levelOption(options) {
    var level = options && typeof options === 'object' ? options.level : undefined;
    if (level === undefined) return -1;
    if (typeof level !== 'number') throw argTypeError('options.level', 'of type number', level);
    if (!(level >= -1 && level <= 9)) {
      throw failure(RangeError, 'ERR_OUT_OF_RANGE',
        'The value of "options.level" is out of range. It must be >= -1 and <= 9. Received ' + level);
    }
    return Math.trunc(level);
  }

  /*
   * Node bounds a flush flag by the codec that reads it: zlib's own five constants plus Z_BLOCK,
   * brotli's four operations, zstd's three directives. 'flush' is the flag an ordinary write carries
   * and 'finishFlush' the one the last write is raised to; both are checked here, as there, before
   * anything is compressed. The value is only stored, never applied: a finish is still a finish.
   */
  var FLUSH_BOUND_MAX = { brotli: 3, zstd: 2 };

  function flushBound(format) {
    return FLUSH_BOUND_MAX[format] === undefined ? 5 : FLUSH_BOUND_MAX[format];
  }

  function boundOption(format, options, name) {
    var value = options && typeof options === 'object' ? options[name] : undefined;
    if (value === undefined) return undefined;
    if (typeof value !== 'number') throw argTypeError('options.' + name, 'of type number', value);
    var max = flushBound(format);
    if (!(value >= 0 && value <= max)) {
      throw failure(RangeError, 'ERR_OUT_OF_RANGE',
        'The value of "options.' + name + '" is out of range. It must be >= 0 and <= ' + max +
        '. Received ' + value);
    }
    return Math.trunc(value);
  }

  function flushOptions(format, options) {
    boundOption(format, options, 'flush');
    boundOption(format, options, 'finishFlush');
  }

  /* Options only brotli and zstd read: 'params' is a map of BROTLI_PARAM_* or ZSTD_c_* / ZSTD_d_*
     keys to numbers. Node checks the key before the value, and names the key as it was written. */
  var BROTLI_PARAM_MAX = 8;
  var ZSTD_COMPRESSION_LEVEL = 100;
  var CODEC = { brotli: 1, zstd: 1 };

  function isCodecFormat(format) {
    return CODEC[format] === 1;
  }

  function paramsOption(format, options) {
    var params = options && typeof options === 'object' ? options.params : undefined;
    if (params === undefined || params === null) return undefined;
    var label = format === 'brotli' ? 'Brotli' : 'zstd';
    var invalid = format === 'brotli' ? 'ERR_BROTLI_INVALID_PARAM' : 'ERR_ZSTD_INVALID_PARAM';
    var pairs = [];
    var keys = Object.keys(params);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var numeric = Number(key);
      var unknown = !isFinite(numeric) || Math.floor(numeric) !== numeric ||
        (format === 'brotli' && (numeric < 0 || numeric > BROTLI_PARAM_MAX));
      if (unknown) throw failure(RangeError, invalid, key + ' is not a valid ' + label + ' parameter');
      var value = params[key];
      if (typeof value !== 'number') throw argTypeError('options.params[key]', 'of type number', value);
      pairs.push([numeric, value]);
    }
    return pairs.length > 0 ? pairs : undefined;
  }

  /* Brotli takes nine parameters; zstd's set is the library's own, so the host names a bad key.
     Node ignores 'level' for zstd -- it is only ever a deflate-family option there -- and a level
     asked for here is applied, as ZSTD_c_compressionLevel, before any 'params'. */
  function codecParamsOption(format, compress, options) {
    var pairs = paramsOption(format, options);
    if (format === 'zstd' && compress) {
      var level = options && typeof options === 'object' ? options.level : undefined;
      if (typeof level === 'number') {
        pairs = pairs ? [[ZSTD_COMPRESSION_LEVEL, level]].concat(pairs) : [[ZSTD_COMPRESSION_LEVEL, level]];
      }
    }
    return pairs;
  }

  function dictionaryOption(options) {
    var dictionary = options && typeof options === 'object' ? options.dictionary : undefined;
    if (dictionary === undefined) return undefined;
    return toBase64(inputBytes(dictionary, 'options.dictionary', SYNC_INPUT, true));
  }

  function concatBytes(list) {
    var total = 0;
    for (var i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (var j = 0; j < list.length; j++) {
      out.set(list[j], pos);
      pos += list[j].length;
    }
    return out;
  }

  /* 'chunkSize' is zstd's: the output buffer Node hands the library, which decides where the
     block boundaries fall. Anything but a finite number falls back to Node's default, as there. */
  function chunkOption(format, options) {
    if (format !== 'zstd') return undefined;
    var size = options && typeof options === 'object' ? options.chunkSize : undefined;
    if (typeof size !== 'number' || !isFinite(size)) return undefined;
    if (size < 64) {
      throw failure(RangeError, 'ERR_OUT_OF_RANGE',
        'The value of "options.chunkSize" is out of range. It must be >= 64. Received ' + size);
    }
    return Math.trunc(size);
  }

  function runZlib(format, compress, bytes, level, dictionary, params, chunkSize, streamed) {
    var args = { format: format, data: toBase64(bytes) };
    if (compress) args.level = level;
    if (dictionary !== undefined) args.dictionary = dictionary;
    if (params !== undefined) args.params = params;
    if (chunkSize !== undefined) args.chunkSize = chunkSize;
    if (streamed) args.streamed = true;
    var encoded;
    try {
      encoded = callCap(compress ? 'zlib.compress' : 'zlib.decompress', args);
    } catch (err) {
      /*
       * The host knows which parameter keys zstd accepts, so an unknown one is reported there --
       * and a capability failure always comes back as an Error. Node raises a RangeError, so the
       * one code that means that is rebuilt as one here.
       */
      if (err && err.code === 'ERR_ZSTD_INVALID_PARAM') throw failure(RangeError, err.code, String(err.message));
      throw err;
    }
    var result = fromBase64(encoded);
    return Buf.from(result.buffer);
  }

  function levelOf(format, compress, options) {
    return compress && !isCodecFormat(format) ? levelOption(options) : -1;
  }

  function syncOp(format, compress) {
    return function (buffer, options) {
      var bytes = inputBytes(buffer, 'buffer', SYNC_INPUT, true);
      flushOptions(format, options);
      return runZlib(format, compress, bytes, levelOf(format, compress, options), dictionaryOption(options),
        codecParamsOption(format, compress, options), chunkOption(format, options), false);
    };
  }

  // Callback forms validate their arguments synchronously, as Node does, then deliver the result
  // on a later macrotask, so the callback never runs inside the caller's stack frame.
  function callbackOp(format, compress) {
    return function (chunk, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = undefined;
      }
      if (typeof callback !== 'function') throw argTypeError('callback', 'of type function', callback);
      var bytes = inputBytes(chunk, 'chunk', CHUNK_INPUT, false);
      var level = levelOf(format, compress, options);
      flushOptions(format, options);
      var dictionary = dictionaryOption(options);
      var params = codecParamsOption(format, compress, options);
      var chunkSize = chunkOption(format, options);
      var result = null;
      var error = null;
      try {
        result = runZlib(format, compress, bytes, level, dictionary, params, chunkSize, true);
      } catch (err) {
        error = err;
      }
      setImmediateImpl(function () {
        if (error) callback(error);
        else callback(null, result);
      });
    };
  }

  // Stream classes extend the stream module's Transform. Every compress stream is driven one call
  // at a time -- a write, a flush or the finish is its own call against a context the host keeps --
  // because each one is visible in the bytes: a flush ends the block or meta-block that is open, and
  // in the deflate family it leaves the history where it was or clears it, which is two different
  // streams. Decompressing is the same bytes whatever the split, so those still buffer and inflate
  // once. The stream module is looked up when a class is first used.
  var streamClasses = Object.create(null);

  /*
   * The operation a call hands the codec. Brotli numbers process, flush and finish 0, 1, 2 and zstd
   * numbers continue, flush and end the same way; the deflate family uses zlib's own flush constants,
   * and Node's own default for a flush() with no argument is Z_FULL_FLUSH, not Z_SYNC_FLUSH.
   */
  var EMPTY = new Uint8Array(0);
  var CODEC_OPS = { write: 0, flush: 1, finish: 2 };
  var DEFLATE_OPS = { write: 0, flush: 3, finish: 4 };

  /*
   * A flush is not a call of its own: Node writes one of six zero-length buffers, each carrying the
   * flag it stands for, so a flush takes its turn behind whatever is already queued instead of
   * jumping ahead of it -- and, if it turns out to be the last chunk, it is raised to the finish
   * exactly as a write would be.
   */
  var flushBuffers = [];

  function flushBuffer(kind) {
    var buf = flushBuffers[kind];
    if (buf === undefined) {
      buf = Buf.from(EMPTY);
      buf._owcFlush = kind;
      flushBuffers[kind] = buf;
    }
    return buf;
  }

  function streamClass(name, format, compress) {
    if (streamClasses[name]) return streamClasses[name];
    var streamModule = requireBuiltin('stream');
    var Transform = streamModule && streamModule.Transform;
    if (typeof Transform !== 'function') throw new Error('zlib streams need the stream module');

    var incremental = compress;
    var ops = isCodecFormat(format) ? CODEC_OPS : DEFLATE_OPS;

    function openCodec(self) {
      if (self._owcStream) return self._owcStream;
      var args = { format: format, level: self._owcLevel };
      if (self._owcParams !== undefined) args.params = self._owcParams;
      if (self._owcChunkSize !== undefined) args.chunkSize = self._owcChunkSize;
      if (self._owcDictionary !== undefined) args.dictionary = self._owcDictionary;
      self._owcStream = callCap('zlib.streamOpen', args);
      return self._owcStream;
    }

    function closeCodec(self) {
      if (!self._owcStream) return;
      var id = self._owcStream;
      self._owcStream = 0;
      try {
        callCap('zlib.streamClose', { id: id });
      } catch (err) { /* the context is gone with the stream either way */ }
    }

    function pushCodec(self, op, bytes) {
      var encoded = callCap('zlib.streamWrite', { id: openCodec(self), data: toBase64(bytes), op: op });
      var out = fromBase64(encoded);
      if (out.length > 0) self.push(Buf.from(out.buffer));
    }
    if (streamClasses[name]) return streamClasses[name];

    function ZlibStream(options) {
      var self = Reflect.construct(Transform, [options || {}], ZlibStream);
      self._owcChunks = [];
      self._owcLevel = levelOf(format, compress, options);
      self._owcDictionary = dictionaryOption(options);
      self._owcParams = codecParamsOption(format, compress, options);
      self._owcChunkSize = chunkOption(format, options);
      self._owcStream = 0;
      flushOptions(format, options);
      self.bytesWritten = 0;
      return self;
    }
    ZlibStream.prototype = Object.create(Transform.prototype, {
      constructor: { value: ZlibStream, writable: true, configurable: true }
    });
    Object.defineProperty(ZlibStream, 'name', { value: name });

    ZlibStream.prototype._transform = function (chunk, encoding, callback) {
      var bytes = typeof chunk === 'string' ? encodeString(chunk, encoding) : inputBytes(chunk, 'chunk', CHUNK_INPUT, false);
      this.bytesWritten += bytes.length;
      if (!incremental) {
        // Copied now: the caller may reuse its buffer before the stream ends.
        this._owcChunks.push(bytes.slice(0));
        callback();
        return;
      }
      /*
       * Which call this chunk is. A write is the codec's own default and the finish is the last
       * one -- but Node hands the finish over as soon as the chunk it is processing is the only
       * one left in the queue, not only once the stream ends: writableEnded with nothing behind
       * this chunk. So a stream fed more than once finishes during a write, and then again when it
       * ends. zstd is where that shows: its second finish is a whole empty frame, nine bytes,
       * which a stream fed in one piece never carries. A deflate or brotli finish past the end
       * produces nothing, so there the extra call is invisible.
       */
      var op = ops.write;
      if (typeof chunk._owcFlush === 'number') op = chunk._owcFlush;
      if (this.writableEnded && this.writableLength === chunk.byteLength) op = ops.finish;
      try {
        pushCodec(this, op, bytes);
      } catch (err) {
        callback(err);
        return;
      }
      /*
       * Answered on a later turn, as the host's zlib does: its write finishes on the thread pool,
       * so a chunk queued behind this one is not handed to the library until after the call that
       * ended the stream -- which is what makes the finish flag above ever true. Answering here
       * instead drains every queued write before the end is seen, and a stream fed more than once
       * then never finishes early.
       */
      setImmediateImpl(callback);
    };

    ZlibStream.prototype._flush = function (callback) {
      var out;
      try {
        if (incremental) pushCodec(this, ops.finish, EMPTY);
        else {
          var input = concatBytes(this._owcChunks);
          this._owcChunks = [];
          out = runZlib(format, compress, input, this._owcLevel, this._owcDictionary, this._owcParams,
            this._owcChunkSize, true);
          if (out.length > 0) this.push(out);
        }
      } catch (err) {
        closeCodec(this);
        callback(err);
        return;
      }
      closeCodec(this);
      callback();
    };

    ZlibStream.prototype._destroy = function (err, callback) {
      closeCodec(this);
      if (typeof callback === 'function') callback(err);
    };

    ZlibStream.prototype.params = function (level, strategy, callback) {
      this._owcLevel = levelOption({ level: level });
      if (typeof callback === 'function') setImmediateImpl(callback);
    };

    ZlibStream.prototype.reset = function () {
      closeCodec(this);
      this._owcChunks = [];
      this.bytesWritten = 0;
    };

    /*
     * Past the end there is nothing left to flush, and the callback can then only wait for the
     * stream: on a later tick once the writable side has finished, on 'end' while it is still
     * ending -- which never comes for a stream that errored. Before the end the flush goes in as a
     * write of its own, so it lands behind the chunks already queued and the callback answers when
     * that write does.
     */
    ZlibStream.prototype.flush = function (kind, callback) {
      var done = typeof kind === 'function' ? kind : callback;
      if (typeof kind !== 'number') kind = ops.flush;
      /*
       * A stream whose readable side has ended has already run its finish, so the callback is only
       * held until the next tick. This module emits 'end' a tick before 'finish', where Node emits
       * 'finish' first, so waiting on 'end' here would wait forever: that is why the readable side
       * is asked as well as the writable one.
       */
      var rState = this._readableState;
      if (this.writableFinished || (rState && rState.endEmitted)) {
        if (typeof done === 'function') setImmediateImpl(done);
        return;
      }
      if (this.writableEnded) {
        if (typeof done === 'function') this.once('end', done);
        return;
      }
      this.write(flushBuffer(kind), '', typeof done === 'function' ? done : undefined);
    };

    ZlibStream.prototype.close = function (callback) {
      if (typeof callback === 'function') this.once('close', callback);
      this.destroy();
    };

    streamClasses[name] = ZlibStream;
    return ZlibStream;
  }

  function createStream(name, format, compress, options) {
    var Ctor = streamClass(name, format, compress);
    return new Ctor(options);
  }

  // CRC-32 (IEEE, reflected), table driven; the second argument continues an earlier checksum.
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    return table;
  })();

  function crc32(data, value) {
    var bytes = inputBytes(data, 'data', CHUNK_INPUT, false);
    var start = 0;
    if (value !== undefined) {
      if (typeof value !== 'number') throw argTypeError('value', 'of type number', value);
      if (!(value >= 0 && value <= 4294967295)) {
        throw failure(RangeError, 'ERR_OUT_OF_RANGE',
          'The value of "value" is out of range. It must be >= 0 && <= 4294967295. Received ' + value);
      }
      start = value;
    }
    var crc = start ^ 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  var zlib = {};
  zlib.constants = CONSTANTS;
  zlib.codes = CODES;
  zlib.crc32 = crc32;

  zlib.gzipSync = syncOp('gzip', true);
  zlib.gunzipSync = syncOp('gzip', false);
  zlib.deflateSync = syncOp('deflate', true);
  zlib.inflateSync = syncOp('deflate', false);
  zlib.deflateRawSync = syncOp('deflate-raw', true);
  zlib.inflateRawSync = syncOp('deflate-raw', false);
  zlib.unzipSync = syncOp('unzip', false);
  zlib.brotliCompressSync = syncOp('brotli', true);
  zlib.brotliDecompressSync = syncOp('brotli', false);
  zlib.zstdCompressSync = syncOp('zstd', true);
  zlib.zstdDecompressSync = syncOp('zstd', false);

  zlib.gzip = callbackOp('gzip', true);
  zlib.gunzip = callbackOp('gzip', false);
  zlib.deflate = callbackOp('deflate', true);
  zlib.inflate = callbackOp('deflate', false);
  zlib.deflateRaw = callbackOp('deflate-raw', true);
  zlib.inflateRaw = callbackOp('deflate-raw', false);
  zlib.unzip = callbackOp('unzip', false);
  zlib.brotliCompress = callbackOp('brotli', true);
  zlib.brotliDecompress = callbackOp('brotli', false);
  zlib.zstdCompress = callbackOp('zstd', true);
  zlib.zstdDecompress = callbackOp('zstd', false);

  [
    ['Gzip', 'gzip', true],
    ['Gunzip', 'gzip', false],
    ['Deflate', 'deflate', true],
    ['Inflate', 'deflate', false],
    ['DeflateRaw', 'deflate-raw', true],
    ['InflateRaw', 'deflate-raw', false],
    ['Unzip', 'unzip', false],
    ['BrotliCompress', 'brotli', true],
    ['BrotliDecompress', 'brotli', false],
    ['ZstdCompress', 'zstd', true],
    ['ZstdDecompress', 'zstd', false]
  ].forEach(function (kind) {
    Object.defineProperty(zlib, kind[0], {
      enumerable: true,
      get: function () { return streamClass(kind[0], kind[1], kind[2]); }
    });
    zlib['create' + kind[0]] = function (options) {
      return createStream(kind[0], kind[1], kind[2], options);
    };
  });

  return zlib;
};
`;
