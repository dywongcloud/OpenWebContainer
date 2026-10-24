/**
 * Guest source for the net family: `net` and `dgram`, carried over the in-container
 * virtual network (network/virtual/hub.ts) through the net.* capabilities.
 *
 * Limits, stated plainly:
 * - Real outbound TCP and UDP is impossible from a browser. Traffic stays inside the container:
 *   loopback between its processes, plus names in the virtual name table. Connecting or sending
 *   to any other address fails with ENETUNREACH (UDP sends are dropped).
 * - Names other than localhost and registered names go through the 'dns.lookup' capability;
 *   without one they fail with ENOTFOUND.
 * - `tls` is a separate family (tls.ts, over the engine in tls-engine.ts); its sockets extend
 *   net.Socket and reuse the hub hooks defined here (_onConnectEvent, _onChunk, _onRemoteEnd,
 *   _onRemoteClose, _sendChunk, _sendEnd, _readQueue, _scheduleRead).
 * - net.Socket extends stream.Duplex when the stream family is registered when `net` is first
 *   required; otherwise it is a self-contained EventEmitter with the same surface.
 * - dgram accepts multicast, broadcast and reuse options but implements none of them. Two
 *   sockets cannot share a UDP port.
 * - Unix domain sockets are carried by path in the hub: `listen('/tmp/x')` and `connect('/tmp/x')`
 *   meet there and a unix connection reports no address at either end, as Node's does. No inode is
 *   created at the path, so the container's filesystem shows nothing there and a bind under a
 *   directory that does not exist is not the host's EACCES.
 *
 * Plain JavaScript inside a String.raw snippet. Each family registers BF.net, BF.dgram.
 */
