/**
 * Guest source for the child family: child_process, worker_threads and cluster. Host half:
 * ../../capabilities/child.ts.
 *
 * Mechanism. Each child is a container process. Its stdout and stderr reach the parent as events
 * (stdio 'pipe'), are forwarded through the parent's output (stdio 'inherit', the default for fork,
 * worker_threads and cluster workers), or are dropped ('ignore'). The parent holds a ref from spawn
 * until the child exits, so the parent waits for its children as Node does.
 *
 * IPC (fork, cluster workers, worker_threads). A child boots with OWC_IPC_KIND (fork | cluster | worker)
 * and OWC_IPC_DATA (JSON with the spawn token, threadId, workerData or cluster id) in its environment.
 * The bootstrap hook at the end of this source reads them, deletes them from process.env, attaches an IPC
 * target with the child.ipcAttach capability, and installs process.send / process.connected /
 * process.disconnect (fork, cluster) or parentPort (worker). Messages cross as tagged JSON: undefined,
 * bigint, NaN and Infinity, Date, Map, Set and typed arrays keep their type; functions and symbols throw
 * DataCloneError. A Buffer is the one view that comes back a Uint8Array; every other kind keeps its own. A forked child or cluster worker holds a ref while it has 'message' or 'disconnect'
 * listeners, as Node's refCounted channel does. An uncaught error in a worker thread is sent to the parent
 * as an 'error' event before the thread exits with code 1.
 *
 * Synchronous family. spawnSync, execSync and execFileSync run the child to completion inside one capability
 * call (child.spawnSync): the host steps the child's jobs, timers and synchronous host calls until it exits. A
 * child that waits on asynchronous host work (network, a grandchild, a promise-returning capability) cannot be
 * stepped there, so the call reports ERR_NOT_SUPPORTED with the output written so far.
 *
 * Known gaps. A child's stdout and stderr are read as a whole after the child ends, not streamed as
 * they are written. There is no SCM_RIGHTS handle passing and no cluster networking (servers are not
 * shared between workers). A BroadcastChannel name reaches the workers of one process and not the
 * channels of another, as it does on a host; a MessagePort transferred to a worker keeps working on
 * the link the two ends share.
 */
