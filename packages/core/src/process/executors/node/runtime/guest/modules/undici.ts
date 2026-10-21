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
var MULTIPART_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function isBlobLike(value) {
  return globalThis.Blob !== undefined && value instanceof globalThis.Blob;
}

function multipartQuote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function multipartBoundary() {
  var bytes = requireBuiltin('crypto').randomBytes(24);
  var boundary = '----formdata-owc-';
  for (var i = 0; i < bytes.length; i++) boundary += MULTIPART_CHARS[bytes[i] % MULTIPART_CHARS.length];
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
    return { bytes: Buffer.from(String(value), 'utf8'), stream: null, pending: null, contentType: 'application/x-www-form-urlencoded;charset=UTF-8', has: true };
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
  return new Ctor({
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
    throw new TypeError("Failed to construct 'Headers': Please use the 'new' operator.");
  }
  this._list = [];
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
  /* A record: one value per key, or several for a key the server sent more than once. */
  for (var key in init) {
    var value = init[key];
    if (Array.isArray(value)) {
      for (var j = 0; j < value.length; j++) self.append(key, String(value[j]));
    } else {
      self.append(key, String(value));
    }
  }
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
Headers.prototype.set = function (name, value) {
  var lower = String(name).toLowerCase();
  var kept = [];
  for (var i = 0; i < this._list.length; i++) if (this._list[i].name !== lower) kept.push(this._list[i]);
  this._list = kept;
  this.append(name, value);
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
Headers.prototype.delete = function (name) {
  var lower = String(name).toLowerCase();
  var kept = [];
  for (var i = 0; i < this._list.length; i++) if (this._list[i].name !== lower) kept.push(this._list[i]);
  this._list = kept;
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
Headers.prototype.keys = function () {
  return headerEntries(this._list).map(function (pair) { return pair[0]; })[Symbol.iterator]();
};
Headers.prototype.values = function () {
  return headerEntries(this._list).map(function (pair) { return pair[1]; })[Symbol.iterator]();
};
Headers.prototype.entries = function () {
  return headerEntries(this._list).map(function (pair) { return [pair[0], pair[1]]; })[Symbol.iterator]();
};
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
    throw new TypeError('Failed to construct \'FormData\': Please use the \'new\' operator.');
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

/* The bytes a body holds, whichever of the three kinds it is: what is in hand is returned as it is,
   what has to be read is read once and kept, and a body the caller owns is drained. */
function bodyBuffer(body) {
  if (body._bytes !== null && body._bytes !== undefined) return Promise.resolve(body._bytes);
  if (body._pending !== null && body._pending !== undefined) {
    return Promise.resolve(body._pending).then(function (bytes) {
      body._pending = null;
      body._bytes = bytes;
      return bytes;
    });
  }
  if (body._stream !== null && body._stream !== undefined) {
    return readStream(body._stream).then(function (bytes) {
      body._stream = null;
      body._bytes = bytes;
      return bytes;
    });
  }
  return Promise.resolve(Buffer.alloc(0));
}

/* The stream a body is read through. A body the caller owns is handed back unchanged; bytes in hand
   are wrapped, and the wrapper marks the body used when something first pulls on it. */
function bodyStream(body) {
  if (body._stream !== null && body._stream !== undefined) return body._stream;
  if (body._bytes === null && body._pending === null) return null;
  var self = body;
  var stream = streamOfBytes(function () { return self._bytes; }, function () { self._used = true; });
  if (stream === undefined) return undefined;
  if (body._pending !== null && body._pending !== undefined) {
    /* the bytes do not exist yet: the first pull waits for them */
    var Ctor = globalThis.ReadableStream;
    return new Ctor({
      pull: function (controller) {
        self._used = true;
        return bodyBuffer(self).then(function (bytes) {
          controller.enqueue(new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
          controller.close();
        });
      }
    });
  }
  return stream;
}

function Response(body, init) {
  if (!(this instanceof Response)) {
    throw new TypeError("Failed to construct 'Response': Please use the 'new' operator.");
  }
  init = init || {};
  var raw = init.status === undefined ? 200 : Number(init.status);
  var status = raw < 0 ? Math.ceil(raw) : Math.floor(raw);
  if (status < 200 || status > 599) {
    throw new RangeError('init["status"] must be in the range of 200 to 599, inclusive.');
  }
  var statusText = init.statusText === undefined ? '' : String(init.statusText);
  if (statusText.indexOf('\n') >= 0 || statusText.indexOf('\r') >= 0) throw new TypeError('Invalid statusText');
  var made = makeBody(body);
  /* a status that carries no body may not be given one */
  if (made.has && (status === 204 || status === 205 || status === 304)) {
    throw new TypeError('Response constructor: Invalid response status code ' + status);
  }
  this.status = status;
  this.statusText = statusText;
  this.ok = status >= 200 && status < 300;
  this.type = 'default';
  this.redirected = false;
  this.url = init.url === undefined ? '' : String(init.url);
  this.headers = new Headers(init.headers);
  if (made.contentType !== null && !this.headers.has('content-type')) this.headers.set('content-type', made.contentType);
  this._bytes = made.bytes;
  this._stream = made.stream;
  this._pending = made.pending;
  this._used = false;
}
Object.defineProperty(Response.prototype, 'body', {
  get: function () { return bodyStream(this); },
  configurable: true
});
Object.defineProperty(Response.prototype, 'bodyUsed', {
  get: function () { return this._used; },
  configurable: true
});
Object.defineProperty(Response.prototype, Symbol.toStringTag, { value: 'Response', configurable: true });
Response.prototype.bytes = function () {
  if (this._used) return Promise.reject(new TypeError('Body has already been used.'));
  this._used = true;
  return bodyBuffer(this).then(function (buffer) { return new Uint8Array(buffer); });
};
Response.prototype.text = function () {
  if (this._used) return Promise.reject(new TypeError('Body has already been used.'));
  this._used = true;
  return bodyBuffer(this).then(function (buffer) { return buffer.toString('utf8'); });
};
Response.prototype.json = function () {
  if (this._used) return Promise.reject(new TypeError('Body has already been used.'));
  this._used = true;
  return bodyBuffer(this).then(function (buffer) { return JSON.parse(buffer.toString('utf8')); });
};
Response.prototype.arrayBuffer = function () {
  if (this._used) return Promise.reject(new TypeError('Body has already been used.'));
  this._used = true;
  return bodyBuffer(this).then(function (buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  });
};
Response.prototype.clone = function () {
  if (this._used) throw new TypeError('Response.clone: body has already been used.');
  var copy = new Response(null, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url });
  if (this._stream !== null && this._stream !== undefined) {
    var both = this._stream.tee();
    this._stream = both[0];
    copy._stream = both[1];
    this._bytes = null;
  } else {
    copy._bytes = this._bytes;
    copy._pending = this._pending;
  }
  return copy;
};

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

function Request(target, options) {
  if (!(this instanceof Request)) {
    throw new TypeError("Failed to construct 'Request': Please use the 'new' operator.");
  }
  if (arguments.length < 1) throw new TypeError('Request constructor: 1 argument required, but 0 found.');
  options = options === undefined || options === null ? {} : options;
  var url;
  var rawMethod = 'GET';
  var headersInit = undefined;
  var bodyIn = null;
  if (target instanceof Request) {
    if (target._used) {
      throw new TypeError('Cannot construct a Request with a Request object that has already been used.');
    }
    url = target.url;
    rawMethod = target.method;
    headersInit = target.headers;
    if (target._bytes !== null && target._bytes !== undefined) bodyIn = target._bytes;
    else if (target._stream !== null && target._stream !== undefined) bodyIn = target._stream;
    else if (target._pending !== null && target._pending !== undefined) bodyIn = target._pending;
  } else {
    url = target === undefined || target === null ? '' : (target.href !== undefined ? String(target.href) : String(target));
  }
  if (options.method !== undefined && options.method !== null) rawMethod = String(options.method);
  if (options.headers !== undefined && options.headers !== null) headersInit = options.headers;
  if (options.body !== undefined && options.body !== null) bodyIn = options.body;
  var method = normalizeMethod(rawMethod);
  var made = makeBody(bodyIn);
  if (made.has && (method === 'GET' || method === 'HEAD')) {
    throw new TypeError('Request with GET/HEAD method cannot have body.');
  }
  var parsed = null;
  try { parsed = new globalThis.URL(url); } catch (badUrl) { parsed = null; }
  if (parsed === null) throw new TypeError('Failed to parse URL from ' + url);
  this.url = parsed.href;
  this.method = method;
  this.headers = new Headers(headersInit);
  if (made.contentType !== null && !this.headers.has('content-type')) this.headers.set('content-type', made.contentType);
  this._bytes = made.bytes;
  this._stream = made.stream;
  this._pending = made.pending;
  this._used = false;
  this._signal = options.signal !== undefined && options.signal !== null ? options.signal : undefined;
  this.mode = options.mode === undefined ? 'cors' : String(options.mode);
  this.credentials = options.credentials === undefined ? 'same-origin' : String(options.credentials);
  this.cache = options.cache === undefined ? 'default' : String(options.cache);
  this.redirect = options.redirect === undefined ? 'follow' : String(options.redirect);
  this.referrer = options.referrer === undefined ? 'about:client' : String(options.referrer);
  this.referrerPolicy = options.referrerPolicy === undefined ? '' : String(options.referrerPolicy);
  this.integrity = options.integrity === undefined ? '' : String(options.integrity);
  this.keepalive = options.keepalive === undefined ? false : !!options.keepalive;
  this.destination = '';
  this.isReloadNavigation = false;
}
Object.defineProperty(Request.prototype, 'duplex', { get: function () { return 'half'; }, configurable: true });
Object.defineProperty(Request.prototype, 'body', {
  get: function () { return bodyStream(this); },
  configurable: true
});
Object.defineProperty(Request.prototype, 'bodyUsed', {
  get: function () { return this._used; },
  configurable: true
});
/* Every Request carries a signal, whether the caller passed one or not. */
Object.defineProperty(Request.prototype, 'signal', {
  get: function () {
    if (this._signal === undefined || this._signal === null) {
      this._signal = globalThis.AbortController !== undefined ? new globalThis.AbortController().signal : undefined;
    }
    return this._signal;
  },
  configurable: true
});
Object.defineProperty(Request.prototype, Symbol.toStringTag, { value: 'Request', configurable: true });
Request.prototype.bytes = function () {
  if (this._used) return Promise.reject(new TypeError('Body has already been used.'));
  this._used = true;
  return bodyBuffer(this).then(function (buffer) { return new Uint8Array(buffer); });
};
Request.prototype.text = function () {
  if (this._used) return Promise.reject(new TypeError('Body has already been used.'));
  this._used = true;
  return bodyBuffer(this).then(function (buffer) { return buffer.toString('utf8'); });
};
Request.prototype.json = function () {
  if (this._used) return Promise.reject(new TypeError('Body has already been used.'));
  this._used = true;
  return bodyBuffer(this).then(function (buffer) { return JSON.parse(buffer.toString('utf8')); });
};
Request.prototype.arrayBuffer = function () {
  if (this._used) return Promise.reject(new TypeError('Body has already been used.'));
  this._used = true;
  return bodyBuffer(this).then(function (buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  });
};
Request.prototype.clone = function () {
  if (this._used) throw new TypeError('Request.clone: body has already been used.');
  var copy = new Request(this.url, { method: this.method, headers: this.headers });
  if (this._stream !== null && this._stream !== undefined) {
    var both = this._stream.tee();
    this._stream = both[0];
    copy._stream = both[1];
    this._bytes = null;
  } else {
    copy._bytes = this._bytes;
    copy._pending = this._pending;
  }
  copy._signal = this._signal;
  return copy;
};

/* fetch(target, options): target is a URL string, a URL, or a Request -- a Request carries its own
   method, headers and body, and an option given beside it overrides the one the Request holds. */
function fetch(target, options) {
  var init = options || {};
  if (target instanceof Request) {
    if (target._used) {
      /* not a transport failure, so it travels out of fetch exactly as Node reports it */
      var used = new TypeError('Cannot construct a Request with a Request object that has already been used.');
      Object.defineProperty(used, 'owcNotTransport', { value: true });
      return Promise.reject(used);
    }
    var carried = target._bytes !== null && target._bytes !== undefined
      ? target._bytes
      : (target._stream !== null && target._stream !== undefined
        ? target._stream
        : (target._pending !== null && target._pending !== undefined ? target._pending : null));
    init = { method: target.method, headers: target.headers, body: carried };
    for (var key in options) init[key] = options[key];
    target._used = true;
    target = target.url;
  }
  var url = String(target && target.href !== undefined ? target.href : target);
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
  if (ws.readyState === WS_CLOSED || !ws._socket) return false;
  ws._socket.write(wsMaskFrame(opcode, payload));
  return true;
}

function wsCloseBody(code, reason) {
  var text = typeof reason === 'string' ? reason : '';
  var body = Buffer.alloc(2 + Buffer.byteLength(text));
  body.writeUInt16BE(code, 0);
  if (text !== '') body.write(text, 2, 'utf8');
  return body;
}

function wsDeliverMessage(ws, opcode, bytes) {
  var data;
  if (opcode === 0x1) {
    data = bytes.toString('utf8');
  } else if (ws.binaryType === 'arraybuffer') {
    data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } else if (ws.binaryType === 'nodebuffer' || ws.binaryType === 'buffer') {
    data = bytes;
  } else {
    data = new globalThis.Blob([new Uint8Array(bytes)]);
  }
  ws.emit('message', { type: 'message', data: data, origin: ws.url, lastEventId: '', target: ws });
}

function wsHandleFrame(ws, fin, opcode, payload) {
  if (opcode === 0x8) {
    var code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    var reason = payload.length > 2 ? payload.slice(2).toString('utf8') : '';
    /*
     * Half of a close handshake, whichever side started it: the code and reason are remembered and
     * the peer's frame is answered, but nothing is settled yet. Node holds the socket at CLOSING
     * until the connection itself ends, so a program that waits for close waits for the TCP close,
     * not for the frame -- a server that sends a close frame and keeps the socket leaves the
     * client at readyState 2 for as long as the socket lives.
     */
    ws._closeReceived = code;
    ws._closeReceivedReason = reason;
    if (ws.readyState === WS_OPEN) {
      ws.readyState = WS_CLOSING;
      wsSendFrame(ws, 0x8, wsCloseBody(code, ''));
    }
    return;
  }
  if (opcode === 0x9) { wsSendFrame(ws, 0xa, payload); return; }
  if (opcode === 0xa) return;
  if (opcode === 0x1 || opcode === 0x2) {
    ws._fragOp = opcode;
    ws._frags = [payload];
  } else if (opcode === 0x0 && ws._frags.length > 0) {
    ws._frags.push(payload);
  } else {
    return;
  }
  if (!fin) return;
  var all = ws._frags.length === 1 ? ws._frags[0] : Buffer.concat(ws._frags);
  ws._frags = [];
  wsDeliverMessage(ws, ws._fragOp, all);
}

function wsFeed(ws, buf) {
  while (ws.readyState !== WS_CLOSED) {
    if (buf.length < 2) return buf;
    var b0 = buf[0];
    var b1 = buf[1];
    var fin = (b0 & 0x80) !== 0;
    var opcode = b0 & 0x0f;
    var masked = (b1 & 0x80) !== 0;
    var len = b1 & 0x7f;
    var at = 2;
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
  if (ws._settled) return;
  ws._settled = true;
  ws.readyState = WS_CLOSED;
  if (ws._socket) {
    try { ws._socket.destroy(); } catch (destroyError) {}
    ws._socket = null;
  }
  ws.emit('close', wsCloseEvent(code, reason, clean, ws));
}

function wsSocketGone(ws) {
  if (ws._settled || ws.readyState === WS_CLOSED) return;
  if (ws._closeReceived !== undefined && ws._closeReceived !== null) {
    wsSettle(ws, ws._closeReceived, ws._closeReceivedReason, true);
    return;
  }
  if (ws.listenerCount('error') > 0) {
    ws.emit('error', new Error('The WebSocket connection was closed before a close frame was received.'));
  }
  wsSettle(ws, 1006, '', false);
}

function wsFail(ws, err) {
  if (ws._settled) return;
  /* a listener sees the socket as Node does: already CLOSED, not still connecting */
  ws.readyState = WS_CLOSED;
  if (ws.listenerCount('error') > 0) ws.emit('error', err);
  wsSettle(ws, 1006, '', false);
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

/* Node rejects a URL the way the platform does: a DOMException SyntaxError, not a SyntaxError. */
function wsSyntax(message) {
  if (globalThis.DOMException !== undefined) {
    try {
      return new globalThis.DOMException(message, 'SyntaxError');
    } catch (badException) { /* no DOMException that takes a name: fall through */ }
  }
  return new SyntaxError(message);
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
   * The container's URL leaves a ws: URL written with one slash as it found it, where Node's adds
   * the authority slashes, so 'ws:/x.test/' would keep its single slash and resolve to no host.
   * Adding them here is what makes both spellings the same address.
   */
  var schemeEnd = raw.indexOf(':/');
  if (schemeEnd === 2 || schemeEnd === 3) {
    var scheme = raw.slice(0, schemeEnd).toLowerCase();
    if (scheme === 'ws' || scheme === 'wss') {
      var rest = raw.slice(schemeEnd + 2);
      if (rest.charAt(0) !== '/') raw = scheme + '://' + rest;
    }
  }
  var parsed = null;
  try { parsed = new globalThis.URL(raw); } catch (badUrl) { parsed = null; }
  if (parsed === null) throw wsSyntax('TypeError: Invalid URL');
  /* a ws: URL with no host is no more a URL here than it is in Node, which will not parse one */
  if (parsed.hostname === '') throw wsSyntax('TypeError: Invalid URL');
  if (parsed.hash !== '') throw wsSyntax('hash');
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw wsSyntax('expected a ws: or wss: url');
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

function WebSocket(url, protocols) {
  if (!(this instanceof WebSocket)) return new WebSocket(url, protocols);
  var EventEmitter = requireBuiltin('events');
  EventEmitter.call(this);
  var self = this;
  if (arguments.length < 1) throw new TypeError('WebSocket constructor: 1 argument required, but 0 found.');
  var offered = wsProtocols(protocols);
  var href = wsParseUrl(url);
  var parsed = new globalThis.URL(href);
  var secure = parsed.protocol === 'wss:';
  this.url = href;
  this.protocol = '';
  this.extensions = '';
  this.binaryType = 'blob';
  this.bufferedAmount = 0;
  this.readyState = WS_CONNECTING;
  this._socket = null;
  this._frags = [];
  this._fragOp = 0;
  this._settled = false;
  this._closeCode = undefined;
  this._closeReason = '';
  this._closeReceived = undefined;
  this._closeReceivedReason = '';
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
      wsFail(self, new Error('Server sent an invalid Sec-WebSocket-Accept header'));
      return;
    }
    self._socket = socket;
    if (res.headers['sec-websocket-protocol'] !== undefined) self.protocol = res.headers['sec-websocket-protocol'];
    if (res.headers['sec-websocket-extensions'] !== undefined) self.extensions = res.headers['sec-websocket-extensions'];
    var rest = Buffer.isBuffer(head) ? head : Buffer.from('');
    socket.on('data', function (chunk) {
      rest = wsFeed(self, Buffer.concat([rest, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]));
    });
    socket.on('error', function (err) { if (self.listenerCount('error') > 0) self.emit('error', err); });
    /* the connection ending is what closes the socket: a FIN, or the socket going away */
    socket.on('end', function () { wsSocketGone(self); });
    socket.on('close', function () { wsSocketGone(self); });
    self.readyState = WS_OPEN;
    self.emit('open', { type: 'open', target: self });
    if (rest.length > 0) rest = wsFeed(self, rest);
  });
  req.on('response', function (res) {
    if (res && typeof res.resume === 'function') res.resume();
    wsFail(self, new Error('Unexpected server response: ' + (res ? res.statusCode : 'unknown')));
  });
  req.on('error', function (err) { wsFail(self, err); });
  req.end();
}
WebSocket.prototype = Object.create(requireBuiltin('events').prototype);
Object.defineProperty(WebSocket.prototype, 'constructor', { value: WebSocket, writable: true, configurable: true });

WebSocket.prototype.addEventListener = function addEventListener(type, fn) {
  this.on(String(type), fn);
};
WebSocket.prototype.removeEventListener = function removeEventListener(type, fn) {
  this.removeListener(String(type), fn);
};
WebSocket.prototype.dispatchEvent = function dispatchEvent(event) {
  this.emit(event && event.type, event);
  return true;
};

WebSocket.prototype.send = function send(data) {
  if (this.readyState !== WS_OPEN) {
    var closed = new Error('WebSocket is not open: readyState ' + this.readyState);
    closed.code = 'ERR_INVALID_STATE';
    throw closed;
  }
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
  } else {
    payload = Buffer.from(String(data), 'utf8');
    opcode = 0x1;
  }
  this.bufferedAmount += payload.length;
  var sent = wsSendFrame(this, opcode, payload);
  this.bufferedAmount = 0;
  return sent;
};

WebSocket.prototype.close = function close(code, reason) {
  if (this.readyState === WS_CLOSED || this.readyState === WS_CLOSING) return;
  var num = code === undefined || code === null ? 1000 : Number(code);
  if (num !== 1000 && (num < 3000 || num > 4999)) {
    var bad = new Error('The close code must be either 1000 or in the range 3000 to 4999. Received ' + String(code));
    bad.code = 'ERR_OUT_OF_RANGE';
    throw bad;
  }
  this._closeCode = num;
  this._closeReason = typeof reason === 'string' ? reason : '';
  this.readyState = WS_CLOSING;
  wsSendFrame(this, 0x8, wsCloseBody(num, this._closeReason));
};

WebSocket.CONNECTING = WS_CONNECTING;
WebSocket.OPEN = WS_OPEN;
WebSocket.CLOSING = WS_CLOSING;
WebSocket.CLOSED = WS_CLOSED;

(function () {
  var handlers = ['open', 'message', 'error', 'close'];
  for (var i = 0; i < handlers.length; i++) {
    (function (name) {
      Object.defineProperty(WebSocket.prototype, 'on' + name, {
        configurable: true,
        get: function () { return this['_handler_' + name]; },
        set: function (fn) {
          var previous = this['_handler_' + name];
          if (typeof previous === 'function') this.removeListener(name, previous);
          this['_handler_' + name] = typeof fn === 'function' ? fn : null;
          if (typeof fn === 'function') this.on(name, fn);
        }
      });
    })(handlers[i]);
  }
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
