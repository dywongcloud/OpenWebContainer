/**
 * Guest-side WebAssembly: the `WebAssembly` global, built on the host bridge in
 * runtime/wasm-host.ts.
 *
 * Modules are compiled and run in the host realm, because the guest engine has no
 * WebAssembly at all. Everything here behaves like the real thing except memory: a
 * `WebAssembly.Memory` keeps a guest shadow of the bytes, and the host copies the shadow
 * across the boundary whenever an export is called or an import calls back into guest
 * code. So guest writes to `memory.buffer` are visible to the module from the next call
 * on, and the module's writes are visible to the guest as soon as a call returns -- but
 * not in between, since there is one copy per call, not per byte. The copy is made in
 * chunks, so a large heap never exists twice at once; that changes nothing about when a
 * write becomes visible, only how much is live during the copy.
 *
 * Plain JavaScript inside a String.raw snippet, evaluated by the bootstrap with `host`
 * in scope.
 */
export const WASM_SRC = String.raw`
(function () {
  if (!host.wasm) return;
  var W = host.wasm;

  /*
   * The three error classes the namespace carries. Their name is on the prototype, as it is on a
   * host: Error.prototype and its subclasses each own a name and a message, and an instance owns
   * only what the constructor set.
   */
  class CompileError extends Error { constructor (m) { super(m); } }
  class LinkError extends Error { constructor (m) { super(m); } }
  class RuntimeError extends Error { constructor (m) { super(m); } }
  [['CompileError', CompileError], ['LinkError', LinkError], ['RuntimeError', RuntimeError]].forEach(function (pair) {
    Object.defineProperty(pair[1].prototype, 'name', { value: pair[0], writable: true, enumerable: false, configurable: true });
    Object.defineProperty(pair[1].prototype, 'message', { value: '', writable: true, enumerable: false, configurable: true });
  });

  var NAMED = {
    Error: Error, TypeError: TypeError, RangeError: RangeError, ReferenceError: ReferenceError,
    SyntaxError: SyntaxError, CompileError: CompileError, LinkError: LinkError, RuntimeError: RuntimeError
  };

  function parse (text) {
    var value = JSON.parse(text);
    if (value && value.ok === false) throw buildError(value);
    return value;
  }
  /** A host envelope: on failure it carries the code, the message and the guest error's name. */
  function unwrap (text) {
    var value = JSON.parse(text);
    if (value && value.ok === false) throw buildError(value);
    return value.value;
  }
  /*
   * An error the host raised, rebuilt in the class the host raised it in. The class travels with
   * the message: a bad import object and a Number where an i64 is wanted are both bad arguments
   * and are a TypeError on a host, while an import that is present but not callable is the one
   * case that really is a LinkError. Classifying by where the failure happened -- a link-time
   * failure a LinkError, a failure inside a call a RuntimeError -- is what made the first a
   * LinkError and the second a RuntimeError.
   */
  function buildError (envelope) {
    var props = envelope.props || {};
    var message = envelope.message || 'WebAssembly failed';
    if (envelope.code === 'ERR_WASM_GUEST') {
      var Ctor = NAMED[props.name] || Error;
      var guestError = new Ctor(message);
      if (props.name && !NAMED[props.name]) guestError.name = props.name;
      if (props.code) guestError.code = props.code;
      return guestError;
    }
    /* A wasm exception is not an error: it is thrown as it is, so a catch sees it whole. */
    if (envelope.code === 'ERR_WASM_EXCEPTION') return exceptionFor(props);
    var Host = NAMED[props.name] || Error;
    var error = new Host(message);
    if (props.name && !NAMED[props.name]) error.name = props.name;
    error.code = envelope.code;
    return error;
  }

  /*
   * A wasm exception. It is not an Error -- a host's is not -- so it is thrown as itself and a
   * caller's catch answers is and getArg on it. TAG and EXC hold the host's objects by id;
   * EXC is also how an exception that came out of a module is rebuilt as the same guest object
   * whoever reads it.
   */
  var TAG = Object.create(null);
  var EXC = Object.create(null);

  /** A tagged BigInt, rebuilt the way wasmArgs tagged it. */
  function decodeValue (value) {
    if (typeof value === 'string' && value.charCodeAt(0) === 0 && value.charCodeAt(1) === 98) return BigInt(value.slice(2));
    return value;
  }
  function exceptionFor (props) {
    var known = EXC[props.id];
    if (known) return known;
    var rebuilt = Object.create(Exception.prototype);
    rebuilt.__id = props.id;
    rebuilt.__tag = TAG[props.tag];
    rebuilt.__args = (props.args || []).map(decodeValue);
    EXC[props.id] = rebuilt;
    return rebuilt;
  }

  function toArrayBuffer (value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      var copy = new Uint8Array(value.byteLength);
      copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return copy.buffer;
    }
    throw new TypeError('WebAssembly: the argument must be a BufferSource');
  }

  /*
   * One piece of a memory copy. The host asks for pieces of this size when it syncs, and the
   * guest asks for the same when it seeds a shadow: a piece is small enough to allocate next
   * to a memory already this big, a whole memory is not.
   */
  var CHUNK = 1048576;

  /*
   * A wasm export takes numbers, and the JS API coerces anything else: ToNumber, then NaN
   * becomes 0 -- except at an i64, which the JS API takes as a BigInt and which JSON cannot
   * carry, so a BigInt goes over as a string with a NUL and a 'b' in front and the host rebuilds
   * it. A string the caller really passed goes over as a string with a NUL and an 's', so the host
   * hands it to the API as it is and the API does its own conversion: 'x' for an i64 is then the
   * host's own 'Cannot convert x to a BigInt', not a 0 the guest coerced first. Doing this here
   * rather than shipping the arguments across as JSON keeps the heap out of it -- emscripten
   * hands its Module object to a queued callback, and that object carries a typed array view over
   * every byte of a memory this size.
   */
  var BIGINT_TAG = '\u0000b';
  var STRING_TAG = String.fromCharCode(0) + 's';
  function wasmArgs (args) {
    var out = [];
    for (var i = 0; i < args.length; i++) {
      var value = args[i];
      if (typeof value === 'bigint') out.push(BIGINT_TAG + value.toString());
      else if (typeof value === 'string') out.push(STRING_TAG + value);
      else { var num = Number(value); out.push(num === num ? num : 0); }
    }
    return JSON.stringify(out);
  }

  /* Live objects by host id, so the host's sync callbacks can find them. */
  var MEM = Object.create(null);
  var TAB = Object.create(null);
  var GLOB = Object.create(null);

  /*
   * Resizing a memory's shadow. It is a plain function and not a method on the prototype, because
   * a host's Memory.prototype owns only buffer, constructor and grow -- a fourth own name there is
   * the sort of thing a package that enumerates the prototype trips over.
   */
  function resizeMemory (memory, bytes) {
    if (bytes === memory.__buffer.byteLength) return;
    var next = new ArrayBuffer(bytes);
    var view = new Uint8Array(next);
    var old = new Uint8Array(memory.__buffer);
    view.set(old.subarray(0, Math.min(old.length, view.length)));
    memory.__buffer = next;
  }

  /* The guest side of a host memory: buffer is the shadow the guest code sees. */
  class Memory {
    constructor (descriptor) {
      var d = descriptor || {};
      var initial = Math.max(0, Math.floor(d.initial || 0));
      var maximum = d.maximum === undefined ? -1 : Math.floor(d.maximum);
      if (d.shared) throw new Error('WebAssembly.Memory: shared memory is not supported in the container');
      this.__id = unwrap(W.memoryNew(initial, maximum));
      this.__buffer = new ArrayBuffer(initial * 65536);
      MEM[this.__id] = this;
    }
    get buffer () { return this.__buffer; }
    grow (delta) {
      delta = Math.floor(delta);
      var before = unwrap(W.memoryGrow(this.__id, delta));
      resizeMemory(this, unwrap(W.memoryPages(this.__id)) * 65536);
      return before;
    }
  }

  /** A memory the module created: same as a guest Memory, seeded with the module's bytes. */
  function bindMemory (id) {
    var memory = Object.create(Memory.prototype);
    memory.__id = id;
    var size = unwrap(W.memoryPages(id)) * 65536;
    memory.__buffer = new ArrayBuffer(size);
    for (var off = 0; off < size; off += CHUNK) {
      var part = W.memoryRead(id, off, Math.min(CHUNK, size - off));
      if (!part || part.byteLength === 0) break;
      new Uint8Array(memory.__buffer, off, part.byteLength).set(new Uint8Array(part));
    }
    MEM[id] = memory;
    return memory;
  }

  /*
   * What marks a function that stands for a real wasm function: one the host holds, read out of a
   * table, or an export of an instantiated module. A host's Table.set takes these and refuses an
   * ordinary JavaScript function, so the difference travels under symbols, which no enumeration of
   * a function or of a prototype sees. WASMFN_ID is the id the host already holds the function
   * under, so setting one into a table sets the real function and not a wrapper around it.
   */
  var WASMFN = Symbol('wasmfn');
  var WASMFN_ID = Symbol('wasmfnid');
  /* Seeding a table with the host's own entries, at bind time. This is a symbol and not the name
     it used to carry, because a host's Table.prototype owns no '__host': that name showed up in
     Object.getOwnPropertyNames(WebAssembly.Table.prototype) on the container and not on a host.
     Both are declared ahead of the class, whose prototype is built at install time. */
  var SEED = Symbol('host');

  class Table {
    constructor (descriptor) {
      var d = descriptor || {};
      this.__element = d.element || 'anyfunc';
      var maximum = d.maximum === undefined ? -1 : Math.floor(d.maximum);
      this.__id = unwrap(W.tableNew(this.__element, Math.max(0, Math.floor(d.initial || 0)), maximum));
      this.__entries = new Array(unwrap(W.tableLength(this.__id)));
      this.__ids = new Array(this.__entries.length);
      TAB[this.__id] = this;
    }
    get length () { return unwrap(W.tableLength(this.__id)); }
    get (index) {
      var entry = this.__entries[index];
      if (entry === undefined) {
        var info = unwrap(W.tableGet(this.__id, index));
        entry = info && info.k === 'fn' ? hostFunction(this.__id, info.id) : null;
        this.__entries[index] = entry;
      }
      return entry;
    }
    set (index, value) {
      /*
       * A function-typed table takes null or a wasm function object and nothing else. An ordinary
       * JavaScript function is refused, in the host's own words, and the slot stays empty; the
       * same refusal covers undefined, an object, a number and a string, which the host does not
       * distinguish either.
       */
      if (value !== null && !(typeof value === 'function' && value[WASMFN] === true)) {
        throw new TypeError('WebAssembly.Table.set(): Argument 1 is invalid for table: function-typed object must be null (if nullable) or a Wasm function object');
      }
      var previous = this.__ids[index];
      if (previous !== undefined) { W.drop(previous); this.__ids[index] = undefined; }
      var descriptor = { k: 'null' };
      if (value !== null) {
        var held = value[WASMFN_ID];
        if (typeof held === 'number') descriptor = { k: 'fn', id: held };
        else {
          this.__ids[index] = W.retain(value);
          descriptor = { k: 'fn', id: this.__ids[index] };
        }
      }
      var reply = JSON.parse(W.tableSet(this.__id, index, JSON.stringify(descriptor)));
      /* A function-typed table takes WebAssembly functions only, so the guest keeps its own. */
      if (reply && reply.ok === false && reply.code !== 'ERR_WASM_TABLE_JSFN') throw buildError(reply);
      this.__entries[index] = value;
    }
    grow (delta) {
      var before = unwrap(W.tableGrow(this.__id, Math.floor(delta)));
      this.__entries.length = unwrap(W.tableLength(this.__id));
      return before;
    }
  }
  Object.defineProperty(Table.prototype, SEED, {
    value: function (json) {
      var entries = JSON.parse(json);
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.k === 'fn') this.__entries[entry.i] = hostFunction(this.__id, entry.id);
        else if (this.__entries[entry.i] === undefined) this.__entries[entry.i] = null;
      }
      this.__entries.length = unwrap(W.tableLength(this.__id));
    },
    writable: true,
    enumerable: false,
    configurable: true
  });
  /*
   * A host's Table.prototype owns get, grow, length and set as enumerable members and its
   * constructor as a non-enumerable one, which is what Object.keys answers 'get,grow,length,set'
   * for. A class body makes every member non-enumerable, so the four are re-declared the way a
   * host carries them, and the prototype answers '[object WebAssembly.Table]' to a toString.
   */
  var tableLength = Object.getOwnPropertyDescriptor(Table.prototype, 'length');
  Object.defineProperty(Table.prototype, 'length', {
    get: tableLength.get, set: tableLength.set, enumerable: true, configurable: true
  });
  ['get', 'grow', 'set'].forEach(function (name) {
    var member = Object.getOwnPropertyDescriptor(Table.prototype, name);
    Object.defineProperty(Table.prototype, name, {
      value: member.value, writable: true, enumerable: true, configurable: true
    });
  });
  Object.defineProperty(Table.prototype, Symbol.toStringTag, {
    value: 'WebAssembly.Table', writable: false, enumerable: false, configurable: true
  });

  function bindTable (id) {
    var table = Object.create(Table.prototype);
    table.__element = 'anyfunc';
    table.__id = id;
    table.__entries = new Array(unwrap(W.tableLength(id)));
    table.__ids = new Array(table.__entries.length);
    TAB[id] = table;
    table[SEED](W.tableDump(id));
    return table;
  }

  /** A wasm function the host holds: calling it goes through the host, with memory synced. */
  function hostFunction (instanceId, fnId) {
    var call = function () {
      /* A wasm function the host ran answers a BigInt for an i64, and it crosses as a tagged
         string, so it is rebuilt here: a caller sees the BigInt the JS API would have given it. */
      return decodeValue(unwrap(W.fnCall(fnId, wasmArgs(arguments), instanceId)));
    };
    Object.defineProperty(call, 'name', { value: 'wasm-function', configurable: true });
    Object.defineProperty(call, WASMFN, { value: true });
    Object.defineProperty(call, WASMFN_ID, { value: fnId });
    return call;
  }

  class Global {
    constructor (descriptor, value) {
      var d = descriptor || {};
      this.__id = unwrap(W.globalNew(d.value || 'i32', !!d.mutable, value === undefined ? 0 : Number(value)));
      GLOB[this.__id] = this;
    }
    /* An i64 global's value is a BigInt on a host, and it crosses tagged like any other i64. */
    get value () { return decodeValue(unwrap(W.globalGet(this.__id))); }
    set value (next) { unwrap(W.globalSet(this.__id, Number(next))); }
  }
  /*
   * A host's Global.prototype owns three names: constructor, value and valueOf. valueOf is an
   * ordinary enumerable method that answers the value -- the Number or BigInt the getter answers,
   * which is what makes global.valueOf() read 5 where its absence made it a TypeError here. A
   * host also carries value as an enumerable accessor, so Object.keys reads 'value,valueOf' there,
   * while a class body makes both non-enumerable.
   */
  Global.prototype.valueOf = function () { return this.value; };
  var globalValue = Object.getOwnPropertyDescriptor(Global.prototype, 'value');
  Object.defineProperty(Global.prototype, 'value', {
    get: globalValue.get, set: globalValue.set, enumerable: true, configurable: true
  });
  Object.defineProperty(Global.prototype, Symbol.toStringTag, {
    value: 'WebAssembly.Global', writable: false, enumerable: false, configurable: true
  });

  function bindGlobal (id) {
    var global = Object.create(Global.prototype);
    global.__id = id;
    GLOB[id] = global;
    return global;
  }

  /*
   * The host's two sync callbacks. Only memory needs them: a table or global the guest
   * writes goes straight through to the host, while a write into the memory shadow is
   * invisible until it is copied.
   *
   * A memory is copied a chunk at a time, so a large heap is never live twice: onPull
   * answers with the bytes at (offset, length) and onPush writes the bytes it is handed
   * back at offset, growing the shadow when a chunk runs past its end. The chunk is a
   * fresh ArrayBuffer each time -- the host copies it out of this heap anyway.
   */
  var PULL = 0;
  var PUSH = 0;
  /*
   * The piece the host is handed, kept between calls: the host copies the bytes out of this
   * heap before it asks for the next piece, so one piece-sized buffer serves a whole sync
   * instead of a fresh megabyte being allocated for every chunk of it.
   */
  var PIECE = null;
  var PIECE_N = 0;
  function piece (n) {
    if (PIECE_N === n) return PIECE;
    var buffer = new ArrayBuffer(n);
    if (n >= PIECE_N) { PIECE = buffer; PIECE_N = n; }
    return buffer;
  }

  function onPull (kind, id, offset, length) {
    if (kind !== 'mem') return undefined;
    var memory = MEM[id];
    if (!memory) return undefined;
    var size = memory.__buffer.byteLength;
    var start = typeof offset === 'number' && offset > 0 ? Math.min(offset, size) : 0;
    var end = typeof length === 'number' && length > 0 ? Math.min(size, start + length) : size;
    var n = Math.max(0, end - start);
    if (n === 0) return undefined;
    /* Asked for the whole shadow: hand over the shadow itself rather than a copy of it. */
    if (start === 0 && n === size) return memory.__buffer;
    var buffer = piece(n);
    new Uint8Array(buffer).set(new Uint8Array(memory.__buffer, start, n));
    return buffer;
  }
  function onPush (kind, id, offset, payload) {
    if (kind !== 'mem') return undefined;
    var memory = MEM[id];
    if (!memory || !payload) return undefined;
    var start = typeof offset === 'number' && offset > 0 ? offset : 0;
    if (start + payload.byteLength > memory.__buffer.byteLength) resizeMemory(memory, start + payload.byteLength);
    if (payload.byteLength > 0) new Uint8Array(memory.__buffer, start, payload.byteLength).set(new Uint8Array(payload));
    return undefined;
  }
  function syncIds () {
    if (!PULL) {
      PULL = W.retain(onPull);
      PUSH = W.retain(onPush);
    }
    return [PULL, PUSH];
  }

  function shapeOf (module) {
    var text = W.moduleShape(module.__id);
    var value = JSON.parse(text);
    if (value && value.ok === false) throw buildError(value);
    return value;
  }

  class Module {
    constructor (bytes) {
      this.__id = unwrap(W.compile(toArrayBuffer(bytes)));
    }
    static imports (module) {
      var shape = shapeOf(module);
      return shape.imports.map(function (entry) { return { module: entry.module, name: entry.name, kind: entry.kind }; });
    }
    static exports (module) {
      var shape = shapeOf(module);
      return shape.exports.map(function (entry) { return { name: entry.name, kind: entry.kind }; });
    }
    static customSections () { return []; }
  }

  function describeImports (imports) {
    /* No import object at all is its own case on a host, so it travels as null and not as {}. */
    if (imports === undefined || imports === null) return null;
    var out = {};
    var namespaces = Object.keys(imports);
    for (var i = 0; i < namespaces.length; i++) {
      var entries = imports[namespaces[i]] || {};
      var built = {};
      var names = Object.keys(entries);
      for (var j = 0; j < names.length; j++) {
        var value = entries[names[j]];
        if (value instanceof Memory) built[names[j]] = { k: 'mem', id: value.__id };
        else if (value instanceof Table) built[names[j]] = { k: 'tab', id: value.__id };
        else if (value instanceof Global) built[names[j]] = { k: 'glob', id: value.__id };
        else if (typeof value === 'function') built[names[j]] = { k: 'fn', id: W.retain(value) };
        else if (typeof value === 'number') built[names[j]] = { k: 'num', v: value };
        else if (value === undefined || value === null) continue;
        else throw new TypeError('WebAssembly: ' + namespaces[i] + '.' + names[j] + ' is not a supported import');
      }
      out[namespaces[i]] = built;
    }
    return out;
  }

  function wrapExport (instanceId, entry) {
    if (entry.kind === 'function') {
      var fn = function () {
        /* An export the module declared as i64 answers a BigInt on a host, and the host sends it
           as a tagged string, so it is rebuilt here rather than arriving as a lossy Number. */
        return decodeValue(unwrap(W.call(instanceId, entry.name, wasmArgs(arguments))));
      };
      Object.defineProperty(fn, 'name', { value: entry.name, configurable: true });
      /* An export is a wasm function, so a host's Table.set takes it; only an ordinary JavaScript
         function is refused. */
      Object.defineProperty(fn, WASMFN, { value: true });
      return fn;
    }
    if (entry.kind === 'memory') return bindMemory(entry.id);
    if (entry.kind === 'table') return bindTable(entry.id);
    if (entry.kind === 'global') return bindGlobal(entry.id);
    return undefined;
  }

  class Instance {
    constructor (module, imports, label) {
      if (!(module instanceof Module)) throw new TypeError('WebAssembly.Instance: expected a Module');
      var ids = syncIds();
      /*
       * The label is the name the host's message should carry: the same link failure reads
       * 'WebAssembly.instantiate(): ...' reached through instantiate and 'WebAssembly.Instance():
       * ...' reached through the constructor, and only the guest knows which one was called.
       */
      var info = unwrap(W.instantiate(module.__id, JSON.stringify(describeImports(imports)), ids[0], ids[1],
        label === undefined ? 'Instance' : label));
      this.__id = info.id;
      this.__module = module;
      this.__exports = Object.create(null);
      for (var i = 0; i < info.exports.length; i++) {
        var entry = info.exports[i];
        this.__exports[entry.name] = wrapExport(this.__id, entry);
      }
    }
  }
  /*
   * A host's Instance.prototype owns exports, as a getter, and an instance does not own it at all.
   * Keeping it on the prototype is what Object.getOwnPropertyNames(WebAssembly.Instance.prototype)
   * answers 'constructor,exports' for.
   */
  Object.defineProperty(Instance.prototype, 'exports', {
    get: function () { return this.__exports; },
    enumerable: true,
    configurable: true
  });

  /*
   * The exception-handling surface. A tag and an exception are really host objects -- the module
   * runs in the host realm, so it is a host tag the module throws and catches -- and what is made
   * here is the host's own, with the guest keeping the id. Neither is an Error, because a host's
   * is not: an exception is thrown as itself, and whoever catches it answers is and getArg.
   *
   * An exception thrown by an import goes back to the host as the host exception and not as an
   * error, so a handler inside the module can catch it; one that comes out of the module is
   * rebuilt here from the host's tag and payload.
   */
  class Tag {
    constructor (descriptor) {
      this.__id = unwrap(W.tagNew(descriptor === undefined || descriptor === null ? 'null' : JSON.stringify(descriptor)));
      TAG[this.__id] = this;
    }
  }
  /*
   * WebAssembly.JSTag, the tag a host carries beside Tag. It is not a class: it is an object with
   * Tag.prototype behind it, no own property of its own, and no way to construct it -- a TypeError
   * is what a host raises for new WebAssembly.JSTag(). It is an own name of the namespace but not an
   * own enumerable one, which is why Object.keys misses it and Object.getOwnPropertyNames does
   * not. Tag.prototype carries the 'WebAssembly.Tag' tag a host answers, so a tag, an exception
   * built from one and JSTag itself all read '[object WebAssembly.Tag]'.
   */
  var JSTAG = Object.create(Tag.prototype);
  Object.defineProperty(Tag.prototype, Symbol.toStringTag, {
    value: 'WebAssembly.Tag', writable: false, enumerable: false, configurable: true
  });

  class Exception {
    constructor (tag, payload) {
      var tagId = tag instanceof Tag ? tag.__id : 0;
      /* A host refuses JSTag as the tag of an exception, in its own words, before anything else. */
      if (tag === JSTAG) throw new TypeError('WebAssembly.Exception(): Argument 0 cannot be WebAssembly.JSTag');
      /* Anything that is not a list of values is the call a host refuses in its own words. */
      var args = 'null';
      if (Array.isArray(payload)) {
        args = JSON.stringify(payload.map(function (value) {
          return typeof value === 'bigint' ? BIGINT_TAG + value.toString() : value;
        }));
      }
      this.__tag = tag;
      this.__args = Array.isArray(payload) ? payload.slice() : [];
      this.__id = unwrap(W.exceptionNew(tagId, args));
      EXC[this.__id] = this;
      /* How the host tells an exception from an error when an import throws one. */
      Object.defineProperty(this, '__exc', { value: this.__id });
    }
    is (tag) {
      return unwrap(W.exceptionIs(this.__id, tag instanceof Tag ? tag.__id : 0)) === true;
    }
    getArg (tag, index) {
      return decodeValue(unwrap(W.exceptionArg(this.__id, tag instanceof Tag ? tag.__id : 0, index)));
    }
  }

  function validate (bytes) {
    try {
      return W.validate(toArrayBuffer(bytes)) === true;
    } catch (error) {
      return false;
    }
  }
  function compile (bytes) {
    return Promise.resolve(new Module(bytes));
  }
  /*
   * Two shapes, as in the JS API: given bytes this resolves to { module, instance }, and given a
   * Module it resolves to the Instance itself. hash-wasm and most emscripten output take the
   * second form and read result.exports straight off what they awaited.
   */
  function instantiate (source, imports) {
    try {
      if (source instanceof Module) return Promise.resolve(new Instance(source, imports, 'instantiate'));
      var module = new Module(source);
      return Promise.resolve({ module: module, instance: new Instance(module, imports, 'instantiate') });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /*
   * The two streaming entry points. What either takes is a Response, or a promise of one, and what
   * streams is its body: the bytes go through the same compile the non-streaming call uses, because
   * a container has no host network behind the fetch that produced them. Both checks a host makes
   * are made here, and both come back as a rejection rather than a throw: the argument is neither a
   * Response nor a promise, and a Response whose Content-Type is not exactly application/wasm.
   */
  function describeSource (value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return "type string ('" + value + "')";
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return 'type ' + typeof value + ' (' + String(value) + ')';
    }
    if (typeof value === 'symbol' || typeof value === 'function') return 'type ' + typeof value;
    var ctor = value.constructor;
    return 'an instance of ' + (ctor && typeof ctor.name === 'string' && ctor.name ? ctor.name : 'Object');
  }
  function badSource (value) {
    var error = new TypeError('The "source" argument must be an instance of Response or an Promise resolving to Response. Received ' + describeSource(value));
    error.code = 'ERR_INVALID_ARG_TYPE';
    return error;
  }
  function badMime (type) {
    var error = new TypeError("WebAssembly response has unsupported MIME type '" + (type === undefined || type === null ? 'null' : type) + "'");
    error.code = 'ERR_WEBASSEMBLY_RESPONSE';
    return error;
  }
  /* A Response is taken by what it can do rather than by what class made it, so a package that
     installs its own Response under that name still works here. */
  function isResponse (value) {
    return !!value && typeof value.arrayBuffer === 'function';
  }
  function streamingBytes (source) {
    if (isResponse(source)) {
      /* A body is one-shot: a Response a caller already read -- or already handed to one of these
         two -- is unusable, and a host says so in its own words rather than the Response's. */
      if (source.bodyUsed === true) {
        var used = new TypeError('WebAssembly response body has already been used');
        used.code = 'ERR_WEBASSEMBLY_RESPONSE';
        return Promise.reject(used);
      }
      var headers = source.headers;
      var type = headers && typeof headers.get === 'function' ? headers.get('content-type') : null;
      if (type !== 'application/wasm') return Promise.reject(badMime(type));
      return Promise.resolve(source.arrayBuffer());
    }
    if (source && typeof source.then === 'function') {
      return Promise.resolve(source).then(function (value) {
        if (!isResponse(value)) throw badSource(value);
        return streamingBytes(value);
      });
    }
    return Promise.reject(badSource(source));
  }
  function compileStreaming (source) {
    return streamingBytes(source).then(function (bytes) { return new Module(bytes); });
  }
  /* Given bytes a caller reads result.module and result.instance, the pair instantiate answers. */
  function instantiateStreaming (source, imports) {
    return streamingBytes(source).then(function (bytes) {
      var module = new Module(bytes);
      return { module: module, instance: new Instance(module, imports) };
    });
  }

  /*
   * The namespace object: the five functions a caller enumerates, and the constructors beside them,
   * which a host does not enumerate -- Object.keys(WebAssembly) there is those five names and no
   * more -- so the two kinds of member are put on it two different ways.
   */
  var NS = {
    compile: compile,
    compileStreaming: compileStreaming,
    instantiate: instantiate,
    instantiateStreaming: instantiateStreaming,
    validate: validate
  };
  var CLASS_NAMES = ['Module', 'Instance', 'Memory', 'Table', 'Global', 'Tag', 'Exception', 'CompileError', 'LinkError', 'RuntimeError'];
  var CLASS_VALUES = [Module, Instance, Memory, Table, Global, Tag, Exception, CompileError, LinkError, RuntimeError];
  for (var cn = 0; cn < CLASS_NAMES.length; cn++) {
    Object.defineProperty(NS, CLASS_NAMES[cn], {
      value: CLASS_VALUES[cn],
      writable: true,
      enumerable: false,
      configurable: true
    });
  }
  /* JSTag is not one of the classes: a host carries it non-writable, beside them. */
  Object.defineProperty(NS, 'JSTag', {
    value: JSTAG, writable: false, enumerable: false, configurable: true
  });

  Object.defineProperty(globalThis, 'WebAssembly', {
    value: NS,
    writable: true,
    configurable: true,
    enumerable: false
  });
  /* The tag host Node 24.15 answers for the namespace: 'Object.prototype.toString.call(WebAssembly)'
     reads '[object WebAssembly]' there and not '[object Object]', which is what a bare namespace
     object reads as. Node carries it as a non-enumerable, non-writable own property of the
     namespace, and so does this one. */
  Object.defineProperty(globalThis.WebAssembly, Symbol.toStringTag, {
    value: 'WebAssembly', writable: false, enumerable: false, configurable: true
  });
})();
`;
