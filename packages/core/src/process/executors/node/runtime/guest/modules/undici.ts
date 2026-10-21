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

function multipartOf(form) {
  var bytes = requireBuiltin('crypto').randomBytes(24);
  var boundary = '----formdata-owc-';
  for (var i = 0; i < bytes.length; i++) boundary += MULTIPART_CHARS[bytes[i] % MULTIPART_CHARS.length];
  var parts = [];
  var entries = form._entries;
  var at = 0;
  function step() {
    if (at >= entries.length) {
      /* the epilogue: the closing delimiter follows the CRLF that ended the last part */
      parts.push(Buffer.from('--' + boundary + '--\r\n', 'utf8'));
      return Promise.resolve({ payload: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary });
    }
    var entry = entries[at++];
    var head = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + multipartQuote(entry.name) + '"';
    if (isBlobLike(entry.value)) {
      var file = entry.value;
      head += '; filename="' + multipartQuote(file.name === undefined || file.name === '' ? 'blob' : file.name) +
        '"\r\nContent-Type: ' + (file.type || 'application/octet-stream');
    }
    parts.push(Buffer.from(head + '\r\n\r\n', 'utf8'));
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

function bodyBytes(body) {
  if (body === undefined || body === null) return Promise.resolve(null);
  /* a stream needs the duplex option Node requires for one; sending its String() would be garbage */
  if (typeof body.pipe === 'function') {
    return Promise.reject(new TypeError('RequestInit: duplex option is required when sending a body.'));
  }
  if (typeof body === 'string') return Promise.resolve({ payload: Buffer.from(body, 'utf8'), contentType: 'text/plain;charset=UTF-8' });
  if (body instanceof FormData) return multipartOf(body);
  if (globalThis.URLSearchParams !== undefined && body instanceof globalThis.URLSearchParams) {
    return Promise.resolve({ payload: Buffer.from(String(body), 'utf8'), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' });
  }
  if (Buffer.isBuffer(body)) return Promise.resolve({ payload: body });
  if (body instanceof Uint8Array) {
    return Promise.resolve({ payload: Buffer.from(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)) });
  }
  if (isBlobLike(body)) {
    return Promise.resolve(body.arrayBuffer()).then(function (buf) { return { payload: Buffer.from(new Uint8Array(buf)) }; });
  }
  return Promise.resolve({ payload: Buffer.from(String(body), 'utf8') });
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

function Headers(init) {
  this.map = Object.create(null);
  if (!init) return;
  if (typeof init.forEach === 'function' && typeof init.get !== 'function') {
    var self = this;
    init.forEach(function (value, key) { self.append(String(key), String(value)); });
    return;
  }
  for (var key in init) this.append(key, String(init[key]));
}
Headers.prototype.append = function (name, value) {
  var lower = String(name).toLowerCase();
  if (this.map[lower] === undefined) this.map[lower] = String(value);
  else this.map[lower] = this.map[lower] + ', ' + String(value);
};
Headers.prototype.set = function (name, value) { this.map[String(name).toLowerCase()] = String(value); };
Headers.prototype.get = function (name) {
  var value = this.map[String(name).toLowerCase()];
  return value === undefined ? null : value;
};
Headers.prototype.has = function (name) { return this.map[String(name).toLowerCase()] !== undefined; };
Headers.prototype.delete = function (name) { delete this.map[String(name).toLowerCase()]; };
Headers.prototype.forEach = function (fn) {
  for (var key in this.map) fn(this.map[key], key, this);
};

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

function Response(body, init) {
  init = init || {};
  this.status = init.status === undefined ? 200 : init.status;
  this.statusText = init.statusText === undefined ? '' : init.statusText;
  this.ok = this.status >= 200 && this.status < 300;
  this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
  this.url = init.url === undefined ? '' : init.url;
  /* A Buffer body -- what fetch hands it -- is kept as bytes: the body property decodes it the
     first time something reads it and arrayBuffer hands the bytes straight back, so a large
     response crosses no codec unless its text is asked for. Any other body behaves as it did. */
  if (Buffer.isBuffer(body)) {
    var bytes = body;
    var decoded;
    Object.defineProperty(this, '_bytes', { value: bytes, writable: true, enumerable: false, configurable: true });
    Object.defineProperty(this, 'body', {
      enumerable: true,
      configurable: true,
      get: function () {
        if (decoded === undefined) decoded = bytes.toString('utf8');
        return decoded;
      },
      set: function (value) {
        this._bytes = undefined;
        decoded = value === undefined || value === null ? '' : String(value);
      }
    });
  } else {
    this.body = body === undefined || body === null ? '' : String(body);
  }
}
Response.prototype.text = function () { return Promise.resolve(this.body); };
Response.prototype.json = function () { return Promise.resolve(JSON.parse(this.body)); };
Response.prototype.arrayBuffer = function () {
  return Promise.resolve(this._bytes === undefined ? Buffer.from(this.body, 'utf8') : Buffer.from(this._bytes));
};
Response.prototype.clone = function () {
  var body = this._bytes === undefined ? this.body : this._bytes;
  return new Response(body, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url });
};

function Request(target, options) {
  options = options || {};
  this.url = String(target && target.href !== undefined ? target.href : target);
  this.method = (options.method || 'GET').toUpperCase();
  this.headers = options.headers instanceof Headers ? options.headers : new Headers(options.headers);
  this._body = options.body === undefined || options.body === null ? null : options.body;
  this._used = false;
}
Object.defineProperty(Request.prototype, 'bodyUsed', {
  get: function () { return this._used; },
  configurable: true
});
Request.prototype.text = function () {
  if (this._used) return Promise.reject(new TypeError('Body has already been used.'));
  this._used = true;
  var body = this._body;
  if (body === null) return Promise.resolve('');
  if (typeof body === 'string') return Promise.resolve(body);
  if (isBlobLike(body)) return Promise.resolve(body.text());
  return Promise.resolve(String(body));
};
Request.prototype.json = function () {
  return this.text().then(function (text) { return JSON.parse(text); });
};
Request.prototype.arrayBuffer = function () {
  return this.text().then(function (text) { return Buffer.from(text, 'utf8'); });
};
Request.prototype.clone = function () {
  var copy = new Request(this.url, { method: this.method, headers: this.headers, body: this._body });
  copy._used = this._used;
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
    init = { method: target.method, headers: target.headers, body: target._body };
    for (var key in options) init[key] = options[key];
    target._used = true;
    target = target.url;
  }
  var url = String(target && target.href !== undefined ? target.href : target);
  return request(url, init).then(function (res) {
    return new Response(res.body.buffer, { status: res.statusCode, statusText: res.statusText, headers: res.headers, url: url });
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
    if (ws.readyState === WS_OPEN) {
      ws.readyState = WS_CLOSING;
      wsSendFrame(ws, 0x8, wsCloseBody(code, ''));
    }
    wsSettle(ws, code, reason, true);
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

function wsSettle(ws, code, reason, clean) {
  if (ws.readyState === WS_CLOSED) return;
  ws.readyState = WS_CLOSED;
  if (ws._socket) {
    try { ws._socket.destroy(); } catch (destroyError) {}
    ws._socket = null;
  }
  ws.emit('close', { type: 'close', code: code, reason: reason, wasClean: !!clean, target: ws });
}

function wsFail(ws, err) {
  if (ws.readyState === WS_CLOSED) return;
  if (ws.listenerCount('error') > 0) ws.emit('error', err);
  wsSettle(ws, 1006, '', false);
}

function WebSocket(url, protocols) {
  if (!(this instanceof WebSocket)) return new WebSocket(url, protocols);
  var EventEmitter = requireBuiltin('events');
  EventEmitter.call(this);
  var self = this;
  var parsed = null;
  try { parsed = new globalThis.URL(String(url)); } catch (badUrl) { parsed = null; }
  if (parsed === null || (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')) {
    throw new SyntaxError('Failed to construct \'WebSocket\': The URL \'' + String(url) + '\' is invalid.');
  }
  var secure = parsed.protocol === 'wss:';
  this.url = String(url);
  this.protocol = '';
  this.extensions = '';
  this.binaryType = 'blob';
  this.bufferedAmount = 0;
  this.readyState = WS_CONNECTING;
  this._socket = null;
  this._frags = [];
  this._fragOp = 0;
  this._closeCode = undefined;
  this._closeReason = '';
  var offered = protocols === undefined || protocols === null
    ? []
    : (Array.isArray(protocols) ? protocols : [String(protocols)]);
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
    socket.on('close', function () {
      wsSettle(self, self._closeCode === undefined ? 1006 : self._closeCode, self._closeReason, self._closeCode !== undefined);
    });
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