export const SRC = String.raw`
(function () {
var NET_REASON_TEXT = { EADDRINUSE: 'address already in use', EADDRNOTAVAIL: 'address not available', EINVAL: 'invalid argument' };

/* node's own diagnostics channels: the publish path lives in the diagnostics_channel family,
   whose snippet is an IIFE of its own, so it reaches this one through a global name. */
function dcPublish(name, data) {
  var publish = globalThis.__owcDcPublish;
  if (publish !== undefined) publish(name, data);
}


/** What a loopback socket absorbs before a write is still in flight when it is destroyed: Node's SO_SNDBUF. */
var NET_SNDBUF = 262144;

/**
 * The buffer sizes host Node 24.15 reads off a socket of this platform's that nobody has set one on:
 * 786896 bytes to receive and 9216 to send, the same two figures on every dgram socket it opens here.
 */
var DGRAM_RECV_BUFFER_SIZE = 786896;
var DGRAM_SEND_BUFFER_SIZE = 9216;

/**
 * The most a buffer size this platform's kernel will hold: a setter is free to ask for more and the
 * kernel accepts it, but the socket then reports this figure, so setRecvBufferSize(2147483647)
 * followed by getRecvBufferSize() answers 8388608 on host Node 24.15 for either direction.
 */
var DGRAM_MAX_BUFFER_SIZE = 8388608;

/**
 * One piece of a socket write, and the most a socket delivers in one read.
 *
 * Measured over 4 KiB to 4 MiB per write, 16 MiB end to end: a write goes fastest in pieces of
 * 64 KiB -- 761 MiB/s against 410 at 16 KiB, 116 at 4 KiB, 163 at 1 MiB and 58 at 4 MiB, because a
 * piece bigger than one buffer is copied across the bridge in one call that grows with the piece
 * while a smaller one pays the crossing once per piece -- and one write carrying a whole 16 MiB
 * body costs 1095 ms against 21 ms for the same bytes in pieces of it. Host Node hands a reader
 * the same upper bound: its reads of a 16 MiB transfer arrive as ~64 KiB, whatever size the peer
 * wrote, so a read capped here lands where the host lands too.
 */
var NET_CHUNK = 65536;

function netError(Ctor, code, message) {
  var err = new Ctor(message);
  err.code = code;
  return err;
}

function netDefer(fn) {
  queueMicrotask(fn);
}

function netEmitterBase() {
  var base = requireBuiltin('events');
  return typeof base === 'function' ? base : base.EventEmitter;
}

function netDuplexBase() {
  try {
    var streamModule = requireBuiltin('stream');
    return streamModule && typeof streamModule.Duplex === 'function' ? streamModule.Duplex : null;
  } catch (failure) {
    return null;
  }
}

function netDescribe(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return 'an instance of ' + ((value.constructor && value.constructor.name) || 'Object');
  if (typeof value === 'string') return "type string ('" + value + "')";
  /* A BigInt keeps the 'n' Node prints it with: 'type bigint (24n)', not 'type bigint (24)'. */
  if (typeof value === 'bigint') return 'type bigint (' + String(value) + 'n)';
  /* A function is the one type Node names without 'type' and without a rendering: 'Received
     function foo', and 'Received function ' for one with no name at all, trailing space included,
     where every other type carries its own value in parentheses. */
  if (typeof value === 'function') return 'function ' + (typeof value.name === 'string' ? value.name : '');
  return 'type ' + typeof value + ' (' + String(value) + ')';
}

/**
 * Renders a value the way Node's inspect does it in an ERR_INVALID_ARG_VALUE message -- the whole
 * options object is named, not just the property at fault: "The argument 'options' is invalid.
 * Received { path: 123 }".
 */
function netInspectValue(value, depth) {
  if (typeof value === 'string') return "'" + value + "'";
  if (typeof value === 'function') return '[Function' + (value.name ? ': ' + value.name : '') + ']';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Buffer.isBuffer(value)) {
    var hex = [];
    for (var b = 0; b < value.length; b++) hex.push(('0' + value[b].toString(16)).slice(-2));
    return '<Buffer' + (hex.length > 0 ? ' ' + hex.join(' ') : '') + '>';
  }
  if (typeof value !== 'object') return String(value);
  if (depth > 2) return Array.isArray(value) ? '[Array]' : '[Object]';
  var parts = [];
  for (var key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) parts.push(key + ': ' + netInspectValue(value[key], depth + 1));
  }
  if (Array.isArray(value)) return '[ ' + parts.join(', ') + ' ]';
  return parts.length === 0 ? '{}' : '{ ' + parts.join(', ') + ' }';
}

function netIsIPv4(value) {
  return typeof value === 'string' && /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(value);
}

function netIsIPv6(value) {
  if (typeof value !== 'string' || value.indexOf(':') === -1) return false;
  /* A zone (scope) id is part of a literal, not part of a name: Node's isIPv6 answers 6 for
     '::1%lo0' and 0 for a '%' with nothing after it, and a socket dialling the scoped literal
     connects to the address the zone is attached to ('::1'), which is what it then reports. */
  var zoneAt = value.indexOf('%');
  if (zoneAt !== -1) {
    if (zoneAt === value.length - 1) return false;
    value = value.slice(0, zoneAt);
  }
  var halves = value.split('::');
  if (halves.length > 2) return false;
  var groups = 0;
  for (var h = 0; h < halves.length; h++) {
    var parts = halves[h] === '' ? [] : halves[h].split(':');
    for (var p = 0; p < parts.length; p++) {
      var part = parts[p];
      var isTail = h === halves.length - 1 && p === parts.length - 1;
      if (isTail && part.indexOf('.') !== -1) {
        if (!netIsIPv4(part)) return false;
        groups += 2;
      } else if (/^[0-9a-fA-F]{1,4}$/.test(part)) {
        groups += 1;
      } else {
        return false;
      }
    }
  }
  return halves.length === 2 ? groups < 8 : groups === 8;
}

function netIsIP(value) {
  return netIsIPv4(value) ? 4 : netIsIPv6(value) ? 6 : 0;
}

function netFamilyName(address) {
  return netIsIPv6(address) ? 'IPv6' : 'IPv4';
}

function netPortOf(value, listen) {
  var port = typeof value === 'string' && value !== '' ? Number(value) : value;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    /* A server's own refusal names the option it was given, where every other caller -- a connect,
       a dgram bind -- names the port itself: 'options.port should be >= 0 and < 65536. Received
       type string ('')' against 'Port should be >= 0 and < 65536. Received type number (70000).' */
    throw netError(RangeError, 'ERR_SOCKET_BAD_PORT',
      (listen ? 'options.port' : 'Port') + ' should be >= 0 and < 65536. Received '
      + netDescribe(value) + '.');
  }
  return port;
}

function netToBuffer(chunk, encoding) {
  if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  if (Buffer.isBuffer(chunk)) return chunk;
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
    'The "chunk" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ' + netDescribe(chunk));
}

/** Index up to which a UTF-8 buffer holds only complete characters (the rest is an incomplete sequence). */
function netUtf8Cut(buf) {
  var n = buf.length;
  var i = n - 1;
  for (var back = 0; back < 4 && i >= 0; back++, i--) {
    var b = buf[i];
    if ((b & 0xC0) === 0x80) continue;
    var need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1;
    return n - i < need ? i : n;
  }
  return n;
}

/** Checks a buffer size the way Node does: the socket must be running, the size a plain integer. */
/**
 * The state a dgram buffer size is read or written in. Host Node 24.15 answers from two different
 * ones: an unbound socket has no descriptor to read or set a size on, so it is EBADF, while a closed
 * one has had its handle nulled and Node dereferences it, throwing a TypeError with V8's own text
 * rather than the error it throws for an unbound socket.
 */
/**
 * The class host Node 24.15 reports as the constructor of every error it raises itself: V8 calls it
 * NodeError, whatever the error's own 'name', and a guest error has to carry the same one for
 * 'err.constructor.name' to read the way a host's does.
 */
var NET_NODE_ERROR = function NodeError() {};

/**
 * The error host Node 24.15 throws when the buffer-size operation itself fails: a 'SystemError'
 * carrying the libuv call that failed and the errno it answered with -- EBADF (-9) for a socket with
 * no descriptor behind it, EINVAL (-22) for a size the kernel refuses to hold.
 */
function netBufferError(syscall, name, errno) {
  var err = netError(Error, 'ERR_SOCKET_BUFFER_SIZE',
    'Could not get or set buffer size: ' + syscall + ' returned ' + name + ' (' + NET_BUFFER_REASON[name] + ')');
  err.name = 'SystemError';
  err.constructor = NET_NODE_ERROR;
  err.errno = errno;
  err.syscall = syscall;
  return err;
}

/** The reason text Node prints for the errno a buffer-size call answered with. */
var NET_BUFFER_REASON = { EBADF: 'bad file descriptor', EINVAL: 'invalid argument' };

function netBufferState(socket, syscall) {
  if (socket._dead) throw new TypeError("Cannot read properties of null (reading 'bufferSize')");
  if (!socket._bound) throw netBufferError(syscall, 'EBADF', -9);
}

/**
 * Validates a buffer size the way Node 24.15 validates one. Three bands, each with its own answer:
 * a size that is not an integer, is negative, or will not fit in a 32-bit word is refused before the
 * kernel ever sees it ('ERR_SOCKET_BAD_BUFFER_SIZE', a TypeError, whose text names a positive integer
 * even though 0 passes it); one from 2^31 to 2^32-1 reaches libuv and comes back EINVAL, because the
 * size is handed to the kernel as a signed 32-bit int and overflows it; and everything from 0 to
 * 2^31-1 is accepted, the kernel clamping what it holds to 8388608.
 */
function netBufferSize(socket, size, syscall) {
  netBufferState(socket, syscall);
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > 4294967295) {
    throw netError(TypeError, 'ERR_SOCKET_BAD_BUFFER_SIZE', 'Buffer size must be a positive integer');
  }
  if (size > 2147483647) throw netBufferError(syscall, 'EINVAL', -22);
}

/**
 * The two errors host Node 24.15 raises for a dgram option this socket cannot carry. One that is
 * no longer running has had its handle nulled, so Node dereferences it and V8 throws its own
 * TypeError -- "Cannot read properties of null (reading 'setTTL')" -- where one that is merely
 * unbound reaches libuv and comes back with the errno the kernel answered with.
 */
function netDgramGone(name) {
  return new TypeError("Cannot read properties of null (reading '" + name + "')");
}

/** uv's own answer for an option it refused: a SystemError naming the call and its errno. */
function netDgramUvError(name, code, errno) {
  var err = netError(Error, code, name + ' ' + code);
  err.errno = errno;
  err.syscall = name;
  return err;
}

/** An argument Node reads with validateNumber / validateString: anything else is refused by type. */
function netDgramArg(value, name, want) {
  if (typeof value !== want) {
    throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
      'The "' + name + '" argument must be of type ' + want + '. Received ' + netDescribe(value));
  }
}

/** A whole byte as libuv truncates what it was handed: 255.5 is 255, 0.5 is 0, and NaN stays NaN. */
function netDgramByte(value) {
  return value >= 0 ? Math.floor(value) : Math.ceil(value);
}

/**
 * A value as libuv hands it to a syscall that takes an int: ToInt32, so a value that is not finite
 * becomes 0 and one outside the 32-bit word wraps into it -- NaN, Infinity and 2^53 are all the 0
 * a hop count of 0 is, which is what makes setMulticastTTL(NaN) succeed where setTTL(NaN) is the
 * EINVAL a hop count of 0 is not.
 */
function netDgramInt32(value) {
  var whole = Number(value);
  if (whole !== whole || whole === Infinity || whole === -Infinity) return 0;
  whole = Math.trunc(whole) % 4294967296;
  if (whole < 0) whole += 4294967296;
  if (whole >= 2147483648) whole -= 4294967296;
  return whole;
}

/**
 * The fault host Node 24.15 reports for a multicast address a socket cannot join, or null for one
 * it can: a text no family can hold, and one of the family this socket is not, are each EINVAL
 * (-22), as is an address outside the block the family keeps for multicast -- 224.0.0.0/4 for
 * IPv4 and ff00::/8 for IPv6. The IPv6 block is checked only where the host checks it: leaving a
 * group refuses an address outside it, where joining one reaches the kernel and answers for it.
 */
function netDgramMulticastFault(text, want6, checkV6) {
  var family = typeof text === 'string' ? netIsIP(text) : 0;
  if (family === 0 || (family === 6) !== want6) return 'EINVAL';
  if (family === 4) {
    var first = Number(text.split('.')[0]);
    if (!(first >= 224 && first <= 239)) return 'EINVAL';
  } else if (checkV6) {
    /* ff00::/8 is the prefix, so the first group alone says it: ff02::1 is one and ::1 is not. */
    if (!/^ff[0-9a-fA-F]{0,2}/.test(text)) return 'EINVAL';
  }
  return null;
}

/** Address shown for a listener: no host means the IPv6 wildcard, as Node does on a dual-stack host. */
function netListenDisplay(host) {
  if (host === undefined || host === null || host === '' || host === '::') return '::';
  if (host === 'localhost') return '127.0.0.1';
  return String(host);
}

/**
 * Address passed to the hub: the IPv4 wildcard becomes '' (every local address), and the IPv6 one
 * stays '::' -- the hub folds both to '', so its own text is the only thing that tells the two apart,
 * and they differ in what they accept: '::' is dual-stack and takes an IPv4 client (delivered to the
 * accepted socket as '::ffff:<v4>'), where '0.0.0.0' takes none.
 */
function netListenHub(host) {
  var shown = netListenDisplay(host);
  return shown === '0.0.0.0' ? '' : shown;
}

/**
 * The address a listener reports for itself, which is not always the literal it was handed: the
 * IPv4-mapped wildcard '::ffff:0.0.0.0' is bound as the wildcard and host Node 24.15 answers
 * address() '::'/IPv6 for it, not the mapped literal. The hub still needs the literal, so only the
 * reported text is rewritten.
 */
function netListenShown(text) {
  return typeof text === 'string' && text.toLowerCase() === '::ffff:0.0.0.0' ? '::' : text;
}

/**
 * Cuts the zone (scope) id off an IPv6 literal ('::1%lo0' -> '::1'). A zone says which interface a
 * link-local address means, not which host it is: a host's kernel binds and dials the address the
 * zone is attached to, and its getsockname and getpeername report that address with no zone on it.
 */
function netStripZone(text) {
  if (typeof text !== 'string') return text;
  var at = text.indexOf('%');
  return at === -1 ? text : text.slice(0, at);
}

/** A Node-shaped system error: 'listen EADDRINUSE: address already in use 127.0.0.1:80', 'connect ECONNREFUSED ...'. */
function netSystemError(cause, syscall, address, port) {
  var code = cause && typeof cause.code === 'string' ? cause.code : 'ERR_NET_FAILURE';
  /* Port -1 is what host Node reports on a unix bind that failed: it names no port, so none is
     printed in the message, but err.port still carries it. */
  var where = port === undefined || port < 0 ? address : address + ':' + port;
  /* Port 0 is not a destination, so the kernel's EADDRNOTAVAIL names no peer port: Node reports
     'connect EADDRNOTAVAIL 127.0.0.1' and leaves err.port unset. (Node appends the local address
     its socket had already bound, '- Local (0.0.0.0:53326)', whose port is the host's own
     ephemeral choice; no other implementation can print the same one.) */
  var unnamed = syscall === 'connect' && code === 'EADDRNOTAVAIL';
  var text;
  if (syscall === 'listen' && NET_REASON_TEXT[code]) {
    text = 'listen ' + code + ': ' + NET_REASON_TEXT[code] + ' ' + where;
  } else if (syscall === 'getaddrinfo') {
    text = 'getaddrinfo ' + code + ' ' + address;
  } else if (unnamed) {
    text = 'connect ' + code + ' ' + address;
  } else {
    text = syscall + ' ' + code + ' ' + where;
  }
  var err = new Error(text);
  err.errno = cause && typeof cause.errno === 'number' ? cause.errno : undefined;
  err.code = code;
  err.syscall = syscall;
  if (syscall === 'getaddrinfo') {
    err.hostname = address;
  } else {
    err.address = address;
    if (!unnamed && port !== undefined) err.port = port;
  }
  return err;
}

/**
 * The error host Node 24.15 reports for a connect a socket has already made (EISCONN) or one still in
 * flight (EALREADY). Its text names the destination and, for an internet one, the local end the
 * socket had already bound -- 'connect EISCONN 127.0.0.1:8080 - Local (127.0.0.1:53326)' -- while a
 * path names itself and no local end, because a unix socket has none.
 */
function netConnectAgainError(socket, code, args) {
  var path = args.path === undefined ? undefined : String(args.path);
  var where = path !== undefined ? path : String(args.host) + ':' + netPortOf(args.port);
  var local = path !== undefined ? '' : ' - Local (' + socket.localAddress + ':' + socket.localPort + ')';
  var err = new Error('connect ' + code + ' ' + where + local);
  err.errno = code === 'EALREADY' ? -37 : -56;
  err.code = code;
  err.syscall = 'connect';
  if (path === undefined) {
    err.address = String(args.host);
    err.port = netPortOf(args.port);
  }
  return err;
}

/** What Node hands back when every address of a name refused: an AggregateError of the attempts. */
function netAggregate(failures) {
  var first = failures[0];
  var code = first && typeof first.code === 'string' ? first.code : 'ERR_NET_FAILURE';
  if (typeof AggregateError !== 'function') return netError(Error, code, '');
  var err = new AggregateError(failures, '');
  err.code = code;
  return err;
}

/** Keeps the event loop alive while a server, socket or datagram socket is open and referenced. */
function netRefresh(owner) {
  var want = !!owner._refed && owner._holdable();
  if (want === owner._holding) return;
  owner._holding = want;
  holdRef(want ? 1 : -1);
}

/**
 * Every address a connect tries, in the order Node tries them, or null when the name has to be
 * resolved first. A loopback name is dual-stack: getaddrinfo answers '::1' before '127.0.0.1' on a
 * dual-stack host and Node attempts each in turn, so connecting to 'localhost' -- or to no host at
 * all, which means 'localhost' -- is two attempts, and failing both is an AggregateError.
 */
/** The name a connect asks about: a host that is not named at all is 'localhost', as Node's own default is. */
/**
 * One 'lookup' event, the announcement Node makes between resolving a name and dialling it: the
 * address and the family that address is of, or the error when the name answered none, and the
 * host that was asked for either way. A host makes it from the DNS callback, so it never lands
 * in the turn that asked for it -- a listener attached after createConnection() returns still
 * hears it.
 */
function netEmitLookup(socket, address, family, name) {
  netDefer(function () { socket.emit('lookup', null, address, family, name); });
}
function netEmitLookupMiss(socket, failure, name) {
  netDefer(function () { socket.emit('lookup', failure, null, null, name); });
}

function netConnectHost(host) {
  var name = host === undefined || host === null || host === '' ? 'localhost' : String(host);
  return name;
}

function netConnectList(host, family) {
  var name = netConnectHost(host);
  if (netIsIP(name)) return [name];
  if (name.toLowerCase() !== 'localhost') return null;
  if (family === 6) return ['::1'];
  if (family === 4) return ['127.0.0.1'];
  return ['::1', '127.0.0.1'];
}

/**
 * The error host Node 24.15 reports for a name getaddrinfo cannot answer: ENOTFOUND, and carrying
 * libuv's own errno for it, UV_EAI_NONAME (-3008), which is the figure a host's 'err.errno' reads
 * on a connect to a name that does not resolve.
 */
function netNotFound(name) {
  return netSystemError({ code: 'ENOTFOUND', errno: -3008 }, 'getaddrinfo', name);
}

/**
 * Whether an address is one this host's own loopback answers to, and so one a socket may be bound
 * to: the loopback and the wildcard of either family. Anything else is EADDRNOTAVAIL, which is what
 * a host's bind answers for an address no interface of its holds ('bind EADDRNOTAVAIL 8.8.8.8').
 */
function netOwnAddress(address) {
  if (netIsIP(address) === 6) return address === '::' || address === '::1';
  return address === '0.0.0.0' || address.indexOf('127.') === 0;
}

/* Host node builds its resolver channel the first time anything asks the resolver for an address --
   before it takes the IP-literal fast path, which is why a listen on '127.0.0.1' alone is enough to
   make one -- and reports it once as a DNSCHANNEL. It is one channel for the life of the process, so
   it is made once and never closed here: a host destroys its own at the exit of the process, and this
   container reports nothing of that. */
var netDnsChannelMade = false;
function netDnsChannel() {
  if (netDnsChannelMade) return;
  netDnsChannelMade = true;
  asyncOpenResource('DNSCHANNEL', {});
}

/** Resolves a host to an address: IP literals and the name table synchronously, other names via dns.lookup. */
function netResolve(host, family, done, lookup) {
  netDnsChannel();
  var name = host === undefined || host === null || host === '' ? 'localhost' : String(host);
  if (netIsIP(name)) {
    done(null, name);
    return;
  }
  if (typeof lookup === 'function') {
    // The caller's lookup is asked as Node asks it (all: true): a list of {address, family}. A bare address is refused.
    var answered = false;
    var answer = function (failure, found) {
      if (answered) return;
      answered = true;
      if (failure) {
        done(failure);
        return;
      }
      var entry = Array.isArray(found) ? found[0] : undefined;
      if (entry && typeof entry.address === 'string' && netIsIP(entry.address)) done(null, entry.address);
      /* Node asked for a list, so anything that is not one has no address to report and names the
         one it read -- undefined -- which is the text host Node 24.15 prints for a lookup that
         answered a bare string. It is a TypeError, as every ERR_INVALID_IP_ADDRESS of Node's is. */
      else done(netError(TypeError, 'ERR_INVALID_IP_ADDRESS',
        'Invalid IP address: ' + String(entry && entry.address)));
    };
    try {
      lookup(name, { family: family || 0, hints: 0, all: true }, answer);
    } catch (failure) {
      answer(failure);
    }
    return;
  }
  var mapped = null;
  try {
    mapped = callCap('net.resolveHost', { name: name });
  } catch (failure) {
    /* A container that carries no /etc/hosts raises ENOENT for the file while reading it. That says
       only that this name is not one the table can answer -- it is not a failure of the connect --
       so the name falls through to dns.lookup, exactly as any other unknown name does. */
    mapped = null;
  }
  if (typeof mapped === 'string') {
    done(null, mapped);
    return;
  }
  callOp('dns.lookup', { hostname: name, family: family || 0 }).then(function (found) {
    if (found && typeof found.address === 'string') done(null, found.address);
    else done(netNotFound(name));
  }, function () {
    done(netNotFound(name));
  });
}

function netConnectArgs(args) {
  var list = Array.prototype.slice.call(args);
  var cb = typeof list[list.length - 1] === 'function' ? list.pop() : undefined;
  var first = list[0];
  if (first !== null && typeof first === 'object') {
    return { port: first.port, host: first.host, family: first.family, localPort: first.localPort,
      localAddress: first.localAddress, lookup: first.lookup, path: first.path, cb: cb };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) {
    /* A pipe path is a destination this runtime cannot open. Node does not throw it either: the
       socket reports the failure as an asynchronous 'error' (ENOENT), which connect() delivers. */
    return { path: first, cb: cb };
  }
  return { port: first, host: typeof list[1] === 'string' ? list[1] : undefined, cb: cb };
}

/**
 * The unix domain socket path an argument names, or undefined for a port or a host. Node's rule is
 * isPipeName: a string that is neither a number it can read as a port nor an internet address is a
 * pipe path, separator or not, so a listen of 'x.sock', 'localhost' or 'abc' binds a socket of that
 * name in the working directory, which is what host Node 24.15 reports -- where demanding a '/'
 * read them as a port and refused them ERR_SOCKET_BAD_PORT. An IP literal is the one exception this
 * runtime has to make: a name and a path reach the hub as the same field, so '::1' has to stay the
 * address a bind of that name asks for rather than becoming a file called '::1'.
 */
function netIsPath(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  if (netIsIP(value) !== 0) return undefined;
  var asNumber = Number(value);
  if (!Number.isNaN(asNumber) && asNumber >= 0) return undefined;
  return value;
}

function netListenArgs(args) {
  var list = Array.prototype.slice.call(args);
  var cb = typeof list[list.length - 1] === 'function' ? list.pop() : undefined;
  var first = list[0];
  if (first !== null && typeof first === 'object') {
    return { port: first.port, host: first.host, path: first.path, ipv6Only: first.ipv6Only, cb: cb };
  }
  var asPath = netIsPath(first);
  if (asPath !== undefined) return { path: asPath, cb: cb };
  return { port: first, host: typeof list[1] === 'string' ? list[1] : undefined, cb: cb };
}

function netBindArgs(args) {
  var list = Array.prototype.slice.call(args);
  var cb = typeof list[list.length - 1] === 'function' ? list.pop() : undefined;
  var first = list[0];
  if (first !== null && typeof first === 'object') {
    return { port: first.port, address: first.address, cb: cb };
  }
  return { port: first, address: typeof list[1] === 'string' ? list[1] : undefined, cb: cb };
}

BF['net'] = function () {
  var EventEmitter = netEmitterBase();
  var DuplexBase = netDuplexBase();
  var duplexMode = DuplexBase !== null;
  var baseAddListener = EventEmitter.prototype.addListener || EventEmitter.prototype.on;
  /* The auto-select-family defaults Node starts with: true, and a 250 ms attempt timeout. Both are
     kept here so the setter that names one is the value the getter later answers with. */
  var NET_AUTO_SELECT_FAMILY = true;
  var NET_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT = 250;

  class Socket extends (duplexMode ? DuplexBase : EventEmitter) {
    constructor(options) {
      var opts = options || {};
      if (duplexMode) {
        super({ allowHalfOpen: !!opts.allowHalfOpen, readable: true, writable: true });
      } else {
        super();
      }
      this.connecting = false;
      this.allowHalfOpen = !!opts.allowHalfOpen;
      this.bytesRead = 0;
      this.bytesWritten = 0;
      this.localAddress = undefined;
      this.localPort = undefined;
      this.localFamily = undefined;
      /* The peer's end is not a field of this socket but a reading of the handle, which is gone
         once the socket is -- and host Node 24.15 keeps what a caller first read of it, so a
         socket asked for its peer before it was destroyed still names that peer afterwards, while
         one never asked reports undefined. The live reading and the remembered one are separate. */
      netHide(this, '_remoteName', undefined);
      netHide(this, '_remoteCache', undefined);
      this._hubId = undefined;
      this._targetId = undefined;
      this._dead = false;
      this._rEnded = false;
      this._wEnded = false;
      this._wFinished = false;
      this._hubClosed = false;
      this._closePending = false;
      /* Set when the peer's own end-of-stream is what ended this side (allowHalfOpen false), which is
         the one case in which Node replaces socket.write: a write past that end is EPIPE, while a
         write past an end this side asked for is the stream's own 'write after end'. */
      this._finEnded = false;
      this._refed = true;
      this._holding = false;
      this._connectStarted = false;
      this._endRequested = false;
      this._pendingWrites = [];
      this._writeCbs = [];
      this._readQueue = [];
      /* Bytes handed to the hub and not delivered yet: what socket.bufferSize counts (see _accountSent). */
      this._unsentBytes = 0;
      this._unsentTimer = null;
      this._flowing = undefined;
      this._encoding = null;
      this._carry = null;
      /* Undefined, not 0: socket.timeout is undefined until a setTimeout sets it, and a socket with
         no timeout must not look like one carrying a zero timeout. */
      this._idleMs = undefined;
      this._idleTimer = null;
      this._readTimer = null;
      this._serverRef = undefined;
      if (duplexMode) {
        // The lifecycle is owned here, not left to the stream's autoDestroy: once both sides have
        // ended, the socket is destroyed (which closes the hub connection and emits 'close').
        var self = this;
        this.on('end', function () {
          self._rEnded = true;
          /* Node swaps socket.write for its writeAfterFIN here, whatever the writable side was
             doing, so a later write past that end reports the peer, not the stream. */
          if (!self.allowHalfOpen) self._finEnded = true;
          // Node ends the writable side on a later tick, after the 'end' listeners have run, so a listener can still reply.
          if (!self.allowHalfOpen) {
            netDefer(function () {
              if (!self._dead && !self.writableEnded) self.end();
            });
          }
          // Teardown waits for the 'end' listeners the caller added after this one, as Node orders them.
          if (self._closePending) {
            netDefer(function () {
              if (!self._dead) self.destroy();
            });
            return;
          }
          self._maybeFinish();
        });
        this.on('finish', function () {
          self._wFinished = true;
          self._maybeFinish();
        });
      }
    }

    get readyState() {
      if (this.connecting) return 'opening';
      if (this._dead) return 'closed';
      var canRead = duplexMode ? this.readable : !this._rEnded;
      var canWrite = duplexMode ? this.writable : !this._wEnded;
      if (canRead && canWrite) return 'open';
      if (canRead) return 'readOnly';
      if (canWrite) return 'writeOnly';
      return 'closed';
    }

    /* Node reports a socket that has no connection behind it -- one never asked to connect, one still
       connecting, or one destroyed -- and stops reporting it once the connection is there. The hub id
       alone is not enough: it is assigned when the connect starts, so a socket mid-connect would read
       as settled. */
    get pending() {
      return this._dead || this.connecting || this._hubId === undefined;
    }

    /** The idle timeout in milliseconds, or undefined while none has been set, as Node reports it. */
    get timeout() {
      return this._idleMs;
    }

    /**
     * Bytes written but not yet acknowledged, the way Node counts a socket's unsent queue: what this
     * socket has handed the hub and the hub has not delivered to the peer yet, plus what a write made
     * before the socket had a connection is still holding.
     *
     * The hub delivers on a later macrotask, so a burst of writes is counted in full until the turn
     * that delivers it -- and it drains on that turn even when the peer never reads, because this
     * virtual network has no finite send buffer to fill: the bytes reach the peer's own buffer, which
     * is the peer's receive queue, not this socket's send queue. A host's kernel buffers fill, so its
     * figure stalls at the amount the peer has left unread (13 MiB of the 12.5 MiB written here).
     */
    get bufferSize() {
      if (this._hubId === undefined && !this.connecting) return undefined;
      /* A closed socket counts nothing: Node leaves the figure undefined once the handle is gone. */
      if (this._dead) return undefined;
      /* One count of each byte, and never more than the socket was given. The three figures a write
         leaves behind -- the held write callback, the stream's own buffer, and the bytes this socket
         handed the hub -- name the SAME bytes, so summing them reported three times what was written
         (262145 -> 786435) and, once two writes shared a turn, more than every byte the socket had
         ever been handed (400010 written -> 1200010). What is still the socket's own is what the hub
         has not delivered yet, plus what a write before 'connect' is still holding. */
      var queued = 0;
      for (var i = 0; i < this._pendingWrites.length; i++) queued += this._pendingWrites[i].length;
      /* Plus what the stream itself is still holding: a corked socket has handed the hub nothing at
         all, and host Node 24.15 counts those bytes -- 131072 for two 64 KiB writes under a cork,
         falling to 0 on the uncork that hands them on. */
      var held = this._writableState ? this._writableState.length : 0;
      return this._unsentBytes + queued + held;
    }

    /**
     * Counts bytes handed to the hub as unsent, and arranges for the count to drop on the turn that
     * delivers them: the hub schedules one delivery per chunk, all of them before this timer, which
     * is armed after the last one, so the count is exact until every byte has reached the peer.
     */
    _accountSent(size) {
      this._unsentBytes += size;
      if (this._unsentTimer !== null) clearTimeout(this._unsentTimer);
      var self = this;
      this._unsentTimer = setTimeout(function () {
        self._unsentTimer = null;
        self._unsentBytes = 0;
      }, 0);
    }

    connect() {
      var args = netConnectArgs(arguments);
      if (typeof args.cb === 'function') this.once('connect', args.cb);
      /* A connect that names no destination at all is one Node refuses before it looks at the
         socket: 'The "options" or "port" or "path" argument must be specified', a TypeError thrown
         synchronously, whether the socket is fresh or already connected. */
      if (args.port === undefined && args.path === undefined) {
        throw netError(TypeError, 'ERR_MISSING_ARGS',
          'The "options" or "port" or "path" argument must be specified');
      }
      /* A local address has to be an address at all: Node reads it before it dials, and a name there
         is ERR_INVALID_IP_ADDRESS, a TypeError thrown synchronously. */
      if (args.localAddress !== undefined && args.localAddress !== null && args.localAddress !== ''
        && netIsIP(args.localAddress) === 0) {
        throw netError(TypeError, 'ERR_INVALID_IP_ADDRESS', 'Invalid IP address: ' + String(args.localAddress));
      }
      /* A socket already destroyed is not one Node refuses: connect() nulls the handle its destroy
         closed, clears the addresses the dead connection reported and the destroyed flag itself,
         and dials again -- host Node 24.15 emits a second 'connect' and carries bytes both ways on
         the new connection. Reopening it here means undoing the destroy: the stream's own flags
         and the socket's, since it is one socket that connects twice, not two. */
      if (this._dead) {
        if (typeof this._undestroy === 'function') this._undestroy();
        this._dead = false;
        this._hubId = undefined;
        this._hubClosed = false;
        this._closePending = false;
        this._rEnded = false;
        this._wEnded = false;
        this._wFinished = false;
        this._finEnded = false;
        this._endRequested = false;
        this._hadError = false;
        this._pendingWrites = [];
        this._writeCbs = [];
        this._readQueue = [];
        this._unsentBytes = 0;
        this._flowing = undefined;
        this._carry = null;
        this.localAddress = undefined;
        this.localPort = undefined;
        this.localFamily = undefined;
        /* A socket reopened by connect() is a new connection, so nothing it was asked about the
           old one is remembered. */
        this._remoteName = undefined;
        this._remoteCache = undefined;
      }
      /* A second connect is one Node refuses: a connection this socket has already made is EISCONN,
         one still in flight is EALREADY, and both are reported the way every connect failure is --
         asynchronously, and by destroying the socket, which then emits 'close' too -- while connect()
         itself still answers with the socket. Which of the two it is has to be read before
         'connecting' is set, since setting it is what makes the next one EALREADY. Node sets the
         flag first, so a socket whose second connect was refused still reads connecting until the
         destroy that reports the refusal clears it.
         The refusal is not the first thing that happens either: Node resolves the name first, so a
         name getaddrinfo cannot answer is ENOTFOUND even on a socket that is already connected, and
         the refusal comes per address -- one address is one EISCONN, and the two a bare port asks
         for ('localhost' is dual-stack) are the AggregateError Node reports for a name it tried
         twice. A connect on a socket already destroyed is not refused at all. */
      var flying = this.connecting;
      this.connecting = true;
      var again = this._dead ? null
        : (flying ? 'EALREADY' : (this._hubId !== undefined ? 'EISCONN' : null));
      if (again !== null) {
        var refused = this;
        var retry = args.path !== undefined ? [args.path] : netConnectList(args.host, args.family);
        var refuse = function (addresses) {
          var each = [];
          for (var i = 0; i < addresses.length; i++) {
            each.push(netConnectAgainError(refused, again, { path: args.path, host: addresses[i], port: args.port }));
          }
          netDefer(function () {
            refused.destroy(each.length === 1 ? each[0] : netAggregate(each));
          });
        };
        /* A path is one destination, so it is one EISCONN; the host's own process aborts on that
           case (a native assertion in TCPWrap::Connect), so there is no answer of its to match. */
        if (retry !== null) {
          refuse(retry);
          return this;
        }
        var refusing = this;
        netResolve(args.host, args.family, function (failure, address) {
          if (failure) {
            netDefer(function () { refusing.destroy(failure); });
            return;
          }
          refuse([address]);
        }, args.lookup);
        return this;
      }
      this._connectStarted = true;
      this._ensureTarget();
      netRefresh(this);
      /* A pipe path names a unix domain socket the virtual hub carries by path. */
      if (args.path !== undefined) {
        var dialled = String(args.path);
        var dialler = this;
        /* Node's connect is never synchronous, not even the answer it refuses with. */
        netDefer(function () { dialler._doConnectPath(dialled); });
        return this;
      }
      /* A host's TCP socket is one TCPWRAP: node reports it when the socket is made and destroys it
         when the socket is destroyed. A pipe path is no TCP socket at all, so it reports none. */
      this._owcAsync = asyncOpenResource('TCPWRAP', this);
      /* net.client.socket: the TCP socket a dial is about to be made on, once per connect. */
      dcPublish('net.client.socket', { socket: this });
      var port = netPortOf(args.port);
      var self = this;
      /* A name with two addresses is tried on both, as Node's happy-eyeballs does: only the caller's
         own lookup changes that, since it is the caller who says which addresses a name has. */
      var listed = typeof args.lookup === 'function' ? null : netConnectList(args.host, args.family);
      /* The resolution a connect announces before it dials, as host Node 24.15 does: one 'lookup'
         per address the name answered, in the order the addresses are tried, and one carrying the
         error when the name answered none -- 'localhost' announces ::1 and then 127.0.0.1 before
         the ECONNREFUSED, an unknown name announces the ENOTFOUND, and an IP literal announces
         nothing at all because nothing was ever looked up. A caller's own lookup is not announced:
         Node asks it instead of the resolver and reports nothing of what it answered. */
      /* ... nothing at all for an IP literal, which no resolver was ever asked about. A caller's
         own lookup is not announced either: Node asks it instead of the resolver and reports
         nothing of what it answered. */
      var asked = netConnectHost(args.host);
      var told = typeof args.lookup === 'function' || netIsIP(asked) !== 0;
      var announce = function (failure, addresses) {
        if (told) return;
        told = true;
        if (failure) {
          netEmitLookupMiss(self, failure, asked);
          return;
        }
        for (var i = 0; i < addresses.length; i++) {
          netEmitLookup(self, addresses[i], netIsIP(addresses[i]) === 6 ? 6 : 4, asked);
        }
      };
      var begin = function (failure, address) {
        if (failure) {
          announce(failure, null);
          self.destroy(failure);
          return;
        }
        /* Binding the local end to an address is the kernel's own call, and it answers the way a
           host's bind does: EINVAL (-22) for an address of the other family than the peer, and
           EADDRNOTAVAIL (-49) for one no interface of this host holds. */
        if (args.localAddress !== undefined && args.localAddress !== null && args.localAddress !== '') {
          if ((netIsIP(args.localAddress) === 6) !== (netIsIP(address) === 6)) {
            self.destroy(netSystemError({ code: 'EINVAL', errno: -22 }, 'bind', args.localAddress));
            return;
          }
          if (!netOwnAddress(args.localAddress)) {
            self.destroy(netSystemError({ code: 'EADDRNOTAVAIL', errno: -49 }, 'bind', args.localAddress));
            return;
          }
        }
        var dialled = listed || [address];
        announce(null, dialled);
        self._doConnect(dialled, port, args.localPort);
      };
      try {
        netResolve(args.host, args.family, begin, args.lookup);
      } catch (failure) {
        /* Nothing about a name may leave a socket holding the event loop open, so a failure found
           before the connect was ever begun is delivered the way Node delivers one: by destroying
           the socket, which releases the loop and reports the error on a later tick. */
        self.destroy(failure);
      }
      return this;
    }

    /* Tries each address in turn. One address failing is that error; every address failing is the
       AggregateError Node reports for a name the host tried on both of its families. */
    _doConnect(addresses, port, localPort) {
      var failures = [];
      for (var i = 0; i < addresses.length; i++) {
        var res;
        /* Dialling the unspecified address is dialling the loopback of its own family, as host
           Node 24.15 does it: '::' reaches a listener on '::' or on '::1' as ::1/IPv6 at both
           ends, and is refused by one bound to an IPv4 address, where dialling it as 127.0.0.1
           reached listeners a host refuses. The error text still names what the caller dialled
           ('connect ECONNREFUSED :::8080'), so only the address the hub is asked for changes. */
        var dialled = addresses[i] === '::' ? '::1' : addresses[i];
        try {
          res = callCap('net.connect', { address: dialled, port: port, targetId: this._targetId, localPort: localPort || 0 });
        } catch (cause) {
          failures.push(netSystemError(cause, 'connect', addresses[i], port));
          continue;
        }
        this._hubId = res.id;
        /* The name of a connection is the kernel's to give, and it has not given one yet: a host's
           socket reads no address at either end until 'connect', so these are carried here and
           published by _onConnectEvent. */
        netHide(this, '_pendingPeer', res);
        netRefresh(this);
        this._flushPending();
        return;
      }
      /* A refused connect is not a synchronous answer: Node's comes back from the loop, so a
         destroy() the caller issues first still wins and the socket just closes. */
      var refused = failures.length === 1 ? failures[0] : netAggregate(failures);
      var self = this;
      netDefer(function () { self.destroy(refused); });
      return;
    }

    /* Dials a unix domain socket by path. A path nothing is bound at is the kernel's ENOENT, which
       is the error Node reports for it, and a connection it accepted has no addresses at all. */
    _doConnectPath(path) {
      var res;
      try {
        /* A path the hub does not carry -- one with no separator in it -- has nothing bound at it
           either, so the answer is the ENOENT host Node reports (connect('x.sock'),
           connect('localhost')), not a dial that reads the name as an address and refuses it
           ENETUNREACH or EADDRNOTAVAIL. */
        if (netIsPath(path) === undefined) {
          throw Object.assign(new Error('connect ENOENT ' + path), { code: 'ENOENT', errno: -2 });
        }
        res = callCap('net.connect', { address: path, port: 0, targetId: this._targetId });
      } catch (cause) {
        var refused = netSystemError(cause, 'connect', path);
        var self = this;
        netDefer(function () { self.destroy(refused); });
        return;
      }
      this._hubId = res.id;
      this.localAddress = res.localAddress;
      this.localPort = res.localPort;
      this.localFamily = res.localAddress === undefined ? undefined : netFamilyName(res.localAddress);
      this._remoteName = { address: res.remoteAddress, port: res.remotePort,
        family: res.remoteAddress === undefined ? undefined : netFamilyName(res.remoteAddress) };
      this._remoteCache = undefined;
      netRefresh(this);
      this._flushPending();
    }

    /* The third argument is the payload on the binary channel, an ArrayBuffer the host read out of
       this heap; a delivery made over JSON carries it as base64 in the payload instead. */
    _onHub(name, payload, bytes) {
      if (name === 'data') this._onChunk(bytes === undefined ? Buffer.from(payload, 'base64') : Buffer.from(bytes));
      else if (name === 'connect') this._onConnectEvent();
      else if (name === 'end') this._onRemoteEnd();
      else if (name === 'reset') this._onRemoteReset(payload);
      else if (name === 'close') this._onRemoteClose();
    }

    /** The peer closed with unread data of its own: a reset, so this side gets ECONNRESET, never EOF. */
    _onRemoteReset(payload) {
      if (this._dead) return;
      var code = payload && typeof payload.code === 'string' ? payload.code : 'ECONNRESET';
      /* Node names a reset the way the read that found it failed: 'read ECONNRESET', with no address. */
      var failure = netError(Error, code, 'read ' + code);
      failure.errno = -54;
      failure.syscall = 'read';
      this._readQueue = [];
      this.destroy(failure);
    }

    _onConnectEvent() {
      if (this._dead) return;
      /* The connection the hub made is named now, on the turn 'connect' is emitted -- not on the
         turn it was dialled, which is what a host's own socket does. */
      if (this._pendingPeer !== undefined) {
        var peer = this._pendingPeer;
        this._pendingPeer = undefined;
        this.localAddress = peer.localAddress;
        this.localPort = peer.localPort;
        this.localFamily = netFamilyName(peer.localAddress);
        this._remoteName = { address: peer.remoteAddress, port: peer.remotePort,
          family: netFamilyName(peer.remoteAddress) };
        this._remoteCache = undefined;
      }
      this.connecting = false;
      netRefresh(this);
      this._armIdle();
      this.emit('connect');
      this.emit('ready');
    }

    _onChunk(chunk) {
      if (this._dead) return;
      this.bytesRead += chunk.length;
      this._armIdle();
      this._readQueue.push({ chunk: chunk });
      this._scheduleRead();
    }

    _onRemoteEnd() {
      if (this._dead) return;
      /* An end with nothing buffered ahead of it ends the stream on the turn it arrives, as Node's
         does: there is no read to batch it with, and waiting a turn would put this side's 'close'
         ahead of the peer's 'end' in the order both sides observe. */
      var batched = this._readQueue.length > 0;
      this._readQueue.push({ end: true });
      if (batched) this._scheduleRead();
      else this._drainReadQueue();
    }

    _onRemoteClose() {
      if (this._dead) return;
      if (this._rEnded || (!duplexMode && this._readQueue.length === 0)) {
        this.destroy();
        return;
      }
      // The peer's end is queued ahead of its close: destroy once the consumer has read it.
      this._closePending = true;
    }

    /** Batches the chunks that arrive in one macrotask, as one kernel read would, before delivering them. */
    _scheduleRead() {
      if (this._readTimer) return;
      var self = this;
      this._readTimer = setTimeout(function () {
        self._readTimer = null;
        self._drainReadQueue();
      }, 0);
    }

    _drainReadQueue() {
      if (this._dead) return;
      if (duplexMode) this._pushQueued();
      else this._flushReadable();
    }

    _pushQueued() {
      var self = this;
      var parts = [];
      var used = 0;
      var pushed = false;
      function flush() {
        if (parts.length === 0) return;
        self.push(parts.length === 1 ? parts[0] : Buffer.concat(parts));
        parts = [];
        used = 0;
        pushed = true;
      }
      while (!this._dead && this._readQueue.length > 0) {
        var item = this._readQueue[0];
        if (item.end) {
          this._readQueue.shift();
          flush();
          /* Node reads a peer's last byte and its FIN on two turns, so 'end' never lands in the pass
             that emitted the final 'data'. Both arrive batched in one read here, and pushing EOF
             straight after that data emits 'end' before a consumer who awaited the 'data' can listen
             for it -- an await on 'data' followed by one on 'end' then never settles. Pushing EOF one
             macrotask later puts the two events on the two turns Node's consumer sees. */
          if (pushed) {
            this._endPending = true;
            setTimeout(function () {
              self._endPending = false;
              if (!self._dead) {
                self.push(null);
                // As Node does at EOF: an empty buffer ends the stream even when nothing is reading it.
                self.read(0);
              }
            }, 0);
            return;
          }
          this.push(null);
          // As Node does at EOF: an empty buffer ends the stream even when nothing is reading it.
          this.read(0);
          return;
        }
        /* A socket reads one buffer at a time: what its reader has not taken yet stays in the
           kernel, so a socket nobody reads holds NET_CHUNK bytes at most and the rest is still
           unread -- which is what makes closing it a reset instead of a clean end (Node 24.15
           sends FIN up to 65536 unread bytes and RST from 65537 on). The read resumes from _read,
           the way the kernel read resumes once the buffer has room. */
        var room = NET_CHUNK - (this.readableLength + used);
        if (room <= 0) break;
        var chunk = item.chunk;
        if (chunk.length <= room) {
          this._readQueue.shift();
          parts.push(chunk);
          used += chunk.length;
        } else {
          parts.push(chunk.subarray(0, room));
          item.chunk = chunk.subarray(room);
          used += room;
        }
      }
      if (!this._dead) flush();
    }

    _flushReadable() {
      var emittedData = false;
      while (!this._dead && this._readQueue.length > 0) {
        if (this._readQueue[0].end) {
          // An end with nothing buffered ahead of it ends the stream even while paused, as Node does.
          this._readQueue.shift();
          /* Node reads a peer's last byte and its FIN in two turns, so 'end' never lands in the pass
             that emitted the final 'data'. Here both can arrive batched in one read, and emitting
             them together loses any 'end' listener the consumer attaches after awaiting that 'data'
             -- an await on 'data' followed by one on 'end' never settles. Deferring the end one
             macrotask puts the two events on the two turns Node's consumer sees. */
          if (emittedData) {
            var self = this;
            this._endPending = true;
            setTimeout(function () {
              self._endPending = false;
              if (!self._dead) self._emitEnd();
              self._finishClose();
            }, 0);
            break;
          }
          this._emitEnd();
          continue;
        }
        if (this._flowing !== true) break;
        var parts = [];
        var used = 0;
        while (this._readQueue.length > 0 && this._readQueue[0].chunk !== undefined && used < NET_CHUNK) {
          var chunk = this._readQueue[0].chunk;
          var take = Math.min(NET_CHUNK - used, chunk.length);
          if (take === chunk.length) {
            parts.push(chunk);
            this._readQueue.shift();
          } else {
            parts.push(chunk.subarray(0, take));
            this._readQueue[0].chunk = chunk.subarray(take);
          }
          used += take;
        }
        var out = this._decode(parts.length === 1 ? parts[0] : Buffer.concat(parts));
        if (out !== null) { this.emit('data', out); emittedData = true; }
      }
      this._finishClose();
    }

    /** Runs the queued close that was waiting on the consumer to read the peer's end. */
    _finishClose() {
      if (!this._dead && this._closePending && !this._endPending && this._readQueue.length === 0) {
        this._closePending = false;
        this.destroy();
      }
    }

    _emitEnd() {
      if (this._rEnded) return;
      this._rEnded = true;
      this.emit('end');
      if (!this.allowHalfOpen) this._finEnded = true;
      if (!this.allowHalfOpen && !this._wEnded && !this._dead) this.end();
      this._maybeFinish();
    }

    _maybeFinish() {
      if (!(this._wFinished && this._rEnded && !this._dead)) return;
      var self = this;
      netDefer(function () {
        if (self._wFinished && self._rEnded && !self._dead) self.destroy();
      });
    }

    _decode(chunk) {
      if (this._encoding === null) return chunk;
      var all = this._carry === null ? chunk : Buffer.concat([this._carry, chunk]);
      this._carry = null;
      if (this._encoding === 'utf8' || this._encoding === 'utf-8') {
        var cut = netUtf8Cut(all);
        if (cut < all.length) this._carry = all.slice(cut);
        return cut === 0 ? null : all.toString('utf8', 0, cut);
      }
      return all.toString(this._encoding);
    }

    _sendChunk(chunk) {
      if (this._hubId === undefined) {
        this._pendingWrites.push(chunk);
        return;
      }
      if (chunk.length === 0) return;
      var handed = 0;
      try {
        var at = 0;
        while (at < chunk.length) {
          var last = at + NET_CHUNK >= chunk.length;
          callCapBytes('net.write', { connectionId: this._hubId }, last && at === 0 ? chunk : chunk.subarray(at, at + NET_CHUNK));
          at = Math.min(at + NET_CHUNK, chunk.length);
          handed = at;
        }
      } catch (cause) {
        // The connection is already gone; the peer's close finishes this side.
      }
      if (handed > 0) this._accountSent(handed);
    }

    _sendEnd() {
      this._endRequested = false;
      if (this._hubId === undefined) {
        this._endRequested = true;
        return;
      }
      try {
        callCap('net.end', { connectionId: this._hubId });
      } catch (cause) {
        // The connection is already gone.
      }
    }

    _flushPending() {
      var queued = this._pendingWrites;
      this._pendingWrites = [];
      for (var i = 0; i < queued.length; i++) this._sendChunk(queued[i]);
      if (this._endRequested) this._sendEnd();
    }

    /**
     * Completes one write. A write bigger than the socket buffer is still in flight once this tick
     * ends, so it is held until the next one -- and a socket destroyed meanwhile cancels it with
     * ECANCELED instead of reporting a success it never had, which is what Node does.
     */
    _settleWrite(callback, size) {
      if (typeof callback !== 'function') return;
      if (size > NET_SNDBUF) {
        this._writeCbs.push({ cb: callback, size: size });
        var self = this;
        /* Only a socket that is still alive settles its own write: one destroyed meanwhile leaves it
           to the destroy, which cancels it with ECANCELED as Node does. */
        setTimeout(function () { if (!self._dead) self._drainWriteCbs(null); }, 0);
        return;
      }
      if (duplexMode) callback();
      else netDefer(function () { callback(); });
    }

    /** Runs every held write callback: with the failure that ended the socket, or with none. */
    _drainWriteCbs(failure) {
      var pending = this._writeCbs;
      this._writeCbs = [];
      for (var i = 0; i < pending.length; i++) pending[i].cb(failure);
    }

    _writeCancelError() {
      return netError(Error, 'ECANCELED', 'write ECANCELED');
    }

    /* The unread count is measured before this socket drops what it was holding: it is the reason
       the hub sends the peer a reset instead of end-of-file. */
    _closeHub(unread) {
      if (this._hubId === undefined || this._hubClosed) return;
      this._hubClosed = true;
      var pending = unread === undefined ? this._unreadBytes() : unread;
      try {
        callCap('net.destroy', { connectionId: this._hubId, unread: pending > 0 });
      } catch (cause) {
        // Already destroyed.
      }
    }

    /** Bytes this side received and never handed to its reader: those are the ones a real socket
        still holds in its kernel buffer, and closing with them is the reset Node sends. Bytes the
        reader was given but has not consumed are not -- Node closes cleanly over 65536 of those. */
    _unreadBytes() {
      var queued = 0;
      for (var i = 0; i < this._readQueue.length; i++) {
        if (this._readQueue[i].chunk !== undefined) queued += this._readQueue[i].chunk.length;
      }
      return queued;
    }

    _ensureTarget() {
      if (this._targetId !== undefined) return;
      var self = this;
      this._targetId = createTarget(function (name, payload, bytes) {
        self._onHub(name, payload, bytes);
      });
    }

    /** Adopts a connection accepted by a server; the caller attaches the target to it. */
    _adopt(payload) {
      this._ensureTarget();
      this._hubId = payload.connectionId;
      this.localAddress = payload.localAddress;
      this.localPort = payload.localPort;
      /* A unix connection carries no address, so it has no family to name either. */
      this.localFamily = payload.localAddress === undefined ? undefined : netFamilyName(payload.localAddress);
      this._remoteName = { address: payload.remoteAddress, port: payload.remotePort,
        family: payload.remoteAddress === undefined ? undefined : netFamilyName(payload.remoteAddress) };
      this._remoteCache = undefined;
      netRefresh(this);
    }

    _holdable() {
      return !this._dead && (this.connecting || this._hubId !== undefined);
    }

    _teardown() {
      if (this._idleTimer) {
        clearTimeout(this._idleTimer);
        this._idleTimer = null;
      }
      if (this._readTimer) {
        clearTimeout(this._readTimer);
        this._readTimer = null;
      }
      if (this._unsentTimer !== null) {
        clearTimeout(this._unsentTimer);
        this._unsentTimer = null;
        this._unsentBytes = 0;
      }
      var owner = this._serverRef;
      if (owner) {
        this._serverRef = undefined;
        owner._connections -= 1;
        owner._emitCloseIfDrained(true);
      }
      if (this._targetId !== undefined) {
        deleteTarget(this._targetId);
        this._targetId = undefined;
      }
      /* Node reads a socket's own address and its family off its handle, so once the handle is gone
         every one of them is undefined: a destroyed socket names no local end, and address() is the
         empty object rather than the pair the connection was made on. The peer's end is only lost
         to a caller who never asked for it -- what was read of it before the destroy is kept. */
      this.localAddress = undefined;
      this.localPort = undefined;
      this.localFamily = undefined;
      this._remoteName = undefined;
      netRefresh(this);
    }

    _armIdle() {
      if (this._idleTimer) {
        clearTimeout(this._idleTimer);
        this._idleTimer = null;
      }
      if (!(this._idleMs > 0) || this._dead) return;
      var self = this;
      var timer = setTimeout(function () {
        self._idleTimer = null;
        self.emit('timeout');
      }, this._idleMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      this._idleTimer = timer;
    }

    setTimeout(ms, callback) {
      if (typeof callback === 'function') this.once('timeout', callback);
      this._idleMs = Number(ms) || 0;
      this._armIdle();
      return this;
    }

    setNoDelay() {
      return this;
    }

    setKeepAlive() {
      return this;
    }

    /* The peer's end of the connection, as host Node 24.15 answers it: read off the handle while
       there is one, and remembered from the first time a caller asked, so a socket destroyed after
       being asked still names the peer it had, where one never asked names nothing. The local end
       is the live reading only -- a destroyed socket's localAddress is undefined either way. */
    get remoteAddress() {
      return netPeerName(this).address;
    }

    get remotePort() {
      return netPeerName(this).port;
    }

    get remoteFamily() {
      return netPeerName(this).family;
    }

    address() {
      /* A socket still dialling answers with nothing at all, as a host's does: the name of the
         connection is the kernel's to give, and it has not made one yet -- so address() is the
         empty object until 'connect', even though this socket already knows the port it took. */
      if (this.connecting || this._hubId === undefined || this._hubClosed) return {};
      /* A unix connection has no name at either end, and host Node 24.15's address() for one is
         the empty object: an object with no keys at all, not the three a TCP socket answers with
         holding undefined. */
      if (this.localAddress === undefined) return {};
      return { address: this.localAddress, family: this.localFamily, port: this.localPort };
    }

    ref() {
      this._refed = true;
      netRefresh(this);
      return this;
    }

    unref() {
      this._refed = false;
      netRefresh(this);
      return this;
    }
  }

  if (duplexMode) {
    var duplexWrite = DuplexBase.prototype.write;
    /* A write past this end is EPIPE, as the socket would have raised: it goes to the callback and
       nothing else, which is what Node does -- only a write past a destroyed socket is an 'error'. */
    Socket.prototype.write = function (chunk, encoding, callback) {
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      /* A socket that sent its own end takes EPIPE, even once it has closed: only one that was
         destroyed without ending (a reset) reports the stream's own error instead. */
      if (this._wFinished || this._wEnded) {
        /* Which error it is depends on what ended this side, as Node 24.15 reports them: an end
           forced by the peer's FIN is EPIPE ('This socket has been ended by the other party'), and
           an end this side asked for is the stream's own 'write after end', which Node also emits
           as 'error' and destroys the socket with. */
        var failure = this._finEnded
          ? netError(Error, 'EPIPE', 'This socket has been ended by the other party')
          : netError(Error, 'ERR_STREAM_WRITE_AFTER_END', 'write after end');
        var failed = this;
        netDefer(function () {
          if (typeof callback === 'function') callback(failure);
          if (!failed._finEnded) failed.destroy(failure);
        });
        return false;
      }
      return duplexWrite.call(this, chunk, encoding, callback);
    };

    Socket.prototype._read = function () {
      /* The stream asks for more once its reader has taken what it was holding: that is the kernel
         read resuming, so what was left unread moves into the buffer. */
      if (this._readQueue.length > 0) this._scheduleRead();
    };

    Socket.prototype._write = function (chunk, encoding, callback) {
      this.bytesWritten += chunk.length;
      this._armIdle();
      this._sendChunk(chunk);
      this._settleWrite(callback, chunk.length);
    };

    /* Node shuts a socket's writable side down on the turn after end(), so a destroy() that lands
       first still wins and 'finish' is never emitted. */
    Socket.prototype._final = function (callback) {
      this._wFinished = true;
      this._sendEnd();
      netDefer(function () { callback(); });
    };

    Socket.prototype._destroy = function (error, callback) {
      var unread = this._unreadBytes();
      this._dead = true;
      /* The handle goes with the socket, as a host's does. */
      if (this._owcAsync) {
        this._owcAsync();
        this._owcAsync = null;
      }
      this._hadError = !!error;
      this.connecting = false;
      this._readQueue = [];
      // Node cancels what a destroyed socket never managed to send with ECANCELED, even when the
      // socket was destroyed with an error of its own: the error is the socket's, not the write's.
      this._closeHub(unread);
      this._teardown();
      var self = this;
      /* Node reports the error a socket was destroyed with BEFORE it cancels the writes the destroy
         stranded: the error is the socket's own, and the cancel is the handle closing under it, so
         Node 24.15 logs 'error', then the write callback, then 'close'. It is reported on the next
         tick, as the stream's own error would be, and the stream is told it has been reported so its
         close path does not repeat it. */
      if (error) {
        var w = this._writableState;
        var r = this._readableState;
        if (w) w.errorEmitted = true;
        if (r) r.errorEmitted = true;
        process.nextTick(function () { self.emit('error', error); });
      }
      /* The cancel lands on the turn after the destroy, as Node's handle close does: the socket's
         own 'error' is reported first, and a write issued after the destroy is answered before the
         one that was still pending. */
      setTimeout(function () {
        self._drainWriteCbs(self._writeCancelError());
        /* The socket's own 'close' lands a turn later still: Node's handle closes under the loop
           turn in which the peer reads the FIN, so both sides log the peer's 'end' before this
           side's 'close' (Node 24.15, plain net). */
        setTimeout(function () { callback(error); }, 0);
      }, 0);
    };

    // The stream emits 'close' with no argument; Node passes hadError.
    var baseEmit = Socket.prototype.emit;
    Socket.prototype.emit = function (type) {
      if (type === 'close' && arguments.length === 1) return baseEmit.call(this, 'close', !!this._hadError);
      return baseEmit.apply(this, arguments);
    };
  } else {
    Socket.prototype.write = function (chunk, encoding, callback) {
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      var buf = netToBuffer(chunk, encoding);
      if (this._wFinished || this._wEnded) {
        /* As in duplex mode: an end forced by the peer's FIN is EPIPE, and an end this side asked
           for is the stream's own 'write after end', which is also emitted as 'error'. */
        var ended = this._finEnded
          ? netError(Error, 'EPIPE', 'This socket has been ended by the other party')
          : netError(Error, 'ERR_STREAM_WRITE_AFTER_END', 'write after end');
        var endedSocket = this;
        /* A write past this side's own end fails the write side, so the 'finish' end() scheduled is
           never delivered -- an errored stream ends without finishing, which is what Node does. */
        this._wFailed = true;
        netDefer(function () {
          if (typeof callback === 'function') callback(ended);
          if (!endedSocket._finEnded) endedSocket.destroy(ended);
        });
        return false;
      }
      if (this._dead) {
        var self = this;
        var failure = netError(Error, 'ERR_STREAM_DESTROYED', 'Cannot call write after a stream was destroyed');
        netDefer(function () {
          if (typeof callback === 'function') callback(failure);
          self.emit('error', failure);
        });
        return false;
      }
      this.bytesWritten += buf.length;
      this._armIdle();
      this._sendChunk(buf);
      this._settleWrite(callback, buf.length);
      return true;
    };

    Socket.prototype.end = function (chunk, encoding, callback) {
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
      } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
      if (this._wEnded || this._dead) {
        if (typeof callback === 'function') netDefer(callback);
        return this;
      }
      this._wEnded = true;
      if (typeof callback === 'function') this.once('finish', callback);
      if (this._hubId !== undefined) this._sendEnd();
      else this._endRequested = true;
      var self = this;
      netDefer(function () {
        if (self._dead || self._wFailed) return;
        self._wFinished = true;
        self.emit('finish');
        self._maybeFinish();
      });
      return this;
    };

    Socket.prototype.destroy = function (error) {
      if (this._dead) return this;
      var unread = this._unreadBytes();
      this._dead = true;
      this.connecting = false;
      this._readQueue = [];
      // Node cancels what a destroyed socket never managed to send with ECANCELED, even when the
      // socket was destroyed with an error of its own: the error is the socket's, not the write's.
      this._closeHub(unread);
      this._teardown();
      var self = this;
      netDefer(function () {
        if (error) self.emit('error', error);
        /* As above: the cancel lands after the socket's own 'error' and after a write issued once
           it was already destroyed. */
        setTimeout(function () {
          self._drainWriteCbs(self._writeCancelError());
          self.emit('close', !!error);
        }, 0);
      });
      return this;
    };

    Socket.prototype.setEncoding = function (encoding) {
      this._encoding = encoding || 'utf8';
      this._carry = null;
      return this;
    };

    Socket.prototype.pause = function () {
      this._flowing = false;
      return this;
    };

    Socket.prototype.resume = function () {
      this._flowing = true;
      var self = this;
      netDefer(function () { self._flushReadable(); });
      return this;
    };

    Socket.prototype.isPaused = function () {
      return this._flowing === false;
    };

    Socket.prototype.on = Socket.prototype.addListener = function (type, listener) {
      baseAddListener.call(this, type, listener);
      if (type === 'data' && this._flowing !== false) this.resume();
      return this;
    };

    Socket.prototype.pipe = function (dest, options) {
      var self = this;
      var endOnEnd = !(options && options.end === false);
      this.on('data', function (chunk) {
        if (dest.write(chunk) === false) self.pause();
      });
      if (typeof dest.on === 'function') {
        dest.on('drain', function () { self.resume(); });
      }
      if (endOnEnd) {
        this.once('end', function () { dest.end(); });
      }
      if (typeof dest.emit === 'function') dest.emit('pipe', this);
      return dest;
    };

    Object.defineProperty(Socket.prototype, 'destroyed', { get: function () { return this._dead; }, configurable: true });
    Object.defineProperty(Socket.prototype, 'readable', { get: function () { return !this._dead && !this._rEnded; }, configurable: true });
    Object.defineProperty(Socket.prototype, 'writable', { get: function () { return !this._dead && !this._wEnded; }, configurable: true });
    Object.defineProperty(Socket.prototype, 'readableEnded', { get: function () { return this._rEnded; }, configurable: true });
    Object.defineProperty(Socket.prototype, 'writableEnded', { get: function () { return this._wEnded; }, configurable: true });
    Object.defineProperty(Socket.prototype, 'writableFinished', { get: function () { return this._wFinished; }, configurable: true });
  }

  /* Node's destroySoon is the name destroy() had before it: a socket that has already ended is
     destroyed now, one still writing is destroyed once 'finish' comes, and any other is ended and
     left to close on its own -- it does not tear a socket down out from under a live write. */
  Socket.prototype.destroySoon = function () {
    if (this._wEnded) return this.destroy();
    if (this._writeCbs && this._writeCbs.length > 0) {
      var self = this;
      this.once('finish', function () { self.destroy(); });
      return this;
    }
    this.end();
    return this;
  };

  /* Node tears a connection down with a reset: what the peer has not read is discarded, so the peer
     sees ECONNRESET where a plain destroy hands it end-of-file. This hub has no RST flag of its own
     -- a close that leaves bytes unread is what it reports as a reset -- so the socket is closed as
     one with unread data, whatever it had actually consumed. */
  Socket.prototype.resetAndDestroy = function () {
    this._closeHub(1);
    this.destroy();
    return this;
  };

  /* The Type-of-Service (DSCP) byte a socket sends with. Node 24.15 answers 0 for a socket that has
     never set one, and for a destroyed one too; setting it validates the number and nothing else --
     this virtual network carries no IP header to put it in, so it is remembered for the getter and
     is not reported to the peer. */
  Socket.prototype.getTypeOfService = function () {
    return this._tos === undefined ? 0 : this._tos;
  };

  Socket.prototype.setTypeOfService = function (tos) {
    if (typeof tos !== 'number') {
      throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
        'The "tos" argument must be of type number. Received ' + netDescribe(tos));
    }
    if (!Number.isInteger(tos) || tos < 0 || tos > 255) {
      throw netError(RangeError, 'ERR_OUT_OF_RANGE',
        'The value of "tos" is out of range. It must be >= 0 && <= 255. Received ' + String(tos));
    }
    this._tos = tos;
    /* Node answers with the socket, so the call chains as setNoDelay and setKeepAlive do. */
    return this;
  };

  class Server extends EventEmitter {
    constructor(options, listener) {
      super();
      if (typeof options === 'function') {
        listener = options;
        options = undefined;
      }
      var opts = options || {};
      /* The options object itself is validated as host Node 24.15 validates it -- anything that is
         not an object is ERR_INVALID_ARG_TYPE naming 'options', so createServer('x') and
         createServer(7) are refused where this runtime built a server out of them -- and each
         option it carries is validated by type in its own words. */
      if (options !== undefined && options !== null && typeof options !== 'object') {
        throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
          'The "options" argument must be of type object. Received ' + netDescribe(options));
      }
      if (opts.highWaterMark !== undefined && typeof opts.highWaterMark !== 'number') {
        throw netError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "options.highWaterMark" property must be of type number. Received ' + netDescribe(opts.highWaterMark));
      }
      /* The options Node reads off a Server and keeps on it, so a caller can read them back:
         they are the socket settings its accepted connections are created with, and this runtime
         carries them as the plain fields host Node 24.15 answers them with. A half-open server is
         options.allowHalfOpen || false, which keeps the value it was given -- 1 stays 1, where
         a Boolean() of it would answer true -- and a keep-alive delay is kept in whole seconds,
         so 1234 ms is 1 and 999 ms is 0. */
      this.allowHalfOpen = opts.allowHalfOpen || false;
      this.pauseOnConnect = !!opts.pauseOnConnect;
      this.noDelay = !!opts.noDelay;
      this.keepAlive = !!opts.keepAlive;
      this.keepAliveInitialDelay = Number(opts.keepAliveInitialDelay) > 0 ? Math.floor(Number(opts.keepAliveInitialDelay) / 1000) : 0;
      this.highWaterMark = opts.highWaterMark === undefined ? NET_CHUNK : opts.highWaterMark;
      this._serverOpts = { allowHalfOpen: !!opts.allowHalfOpen, pauseOnConnect: !!opts.pauseOnConnect };
      this._listening = false;
      this._address = null;
      this._handleId = undefined;
      this._targetId = undefined;
      this._connections = 0;
      this._refed = true;
      this._holding = false;
      if (typeof listener === 'function') this.on('connection', listener);
    }

    get listening() {
      return this._listening;
    }

    _holdable() {
      return this._listening;
    }

    listen() {
      var args = netListenArgs(arguments);
      if (this._listening) {
        throw netError(Error, 'ERR_SERVER_ALREADY_LISTEN', 'Listen method has been called more than once without closing.');
      }
      /* Node reads the 'path' option only when the path is what is being bound: a port named
         alongside it wins and is bound, and no property of the path is looked at then -- host Node
         24.15 binds :8080 for {path: 123, port: 8080}. A path named alone must be a non-empty
         string: a number, a Buffer, an object, null and '' are each ERR_INVALID_ARG_VALUE there,
         naming the whole options object, where this runtime bound or mis-refused them. */
      var given = arguments.length > 0 ? arguments[0] : undefined;
      if (given !== null && typeof given === 'object'
        && Object.prototype.hasOwnProperty.call(given, 'path') && given.port === undefined
        && (typeof given.path !== 'string' || given.path === '')) {
        throw netError(TypeError, 'ERR_INVALID_ARG_VALUE',
          "The argument 'options' is invalid. Received " + netInspectValue(given, 0));
      }
      /* A 'path' option names a unix domain socket, which the virtual hub carries by path: the
         socket binds, accepts and connects as the host's does, and reports no address, because a
         unix connection has none. What the hub does not do is put a file at the path -- no inode is
         created there, and a bind under a directory that does not exist is not refused -- so the
         path is the hub's own name for the binding, not an entry in the filesystem. */
      var named = args.path !== undefined && args.path !== null ? String(args.path) : undefined;
      var path = netIsPath(named);
      /* A port named alongside a path wins, as it does on host Node 24.15: a listen of
         {path:'/tmp/x', port:8080} binds the TCP port and ignores the path, where a path named
         alone binds the socket. A path with no separator in it is not one the hub carries, so it
         is read as a port and refused there, which is what this runtime answered before a path
         was carried at all. */
      var usePath = path !== undefined && args.port === undefined;
      /* A host resolves the host a listen names before it binds -- an IP literal included, which is
         why a listen on '127.0.0.1' alone is enough to make its resolver channel. A unix path is
         never resolved, so it makes none. */
      if (!usePath) netDnsChannel();
      var port = usePath
        ? 0
        : netPortOf(args.port !== undefined ? args.port : (named !== undefined ? named : 0), true);
      if (this._targetId === undefined) {
        var target = this;
        this._targetId = createTarget(function (name, payload) {
          if (name === 'connection') target._onConnectionEvent(payload);
        });
      }
      /* A server told to bind 'localhost' binds the address this host's own lookup gives the name,
         which is ::1 (Node 24.15, verified). dgram keeps the IPv4 answer its family asks for, so the
         name is resolved here and not in netListenDisplay, which both bind paths share. */
      var shown = usePath
        ? path
        : (typeof args.host === 'string' && args.host.toLowerCase() === 'localhost'
          ? '::1'
          : netListenDisplay(args.host));
      var res;
      try {
        res = callCap('net.listen', { address: usePath ? path : netListenHub(shown), port: port, targetId: this._targetId });
      } catch (cause) {
        var failed = netSystemError(cause, 'listen', shown, usePath ? -1 : port);
        /* A unix bind that failed still answers address() with the path it was asked for, as host
           Node 24.15 does for the 105-byte path it refuses EINVAL: the server never listened, but
           the path is the name it was given, and it is what a host's address() reports. */
        if (usePath) this._address = path;
        var failedServer = this;
        netDefer(function () { failedServer.emit('error', failed); });
        return this;
      }
      this._handleId = res.id;
      this._listening = true;
      /* A unix listener's address() is the path itself, a plain string, as Node reports it. */
      this._address = usePath ? res.address : { address: netListenShown(shown), family: netFamilyName(shown), port: res.port };
      netRefresh(this);
      if (typeof args.cb === 'function') this.once('listening', args.cb);
      var listeningServer = this;
      netDefer(function () { listeningServer.emit('listening'); });
      return this;
    }

    close(callback) {
      if (typeof callback === 'function') {
        if (this._listening) {
          this.once('close', callback);
        } else {
          this.once('close', function () {
            callback(netError(Error, 'ERR_SERVER_NOT_RUNNING', 'Server is not running.'));
          });
        }
      }
      if (this._listening) {
        try {
          callCap('net.closeListener', { id: this._handleId });
        } catch (cause) {
          // The listener is already gone.
        }
        this._listening = false;
        this._handleId = undefined;
        /* A closed TCP listener answers address() with null, but a unix listener keeps answering
           with the path it was bound at, as host Node 24.15 does after a close. */
        if (typeof this._address !== 'string') this._address = null;
        netRefresh(this);
      }
      this._emitCloseIfDrained();
      return this;
    }

    address() {
      /* A unix listener's address is the path it is bound at: Node answers with the path itself, a
         plain string, and not with the address/family/port triple a TCP listener gives -- and it
         keeps answering with it after a close, where a closed TCP listener answers null. */
      if (typeof this._address === 'string') return this._address;
      if (!this._listening || !this._address) return null;
      return { address: this._address.address, family: this._address.family, port: this._address.port };
    }

    /* Node refuses a call with no callback before it answers anything: ERR_INVALID_ARG_TYPE, a
       TypeError naming the argument, thrown synchronously -- where answering later raised the
       callback as 'not a function' from a tick the caller never saw coming. */
    getConnections(callback) {
      if (typeof callback !== 'function') {
        throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
          'The "callback" argument must be of type function. Received ' + netDescribe(callback));
      }
      var count = this._connections;
      netDefer(function () { callback(null, count); });
      return this;
    }

    ref() {
      this._refed = true;
      netRefresh(this);
      return this;
    }

    unref() {
      this._refed = false;
      netRefresh(this);
      return this;
    }

    _onConnectionEvent(payload) {
      if (!this._listening) {
        try {
          callCap('net.destroy', { connectionId: payload.connectionId });
        } catch (cause) {
          // Already gone.
        }
        return;
      }
      /* Node refuses an accept past maxConnections: it never reaches a 'connection' handler or the
         connection count, so the client's connect completes and then its socket is closed, and the
         server emits 'drop' with the addresses it refused. */
      if (this.maxConnections > 0 && this._connections >= this.maxConnections) {
        try {
          callCap('net.destroy', { connectionId: payload.connectionId });
        } catch (cause) {
          // Already gone.
        }
        this.emit('drop', {
          localAddress: payload.localAddress,
          localPort: payload.localPort,
          localFamily: payload.localAddress === undefined ? undefined : netFamilyName(payload.localAddress),
          remoteAddress: payload.remoteAddress,
          remotePort: payload.remotePort,
          remoteFamily: payload.remoteAddress === undefined ? undefined : netFamilyName(payload.remoteAddress),
        });
        return;
      }
      var socket = this._makeSocket();
      socket._adopt(payload);
      try {
        callCap('net.attach', { connectionId: payload.connectionId, targetId: socket._targetId });
      } catch (cause) {
        socket.destroy();
        return;
      }
      this._connections += 1;
      // Counted down when the socket is torn down (in _teardown), before its own 'close' is emitted, as Node does.
      socket._serverRef = this;
      if (this._serverOpts.pauseOnConnect) socket.pause();
      this._emitAccepted(socket);
    }

    _makeSocket() {
      var made = new Socket({ allowHalfOpen: this._serverOpts.allowHalfOpen });
      /* A connection a server accepted is a TCPWRAP of its own, made when the accept happens. */
      made._owcAsync = asyncOpenResource('TCPWRAP', made);
      return made;
    }

    _emitAccepted(socket) {
      /* The server an accepted socket came from is an own property of it, as host Node 24.15
         answers it: socket.server is the listener that accepted it, enumerable on the socket. */
      socket.server = this;
      /* net.server.socket: one publish per connection a server accepts, with the socket it made. */
      dcPublish('net.server.socket', { socket: socket });
      this.emit('connection', socket);
    }

    /** Emits the server's 'close' once it is drained. From a connection's teardown it is emitted at once, so it precedes that socket's own 'close', as Node orders them. */
    _emitCloseIfDrained(now) {
      if (this._listening || this._connections > 0) return;
      if (now) {
        this.emit('close');
        return;
      }
      var server = this;
      netDefer(function () { server.emit('close'); });
    }
  }

  /* IPv4 as four bytes, IPv6 as eight sixteen-bit groups: the units BlockList compares */
  function netParseIPv4(text) {
    if (!netIsIPv4(text)) return null;
    var parts = text.split('.');
    return [Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3])];
  }

  function netParseIPv6(text) {
    if (!netIsIPv6(text)) return null;
    var s = text;
    var lastColon = s.lastIndexOf(':');
    if (s.indexOf('.', lastColon) !== -1) {
      var v4 = netParseIPv4(s.slice(lastColon + 1));
      if (v4 === null) return null;
      s = s.slice(0, lastColon + 1) + (v4[0] * 256 + v4[1]).toString(16) + ':' + (v4[2] * 256 + v4[3]).toString(16);
    }
    var halves = s.split('::');
    var head = halves[0] === '' ? [] : halves[0].split(':');
    var tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
    var groups = [];
    var i;
    for (i = 0; i < head.length; i++) groups.push(parseInt(head[i], 16));
    if (halves.length === 2) {
      for (i = 0; i < 8 - head.length - tail.length; i++) groups.push(0);
    }
    for (i = 0; i < tail.length; i++) groups.push(parseInt(tail[i], 16));
    return groups.length === 8 ? groups : null;
  }

  /* The eight groups of an IPv4-mapped address ('::ffff:123.123.123.123') as the dotted IPv4 text
     the kernel renders it in, or null for any other address. inet_ntop writes the mapped form this
     way, and so does host Node 24.15 in a BlockList rule and in a SocketAddress's own address. */
  function netMappedIPv4Text(groups) {
    if (groups[0] !== 0 || groups[1] !== 0 || groups[2] !== 0 || groups[3] !== 0
      || groups[4] !== 0 || groups[5] !== 0xffff) return null;
    return '::ffff:' + ((groups[6] >> 8) & 255) + '.' + (groups[6] & 255)
      + '.' + ((groups[7] >> 8) & 255) + '.' + (groups[7] & 255);
  }

  /* RFC 5952 text: lower case, the first longest run of two or more zero groups compressed */
  function netFormatIPv6(groups) {
    var bestStart = -1;
    var bestLength = 0;
    var i = 0;
    while (i < 8) {
      if (groups[i] !== 0) {
        i++;
        continue;
      }
      var j = i;
      while (j < 8 && groups[j] === 0) j++;
      if (j - i >= 2 && j - i > bestLength) {
        bestStart = i;
        bestLength = j - i;
      }
      i = j;
    }
    var hex = [];
    for (i = 0; i < 8; i++) hex.push(groups[i].toString(16));
    var mapped = netMappedIPv4Text(groups);
    if (mapped !== null) return mapped;
    if (bestStart < 0) return hex.join(':');
    return hex.slice(0, bestStart).join(':') + '::' + hex.slice(bestStart + bestLength).join(':');
  }

  /* An address of the given family ('ipv4' or 'ipv6') as comparable units; null when the text is not one */
  function netAddressOf(text, family) {
    if (family === 'ipv4') {
      var v4 = netParseIPv4(text);
      return v4 === null ? null : { family: 'IPv4', units: v4, bits: 8, total: 32 };
    }
    var v6 = netParseIPv6(text);
    return v6 === null ? null : { family: 'IPv6', units: v6, bits: 16, total: 128 };
  }

  function netTextOf(parsed) {
    return parsed.family === 'IPv4' ? parsed.units.join('.') : netFormatIPv6(parsed.units);
  }

  /**
   * The type argument of the BlockList methods: 'ipv4' unless told otherwise, as Node defaults it.
   * One that is not a string at all -- a number, or null -- is the type error Node reports for it,
   * and a string naming no family is an invalid value whose text calls the argument 'options.family',
   * which is Node's own wording for what the receiver called 'type'.
   */
  function netBlockFamily(type) {
    if (type === undefined) return 'ipv4';
    if (typeof type !== 'string') {
      throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
        'The "family" argument must be of type string. Received ' + netDescribe(type));
    }
    var kind = type.toLowerCase();
    if (kind !== 'ipv4' && kind !== 'ipv6') {
      throw netError(TypeError, 'ERR_INVALID_ARG_VALUE',
        "The property 'options.family' is invalid. Received " + netInspectValue(type));
    }
    return kind;
  }

  /** An address argument of a BlockList method: Node refuses one that is not a string by type. */
  function netBlockAddress(value, name) {
    if (typeof value !== 'string') {
      throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
        'The "' + name + '" argument must be of type string. Received ' + netDescribe(value));
    }
    return value;
  }

  /**
   * The prefix of a subnet rule: a number, an integer, and within the width of the family it names
   * -- 32 bits for IPv4, 128 for IPv6 -- with each band answered the way Node 24.15 answers it.
   */
  function netBlockPrefix(prefix, total) {
    if (typeof prefix !== 'number') {
      throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
        'The "prefix" argument must be of type number. Received ' + netDescribe(prefix));
    }
    if (!Number.isInteger(prefix)) {
      throw netError(RangeError, 'ERR_OUT_OF_RANGE',
        'The value of "prefix" is out of range. It must be an integer. Received ' + String(prefix));
    }
    if (prefix < 0 || prefix > total) {
      throw netError(RangeError, 'ERR_OUT_OF_RANGE',
        'The value of "prefix" is out of range. It must be >= 0 && <= ' + total + '. Received ' + String(prefix));
    }
  }

  /**
   * The flow label of a SocketAddress: a number inside the 32 bits the field holds, and carried only
   * by an IPv6 address -- IPv4 has no such field, so host Node 24.15 answers 0 whatever it was given.
   */
  function netSocketFlowlabel(value, family) {
    if (value === undefined) return 0;
    if (typeof value !== 'number') {
      throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
        'The "options.flowlabel" property must be of type number. Received ' + netDescribe(value));
    }
    if (!Number.isInteger(value)) {
      throw netError(RangeError, 'ERR_OUT_OF_RANGE',
        'The value of "options.flowlabel" is out of range. It must be an integer. Received ' + String(value));
    }
    if (value < 0 || value > 4294967295) {
      throw netError(RangeError, 'ERR_OUT_OF_RANGE',
        'The value of "options.flowlabel" is out of range. It must be >= 0 && <= 4294967295. Received ' + String(value));
    }
    return family === 'ipv6' ? value : 0;
  }

  function netCompareUnits(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  /* True when the first prefix bits of address equal those of network */
  function netPrefixMatches(network, address, prefix) {
    var remaining = prefix;
    for (var i = 0; i < network.units.length && remaining > 0; i++) {
      var take = Math.min(network.bits, remaining);
      var shift = network.bits - take;
      if ((network.units[i] >> shift) !== (address.units[i] >> shift)) return false;
      remaining -= take;
    }
    return true;
  }

  /**
   * The host and port a URL reads out of 'http://' + input, with the family the brackets (or their
   * absence) ask for; null for a string a URL refuses. A bracketed literal is IPv6 and a zone id is
   * not a thing a URL's host may carry; an unbracketed one keeps its last colon as the separator, so
   * a literal carrying a colon of its own -- '::1', '::' -- is not a host at all.
   */
  function netSplitHostPort(input) {
    var host;
    var portText;
    var family;
    if (input.charAt(0) === '[') {
      var close = input.indexOf(']');
      if (close === -1) return null;
      host = input.slice(1, close);
      if (host.indexOf('%') !== -1) return null;
      var rest = input.slice(close + 1);
      if (rest !== '' && rest.charAt(0) !== ':') return null;
      portText = rest === '' ? '' : rest.slice(1);
      family = 'ipv6';
    } else {
      var colon = input.lastIndexOf(':');
      if (colon === -1) {
        host = input;
        portText = '';
      } else {
        host = input.slice(0, colon);
        portText = input.slice(colon + 1);
      }
      if (host === '' || host.indexOf(':') !== -1) return null;
      family = 'ipv4';
    }
    if (portText !== '' && !/^[0-9]+$/.test(portText)) return null;
    var port = portText === '' ? 0 : Number(portText);
    if (port > 65535) return null;
    /* 80 is the port of the scheme Node prepends, so the URL carries none and the port reads back 0;
       every other port, 0 included, is the number it was given. */
    return { host: host, port: port === 80 ? 0 : port, family: family };
  }

  /* One part of a dotted quad as the URL host parser reads it: a leading '0x' is hexadecimal, a
     leading zero octal, anything else decimal; null for a part it cannot read. */
  function netUrlIPv4Number(part) {
    if (part === '') return null;
    var radix = 10;
    var digits = part;
    if (part.length > 1 && part.charAt(0) === '0' && (part.charAt(1) === 'x' || part.charAt(1) === 'X')) {
      radix = 16;
      digits = part.slice(2);
    } else if (part.length > 1 && part.charAt(0) === '0') {
      radix = 8;
      digits = part.slice(1);
    }
    if (digits === '') return 0;
    if (radix === 16 && !/^[0-9a-fA-F]+$/.test(digits)) return null;
    if (radix === 8 && !/^[0-7]+$/.test(digits)) return null;
    if (radix === 10 && !/^[0-9]+$/.test(digits)) return null;
    var value = 0;
    for (var i = 0; i < digits.length; i++) value = value * radix + parseInt(digits.charAt(i), radix);
    return value;
  }

  /* A dotted quad as the URL host parser reads it: one to four parts, the last of them filling every
     byte the others leave, so '01.2.3.4' is '1.2.3.4', '010.1.1.1' is '8.1.1.1', and '127.1' and
     '2130706433' are both '127.0.0.1'; null for anything that is not one. Host Node 24.15 reads the
     text this way and not as 'net.isIPv4' does, which answers false for all four of them. */
  function netUrlIPv4(text) {
    if (netIsIPv4(text)) return text;
    if (text === '' || !/^[0-9a-fA-FxX.]+$/.test(text)) return null;
    var parts = text.split('.');
    if (parts.length > 4) return null;
    var head = [];
    var i;
    for (i = 0; i < parts.length - 1; i++) {
      var value = netUrlIPv4Number(parts[i]);
      if (value === null || value > 255) return null;
      head.push(value);
    }
    var last = netUrlIPv4Number(parts[parts.length - 1]);
    if (last === null) return null;
    if (head.length > 3) return null;
    if (last >= Math.pow(256, 4 - head.length)) return null;
    var bytes = head.slice();
    for (i = head.length; i < 4; i++) bytes.push(Math.floor(last / Math.pow(256, 3 - i)) % 256);
    return bytes.join('.');
  }

  /* net.BlockList: address, range and subnet rules, each of one family; rules lists the newest first, as Node does */
  class BlockList {
    constructor() {
      netHide(this, '_rules', []);
    }

    addAddress(address, type) {
      var text = netBlockAddress(address, 'address');
      var parsed = netAddressOf(text, netBlockFamily(type));
      if (parsed === null) throw netError(TypeError, 'ERR_INVALID_ADDRESS', 'Invalid socket address');
      this._rules.push({ kind: 'Address', family: parsed.family, units: parsed.units, bits: parsed.bits, text: netTextOf(parsed) });
    }

    addRange(start, end, type) {
      var firstText = netBlockAddress(start, 'start');
      var lastText = netBlockAddress(end, 'end');
      var kind = netBlockFamily(type);
      var first = netAddressOf(firstText, kind);
      var last = netAddressOf(lastText, kind);
      if (first === null || last === null) throw netError(TypeError, 'ERR_INVALID_ADDRESS', 'Invalid socket address');
      if (netCompareUnits(first.units, last.units) > 0) {
        /* Node names the start it was handed as a SocketAddress, the way inspect prints one. */
        throw netError(TypeError, 'ERR_INVALID_ARG_VALUE',
          "The argument 'start' must come before end. Received SocketAddress { address: '"
          + netTextOf(first) + "', port: 0, family: '" + kind + "', flowlabel: 0 }");
      }
      this._rules.push({ kind: 'Range', family: first.family, units: first.units, end: last.units, bits: first.bits, text: netTextOf(first) + '-' + netTextOf(last) });
    }

    addSubnet(network, prefix, type) {
      var text = netBlockAddress(network, 'network');
      var parsed = netAddressOf(text, netBlockFamily(type));
      if (parsed === null) throw netError(TypeError, 'ERR_INVALID_ADDRESS', 'Invalid socket address');
      netBlockPrefix(prefix, parsed.total);
      this._rules.push({ kind: 'Subnet', family: parsed.family, units: parsed.units, bits: parsed.bits, prefix: prefix, text: netTextOf(parsed) + '/' + prefix });
    }

    check(address, type) {
      var text = netBlockAddress(address, 'address');
      var parsed = netAddressOf(text, netBlockFamily(type));
      if (parsed === null) return false;
      for (var i = 0; i < this._rules.length; i++) {
        var rule = this._rules[i];
        if (rule.family !== parsed.family) continue;
        if (rule.kind === 'Address') {
          if (netCompareUnits(rule.units, parsed.units) === 0) return true;
        } else if (rule.kind === 'Range') {
          if (netCompareUnits(rule.units, parsed.units) <= 0 && netCompareUnits(parsed.units, rule.end) <= 0) return true;
        } else if (netPrefixMatches(rule, parsed, rule.prefix)) {
          return true;
        }
      }
      return false;
    }

    /** The rules as JSON: the same list 'rules' answers with, newest first. */
    toJSON() {
      return this.rules;
    }

    /**
     * Adds the rules a JSON string or an array of strings names -- 'Address: IPv4 1.2.3.4',
     * 'Subnet: IPv4 192.168.1.0/24', 'Range: IPv4 10.0.0.1-10.0.0.10' -- which is the text 'rules'
     * writes them in. A rule whose kind or family is spelled some other way is skipped, as Node
     * skips it, and the argument itself is ERR_INVALID_ARG_TYPE for a string or array of strings
     * that is not one ('The "data" argument must be of type string or string[].').
     */
    fromJSON(data) {
      var rules = data;
      if (typeof data === 'string') {
        rules = JSON.parse(data);
        if (!Array.isArray(rules)) {
          throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
            'The "data" argument must be of type string or string[]. Received ' + netDescribe(data));
        }
      } else if (!Array.isArray(rules)) {
        throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
          'The "data" argument must be of type string or string[]. Received ' + netDescribe(data));
      }
      for (var i = 0; i < rules.length; i++) {
        if (typeof rules[i] !== 'string') {
          throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
            'The "data" argument must be of type string or string[]. Received ' + netDescribe(data));
        }
      }
      for (var n = 0; n < rules.length; n++) {
        var parts = rules[n].split(' ');
        var kind = parts[0].slice(-1) === ':' ? parts[0].slice(0, -1) : parts[0];
        var family = parts[1] === 'IPv4' ? 'ipv4' : parts[1] === 'IPv6' ? 'ipv6' : null;
        if (family === null || parts[2] === undefined || parts[2] === '') continue;
        var body = parts[2];
        if (kind === 'Address') {
          this.addAddress(body.split('/')[0], family);
        } else if (kind === 'Subnet') {
          var at = body.lastIndexOf('/');
          if (at === -1) continue;
          this.addSubnet(body.slice(0, at), Number(body.slice(at + 1)), family);
        } else if (kind === 'Range') {
          var dash = body.indexOf('-');
          if (dash === -1) continue;
          this.addRange(body.slice(0, dash), body.slice(dash + 1), family);
        }
      }
    }

    get rules() {
      var out = [];
      for (var i = this._rules.length - 1; i >= 0; i--) {
        var rule = this._rules[i];
        out.push(rule.kind + ': ' + rule.family + ' ' + rule.text);
      }
      return out;
    }
  }

  /* The peer a socket reports: what the handle says while there is one, or -- once the handle is
     gone -- what a caller last read, which is the one way a destroyed socket still names a peer. */
  var NET_NO_PEER = { address: undefined, port: undefined, family: undefined };

  function netPeerName(socket) {
    if (socket._remoteCache === undefined && socket._remoteName !== undefined) {
      socket._remoteCache = socket._remoteName;
    }
    return socket._remoteCache === undefined ? NET_NO_PEER : socket._remoteCache;
  }

  /* An own field kept out of Object.keys: host Node holds a SocketAddress's and a BlockList's state
     in a native handle, so an instance of either enumerates nothing at all. */
  function netHide(target, key, value) {
    Object.defineProperty(target, key, { value: value, writable: true, enumerable: false, configurable: true });
  }

  /* net.SocketAddress: an immutable address, family ('ipv4' or 'ipv6'), port and flow label */
  class SocketAddress {
    /* No named parameter, because Node's own constructor answers 'length' 0: it defaults the whole
       options object, so 'new SocketAddress()' and 'new SocketAddress({ ... })' are one signature. */
    constructor() {
      var options = arguments[0];
      /* The options object is required to be one -- undefined builds the default address, and null,
         a number, a string, an array and a function are each ERR_INVALID_ARG_TYPE 'The "options"
         argument must be of type object', which is Node's validateObject with no array or function
         allowed. */
      if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
        throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
          'The "options" argument must be of type object. Received ' + netDescribe(options));
      }
      var opts = options === undefined ? {} : options;
      var family = opts.family === undefined ? 'ipv4' : String(opts.family).toLowerCase();
      if (family !== 'ipv4' && family !== 'ipv6') {
        throw netError(TypeError, 'ERR_INVALID_ARG_VALUE',
          "The property 'options.family' is invalid. Received " + netInspectValue(opts.family));
      }
      /* The address of an IPv6 socket with none named is the unspecified '::', not '::1': the
         SocketAddress host Node 24.15 builds with no address carries the family's own wildcard --
         and it picks it from the family as it was given, before the case is folded, so 'ipv4' names
         '127.0.0.1' while 'iPv4' and 'IPV4' name '::' and are then asked to hold it as IPv4, which
         is ERR_INVALID_ADDRESS 'Invalid socket address'. */
      var address = opts.address === undefined
        ? (opts.family === undefined || opts.family === 'ipv4' ? '127.0.0.1' : '::')
        : opts.address;
      if (typeof address !== 'string') {
        throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
          'The "options.address" property must be of type string. Received ' + netDescribe(address));
      }
      var parsed = netAddressOf(address, family);
      if (parsed === null) throw netError(TypeError, 'ERR_INVALID_ADDRESS', 'Invalid socket address');
      /* The address a SocketAddress keeps is the one the kernel renders, not the one it was handed:
         lower case, its longest run of zero groups compressed, a v4-mapped one written in dotted
         IPv4 -- '2001:DB8::1' is kept as '2001:db8::1' and '::FFFF:7B7B:7B7B' as
         '::ffff:123.123.123.123'. */
      netHide(this, '_address', netTextOf(parsed));
      netHide(this, '_port', opts.port === undefined ? 0 : netPortOf(opts.port, true));
      netHide(this, '_family', family);
      netHide(this, '_flowlabel', netSocketFlowlabel(opts.flowlabel, family));
    }

    get address() {
      return this._address;
    }

    get port() {
      return this._port;
    }

    get family() {
      return this._family;
    }

    get flowlabel() {
      return this._flowlabel;
    }

    /** The address as JSON: address, port, family and flow label, in Node's own order. */
    toJSON() {
      return { address: this._address, port: this._port, family: this._family, flowlabel: this._flowlabel };
    }

    /**
     * An 'address:port' or '[address]:port' string as a SocketAddress, or undefined for one that is
     * neither. An input that is not a string is ERR_INVALID_ARG_TYPE 'The "input" argument must be
     * of type string', the way Node refuses it.
     *
     * Host Node 24.15 reads the string as the host and port of a URL: it reads
     * 'http://' + input, and that reading is what decides every case here. 80 is
     * the scheme's own port, so the URL carries none and the port comes back 0
     * ('127.0.0.1:80' is port 0 while ':1' is 1). A bracketed literal is IPv6, and
     * a zone id is a thing a URL's host may not carry, so a bracketed one is not
     * parsed at all. An unbracketed literal with a colon of its own -- '::1' -- is
     * not a URL's host. And a dotted quad is read by the URL host parser, which
     * takes '01.2.3.4' for '1.2.3.4'.
     */
    static parse(input) {
      if (typeof input !== 'string') {
        throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
          'The "input" argument must be of type string. Received ' + netDescribe(input));
      }
      /* Trailing space is stripped off the whole URL string, so '1.2.3.4 ' is parsed; a leading
         space sits inside the authority and is not, so ' 1.2.3.4' is not. */
      var split = netSplitHostPort(input.replace(/[\s]+$/, ''));
      if (split === null) return undefined;
      if (split.family === 'ipv6') {
        if (!netIsIPv6(split.host)) return undefined;
        return new SocketAddress({ address: split.host, family: 'ipv6', port: split.port });
      }
      var text = netUrlIPv4(split.host);
      if (text === null) return undefined;
      return new SocketAddress({ address: text, family: 'ipv4', port: split.port });
    }
  }

  /* What Node prints for one: its four fields in the order it lists them, not the fields this
     implementation keeps them in. */
  var SOCKET_ADDRESS_INSPECT = typeof Symbol.for === 'function' ? Symbol.for('nodejs.util.inspect.custom') : undefined;
  if (SOCKET_ADDRESS_INSPECT !== undefined) {
    Object.defineProperty(SocketAddress.prototype, SOCKET_ADDRESS_INSPECT, {
      value: function () {
        return 'SocketAddress { address: ' + netInspectValue(this._address) + ', port: ' + this._port
          + ', family: ' + netInspectValue(this._family) + ', flowlabel: ' + this._flowlabel + ' }';
      },
      writable: true, configurable: true
    });
  }

  function netConnect() {
    var first = arguments[0];
    var socket = new Socket(first !== null && typeof first === 'object' ? first : undefined);
    return socket.connect.apply(socket, arguments);
  }

  return {
    Server: Server,
    Socket: Socket,
    Stream: Socket,
    BlockList: BlockList,
    SocketAddress: SocketAddress,
    createServer: function (options, listener) {
      return new Server(options, listener);
    },
    connect: netConnect,
    createConnection: netConnect,
    isIP: netIsIP,
    isIPv4: netIsIPv4,
    isIPv6: netIsIPv6,
    getDefaultAutoSelectFamily: function () {
      return NET_AUTO_SELECT_FAMILY;
    },
    /* A setter that sets: host Node 24.15 keeps the flag a caller gave it, and refuses one that is
       not a boolean with ERR_INVALID_ARG_TYPE 'The "value" argument must be of type boolean'. */
    setDefaultAutoSelectFamily: function (value) {
      if (typeof value !== 'boolean') {
        throw netError(TypeError, 'ERR_INVALID_ARG_TYPE',
          'The "value" argument must be of type boolean. Received ' + netDescribe(value));
      }
      NET_AUTO_SELECT_FAMILY = value;
    },
    getDefaultAutoSelectFamilyAttemptTimeout: function () {
      return NET_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT;
    },
    setDefaultAutoSelectFamilyAttemptTimeout: function (value) {
      NET_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT = value;
    }
  };
};

BF['dgram'] = function () {
  var EventEmitter = netEmitterBase();

  /* Named Socket, as Node's is: dgram.Socket.name is 'Socket' on host Node 24.15, and the class
     is the one dgram.Socket hands out. */
  class Socket extends EventEmitter {
    constructor(type) {
      super();
      /* 'udp4' or 'udp6', as an own field of the socket and not a getter on the prototype: that
         is where host Node 24.15 keeps it, so it is what an instance enumerates. */
      this.type = type;
      this._family = type === 'udp6' ? 'IPv6' : 'IPv4';
      this._hubId = undefined;
      this._targetId = undefined;
      this._bound = false;
      this._binding = false;
      this._dead = false;
      this._address = null;
      this._refed = true;
      this._holding = false;
      this._remote = null;
      this._recvBufferSize = undefined;
      this._sendBufferSize = undefined;
      /* The groups this socket has joined, and the source-specific ones: a group joined without a
         source is what makes a later source-specific join of it EINVAL, as a host's kernel
         answers it, so the membership is kept to answer that. */
      this._joined = [];
      this._sources = [];
      /* Kept out of what an instance enumerates, as a host's own state is: host Node 24.15 holds
         a dgram socket's in a native handle, so Object.keys of one is its own type and nothing
         else. This socket reads them by name, so hiding them changes nothing else. */
      var hidden = ['_family', '_hubId', '_targetId', '_bound', '_binding', '_dead', '_address',
        '_refed', '_holding', '_remote', '_recvBufferSize', '_sendBufferSize', '_joined', '_sources'];
      for (var h = 0; h < hidden.length; h++) {
        Object.defineProperty(this, hidden[h], {
          value: this[hidden[h]], writable: true, enumerable: false, configurable: true
        });
      }
    }

    _holdable() {
      return (this._bound || this._binding) && !this._dead;
    }

    _onHub(name, payload, bytes) {
      if (name !== 'message' || this._dead || !this._bound) return;
      var datagram = bytes === undefined ? Buffer.from(payload.data, 'base64') : Buffer.from(bytes);
      /* The family is the one the peer's address is written in, not this socket's own: a udp6 socket
         on the wildcard sees an IPv4 peer as '::ffff:127.0.0.1'/IPv6, and one bound to the mapped
         loopback sees the same peer as '127.0.0.1'/IPv4, which is what host Node reports there. */
      var rinfo = {
        address: payload.address,
        family: netFamilyName(payload.address),
        port: payload.port,
        size: datagram.length
      };
      /* A listener that ends the process -- or throws -- does it from inside the hub's delivery,
         while the host still holds the handles it handed that delivery, and the unwind skips the
         code that frees them: an object stays on the runtime's list and QuickJS asserts on it when
         the runtime is freed, printing one Aborted(Assertion failed: list_empty(&rt->gc_obj_list))
         line on the host's own stderr after the container's own output has matched. So the throw is
         raised a task later, when the delivery has answered and its handles are gone. An exit is
         raised not at all: process.exit has already written the status and never returns on a host
         either. */
      try {
        this.emit('message', datagram, rinfo);
      } catch (thrown) {
        if (!api.isExitSignal(thrown)) netDefer(function () { throw thrown; });
      }
    }

    bind() {
      var args = netBindArgs(arguments);
      if (this._dead) throw netError(Error, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
      if (this._bound || this._binding) throw netError(Error, 'ERR_SOCKET_ALREADY_BOUND', 'Socket is already bound');
      /* A dgram bind coerces what it cannot read as a port to 0 rather than refusing it, as host
         Node 24.15 does: bind('/tmp/x.sock') and bind('abc') bind an ephemeral UDP port
         (0.0.0.0:55602 there), where a path meant as a unix socket is not a thing dgram opens. */
      var port = args.port === undefined ? 0
        : netPortOf(typeof args.port === 'string' && !/^\d+$/.test(args.port) ? 0 : args.port);
      /* A zone id is not part of the address a UDP socket binds or sends to: a host's own getsockname
         answers '::1' for a socket bound on '::1%lo0', and a datagram sent to the scoped literal
         arrives at the address the zone is attached to. */
      var shown = args.address
        ? netStripZone(netListenDisplay(args.address))
        : (this._family === 'IPv6' ? '::' : '0.0.0.0');
      if (this._targetId === undefined) {
        var target = this;
        this._targetId = createTarget(function (name, payload, bytes) {
          target._onHub(name, payload, bytes);
        });
      }
      var res;
      try {
        res = callCap('net.udpBind', {
          /* A udp6 socket is handed the address it was given, IPv4 spelling included: the hub folds
             '0.0.0.0' to the wildcard for an IPv4 socket, and an IPv6 one handed the same literal
             is the host's EINVAL, which only the literal itself can tell it. */
          address: this._family === 'IPv6' ? shown : netListenHub(shown),
          port: port,
          targetId: this._targetId,
          family: this._family
        });
      } catch (cause) {
        var failed = netSystemError(cause, 'bind', shown, port);
        var failedSocket = this;
        netDefer(function () { failedSocket.emit('error', failed); });
        return this;
      }
      this._hubId = res.id;
      this._address = { address: netListenShown(shown), family: this._family, port: res.port };
      this._binding = true;
      netRefresh(this);
      if (typeof args.cb === 'function') this.once('listening', args.cb);
      /* A dgram bind is asynchronous, as a host's is: the descriptor the buffer-size getters and
         setters read exists only once the socket is listening, so in the window between bind()
         and 'listening' host Node 24.15 answers them EBADF. The hub id is assigned here, so a
         datagram sent in that window still has somewhere to go. */
      var listeningSocket = this;
      netDefer(function () {
        if (listeningSocket._dead || !listeningSocket._binding) return;
        listeningSocket._binding = false;
        listeningSocket._bound = true;
        listeningSocket.emit('listening');
      });
      return this;
    }

    send() {
      var args = Array.prototype.slice.call(arguments);
      var callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
      if (this._dead) throw netError(Error, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
      var datagram;
      var port;
      var address;
      if (args.length >= 4 && typeof args[2] === 'number') {
        datagram = netToBuffer(args[0]).slice(args[1], args[1] + args[2]);
        port = args[3];
        address = args[4];
      } else {
        datagram = Array.isArray(args[0])
          ? Buffer.concat(args[0].map(function (part) { return netToBuffer(part); }))
          : netToBuffer(args[0]);
        port = args[1];
        address = args[2];
      }
      if (this._remote !== null) {
        if (args.length >= 2 && port !== undefined) {
          throw netError(Error, 'ERR_SOCKET_DGRAM_IS_CONNECTED', 'Already connected');
        }
        port = this._remote.port;
        address = this._remote.address;
      }
      port = netPortOf(port);
      var target = address === undefined || address === null || address === '' ? 'localhost' : String(address);
      if (!this._bound && !this._binding) this.bind(0);
      var self = this;
      netResolve(target, this._family === 'IPv6' ? 6 : 4, function (failure, resolved) {
        if (failure) {
          if (typeof callback === 'function') netDefer(function () { callback(failure); });
          else self.emit('error', failure);
          return;
        }
        /* A datagram addressed to the other family is refused by the send itself, the way
           uv_udp_send answers it, rather than dropped without a word. */
        var destination = netStripZone(resolved);
        if ((netIsIP(destination) === 6) !== (self._family === 'IPv6')) {
          var mismatch = netError(Error, 'EINVAL', 'send EINVAL ' + destination + ':' + port);
          mismatch.errno = -22;
          mismatch.syscall = 'send';
          if (typeof callback === 'function') netDefer(function () { callback(mismatch); });
          else self.emit('error', mismatch);
          return;
        }
        if (self._hubId !== undefined) {
          try {
            callCapBytes('net.udpSend', { socketId: self._hubId, address: destination, port: port }, datagram);
          } catch (cause) {
            /* A datagram the hub refuses -- an IPv4 destination a socket bound to one address of its
               own has no route to, and the unspecified address no socket has a route to at all --
               is the send's own answer, as uv_udp_send gives it. Anything else raised here is a
               socket that is gone, and UDP drops those without a word. */
            var code = cause && cause.code;
            if (code === 'EADDRNOTAVAIL' || code === 'EHOSTUNREACH' || code === 'EINVAL') {
              var refused = netSystemError(cause, 'send', destination, port);
              /* The errno the kernel pairs with the code, which a send is the only path to raise:
                 no route to the address, -65, as uv_udp_send reports it on a host. */
              if (refused.errno === undefined && code === 'EHOSTUNREACH') refused.errno = -65;
              if (typeof callback === 'function') netDefer(function () { callback(refused); });
              else self.emit('error', refused);
              return;
            }
          }
        }
        if (typeof callback === 'function') netDefer(function () { callback(null, datagram.length); });
      });
    }

    close(callback) {
      if (typeof callback === 'function') this.once('close', callback);
      if (this._dead) return this;
      this._dead = true;
      this._bound = false;
      if (this._hubId !== undefined) {
        try {
          callCap('net.udpClose', { id: this._hubId });
        } catch (cause) {
          // Already closed.
        }
      }
      this._hubId = undefined;
      netRefresh(this);
      if (this._targetId !== undefined) {
        deleteTarget(this._targetId);
        this._targetId = undefined;
      }
      var closing = this;
      netDefer(function () { closing.emit('close'); });
      return this;
    }

    address() {
      /* A socket that was never bound has no name to return and no file descriptor to ask, which
         Node reports as EBADF from getsockname; one that was closed is no longer running at all. */
      if (this._dead) throw netError(Error, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
      if (!this._bound || this._address === null) {
        /* errno -9 is the figure host Node 24.15's own EBADF carries, and it is what a caller
           reads off the error: the code alone does not say which descriptor failed. */
        throw Object.assign(netError(Error, 'EBADF', 'getsockname EBADF'), { syscall: 'getsockname', errno: -9 });
      }
      return { address: this._address.address, family: this._address.family, port: this._address.port };
    }

    connect() {
      var args = netBindArgs(arguments);
      if (this._dead) throw netError(Error, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
      if (this._remote !== null) throw netError(Error, 'ERR_SOCKET_DGRAM_IS_CONNECTED', 'Already connected');
      var port = netPortOf(args.port);
      if (!this._bound && !this._binding) this.bind(0);
      if (typeof args.cb === 'function') this.once('connect', args.cb);
      var self = this;
      netResolve(args.address, this._family === 'IPv6' ? 6 : 4, function (failure, resolved) {
        if (failure) {
          self.emit('error', failure);
          return;
        }
        self._remote = { address: resolved, port: port, family: netFamilyName(resolved) };
        netDefer(function () { self.emit('connect'); });
      });
      return this;
    }

    disconnect() {
      if (this._remote === null) throw netError(Error, 'ERR_SOCKET_DGRAM_NOT_CONNECTED', 'Not connected');
      this._remote = null;
    }

    remoteAddress() {
      if (this._remote === null) throw netError(Error, 'ERR_SOCKET_DGRAM_NOT_CONNECTED', 'Not connected');
      return { address: this._remote.address, family: this._remote.family, port: this._remote.port };
    }

    ref() {
      this._refed = true;
      netRefresh(this);
      return this;
    }

    unref() {
      this._refed = false;
      netRefresh(this);
      return this;
    }

    /* Every TTL, broadcast and multicast option is a kernel setting this virtual network has no
       kernel for. What is carried is the answer host Node 24.15 gives for it, which is where the
       surface is observable: the argument each call refuses, the errno it refuses it with, the
       value it hands back, and the three states a socket may be in -- closed, unbound, bound. */
    setBroadcast() {
      if (this._dead) throw netDgramGone('setBroadcast');
      if (!this._bound) throw netDgramUvError('setBroadcast', 'EBADF', -9);
    }

    /* A second-to-live count of 1..255: uv truncates what it is handed, so 255.5 is 255 and 0.5
       is the 0 a datagram may not be forwarded with, which the kernel refuses (EINVAL, -22). */
    setTTL(ttl) {
      netDgramArg(ttl, 'ttl', 'number');
      if (this._dead) throw netDgramGone('setTTL');
      var whole = netDgramByte(ttl);
      if (!(whole >= 1 && whole <= 255)) throw netDgramUvError('setTTL', 'EINVAL', -22);
      /* A socket still binding has no descriptor yet, as a host's does not: uv_udp_set_ttl is
         asked for one before 'listening' has made it, and answers EBADF. */
      if (!this._bound) throw netDgramUvError('setTTL', 'EBADF', -9);
      return ttl;
    }

    /* The hop count of a multicast datagram, 0..255: 0 keeps it on this host, which the kernel
       accepts, where a TTL of 0 is one it does not. */
    setMulticastTTL(ttl) {
      netDgramArg(ttl, 'ttl', 'number');
      if (this._dead) throw netDgramGone('setMulticastTTL');
      /* An int, not a byte: libuv hands a hop count to the kernel as a signed 32-bit int, so
         NaN, Infinity and 2^53 are all 0 -- a hop count the kernel accepts -- and 256 or -1 are
         the EINVAL (-22) a socket outside 0..255 is. */
      var hops = netDgramInt32(ttl);
      if (!(hops >= 0 && hops <= 255)) throw netDgramUvError('setMulticastTTL', 'EINVAL', -22);
      if (!this._bound) throw netDgramUvError('setMulticastTTL', 'EBADF', -9);
      return ttl;
    }

    /* Whether a datagram this socket sends is looped back to it: answered with the flag itself,
       whatever it was, as host Node 24.15 answers it. */
    setMulticastLoopback(flag) {
      if (this._dead) throw netDgramGone('setMulticastLoopback');
      if (!this._bound) throw netDgramUvError('setMulticastLoopback', 'EBADF', -9);
      return flag;
    }

    /* The interface multicast goes out on: an address of this socket's own family, and on this
       platform not an IPv6 one -- the loopback is the only address this container has and no
       IPv6 interface carries multicast, which is the EINVAL (-22) host Node 24.15 reports for
       '::1' on a udp6 socket. */
    setMulticastInterface(interfaceAddress) {
      if (this._dead) throw netError(Error, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
      netDgramArg(interfaceAddress, 'interfaceAddress', 'string');
      var want6 = this._family === 'IPv6';
      var family = netIsIP(interfaceAddress);
      /* A text no family can hold is refused before the socket is asked for its handle, so an
         unbound socket reports the descriptor it does not have (EBADF) rather than the address
         it cannot use (EINVAL) -- host Node 24.15 answers EBADF for '::1' on an unbound udp4
         socket and EINVAL for the same address on a bound one. */
      if (family === 0) throw netDgramUvError('setMulticastInterface', 'EINVAL', -22);
      if (!this._bound) throw netDgramUvError('setMulticastInterface', 'EBADF', -9);
      /* On an IPv6 socket the address must carry a zone: the interface a multicast datagram goes
         out on is named by index, and this platform's loopback has no IPv6 interface to index,
         which is the EINVAL (-22) host Node 24.15 answers for a bare '::1'. A zoned literal --
         '::1%lo0' -- names one, so it is accepted. On an IPv4 socket the address has to be one
         this host owns: anything else, a multicast group among them, is EADDRNOTAVAIL (-49). */
      if (want6) {
        if (interfaceAddress.indexOf('%') === -1) throw netDgramUvError('setMulticastInterface', 'EINVAL', -22);
      } else if ((family === 6) !== want6) {
        throw netDgramUvError('setMulticastInterface', 'EINVAL', -22);
      } else if (!netOwnAddress(interfaceAddress)) {
        throw netDgramUvError('setMulticastInterface', 'EADDRNOTAVAIL', -49);
      }
    }

    /* Buffer sizes are a kernel setting this runtime has no kernel for: accepted and checked, then
       remembered for the getter, which answers with this platform's own default until one is set. A
       size of 0 is the one value that leaves the figure alone, because that is what the host's kernel
       does with it -- host Node 24.15 still reports 786896 after setRecvBufferSize(0). */
    setRecvBufferSize(size) {
      netBufferSize(this, size, 'uv_recv_buffer_size');
      if (size > 0) this._recvBufferSize = Math.min(size, DGRAM_MAX_BUFFER_SIZE);
    }

    setSendBufferSize(size) {
      netBufferSize(this, size, 'uv_send_buffer_size');
      if (size > 0) this._sendBufferSize = Math.min(size, DGRAM_MAX_BUFFER_SIZE);
    }

    /* The size a bound dgram socket reports: whatever a setter gave it, or the size host Node 24.15
       reads off a socket of this platform that has never had one set. */
    getRecvBufferSize() {
      netBufferState(this, 'uv_recv_buffer_size');
      return this._recvBufferSize === undefined ? DGRAM_RECV_BUFFER_SIZE : this._recvBufferSize;
    }

    getSendBufferSize() {
      netBufferState(this, 'uv_send_buffer_size');
      return this._sendBufferSize === undefined ? DGRAM_SEND_BUFFER_SIZE : this._sendBufferSize;
    }

    /* Joining a group binds the socket if it was not bound yet, as Node's does, and keeps the
       group: a group it is already in is what makes a source-specific join of it EINVAL. An IPv6
       group reaches the kernel and comes back EADDRNOTAVAIL (-49) -- no interface of this host
       carries IPv6 multicast, so there is nothing to join it on. */
    addMembership(multicastAddress, multicastInterface) {
      if (this._dead) throw netError(Error, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
      /* A group that is not there at all -- undefined, '', 0, null or false -- is the
         ERR_MISSING_ARGS host Node 24.15 throws, a TypeError, not the EINVAL a text no family can
         hold would be. */
      if (!multicastAddress) {
        throw netError(TypeError, 'ERR_MISSING_ARGS', 'The "multicastAddress" argument must be specified');
      }
      /* A socket that was never bound is bound by the join, as Node's is -- and it is bound in the
         family of the group it was asked to join, so an unbound udp6 socket that joins 224.0.0.1
         comes back an IPv4 socket on 0.0.0.0, which is the name host Node 24.15 reports for it. */
      if (!this._bound && !this._binding) {
        var groupFamily = netIsIP(multicastAddress);
        if (groupFamily === 4 && this._family !== 'IPv4') this._family = 'IPv4';
        else if (groupFamily === 6 && this._family !== 'IPv6') this._family = 'IPv6';
        this.bind(0);
      }
      var want6 = this._family === 'IPv6';
      var fault = netDgramMulticastFault(multicastAddress, want6, false);
      if (fault !== null) throw netDgramUvError('addMembership', fault, -22);
      if (multicastInterface !== undefined) {
        var ifFamily = typeof multicastInterface === 'string' ? netIsIP(multicastInterface) : 0;
        if (ifFamily === 0 || (ifFamily === 6) !== want6) throw netDgramUvError('addMembership', 'EINVAL', -22);
      }
      if (want6) throw netDgramUvError('addMembership', 'EADDRNOTAVAIL', -49);
      /* Joining one group twice is the kernel's own EADDRINUSE (-48): the second ask is for a
         membership this socket is already holding. */
      if (this._joined.indexOf(multicastAddress) !== -1) {
        throw netDgramUvError('addMembership', 'EADDRINUSE', -48);
      }
      this._joined.push(multicastAddress);
    }

    /* Leaving a group: one that is not a multicast address at all is the kernel's EINVAL, whether
       or not this socket ever joined it, and an IPv6 one is the EADDRNOTAVAIL of a group no
       interface of this host could have joined. */
    dropMembership(multicastAddress) {
      if (this._dead) throw netError(Error, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
      if (!multicastAddress) {
        throw netError(TypeError, 'ERR_MISSING_ARGS', 'The "multicastAddress" argument must be specified');
      }
      var want6 = this._family === 'IPv6';
      var fault = netDgramMulticastFault(multicastAddress, want6, true);
      if (fault !== null) throw netDgramUvError('dropMembership', fault, -22);
      if (want6) throw netDgramUvError('dropMembership', 'EADDRNOTAVAIL', -49);
      /* Leaving a group this socket never joined is the kernel's EADDRNOTAVAIL (-49): host Node
         24.15 answers it for 224.0.0.1 on a socket that has joined nothing. */
      var at = this._joined.indexOf(multicastAddress);
      if (at === -1) throw netDgramUvError('dropMembership', 'EADDRNOTAVAIL', -49);
      this._joined.splice(at, 1);
    }

    /* A source-specific join names the source a group is joined for, so both are read as strings
       before either is looked at; a group this socket is already in without a source is EINVAL. */
    addSourceSpecificMembership(sourceAddress, groupAddress) {
      if (this._dead) throw netError(Error, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
      netDgramArg(sourceAddress, 'sourceAddress', 'string');
      netDgramArg(groupAddress, 'groupAddress', 'string');
      var want6 = this._family === 'IPv6';
      var fault = netDgramMulticastFault(groupAddress, want6, true);
      if (fault !== null) throw netDgramUvError('addSourceSpecificMembership', fault, -22);
      var sourceFamily = netIsIP(sourceAddress);
      if (sourceFamily === 0 || (sourceFamily === 6) !== want6) {
        throw netDgramUvError('addSourceSpecificMembership', 'EINVAL', -22);
      }
      if (want6) throw netDgramUvError('addSourceSpecificMembership', 'EADDRNOTAVAIL', -49);
      if (this._joined.indexOf(groupAddress) !== -1) {
        throw netDgramUvError('addSourceSpecificMembership', 'EINVAL', -22);
      }
      /* Joining the same source and group twice is the kernel's EADDRNOTAVAIL (-49), the way a
         second plain join of one group is its EADDRINUSE. */
      var key = sourceAddress + '|' + groupAddress;
      if (this._sources.indexOf(key) !== -1) {
        throw netDgramUvError('addSourceSpecificMembership', 'EADDRNOTAVAIL', -49);
      }
      this._sources.push(key);
    }

    /* Leaving one: a group this socket never joined that way is the kernel's EADDRNOTAVAIL. */
    dropSourceSpecificMembership(sourceAddress, groupAddress) {
      if (this._dead) throw netError(Error, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
      netDgramArg(sourceAddress, 'sourceAddress', 'string');
      netDgramArg(groupAddress, 'groupAddress', 'string');
      var want6 = this._family === 'IPv6';
      var fault = netDgramMulticastFault(groupAddress, want6, true);
      if (fault !== null) throw netDgramUvError('dropSourceSpecificMembership', fault, -22);
      var sourceFamily = netIsIP(sourceAddress);
      if (sourceFamily === 0 || (sourceFamily === 6) !== want6) {
        throw netDgramUvError('dropSourceSpecificMembership', 'EINVAL', -22);
      }
      /* Leaving a group this socket is not a source-specific member of is the kernel's
         EADDRNOTAVAIL (-49) on a host, whatever the join before it answered; one it joined that
         way leaves, so the pair a host answers -- join then leave -- is answered here as there. */
      var key = sourceAddress + '|' + groupAddress;
      var at = this._sources.indexOf(key);
      if (at === -1) throw netDgramUvError('dropSourceSpecificMembership', 'EADDRNOTAVAIL', -49);
      this._sources.splice(at, 1);
    }

    /* Nothing is ever queued: a datagram this socket hands the hub is delivered on the next
       macrotask, so both counts are 0, as a host's are for a socket that is not writing. */
    getSendQueueCount() {
      if (this._dead) throw netDgramGone('getSendQueueCount');
      return 0;
    }

    getSendQueueSize() {
      if (this._dead) throw netDgramGone('getSendQueueSize');
      return 0;
    }
  }

  function dgramCreateSocket(type, listener) {
    var kind = typeof type === 'string' ? type : (type !== null && typeof type === 'object' ? type.type : undefined);
    if (kind !== 'udp4' && kind !== 'udp6') {
      throw netError(TypeError, 'ERR_SOCKET_BAD_TYPE', 'Bad socket type specified. Valid types are: udp4, udp6');
    }
    var socket = new Socket(kind);
    /* The two sizes a socket can be opened with: Node passes them to the same setters, so a socket
       created with them reports them from the moment it is bound. */
    if (type !== null && typeof type === 'object') {
      if (typeof type.recvBufferSize === 'number' && type.recvBufferSize > 0) {
        socket._recvBufferSize = Math.min(type.recvBufferSize, DGRAM_MAX_BUFFER_SIZE);
      }
      if (typeof type.sendBufferSize === 'number' && type.sendBufferSize > 0) {
        socket._sendBufferSize = Math.min(type.sendBufferSize, DGRAM_MAX_BUFFER_SIZE);
      }
    }
    if (typeof listener === 'function') socket.on('message', listener);
    return socket;
  }

  return { createSocket: dgramCreateSocket, Socket: Socket };
};
})();
`;
