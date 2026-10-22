/**
 * Guest source for `undici`, an npm package the container serves itself.
 *
 * Why. The package builds its HTTP/1.1 parser, llhttp, from WebAssembly: lib/dispatcher/client-h1.js
 * runs `let llhttpPromise = lazyllhttp(); llhttpPromise.catch()` at module scope. This runtime has no
 * WebAssembly, so lazyllhttp() rejects there, and `.catch()` with no callable handler does not suppress
 * it -- Node 24.15 ends a process the same way for `Promise.reject(e).catch()`. Requiring undici was
 * therefore enough to abort any program that touches it, including cheerio, which imports it only for
 * `fromURL` and never uses it for a document it already holds.
 *
 * What. The container serves undici over its own http and https modules instead of loading the package:
 * request, stream, pipeline and fetch are real HTTP, an Agent keeps the container's keep-alive pool, and
 * the surface that needs a raw socket or a WebSocket (connect, upgrade, WebSocket, EventSource) is not
 * available here and reports ERR_NOT_SUPPORTED, the way the container's own fetch does.
 */
export const SRC = String.raw`
(function () {
function unsupported(what) {
  return function () {
    var err = new Error(what + ' is not supported by this runtime');
    err.code = 'ERR_NOT_SUPPORTED';
    return Promise.reject(err);
  };
}

function isHttps(target, options) {
  var url = typeof target === 'string' ? target : (target && target.href !== undefined ? String(target.href) : '');
  if (url.indexOf('https:') === 0) return true;
  if (options && (options.protocol === 'https:' || options.protocol === 'https')) return true;
  return false;
}

function transport(target, options) {
  return isHttps(target, options) ? requireBuiltin('https') : requireBuiltin('http');
}

/* undici takes method, headers and body; http takes method, headers and a stream it is handed the body on. */
function headersToObject(headers) {
  var out = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach(function (value, key) { out[key] = value; });
    return out;
  }
  for (var key in headers) out[key] = headers[key];
  return out;
}

function headerHas(headers, name) {
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has(name);
  for (var key in headers) if (String(key).toLowerCase() === name) return true;
  return false;
}

function httpOptions(options) {
  var opts = {};
  if (!options) return opts;
  for (var key in options) {
    /* body is put on the wire separately and signal drives the abort below; neither is an http option */
    if (key === 'body' || key === 'dispatcher' || key === 'maxRedirections' || key === 'onInfo' || key === 'throwOnError') continue;
    if (key === 'signal' || key === 'headers' || key === 'method') continue;
    opts[key] = options[key];
  }
  if (options.headers) opts.headers = headersToObject(options.headers);
  if (options.method) opts.method = options.method;
  return opts;
}

/* ---- bodies ----
 *
 * Node derives Content-Type from the kind of body it is handed: a string goes out as
 * text/plain;charset=UTF-8, a URLSearchParams as form-urlencoded and a FormData as multipart with a
 * boundary it picks. A Content-Type the caller set on the request wins over the derived one.
 */
function isBlobLike(value) {
  return globalThis.Blob !== undefined && value instanceof globalThis.Blob;
}

function multipartQuote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/* A boundary in the shape undici writes one: the fixed prefix, then twelve digits. */
function multipartBoundary() {
  var bytes = requireBuiltin('crypto').randomBytes(12);
  var boundary = '----formdata-undici-';
  for (var i = 0; i < bytes.length; i++) boundary += String(bytes[i] % 10);
  return boundary;
}

function multipartHead(boundary, name, value) {
  var head = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + multipartQuote(name) + '"';
  if (isBlobLike(value)) {
    head += '; filename="' + multipartQuote(value.name === undefined || value.name === '' ? 'blob' : value.name) +
      '"\r\nContent-Type: ' + (value.type || 'application/octet-stream');
  }
  return head + '\r\n\r\n';
}

/* The whole multipart body in one buffer: possible while every part is a string, which is what a
   form of fields is. A Blob part has to be read first, so that form takes the promise below. */
function multipartSync(form, boundary) {
  var parts = [];
  var entries = form._entries;
  for (var i = 0; i < entries.length; i++) {
    parts.push(Buffer.from(multipartHead(boundary, entries[i].name, entries[i].value), 'utf8'));
    parts.push(Buffer.from(String(entries[i].value), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  /* the epilogue: the closing delimiter follows the CRLF that ended the last part */
  parts.push(Buffer.from('--' + boundary + '--\r\n', 'utf8'));
  return Buffer.concat(parts);
}

function multipartAsync(form, boundary) {
  var parts = [];
  var entries = form._entries;
  var at = 0;
  function step() {
    if (at >= entries.length) {
      parts.push(Buffer.from('--' + boundary + '--\r\n', 'utf8'));
      return Promise.resolve(Buffer.concat(parts));
    }
    var entry = entries[at++];
    parts.push(Buffer.from(multipartHead(boundary, entry.name, entry.value), 'utf8'));
    if (isBlobLike(entry.value)) {
      return Promise.resolve(entry.value.arrayBuffer()).then(function (buf) {
        parts.push(Buffer.from(new Uint8Array(buf)));
        parts.push(Buffer.from('\r\n', 'utf8'));
        return step();
      });
    }
    parts.push(Buffer.from(String(entry.value), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
    return step();
  }
  return step();
}

/* The characters the form-urlencoded serializer leaves alone; every other byte of the UTF-8 form
   of the value is escaped, and a space becomes '+'. */
var FORM_SAFE = /[0-9A-Za-z*\-._]/;

function formEncode(text) {
  var bytes = Buffer.from(String(text), 'utf8');
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var byte = bytes[i];
    if (byte === 0x20) out += '+';
    else if (FORM_SAFE.test(String.fromCharCode(byte))) out += String.fromCharCode(byte);
    else out += '%' + (byte < 16 ? '0' : '') + byte.toString(16).toUpperCase();
  }
  return out;
}

/* A URLSearchParams read through its own entries rather than through String(): the pairs are what
   the caller appended, whatever the container's own URLSearchParams makes of its constructor. */
function formUrlencode(params) {
  var out = [];
  params.forEach(function (value, name) { out.push(formEncode(name) + '=' + formEncode(value)); });
  return out.join('&');
}

/* ---- a body, as Request and Response both hold one ----
 *
 * Node keeps a body as a stream of bytes and derives a Content-Type from the kind of value it was
 * built from. Here a body is one of three things: bytes already in hand (bytes), a stream the
 * caller owns (stream), or bytes that have to be read before they exist (pending). contentType is
 * what Node would derive, and has says whether the caller passed a body at all -- a null body and
 * an empty one are not the same thing, and only a null one is allowed beside status 204.
 */
function makeBody(value) {
  if (value === undefined || value === null) return { bytes: null, stream: null, pending: null, contentType: null, has: false };
  if (typeof value === 'string') {
    return { bytes: Buffer.from(value, 'utf8'), stream: null, pending: null, contentType: 'text/plain;charset=UTF-8', has: true };
  }
  if (Buffer.isBuffer(value)) return { bytes: value, stream: null, pending: null, contentType: null, has: true };
  if (value instanceof Uint8Array) {
    return { bytes: Buffer.from(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)), stream: null, pending: null, contentType: null, has: true };
  }
  if (globalThis.ArrayBuffer !== undefined && value instanceof globalThis.ArrayBuffer) {
    return { bytes: Buffer.from(new Uint8Array(value)), stream: null, pending: null, contentType: null, has: true };
  }
  if (globalThis.URLSearchParams !== undefined && value instanceof globalThis.URLSearchParams) {
    return { bytes: Buffer.from(formUrlencode(value), 'utf8'), stream: null, pending: null, contentType: 'application/x-www-form-urlencoded;charset=UTF-8', has: true };
  }
  if (value instanceof FormData) {
    var boundary = multipartBoundary();
    var contentType = 'multipart/form-data; boundary=' + boundary;
    var needsRead = false;
    for (var i = 0; i < value._entries.length; i++) if (isBlobLike(value._entries[i].value)) needsRead = true;
    if (!needsRead) return { bytes: multipartSync(value, boundary), stream: null, pending: null, contentType: contentType, has: true };
    return { bytes: null, stream: null, pending: multipartAsync(value, boundary), contentType: contentType, has: true };
  }
  if (isBlobLike(value)) {
    return {
      bytes: null, stream: null, contentType: value.type || null, has: true,
      pending: Promise.resolve(value.arrayBuffer()).then(function (buf) { return Buffer.from(new Uint8Array(buf)); })
    };
  }
  if (typeof value.getReader === 'function') return { bytes: null, stream: value, pending: null, contentType: null, has: true };
  return { bytes: Buffer.from(String(value), 'utf8'), stream: null, pending: null, contentType: 'text/plain;charset=UTF-8', has: true };
}

function readStream(stream) {
  var reader = stream.getReader();
  var parts = [];
  function step() {
    return reader.read().then(function (read) {
      if (read.done) return Buffer.concat(parts);
      parts.push(Buffer.isBuffer(read.value) ? read.value : Buffer.from(read.value));
      return step();
    });
  }
  return step();
}

/* A body that is read the way Node reads one: the bytes are handed over the first time something
   pulls on the stream, and only then is the body marked used -- asking for .body disturbs nothing. */
function streamOfBytes(readBytes, markUsed) {
  var Ctor = globalThis.ReadableStream;
  if (typeof Ctor !== 'function') return undefined;
  var sent = false;
  /* A byte stream, as undici makes one: a body is bytes, so a caller can take a BYOB reader to it
     -- which is the 'supportsBYOB: true' Node prints for the body of a Response. */
  return new Ctor({
    type: 'bytes',
    pull: function (controller) {
      if (sent) { controller.close(); return; }
      sent = true;
      markUsed();
      var bytes = readBytes();
      if (bytes !== null && bytes !== undefined) {
        controller.enqueue(new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
      }
      controller.close();
    }
  });
}

function bodyBytes(body) {
  if (body === undefined || body === null) return Promise.resolve(null);
  /* bytes that are still being read, as a FormData holding a Blob reaches fetch: wait, then go on */
  if (typeof body.then === 'function') return Promise.resolve(body).then(function (bytes) { return bodyBytes(bytes); });
  /* a Node stream needs the duplex option Node requires for one; sending its String() would be garbage */
  if (typeof body.pipe === 'function') {
    return Promise.reject(new TypeError('RequestInit: duplex option is required when sending a body.'));
  }
  var made = makeBody(body);
  if (made.stream !== null) {
    return readStream(made.stream).then(function (buffer) { return { payload: buffer, contentType: null }; });
  }
  if (made.pending !== null) {
    return made.pending.then(function (buffer) { return { payload: buffer, contentType: made.contentType }; });
  }
  return Promise.resolve({ payload: made.bytes, contentType: made.contentType });
}

function bodyOf(chunks) {
  var buffer = Buffer.concat(chunks);
  return {
    /* The bytes themselves, so a caller that wants them never decodes and re-encodes the body. */
    buffer: buffer,
    text: function () { return Promise.resolve(buffer.toString('utf8')); },
    json: function () { return Promise.resolve(JSON.parse(buffer.toString('utf8'))); },
    bytes: function () { return Promise.resolve(new Uint8Array(buffer)); },
    arrayBuffer: function () { return Promise.resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)); },
    dump: function () { return Promise.resolve(); }
  };
}

/* request(url, options) -> { statusCode, headers, body }, as undici's request resolves. An
   options.signal aborts it: the socket is destroyed and the promise rejects with the signal's own
   reason, the way Node rejects an aborted fetch. */
function request(target, options) {
  return bodyBytes(options && options.body !== undefined ? options.body : null).then(function (prepared) {
    return new Promise(function (resolve, reject) {
      var mod = transport(target, options);
      var opts = httpOptions(options);
      if (prepared && prepared.contentType && !headerHas(opts.headers, 'content-type')) {
        opts.headers = headersToObject(opts.headers);
        opts.headers['content-type'] = prepared.contentType;
      }
      var req = mod.request(target, opts, function (res) {
        var chunks = [];
        res.on('data', function (chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
        res.on('end', function () {
          resolve({ statusCode: res.statusCode, statusText: res.statusMessage, headers: res.headers, body: bodyOf(chunks) });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      var signal = options && options.signal;
      if (signal && typeof signal.addEventListener === 'function') {
        var onAbort = function () {
          reject(signal.reason !== undefined ? signal.reason : new Error('This operation was aborted'));
          try { req.destroy(); } catch (destroyError) {}
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort);
      }
      if (prepared && prepared.payload !== null && prepared.payload !== undefined) req.end(prepared.payload);
      else req.end();
    });
  });
}

/* stream(url, options, factory): factory is called with the head and returns the writable the body is
   piped into, and the promise resolves with whatever factory returned. */
function stream(target, options, factory) {
  return new Promise(function (resolve, reject) {
    var mod = transport(target, options);
    var req = mod.request(target, httpOptions(options), function (res) {
      var sink = factory({ statusCode: res.statusCode, headers: res.headers, context: {} });
      res.on('data', function (chunk) { if (sink && typeof sink.write === 'function') sink.write(chunk); });
      res.on('end', function () {
        if (sink && typeof sink.end === 'function') sink.end();
        resolve(sink);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    var body = options && options.body !== undefined && options.body !== null ? options.body : null;
    if (body !== null) req.end(body); else req.end();
  });
}

function pipeline(target, options, handler) {
  return request(target, options).then(function (res) { return handler(res); });
}

/*
 * Headers, as Node keeps them: a list of lower-cased name/value pairs in the order they were
 * added, read back sorted by name with the values of one name joined by ', '. A name that is not
 * a token and a value carrying a byte a header cannot hold (NUL, CR or LF) are both rejected
 * with Node's own TypeError, and set-cookie keeps every value it was given, which getSetCookie
 * hands back one by one where get joins them.
 */
/* The token a header name has to be: the characters RFC 7230 allows, written with \x60 for the
   backtick because this whole module is one template literal. */
var HEADER_NAME = /^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/;
var CONTROL_BYTES = ['\n', '\r', String.fromCharCode(0)];

function normalizeHeaderValue(value) {
  return String(value).replace(/^[\t\n\f\r ]+/, '').replace(/[\t\n\f\r ]+$/, '');
}

function Headers(init) {
  if (!(this instanceof Headers)) {
    throw new TypeError('Class constructor _Headers cannot be invoked without \'new\'');
  }
  /* The list a Headers keeps is an own property here, but not one Node's shows: Object.keys,
     JSON.stringify and for-in of a Headers are all empty. */
  Object.defineProperty(this, '_list', { value: [], writable: true, configurable: true });
  if (init === undefined || init === null) return;
  var self = this;
  /* A sequence of pairs: an array of arrays, another Headers, or anything else iterable. */
  if (init[Symbol.iterator] !== undefined && typeof init[Symbol.iterator] === 'function') {
    var iter = init[Symbol.iterator]();
    var step = iter.next();
    while (!step.done) {
      var pair = [];
      var item = step.value;
      if (item !== undefined && item !== null && typeof item[Symbol.iterator] === 'function') {
        var inner = item[Symbol.iterator]();
        var part = inner.next();
        while (!part.done) { pair.push(part.value); part = inner.next(); }
      } else if (typeof item.length === 'number') {
        for (var i = 0; i < item.length; i++) pair.push(item[i]);
      }
      if (pair.length !== 2) {
        throw new TypeError('Headers constructor: expected name/value pair to be length 2, found ' + pair.length + '.');
      }
      self.append(String(pair[0]), String(pair[1]));
      step = iter.next();
    }
    return;
  }
  /* A record: one string value per key. The value is converted once, so an array of values arrives
     as the comma-joined string String() makes of it -- '1,2' rather than two entries -- which is
     what a record of ByteStrings holds. */
  for (var key in init) self.append(String(key), String(init[key]));
}
Headers.prototype.append = function (name, value) {
  var rawName = String(name);
  if (!HEADER_NAME.test(rawName)) {
    throw new TypeError('Headers.append: "' + rawName + '" is an invalid header name.');
  }
  var rawValue = String(value);
  for (var i = 0; i < CONTROL_BYTES.length; i++) {
    if (rawValue.indexOf(CONTROL_BYTES[i]) >= 0) {
      throw new TypeError('Headers.append: "' + rawValue + '" is an invalid header value.');
    }
  }
  this._list.push({ name: rawName.toLowerCase(), value: normalizeHeaderValue(rawValue) });
};
Headers.prototype.delete = function (name) {
  var lower = String(name).toLowerCase();
  var kept = [];
  for (var i = 0; i < this._list.length; i++) if (this._list[i].name !== lower) kept.push(this._list[i]);
  this._list = kept;
};
Headers.prototype.get = function (name) {
  var lower = String(name).toLowerCase();
  var found = [];
  for (var i = 0; i < this._list.length; i++) if (this._list[i].name === lower) found.push(this._list[i].value);
  return found.length === 0 ? null : found.join(', ');
};
Headers.prototype.has = function (name) {
  var lower = String(name).toLowerCase();
  for (var i = 0; i < this._list.length; i++) if (this._list[i].name === lower) return true;
  return false;
};
/* Node's Headers declares set after delete, so that is the order the prototype lists them in. */
Headers.prototype.set = function (name, value) {
  this.delete(name);
  this.append(name, value);
};
Headers.prototype.getSetCookie = function () {
  var found = [];
  for (var i = 0; i < this._list.length; i++) if (this._list[i].name === 'set-cookie') found.push(this._list[i].value);
  return found;
};
/* What Node iterates: one entry per name, the names sorted, the values of a name joined. */
function headerEntries(list) {
  var names = [];
  var byName = Object.create(null);
  for (var i = 0; i < list.length; i++) {
    if (byName[list[i].name] === undefined) {
      byName[list[i].name] = [];
      names.push(list[i].name);
    }
    byName[list[i].name].push(list[i].value);
  }
  names.sort();
  var out = [];
  for (var j = 0; j < names.length; j++) out.push([names[j], byName[names[j]].join(', ')]);
  return out;
}
/* The symbol Node hands a class that writes its own inspect output, and the shape it writes: the
   name, then each field on its own line under a two-space indent, with every value printed by
   util.inspect itself -- which is the whole of what a Response or a Headers shows, since neither
   carries an own property of its own for inspect to walk. */
var INSPECT_CUSTOM = typeof Symbol.for === 'function' ? Symbol.for('nodejs.util.inspect.custom') : undefined;

function keyTextOf(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : "'" + key.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function inspectBlock(name, pairs, inspect) {
  var body = '';
  for (var i = 0; i < pairs.length; i++) {
    body += (i === 0 ? '' : ',\n  ') + pairs[i][0] + ': ' + inspect(pairs[i][1]);
  }
  return name + ' {\n  ' + body + '\n}';
}

function headersInspect(inspect) {
  var entries = headerEntries(this._list);
  var shown = '';
  for (var i = 0; i < entries.length; i++) {
    shown += (i === 0 ? '' : ', ') + keyTextOf(entries[i][0]) + ': ' + inspect(entries[i][1]);
  }
  return shown === '' ? 'Headers {}' : 'Headers { ' + shown + ' }';
}

Headers.prototype.keys = function () {
  return headerEntries(this._list).map(function (pair) { return pair[0]; })[Symbol.iterator]();
};
Headers.prototype.values = function () {
  return headerEntries(this._list).map(function (pair) { return pair[1]; })[Symbol.iterator]();
};
Headers.prototype.entries = function () {
  return headerEntries(this._list).map(function (pair) { return [pair[0], pair[1]]; })[Symbol.iterator]();
};
if (INSPECT_CUSTOM !== undefined) {
  Object.defineProperty(Headers.prototype, INSPECT_CUSTOM, {
    value: function (depth, options, inspect) { return headersInspect.call(this, inspect); },
    writable: true, configurable: true
  });
}
Headers.prototype[Symbol.iterator] = Headers.prototype.entries;
Headers.prototype.forEach = function (fn, thisArg) {
  var entries = headerEntries(this._list);
  var self = this;
  for (var i = 0; i < entries.length; i++) {
    fn.call(thisArg === undefined ? self : thisArg, entries[i][1], entries[i][0], self);
  }
};
Object.defineProperty(Headers.prototype, Symbol.toStringTag, { value: 'Headers', configurable: true });

/* ---- FormData ----
 *
 * Node defines FormData as a global beside fetch. Entries keep their order and their kind: a string
 * stays a string, a Blob or File stays itself, and a Blob appended with a filename becomes a File
 * the way undici's does. fetch encodes one as multipart/form-data.
 */
function FormData() {
  if (!(this instanceof FormData)) {
    throw new TypeError('Class constructor _FormData cannot be invoked without \'new\'');
  }
  this._entries = [];
}
FormData.prototype.append = function (name, value, filename) {
  var File = globalThis.File;
  if (File !== undefined && filename !== undefined && isBlobLike(value) && !(value instanceof File)) {
    value = new File([value], String(filename), { type: value.type });
  }
  this._entries.push({ name: String(name), value: value });
};
FormData.prototype.set = function (name, value, filename) {
  this.delete(name);
  this.append(name, value, filename);
};
FormData.prototype.get = function (name) {
  var entries = this._entries;
  for (var i = 0; i < entries.length; i++) if (entries[i].name === String(name)) return entries[i].value;
  return null;
};
FormData.prototype.getAll = function (name) {
  return this._entries.filter(function (entry) { return entry.name === String(name); })
    .map(function (entry) { return entry.value; });
};
FormData.prototype.has = function (name) {
  return this._entries.some(function (entry) { return entry.name === String(name); });
};
FormData.prototype.delete = function (name) {
  this._entries = this._entries.filter(function (entry) { return entry.name !== String(name); });
};
FormData.prototype.forEach = function (fn, thisArg) {
  var self = this;
  this._entries.forEach(function (entry) {
    fn.call(thisArg === undefined ? self : thisArg, entry.value, entry.name, self);
  });
};
FormData.prototype.entries = function () {
  return this._entries.map(function (entry) { return [entry.name, entry.value]; })[Symbol.iterator]();
};
FormData.prototype.keys = function () {
  return this._entries.map(function (entry) { return entry.name; })[Symbol.iterator]();
};
FormData.prototype.values = function () {
  return this._entries.map(function (entry) { return entry.value; })[Symbol.iterator]();
};
FormData.prototype[Symbol.iterator] = FormData.prototype.entries;
Object.defineProperty(FormData.prototype, Symbol.toStringTag, { value: 'FormData', configurable: true });

/* Node's message for a body that has already been read, whichever way it is read again. */
function unusableBody() {
  return new TypeError('Body is unusable: Body has already been read');
}

/* The bytes a body holds, whichever of the three kinds it is: what is in hand is returned as it is,
   what has to be read is read once and kept, and a body the caller owns is drained. */
function bodyBuffer(body) {
  var slots = bodySlots(body);
  if (slots.bytes !== null && slots.bytes !== undefined) return Promise.resolve(slots.bytes);
  if (slots.pending !== null && slots.pending !== undefined) {
    return Promise.resolve(slots.pending).then(function (bytes) {
      slots.pending = null;
      slots.bytes = bytes;
      return bytes;
    });
  }
  if (slots.stream !== null && slots.stream !== undefined) {
    return readStream(slots.stream).then(function (bytes) {
      slots.stream = null;
      slots.bytes = bytes;
      return bytes;
    });
  }
  return Promise.resolve(Buffer.alloc(0));
}

/* The stream a body is read through. A body the caller owns is handed back unchanged; bytes in hand
   are wrapped, and the wrapper marks the body used when something first pulls on it. */
function bodyStream(body) {
  var slots = bodySlots(body);
  if (slots.stream !== null && slots.stream !== undefined) return slots.stream;
  if (slots.bytes === null && slots.pending === null) return null;
  var self = body;
  var stream = streamOfBytes(function () { return slots.bytes; }, function () { slots.used = true; });
  if (stream === undefined) return undefined;
  if (slots.pending !== null && slots.pending !== undefined) {
    /* the bytes do not exist yet: the first pull waits for them */
    var Ctor = globalThis.ReadableStream;
    return new Ctor({
      pull: function (controller) {
        slots.used = true;
        return bodyBuffer(self).then(function (bytes) {
          controller.enqueue(new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
          controller.close();
        });
      }
    });
  }
  return stream;
}

/*
 * What a Response holds, kept beside the instance in a WeakMap rather than on it. Node's Response
 * carries no own properties at all -- its fields are prototype accessors -- so Object.keys() of one
 * is [] and JSON.stringify() of one is '{}', where a plain object with the same fields written on
 * it would serialise every one of them. A class built over a state object keeps the accessors
 * assignable, which is the other half of what a program expects: status, url and the rest still
 * read back what a caller wrote.
 */
var RESPONSE_STATE = new WeakMap();

/*
 * The four slots a body is kept in -- the bytes in hand, the stream to drain, the promise that will
 * resolve to one of them, and whether the body has been read. Node keeps them nowhere a program can
 * see: a Response prototype carries no '_'-prefixed name at all, and a Request carries no own
 * property a for-in or a JSON.stringify would show. So they live in a WeakMap of their own, and
 * every read and write in this file goes through it.
 */
var BODY_SLOTS = new WeakMap();

function bodySlots(body) {
  var slots = BODY_SLOTS.get(body);
  if (slots === undefined) {
    slots = { bytes: null, stream: null, pending: null, used: false };
    BODY_SLOTS.set(body, slots);
  }
  return slots;
}

function responseState(res) {
  var state = RESPONSE_STATE.get(res);
  if (state === undefined) {
    state = {
      status: 200, statusText: '', ok: true, type: 'default', redirected: false, url: '',
      headers: new Headers()
    };
    RESPONSE_STATE.set(res, state);
  }
  return state;
}

/* One accessor per field, over the state object: readable and writable, as Node's are readable.
   The four slots a body is kept in are not among them -- they are read through bodySlots, so
   a for-in over a Response lists the fields and the methods and nothing else. */
function responseField(name, key, seen) {
  Object.defineProperty(Response.prototype, name, {
    get: function () { return responseState(this)[key]; },
    set: function (value) { responseState(this)[key] = value; },
    enumerable: seen === true,
    configurable: true
  });
}

function Response(body, init) {
  if (!(this instanceof Response)) {
    throw new TypeError('Class constructor _Response cannot be invoked without \'new\'');
  }
  init = init || {};
  var raw = init.status === undefined ? 200 : Number(init.status);
  var status = raw < 0 ? Math.ceil(raw) : Math.floor(raw);
  /* a status that is not a number at all is no more in range than one that is out of it */
  if (!(status >= 200 && status <= 599)) {
    throw new RangeError('init["status"] must be in the range of 200 to 599, inclusive.');
  }
  var statusText = init.statusText === undefined ? '' : String(init.statusText);
  if (statusText.indexOf('\n') >= 0 || statusText.indexOf('\r') >= 0) throw new TypeError('Invalid statusText');
  var made = makeBody(body);
  /* a status that carries no body may not be given one */
  if (made.has && (status === 204 || status === 205 || status === 304)) {
    throw new TypeError('Response constructor: Invalid response status code ' + status);
  }
  var state = {
    status: status,
    statusText: statusText,
    ok: status >= 200 && status < 300,
    type: 'default',
    redirected: false,
    url: init.url === undefined ? '' : String(init.url),
    headers: new Headers(init.headers)
  };
  RESPONSE_STATE.set(this, state);
  var slots = bodySlots(this);
  slots.bytes = made.bytes;
  slots.stream = made.stream;
  slots.pending = made.pending;
  slots.used = false;
  if (made.contentType !== null && !state.headers.has('content-type')) state.headers.set('content-type', made.contentType);
}
/* The order Node declares them in, which is the order a for-in and getOwnPropertyNames walk. */
responseField('type', 'type', true);
responseField('url', 'url', true);
responseField('redirected', 'redirected', true);
responseField('status', 'status', true);
responseField('ok', 'ok', true);
responseField('statusText', 'statusText', true);
responseField('headers', 'headers', true);
/* Node's Response takes no arguments -- the two a class body would declare are the body and the
   init, and neither is optional in the signature the way Node's is written. */
Object.defineProperty(Response, 'length', { value: 0, configurable: true });
Object.defineProperty(Response.prototype, 'body', {
  get: function () { return bodyStream(this); },
  enumerable: true, configurable: true
});
Object.defineProperty(Response.prototype, 'bodyUsed', {
  get: function () { return bodySlots(this).used; },
  enumerable: true, configurable: true
});

if (INSPECT_CUSTOM !== undefined) {
  /* What Node prints: the fields in the order it declares them, and nothing of the body beyond the
     stream it hands out. */
  Object.defineProperty(Response.prototype, INSPECT_CUSTOM, {
    value: function (depth, options, inspect) {
      var self = this;
      return inspectBlock('Response', [
        ['status', self.status], ['statusText', self.statusText], ['headers', self.headers],
        ['body', self.body], ['bodyUsed', self.bodyUsed], ['ok', self.ok],
        ['redirected', self.redirected], ['type', self.type], ['url', self.url]
      ], inspect);
    },
    writable: true, configurable: true
  });
}
Object.defineProperty(Response.prototype, Symbol.toStringTag, { value: 'Response', configurable: true });/* The type a Blob is made with: the content type as the header writes it, lower-cased, and nothing
   at all when there is no header. */
function blobTypeOf(headers) {
  var raw = headers === undefined || headers === null ? null : headers.get('content-type');
  if (raw === null || raw === undefined) return '';
  return String(raw).trim().toLowerCase();
}

/* The MIME type the body says it is, split from its parameters the way undici splits it, and
   matched without regard to case. */
function mimeOf(headers) {
  var raw = headers === undefined || headers === null ? '' : String(headers.get('content-type') || '');
  var at = raw.indexOf(';');
  return (at < 0 ? raw : raw.slice(0, at)).trim().toLowerCase();
}

/* The boundary a multipart body is split on: the parameter of its content type. */
function boundaryOf(headers) {
  var raw = headers === undefined || headers === null ? '' : String(headers.get('content-type') || '');
  var match = /boundary=(?:"([^"]*)"|([^;]*))/i.exec(raw);
  if (match === null) return null;
  var value = (match[1] !== undefined ? match[1] : match[2]).trim();
  return value === '' ? null : value;
}

/* One part of a multipart body: the headers above the blank line, and the raw bytes below it. */
function splitMultipart(bytes, boundary) {
  var text = bytes.toString('latin1');
  var delimiter = '--' + boundary;
  var parts = text.split('\r\n' + delimiter);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var chunk = parts[i];
    if (i > 0) chunk = chunk.replace(/^[^\S\r\n]*\r\n/, '');
    var head = chunk.indexOf('\r\n\r\n');
    if (head < 0) continue;
    var headerText = chunk.slice(0, head);
    if (headerText.indexOf(':') < 0) continue;
    if (chunk.slice(0, 2) === '--') break;
    out.push({ headers: headerText, body: chunk.slice(head + 4).replace(/\r\n$/, '') });
  }
  return out;
}

/* The name and filename a part's content-disposition carries. */
function dispositionOf(headerText) {
  var name = null;
  var filename = null;
  var match = /name=(?:"([^"]*)"|([^;]*))/i.exec(headerText);
  if (match !== null) name = match[1] !== undefined ? match[1] : match[2];
  var file = /filename=(?:"([^"]*)"|([^;]*))/i.exec(headerText);
  if (file !== null) filename = file[1] !== undefined ? file[1] : file[2];
  return { name: name, filename: filename };
}

/* A body read as a FormData, which is what Node offers beside text and json: a urlencoded body and
   a multipart one are the two it will parse, and anything else is refused by its content type
   before a byte of it is read. */
/* Node's formData is an async function, so a content type it will not parse is a rejected promise
   rather than a throw -- and it is refused before a byte of the body is read. */
function bodyFormData(body) {
  var mime = mimeOf(body.headers);
  if (mime !== 'multipart/form-data' && mime !== 'application/x-www-form-urlencoded') {
    return Promise.reject(new TypeError('Content-Type was not one of "multipart/form-data" or "application/x-www-form-urlencoded".'));
  }
  var slots = bodySlots(body);
  if (slots.used) return Promise.reject(unusableBody());
  slots.used = true;
  var made = new globalThis.FormData();
  return bodyBuffer(body).then(function (bytes) {
    if (mime === 'application/x-www-form-urlencoded') {
      new globalThis.URLSearchParams(bytes.toString('utf8')).forEach(function (value, key) {
        made.append(key, value);
      });
      return made;
    }
    var boundary = boundaryOf(body.headers);
    if (boundary === null) return made;
    var parts = splitMultipart(bytes, boundary);
    for (var i = 0; i < parts.length; i++) {
      var named = dispositionOf(parts[i].headers);
      if (named.name === null || named.name === undefined) continue;
      var typeMatch = /content-type\s*:\s*([^\r\n]*)/i.exec(parts[i].headers);
      var partType = typeMatch === null ? '' : typeMatch[1].trim();
      var raw = Buffer.from(parts[i].body, 'latin1');
      if (named.filename !== null && named.filename !== undefined && named.filename !== '') {
        made.append(named.name, new globalThis.File([raw], named.filename, { type: partType }), named.filename);
      } else if (partType === '' || partType === 'text/plain') {
        made.append(named.name, parts[i].body);
      } else {
        made.append(named.name, new globalThis.Blob([raw], { type: partType }));
      }
    }
    return made;
  });
}

/* Node's order on the prototype: clone, then the five ways to read a body. */
Response.prototype.clone = function () {
  if (bodySlots(this).used) throw new TypeError('Response.clone: Body has already been consumed.');
  /* built beside the constructor rather than through it: a clone keeps the status it was made
     with, and status 0 -- the one Response.error() carries -- is not a status the constructor
     would accept again */
  var copy = Object.create(Response.prototype);
  var source = responseState(this);
  var state = {
    status: source.status,
    statusText: source.statusText,
    ok: source.ok,
    type: source.type,
    redirected: source.redirected,
    url: source.url,
    headers: new Headers(source.headers)
  };
  RESPONSE_STATE.set(copy, state);
  var from = bodySlots(this);
  var into = bodySlots(copy);
  into.used = false;
  if (from.stream !== null && from.stream !== undefined) {
    var both = from.stream.tee();
    from.stream = both[0];
    into.stream = both[1];
    into.bytes = null;
    into.pending = null;
    from.bytes = null;
  } else {
    into.bytes = from.bytes;
    into.pending = from.pending;
    into.stream = null;
  }
  return copy;
};

Response.prototype.blob = function () {
  var slots = bodySlots(this);
  if (slots.used) return Promise.reject(unusableBody());
  slots.used = true;
  var type = blobTypeOf(this.headers);
  return bodyBuffer(this).then(function (bytes) { return new globalThis.Blob([bytes], { type: type }); });
};
Response.prototype.arrayBuffer = function () {
  var slots = bodySlots(this);
  if (slots.used) return Promise.reject(unusableBody());
  slots.used = true;
  return bodyBuffer(this).then(function (buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  });
};
Response.prototype.text = function () {
  var slots = bodySlots(this);
  if (slots.used) return Promise.reject(unusableBody());
  slots.used = true;
  return bodyBuffer(this).then(function (buffer) { return buffer.toString('utf8'); });
};
Response.prototype.json = function () {
  var slots = bodySlots(this);
  if (slots.used) return Promise.reject(unusableBody());
  slots.used = true;
  return bodyBuffer(this).then(function (buffer) { return JSON.parse(buffer.toString('utf8')); });
};
Response.prototype.formData = function () {
  return bodyFormData(this);
};
Response.prototype.bytes = function () {
  var slots = bodySlots(this);
  if (slots.used) return Promise.reject(unusableBody());
  slots.used = true;
  return bodyBuffer(this).then(function (buffer) { return new Uint8Array(buffer); });
};

/* init with one content-type added to whatever headers the caller passed, for the two static
   constructors that set one. The caller's own object is never touched. */
function initWithContentType(init, contentType) {
  var out = {};
  if (init !== undefined && init !== null) for (var key in init) out[key] = init[key];
  var headers = new Headers(init === undefined || init === null ? undefined : init.headers);
  if (!headers.has('content-type')) headers.set('content-type', contentType);
  out.headers = headers;
  return out;
}

/* The three constructors Node hangs off Response itself, beside the one a program calls with new.
   Response.error is the one the class cannot express: its status is 0 and its type is 'error'. */
Response.json = function (data, init) {
  if (arguments.length < 1) throw new TypeError('Response.json: 1 argument required, but 0 found.');
  var text = JSON.stringify(data);
  if (text === undefined) throw new TypeError('Value is not JSON serializable');
  return new Response(text, initWithContentType(init, 'application/json'));
};
var REDIRECT_STATUSES = [301, 302, 303, 307, 308];
Response.redirect = function (url, status) {
  if (arguments.length < 1) throw new TypeError('Response.redirect: 1 argument required, but 0 found.');
  var code = status === undefined ? 302 : Number(status);
  if (REDIRECT_STATUSES.indexOf(code) < 0) throw new RangeError('Invalid status code ' + String(status));
  var parsed = requestableUrl(url);
  if (parsed === null) throw unparseableUrl(url);
  return new Response(null, { status: code, headers: { location: parsed.href } });
};
Response.error = function () {
  var res = Object.create(Response.prototype);
  RESPONSE_STATE.set(res, {
    status: 0,
    statusText: '',
    ok: false,
    type: 'error',
    redirected: false,
    url: '',
    headers: new Headers()
  });
  return res;
};
/* Node's own order on the constructor: error, then json, then redirect. Deleting and re-adding is
   what moves a name that was already written to the front of the order. */
['error', 'json', 'redirect'].forEach(function (name) {
  var held = Response[name];
  delete Response[name];
  Object.defineProperty(Response, name, { value: held, writable: true, configurable: true });
});

var FORBIDDEN_METHODS = ['CONNECT', 'TRACE', 'TRACK'];
var METHOD_TOKEN = /^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/;

/* Node checks the method twice: once as a token, and once against the three methods a Request may
   never carry. Both messages quote the method as the caller wrote it, not as Node normalises it. */
function normalizeMethod(raw) {
  var name = String(raw);
  if (!METHOD_TOKEN.test(name)) throw new TypeError("'" + name + "' is not a valid HTTP method.");
  var upper = name.toUpperCase();
  if (FORBIDDEN_METHODS.indexOf(upper) >= 0) throw new TypeError("'" + name + "' HTTP method is unsupported.");
  return upper;
}

/*
 * A URL a request can be sent to, or null for one Node would refuse to parse. Node's URL rejects
 * 'http://' and 'http:' outright -- they name no host -- while this runtime's parses them to a
 * hostless href, so a scheme that needs a host is checked here too.
 */
function requestableUrl(raw) {
  var text = String(raw);
  var parsed = null;
  try { parsed = new globalThis.URL(text); } catch (badUrl) { return null; }
  var scheme = parsed.protocol;
  if ((scheme === 'http:' || scheme === 'https:' || scheme === 'ws:' || scheme === 'wss:') && parsed.hostname === '') return null;
  return parsed;
}

/* The TypeError both the Request constructor and fetch give for a URL that will not parse: the
   message Node writes, carrying the platform's ERR_INVALID_URL as its cause. */
function unparseableUrl(raw) {
  var failed = new TypeError('Failed to parse URL from ' + raw);
  var cause = new TypeError('Invalid URL');
  cause.code = 'ERR_INVALID_URL';
  failed.cause = cause;
  return failed;
}

/*
 * What a Request holds, kept beside the instance the way a Response's fields are. Node's Request
 * carries no own property at all -- every field is a prototype accessor -- so Object.keys() of one
 * is [] and a for-in lists the accessors and the methods in the order Node defines them.
 */
var REQUEST_STATE = new WeakMap();

function requestState(req) {
  var state = REQUEST_STATE.get(req);
  if (state === undefined) {
    state = {
      method: 'GET', url: '', headers: new Headers(), destination: '', referrer: 'about:client',
      referrerPolicy: '', mode: 'cors', credentials: 'same-origin', cache: 'default',
      redirect: 'follow', integrity: '', keepalive: false, isReloadNavigation: false,
      isHistoryNavigation: false, signal: undefined
    };
    REQUEST_STATE.set(req, state);
  }
  return state;
}

function requestField(name, key) {
  Object.defineProperty(Request.prototype, name, {
    get: function () { return requestState(this)[key]; },
    set: function (value) { requestState(this)[key] = value; },
    enumerable: true, configurable: true
  });
}

function Request(target, options) {
  if (!(this instanceof Request)) {
    throw new TypeError('Class constructor _Request cannot be invoked without \'new\'');
  }
  if (arguments.length < 1) throw new TypeError('Request constructor: 1 argument required, but 0 found.');
  options = options === undefined || options === null ? {} : options;
  var url;
  var rawMethod = 'GET';
  var headersInit = undefined;
  var bodyIn = null;
  if (target instanceof Request) {
    var given = bodySlots(target);
    if (given.used) {
      throw new TypeError('Cannot construct a Request with a Request object that has already been used.');
    }
    url = target.url;
    rawMethod = target.method;
    headersInit = target.headers;
    if (given.bytes !== null && given.bytes !== undefined) bodyIn = given.bytes;
    else if (given.stream !== null && given.stream !== undefined) bodyIn = given.stream;
    else if (given.pending !== null && given.pending !== undefined) bodyIn = given.pending;
  } else {
    url = target === undefined || target === null ? '' : (target.href !== undefined ? String(target.href) : String(target));
  }
  if (options.method !== undefined && options.method !== null) rawMethod = String(options.method);
  if (options.headers !== undefined && options.headers !== null) headersInit = options.headers;
  if (options.body !== undefined && options.body !== null) bodyIn = options.body;
  /* the URL is read first: a URL that will not parse is reported before the method or the body
     is looked at, which is the order Node reports them in */
  var parsed = requestableUrl(url);
  if (parsed === null) throw unparseableUrl(url);
  var method = normalizeMethod(rawMethod);
  var made = makeBody(bodyIn);
  if (made.has && (method === 'GET' || method === 'HEAD')) {
    throw new TypeError('Request with GET/HEAD method cannot have body.');
  }
  var state = requestState(this);
  state.url = parsed.href;
  state.method = method;
  state.headers = new Headers(headersInit);
  if (made.contentType !== null && !state.headers.has('content-type')) state.headers.set('content-type', made.contentType);
  var slots = bodySlots(this);
  slots.bytes = made.bytes;
  slots.stream = made.stream;
  slots.pending = made.pending;
  slots.used = false;
  state.signal = options.signal !== undefined && options.signal !== null ? options.signal : undefined;
  state.mode = options.mode === undefined ? 'cors' : String(options.mode);
  state.credentials = options.credentials === undefined ? 'same-origin' : String(options.credentials);
  state.cache = options.cache === undefined ? 'default' : String(options.cache);
  state.redirect = options.redirect === undefined ? 'follow' : String(options.redirect);
  state.referrer = options.referrer === undefined ? 'about:client' : String(options.referrer);
  state.referrerPolicy = options.referrerPolicy === undefined ? '' : String(options.referrerPolicy);
  state.integrity = options.integrity === undefined ? '' : String(options.integrity);
  state.keepalive = options.keepalive === undefined ? false : !!options.keepalive;
  state.destination = '';
  state.isReloadNavigation = false;
}
requestField('method', 'method');
requestField('url', 'url');
requestField('headers', 'headers');
requestField('destination', 'destination');
requestField('referrer', 'referrer');
requestField('referrerPolicy', 'referrerPolicy');
requestField('mode', 'mode');
requestField('credentials', 'credentials');
requestField('cache', 'cache');
requestField('redirect', 'redirect');
requestField('integrity', 'integrity');
requestField('keepalive', 'keepalive');
requestField('isReloadNavigation', 'isReloadNavigation');
requestField('isHistoryNavigation', 'isHistoryNavigation');
/* Every Request carries a signal, whether the caller passed one or not. */
Object.defineProperty(Request.prototype, 'signal', {
  get: function () {
    var state = requestState(this);
    if (state.signal === undefined || state.signal === null) {
      state.signal = globalThis.AbortController !== undefined ? new globalThis.AbortController().signal : undefined;
    }
    return state.signal;
  },
  enumerable: true, configurable: true
});
Object.defineProperty(Request.prototype, 'body', {
  get: function () { return bodyStream(this); },
  enumerable: true, configurable: true
});
Object.defineProperty(Request.prototype, 'bodyUsed', {
  get: function () { return bodySlots(this).used; },
  enumerable: true, configurable: true
});
Object.defineProperty(Request.prototype, 'duplex', { get: function () { return 'half'; }, enumerable: true, configurable: true });

if (INSPECT_CUSTOM !== undefined) {
  /* What Node prints: every field but the body, and the signal a Request always carries. */
  Object.defineProperty(Request.prototype, INSPECT_CUSTOM, {
    value: function (depth, options, inspect) {
      var self = this;
      return inspectBlock('Request', [
        ['method', self.method], ['url', self.url], ['headers', self.headers],
        ['destination', self.destination], ['referrer', self.referrer],
        ['referrerPolicy', self.referrerPolicy], ['mode', self.mode],
        ['credentials', self.credentials], ['cache', self.cache], ['redirect', self.redirect],
        ['integrity', self.integrity], ['keepalive', self.keepalive],
        ['isReloadNavigation', self.isReloadNavigation], ['isHistoryNavigation', self.isHistoryNavigation],
        ['signal', self.signal]
      ], inspect);
    },
    writable: true, configurable: true
  });
}
Object.defineProperty(Request.prototype, Symbol.toStringTag, { value: 'Request', configurable: true });Object.defineProperty(Request, 'length', { value: 1, configurable: true });
/* Node's order on the prototype: clone, then the ways to read a body, then the attribute slot. */
Request.prototype.clone = function () {
  if (bodySlots(this).used) throw new TypeError('unusable');
  var copy = new Request(this.url, { method: this.method, headers: this.headers });
  var from = bodySlots(this);
  var into = bodySlots(copy);
  if (from.stream !== null && from.stream !== undefined) {
    var both = from.stream.tee();
    from.stream = both[0];
    into.stream = both[1];
    from.bytes = null;
  } else {
    into.bytes = from.bytes;
    into.pending = from.pending;
  }
  requestState(copy).signal = requestState(this).signal;
  return copy;
};
Request.prototype.blob = function () {
  var slots = bodySlots(this);
  if (slots.used) return Promise.reject(unusableBody());
  slots.used = true;
  var type = blobTypeOf(this.headers);
  return bodyBuffer(this).then(function (bytes) { return new globalThis.Blob([bytes], { type: type }); });
};
Request.prototype.arrayBuffer = function () {
  var slots = bodySlots(this);
  if (slots.used) return Promise.reject(unusableBody());
  slots.used = true;
  return bodyBuffer(this).then(function (buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  });
};
Request.prototype.text = function () {
  var slots = bodySlots(this);
  if (slots.used) return Promise.reject(unusableBody());
  slots.used = true;
  return bodyBuffer(this).then(function (buffer) { return buffer.toString('utf8'); });
};
Request.prototype.json = function () {
  var slots = bodySlots(this);
  if (slots.used) return Promise.reject(unusableBody());
  slots.used = true;
  return bodyBuffer(this).then(function (buffer) { return JSON.parse(buffer.toString('utf8')); });
};
Request.prototype.formData = function () {
  return bodyFormData(this);
};
Request.prototype.bytes = function () {
  var slots = bodySlots(this);
  if (slots.used) return Promise.reject(unusableBody());
  slots.used = true;
  return bodyBuffer(this).then(function (buffer) { return new Uint8Array(buffer); });
};
/* Node hangs a plain 'attribute' slot on the prototype, the one its own Request carries and never
   fills: it reads as undefined, and it is a data property like the rest of the prototype's. */
Object.defineProperty(Request.prototype, 'attribute', { value: undefined, writable: true, enumerable: true, configurable: true });

/* An error that is the caller's, not the network's: fetch rejects with it as it is, and it is never
   wrapped in 'fetch failed'. */
function notTransport(error) {
  Object.defineProperty(error, 'owcNotTransport', { value: true });
  return error;
}

/*
 * A data: URL, which Node answers without a socket: the media type before the first comma is the
 * content type -- text/plain;charset=US-ASCII when the URL gives none -- and what follows is the
 * body, percent-decoded, or base64 when the type says so.
 */
function dataResponse(url) {
  var at = url.indexOf(',');
  var meta = at < 0 ? '' : url.slice(5, at);
  var payload = at < 0 ? '' : url.slice(at + 1);
  var base64 = /(^|;)base64$/i.test(meta);
  var bytes;
  try {
    bytes = base64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch (undecodable) {
    bytes = Buffer.from(payload, 'utf8');
  }
  return new Response(bytes, { status: 200, headers: { 'content-type': base64 ? meta.slice(0, meta.length - 7) : (meta === '' ? 'text/plain;charset=US-ASCII' : meta) } });
}

/* fetch(target, options): target is a URL string, a URL, or a Request -- a Request carries its own
   method, headers and body, and an option given beside it overrides the one the Request holds. */
function fetch(target, options) {
  var init = options || {};
  if (target instanceof Request) {
    var held = bodySlots(target);
    if (held.used) {
      /* not a transport failure, so it travels out of fetch exactly as Node reports it */
      var used = notTransport(new TypeError('Cannot construct a Request with a Request object that has already been used.'));
      return Promise.reject(used);
    }
    var carried = held.bytes !== null && held.bytes !== undefined
      ? held.bytes
      : (held.stream !== null && held.stream !== undefined
        ? held.stream
        : (held.pending !== null && held.pending !== undefined ? held.pending : null));
    init = { method: target.method, headers: target.headers, body: carried };
    for (var key in options) init[key] = options[key];
    held.used = true;
    target = target.url;
  }
  var url = String(target && target.href !== undefined ? target.href : target);
  /*
   * What a Request would have refused, in the order a Request refuses it: a URL that does not
   * parse, a method that is not a token or is one of the three a request may never carry, and a
   * body beside GET or HEAD. None of them is a transport failure, and none of them dials: an
   * 'http://' that names no host fails to parse here as it does in Node, instead of being
   * connected to port 80.
   */
  var parsed = requestableUrl(url);
  if (parsed === null) return Promise.reject(notTransport(unparseableUrl(url)));
  var method;
  try {
    method = normalizeMethod(init.method === undefined || init.method === null ? 'GET' : String(init.method));
  } catch (badMethod) {
    return Promise.reject(notTransport(badMethod));
  }
  if (init.body !== undefined && init.body !== null && (method === 'GET' || method === 'HEAD')) {
    return Promise.reject(notTransport(new TypeError('Request with GET/HEAD method cannot have body.')));
  }
  if (parsed.protocol === 'data:') return Promise.resolve(dataResponse(url));
  /* a scheme the container has no client for is a failed fetch, not a parse error */
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return Promise.reject(new Error('unknown scheme'));
  return request(url, init).then(function (res) {
    /* a status that carries no body gets none, so a 204 is not built with an empty one */
    var payload = (res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304) ? null : res.body.buffer;
    return new Response(payload, { status: res.statusCode, statusText: res.statusText, headers: res.headers, url: url });
  });
}

/* A dispatcher over the container's keep-alive pool. undici's Agent is per-origin and queues requests;
   this one hands each request to http or https with its own agent, which is the same pool. */
function Agent(options) {
  this.options = options || {};
}
Agent.prototype.dispatch = function (opts, handler) {
  return request(opts.origin && opts.path ? String(opts.origin) + String(opts.path) : String(opts.path), {
    method: opts.method, headers: opts.headers, body: opts.body
  }).then(function (res) {
    if (handler && typeof handler.onConnect === 'function') handler.onConnect(function () {});
    if (handler && typeof handler.onHeaders === 'function') handler.onHeaders(res.statusCode, res.headers, function () {}, res.statusText);
    return res.body.text().then(function (text) {
      if (handler && typeof handler.onData === 'function') handler.onData(Buffer.from(text));
    }).then(function () {
      if (handler && typeof handler.onComplete === 'function') handler.onComplete([]);
    });
  }, function (err) {
    if (handler && typeof handler.onError === 'function') handler.onError(err);
    else throw err;
  });
};
Agent.prototype.close = function () { return Promise.resolve(); };
Agent.prototype.destroy = function () { return Promise.resolve(); };

function Pool(origin, options) {
  this.origin = String(origin || '');
  this.options = options || {};
  this.agent = new Agent(this.options);
}
Pool.prototype.request = function (opts) {
  var url = this.origin.replace(/\/+$/, '') + String(opts && opts.path ? opts.path : '/');
  return request(url, opts);
};
Pool.prototype.close = function () { return Promise.resolve(); };
Pool.prototype.destroy = function () { return Promise.resolve(); };

function Client(origin, options) {
  Pool.call(this, origin, options);
}
Client.prototype = Object.create(Pool.prototype);
Client.prototype.constructor = Client;

function Dispatcher() {}
Dispatcher.prototype.close = function () { return Promise.resolve(); };
Dispatcher.prototype.destroy = function () { return Promise.resolve(); };

var globalDispatcher = new Agent();

var errors = {
  UndiciError: Error,
  ConnectTimeoutError: Error,
  HeadersTimeoutError: Error,
  BodyTimeoutError: Error,
  ResponseStatusCodeError: Error,
  InvalidArgumentError: Error,
  RequestAbortedError: Error,
  RequestContentLengthMismatchError: Error,
  ClientDestroyedError: Error,
  ClientClosedError: Error,
  SocketError: Error,
  NotSupportedError: Error,
  InformationalError: Error
};

var interceptors = {
  redirect: function (opts) { return function (dispatch) { return dispatch; }; },
  decompress: function (opts) { return function (dispatch) { return dispatch; }; },
  retry: function (opts) { return function (dispatch) { return dispatch; }; },
  dump: function (opts) { return function (dispatch) { return dispatch; }; },
  responseError: function (opts) { return function (dispatch) { return dispatch; }; }
};

/* ---- WebSocket ----
 *
 * A WebSocket client over the container's own sockets: the opening handshake is an HTTP/1.1
 * Upgrade on http or https, and once the server answers 101 the socket carries RFC 6455 frames,
 * masked on the way out the way a client must send them and read back unmasked. Text and binary
 * frames, fragments, ping and pong and the close handshake are all handled; there is no WebSocket
 * server here and no EventSource, only the client Node defines as a global.
 */
var WS_CONNECTING = 0;
var WS_OPEN = 1;
var WS_CLOSING = 2;
var WS_CLOSED = 3;
var WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/* the four handlers, in the order Node declares them on the prototype */
var WS_HANDLERS = ['open', 'error', 'close', 'message'];

function wsAcceptOf(key) {
  return requireBuiltin('crypto').createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsMaskFrame(opcode, payload) {
  var len = payload.length;
  var head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 0x80 | opcode;
  var mask = requireBuiltin('crypto').randomBytes(4);
  var body = Buffer.alloc(len);
  for (var i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

function wsSendFrame(ws, opcode, payload) {
  var state = wsState(ws);
  if (state.readyState === WS_CLOSED || !state.socket) return false;
  state.socket.write(wsMaskFrame(opcode, payload));
  return true;
}

/*
 * A frame the program asked to send, which is the only kind bufferedAmount counts: the bytes stand
 * against the socket until the write has been taken, so a read in the same turn as the send() -- the
 * way a program that sends and then looks -- reports them, and a read after a turn does not. Control
 * frames the container answers with are not the program's, and are not counted.
 */
function wsWrite(ws, opcode, payload) {
  var state = wsState(ws);
  state.bufferedAmount += payload.length;
  wsSendFrame(ws, opcode, payload);
  setTimeout(function () { state.bufferedAmount = 0; }, 0);
}

function wsCloseBody(code, reason) {
  var text = typeof reason === 'string' ? reason : '';
  var body = Buffer.alloc(2 + Buffer.byteLength(text));
  body.writeUInt16BE(code, 0);
  if (text !== '') body.write(text, 2, 'utf8');
  return body;
}

/*
 * The codes a peer may close with: 1000, the 1001-1014 the protocol defines, or any 3000-4999 an
 * application registers for itself. 1004, 1005 and 1006 name no real close, 1015 up to 2999 are
 * reserved, and anything under 1000 or over 4999 is out of range -- each of them fails the
 * connection rather than settling it.
 */
function wsCloseCodeOk(code) {
  if (code >= 1000 && code <= 1014) return code !== 1004 && code !== 1005 && code !== 1006;
  return code >= 3000 && code <= 4999;
}

/*
 * Whether a byte string is well-formed UTF-8. The lead byte fixes how many continuations follow and
 * narrows the first of them: 0xe0 needs 0xa0 and up so nothing is spelled in more bytes than it
 * needs, 0xed stops at 0x9f so a half surrogate is refused, 0xf0 starts at 0x90 and 0xf4 stops at
 * 0x8f so nothing above U+10FFFF is spelled -- while 0xc0, 0xc1 and 0xf5 upward name no character.
 * Node reads a text frame this way before it delivers one and fails the connection on the first byte
 * string that is not, rather than handing a program replacement characters.
 */
function wsUtf8Ok(bytes) {
  var i = 0;
  var n = bytes.length;
  while (i < n) {
    var lead = bytes[i];
    var extra = 0;
    var lo = 0x80;
    var hi = 0xbf;
    if (lead <= 0x7f) { i += 1; continue; }
    if (lead >= 0xc2 && lead <= 0xdf) extra = 1;
    else if (lead >= 0xe0 && lead <= 0xef) {
      extra = 2;
      if (lead === 0xe0) lo = 0xa0;
      else if (lead === 0xed) hi = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      extra = 3;
      if (lead === 0xf0) lo = 0x90;
      else if (lead === 0xf4) hi = 0x8f;
    } else return false;
    if (i + extra >= n) return false;
    if (bytes[i + 1] < lo || bytes[i + 1] > hi) return false;
    for (var k = 2; k <= extra; k++) {
      var cont = bytes[i + k];
      if (cont < 0x80 || cont > 0xbf) return false;
    }
    i += extra + 1;
  }
  return true;
}

/*
 * The state behind a socket, which no program is meant to see. Host Node keeps it in internal slots:
 * a socket carries no own property at all -- Object.getOwnPropertyNames(ws) is [] on the host and
 * every attribute is a prototype accessor -- so a WeakMap is the same thing here, with the socket as
 * the key and nothing about it changed. The listener list lives in that state too rather than on the
 * instance, so the slots an emitter would otherwise own never appear on the socket either.
 */
var WS_STATE = new WeakMap();

function wsState(ws) {
  return WS_STATE.get(ws);
}

/*
 * The socket's listener list, which is EventTarget's and not an emitter's: the same listener added
 * twice for one type is registered once, { once: true } unregisters as it fires, the capture flag is
 * part of what removeEventListener has to match, and a listener runs with the socket as 'this' --
 * or, for an object carrying a handleEvent, with that object. The list lives in the state beside the
 * rest of the socket, so the socket itself still carries no property of its own. 'error' is only
 * delivered to a program that is listening for it, as the count below decides.
 */
function wsCaptureOf(options) {
  if (options === true) return true;
  return !!(options !== null && typeof options === 'object' && options.capture);
}

function wsOnceOf(options) {
  return !!(options !== null && typeof options === 'object' && options.once);
}

function wsFindListener(st, type, listener, capture) {
  for (var i = 0; i < st.listeners.length; i++) {
    var entry = st.listeners[i];
    if (entry.type === type && entry.listener === listener && entry.capture === capture) return i;
  }
  return -1;
}

function wsAddListener(ws, type, listener, options) {
  var st = wsState(ws);
  var capture = wsCaptureOf(options);
  if (wsFindListener(st, type, listener, capture) >= 0) return;
  st.listeners.push({ type: type, listener: listener, capture: capture, once: wsOnceOf(options) });
}

function wsRemoveListener(ws, type, listener, options) {
  var st = wsState(ws);
  var at = wsFindListener(st, type, listener, wsCaptureOf(options));
  if (at >= 0) st.listeners.splice(at, 1);
}

function wsOn(ws, name, fn) {
  wsAddListener(ws, name, fn, undefined);
}

function wsOff(ws, name, fn) {
  wsRemoveListener(ws, name, fn, undefined);
}

function wsInvoke(ws, entry, event) {
  if (typeof entry.listener === 'function') entry.listener.call(ws, event);
  else if (entry.listener !== null && typeof entry.listener.handleEvent === 'function') {
    entry.listener.handleEvent.call(entry.listener, event);
  }
}

function wsEmit(ws, name, event) {
  var st = wsState(ws);
  var snapshot = st.listeners.slice();
  var fired = false;
  for (var i = 0; i < snapshot.length; i++) {
    var entry = snapshot[i];
    if (entry.type !== name) continue;
    /* A listener that is only heard once is gone before it runs, so it cannot hear itself again. */
    if (entry.once) wsRemoveListener(ws, name, entry.listener, entry.capture ? true : undefined);
    wsInvoke(ws, entry, event);
    fired = true;
  }
  return fired;
}

function wsListenerCount(ws, name) {
  var st = wsState(ws);
  var count = 0;
  for (var i = 0; i < st.listeners.length; i++) if (st.listeners[i].type === name) count++;
  return count;
}

/* What Node names the value it refused: 'Received undefined', 'Received null',
   "Received type string ('open')" and 'Received an instance of Object' are all one shape. */
function wsDescribeValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return "type string ('" + value + "')";
  if (typeof value === 'number') return 'type number (' + value + ')';
  if (typeof value === 'boolean') return 'type boolean (' + value + ')';
  if (typeof value === 'bigint') return 'type bigint (' + value + ')';
  if (typeof value === 'symbol') return 'type symbol (' + String(value) + ')';
  if (typeof value === 'function') return 'an instance of Function';
  var name = value.constructor && value.constructor.name ? value.constructor.name : 'Object';
  return 'an instance of ' + name;
}

/*
 * The message event Node delivers: a MessageEvent, whose data, origin, lastEventId, source and ports
 * are prototype getters over state no program can see, so an instance carries no own property and a
 * 'for (const k in event)' reads the prototype's names. 'origin' is the socket URL's origin -- it
 * stops at the host and carries no path, unlike the url itself -- and 'target' is the socket: the
 * container carries events on an emitter rather than dispatching them, so nothing else sets one.
 */
var WS_EVENT_TARGET = new WeakMap();

var WS_MESSAGE_PROTO = (function () {
  var Base = typeof globalThis.MessageEvent === 'function' ? globalThis.MessageEvent.prototype : Object.prototype;
  var proto = Object.create(Base);
  Object.defineProperty(proto, 'target', {
    get: function () { return WS_EVENT_TARGET.get(this); },
    configurable: true
  });
  return proto;
})();

function wsMessageEvent(ws, data) {
  var origin = wsState(ws).origin;
  var event = null;
  if (typeof globalThis.MessageEvent === 'function') {
    try {
      event = new globalThis.MessageEvent('message', {
        data: data,
        origin: origin,
        lastEventId: '',
        source: null,
        ports: []
      });
    } catch (badEvent) { event = null; }
  }
  if (event === null) {
    event = { type: 'message', data: data, origin: origin, lastEventId: '', source: null, ports: [] };
  } else {
    Object.setPrototypeOf(event, WS_MESSAGE_PROTO);
  }
  WS_EVENT_TARGET.set(event, ws);
  return event;
}

function wsDeliverMessage(ws, opcode, bytes) {
  var data;
  if (opcode === 0x1) {
    /*
     * A text frame that is not UTF-8: Node fails the connection there and then -- an error event and
     * the abnormal 1006 -- and tells the peer why with a 1007 close frame.
     */
    if (!wsUtf8Ok(bytes)) {
      wsSendFrame(ws, 0x8, wsCloseBody(1007, 'Received invalid UTF-8 in text frame.'));
      wsFail(ws);
      return;
    }
    /*
     * A text frame is read the way Node reads one: a leading byte-order mark is dropped, the way a
     * TextDecoder with ignoreBOM false reads a stream, so ef bb bf at the head of a message -- or at
     * the head of the first fragment of one -- never reaches the program. Only one is dropped, so a
     * second still does, which is what Node delivers for a message carrying two.
     */
    data = bytes.toString('utf8');
    if (data.charCodeAt(0) === 0xfeff) data = data.slice(1);
  } else if (ws.binaryType === 'arraybuffer') {
    data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } else if (ws.binaryType === 'nodebuffer' || ws.binaryType === 'buffer') {
    data = bytes;
  } else {
    data = new globalThis.Blob([new Uint8Array(bytes)]);
  }
  wsEmit(ws, 'message', wsMessageEvent(ws, data));
}

function wsHandleFrame(ws, fin, opcode, payload) {
  var state = wsState(ws);
  if (opcode === 0x8) {
    /*
     * A close frame the protocol does not allow: one byte of payload, which is half a code, or a
     * code a peer may not send. Node fails the connection then and there -- an error event and the
     * abnormal 1006, without waiting for the socket to end -- rather than settling on it. A frame
     * carrying no payload at all is the exception: it names no code, which is the 1005 Node
     * settles on cleanly.
     */
    if (payload.length === 1) {
      wsProtocolFail(ws, 1002, 'Received close frame with a 1-byte body.');
      return;
    }
    if (payload.length >= 2 && !wsCloseCodeOk(payload.readUInt16BE(0))) {
      wsProtocolFail(ws, 1002, 'Invalid status code');
      return;
    }
    /*
     * A close reason that is not UTF-8, which is a 1007 and not a 1002: the payload is text and the
     * text is wrong, not the frame around it.
     */
    if (payload.length > 2 && !wsUtf8Ok(payload.slice(2))) {
      wsProtocolFail(ws, 1007, 'Invalid UTF-8');
      return;
    }
    var code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    var reason = payload.length > 2 ? payload.slice(2).toString('utf8') : '';
    /*
     * Half of a close handshake, whichever side started it: the code and reason are remembered and
     * the peer's frame is answered, but nothing is settled yet. Node holds the socket at CLOSING
     * until the connection itself ends, so a program that waits for close waits for the TCP close,
     * not for the frame -- a server that sends a close frame and keeps the socket leaves the
     * client at readyState 2 for as long as the socket lives.
     */
    state.closeReceived = code;
    state.closeReceivedReason = reason;
    if (state.readyState === WS_OPEN) {
      state.readyState = WS_CLOSING;
      wsSendFrame(ws, 0x8, wsCloseBody(code, ''));
    }
    return;
  }
  if (opcode === 0x9) { wsSendFrame(ws, 0xa, payload); return; }
  if (opcode === 0xa) return;
  if (opcode === 0x1 || opcode === 0x2) {
    state.fragOp = opcode;
    state.frags = [payload];
  } else if (opcode === 0x0 && state.frags.length > 0) {
    state.frags.push(payload);
  } else {
    return;
  }
  if (!fin) return;
  var all = state.frags.length === 1 ? state.frags[0] : Buffer.concat(state.frags);
  state.frags = [];
  wsDeliverMessage(ws, state.fragOp, all);
}

function wsFeed(ws, buf) {
  while (wsState(ws).readyState !== WS_CLOSED) {
    if (buf.length < 2) return buf;
    var b0 = buf[0];
    var b1 = buf[1];
    var fin = (b0 & 0x80) !== 0;
    var opcode = b0 & 0x0f;
    var masked = (b1 & 0x80) !== 0;
    var len = b1 & 0x7f;
    var at = 2;
    /*
     * A frame the peer may not send, each of which Node answers with a 1002 close and then a failed
     * connection rather than reading past it. A server's frames are never masked -- only a client's
     * are -- so a masked one is refused outright, before its payload is even looked at.
     */
    if (masked) {
      wsProtocolFail(ws, 1002, 'Frame cannot be masked');
      return buf;
    }
    /*
     * The three reserved bits: RSV1 is the one a permessage-deflate extension would set, so it has a
     * message of its own, and RSV2 and RSV3 share the other.
     */
    if ((b0 & 0x40) !== 0) {
      wsProtocolFail(ws, 1002, 'Expected RSV1 to be clear.');
      return buf;
    }
    if ((b0 & 0x30) !== 0) {
      wsProtocolFail(ws, 1002, 'RSV1, RSV2, RSV3 must be clear');
      return buf;
    }
    var frags = wsState(ws).frags.length;
    if (opcode >= 0x8) {
      /* a control frame may carry no more than 125 bytes and may never be fragmented */
      if (!fin) {
        wsProtocolFail(ws, 1002, 'Invalid frame type was fragmented.');
        return buf;
      }
      if (len > 125) {
        wsProtocolFail(ws, 1002, 'Control frame either too large or fragmented');
        return buf;
      }
      if (opcode !== 0x8 && opcode !== 0x9 && opcode !== 0xa) {
        wsProtocolFail(ws, 1002, 'Invalid opcode received');
        return buf;
      }
    } else if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) {
      wsProtocolFail(ws, 1002, 'Invalid opcode received');
      return buf;
    } else if (opcode === 0x0 && frags === 0) {
      /* a continuation with nothing to continue */
      wsProtocolFail(ws, 1002, 'Unexpected continuation frame');
      return buf;
    } else if (opcode !== 0x0 && frags > 0) {
      /* a new message started while the last one was still fragmented */
      wsProtocolFail(ws, 1002, 'Expected continuation frame');
      return buf;
    }
    if (len === 126) {
      if (buf.length < 4) return buf;
      len = buf.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (buf.length < 10) return buf;
      len = buf.readUInt32BE(6);
      at = 10;
    }
    if (masked) at += 4;
    if (buf.length < at + len) return buf;
    var payload = buf.slice(at, at + len);
    if (masked) {
      var mask = buf.slice(at - 4, at);
      for (var i = 0; i < payload.length; i++) payload[i] = payload[i] ^ mask[i % 4];
    }
    buf = buf.slice(at + len);
    wsHandleFrame(ws, fin, opcode, payload);
  }
  return buf;
}

/*
 * The close event, and the only moment it is fired: when the connection ends. A close frame that
 * was exchanged settles cleanly, with the code the peer sent; a connection that ended without one
 * is the abnormal closure Node reports as 1006, and it carries an error first.
 */
function wsSettle(ws, code, reason, clean) {
  var state = wsState(ws);
  if (state.settled) return;
  state.settled = true;
  state.readyState = WS_CLOSED;
  if (state.socket) {
    try { state.socket.destroy(); } catch (destroyError) {}
    state.socket = null;
  }
  wsEmit(ws, 'close', wsCloseEvent(code, reason, clean, ws));
}

function wsSocketGone(ws) {
  var state = wsState(ws);
  if (state.settled || state.readyState === WS_CLOSED) return;
  if (state.closeReceived !== undefined && state.closeReceived !== null) {
    wsSettle(ws, state.closeReceived, state.closeReceivedReason, true);
    return;
  }
  /*
   * A connection that ended without a close frame: the socket itself is already gone, so Node
   * reports the failure on a socket that is already CLOSED -- a handler reads readyState 3, not the
   * OPEN it had while the connection was still up -- and settles it as the abnormal 1006.
   */
  state.readyState = WS_CLOSED;
  if (wsListenerCount(ws, 'error') > 0) wsEmit(ws, 'error', wsErrorEvent(ws));
  wsSettle(ws, 1006, '', false);
}

function wsFail(ws) {
  var state = wsState(ws);
  if (state.settled) return;
  /* a listener sees the socket as Node does: already CLOSED, not still connecting */
  state.readyState = WS_CLOSED;
  if (wsListenerCount(ws, 'error') > 0) wsEmit(ws, 'error', wsErrorEvent(ws));
  wsSettle(ws, 1006, '', false);
}

/*
 * A frame the protocol does not allow. Node does not just drop the connection: it tells the peer
 * why with a close frame -- 1002 for a frame that is malformed or a close code a peer may not send,
 * 1007 when the payload that is wrong is a close reason -- and only then fails the connection.
 */
function wsProtocolFail(ws, code, reason) {
  wsSendFrame(ws, 0x8, wsCloseBody(code, reason));
  wsFail(ws);
}

/*
 * The error event Node delivers to a WebSocket's error handler. Its attributes sit on a prototype
 * backed by the values below, the way Node's own events keep theirs on a prototype backed by
 * internal slots, so an "event instanceof Event" check passes and none of them shows up as an own
 * property. The failure it carries is a TypeError Node builds for the occasion, with no message of
 * its own: the real cause -- a refused connection, a bad Sec-WebSocket-Accept -- never reaches the
 * handler, so a handler that reads event.error.message sees '' whatever went wrong.
 */
function wsBuildEvent(Ctor, values) {
  var proto = Object.create(Ctor.prototype);
  for (var name in values) {
    (function (key) {
      Object.defineProperty(proto, key, { get: function () { return values[key]; }, configurable: true });
    })(name);
  }
  return Object.create(proto);
}

var WSErrorEvent = (function () {
  function ErrorEvent() {}
  var Base = typeof globalThis.Event === 'function' ? globalThis.Event.prototype : Object.prototype;
  ErrorEvent.prototype = Object.create(Base);
  Object.defineProperty(ErrorEvent.prototype, 'constructor', { value: ErrorEvent, writable: true, configurable: true });
  Object.defineProperty(ErrorEvent.prototype, Symbol.toStringTag, { value: 'ErrorEvent', configurable: true });
  ErrorEvent.prototype.preventDefault = function () {};
  ErrorEvent.prototype.stopPropagation = function () {};
  return ErrorEvent;
})();

function wsErrorEvent(target) {
  return wsBuildEvent(WSErrorEvent, {
    type: 'error',
    message: '',
    filename: '',
    lineno: 0,
    colno: 0,
    error: new TypeError(),
    target: target,
    currentTarget: null,
    bubbles: false,
    cancelable: false,
    defaultPrevented: false,
    timeStamp: 0
  });
}

function wsCloseEvent(code, reason, clean, target) {
  var Ctor = globalThis.CloseEvent;
  if (typeof Ctor === 'function') {
    try {
      return new Ctor('close', { code: code, reason: reason, wasClean: !!clean, target: target });
    } catch (badEvent) { /* a CloseEvent that will not build falls back to the plain object */ }
  }
  return { type: 'close', code: code, reason: reason, wasClean: !!clean, target: target };
}

/*
 * Node rejects the way the platform does: a DOMException, with the name a handler switches on and
 * the legacy code that goes with it (12 SyntaxError, 11 InvalidStateError, 15 InvalidAccessError),
 * not a plain Error.
 */
function wsDomError(message, name) {
  if (globalThis.DOMException !== undefined) {
    try {
      return new globalThis.DOMException(message, name);
    } catch (badException) { /* no DOMException that takes a name: fall through */ }
  }
  var err = new Error(message);
  err.name = name;
  return err;
}

/* Node rejects a URL the way the platform does: a DOMException SyntaxError, not a SyntaxError. */
function wsSyntax(message) {
  return wsDomError(message, 'SyntaxError');
}

/*
 * The close code, as the platform reads it: an unsigned short, so a fraction is truncated rather
 * than refused -- 1000.5 closes with 1000 -- and a value that is not a number at all lands on 0.
 */
function wsCloseCodeOf(value) {
  var num = Number(value);
  if (!Number.isFinite(num)) return 0;
  num = Math.trunc(num) % 65536;
  return num < 0 ? num + 65536 : num;
}

/*
 * The URL a WebSocket is built from. http and https are the ws and wss of the same host -- Node
 * rewrites the scheme rather than rejecting it -- a URL that does not parse at all is an invalid
 * URL, one that parses to some other scheme is refused as not a ws: or wss: url, and a fragment is
 * refused outright. What the socket is opened on is the normalised href, so 'ws://x.test' and
 * 'ws://x.test/' are one address.
 */
function wsParseUrl(url) {
  var raw = url !== null && typeof url === 'object' && typeof url.href === 'string' ? url.href : String(url);
  /*
   * The container's URL leaves a ws: URL written without the two authority slashes as it found it,
   * where Node's adds them, so 'ws:/x.test/' or 'ws:x.test/' would keep one slash or none and
   * resolve to no host. Adding them here is what makes every spelling the same address.
   */
  var bare = /^(ws|wss):(\/*)/i.exec(raw);
  if (bare !== null && bare[2].length < 2) raw = bare[1].toLowerCase() + '://' + raw.slice(bare[0].length);
  var parsed = null;
  try { parsed = new globalThis.URL(raw); } catch (badUrl) { parsed = null; }
  if (parsed === null) throw wsSyntax('TypeError: Invalid URL');
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw wsSyntax('expected a ws: or wss: url');
  /*
   * Refused on the fragment the parser found, which is not the same as a non-empty one: a bare '#'
   * carries no fragment text and leaves hash '', yet Node still refuses it, so the raw text -- where
   * a '#' can only start a fragment in a ws: or wss: URL -- is what decides.
   */
  if (raw.indexOf('#') !== -1) throw wsSyntax('hash');
  /* a ws: URL with no host is no more a URL here than it is in Node, which will not parse one */
  if (parsed.hostname === '') throw wsSyntax('TypeError: Invalid URL');
  if (parsed.pathname === '') parsed.pathname = '/';
  return parsed.href;
}

/* The Sec-WebSocket-Protocol list: one token each, none repeated, and no value a header cannot hold. */
function wsProtocols(protocols) {
  if (protocols === undefined || protocols === null) return [];
  var list = Array.isArray(protocols) ? protocols : [String(protocols)];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var value = String(list[i]);
    var ok = value !== '';
    for (var j = 0; ok && j < value.length; j++) {
      var at = value.charCodeAt(j);
      if (at <= 0x20 || at >= 0x7f || value.charAt(j) === ',') ok = false;
    }
    for (var k = 0; ok && k < out.length; k++) if (out[k] === value) ok = false;
    if (!ok) throw wsSyntax('Invalid Sec-WebSocket-Protocol value');
    out.push(value);
  }
  return out;
}

function WebSocket(url) {
  if (!(this instanceof WebSocket)) return new WebSocket(url, arguments[1]);
  var self = this;
  if (arguments.length < 1) throw new TypeError('WebSocket constructor: 1 argument required, but 0 found.');
  var protocols = arguments[1];
  var offered = wsProtocols(protocols);
  var href = wsParseUrl(url);
  var parsed = new globalThis.URL(href);
  var secure = parsed.protocol === 'wss:';
  /*
   * The whole of a socket's state, off the socket: it is read back through the accessors on the
   * prototype and through wsState, so the socket itself never carries a property of its own.
   */
  var handlers = {};
  for (var h = 0; h < WS_HANDLERS.length; h++) handlers[WS_HANDLERS[h]] = null;
  var state = {
    listeners: [],
    handlers: handlers,
    url: href,
    /* the message event's origin is the url's origin, which stops at the host and carries no path */
    origin: parsed.protocol + '//' + parsed.host,
    protocol: '',
    extensions: '',
    binaryType: 'blob',
    bufferedAmount: 0,
    readyState: WS_CONNECTING,
    socket: null,
    frags: [],
    fragOp: 0,
    settled: false,
    closeCode: undefined,
    closeReason: '',
    closeReceived: undefined,
    closeReceivedReason: ''
  };
  WS_STATE.set(this, state);
  var key = requireBuiltin('crypto').randomBytes(16).toString('base64');
  var headers = {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13'
  };
  if (offered.length > 0) headers['Sec-WebSocket-Protocol'] = offered.join(', ');
  var target = (secure ? 'https://' : 'http://') + parsed.host +
    (parsed.pathname === '' ? '/' : parsed.pathname) + (parsed.search || '');
  var mod = secure ? requireBuiltin('https') : requireBuiltin('http');
  var req = mod.request(target, { headers: headers });
  req.on('upgrade', function (res, socket, head) {
    var accept = res && res.headers ? res.headers['sec-websocket-accept'] : undefined;
    if (accept !== wsAcceptOf(key)) {
      wsFail(self);
      return;
    }
    /*
     * A protocol the client never asked for: the server may answer with one of the offered tokens or
     * with nothing, and anything else -- a token the client did not offer, a second one, a spelling
     * that differs in case -- fails the handshake the way a wrong Sec-WebSocket-Accept does, with an
     * error and no open. The client does not fall back to what the server picked.
     */
    var negotiated = res.headers['sec-websocket-protocol'];
    if (negotiated !== undefined && negotiated !== null) {
      if (Array.isArray(negotiated)) negotiated = negotiated.join(', ');
      if (offered.indexOf(negotiated) === -1) {
        wsFail(self);
        return;
      }
      state.protocol = negotiated;
    } else if (offered.length > 0) {
      /*
       * The other half of the same rule: a client that sent a Sec-WebSocket-Protocol and got no
       * Sec-WebSocket-Protocol back also fails. Node reads the request's own list and asks whether
       * the answer is in it, so with nothing answered there is nothing to be in it, and the socket
       * never opens -- it does not settle for no subprotocol.
       */
      wsFail(self);
      return;
    }
    var negotiatedExtensions = res.headers['sec-websocket-extensions'];
    if (negotiatedExtensions !== undefined && negotiatedExtensions !== null) {
      state.extensions = Array.isArray(negotiatedExtensions) ? negotiatedExtensions.join(', ') : negotiatedExtensions;
    }
    state.socket = socket;
    var rest = Buffer.isBuffer(head) ? head : Buffer.from('');
    socket.on('data', function (chunk) {
      rest = wsFeed(self, Buffer.concat([rest, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]));
    });
    socket.on('error', function (err) { if (wsListenerCount(self, 'error') > 0) wsEmit(self, 'error', err); });
    /* the connection ending is what closes the socket: a FIN, or the socket going away */
    socket.on('end', function () { wsSocketGone(self); });
    socket.on('close', function () { wsSocketGone(self); });
    state.readyState = WS_OPEN;
    wsEmit(self, 'open', { type: 'open', target: self });
    if (rest.length > 0) rest = wsFeed(self, rest);
  });
  req.on('response', function (res) {
    if (res && typeof res.resume === 'function') res.resume();
    wsFail(self);
  });
  req.on('error', function () { wsFail(self); });
  req.end();
}
/*
 * The surface a socket shows. Host Node's WebSocket is an EventTarget: addEventListener,
 * removeEventListener and dispatchEvent sit on EventTarget.prototype and not on the class, so a
 * for-in reaches them after every attribute the class declares and they never appear among the
 * class's own property names. WS_EVENT_BASE is that prototype's shape -- constructor, then the
 * three -- built over the real EventTarget, so 'ws instanceof EventTarget' still holds, while every
 * attribute of the socket itself is declared on WebSocket.prototype in the order Node declares it.
 */
var WS_EVENT_BASE = (function () {
  var Ctor = typeof globalThis.EventTarget === 'function' ? globalThis.EventTarget : null;
  var proto = Object.create(Ctor === null ? Object.prototype : Ctor.prototype);
  Object.defineProperty(proto, 'constructor', {
    value: Ctor === null ? Object : Ctor,
    writable: true,
    configurable: true
  });
  return proto;
})();

Object.defineProperty(WS_EVENT_BASE, 'addEventListener', {
  value: function addEventListener(type, listener, options) {
    /*
     * A listener Node will not keep is dropped without a sound: null and undefined are allowed and
     * ignored, and so is any value that is neither callable nor an object carrying a handleEvent.
     */
    if (listener === null || listener === undefined) return;
    var callable = typeof listener === 'function' ||
      (typeof listener === 'object' && listener !== null && typeof listener.handleEvent === 'function');
    if (!callable) return;
    wsAddListener(this, String(type), listener, options);
  },
  writable: true,
  configurable: true,
  enumerable: true
});
Object.defineProperty(WS_EVENT_BASE, 'removeEventListener', {
  value: function removeEventListener(type, listener, options) {
    wsRemoveListener(this, String(type), listener, options);
  },
  writable: true,
  configurable: true,
  enumerable: true
});
Object.defineProperty(WS_EVENT_BASE, 'dispatchEvent', {
  value: function dispatchEvent(event) {
    var Ctor = typeof globalThis.Event === 'function' ? globalThis.Event : null;
    if (Ctor === null || !(event instanceof Ctor)) {
      throw new TypeError('The "event" argument must be an instance of Event. Received ' + wsDescribeValue(event));
    }
    wsEmit(this, event.type, event);
    return !event.defaultPrevented;
  },
  writable: true,
  configurable: true,
  enumerable: true
});

WebSocket.prototype = Object.create(WS_EVENT_BASE);
Object.defineProperty(WebSocket.prototype, 'constructor', { value: WebSocket, writable: true, configurable: true });
Object.defineProperty(WebSocket.prototype, Symbol.toStringTag, { value: 'WebSocket', configurable: true });

WebSocket.prototype.close = function close() {
  var code = arguments[0];
  var reason = arguments[1];
  var num = code === undefined ? 1000 : wsCloseCodeOf(code);
  /*
   * The code is validated before the reason: a close carrying both an invalid code and an over-long
   * reason is an invalid code, which is the order Node checks them in. Both are checked before the
   * state is, so a second close() on a socket that is already closing still reports a code that is
   * not one, instead of being the no-op a socket in that state otherwise is.
   */
  if (num !== 1000 && (num < 3000 || num > 4999)) throw wsDomError('invalid code', 'InvalidAccessError');
  var text = reason === undefined ? '' : String(reason);
  var bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > 123) throw wsDomError('Reason must be less than 123 bytes; received ' + bytes, 'SyntaxError');
  if (this.readyState === WS_CLOSED || this.readyState === WS_CLOSING) return;
  var state = wsState(this);
  state.closeCode = num;
  state.closeReason = text;
  state.readyState = WS_CLOSING;
  /*
   * A close() that names no code sends a close frame with no body, not one carrying 1000: the peer
   * reads no code from it and the socket settles on 1005, which is what Node puts on the wire.
   */
  wsSendFrame(this, 0x8, arguments.length === 0 ? Buffer.alloc(0) : wsCloseBody(num, text));
};

WebSocket.prototype.send = function send(data) {
  /*
   * Before the handshake has finished there is no socket to write to, and Node says so with a
   * DOMException InvalidStateError rather than a state message of its own. Once the socket is
   * closing or closed a send is dropped on the floor: no throw, nothing written, no return value.
   */
  /*
   * No argument at all is an arity error and not a send of 'undefined': Node's webidl layer counts
   * the arguments before anything else looks at them.
   */
  if (arguments.length < 1) throw new TypeError('WebSocket.send: 1 argument required, but 0 found.');
  if (this.readyState === WS_CONNECTING) throw wsDomError('Sent before connected.', 'InvalidStateError');
  if (this.readyState !== WS_OPEN) return;
  var payload;
  var opcode;
  if (typeof data === 'string') {
    payload = Buffer.from(data, 'utf8');
    opcode = 0x1;
  } else if (Buffer.isBuffer(data)) {
    payload = data;
    opcode = 0x2;
  } else if (data instanceof Uint8Array) {
    payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    opcode = 0x2;
  } else if (data instanceof ArrayBuffer) {
    payload = Buffer.from(new Uint8Array(data));
    opcode = 0x2;
  } else if (typeof globalThis.Blob === 'function' && data instanceof globalThis.Blob) {
    /*
     * A Blob is binary, and its bytes are only reachable through a promise, so the frame is written
     * when they arrive: an op2 carrying the Blob's contents, not the op1 'String(blob)' would give.
     */
    var self = this;
    data.arrayBuffer().then(function (ab) {
      wsWrite(self, 0x2, Buffer.from(new Uint8Array(ab)));
    });
    return;
  } else {
    payload = Buffer.from(String(data), 'utf8');
    opcode = 0x1;
  }
  wsWrite(this, opcode, payload);
};

WebSocket.CONNECTING = WS_CONNECTING;
WebSocket.OPEN = WS_OPEN;
WebSocket.CLOSING = WS_CLOSING;
WebSocket.CLOSED = WS_CLOSED;

/*
 * The attributes, each a prototype accessor over state a program cannot see, declared in the order
 * Node declares them: both a for-in and Object.getOwnPropertyNames read that order back.
 */
/* A function under the name Node's own accessors carry, which a program can read back off .name. */
function wsNamed(name, fn) {
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}

function wsAttribute(name, read) {
  /*
   * The accessor's own name, which is what a program reads off 'Object.getOwnPropertyDescriptor(...
   * ).get.name': Node declares each attribute as 'get readyState' and friends, and a function built
   * here would otherwise be named after the variable it was passed in.
   */
  Object.defineProperty(read, 'name', { value: 'get ' + name, configurable: true });
  Object.defineProperty(WebSocket.prototype, name, { configurable: true, enumerable: true, get: read });
}

wsAttribute('readyState', function () { return wsState(this).readyState; });
wsAttribute('bufferedAmount', function () { return wsState(this).bufferedAmount; });
wsAttribute('url', function () { return wsState(this).url; });
wsAttribute('extensions', function () { return wsState(this).extensions; });
wsAttribute('protocol', function () { return wsState(this).protocol; });

(function () {
  for (var i = 0; i < WS_HANDLERS.length; i++) {
    (function (name) {
      Object.defineProperty(WebSocket.prototype, 'on' + name, {
        /* Node's own handler properties are plain enumerable accessors, and one that was never
           assigned reads null rather than the undefined a plain slot would give. */
        configurable: true,
        enumerable: true,
        get: wsNamed('get on' + name, function () {
          var fn = wsState(this).handlers[name];
          return typeof fn === 'function' ? fn : null;
        }),
        set: wsNamed('set on' + name, function (fn) {
          var handlers = wsState(this).handlers;
          if (typeof handlers[name] === 'function') wsOff(this, name, handlers[name]);
          handlers[name] = typeof fn === 'function' ? fn : null;
          if (typeof fn === 'function') wsOn(this, name, fn);
        })
      });
    })(WS_HANDLERS[i]);
  }
  /*
   * binaryType is the two kinds a message can arrive as and nothing else: Node keeps 'blob' when it
   * is handed anything it does not recognise, so an invalid spelling never sticks.
   */
  Object.defineProperty(WebSocket.prototype, 'binaryType', {
    configurable: true,
    enumerable: true,
    get: wsNamed('get binaryType', function () { return wsState(this).binaryType === 'arraybuffer' ? 'arraybuffer' : 'blob'; }),
    set: wsNamed('set binaryType', function (value) { wsState(this).binaryType = value === 'arraybuffer' ? 'arraybuffer' : 'blob'; })
  });
  /* the four states are readable off an instance, not only off the class */
  var states = { CONNECTING: WS_CONNECTING, OPEN: WS_OPEN, CLOSING: WS_CLOSING, CLOSED: WS_CLOSED };
  Object.keys(states).forEach(function (name) {
    Object.defineProperty(WebSocket.prototype, name, { value: states[name], writable: false, enumerable: true, configurable: true });
  });
})();

BF['undici'] = function () {
  return {
    fetch: fetch,
    request: request,
    stream: stream,
    pipeline: pipeline,
    connect: unsupported('undici.connect'),
    upgrade: unsupported('undici.upgrade'),
    Agent: Agent,
    Pool: Pool,
    Client: Client,
    Dispatcher: Dispatcher,
    BalancedPool: function BalancedPool() { throw new Error('undici.BalancedPool is not supported by this runtime'); },
    ProxyAgent: function ProxyAgent() { throw new Error('undici.ProxyAgent is not supported by this runtime'); },
    EnvHttpProxyAgent: function EnvHttpProxyAgent() { throw new Error('undici.EnvHttpProxyAgent is not supported by this runtime'); },
    RetryAgent: function RetryAgent() { throw new Error('undici.RetryAgent is not supported by this runtime'); },
    MockAgent: function MockAgent() { throw new Error('undici.MockAgent is not supported by this runtime'); },
    MockClient: function MockClient() { throw new Error('undici.MockClient is not supported by this runtime'); },
    MockPool: function MockPool() { throw new Error('undici.MockPool is not supported by this runtime'); },
    buildConnector: function () { throw new Error('undici.buildConnector is not supported by this runtime'); },
    WebSocket: WebSocket,
    EventSource: function EventSource() { throw new Error('undici.EventSource is not supported by this runtime'); },
    setGlobalDispatcher: function (agent) { globalDispatcher = agent; },
    getGlobalDispatcher: function () { return globalDispatcher; },
    interceptors: interceptors,
    errors: errors,
    Headers: Headers,
    FormData: FormData,
    Response: Response,
    Request: Request
  };
};
})();
`;