export const SRC = String.raw`
var cpState = {
  kind: null,
  data: {},
  connected: false,
  held: false,
  port: null,
  target: 0,
  exitHooked: false,
  threadCount: 0,
  tokenCount: 0,
  channels: [],
  portClass: null,
  childClass: null,
  broadcastClass: null,
  /* The value handed to a transferList while it is being encoded, so a port inside it crosses as the
     link it names and one outside it is refused the way node refuses it. */
  transfer: null,
  /* The set of threads one BroadcastChannel name reaches: a worker shares its parent's, a forked or
     clustered child has one of its own, which is what node gives a channel in another process. */
  bcDomain: null
};

var cpSignalNames = { 1: 'SIGHUP', 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' };

/* worker_threads' shared environment data: a map a thread writes and the workers it starts read.
   Host node 24.15 keys it by the value it was handed, not by that value as text:
   setEnvironmentData(9, 'nine') is read back with getEnvironmentData(9) and getEnvironmentData('9')
   answers undefined. A worker is seeded with the keys its parent held when it started it, and a key
   a worker sets is its own -- the parent reads undefined for it, as it does on the host. */
var cpEnvData = new Map();

function cpEnvDataSnapshot() {
  var entries = [];
  cpEnvData.forEach(function (value, key) {
    entries.push([cpEncode(key), cpEncode(value)]);
  });
  return entries;
}

function cpEnvDataSeed(entries) {
  if (!Array.isArray(entries)) return;
  for (var i = 0; i < entries.length; i++) {
    var pair = entries[i];
    if (!Array.isArray(pair) || pair.length < 2) continue;
    cpEnvData.set(cpDecode(pair[0]), cpDecode(pair[1]));
  }
}

/* A SharedArrayBuffer that crosses to another thread keeps sharing its memory there, so the bytes
   live on the host and both sides reach them through an id the buffer carries. A buffer that has
   never crossed answers for no id, and its atomics stay the local ones. */
var CP_SLAB = '__owcSlabId';

function cpSlabOf(buffer) {
  if (buffer === null || typeof buffer !== 'object') return null;
  var id = buffer[CP_SLAB];
  return typeof id === 'number' ? id : null;
}

function cpSlabMark(buffer, id) {
  try {
    Object.defineProperty(buffer, CP_SLAB, { value: id, writable: true, enumerable: false, configurable: true });
  } catch (ignored) {
    /* a buffer that will not carry the id keeps its own local memory, which is the old behaviour */
  }
}

function cpEE() {
  return requireBuiltin('events');
}

function cpError(message, code) {
  var err = new Error(message);
  if (code) err.code = code;
  return err;
}

function cpErrorJson(err) {
  var isObject = err !== null && typeof err === 'object';
  return {
    name: isObject && err.name ? String(err.name) : 'Error',
    message: isObject && err.message !== undefined ? String(err.message) : String(err),
    code: isObject && err.code !== undefined ? String(err.code) : undefined,
    stack: isObject && err.stack ? String(err.stack) : undefined
  };
}

function cpErrorFrom(json) {
  var err = new Error(json.message);
  if (json.name) err.name = json.name;
  if (json.code) err.code = json.code;
  if (json.stack) err.stack = json.stack;
  return err;
}

/* The typed array kinds a clone can hand back, in the order a Buffer is found in: a Buffer is a
   Uint8Array subclass, so its base class is the one its clone gets. */
var CP_VIEWS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];

function cpViewClass(value) {
  for (var i = 0; i < CP_VIEWS.length; i++) {
    var Ctor = globalThis[CP_VIEWS[i]];
    if (typeof Ctor === 'function' && value instanceof Ctor) return CP_VIEWS[i];
  }
  return 'Uint8Array';
}

function cpEncode(value) {
  if (value === undefined) return { $t: 'u' };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return value === value && value !== Infinity && value !== -Infinity ? value : { $t: 'x', v: String(value) };
  }
  if (typeof value === 'bigint') return { $t: 'n', v: value.toString() };
  if (typeof value === 'function' || typeof value === 'symbol') {
    var cloneError = cpError(String(value) + ' could not be cloned.', 'ERR_DATA_CLONE');
    cloneError.name = 'DataCloneError';
    throw cloneError;
  }
  if (value instanceof Date) return { $t: 'd', v: value.getTime() };
  if (value instanceof Map) {
    var entries = [];
    value.forEach(function (item, key) {
      entries.push([cpEncode(key), cpEncode(item)]);
    });
    return { $t: 'M', v: entries };
  }
  if (value instanceof Set) {
    var members = [];
    value.forEach(function (item) {
      members.push(cpEncode(item));
    });
    return { $t: 'S', v: members };
  }
  if (value instanceof DataView) {
    /* A structured clone keeps the class of a view: host Node 24.15 answers DataView for a DataView
       and Int32Array for an Int32Array, and Uint8Array only for a Buffer. */
    return { $t: 'B', c: 'DataView', v: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  }
  if (ArrayBuffer.isView(value)) {
    /* Only the bytes cross, but the class does too: a Buffer is the one view whose clone is a
       Uint8Array, and a view of any other kind comes back as the kind it was posted as. A subclass
       answers the base class it extends, as it does on the host. */
    return {
      $t: 'B', c: cpViewClass(value),
      v: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
    };
  }
  /* A SharedArrayBuffer is the one buffer whose clone shares memory with the value it was cloned
     from, so its bytes are put on the host under an id and the clone is another window onto them:
     the constructor, the instanceof and byteLength a host answers, and a write either side made
     through Atomics is visible to the other. */
  if (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer) {
    var slabId = cpSlabOf(value);
    if (slabId === null) {
      slabId = Number(callCap('shared.create', {
        n: value.byteLength,
        bytes: Buffer.from(new Uint8Array(value)).toString('base64')
      }).id);
      cpSlabMark(value, slabId);
    }
    return { $t: 'SB', id: slabId, n: value.byteLength };
  }
  if (value instanceof ArrayBuffer) return { $t: 'AB', v: Buffer.from(value).toString('base64') };
  /* A MessagePort is not a value a clone copies, it is one a clone moves. Named in the transferList
     it crosses as the link its two ends share and the port itself is left detached, as on the host;
     not named there, node refuses the whole message with the words it uses for that refusal, and
     not with the text of some function the port happens to hold. */
  if (value instanceof cpPortClass()) {
    if (cpState.transfer !== null && cpState.transfer.indexOf(value) >= 0) return cpPortTransfer(value);
    var untransferred = cpError('Object that needs transfer was found in message but not listed in transferList', 'ERR_DATA_CLONE');
    untransferred.name = 'DataCloneError';
    throw untransferred;
  }
  if (Array.isArray(value)) {
    return value.map(function (item) {
      return cpEncode(item);
    });
  }
  var out = {};
  var keys = Object.keys(value);
  var tagged = false;
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] === '$t') tagged = true;
    out[keys[i]] = cpEncode(value[keys[i]]);
  }
  return tagged ? { $t: 'o', v: out } : out;
}

function cpDecode(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(function (item) {
      return cpDecode(item);
    });
  }
  if (Object.prototype.hasOwnProperty.call(value, '$t')) {
    switch (value.$t) {
      case 'u': return undefined;
      case 'x': return Number(value.v);
      case 'n': return BigInt(value.v);
      case 'd': return new Date(value.v);
      case 'M':
        return new Map(value.v.map(function (pair) {
          return [cpDecode(pair[0]), cpDecode(pair[1])];
        }));
      case 'S':
        return new Set(value.v.map(function (item) {
          return cpDecode(item);
        }));
      case 'B': {
        /* A structured clone keeps the class of a view: host Node 24.15 answers Int32Array for an
           Int32Array and DataView for a DataView, and Uint8Array only for a Buffer, so the class
           the value had where it was posted is part of the clone after all. */
        var raw = Buffer.from(value.v, 'base64');
        var bytes = new Uint8Array(raw.length);
        bytes.set(raw);
        var cls = value.c;
        if (cls === 'DataView') return new DataView(bytes.buffer, 0, bytes.byteLength);
        if (CP_VIEWS.indexOf(cls) < 0) return bytes;
        var Ctor = globalThis[cls];
        if (typeof Ctor !== 'function') return bytes;
        return new Ctor(bytes.buffer, 0, raw.length / Ctor.BYTES_PER_ELEMENT);
      }
      case 'SB': {
        var shared = new SharedArrayBuffer(value.n);
        cpSlabMark(shared, value.id);
        var slabBytes = Buffer.from(callCap('shared.read', { id: value.id, off: 0, len: value.n }), 'base64');
        new Uint8Array(shared).set(slabBytes);
        return shared;
      }
      /* A transferred port arrives as the link it was sent on: the port built here is the other end
         of the one that was transferred, and what either posts on it reaches the other. */
      case 'P': {
        var linked = new (cpPortClass())();
        cpPortJoin(linked, Number(value.id));
        return linked;
      }
      case 'AB': {
        var decoded = Buffer.from(value.v, 'base64');
        var buffer = new ArrayBuffer(decoded.length);
        new Uint8Array(buffer).set(decoded);
        return buffer;
      }
      case 'o': {
        var inner = {};
        var innerKeys = Object.keys(value.v);
        for (var j = 0; j < innerKeys.length; j++) {
          inner[innerKeys[j]] = cpDecode(value.v[innerKeys[j]]);
        }
        return inner;
      }
      default: break;
    }
  }
  var plain = {};
  var plainKeys = Object.keys(value);
  for (var k = 0; k < plainKeys.length; k++) {
    plain[plainKeys[k]] = cpDecode(value[plainKeys[k]]);
  }
  return plain;
}

/* The value a transferList holds while it is being encoded, so a port inside it crosses as a link
   and one outside it is refused: cpEncode reads it, and it is put back when the encode ends. */
function cpEncodeWith(value, list) {
  var previous = cpState.transfer;
  cpState.transfer = Array.isArray(list) ? list : null;
  try {
    return cpEncode(value);
  } finally {
    cpState.transfer = previous;
  }
}

/* The bus: what a BroadcastChannel name and a transferred port's link are on the host, which is the
   only place two container processes meet -- they share no heap and no descriptor, and a worker is a
   process of its own here. An endpoint opens a key and every other endpoint open on it is reached by
   a post, in this process or in another. The frames one turn posted travel together in one delivery
   per process, and a process hands its own out in the order it made them, which is the order node
   hands them out in. */
var cpBus = { target: 0, sinks: Object.create(null), order: [], next: 1, flush: false };

/* Endpoint ids are made out of the pid so that two processes never make the same one: the host tells
   one post from another by this number alone. */
function cpBusNext() {
  return Number(proc.pid) * 1000000 + cpBus.next++;
}

function cpBusTarget() {
  if (cpBus.target === 0) cpBus.target = createTarget(cpOnBusFrame);
  return cpBus.target;
}

function cpBusOpen(key, id, sink) {
  cpBus.sinks[id] = sink;
  cpBus.order.push(id);
  callCap('shared.busOpen', { key: key, id: id, target: cpBusTarget() });
}

function cpBusClose(id) {
  if (cpBus.sinks[id] === undefined) return;
  delete cpBus.sinks[id];
  var at = cpBus.order.indexOf(id);
  if (at >= 0) cpBus.order.splice(at, 1);
  callCap('shared.busClose', { id: id });
}

function cpBusPost(key, id, frame) {
  callCap('shared.busPost', { key: key, from: id, frame: frame });
}

function cpBusFlush() {
  cpBus.flush = false;
  for (var i = 0; i < cpBus.order.length; i++) {
    var sink = cpBus.sinks[cpBus.order[i]];
    if (sink && typeof sink._flush === 'function') sink._flush();
  }
}

function cpOnBusFrame(name, payload) {
  if (name !== 'bus' || !payload || !Array.isArray(payload.items)) return;
  var items = payload.items;
  for (var i = 0; i < items.length; i++) {
    if (!Array.isArray(items[i])) continue;
    var sink = cpBus.sinks[items[i][0]];
    if (sink && typeof sink._receive === 'function') sink._receive(items[i][1]);
  }
  /* Everything this turn brought is queued now, so one flush hands it out: a channel's own messages
     in the order it was given them, and every channel before the one made after it. */
  if (!cpBus.flush) {
    cpBus.flush = true;
    queueMicrotask(cpBusFlush);
  }
}

/* The set of threads one BroadcastChannel name is open across: a worker shares its parent's, and a
   forked or clustered child has one of its own -- which is what node has, where a channel reaches the
   threads of one process and not the channels of another. */
function cpBusDomain() {
  if (cpState.bcDomain === null) cpState.bcDomain = String(proc.pid);
  return cpState.bcDomain;
}

/* MessagePort: messages are delivered asynchronously (setImmediate), and a port with 'message' listeners
   holds a ref until it is closed or unref'd, as Node does. A port with a _remote sender sends over IPC. */
function cpPortClass() {
  if (cpState.portClass) return cpState.portClass;
  var EE = cpEE();
  function MessagePort() {
    EE.call(this);
    this._q = [];
    this._started = false;
    this._closed = false;
    this._peer = null;
    this._remote = null;
    this._link = null;
    this._eid = 0;
    this._detached = false;
    this._refed = true;
    this._held = false;
    this._scheduled = false;
    var self = this;
    this.on('newListener', function (ev) {
      if (ev !== 'message') return;
      self._started = true;
      self._sync(true);
      self._schedule();
    });
    this.on('removeListener', function (ev) {
      if (ev === 'message') self._sync(false);
    });
  }
  MessagePort.prototype = Object.create(EE.prototype);
  MessagePort.prototype.constructor = MessagePort;
  MessagePort.prototype._sync = function (adding) {
    var live = !this._closed && this._started && this._refed;
    var want = live && (adding === true || this.listenerCount('message') > 0);
    if (want !== this._held) {
      this._held = want;
      holdRef(want ? 1 : -1);
    }
  };
  MessagePort.prototype._enqueue = function (value) {
    if (this._closed) return;
    this._q.push(value);
    this._schedule();
  };
  MessagePort.prototype._schedule = function () {
    if (this._scheduled || !this._started || this._closed || this._q.length === 0) return;
    this._scheduled = true;
    var self = this;
    setImmediate(function () {
      self._scheduled = false;
      while (self._started && !self._closed && self._q.length > 0) {
        self.emit('message', self._q.shift());
      }
    });
  };
  MessagePort.prototype.postMessage = function (value, transferList) {
    /* A detached port is the one that was transferred away: it has no end to reach any more, and on
       the host using it is silently nothing rather than an error. */
    if (this._closed || this._detached) return;
    var encoded = cpEncodeWith(value, transferList);
    /* A link is ahead of the peer: a transferred port's messages travel over the host, which is the
       only place this process and the one holding the other end meet. */
    if (this._link !== null) {
      cpBusPost('port:' + this._link, this._eid, encoded);
      return;
    }
    if (this._remote) {
      this._remote(encoded);
      return;
    }
    var peer = this._peer;
    if (peer && !peer._closed) peer._enqueue(cpDecode(encoded));
  };
  /* A frame the host handed this end of a link: queued, and handed out when the port is started, as
     a message from the port's own peer is. */
  MessagePort.prototype._receive = function (frame) {
    this._enqueue(cpDecode(frame));
  };
  MessagePort.prototype.start = function () {
    if (this._closed) return;
    this._started = true;
    this._sync(false);
    this._schedule();
  };
  MessagePort.prototype.close = function () {
    if (this._closed) return;
    this._closed = true;
    this._q = [];
    this._sync(false);
    var self = this;
    var peer = this._peer;
    setImmediate(function () {
      self.emit('close');
      if (peer && !peer._closed) peer.close();
    });
  };
  MessagePort.prototype.ref = function () {
    this._refed = true;
    this._sync(false);
    return this;
  };
  MessagePort.prototype.unref = function () {
    this._refed = false;
    this._sync(false);
    return this;
  };
  MessagePort.prototype.hasRef = function () {
    return this._held;
  };
  cpState.portClass = MessagePort;
  return MessagePort;
}

function cpMakeChannel() {
  var Port = cpPortClass();
  var a = new Port();
  var b = new Port();
  a._peer = b;
  b._peer = a;
  return { port1: a, port2: b };
}

/* A transferred port crosses as a link: an id on the host's bus that both the end it reaches and the
   end that stayed behind are open on, so what either posts arrives at the other. The port that
   crosses is detached -- it has no end of its own any more, which is what node leaves behind -- and
   the peer it had here, if it had one, moves onto the link in its place. */
function cpPortTransfer(port) {
  var id = port._link;
  if (id === null) {
    id = Number(callCap('shared.busLink', {}).id);
    var peer = port._peer;
    if (peer && !peer._closed) {
      peer._peer = null;
      peer._link = id;
      peer._eid = cpBusNext();
      cpBusOpen('port:' + id, peer._eid, peer);
    }
  }
  cpPortDetach(port);
  return { $t: 'P', id: id };
}

function cpPortDetach(port) {
  if (port._eid !== 0) cpBusClose(port._eid);
  port._eid = 0;
  port._link = null;
  port._peer = null;
  port._remote = null;
  port._q = [];
  port._detached = true;
  port._sync(false);
}

/* The end a transferred port is where it arrives: open on the link it came over. */
function cpPortJoin(port, id) {
  port._link = id;
  port._eid = cpBusNext();
  cpBusOpen('port:' + id, port._eid, port);
}

/* BroadcastChannel: a message posted on a name reaches every other channel open on that name and not
   the one that posted it, in this process or in a worker of it -- which is what node delivers across
   the threads of one process, and a worker is a process of its own here. Node's channel is an
   EventTarget and not an emitter: 'message' reaches onmessage and addEventListener as a MessageEvent,
   and an open channel holds a ref until it is closed or unref'd, which is why a host waits for one. */
function cpBroadcastClass() {
  if (cpState.broadcastClass) return cpState.broadcastClass;
  function cpBusKey(name) {
    return 'bc:' + cpBusDomain() + ':' + name;
  }
  function cpBusRef(state) {
    var want = !state.closed && state.refed;
    if (want === state.held) return;
    state.held = want;
    holdRef(want ? 1 : -1);
  }
  function BroadcastChannel(name) {
    if (!(this instanceof BroadcastChannel)) throw new TypeError("Constructor BroadcastChannel requires 'new'");
    var self = this;
    var eid = cpBusNext();
    var state = {
      name: String(name),
      closed: false,
      refed: true,
      held: false,
      queue: [],
      target: typeof EventTarget === 'function' ? new EventTarget() : null,
      onmessage: null,
      onmessageerror: null
    };
    Object.defineProperty(this, '_bcState', { value: state, enumerable: false });
    Object.defineProperty(this, '_bcId', { value: eid, enumerable: false });
    state._receive = function (frame) {
      if (state.closed) return;
      state.queue.push(frame);
    };
    state._flush = function () {
      while (state.queue.length > 0) {
        var data = cpDecode(state.queue.shift());
        if (state.closed) return;
        var event = null;
        if (typeof MessageEvent === 'function') {
          try {
            event = new MessageEvent('message', { data: data });
          } catch (ignored) {
            event = null;
          }
        }
        if (event === null) event = { type: 'message', data: data };
        if (typeof state.onmessage === 'function') state.onmessage.call(self, event);
        if (state.target !== null) state.target.dispatchEvent(event);
      }
    };
    cpBusOpen(cpBusKey(state.name), eid, state);
    cpBusRef(state);
  }
  BroadcastChannel.prototype.constructor = BroadcastChannel;
  Object.defineProperty(BroadcastChannel.prototype, 'name', {
    get: function () { return this._bcState.name; },
    enumerable: true, configurable: true
  });
  Object.defineProperty(BroadcastChannel.prototype, 'onmessage', {
    get: function () { return this._bcState.onmessage; },
    set: function (fn) { this._bcState.onmessage = typeof fn === 'function' ? fn : null; },
    enumerable: true, configurable: true
  });
  Object.defineProperty(BroadcastChannel.prototype, 'onmessageerror', {
    get: function () { return this._bcState.onmessageerror; },
    set: function (fn) { this._bcState.onmessageerror = typeof fn === 'function' ? fn : null; },
    enumerable: true, configurable: true
  });
  BroadcastChannel.prototype.postMessage = function (value) {
    var state = this._bcState;
    if (state.closed) throw new DOMException('This BroadcastChannel is already closed', 'InvalidStateError');
    cpBusPost(cpBusKey(state.name), this._bcId, cpEncode(value));
  };
  BroadcastChannel.prototype.close = function () {
    var state = this._bcState;
    if (state.closed) return;
    state.closed = true;
    state.queue = [];
    cpBusClose(this._bcId);
    cpBusRef(state);
  };
  BroadcastChannel.prototype.ref = function () {
    this._bcState.refed = true;
    cpBusRef(this._bcState);
    return this;
  };
  BroadcastChannel.prototype.unref = function () {
    this._bcState.refed = false;
    cpBusRef(this._bcState);
    return this;
  };
  /* Node reads these off EventTarget's prototype; this channel is not one, so they sit here. */
  BroadcastChannel.prototype.addEventListener = function () {
    var target = this._bcState.target;
    return target === null ? undefined : target.addEventListener.apply(target, arguments);
  };
  BroadcastChannel.prototype.removeEventListener = function () {
    var target = this._bcState.target;
    return target === null ? undefined : target.removeEventListener.apply(target, arguments);
  };
  BroadcastChannel.prototype.dispatchEvent = function () {
    var target = this._bcState.target;
    return target === null ? false : target.dispatchEvent.apply(target, arguments);
  };
  cpState.broadcastClass = BroadcastChannel;
  return BroadcastChannel;
}

function cpMode(value) {
  if (value === 'inherit' || value === 'ignore' || value === 'pipe') return value;
  if (value === 0 || value === 1 || value === 2 || (value !== null && typeof value === 'object')) return 'inherit';
  return 'pipe';
}

function cpStdio(stdio) {
  var list = typeof stdio === 'string' ? [stdio, stdio, stdio] : (Array.isArray(stdio) ? stdio : []);
  var ipc = false;
  for (var i = 0; i < list.length; i++) {
    if (list[i] === 'ipc') ipc = true;
  }
  return { modes: [cpMode(list[0]), cpMode(list[1]), cpMode(list[2])], ipc: ipc };
}

/* A host's spawn gives the child the environment it was handed and nothing of its own, and then
   fills in a PATH and a TERM the environment did not name: spawnSync of sh -c 'echo [$PATH]' with
   env { MYVAR: 'v' } reads /usr/gnu/bin:/usr/local/bin:/bin:/usr/bin:. on a host, not an empty
   string, and reads dumb for $TERM. */
var CP_DEFAULT_PATH = '/usr/gnu/bin:/usr/local/bin:/bin:/usr/bin:.';
var CP_DEFAULT_TERM = 'dumb';

function cpEnvObject(env) {
  var out = {};
  Object.keys(env).forEach(function (key) {
    if (env[key] !== undefined) out[key] = String(env[key]);
  });
  if (out.PATH === undefined) out.PATH = CP_DEFAULT_PATH;
  if (out.TERM === undefined) out.TERM = CP_DEFAULT_TERM;
  return out;
}

function cpCallbackFrom(args) {
  for (var i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') return args[i];
  }
  return null;
}

/* exec-style argument parsing: (args?, options?, callback?) after the file or command */
function cpParseCall(rest) {
  var list = Array.prototype.slice.call(rest);
  var callback = null;
  if (list.length > 0 && typeof list[list.length - 1] === 'function') callback = list.pop();
  var args = [];
  var opts = {};
  if (list.length > 0 && Array.isArray(list[0])) {
    args = list[0];
    if (list[1] && typeof list[1] === 'object') opts = list[1];
  } else if (list.length > 0 && list[0] && typeof list[0] === 'object') {
    opts = list[0];
  }
  return { args: args, opts: opts, cb: callback };
}

/* the guest's own IPC ref (process channel), held while a 'message' or 'disconnect' listener exists */
function cpSetRef(on) {
  if (on === cpState.held) return;
  cpState.held = on;
  holdRef(on ? 1 : -1);
}

function cpRefChild(child, on) {
  if (on) {
    if (!child._cpRef && !child._cpExited) {
      child._cpRef = true;
      holdRef(1);
    }
  } else if (child._cpRef) {
    child._cpRef = false;
    holdRef(-1);
  }
}

/* runs an action now if the child has started on the host, otherwise after its spawn settles */
function cpPost(child, action) {
  if (child._cpSpawned) action();
  else child._cpPending.push(action);
}

function cpClusterEmit(child, event, extra) {
  if (!child._cpCluster) return;
  var args = [event, child].concat(extra || []);
  child._cpCluster.emit.apply(child._cpCluster, args);
}

function cpEmitDisconnect(child) {
  child.emit('disconnect');
  cpClusterEmit(child, 'disconnect', []);
}

/* node's own diagnostics channels: the publish path lives in the diagnostics_channel family,
   whose snippet is an IIFE of its own, so it reaches this one through a global name. */
function dcPublish(name, data) {
  var publish = globalThis.__owcDcPublish;
  if (publish !== undefined) publish(name, data);
}

function cpSpawnCore(child, file, argv, options, extra) {
  var opts = options || {};
  var exe = String(file);
  var list = (argv || []).map(function (item) {
    return String(item);
  });
  var spawnfile = exe;
  if (opts.shell) {
    spawnfile = '/bin/sh';
    list = ['-c', [exe].concat(list).join(' ')];
    exe = 'sh';
  }
  var stdio = cpStdio(opts.stdio);
  var ipc = stdio.ipc || extra.ipc === true;
  var cwd = opts.cwd === undefined || opts.cwd === null ? undefined : String(opts.cwd);
  if (cwd !== undefined && cwd.charAt(0) !== '/') cwd = proc.cwd().replace(/\/$/, '') + '/' + cwd;
  cpState.tokenCount += 1;
  var token = proc.pid + ':' + cpState.tokenCount;
  child.spawnfile = spawnfile;
  child.spawnargs = [spawnfile].concat(list);
  child.connected = ipc;
  /* The channel a host's child carries on an IPC stdio and nothing otherwise: an object a program
     can test and hang ref/unref or listeners on. A worker thread is not a channel child, so it
     has none -- and a child with no IPC stdio leaves the property undefined, as a host does. */
  child.channel = ipc && extra.kind !== 'worker' ? new (cpEE())() : undefined;
  child._cpWorker = extra.kind === 'worker';
  child._cpCluster = extra.cluster || null;
  child._cpSpawned = false;
  child._cpExited = false;
  child._cpRef = false;
  child._cpTimer = null;
  child._cpPending = [];
  child._cpQueue = [];
  /* Node gives a child its pid the moment spawn returns; the container's own spawn settles on a later
     turn, so the pid is taken from the host now and the child is registered under it when it starts. */
  var reserved = callCap('child.reservePid', {});
  child.pid = Number(reserved.pid);
  /* A host's spawn is one process handle and one pipe for every stdio it was asked to pipe, and node
     reports both before spawn returns: PROCESSWRAP for the child itself, then a PIPEWRAP per pipe.
     The pipes are numbered the way the descriptors are, so they are opened below, once the streams
     exist. Both are null while no hook is enabled, which is what leaves an ordinary spawn as it was. */
  child._cpAsyncProcess = asyncOpenResource('PROCESSWRAP', child);
  child._cpAsyncPipes = [null, null, null];
  var stream = requireBuiltin('stream');
  /* A Worker reads its two streams off the prototype, so the stream is kept under a name of its own
     as well as on the child: an own property cannot shadow an accessor that has no setter. */
  if (stdio.modes[1] === 'pipe') {
    var outPipe = new stream.Readable({ read: function () {} });
    child._cpStdout = outPipe;
    child.stdout = outPipe;
  }
  if (stdio.modes[2] === 'pipe') {
    var errPipe = new stream.Readable({ read: function () {} });
    child._cpStderr = errPipe;
    child.stderr = errPipe;
  }
  if (stdio.modes[0] === 'pipe') {
    child.stdin = new stream.Writable({
      write: function (chunk, encoding, done) {
        var text = String(chunk);
        cpPost(child, function () {
          callCap('child.stdin', { pid: child.pid, data: text });
        });
        done();
      },
      /* The parent's end of file is the child's: a reader there sees end of input, as in Node. */
      final: function (done) {
        cpPost(child, function () {
          callCap('child.stdinEnd', { pid: child.pid });
        });
        done();
      }
    });
  }
  child.stdio = [child.stdin, child.stdout, child.stderr];
  /* The three pipes, in the order a host numbers them: fd 0, then 1, then 2. The two the child writes
     are closed by the streams themselves, when a reader has read them to their end; the one the
     parent writes dies with the child, as a host's does, which is cpAsyncGone below. */
  var piped = child.stdio;
  for (var pfd = 0; pfd < 3; pfd++) {
    if (!piped[pfd]) continue;
    cpOpenPipe(child, pfd, piped[pfd]);
  }
  child._cpTarget = createTarget(function (name, payload) {
    cpOnEvent(child, payload);
  });
  if (Number(opts.timeout) > 0) {
    child._cpTimer = setTimeout(function () {
      cpKill(child, opts.killSignal);
    }, Number(opts.timeout));
  }
  cpRefChild(child, true);
  if (ipc || extra.kind === 'worker') cpHookParentExit();
  /* The child_process channel: one publish per child spawned -- a worker thread is not one, and
     node names the object it hands over process, not child. */
  if (extra.kind === 'child') dcPublish('child_process', { process: child });
  callOp('child.spawn', {
    pid: child.pid,
    file: exe,
    args: list,
    cwd: cwd,
    env: opts.env && typeof opts.env === 'object' ? cpEnvObject(opts.env) : null,
    stdio: stdio.modes,
    ipc: ipc,
    ipcKind: extra.ipcKind || null,
    ipcData: extra.ipcData || {},
    token: token,
    kind: extra.kind,
    target: child._cpTarget,
    /* The host arms the deadline a guest timer cannot keep: a child that never calls the host holds
       the host thread, and a timer armed for this timeout would not fire until the child had gone. */
    timeout: Number(opts.timeout) > 0 ? Number(opts.timeout) : 0,
    killSignal: cpKillName(opts.killSignal)
  }).then(function (result) {
    cpSpawnedOk(child, result.pid);
  }, function (error) {
    cpSpawnFailed(child, error);
  });
  return child;
}

function cpSpawnedOk(child, pid) {
  child.pid = pid;
  child._cpSpawned = true;
  if (child._cpWorker) child.emit('online');
  else child.emit('spawn');
  if (child._cpCluster) cpClusterEmit(child, 'online', []);
  var actions = child._cpPending.splice(0);
  for (var i = 0; i < actions.length; i++) actions[i]();
  var events = child._cpQueue.splice(0);
  for (var j = 0; j < events.length; j++) cpOnEvent(child, events[j]);
}

function cpSpawnFailed(child, error) {
  child._cpExited = true;
  child.connected = false;
  // a child that never started has no pid, as in Node
  child.pid = undefined;
  if (child._cpTimer) clearTimeout(child._cpTimer);
  cpRefChild(child, false);
  var errno = error && typeof error.errno === 'number' ? error.errno : -2;
  child.emit('error', error);
  proc.nextTick(function () {
    child.emit('close', errno, null);
    cpAsyncGone(child);
  });
}

function cpOnEvent(child, ev) {
  if (!child._cpSpawned) {
    child._cpQueue.push(ev);
    return;
  }
  if (ev.k === 'out') {
    var stream = ev.fd === 2 ? child.stderr : child.stdout;
    if (stream) stream.push(Buffer.from(ev.s, 'utf8'));
    /* A worker's console output is read off w.stdout and w.stderr, and it also reaches the parent's
       own output unless the option that stops that was given -- which is what makes one
       console.log in a worker print on both, as it does on host node 24.15. */
    if (child._cpWorker) {
      var forward = ev.fd === 2 ? child._cpForwardErr : child._cpForwardOut;
      if (forward === undefined || forward === true) {
        if (ev.fd === 2) host.stderr(ev.s);
        else host.stdout(ev.s);
      }
    }
  } else if (ev.k === 'exit') {
    cpExit(child, ev.code, ev.signal, ev.timedOut === true);
  } else if (ev.k === 'error') {
    child.emit('error', cpErrorFrom(ev.e));
  } else if (ev.k === 'ipc') {
    cpIpc(child, ev.f);
  } else if (ev.k === 'ipcdown') {
    if (child.connected) {
      child.connected = false;
      cpEmitDisconnect(child);
    }
  }
}

/* One PIPEWRAP for one pipe of a spawned child: node reports it when the pipe is made and destroys
   it when the pipe closes. The write end (fd 0) is not one a stream closes on its own -- it goes when
   the child goes -- so only the two read ends are tied to their stream's 'close'. */
function cpOpenPipe(child, fd, pipe) {
  var close = asyncOpenResource('PIPEWRAP', pipe);
  if (close === null) return;
  child._cpAsyncPipes[fd] = function cpClosedPipe() {
    if (child._cpAsyncPipes[fd] === null) return;
    child._cpAsyncPipes[fd] = null;
    close();
  };
  if (fd !== 0) pipe.once('close', child._cpAsyncPipes[fd]);
}

/* The child's own handle and the pipe the parent wrote to it: both are gone once the child's 'close'
   has been emitted, the handle first, as a host reports them. */
function cpAsyncGone(child) {
  if (child._cpAsyncProcess) {
    child._cpAsyncProcess();
    child._cpAsyncProcess = null;
  }
  if (!child._cpAsyncPipes) return;
  /* What nothing read to its end goes with the child: the two read ends when no reader ever closed
     them, and the write end last, which is the order a host destroys them in. */
  for (var fd = 1; fd < 3; fd++) {
    if (child._cpAsyncPipes[fd]) child._cpAsyncPipes[fd]();
  }
  if (child._cpAsyncPipes[0]) child._cpAsyncPipes[0]();
}

/* A host shuts the read end of each pipe it made for a child as that child goes, and node reports
   every one of them: a SHUTDOWNWRAP, triggered by the pipe it shut, with a before and an after
   around the shutdown and a destroy once it has settled. */
function cpShutPipe(pipe) {
  asyncWrapResource('SHUTDOWNWRAP', function () { pipe.push(null); }, true)();
}

function cpExit(child, code, signal, timedOut) {
  if (child._cpExited) return;
  child._cpExited = true;
  if (child._cpTimer) clearTimeout(child._cpTimer);
  /* The spawn's own timeout ended this child on the host: the kill a caller reads on "killed"
     happened, even though the timer above never got a turn to make it. */
  if (timedOut) child.killed = true;
  /* A terminated worker ends with status 1: the thread did not choose to exit, it was stopped. A
     worker that ends on its own keeps the status it chose, and one with no status keeps 0. */
  var exitCode = child._cpWorker
    ? (child._cpTerminated ? 1 : (code === null ? 0 : code))
    : code;
  child.exitCode = exitCode;
  child.signalCode = signal;
  cpRefChild(child, false);
  if (child.connected) {
    child.connected = false;
    cpEmitDisconnect(child);
  }
  cpCloseWhenDone(child, exitCode, signal);
}

function cpEmitExit(child, code, signal) {
  child.emit('exit', code, signal);
  cpClusterEmit(child, 'exit', [code, signal]);
}

/* 'exit' and 'close' follow the child's end once every piped stream that is being read has ended
   and closed; unread streams do not hold them. A host reads a child's pipe and reaches its end
   before it reaps the child, so by the time the host reports the child's exit and close, a
   destination the child's stdout was piped into has ended, finished, been unpiped and closed. The
   container hands a piped stream its output in one turn, which left 'close' ahead of a destination
   that had not ended yet; waiting for the read side's own close and then for one turn of the loop
   puts the destination's close first, as it comes first on a host. */
function cpCloseWhenDone(child, code, signal) {
  var waiting = [];
  /* stderr before stdout, which is the order a host shuts them in. */
  var streams = [child.stderr, child.stdout];
  for (var i = 0; i < streams.length; i++) {
    var stream = streams[i];
    if (!stream) continue;
    cpShutPipe(stream);
    if (stream.listenerCount('data') > 0 || stream.readableFlowing === true) waiting.push(stream);
  }
  if (waiting.length === 0) {
    cpEmitExit(child, code, signal);
    proc.nextTick(function () {
      child.emit('close', code, signal);
      cpAsyncGone(child);
    });
    return;
  }
  var left = waiting.length;
  waiting.forEach(function (stream) {
    stream.once('close', function () {
      left -= 1;
      if (left > 0) return;
      setImmediate(function () {
        cpEmitExit(child, code, signal);
        child.emit('close', code, signal);
        cpAsyncGone(child);
      });
    });
  });
}

function cpIpc(child, frame) {
  if (frame.t === 'm') {
    var message = cpDecode(frame.v);
    child.emit('message', message, undefined);
    cpClusterEmit(child, 'message', [message]);
  } else if (frame.t === 'e') {
    child.emit('error', cpErrorFrom(frame.v));
  }
}

function cpKillName(signal) {
  if (typeof signal === 'number') return cpSignalNames[signal] || 'SIGTERM';
  return String(signal === undefined || signal === null ? 'SIGTERM' : signal);
}

function cpKill(child, signal) {
  if (!child._cpSpawned || child._cpExited) return false;
  if (signal === 0 || signal === '0') return true;
  var name = typeof signal === 'number'
    ? (cpSignalNames[signal] || 'SIGTERM')
    : String(signal === undefined || signal === null ? 'SIGTERM' : signal);
  var ok = callCap('child.kill', { pid: child.pid, signal: name });
  if (ok) child.killed = true;
  return ok === true;
}

function cpSendToChild(child, message, callback, transferList) {
  if (!child.connected) {
    var closed = cpError('Channel closed', 'ERR_IPC_CHANNEL_CLOSED');
    if (typeof callback === 'function') proc.nextTick(callback, closed);
    else proc.nextTick(function () {
      child.emit('error', closed);
    });
    return false;
  }
  var frame = { t: 'm', v: cpEncodeWith(message, transferList) };
  cpPost(child, function () {
    callCap('child.sendToChild', { pid: child.pid, frame: frame });
  });
  if (typeof callback === 'function') proc.nextTick(callback, null);
  return true;
}

function cpDisconnectChild(child) {
  if (!child.connected) return;
  child.connected = false;
  cpPost(child, function () {
    callCap('child.disconnectChild', { pid: child.pid });
  });
  proc.nextTick(function () {
    cpEmitDisconnect(child);
  });
}

function cpChannelSend(message, callback) {
  if (!cpState.connected) {
    var closed = cpError('Channel closed', 'ERR_IPC_CHANNEL_CLOSED');
    if (typeof callback === 'function') proc.nextTick(callback, closed);
    else proc.nextTick(function () {
      proc.emit('error', closed);
    });
    return false;
  }
  callCap('child.sendToParent', { frame: { t: 'm', v: cpEncode(message) } });
  if (typeof callback === 'function') proc.nextTick(callback, null);
  return true;
}

function cpChildClass() {
  if (cpState.childClass) return cpState.childClass;
  var EE = cpEE();
  function ChildProcess() {
    EE.call(this);
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.connected = false;
    this.spawnfile = undefined;
    this.spawnargs = [];
    this.stdin = null;
    this.stdout = null;
    this.stderr = null;
    this.stdio = [null, null, null];
  }
  ChildProcess.prototype = Object.create(EE.prototype);
  ChildProcess.prototype.constructor = ChildProcess;
  ChildProcess.prototype.kill = function (signal) {
    return cpKill(this, signal);
  };
  ChildProcess.prototype.send = function (message) {
    return cpSendToChild(this, message, cpCallbackFrom(arguments));
  };
  ChildProcess.prototype.disconnect = function () {
    cpDisconnectChild(this);
  };
  ChildProcess.prototype.ref = function () {
    cpRefChild(this, true);
    return this;
  };
  ChildProcess.prototype.unref = function () {
    cpRefChild(this, false);
    return this;
  };
  cpState.childClass = ChildProcess;
  return ChildProcess;
}

/* The instance surface host node 24.15 gives a Worker: the four numbers of its resource limits, a
   performance object of its own, the cpu and heap calls, and the two streams its console output can
   be read off. The worker's stdout and stderr are piped to the parent here, so they exist to be
   read; what is read off them is carried to the parent's own output too unless the option that stops
   that was given, which is the same two places a worker's console.log reaches on a host. */
var CP_WORKER_LIMIT_NAMES = ['maxYoungGenerationSizeMb', 'maxOldGenerationSizeMb', 'codeRangeSizeMb', 'stackSizeMb'];
var CP_WORKER_LIMITS = { maxYoungGenerationSizeMb: -1, maxOldGenerationSizeMb: -1, codeRangeSizeMb: -1, stackSizeMb: 4 };

function cpWorkerLimits(options) {
  var limits = {};
  for (var i = 0; i < CP_WORKER_LIMIT_NAMES.length; i++) {
    var name = CP_WORKER_LIMIT_NAMES[i];
    limits[name] = CP_WORKER_LIMITS[name];
  }
  if (options && typeof options === 'object') {
    for (var j = 0; j < CP_WORKER_LIMIT_NAMES.length; j++) {
      var key = CP_WORKER_LIMIT_NAMES[j];
      if (typeof options[key] === 'number') limits[key] = options[key];
    }
  }
  return limits;
}

function cpWorkerClass() {
  var Child = cpChildClass();
  function Worker(filename, options) {
    Child.call(this);
    var opts = options || {};
    cpState.threadCount += 1;
    var threadId = cpState.threadCount;
    this._cpThreadId = threadId;
    this._cpThreadName = 'WorkerThread';
    this._cpLimits = cpWorkerLimits(opts.resourceLimits);
    /* stdout: true and stderr: true are the two that stop the worker's output reaching the parent's
       own, and only those: every other shape leaves it reaching both, as on the host. */
    this._cpForwardOut = opts.stdout !== true;
    this._cpForwardErr = opts.stderr !== true;
    /* An object of the worker's own and not the process-wide performance: host node 24.15 reads
       'performance' off the instance and not off the prototype, and its own keys are one name. */
    this.performance = {
      eventLoopUtilization: function () {
        return { idle: 0, active: 0, utilization: 0 };
      }
    };
    var argv = opts.eval === true ? ['-e', String(filename)] : [String(filename)];
    cpSpawnCore(this, 'node', argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe']
    }, {
      kind: 'worker',
      ipc: true,
      ipcKind: 'worker',
      ipcData: {
        threadId: threadId,
        workerData: cpEncodeWith(opts.workerData === undefined ? null : opts.workerData, opts.transferList),
        envData: cpEnvDataSnapshot(),
        /* The set of threads a BroadcastChannel name reaches: a worker shares its parent's. */
        bcDomain: cpBusDomain()
      }
    });
  }
  Worker.prototype = Object.create(Child.prototype);
  Worker.prototype.constructor = Worker;
  Worker.prototype.postMessage = function (value, transferList) {
    cpSendToChild(this, value, null, transferList);
  };
  Worker.prototype.terminate = function () {
    var self = this;
    /* Node ends a terminated worker with status 1: the thread did not choose to exit, it was stopped.
       A worker that ends on its own keeps the status it chose. */
    self._cpTerminated = true;
    return new Promise(function (resolve) {
      if (self._cpExited) {
        resolve(self.exitCode === null ? 0 : self.exitCode);
        return;
      }
      self.once('exit', function (code) {
        resolve(code);
      });
      cpPost(self, function () {
        cpKill(self, 'SIGTERM');
      });
    });
  };
  Worker.prototype.ref = function () {
    Child.prototype.ref.call(this);
    return this;
  };
  Worker.prototype.unref = function () {
    Child.prototype.unref.call(this);
    return this;
  };
  /* Node reads these off the prototype, so the names a program finds on it are these and not the
     child-process ones a Worker used to answer with. */
  Object.defineProperty(Worker.prototype, 'threadId', {
    get: function () { return this._cpThreadId; },
    enumerable: true, configurable: true
  });
  Object.defineProperty(Worker.prototype, 'threadName', {
    get: function () { return this._cpThreadName; },
    set: function (name) { this._cpThreadName = String(name); },
    enumerable: true, configurable: true
  });
  Object.defineProperty(Worker.prototype, 'stdin', {
    get: function () { return null; },
    enumerable: true, configurable: true
  });
  Object.defineProperty(Worker.prototype, 'stdout', {
    get: function () { return this._cpStdout === undefined ? null : this._cpStdout; },
    enumerable: true, configurable: true
  });
  Object.defineProperty(Worker.prototype, 'stderr', {
    get: function () { return this._cpStderr === undefined ? null : this._cpStderr; },
    enumerable: true, configurable: true
  });
  Object.defineProperty(Worker.prototype, 'resourceLimits', {
    get: function () { return this._cpLimits; },
    enumerable: true, configurable: true
  });
  Worker.prototype.getHeapSnapshot = function () {
    /* The host this answers to has no heap of its own to dump: it hands back a promise of nothing,
       which is what host node 24.15 answers for a worker's heap calls. */
    return Promise.resolve({});
  };
  Worker.prototype.getHeapStatistics = function () {
    return {};
  };
  Worker.prototype.cpuUsage = function () {
    return {};
  };
  Worker.prototype.startCpuProfile = function () {
    return Promise.resolve({});
  };
  Worker.prototype.startHeapProfile = function () {
    return Promise.resolve({});
  };
  return Worker;
}

function cpSpawnApi(file, args, options) {
  var list = [];
  var opts = {};
  if (Array.isArray(args)) {
    list = args;
    if (options && typeof options === 'object') opts = options;
  } else if (args && typeof args === 'object') {
    opts = args;
  }
  return cpSpawnCore(new (cpChildClass())(), file, list, opts, { kind: 'child' });
}

/* collects stdout and stderr, then calls back once: on spawn failure, or on close after exit */
function cpCollect(child, opts, cmdText, callback) {
  var encoding = opts.encoding === undefined ? 'utf8' : opts.encoding;
  var outs = [];
  var errs = [];
  var done = false;
  /* maxBuffer: the most either stream may hold. A host's default is a megabyte, and a run that
     writes more ends on a RangeError named ERR_CHILD_PROCESS_STDIO_MAXBUFFER with that stream cut
     back to the limit, which is what exec and execFile report. */
  var maxBuffer = opts.maxBuffer === undefined || opts.maxBuffer === null ? 1024 * 1024 : Number(opts.maxBuffer);
  var over = null;
  function take(arr, chunk, name) {
    arr.push(chunk);
    if (over !== null || !(maxBuffer > 0)) return;
    var total = 0;
    for (var i = 0; i < arr.length; i++) total += arr[i].length;
    if (total > maxBuffer) over = name;
  }
  function cut(arr) {
    var kept = [];
    var left = maxBuffer;
    for (var i = 0; i < arr.length && left > 0; i++) {
      kept.push(arr[i].length > left ? arr[i].slice(0, left) : arr[i]);
      left -= arr[i].length;
    }
    return kept;
  }
  if (child.stdout) child.stdout.on('data', function (chunk) {
    take(outs, chunk, 'stdout');
    if (over !== null) overflown();
  });
  if (child.stderr) child.stderr.on('data', function (chunk) {
    take(errs, chunk, 'stderr');
    if (over !== null) overflown();
  });
  function overflown() {
    if (done) return;
    if (over === 'stdout') outs = cut(outs);
    else errs = cut(errs);
    /* A host ends the child that overran the buffer, then reports the limit. */
    cpKill(child, undefined);
    var error = cpError(over + ' maxBuffer length exceeded');
    error.name = 'RangeError';
    error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    error.cmd = cmdText;
    finish(error);
  }
  function finish(error) {
    if (done) return;
    done = true;
    if (typeof callback !== 'function') return;
    var out = Buffer.concat(outs);
    var err = Buffer.concat(errs);
    var asBuffer = encoding === 'buffer' || encoding === null;
    callback(error, asBuffer ? out : out.toString(encoding), asBuffer ? err : err.toString(encoding));
  }
  child.on('error', function (error) {
    finish(error);
  });
  child.on('close', function (code, signal) {
    if (code === 0 && !signal) {
      finish(null);
      return;
    }
    var error = cpError('Command failed: ' + cmdText + '\n' + Buffer.concat(errs).toString('utf8'));
    error.code = code;
    error.killed = child.killed;
    error.signal = signal;
    error.cmd = cmdText;
    finish(error);
  });
}

function cpExec(command, rest) {
  var call = cpParseCall(rest);
  var cmd = String(command);
  /* /bin/sh, the path a host's node runs an exec through: $0 inside the command reads that path, as
     it does on a host. execSync was given the same path; the asynchronous exec had been left on the
     bare name, which is what made exec('echo $0') print sh where a host prints /bin/sh.

     A shell option names the shell instead, and the line is handed to it once. It used to be handed
     twice: this call spawned '/bin/sh -c <line>' and the option then wrapped that whole command in
     the shell again, so sh -c '/bin/sh -c <line>' ran -- and since the inner path was not one the
     shell recognised, every exec with a shell option printed nothing and 'exit 4' came back 0. */
  var shell = typeof call.opts.shell === 'string' && call.opts.shell !== '' ? call.opts.shell : '/bin/sh';
  var opts = call.opts;
  if (opts.shell !== undefined) {
    opts = {};
    Object.keys(call.opts).forEach(function (key) { opts[key] = call.opts[key]; });
    delete opts.shell;
  }
  var child = cpSpawnCore(new (cpChildClass())(), shell, ['-c', cmd], opts, { kind: 'child' });
  cpCollect(child, opts, cmd, call.cb);
  return child;
}

function cpExecFile(file, rest) {
  var call = cpParseCall(rest);
  var list = call.args.map(function (item) {
    return String(item);
  });
  var child = cpSpawnCore(new (cpChildClass())(), String(file), list, call.opts, { kind: 'child' });
  cpCollect(child, call.opts, [String(file)].concat(list).join(' '), call.cb);
  return child;
}

function cpForkApi(modulePath, args, options) {
  var list = [];
  var opts = {};
  if (Array.isArray(args)) {
    list = args;
    if (options && typeof options === 'object') opts = options;
  } else if (args && typeof args === 'object') {
    opts = args;
  }
  var silent = opts.silent === true;
  var stdio = opts.stdio !== undefined
    ? opts.stdio
    : (silent ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit']);
  return cpSpawnCore(new (cpChildClass())(), 'node', [String(modulePath)].concat(list.map(function (item) {
    return String(item);
  })), {
    cwd: opts.cwd,
    env: opts.env,
    stdio: stdio,
    timeout: opts.timeout,
    killSignal: opts.killSignal
  }, { kind: 'fork', ipc: true, ipcKind: 'fork', ipcData: {} });
}

/* synchronous family: the host runs the child to completion inside one call (child.spawnSync) */
function cpSyncCall(file, args, options) {
  var list = [];
  var opts = {};
  if (Array.isArray(args)) {
    list = args;
    if (options && typeof options === 'object') opts = options;
  } else if (args && typeof args === 'object') {
    opts = args;
  }
  return {
    file: String(file),
    list: list.map(function (item) {
      return String(item);
    }),
    opts: opts
  };
}

function cpSyncKillName(signal) {
  if (typeof signal === 'number') return cpSignalNames[signal] || 'SIGTERM';
  return String(signal === undefined || signal === null ? 'SIGTERM' : signal);
}

/* A synchronous pipe is byte-transparent: it carries what the child wrote, byte for byte. The shell
   holds text, so text every character of which is a byte -- what printf writes for a \377 escape,
   61 ff 62 -- is handed back as those bytes, where UTF-8 made four bytes of it (61 c3 bf 62). A
   character no byte holds has no byte form, so such text keeps the UTF-8 it always had. */
function cpBytesOf(text) {
  var binary = true;
  for (var i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 255) {
      binary = false;
      break;
    }
  }
  return Buffer.from(text, binary ? 'latin1' : 'utf8');
}

/* The mark a host cuts an overlong output back to. A host reads a child's pipe a read unit at a
   time and ends the child on the read that crosses the limit, so it hands back that whole read:
   4096 of limit and 65536 of output where the child wrote 65536 in one write, 1048576 and 1114112
   where it wrote two mebibytes. The container reads a synchronous child's output as one piece after
   the child has gone, so the unit is the 64 KiB one a host's pipe is read in. */
function cpMaxBufferMark(maxBuffer) {
  var unit = 65536;
  return Math.ceil((maxBuffer + 1) / unit) * unit;
}

/* The error a host reports for a child that overran maxBuffer: no status, the signal it ended the
   child with, and ENOBUFS. */
function cpMaxBufferError(exe, argv) {
  var error = cpError('spawnSync ' + exe + ' ENOBUFS', 'ENOBUFS');
  error.errno = -55;
  error.syscall = 'spawnSync ' + exe;
  error.path = exe;
  error.spawnargs = argv;
  return error;
}

/* one run, shaped as Node's spawnSync result: status, signal, output, pid, stdout, stderr and error */
function cpSyncRun(file, list, opts) {
  var exe = file;
  var argv = list;
  if (opts.shell) {
    argv = ['-c', [exe].concat(list).join(' ')];
    /* /bin/sh, the path a host runs its shell by, because that path is what a script of the
       command reads out of $0: sh -c 'echo $0' prints /bin/sh on a host, not sh. */
    exe = '/bin/sh';
  }
  var stdio = cpStdio(opts.stdio);
  var cwd = opts.cwd === undefined || opts.cwd === null ? undefined : String(opts.cwd);
  if (cwd !== undefined && cwd.charAt(0) !== '/') cwd = proc.cwd().replace(/\/$/, '') + '/' + cwd;
  var input = null;
  if (opts.input !== undefined && opts.input !== null) {
    input = typeof opts.input === 'string' ? opts.input : Buffer.from(opts.input).toString('utf8');
  }
  var raw = callCap('child.spawnSync', {
    file: exe,
    args: argv,
    cwd: cwd,
    env: opts.env && typeof opts.env === 'object' ? cpEnvObject(opts.env) : null,
    stdio: stdio.modes,
    input: input,
    timeout: Number(opts.timeout) > 0 ? Number(opts.timeout) : 0,
    killSignal: cpSyncKillName(opts.killSignal)
  });
  var encoding = opts.encoding === undefined ? null : opts.encoding;
  /* maxBuffer: the most either stream may hold, a megabyte when the caller names none and no check
     at all when it names zero. A host ends the child that writes more, and reports no status, the
     SIGTERM it ended it with and ENOBUFS, with the stream cut back to the mark. */
  var maxBuffer = opts.maxBuffer === undefined || opts.maxBuffer === null ? 1024 * 1024 : Number(opts.maxBuffer);
  var over = null;
  function shaped(text, fd) {
    if (stdio.modes[fd] !== 'pipe' || text === null || text === undefined) return null;
    var buffer = cpBytesOf(text);
    if (maxBuffer > 0 && buffer.length > maxBuffer) {
      if (over === null) over = fd === 1 ? 'stdout' : 'stderr';
      buffer = buffer.slice(0, Math.min(buffer.length, cpMaxBufferMark(maxBuffer)));
    }
    return encoding === null || encoding === 'buffer' ? buffer : buffer.toString(encoding);
  }
  var output = raw.spawned ? [null, shaped(raw.stdout, 1), shaped(raw.stderr, 2)] : undefined;
  var result = {
    status: raw.status,
    signal: raw.signal,
    output: output,
    pid: raw.pid,
    stdout: output ? output[1] : undefined,
    stderr: output ? output[2] : undefined
  };
  if (raw.error) {
    var error = new Error(raw.error.message);
    error.code = raw.error.code;
    if (raw.error.errno !== undefined) error.errno = raw.error.errno;
    if (raw.error.syscall !== undefined) error.syscall = raw.error.syscall;
    if (raw.error.path !== undefined) error.path = raw.error.path;
    if (raw.error.spawnargs !== undefined) error.spawnargs = raw.error.spawnargs;
    result.error = error;
  }
  if (over !== null && !raw.error) {
    result.status = null;
    result.signal = 'SIGTERM';
    result.error = cpMaxBufferError(exe, argv);
  }
  return result;
}

/* a failed run as the call site throws it: the run's error, or 'Command failed', with the run's fields attached */
function cpSyncFailure(ret, cmdText) {
  var failure = null;
  if (ret.error) {
    failure = ret.error;
  } else if (ret.status !== 0) {
    var message = 'Command failed: ' + cmdText;
    if (ret.stderr && ret.stderr.length > 0) message += '\n' + String(ret.stderr);
    failure = cpError(message);
  } else {
    return null;
  }
  failure.status = ret.status;
  failure.signal = ret.signal;
  failure.output = ret.output;
  failure.pid = ret.pid;
  failure.stdout = ret.stdout;
  failure.stderr = ret.stderr;
  return failure;
}

function cpSpawnSyncApi(file, args, options) {
  var call = cpSyncCall(file, args, options);
  return cpSyncRun(call.file, call.list, call.opts);
}

function cpExecSyncApi(command, options) {
  var opts = options && typeof options === 'object' ? options : {};
  var cmd = String(command);
  /* execSync runs the command through /bin/sh, the path a host's node runs it by: $0 inside the
     command reads that path, as it does on a host. */
  var ret = cpSyncRun('/bin/sh', ['-c', cmd], opts);
  if (opts.stdio === undefined && ret.stderr) proc.stderr.write(ret.stderr);
  var failure = cpSyncFailure(ret, cmd);
  if (failure) throw failure;
  return ret.stdout;
}

function cpExecFileSyncApi(file, args, options) {
  var call = cpSyncCall(file, args, options);
  var ret = cpSyncRun(call.file, call.list, call.opts);
  if (call.opts.stdio === undefined && ret.stderr) proc.stderr.write(ret.stderr);
  var failure = cpSyncFailure(ret, [call.file].concat(call.list).join(' '));
  if (failure) throw failure;
  return ret.stdout;
}

/* the parent exits: worker threads are terminated and IPC children are disconnected, as in Node */
function cpHookParentExit() {
  if (cpState.exitHooked) return;
  cpState.exitHooked = true;
  proc.once('exit', function () {
    try {
      callCap('child.parentExit', {});
    } catch (ignored) {
      // the process is exiting: nothing is left to notify
    }
  });
}

/* the child side of fork and cluster: process.send, process.connected, process.disconnect and the ref */
function cpWireProcess() {
  proc.connected = true;
  proc.send = function (message) {
    return cpChannelSend(message, cpCallbackFrom(arguments));
  };
  proc.disconnect = function () {
    if (!cpState.connected) return;
    cpState.connected = false;
    proc.connected = false;
    cpSetRef(false);
    callCap('child.disconnectSelf', {});
    proc.nextTick(function () {
      proc.emit('disconnect');
    });
  };
  proc.on('newListener', function (ev) {
    if (cpState.connected && (ev === 'message' || ev === 'disconnect')) cpSetRef(true);
  });
  proc.on('removeListener', function (ev) {
    if (ev !== 'message' && ev !== 'disconnect') return;
    cpSetRef(cpState.connected && proc.listenerCount('message') + proc.listenerCount('disconnect') > 0);
  });
}

/* frames from the parent: 'm' carries a message, 'd' closes the channel */
function cpOnFrame(name, frame) {
  if (name !== 'ipc' || !frame) return;
  if (frame.t === 'm') {
    var message = cpDecode(frame.v);
    if (cpState.kind === 'worker') cpState.port._enqueue(message);
    else proc.emit('message', message, undefined);
  } else if (frame.t === 'd' && cpState.connected) {
    cpState.connected = false;
    proc.connected = false;
    cpSetRef(false);
    proc.nextTick(function () {
      proc.emit('disconnect');
    });
  }
}

/* a worker thread reports an uncaught error to its parent before the error text ends the thread */
function cpWireWorkerErrors() {
  var base = api.formatUncaught;
  api.formatUncaught = function (err) {
    /* process.exit unwinds the thread it is called on by throwing, and the throw is what reaches
       here: it is the exit, not an error. A worker that left on its own reports no 'error' to its
       parent -- only its 'exit', with the status it chose -- and reporting one made a worker run
       from process.exit(5) emit an 'error' no host emits. */
    if (!(typeof api.isExitSignal === 'function' && api.isExitSignal(err))) {
      try {
        callCap('child.sendToParent', { frame: { t: 'e', v: cpErrorJson(err) } });
      } catch (ignored) {
        // the parent may already be gone
      }
    }
    return base(err);
  };
}

/* Atomics over a SharedArrayBuffer another thread holds too: the read-modify-write runs against the
   host's copy of the bytes, which is the one memory both sides share, and the local window is brought
   back in line with it either side of the operation. A wait is the one call that cannot answer at
   once -- the host keeps the waiter until another thread notifies it or its timeout runs out, and the
   guest resumes inside the statement that called, as it does for any host work that has to wait. A
   buffer that never crossed a thread keeps the atomics it already had. */
(function cpWireSharedAtomics() {
  var atoms = globalThis.Atomics;
  if (!atoms || typeof SharedArrayBuffer !== 'function') return;
  var CODES = { Int8Array: 'i8', Uint8Array: 'u8', Int16Array: 'i16', Uint16Array: 'u16',
    Int32Array: 'i32', Uint32Array: 'u32', BigInt64Array: 'i64', BigUint64Array: 'u64' };
  function slabOfArray(array) {
    if (array === null || typeof array !== 'object') return null;
    return cpSlabOf(array.buffer);
  }
  function kindCode(array) {
    for (var name in CODES) {
      var Ctor = globalThis[name];
      if (typeof Ctor === 'function' && array instanceof Ctor) return CODES[name];
    }
    return 'u8';
  }
  function pull(array) {
    var id = slabOfArray(array);
    if (id === null) return;
    var bytes = Buffer.from(callCap('shared.read', { id: id, off: 0, len: array.buffer.byteLength }), 'base64');
    new Uint8Array(array.buffer).set(bytes);
  }
  function push(array) {
    var id = slabOfArray(array);
    if (id === null) return;
    callCap('shared.write', { id: id, off: 0, bytes: Buffer.from(new Uint8Array(array.buffer)).toString('base64') });
  }
  function elementIndex(index) {
    var at = Number(index);
    if (at !== at) return 0;
    if (at === Infinity || at === -Infinity) return at;
    return at < 0 ? -Math.floor(-at) : Math.floor(at);
  }
  function expectedAs(seen, expected) {
    if (typeof seen === 'bigint') {
      try { return BigInt(expected); } catch (ignored) { return expected; }
    }
    return Number(expected);
  }
  function rewrap(name, impl) {
    var base = atoms[name];
    if (typeof base !== 'function') return;
    Object.defineProperty(atoms, name, {
      value: function () {
        var array = arguments[0];
        if (slabOfArray(array) === null) return base.apply(undefined, arguments);
        return impl(base, array, Array.prototype.slice.call(arguments, 1));
      },
      writable: true, enumerable: false, configurable: true
    });
  }
  ['add', 'sub', 'and', 'or', 'xor', 'exchange', 'compareExchange'].forEach(function (name) {
    rewrap(name, function (base, array, rest) {
      pull(array);
      var answer = base.apply(undefined, [array].concat(rest));
      push(array);
      return answer;
    });
  });
  rewrap('load', function (base, array, rest) {
    pull(array);
    return base.apply(undefined, [array].concat(rest));
  });
  rewrap('store', function (base, array, rest) {
    pull(array);
    var answer = base.apply(undefined, [array].concat(rest));
    push(array);
    return answer;
  });
  rewrap('notify', function (base, array, rest) {
    pull(array);
    push(array);
    var count = rest[1];
    return callCap('shared.notify', {
      id: slabOfArray(array),
      index: elementIndex(rest[0]),
      count: count === undefined ? null : Number(count)
    });
  });
  rewrap('wait', function (base, array, rest) {
    pull(array);
    var at = elementIndex(rest[0]);
    var seen = array[at];
    if (seen !== expectedAs(seen, rest[1])) return 'not-equal';
    var answer = callCap('shared.wait', {
      id: slabOfArray(array),
      index: at,
      kind: kindCode(array),
      expected: typeof seen === 'bigint' ? seen.toString() : Number(seen),
      timeout: rest[2] === undefined || rest[2] === null ? null : Number(rest[2])
    });
    pull(array);
    return answer;
  });
  rewrap('waitAsync', function (base, array, rest) {
    pull(array);
    return base.apply(undefined, [array].concat(rest));
  });
})();

BF['child_process'] = function () {
  var ChildProcess = cpChildClass();
  return {
    ChildProcess: ChildProcess,
    spawn: function (file, args, options) {
      return cpSpawnApi(file, args, options);
    },
    exec: function (command) {
      return cpExec(command, Array.prototype.slice.call(arguments, 1));
    },
    execFile: function (file) {
      return cpExecFile(file, Array.prototype.slice.call(arguments, 1));
    },
    fork: function (modulePath, args, options) {
      return cpForkApi(modulePath, args, options);
    },
    spawnSync: function (file, args, options) {
      return cpSpawnSyncApi(file, args, options);
    },
    execSync: function (command, options) {
      return cpExecSyncApi(command, options);
    },
    execFileSync: function (file, args, options) {
      return cpExecFileSyncApi(file, args, options);
    },
    /* Node's child bootstrap calls this at the top of a forked child to hang process.send,
       process.connected and process.disconnect off the channel its parent passed: the file
       descriptor Node reads the channel from is one this container has already attached, so what
       the name does here is the wiring itself. */
    _forkChild: function (fd, serializationMode) {
      cpWireProcess();
    }
  };
};

BF['worker_threads'] = function () {
  var Worker = cpWorkerClass();
  var Port = cpPortClass();
  var BroadcastChannel = cpBroadcastClass();
  function MessageChannel() {
    var pair = cpMakeChannel();
    this.port1 = pair.port1;
    this.port2 = pair.port2;
  }
  var isWorker = cpState.kind === 'worker';
  /* The name a program gave this thread, empty until it gives one, as it is in Node: the name is
     read and written through the module, not through an object of its own. */
  var threadName = '';
  var workerThreads = {
    isMainThread: !isWorker,
    parentPort: isWorker ? cpState.port : null,
    workerData: isWorker ? cpDecode(cpState.data.workerData) : null,
    threadId: isWorker ? cpState.data.threadId : 0,
    resourceLimits: {},
    SHARE_ENV: typeof Symbol === 'function' ? Symbol('nodejs.worker_threads.SHARE_ENV') : {},
    Worker: Worker,
    MessageChannel: MessageChannel,
    MessagePort: Port,
    BroadcastChannel: BroadcastChannel,
    /* A thread reached through this module is never one Node started for its own work, which is
       the only kind the name marks. */
    isInternalThread: false,
    receiveMessageOnPort: function (port) {
      if (!port || !port._q || port._q.length === 0) return undefined;
      return { message: port._q.shift() };
    },
    markAsUntransferable: function () {},
    isMarkedAsUntransferable: function () {
      return false;
    },
    getEnvironmentData: function (key) {
      return cpEnvData.has(key) ? cpEnvData.get(key) : undefined;
    },
    setEnvironmentData: function (key, value) {
      cpEnvData.set(key, value);
    }
  };
  Object.defineProperty(workerThreads, 'threadName', {
    get: function () { return threadName; },
    set: function (name) { threadName = String(name); },
    enumerable: true,
    configurable: true
  });
  return workerThreads;
};

BF['cluster'] = function () {
  var EE = cpEE();
  var cluster = Object.create(EE.prototype);
  EE.call(cluster);
  var Child = cpChildClass();
  var isWorker = cpState.kind === 'cluster';
  var nextId = 1;
  cluster.isWorker = isWorker;
  cluster.isPrimary = !isWorker;
  cluster.isMaster = !isWorker;
  cluster.workers = {};
  cluster.settings = {};
  cluster.schedulingPolicy = 2;
  cluster.SCHED_NONE = 1;
  cluster.SCHED_RR = 2;
  cluster.worker = undefined;
  cluster.setupPrimary = function (settings) {
    Object.assign(cluster.settings, settings || {});
  };
  cluster.setupMaster = cluster.setupPrimary;
  cluster.fork = function (env) {
    var id = nextId++;
    var workerEnv = {};
    Object.keys(proc.env).forEach(function (key) {
      workerEnv[key] = proc.env[key];
    });
    if (env && typeof env === 'object') {
      Object.keys(env).forEach(function (key) {
        workerEnv[key] = String(env[key]);
      });
    }
    workerEnv.NODE_UNIQUE_ID = String(id);
    var worker = new Child();
    worker.id = id;
    worker.process = worker;
    worker.exitedAfterDisconnect = false;
    worker.isDead = function () {
      return worker._cpExited === true;
    };
    worker.isConnected = function () {
      return worker.connected;
    };
    worker.disconnect = function () {
      worker.exitedAfterDisconnect = true;
      cpDisconnectChild(worker);
    };
    cluster.workers[id] = worker;
    cpSpawnCore(worker, 'node', [proc.argv[1]].concat(proc.argv.slice(2)), {
      env: workerEnv,
      stdio: ['inherit', 'inherit', 'inherit']
    }, { kind: 'cluster', cluster: cluster, ipc: true, ipcKind: 'cluster', ipcData: { id: id } });
    cluster.emit('fork', worker);
    return worker;
  };
  cluster.disconnect = function (callback) {
    Object.keys(cluster.workers).forEach(function (id) {
      cluster.workers[id].disconnect();
    });
    if (typeof callback === 'function') proc.nextTick(callback);
  };
  cluster.on('exit', function (worker) {
    delete cluster.workers[worker.id];
  });
  if (isWorker) {
    cluster.worker = {
      id: Number(cpState.data.id),
      process: proc,
      send: function (message, callback) {
        return proc.send(message, callback);
      },
      disconnect: function () {
        proc.disconnect();
      },
      isConnected: function () {
        return cpState.connected;
      },
      isDead: function () {
        return false;
      }
    };
  }
  return cluster;
};

(function cpBootChild() {
  var env = proc.env;
  if (!env || env.OWC_IPC_KIND === undefined) return;
  cpState.kind = String(env.OWC_IPC_KIND);
  cpState.data = JSON.parse(env.OWC_IPC_DATA || '{}');
  delete env.OWC_IPC_KIND;
  delete env.OWC_IPC_DATA;
  if (cpState.kind === 'cluster') delete env.NODE_UNIQUE_ID;
  cpState.connected = true;
  /* A forked or clustered child runs with a channel, as one does on a host: typeof
     process.channel is 'object' there, and a program that tests for it before sending sees it. A
     worker thread is not a channel child and keeps none. */
  if (cpState.kind !== 'worker') proc.channel = new (cpEE())();
  cpState.target = createTarget(cpOnFrame);
  if (cpState.kind === 'worker') {
    /* The environment data its parent held when it started it: a worker reads the keys its parent
       had, and a key it sets of its own is its own, as on host node 24.15. */
    cpEnvDataSeed(cpState.data.envData);
    /* The threads one BroadcastChannel name is open across: a worker shares its parent's set. A
       forked or clustered child keeps its own, which is what node gives a channel in a process of
       its own -- a name does not reach across processes there. */
    cpState.bcDomain = cpState.data.bcDomain === undefined ? String(proc.pid) : String(cpState.data.bcDomain);
    var Port = cpPortClass();
    cpState.port = new Port();
    cpState.port._remote = function (encoded) {
      callCap('child.sendToParent', { frame: { t: 'm', v: encoded } });
    };
    cpWireWorkerErrors();
  } else {
    cpWireProcess();
  }
  callCap('child.ipcAttach', {
    targetId: cpState.target,
    token: cpState.data.token === undefined ? null : cpState.data.token
  });
})();

/* BroadcastChannel without a require: node's global and worker_threads' are the same class, and the
   one above is it -- a channel open on a name reaches the workers of this process, not only the
   channels open in it. */
globalThis.BroadcastChannel = cpBroadcastClass();
`;
