/**
 * Guest-side DOM-style globals that Node provides and some packages load at import time: Event, CustomEvent,
 * EventTarget, DOMException, MessageEvent, MessagePort and MessageChannel. Plain JavaScript inside a String.raw
 * snippet, wrapped in one IIFE that installs the globals it does not already have. MessagePort delivers in
 * process only: postMessage clones with structuredClone and dispatches on the next immediate.
 */
export const SRC = String.raw`
(function () {
  var EVENT = new WeakMap();
  var TARGET = new WeakMap();
  var PORTS = new WeakMap();
  var PORT_TOKEN = {};
  var INSPECT_CUSTOM = typeof Symbol.for === 'function' ? Symbol.for('nodejs.util.inspect.custom') : undefined;

  /* What Node's own inspect hook writes around a string: single quotes, and the two characters it escapes. */
  function inspectString(value) {
    return "'" + String(value).split('\\').join('\\\\').split("'").join("\\'") + "'";
  }

  /*
   * Node declares an event's members ENUMERABLE and in one fixed order, so a for-in over an event
   * lists every one of them; a class body declares them non-enumerable and in the order it was
   * written. So each member is taken off the prototype -- a property keeps the place it was first
   * defined at, and deleting is what lets the order change -- and put back in Node's own order,
   * with the setter Node's has: cancelBubble and returnValue are the two attributes a program may
   * still write, and every other read-only one is left with no setter at all, which is what Node
   * declares -- an assignment to it is a silent no-op when the assigning code is not strict, and
   * Reflect.set answers false. A setter of our own that threw would be observable twice over:
   * the descriptor would carry one that Node's does not, and a sloppy assignment would throw
   * where the host silently ignores it. Only the message the engine itself builds for the strict
   * case is left to the engine, and that is recorded rather than reproduced.
   */
  function declareEventMembers(proto, order, extra) {
    var held = Object.create(null);
    Object.getOwnPropertyNames(proto).forEach(function (name) {
      if (name === 'constructor') return;
      held[name] = Object.getOwnPropertyDescriptor(proto, name);
      delete proto[name];
    });
    if (extra !== undefined) {
      Object.keys(extra).forEach(function (name) { held[name] = extra[name]; });
    }
    order.forEach(function (name) {
      var d = held[name];
      if (d === undefined) return;
      if (d.get !== undefined || d.set !== undefined) {
        d.enumerable = true;
        d.configurable = true;
      } else {
        d.writable = true;
        d.enumerable = true;
        d.configurable = true;
      }
      Object.defineProperty(proto, name, d);
    });
  }

  var LEGACY_CODES = {
    IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5,
    NoModificationAllowedError: 7, NotFoundError: 8, NotSupportedError: 9, InvalidStateError: 11,
    SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14, InvalidAccessError: 15,
    TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20, URLMismatchError: 21,
    QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25
  };

  /*
   * The three members a DOMException answers -- name, message and code -- are getters on the
   * prototype and not own properties of the instance, which is where host node 24.15 puts them and
   * which is why Object.getOwnPropertyNames(new DOMException('d', 'AbortError')) is ['stack'] there:
   * the stack is the one own property the engine gives an error itself. What hangs on that is the
   * report: util.inspect opens with 'DOMException [AbortError]: d' -- the constructor's name in
   * front and the name in brackets -- only while 'name' is NOT the error's own, which is the test
   * formatErrorStack asks, and it is why the container printed 'AbortError: d' where host node 24.15
   * prints 'DOMException [AbortError]: d' for as long as every instance carried its own. The values
   * are one set per instance, so they live in a WeakMap, the way the rest of this module keeps the
   * state an event or a port carries.
   */
  var DOM_FIELDS = new WeakMap();

  /* The name, message and code of an instance this constructor never ran on -- one out of
     'Object.create(DOMException.prototype)' -- are the ones a DOMException with no name answers. */
  function domFieldOf(self, key) {
    var fields = DOM_FIELDS.get(self);
    if (fields !== undefined) return fields[key];
    return key === 'name' ? 'Error' : (key === 'code' ? 0 : '');
  }

  /*
   * The two parameters carry default values, which is what host node 24.15 declares --
   * 'constructor(message = '', options = 'Error')' -- and which is the only reason the arity a
   * DOMException answers is 0: Function.length counts the parameters before the first one with a
   * default, so a constructor that reads 'constructor(message, name)' answers 2 where the host
   * answers 0, both on DOMException.length and on DOMException.prototype.constructor.length, which
   * is the same binding. A program that reads Function.length to decide how many arguments to pass,
   * or that builds a wrapper with the arity of the thing it wraps, is told two here and one there.
   * The defaults are the values the body already fell back to, so every call still lands where it
   * did: an argument left out was undefined, and undefined takes the default.
   */
  class DOMException extends Error {
    constructor(message = '', name = 'Error') {
      var text = message === undefined ? '' : String(message);
      var given = name === undefined ? 'Error' : String(name);
      /* The engine is handed the message so the stack it captures opens with it -- 'AbortError: d',
         the header host node 24.15 writes -- and the own 'message' it wrote is taken back off, so
         that 'stack' is the only own name an instance carries, as on the host. */
      super(text);
      DOM_FIELDS.set(this, { message: text, name: given, code: LEGACY_CODES[given] || 0 });
      delete this.message;
    }
  }
  /* Enumerable and configurable and with no setter, as host node 24.15 declares them: a for-in over
     an instance walks them in this order and an assignment to one is a no-op the host ignores. */
  Object.defineProperties(DOMException.prototype, {
    name: { get: function () { return domFieldOf(this, 'name'); }, enumerable: true, configurable: true },
    message: { get: function () { return domFieldOf(this, 'message'); }, enumerable: true, configurable: true },
    code: { get: function () { return domFieldOf(this, 'code'); }, enumerable: true, configurable: true }
  });
  /*
   * The 25 legacy code constants the DOM spec names -- INDEX_SIZE_ERR = 1 through DATA_CLONE_ERR = 25
   * -- are value properties of the prototype and of nothing else, which is where host node 24.15 puts
   * them: writable false, enumerable true, configurable false, so a for-in over the prototype, or
   * over any instance, walks 28 names and Object.keys(DOMException.prototype) is 28 long, where this
   * prototype carried 3 and every one of them read undefined. They are the codes a DOMException of
   * the matching name answers -- the same numbers LEGACY_CODES hands an instance -- plus the two no
   * name carries any more, DOMSTRING_SIZE_ERR and NO_DATA_ALLOWED_ERR, whose errors the spec dropped
   * and whose numbers it kept. Nothing on the instance changes: no instance gains an own name, so
   * Object.getOwnPropertyNames(new DOMException('d', 'AbortError')) is still ['stack'], and nothing
   * that reads a DOMException by its own names -- util.inspect's header first among them -- sees one
   * more than it did, which is why the report the last row on this file fixed still opens with
   * 'DOMException [AbortError]: d'.
   */
  var LEGACY_CONSTANTS = {
    INDEX_SIZE_ERR: 1, DOMSTRING_SIZE_ERR: 2, HIERARCHY_REQUEST_ERR: 3, WRONG_DOCUMENT_ERR: 4,
    INVALID_CHARACTER_ERR: 5, NO_DATA_ALLOWED_ERR: 6, NO_MODIFICATION_ALLOWED_ERR: 7,
    NOT_FOUND_ERR: 8, NOT_SUPPORTED_ERR: 9, INUSE_ATTRIBUTE_ERR: 10, INVALID_STATE_ERR: 11,
    SYNTAX_ERR: 12, INVALID_MODIFICATION_ERR: 13, NAMESPACE_ERR: 14, INVALID_ACCESS_ERR: 15,
    VALIDATION_ERR: 16, TYPE_MISMATCH_ERR: 17, SECURITY_ERR: 18, NETWORK_ERR: 19, ABORT_ERR: 20,
    URL_MISMATCH_ERR: 21, QUOTA_EXCEEDED_ERR: 22, TIMEOUT_ERR: 23, INVALID_NODE_TYPE_ERR: 24,
    DATA_CLONE_ERR: 25
  };
  var LEGACY_DESCS = {};
  Object.keys(LEGACY_CONSTANTS).forEach(function (constant) {
    LEGACY_DESCS[constant] = { value: LEGACY_CONSTANTS[constant], writable: false, enumerable: true, configurable: false };
  });
  Object.defineProperties(DOMException.prototype, LEGACY_DESCS);
  /*
   * The tag is the one thing a host DOMException carries that a plain Error does not, and it is
   * what Object.prototype.toString.call(new DOMException('d', 'AbortError')) reads to answer
   * '[object DOMException]' and not '[object Error]', as it does on host node 24.15. Host node
   * 24.15 declares it on the prototype -- writable false, enumerable false, configurable true,
   * which is where WebIDL puts it -- and no instance owns one.
   */
  if (typeof Symbol === 'function' && Symbol.toStringTag !== undefined) {
    Object.defineProperty(DOMException.prototype, Symbol.toStringTag, { value: 'DOMException', configurable: true });
  }

  class Event {
    /* Node's own signature: the second parameter carries a default, so Event.length -- and
       Event.prototype.constructor.length -- is 1 rather than the 2 a bare pair of parameters gives.
       timeStamp is a DOMHighResTimeStamp, milliseconds since this process began, not since the epoch. */
    constructor(type, options = {}) {
      if (arguments.length === 0) throw new TypeError('The "type" argument must be specified');
      var init = options === undefined || options === null ? {} : options;
      EVENT.set(this, {
        type: String(type),
        bubbles: !!init.bubbles,
        cancelable: !!init.cancelable,
        composed: !!init.composed,
        defaultPrevented: false,
        stopped: false,
        immediateStopped: false,
        target: null,
        currentTarget: null,
        timeStamp: performance.now()
      });
    }
    get type() { return EVENT.get(this).type; }
    get bubbles() { return EVENT.get(this).bubbles; }
    get cancelable() { return EVENT.get(this).cancelable; }
    get composed() { return EVENT.get(this).composed; }
    get defaultPrevented() { return EVENT.get(this).defaultPrevented; }
    get target() { return EVENT.get(this).target; }
    get currentTarget() { return EVENT.get(this).currentTarget; }
    get srcElement() { return EVENT.get(this).target; }
    get timeStamp() { return EVENT.get(this).timeStamp; }
    get isTrusted() { return false; }
    get eventPhase() { return EVENT.get(this).currentTarget === null ? 0 : 2; }
    get returnValue() { return !EVENT.get(this).defaultPrevented; }
    get cancelBubble() { return EVENT.get(this).stopped; }
    preventDefault() {
      var st = EVENT.get(this);
      if (st.cancelable) st.defaultPrevented = true;
    }
    stopPropagation() { EVENT.get(this).stopped = true; }
    stopImmediatePropagation() {
      var st = EVENT.get(this);
      st.stopped = true;
      st.immediateStopped = true;
    }
    composedPath() {
      var st = EVENT.get(this);
      return st.currentTarget === null ? [] : [st.currentTarget];
    }
  }
  declareEventMembers(Event.prototype, [
    'initEvent', 'stopImmediatePropagation', 'preventDefault', 'target', 'currentTarget', 'srcElement',
    'type', 'cancelable', 'defaultPrevented', 'timeStamp', 'composedPath', 'returnValue', 'bubbles',
    'composed', 'eventPhase', 'cancelBubble', 'stopPropagation', 'isTrusted'
  ], {
    /* The legacy initialiser: it rewrites the three attributes it is handed, and says what the
       constructor says when it is given nothing. */
    initEvent: { value: function initEvent(type) {
      if (arguments.length === 0) throw new TypeError('The "type" argument must be specified');
      var st = EVENT.get(this);
      if (st === undefined) return;
      st.type = String(type);
      st.bubbles = !!arguments[1];
      st.cancelable = !!arguments[2];
    } },
    /* The two attributes a program may still write: writing one is what stops propagation or
       cancels the event, and the getter reads the flag that writing it set. */
    returnValue: {
      get: function () { return !EVENT.get(this).defaultPrevented; },
      set: function (value) { if (!value) this.preventDefault(); }
    },
    cancelBubble: {
      get: function () { return EVENT.get(this).stopped; },
      set: function (value) { if (value) this.stopPropagation(); }
    }
  });
  if (INSPECT_CUSTOM !== undefined) {
    /* What Node prints: the four attributes its own hook names and nothing else -- not detail,
       data, wasClean, code or reason, which the subclass prototypes add -- so a CloseEvent and a
       MessageEvent are printed by the same hook, under their own class name. Node declares the hook
       before the tag, and the order own symbols are reported in is the order they were added. */
    Object.defineProperty(Event.prototype, INSPECT_CUSTOM, {
      value: function () {
        var name = this.constructor && typeof this.constructor.name === 'string' && this.constructor.name !== ''
          ? this.constructor.name : 'Event';
        return name + ' {\n  type: ' + inspectString(this.type) +
          ',\n  defaultPrevented: ' + String(this.defaultPrevented) +
          ',\n  cancelable: ' + String(this.cancelable) +
          ',\n  timeStamp: ' + String(this.timeStamp) + '\n}';
      },
      writable: true,
      configurable: true
    });
  }
  Object.defineProperty(Event.prototype, Symbol.toStringTag, { value: 'Event', configurable: true });
  /*
   * CloseEvent is installed by the bootstrap above this file, which runs before Event exists, so
   * there it can only be joined to Event on first use. Joining it here as well is what makes the
   * prototype itself read the way Node's does from the first moment a program can see it: a for-in
   * over CloseEvent.prototype lists the attributes it adds and then every attribute of an Event.
   */
  if (typeof globalThis.CloseEvent === 'function' &&
      Object.getPrototypeOf(globalThis.CloseEvent.prototype) !== Event.prototype) {
    Object.setPrototypeOf(globalThis.CloseEvent.prototype, Event.prototype);
  }
  Object.defineProperty(Event, 'NONE', { value: 0, enumerable: true });
  Object.defineProperty(Event, 'CAPTURING_PHASE', { value: 1, enumerable: true });
  Object.defineProperty(Event, 'AT_TARGET', { value: 2, enumerable: true });
  Object.defineProperty(Event, 'BUBBLING_PHASE', { value: 3, enumerable: true });

  class CustomEvent extends Event {
    constructor(type, options = {}) {
      super(type, options);
      var init = options === undefined || options === null ? {} : options;
      EVENT.get(this).detail = init.detail === undefined ? null : init.detail;
    }
    get detail() { return EVENT.get(this).detail; }
  }
  declareEventMembers(CustomEvent.prototype, ['detail']);
  Object.defineProperty(CustomEvent.prototype, Symbol.toStringTag, { value: 'CustomEvent', configurable: true });

  class MessageEvent extends Event {
    constructor(type, options = {}) {
      super(type, options);
      var init = options === undefined || options === null ? {} : options;
      var st = EVENT.get(this);
      st.data = init.data === undefined ? null : init.data;
      st.origin = init.origin === undefined ? '' : String(init.origin);
      st.lastEventId = init.lastEventId === undefined ? '' : String(init.lastEventId);
      st.source = init.source === undefined ? null : init.source;
      st.ports = init.ports === undefined ? [] : Array.prototype.slice.call(init.ports);
    }
    get data() { return EVENT.get(this).data; }
    get origin() { return EVENT.get(this).origin; }
    get lastEventId() { return EVENT.get(this).lastEventId; }
    get source() { return EVENT.get(this).source; }
    get ports() { return EVENT.get(this).ports; }
  }
  /* The legacy initialiser Node still declares, which sets nothing: it answers only to say it was
     given no argument at all. */
  declareEventMembers(MessageEvent.prototype,
    ['data', 'origin', 'lastEventId', 'source', 'ports', 'initMessageEvent'], {
      initMessageEvent: { value: function initMessageEvent(type) {
        if (arguments.length < 1) throw new TypeError('MessageEvent.initMessageEvent: 1 argument required, but 0 found.');
      } }
    });
  Object.defineProperty(MessageEvent.prototype, Symbol.toStringTag, { value: 'MessageEvent', configurable: true });

  class EventTarget {
    constructor() {
      TARGET.set(this, { listeners: Object.create(null) });
    }
    addEventListener(type, listener, options) {
      if (listener === null || listener === undefined) return;
      var st = TARGET.get(this);
      var name = String(type);
      var once = !!(options && typeof options === 'object' && options.once);
      var signal = options && typeof options === 'object' ? options.signal : undefined;
      if (signal && signal.aborted) return;
      var list = st.listeners[name] || (st.listeners[name] = []);
      for (var i = 0; i < list.length; i++) {
        if (list[i].listener === listener) return;
      }
      list.push({ listener: listener, once: once });
      if (signal) {
        var target = this;
        signal.addEventListener('abort', function () { target.removeEventListener(name, listener); });
      }
    }
    removeEventListener(type, listener) {
      var list = TARGET.get(this).listeners[String(type)];
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i].listener === listener) {
          list.splice(i, 1);
          return;
        }
      }
    }
    dispatchEvent(event) {
      if (!(event instanceof Event)) throw new TypeError('The "event" argument must be an instance of Event');
      var st = EVENT.get(event);
      if (st.target !== null) throw new DOMException('The event is already being dispatched', 'InvalidStateError');
      st.target = this;
      st.currentTarget = this;
      var list = TARGET.get(this).listeners[st.type];
      if (list) {
        var snapshot = list.slice();
        for (var i = 0; i < snapshot.length; i++) {
          var entry = snapshot[i];
          if (entry.once) this.removeEventListener(st.type, entry.listener);
          try {
            if (typeof entry.listener === 'function') entry.listener.call(this, event);
            else if (entry.listener && typeof entry.listener.handleEvent === 'function') entry.listener.handleEvent(event);
          } catch (error) {
            setImmediate(function () { throw error; });
          }
          if (st.immediateStopped) break;
        }
      }
      st.currentTarget = null;
      return !st.defaultPrevented;
    }
  }

  function deliverMessage(port, data) {
    var st = PORTS.get(port);
    if (st.closed) return;
    if (!st.started) {
      st.queue.push(data);
      return;
    }
    port.dispatchEvent(new MessageEvent('message', { data: data }));
  }

  class MessagePort extends EventTarget {
    constructor(token) {
      if (token !== PORT_TOKEN) throw new TypeError('Illegal constructor');
      super();
      PORTS.set(this, { peer: null, started: false, closed: false, queue: [], handler: null });
    }
    postMessage(message) {
      var st = PORTS.get(this);
      if (st.closed || st.peer === null) return;
      var data = structuredClone(message);
      var peer = st.peer;
      setImmediate(function () { deliverMessage(peer, data); });
    }
    start() {
      var st = PORTS.get(this);
      if (st.started) return;
      st.started = true;
      var queued = st.queue;
      st.queue = [];
      for (var i = 0; i < queued.length; i++) deliverMessage(this, queued[i]);
    }
    close() {
      var st = PORTS.get(this);
      st.closed = true;
      if (st.peer !== null) PORTS.get(st.peer).closed = true;
    }
    ref() {}
    unref() {}
    get onmessage() {
      return PORTS.get(this).handler;
    }
    set onmessage(handler) {
      var st = PORTS.get(this);
      if (st.handler !== null) this.removeEventListener('message', st.handler);
      st.handler = typeof handler === 'function' ? handler : null;
      if (st.handler !== null) {
        this.addEventListener('message', st.handler);
        this.start();
      }
    }
  }

  class MessageChannel {
    constructor() {
      var port1 = new MessagePort(PORT_TOKEN);
      var port2 = new MessagePort(PORT_TOKEN);
      PORTS.get(port1).peer = port2;
      PORTS.get(port2).peer = port1;
      this.port1 = port1;
      this.port2 = port2;
    }
  }

  function isObjectLike(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
  }

  /* This engine build has no GC observation: WeakRef keeps its target and FinalizationRegistry never runs its cleanup. register and unregister still answer as Node does. */
  var WEAK_TARGET = new WeakMap();
  class WeakRef {
    constructor(target) {
      if (!isObjectLike(target)) throw new TypeError('WeakRef: target must be an object');
      WEAK_TARGET.set(this, target);
    }
    deref() {
      return WEAK_TARGET.get(this);
    }
  }
  Object.defineProperty(WeakRef.prototype, Symbol.toStringTag, { value: 'WeakRef', configurable: true });

  var REGISTRY_TOKENS = new WeakMap();
  class FinalizationRegistry {
    constructor(cleanup) {
      if (typeof cleanup !== 'function') throw new TypeError('FinalizationRegistry: cleanup must be callable');
      REGISTRY_TOKENS.set(this, []);
    }
    register(target, heldValue, unregisterToken) {
      if (!isObjectLike(target)) throw new TypeError('FinalizationRegistry.prototype.register: target must be an object');
      if (target === heldValue) throw new TypeError('FinalizationRegistry.prototype.register: target and holdings must not be same');
      if (unregisterToken !== undefined) {
        if (!isObjectLike(unregisterToken)) throw new TypeError('FinalizationRegistry.prototype.register: unregisterToken must be an object');
        REGISTRY_TOKENS.get(this).push(unregisterToken);
      }
    }
    unregister(unregisterToken) {
      if (!isObjectLike(unregisterToken)) throw new TypeError('FinalizationRegistry.prototype.unregister: unregisterToken must be an object');
      var tokens = REGISTRY_TOKENS.get(this);
      var before = tokens.length;
      REGISTRY_TOKENS.set(this, tokens.filter(function (token) { return token !== unregisterToken; }));
      return REGISTRY_TOKENS.get(this).length !== before;
    }
  }
  Object.defineProperty(FinalizationRegistry.prototype, Symbol.toStringTag, { value: 'FinalizationRegistry', configurable: true });

  var installed = {
    Event: Event,
    CustomEvent: CustomEvent,
    EventTarget: EventTarget,
    DOMException: DOMException,
    MessageEvent: MessageEvent,
    MessagePort: MessagePort,
    MessageChannel: MessageChannel,
    WeakRef: WeakRef,
    FinalizationRegistry: FinalizationRegistry
  };
  Object.keys(installed).forEach(function (name) {
    if (typeof globalThis[name] === 'undefined') {
      Object.defineProperty(globalThis, name, { value: installed[name], writable: true, configurable: true, enumerable: false });
    }
  });
})();
`;
