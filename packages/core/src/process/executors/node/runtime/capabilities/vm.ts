import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten';
import { CapabilityContext, CapabilityHandler } from './types';

/**
 * Host half of the vm `timeout` option, and of the preemption that stops a runaway guest.
 *
 * The guest hands the evaluation over as a thunk (api.vmThunk) and calls vm.run with the timeout.
 * The host arms the deadline, runs the thunk, and disarms the deadline before returning, so no guest
 * code runs between arming and the thunk. QuickJS delivers an interrupt as an uncatchable
 * InternalError: guest catch and finally blocks are skipped, so the interruption is caught here, at
 * the host call boundary, and reported as a value.
 *
 * The same handler is what makes a runaway guest stoppable at all. A guest loop blocks the host
 * thread, so no host timer -- the runner's own timeoutMs included -- can fire while it runs; the
 * only code that still runs is this handler, called by QuickJS from inside its interpreter loop.
 * It therefore carries the run's budget itself: a stretch of guest execution that neither called
 * the host nor let the host back in for longer than the budget is interrupted, the way Node's `vm`
 * timeout interrupts a script.
 */

interface VmRealm {
    /** The QuickJS context that is this `vm` context's own realm. */
    ctx: QuickJSContext;
    /** Hands a cell the realm's tracker built to `api.noteRejection`, once per realm. */
    noteFn?: QuickJSHandle;
    /** Hands the cell of a promise this realm built to the guest's record of what promises settled with. */
    recordFn?: QuickJSHandle;
    /** Rebuilds the value a promise settles with, once per realm: see {@link promiseOf}. */
    rehomeFn?: QuickJSHandle;
    /** The standard globals of the guest realm beside their namesakes in this realm, once. */
    builtins?: { from: QuickJSHandle[]; to: QuickJSHandle[] };
    /** `Object.getOwnPropertyNames` of this realm, once: what {@link syncOut} reads. */
    namesFn?: QuickJSHandle;
    /** `Object.defineProperty` in this realm, once: what {@link defineHidden} uses. */
    defineFn?: QuickJSHandle;
    /** The own names of this realm's global object as it was made: its intrinsics, not its sandbox. */
    base: Set<string>;
    /** The names on the global object that are the sandbox's: what {@link syncOut} writes back. */
    held: Set<string>;
    /** Names this container put on the global object itself: never written back to the sandbox. */
    injected: Set<string>;
}

interface VmHost {
    runtime: QuickJSRuntime;
    context: QuickJSContext;
    /** The guest bootstrap API object; vm.run reads the thunk from its `vmThunk` slot. */
    api: QuickJSHandle;
    /**
     * One second realm per `vm` context, each a QuickJS context of its own on the same runtime,
     * made the first time that context runs code. Its intrinsics are its own -- `Array` here is
     * not the guest's `Array`, and not the `Array` of any other context -- because QuickJS gives
     * each context its own set, while objects of one context are usable from another of the same
     * runtime. That is the whole of what Node's cross-realm behaviour needs: a value the context
     * made answers `false` to `instanceof Array` while `Array.isArray` still answers `true`, and
     * one the caller put into the context is the caller's own object still. A context is a realm
     * of its own on host Node 24.15 too, so `vm.createContext({})` twice is two: `Object` out of
     * one is not the `Object` out of the other, and `[1]` out of one is not `instanceof` the
     * `Array` of the other.
     */
    realms: Map<number, VmRealm>;
    /** `Object.prototype.toString` and `Array.isArray` of the guest realm, once: see {@link VmProbes}. */
    probes?: VmProbes;
    /** `(v) => boolean`: whether `v` is a proxy the guest realm made, built once in that realm. */
    proxyTest?: QuickJSHandle;
    /** `Proxy` of the guest realm, once: what a rebuild wraps a proxy it hands back in. */
    proxyCtor?: QuickJSHandle;
    /** Values built in a second realm and handed to the guest, freed with the binding. */
    realmValues: QuickJSHandle[];
    /**
     * A `WeakMap` of the guest realm: the value a `vm` context handed back -> the twin it was
     * rebuilt as, so that what the context hands back twice comes back as one object.
     */
    twins?: QuickJSHandle;
    /** The pairs behind {@link VmHost.twins}, oldest first: the source, and the twin beside it. */
    memo: { src: QuickJSHandle; twin: QuickJSHandle }[];
    /** Armed deadline in epoch milliseconds; 0 while nothing is armed. */
    deadline: number;
    /** Set by the interrupt handler when it interrupts; read by vm.run. */
    fired: boolean;
    /** Set by a kill path: every later interrupt check stops the guest. */
    cancelled: boolean;
    /** Milliseconds of guest execution with no host call in between; 0 leaves the budget disarmed. */
    budgetMs: number;
    /** Start of the stretch of guest execution now running, 0 when none is. */
    sliceStart: number;
    /** Time of the previous interrupt check; the gap to this one is what a yield looks like. */
    lastCheck: number;
    /** Why the handler last interrupted; cleared when the host reads it. */
    reason?: VmInterruption;
}

/** Why the guest was stopped. `vm` is an armed vm.run deadline; the other two are preemption. */
export type VmInterruption = 'vm' | 'cancel' | 'budget';

/**
 * A gap between two interrupt checks longer than this ends the stretch the budget bounds even with
 * no host call in it: the guest awaited something, idled, or the host stepped the event loop.
 */
const YIELD_MS = 250;

/**
 * How deep a value is rebuilt in the second realm: past this it crosses as it is.
 *
 * A bound rather than a promise, and 8 was far too shallow for it: a 12-deep chain of plain objects
 * out of a context is `false` to `instanceof Object` at every level on host Node 24.15 and stopped
 * being so here at the ninth. Cycles are not what this bounds -- the `seen`/`twins` guard is -- so
 * what it stands for is the recursion of one rebuild, and the cap on values below bounds that too.
 */
const REALM_MAX_DEPTH = 64;
/**
 * How many rebuilt values one process holds at once: past this the oldest are retired rather than
 * pinning memory, and a single rebuild that would pass it crosses as it is.
 *
 * A rebuilt value is pinned for as long as the binding is, so that it is still there when the
 * binding is unbound. QuickJS counts references, though: a value the guest has dropped needs no pin,
 * and a pin given up over one the guest still reaches frees nothing -- `JS_FreeValue` on a value
 * with a reference left is a count, not a free. So the oldest half is retired when the cap is
 * reached, which is what keeps a long-lived process rebuilding every value it ever sees instead of
 * every value it saw first.
 */
const REALM_MAX_VALUES = 16384;

/**
 * How many values a process remembers the twin of: past this the oldest half is forgotten, and a
 * value the context hands back after that is rebuilt again rather than recognized.
 *
 * Recognising a value is what gives a context back its identity -- host Node hands the very object
 * the context made to the caller every time, so `vm.runInContext('h.o', ctx)` twice is one object
 * -- and the memory is a `WeakMap`, so an entry whose source the guest has dropped goes with it.
 */
const REALM_MAX_REMEMBERED = 4096;

/**
 * The `Object.prototype.toString` tags a function crosses under, and the typed array names, whose
 * rebuild is a copy of the bytes: everything else is left to the walk of an ordinary object.
 */
const REALM_FUNCTION_TAGS = ['[object Function]', '[object AsyncFunction]', '[object GeneratorFunction]',
    '[object AsyncGeneratorFunction]'];

const REALM_TYPED_ARRAYS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];

/**
 * The standard globals of the guest realm whose namesake in a second realm replaces it when one of
 * them is what crosses out of a `vm` context: `runInContext('Array')` is the context's own `Array`,
 * not the caller's, which is why host Node reports `false` for `runInContext('Array') === Array`.
 *
 * The names a second realm is *given* are these and the ones below: a context made here starts as a
 * bare realm of this engine's, and the standard globals host Node 24.15 hands a fresh context --
 * `Float16Array`, `Iterator`, `SuppressedError`, `WebAssembly`, the two disposable stacks -- are
 * its own polyfills' to supply, so each one the realm lacks is taken from the guest realm, and so
 * is every static the guest's copy carries that the realm's does not (`Array.fromAsync`,
 * `Error.captureStackTrace`, `Symbol.dispose`, `Math.sumPrecise`): a context here answers
 * `typeof WebAssembly` and `typeof Array.fromAsync` the way the guest realm does, as on the host.
 */
const REALM_BUILTINS = ['AggregateError', 'Array', 'ArrayBuffer', 'AsyncDisposableStack', 'Atomics',
    'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView', 'Date', 'DisposableStack',
    'Error', 'EvalError', 'FinalizationRegistry', 'Float16Array', 'Float32Array', 'Float64Array',
    'Function', 'Int16Array', 'Int32Array', 'Int8Array', 'Intl', 'Iterator', 'JSON', 'Map', 'Math',
    'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp',
    'Set', 'SharedArrayBuffer', 'String', 'SuppressedError', 'Symbol', 'SyntaxError', 'TypeError',
    'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'URIError', 'WeakMap',
    'WeakRef', 'WeakSet', 'WebAssembly'];

/** The ES globals of a second realm whose names the guest's `with` scope answers for. */
const REALM_ES_NAMES = ['Infinity', 'NaN', 'undefined', 'eval', 'isFinite', 'isNaN', 'parseFloat',
    'parseInt', 'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'escape',
    'unescape'].concat(REALM_BUILTINS);

/**
 * The one global this engine gives every context that host Node 24.15 does not give a fresh one:
 * `typeof InternalError` reads `undefined` inside a `vm` context there, so it is taken off.
 */
const REALM_ENGINE_ONLY = ['InternalError'];

/**
 * How the code of a `vm` context runs: as global code of the context's own realm.
 *
 * The sandbox is synced onto that realm's global object before the run and back onto the sandbox
 * after it, which is what host Node 24.15's own contextifying does: the sandbox is the context's
 * global object there, so a name the caller put in is a global of the context, and a global the code
 * makes -- a `var`, a `function`, an undeclared assignment -- is a property of the sandbox when the
 * run is over. A name neither of them knows is a ReferenceError of the context's realm, as it is on
 * the host.
 *
 * Global code is what makes the rest of it fall out rather than be emulated: a top-level `let`,
 * `const` or `class` binds in the realm's global lexical scope, so it is still there for the next
 * run of the same context (`vm.runInContext('let a = 1', c)` then `vm.runInContext('a', c)`), and a
 * second declaration of it is the SyntaxError the host reports, where an `eval` of the same code
 * would bind it for one run only. The compile is the realm's own, so the `filename` and the
 * `lineOffset` of a `Script` are what the frames of the error it throws name, and the interruption
 * of a `timeout` still reaches the guest as the uncatchable error this engine raises.
 */

/**
 * The rejection tracker the second realm gets, so a promise a `vm` context leaves unhandled is
 * still one the process reports.
 *
 * The realm has a `Promise` of its own -- it is a context -- so the tracker the guest installs
 * never sees the rejections built inside one. This is that tracker's shape in the realm's own
 * terms: every promise the realm builds goes through one subclass, and a rejection is handed to the
 * guest's `api.noteRejection` as a cell, which is where every other rejection of the process waits
 * to be reported. A handler attached later marks the cell handled, so only a rejection nothing
 * handled is reported.
 */
const REALM_REJECTION_SRC = '(function (note, record) {' +
    'var Native = Promise;' +
    'var CELLS = new WeakMap();' +
    'class Tracked extends Native {' +
    'constructor(executor) {' +
    /* 'new Promise()' with no resolver, or with one that is not a function: the synchronous
       TypeError node raises, and not a rejection. This subclass stands in for 'Promise' in the
       realm of a context and its constructor runs before the one under it, so without this the
       throw happened inside the 'try' below, became a rejection of a promise nobody was holding,
       and ended the process with exit 1 where host node 24.15 throws and exits 0. */
    'if (typeof executor !== "function") {' +
    'throw new TypeError("Promise resolver " + String(executor) + " is not a function"); }' +
    'var cell = { reason: undefined, rejected: false, handled: false, promise: null, domain: null,' +
    ' state: 0, value: undefined };' +
    'super(function (resolve, reject) {' +
    /* What a promise settles with is a slot no probe of this engine reaches, so `util.inspect` had
       nothing to read and printed `Promise { <pending> }` for a settled promise out of a context.
       The cell beside it keeps how it settled and with what, and the guest's record is handed both,
       which is the same record its own promises are in -- without the promise ever being an
       instance of the guest's constructor, which is what `instanceof Promise` asks and answers
       false for, as on the host. */
    'var onResolve = function (value) {' +
    /* What a promise settles with is the value the settling ends at, not the thenable it starts
       from: host node 24.15 prints 'Promise { 3 }' for 'Promise.resolve({ then: function (r)
       { r(3); } })' and 'Promise { 5 }' for 'new Promise(function (r) { r(Promise.resolve(5)); })'.
       A thenable is adopted by the engine alone -- it calls 'then' itself, and the value that call
       is handed reaches no wrapper -- so what is handed on here is a stand-in thenable of our own:
       it forwards the one call the engine makes and writes down what it was given. */
    'var then = undefined;' +
    'try { if (value !== null && (typeof value === "object" || typeof value === "function"))' +
    ' then = value.then; } catch (x) { then = undefined; }' +
    'if (typeof then !== "function") {' +
    'if (cell.state === 0) { cell.state = 1; cell.value = value; }' +
    'return resolve(value); }' +
    /* A thenable leaves the promise pending until the adoption ends: host node 24.15 prints
       'Promise { <pending> }' for 'Promise.resolve({ then: ... })' read before the microtask that
       runs 'then', so the cell is left open here and the stand-in below closes it. */
    'return resolve({ then: function (ok, bad) {' +
    'var wrote = function (how) { return function (inner) {' +
    'if (cell.state === 0 || cell.state === 1) { cell.state = how; cell.value = inner; }' +
    'return (how === 1 ? ok : bad)(inner); }; };' +
    'return then.call(value, wrote(1), wrote(2)); } }); };' +
    'var wrapped = function (reason) {' +
    'cell.rejected = true; cell.reason = reason;' +
    'if (cell.state === 0) { cell.state = 2; cell.value = reason; }' +
    'note(cell); reject(reason); };' +
    'try { executor(onResolve, wrapped); } catch (err) { wrapped(err); }' +
    '});' +
    'CELLS.set(this, cell);' +
    'cell.promise = this;' +
    'if (typeof record === "function") { try { record(this, cell); } catch (x) { } }' +
    '}' +
    '}' +
    'Object.defineProperty(Native, Symbol.species, { get: function () { return Tracked; }, configurable: true });' +
    '/* A promise of a context answers to the name Promise too: host node 24.15 reads Promise.name' +
    '   and Promise.reject(x).constructor.name both as Promise. */' +
    'Object.defineProperty(Tracked, "name", { value: "Promise", configurable: true });' +
    'Object.defineProperty(globalThis, "Promise", { value: Tracked, writable: true, configurable: true });' +
    'Object.defineProperty(Tracked, Symbol.hasInstance, { value: function (x) { return x instanceof Native; }, configurable: true });' +
    'var nativeThen = Native.prototype.then;' +
    'Native.prototype.then = function (onFulfilled, onRejected) {' +
    'if (typeof onRejected === "function" || typeof onFulfilled === "function") {' +
    'var cell = CELLS.get(this);' +
    'if (cell !== undefined) cell.handled = true;' +
    '}' +
    'return nativeThen.call(this, onFulfilled, onRejected);' +
    '};' +
    '})';

/**
 * The stack a `vm` context's own realm gives the errors it builds: the header host Node 24.15 opens
 * one with, and the frames of the caller's own realm behind it.
 *
 * This engine writes the frames alone and nothing in front of them, so `vm.runInNewContext('new
 * Error("x")').stack.split('\n')[0]` was a frame -- `    at <eval> (evalmachine.<anonymous>:1:10)` --
 * where host Node 24.15 answers `Error: x`. The guest realm has never had that problem: it wraps
 * each of the eight error constructors in one that puts the header on and takes this container's own
 * frames out, and a second realm is made without any of it, so the moment errors stopped being
 * copied on their way out of a context and began crossing as the context's own objects, every error
 * a context handed back carried the engine's stack and not the host's. This is that same wrapper in
 * a realm's own terms -- `guestFramesOf` of `guest/globals.ts`, which a second realm cannot reach
 * because it is a closure of a source this one never runs.
 *
 * The frames it takes out are the ones this container's bootstrap leaves on a stack that spans the
 * two realms -- `callCap`, `vmEval`, `runInRecord`, `vmGuarded`, `runScript`, `runInNewContext` --
 * and what it puts in their place is what host Node names there: the compile of a CommonJS body, the
 * load behind it and the entry that started the run. The frame of the code a context ran is named
 * after the eval that ran it by this engine and after the file alone by the host, so `<eval>` comes
 * off it too.
 */
const REALM_STACK_SRC = '(function () {' +
    'var NAMES = ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError",' +
    ' "URIError", "AggregateError"];' +
    'var BOOT = "owc-bootstrap.js:";' +
    'var CJS_MODULE_FRAMES = [' +
    '"    at Module._compile (node:internal/modules/cjs/loader:1830:14)",' +
    '"    at Object..js (node:internal/modules/cjs/loader:1961:10)",' +
    '"    at Module.load (node:internal/modules/cjs/loader:1553:32)",' +
    '"    at Module._load (node:internal/modules/cjs/loader:1355:12)",' +
    '"    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)"];' +
    'var CJS_MAIN_TAIL = [' +
    '"    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)",' +
    '"    at node:internal/main/run_main_module:33:47"];' +
    'var CJS_REQUIRE_TAIL = [' +
    '"    at Module.require (node:internal/modules/cjs/loader:1576:12)",' +
    '"    at require (node:internal/modules/helpers:153:16)"];' +
    'var CJS_CALL_FRAME = "    at call (native)";' +
    'var CONSTRUCT_FRAME = "    at construct (native)";' +
    'function isBootstrapFrame(text) {' +
    'return typeof text === "string" && text.indexOf(BOOT) >= 0; }' +
    'function anonymousFrameName(text) {' +
    'var parsed = /^(\\s*)at <anonymous> \\(([^)]+)\\)\\s*$/.exec(text);' +
    'if (parsed === null) return text;' +
    'if (parsed[2].charAt(0) !== "/") return text;' +
    'return parsed[1] + "at " + parsed[2]; }' +
    /* The frame of the code a context ran: this engine names it after the eval that ran it, and host
       node names it after the location alone. */
    'function evalFrameName(text) {' +
    'var parsed = /^(\\s*)at <eval> \\(([^)]+)\\)\\s*$/.exec(text);' +
    'return parsed === null ? text : parsed[1] + "at " + parsed[2]; }' +
    'function moduleFrameName(text) {' +
    'var parsed = /^(\\s*)at <anonymous> \\((.*)\\)\\s*$/.exec(text);' +
    'return parsed === null ? text : parsed[1] + "at Object.<anonymous> (" + parsed[2] + ")"; }' +
    'function framesOf(lines) {' +
    'var out = [];' +
    'var at = 0;' +
    'while (at < lines.length) {' +
    'var line = lines[at];' +
    'if (isBootstrapFrame(line)) { at++; continue; }' +
    'if (line === CJS_CALL_FRAME && at + 1 < lines.length && isBootstrapFrame(lines[at + 1])) {' +
    'var end = at + 1;' +
    'while (end < lines.length && isBootstrapFrame(lines[end])) end++;' +
    'var run = lines.slice(at + 1, end);' +
    'var main = false;' +
    'var asked = false;' +
    'for (var r = 0; r < run.length; r++) {' +
    'if (run[r].indexOf("    at runMain (") === 0) main = true;' +
    'if (run[r].indexOf("    at require (") === 0 || run[r].indexOf("    at requireFrom (") === 0) asked = true;' +
    '}' +
    'if (main || asked) {' +
    'if (out.length > 0) out[out.length - 1] = moduleFrameName(out[out.length - 1]);' +
    'var tail = main ? CJS_MAIN_TAIL : CJS_REQUIRE_TAIL;' +
    'for (var m = 0; m < CJS_MODULE_FRAMES.length; m++) out.push(CJS_MODULE_FRAMES[m]);' +
    'for (var t = 0; t < tail.length; t++) out.push(tail[t]);' +
    '}' +
    'at = end;' +
    'continue;' +
    '}' +
    'out.push(line);' +
    'at++;' +
    '}' +
    'for (var n = 0; n < out.length; n++) out[n] = evalFrameName(anonymousFrameName(out[n]));' +
    'return out; }' +
    'function headerOf(err) {' +
    'var name = "Error";' +
    'var message = "";' +
    'try {' +
    'name = String(err.name || "Error");' +
    'message = String(err.message === undefined || err.message === null ? "" : err.message);' +
    '} catch (ignored) { }' +
    'return message === "" ? name : name + ": " + message; }' +
    'function engineFrames(stack, ownFrame) {' +
    'var lines = typeof stack === "string" && stack !== "" ? stack.split("\\n") : [];' +
    'while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();' +
    'var at = 0;' +
    'while (at < lines.length && (lines[at] === CONSTRUCT_FRAME || lines[at] === ownFrame)) at++;' +
    'var out = framesOf(lines.slice(at));' +
    'var limit = Error.stackTraceLimit;' +
    'if (typeof limit !== "number") limit = 10;' +
    'if (limit >= 0 && out.length > limit) out = out.slice(0, limit);' +
    'return out.join("\\n"); }' +
    /* An assignment to `stack` is what the host's own is: the accessor is replaced by the value, so
       what is written is what is read and nothing put in front of it. */
    'function installStack(err, frames) {' +
    'var kept = null;' +
    'Object.defineProperty(err, "stack", {' +
    'get: function () {' +
    'if (kept !== null) return kept;' +
    'var header = headerOf(err);' +
    'kept = frames === "" ? header : (frames.indexOf(header) === 0 ? frames : header + "\\n" + frames);' +
    'return kept; },' +
    'set: function (value) {' +
    'Object.defineProperty(err, "stack", { value: value, writable: true, enumerable: false, configurable: true }); },' +
    'enumerable: false,' +
    'configurable: true' +
    '}); }' +
    'function install(name) {' +
    'var Native = globalThis[name];' +
    'if (typeof Native !== "function") return;' +
    'if (typeof Reflect === "undefined" || typeof Reflect.construct !== "function") return;' +
    'var ownFrame = null;' +
    'function Shim() {' +
    'var err = Reflect.construct(Native, arguments, new.target === undefined ? Shim : new.target);' +
    'var raw = err.stack;' +
    'if (ownFrame === null) {' +
    'var built = typeof raw === "string" && raw !== "" ? raw.split("\\n") : [];' +
    'ownFrame = built.length > 1 ? built[1] : "";' +
    '}' +
    'installStack(err, engineFrames(raw, ownFrame));' +
    'return err; }' +
    'Shim.prototype = Native.prototype;' +
    'Object.defineProperty(Shim, "name", { value: name, configurable: true });' +
    'Object.defineProperty(Shim, "length", { value: Native.length, configurable: true });' +
    'Object.defineProperty(Shim, "toString", {' +
    'value: function () { return "function " + name + "() { [native code] }"; },' +
    'writable: true, enumerable: false, configurable: true });' +
    'var statics = Object.getOwnPropertyNames(Native);' +
    'for (var s = 0; s < statics.length; s++) {' +
    'if (statics[s] === "length" || statics[s] === "name" || statics[s] === "prototype") continue;' +
    'Object.defineProperty(Shim, statics[s], Object.getOwnPropertyDescriptor(Native, statics[s]));' +
    '}' +
    /* err.constructor === Error is asked as often as err instanceof Error is, and the prototype the
       instances keep is still the engine's own, so it is its constructor that names the wrapper. */
    'Object.defineProperty(Native.prototype, "constructor",' +
    ' { value: Shim, writable: true, enumerable: false, configurable: true });' +
    'try { globalThis[name] = Shim; } catch (x) { }' +
    '}' +
    'for (var i = 0; i < NAMES.length; i++) install(NAMES[i]);' +
    '})';

/**
 * The standard globals a second realm is given the guest realm's own object for, outright, rather
 * than its own namesake with the guest's statics copied onto it.
 *
 * These two are the ones whose *identity* is the thing: both keep a record in the guest realm of
 * what they have made -- `Proxy` of every proxy, `Promise` of what every promise settled with --
 * and that record is the only answer this engine has to `util.types.isProxy` and to the value a
 * promise settled with, neither of which any probe of any realm can name. Handing the realm its
 * own `Proxy` instead left every proxy a context made unrecorded, so `util.types.isProxy` read
 * false where host Node 24.15 reads true.
 *
 * `Promise` is the exception that proves the rule and is not taken: a promise of the guest's own
 * constructor is an instance of it, so `runInNewContext('Promise.resolve(1)') instanceof Promise`
 * answered true the moment the realm was given that constructor, where host Node 24.15 answers
 * false. What the realm gets instead is its own `Promise` wrapped by its own tracker, which hands
 * what it settles with to the guest's record without ever being an instance of the guest's.
 */
const REALM_WHOLE = ['Proxy'];

/** Dotted paths a second realm is *without* because host Node 24.15 is: see {@link bridgeGlobals}. */
const REALM_GONE_STATICS = ['Math.sumPrecise'];

/** `Array.isArray`, `Object.prototype.toString`, `Object.getOwnPropertyNames` and `Object.prototype`, once. */
interface VmProbes {
    /** `Object` itself, the `this` of `Object.getOwnPropertyNames`. */
    object: QuickJSHandle;
    /** `Object.getOwnPropertyNames`: every own string key, enumerable or not. */
    names: QuickJSHandle;
    /** `Object.getOwnPropertySymbols`: every own symbol key, which cross as handles, not as text. */
    symbols: QuickJSHandle;
    isArray: QuickJSHandle;
    tag: QuickJSHandle;
    objectProto: QuickJSHandle;
}

const hosts = new WeakMap<CapabilityContext, VmHost>();

/**
 * Installs the interrupt handler on a runtime and binds it to the owning process. Call once per
 * runtime, after the bootstrap has produced its API object. With nothing armed the handler does one
 * comparison per interrupt check.
 */
export function bindVmRuntime(owner: CapabilityContext, runtime: QuickJSRuntime, context: QuickJSContext, api: QuickJSHandle): void {
    const host: VmHost = {
        runtime,
        context,
        api,
        realms: new Map(),
        realmValues: [],
        memo: [],
        deadline: 0,
        fired: false,
        cancelled: false,
        budgetMs: 0,
        sliceStart: 0,
        lastCheck: 0
    };
    hosts.set(owner, host);
    runtime.setInterruptHandler(() => {
        const now = Date.now();
        if (host.cancelled) {
            host.reason = 'cancel';
            return true;
        }
        if (host.deadline !== 0 && now >= host.deadline) {
            host.fired = true;
            host.reason = 'vm';
            return true;
        }
        if (host.budgetMs > 0) {
            if (host.sliceStart === 0 || host.lastCheck === 0 || now - host.lastCheck > YIELD_MS) {
                host.sliceStart = now;
            }
            host.lastCheck = now;
            if (now - host.sliceStart >= host.budgetMs) {
                host.fired = true;
                host.reason = 'budget';
                return true;
            }
        }
        return false;
    });
}

/**
 * Arms the runaway guard for a process: guest execution that runs longer than `ms` without calling
 * the host is interrupted. 0 disarms it. Called once per runtime, after bindVmRuntime.
 */
export function armVmBudget(owner: CapabilityContext, ms: number): void {
    const host = hosts.get(owner);
    if (!host) return;
    host.budgetMs = ms > 0 ? ms : 0;
    host.sliceStart = 0;
    host.lastCheck = 0;
}

/**
 * Drops the binding {@link bindVmRuntime} made for a runtime: its guest is gone.
 *
 * A WeakMap entry lives as long as its key does, so the binding held the guest context -- and
 * through it the runtime and the QuickJS module the engine runs in, about 30 MB of host external
 * memory -- for as long as anything still reached the capability context, which the container's
 * process table does for every process it has ever run. Unbinding is what lets that go.
 */
export function unbindVmRuntime(owner: CapabilityContext): void {
    const host = hosts.get(owner);
    hosts.delete(owner);
    if (!host) return;
    /* The second realm and every value rebuilt in it belong to this binding: they are freed here,
       before the process frees the context around them, or the runtime asserts on what is left. */
    for (const handle of host.realmValues) {
        try {
            handle.dispose();
        } catch {
            // a handle already gone is nothing to report
        }
    }
    host.realmValues = [];
    for (const pair of host.memo) {
        try {
            pair.src.dispose();
        } catch {
            // a handle already gone is nothing to report
        }
        try {
            pair.twin.dispose();
        } catch {
            // as above
        }
    }
    host.memo = [];
    if (host.twins !== undefined) {
        try {
            host.twins.dispose();
        } catch {
            // as above
        }
        host.twins = undefined;
    }
    for (const realm of host.realms.values()) disposeRealm(realm);
    host.realms.clear();
    if (host.proxyTest !== undefined) {
        try {
            host.proxyTest.dispose();
        } catch {
            // as above
        }
        host.proxyTest = undefined;
    }
    if (host.proxyCtor !== undefined) {
        try {
            host.proxyCtor.dispose();
        } catch {
            // as above
        }
        host.proxyCtor = undefined;
    }
    if (host.probes !== undefined) {
        for (const handle of [host.probes.object, host.probes.names, host.probes.symbols,
            host.probes.isArray, host.probes.tag, host.probes.objectProto]) {
            try {
                handle.dispose();
            } catch {
                // as above
            }
        }
        host.probes = undefined;
    }
}

/** Frees one second realm and every handle of the binding that was built inside it. */
function disposeRealm(realm: VmRealm): void {
    for (const handle of [realm.noteFn, realm.recordFn, realm.rehomeFn, realm.namesFn, realm.defineFn,
        ...(realm.builtins === undefined ? [] : [...realm.builtins.from, ...realm.builtins.to])]) {
        if (handle === undefined) continue;
        try {
            handle.dispose();
        } catch {
            // a handle already gone is nothing to report
        }
    }
    realm.noteFn = undefined;
    realm.recordFn = undefined;
    realm.rehomeFn = undefined;
    realm.namesFn = undefined;
    realm.defineFn = undefined;
    realm.builtins = undefined;
    try {
        realm.ctx.dispose();
    } catch {
        // as above
    }
}

/** A kill path: the guest stops at its next interrupt check, whatever it is doing. */
export function cancelVmRuntime(owner: CapabilityContext): void {
    const host = hosts.get(owner);
    if (host) host.cancelled = true;
}

/**
 * The guest gave the host back control -- a host call, an await, a step of the event loop -- so the
 * stretch the budget bounds starts again. Without this a program that works in short bursts towards
 * the host would be charged for the whole run and stopped mid-way through it.
 */
export function yieldVmSlice(owner: CapabilityContext): void {
    const host = hosts.get(owner);
    if (!host) return;
    host.sliceStart = 0;
    host.lastCheck = 0;
}

/** Reads and clears why the guest was interrupted, so one interruption is reported once. */
export function takeVmInterruption(owner: CapabilityContext): VmInterruption | undefined {
    const host = hosts.get(owner);
    if (!host) return undefined;
    const reason = host.reason;
    host.reason = undefined;
    return reason;
}

/** The `vm` context a capability was called for: the guest numbers them, one number per context. */
function realmIdOf(args: Record<string, unknown>): number {
    const id = Number(args.id);
    return Number.isFinite(id) ? id : 0;
}

function describeError(error: unknown): string {
    if (error !== null && typeof error === 'object' && 'message' in error) {
        return String((error as { message: unknown }).message);
    }
    return String(error);
}

/**
 * The realm of one `vm` context, made the first time that context runs code or hands a value out,
 * or undefined when it cannot be made. `id` is the context's own, which the guest numbers.
 *
 * A `vm` context's code runs here, so the realm is given the process's rejection tracker before
 * anything runs in it: a promise the context leaves unhandled is otherwise one this process never
 * hears about, where host Node 24.15 reports it. It is given the standard globals the guest realm
 * has and it does not, so that a context here answers for the same names the guest's own code does.
 */
function realmFor(host: VmHost, id: number): VmRealm | undefined {
    const found = host.realms.get(id);
    if (found !== undefined) return found;
    try {
        const ctx = host.runtime.newContext();
        const realm: VmRealm = { ctx, base: new Set<string>(), held: new Set<string>(), injected: new Set<string>() };
        host.realms.set(id, realm);
        bridgeGlobals(host, realm);
        installStacks(realm);
        installRejections(host, realm);
        /* The intrinsics of the realm as it stands -- the bridged names with them -- are what a run
           may add to and is never asked to hand back to the sandbox. */
        for (const name of realmNames(host, realm)) realm.base.add(name);
        return realm;
    } catch {
        return undefined;
    }
}

/**
 * Gives a freshly made realm the standard globals the guest realm carries that it does not, and the
 * statics the guest's copies carry that its own do not: see {@link REALM_BUILTINS}.
 *
 * A context here starts as a bare realm of this engine's, which is short of host Node 24.15's own
 * surface in the places the guest realm has already been brought up to it -- `WebAssembly`,
 * `SuppressedError`, `Array.fromAsync`, `Error.captureStackTrace`, `Symbol.dispose` -- and short of
 * nothing else, so only what it lacks is taken. A static is copied by value where the guest's is a
 * plain one (`Error.stackTraceLimit`, `RegExp.input`) and by reference where it is a function, which
 * is then a function of the guest realm called on objects of this one, as a polyfill of Node's is.
 */
function bridgeGlobals(host: VmHost, realm: VmRealm): void {
    const { context } = host;
    try {
        const built = realm.ctx.evalCode(
            '(function (src, both) {' +
            'var names = both[0];' +
            'var gone = both[1];' +
            'var whole = both[2];' +
            'var off = both[3];' +
            'for (var j = 0; j < gone.length; j++) {' +
            'try { delete globalThis[gone[j]]; } catch (x) { }' +
            '}' +
            /* A static the engine carries and host Node 24.15 does not: `Math.sumPrecise`, which
               QuickJS has and V8 does not. The realm is given the guest's statics but not the
               guest's *absence* of one, so a name the guest does not carry has to come off here
               too, or `typeof Math.sumPrecise` answers `function` inside a context and `undefined`
               outside it. */
            'for (var g = 0; g < off.length; g++) {' +
            'var path = off[g].split(".");' +
            'var at = globalThis;' +
            'for (var p = 0; p < path.length - 1 && at !== undefined && at !== null; p++) at = at[path[p]];' +
            'if (at !== undefined && at !== null) { try { delete at[path[path.length - 1]]; } catch (x) { } }' +
            '}' +
            'for (var w = 0; w < whole.length; w++) {' +
            'if (src[whole[w]] === undefined) continue;' +
            'try { Object.defineProperty(globalThis, whole[w], { value: src[whole[w]], writable: true, enumerable: false, configurable: true }); } catch (x) { }' +
            '}' +
            'for (var i = 0; i < names.length; i++) {' +
            'var n = names[i];' +
            'if (whole.indexOf(n) >= 0) continue;' +
            'var s = src[n];' +
            'if (s === undefined) continue;' +
            'if (!Object.prototype.hasOwnProperty.call(globalThis, n)) {' +
            /* Not a plain assignment: that leaves the name enumerable, and host node 24.15 answers
               '[]' for 'Object.keys(globalThis)' inside a context -- every global a context is
               given beyond the ones the engine built is one Node's own global object does not
               enumerate, so a bridged name has to carry 'enumerable: false' as it arrives. */
            'try { Object.defineProperty(globalThis, n, { value: s, writable: true, enumerable: false, configurable: true }); } catch (x) { }' +
            'continue;' +
            '}' +
            'var d = globalThis[n];' +
            'if (d === null || (typeof d !== "object" && typeof d !== "function")) continue;' +
            'if (s === null || (typeof s !== "object" && typeof s !== "function")) continue;' +
            'var keys = Object.getOwnPropertyNames(s);' +
            'for (var k = 0; k < keys.length; k++) {' +
            'var key = keys[k];' +
            'if (key === "name" || key === "length" || key === "prototype") continue;' +
            'if (Object.prototype.hasOwnProperty.call(d, key)) continue;' +
            'try { d[key] = s[key]; } catch (x) { }' +
            '}' +
            '}' +
            '})'
        );
        if (built.error) {
            built.error.dispose();
            return;
        }
        const bridge = realm.ctx.unwrapResult(built);
        const names = realm.ctx.unwrapResult(
            realm.ctx.evalCode(JSON.stringify([REALM_ES_NAMES.concat(REALM_ENGINE_ONLY), REALM_ENGINE_ONLY, REALM_WHOLE, REALM_GONE_STATICS]))
        );
        const result = realm.ctx.callFunction(bridge, realm.ctx.undefined, [context.global, names]);
        names.dispose();
        bridge.dispose();
        if (result.error) result.error.dispose();
        else result.value.dispose();
    } catch {
        // a realm short of a global still runs the code of a context
    }
}

/**
 * `delete target[key]`, in whichever context `target` belongs to: this engine's context API has no
 * delete of its own, and a name the sandbox no longer carries has to come off the realm's global
 * object with it -- on host Node 24.15 the sandbox *is* that global object, so there is nothing to
 * take off anywhere else.
 */
function deleteKey(ctx: QuickJSContext, target: QuickJSHandle, key: string): void {
    try {
        const built = ctx.evalCode('(function (o, k) { try { delete o[k]; } catch (x) { } })');
        if (built.error) {
            built.error.dispose();
            return;
        }
        const fn = ctx.unwrapResult(built);
        const name = ctx.newString(key);
        const result = ctx.callFunction(fn, ctx.undefined, [target, name]);
        name.dispose();
        fn.dispose();
        if (result.error) result.error.dispose();
        else result.value.dispose();
    } catch {
        // a name that will not come off still leaves the rest of the sync intact
    }
}

/**
 * `Object.defineProperty(globalThis, key, { value, writable: true, enumerable: false, configurable: true })`,
 * in the realm's own terms: how a name a `vm` context is *given* arrives at its global object.
 *
 * Not the context API's own `defineProp`, whose descriptor carries no `writable` -- it is typed out
 * of the object and the engine leaves it off, so the property it makes is read-only -- where host
 * Node 24.15 answers `writable: true` for every global it hands a context, `console` among them.
 */
function defineHidden(realm: VmRealm, key: string, value: QuickJSHandle): void {
    try {
        if (realm.defineFn === undefined) {
            const built = realm.ctx.evalCode(
                '(function (k, v) {' +
                'Object.defineProperty(globalThis, k,' +
                ' { value: v, writable: true, enumerable: false, configurable: true });' +
                '})'
            );
            if (built.error) {
                built.error.dispose();
                return;
            }
            realm.defineFn = realm.ctx.unwrapResult(built);
        }
        const name = realm.ctx.newString(key);
        const result = realm.ctx.callFunction(realm.defineFn, realm.ctx.undefined, [name, value]);
        name.dispose();
        if (result.error) result.error.dispose();
        else result.value.dispose();
    } catch {
        // a global the realm will not take still leaves the run intact
    }
}

/**
 * Gives a freshly made second realm the wrapper its errors need: see {@link REALM_STACK_SRC}.
 *
 * It runs after {@link bridgeGlobals}, which is what hands the realm the statics the guest's own
 * error constructors carry -- `captureStackTrace` and `stackTraceLimit` among them -- so that the
 * wrapper built here is given those to hand on and the errors a context makes answer for them as
 * the guest's own do.
 */
function installStacks(realm: VmRealm): void {
    try {
        const built = realm.ctx.evalCode(REALM_STACK_SRC);
        if (built.error) {
            built.error.dispose();
            return;
        }
        const installer = realm.ctx.unwrapResult(built);
        const result = realm.ctx.callFunction(installer, realm.ctx.global, []);
        installer.dispose();
        if (result.error) result.error.dispose();
        else result.value.dispose();
    } catch {
        // an error that keeps the engine's own stack still carries its name, message and frames
    }
}

/** The own string names of a realm's global object, read inside it. */
function realmNames(host: VmHost, realm: VmRealm): string[] {
    try {
        if (realm.namesFn === undefined) {
            const built = realm.ctx.evalCode('(function () { return Object.getOwnPropertyNames(globalThis); })');
            if (built.error) {
                built.error.dispose();
                return [];
            }
            realm.namesFn = realm.ctx.unwrapResult(built);
        }
        const result = realm.ctx.callFunction(realm.namesFn, realm.ctx.global, []);
        if (result.error) {
            result.error.dispose();
            return [];
        }
        const names = host.context.dump(result.value);
        result.value.dispose();
        return Array.isArray(names) ? names.map((name) => String(name)) : [];
    } catch {
        return [];
    }
}

/**
 * Puts the sandbox of a `vm` context onto its realm's global object before a run: the context's
 * globals are the sandbox's, as they are on host Node 24.15, where the sandbox *is* the global
 * object of the context and not a scope around it.
 *
 * A name the sandbox no longer carries is taken off the global object with it, so a property the
 * caller drops between two runs is gone inside the context too.
 */
function syncIn(host: VmHost, realm: VmRealm, sandbox: QuickJSHandle): void {
    const { context } = host;
    const seen = new Set<string>();
    try {
        for (const key of ownKeysOf(host, sandbox)) {
            const value = context.getProp(sandbox, key);
            realm.ctx.setProp(realm.ctx.global, key, value);
            value.dispose();
            if (typeof key === 'string') {
                seen.add(key);
                realm.held.add(key);
            }
        }
        for (const held of [...realm.held]) {
            if (seen.has(held)) continue;
            realm.held.delete(held);
            deleteKey(realm.ctx, realm.ctx.global, held);
        }
    } catch {
        // a sandbox that cannot be read leaves the realm's globals as the last run left them
    }
}

/**
 * Puts a realm's global object back onto the sandbox after a run: everything the code made a global
 * of -- a `var`, a `function`, an undeclared assignment -- is a property of the sandbox on host Node
 * 24.15, and a name the code deleted is off it.
 *
 * The intrinsics of the realm and the names this container put there itself stay out of it, which is
 * the difference between a global the context made and one it was born with: `Object.keys` of a
 * sandbox reads the assignment a script made on host Node 24.15 and not `Array`.
 */
function syncOut(host: VmHost, realm: VmRealm, sandbox: QuickJSHandle): void {
    const { context } = host;
    const names = realmNames(host, realm);
    const present = new Set<string>();
    try {
        for (const name of names) {
            if (realm.base.has(name) || realm.injected.has(name)) continue;
            const value = realm.ctx.getProp(realm.ctx.global, name);
            context.setProp(sandbox, name, value);
            value.dispose();
            present.add(name);
            realm.held.add(name);
        }
        for (const held of [...realm.held]) {
            if (present.has(held)) continue;
            realm.held.delete(held);
            deleteKey(context, sandbox, held);
        }
    } catch {
        // a realm whose globals cannot be read leaves the sandbox as the run found it
    }
}

/**
 * Gives a freshly made second realm the process's rejection tracker, whose cells are handed to the
 * guest's `api.noteRejection`.
 */
function installRejections(host: VmHost, realm: VmRealm): void {
    const ctx = realm.ctx;
    try {
        const built = ctx.evalCode(REALM_REJECTION_SRC);
        if (built.error) {
            built.error.dispose();
            return;
        }
        const installer = ctx.unwrapResult(built);
        const note = host.context.newFunction('noteRejection', (cell) => {
            try {
                const fn = host.context.getProp(host.api, 'noteRejection');
                if (host.context.typeof(fn) !== 'function') {
                    fn.dispose();
                    return host.context.undefined;
                }
                const result = host.context.callFunction(fn, host.api, [cell]);
                fn.dispose();
                if (result.error) result.error.dispose();
                else result.value.dispose();
            } catch {
                // a rejection the tracker will not take is still not a reason to lose the run
            }
            return host.context.undefined;
        });
        realm.noteFn = note;
        /* The record the guest keeps of what a promise settled with, handed to the realm's tracker:
           a cell of this realm's, keyed in the guest's WeakMap by the promise it belongs to. */
        let record: QuickJSHandle | undefined;
        try {
            const fn = host.context.getProp(host.context.global, '__owcNotePromise');
            if (host.context.typeof(fn) === 'function') record = fn;
            else fn.dispose();
        } catch {
            record = undefined;
        }
        realm.recordFn = record;
        const args: QuickJSHandle[] = [note];
        if (record !== undefined) args.push(record);
        const result = ctx.callFunction(installer, ctx.undefined, args);
        installer.dispose();
        if (result.error) result.error.dispose();
        else result.value.dispose();
    } catch {
        // a realm with an untracked Promise still runs the code of a context
    }
}

/**
 * The twin `value` was rebuilt as the last time this context handed it back, or undefined the first
 * time -- and undefined again once the pair has been forgotten, or the value cannot be a `WeakMap`
 * key at all (a primitive, or one the guest has already dropped).
 *
 * This is what gives a `vm` context back the identity a rebuild costs it: host Node hands the caller
 * the very object the context made, so `vm.runInContext('h.o', ctx)` twice is one object there, a
 * `set(3,4)` on one seen by the other, and one twin for both runs is the same answer. Only the value
 * a run hands back whole is remembered -- the walk of one value still keeps its own `seen`/`twins`
 * guard, so a cycle or a value reached twice inside one rebuild is one twin there as it was.
 */
function twinOf(host: VmHost, value: QuickJSHandle): QuickJSHandle | undefined {
    const twins = twinsOf(host);
    if (twins === undefined) return undefined;
    try {
        const result = host.context.callMethod(twins, 'get', [value]);
        if (result.error) {
            result.error.dispose();
            return undefined;
        }
        const got = result.value;
        if (host.context.typeof(got) === 'undefined') {
            got.dispose();
            return undefined;
        }
        return got;
    } catch {
        return undefined;
    }
}

/** Remembers the twin `value` was rebuilt as, forgetting the oldest half once the cap is reached. */
function remember(host: VmHost, value: QuickJSHandle, twin: QuickJSHandle): void {
    const twins = twinsOf(host);
    if (twins === undefined) return;
    try {
        const result = host.context.callMethod(twins, 'set', [value, twin]);
        if (result.error) result.error.dispose();
        else result.value.dispose();
        host.memo.push({ src: value.dup(), twin: twin.dup() });
    } catch {
        return;
    }
    if (host.memo.length < REALM_MAX_REMEMBERED) return;
    for (const old of host.memo.splice(0, Math.floor(REALM_MAX_REMEMBERED / 2))) {
        try {
            old.src.dispose();
        } catch {
            // a handle already gone is nothing to report
        }
        try {
            old.twin.dispose();
        } catch {
            // as above
        }
    }
}

/** A `WeakMap` of the guest realm the twins are remembered in, made once, or undefined if it cannot be. */
function twinsOf(host: VmHost): QuickJSHandle | undefined {
    if (host.twins !== undefined) return host.twins;
    try {
        const built = host.context.evalCode('new WeakMap()');
        if (built.error) {
            built.error.dispose();
            return undefined;
        }
        host.twins = host.context.unwrapResult(built);
        return host.twins;
    } catch {
        return undefined;
    }
}

/** `Array.isArray`, `Object.prototype.toString` and `Object.prototype` of the guest realm, once. */
function probesOf(host: VmHost): VmProbes {
    if (host.probes !== undefined) return host.probes;
    const { context } = host;
    const global = context.global;
    const array = context.getProp(global, 'Array');
    const object = context.getProp(global, 'Object');
    const objectProto = context.getProp(object, 'prototype');
    const probes: VmProbes = {
        object,
        names: context.getProp(object, 'getOwnPropertyNames'),
        symbols: context.getProp(object, 'getOwnPropertySymbols'),
        isArray: context.getProp(array, 'isArray'),
        tag: context.getProp(objectProto, 'toString'),
        objectProto
    };
    array.dispose();
    host.probes = probes;
    return probes;
}

/** Calls `fn.call(thisArg, ...args)` in the guest realm and dumps the answer, or undefined if it throws. */
function callFor(host: VmHost, fn: QuickJSHandle, thisArg: QuickJSHandle, args: QuickJSHandle[]): unknown {
    const result = host.context.callFunction(fn, thisArg, args);
    if (result.error) {
        result.error.dispose();
        return undefined;
    }
    const answer = host.context.dump(result.value);
    result.value.dispose();
    return answer;
}

/**
 * The namesake of `value` in the second realm, when `value` is one of the guest realm's own standard
 * globals: the context's `Array` is its own, so that is the one a program gets back from it.
 */
function builtinOf(host: VmHost, realm: VmRealm, value: QuickJSHandle): QuickJSHandle | undefined {
    const ctx = realm.ctx;
    if (realm.builtins === undefined) {
        const from: QuickJSHandle[] = [];
        const to: QuickJSHandle[] = [];
        const { context } = host;
        for (const name of REALM_BUILTINS) {
            const ofGuest = context.getProp(context.global, name);
            const ofRealm = ctx.getProp(ctx.global, name);
            from.push(ofGuest);
            to.push(ofRealm);
        }
        realm.builtins = { from, to };
    }
    const { from, to } = realm.builtins;
    for (let i = 0; i < from.length; i++) {
        if (host.context.eq(from[i], value)) return to[i];
    }
    return undefined;
}

/**
 * Whether `value` is a proxy: the one question only the realm that made it can answer, since no
 * probe of any realm -- a tag, a prototype, an own name -- tells a proxy from the object it wraps.
 * The guest realm keeps the record (see `util.types.isProxy`), so it is asked here.
 */
function isProxyValue(host: VmHost, value: QuickJSHandle): boolean {
    try {
        if (host.proxyTest === undefined) {
            const built = host.context.evalCode(
                '(function (v) { return typeof __owcIsProxy === "function" ? __owcIsProxy(v) === true : false; })'
            );
            if (built.error) {
                built.error.dispose();
                return false;
            }
            host.proxyTest = host.context.unwrapResult(built);
        }
        const result = host.context.callFunction(host.proxyTest, host.context.undefined, [value]);
        if (result.error) {
            result.error.dispose();
            return false;
        }
        const answer = host.context.dump(result.value) === true;
        result.value.dispose();
        return answer;
    } catch {
        return false;
    }
}

/**
 * `value` wrapped in a proxy of the second realm, built through the guest realm's own `Proxy` so
 * that the record that realm keeps -- and `util.types.isProxy` with it -- names it too.
 */
function proxyOf(host: VmHost, realm: VmRealm, value: QuickJSHandle): QuickJSHandle | undefined {
    const ctx = realm.ctx;
    const { context } = host;
    try {
        if (host.proxyCtor === undefined) host.proxyCtor = context.getProp(context.global, 'Proxy');
        const object = ctx.getProp(ctx.global, 'Object');
        const objectProto = ctx.getProp(object, 'prototype');
        const built = ctx.evalCode(
            '(function (orig, proto, P) {' +
            'return new P(orig, { getPrototypeOf: function () { return proto; } });' +
            '})'
        );
        object.dispose();
        if (built.error) {
            built.error.dispose();
            objectProto.dispose();
            return undefined;
        }
        const bridge = context.unwrapResult(built);
        const result = ctx.callFunction(bridge, ctx.undefined, [value, objectProto, host.proxyCtor]);
        bridge.dispose();
        objectProto.dispose();
        if (result.error) {
            result.error.dispose();
            return undefined;
        }
        return context.unwrapResult(result);
    } catch {
        return undefined;
    }
}

/** Calls `value[name]()` in the guest realm and dumps the answer, or undefined if it throws. */
function methodDump(host: VmHost, value: QuickJSHandle, name: string): unknown {
    const result = host.context.callMethod(value, name, []);
    if (result.error) {
        result.error.dispose();
        return undefined;
    }
    const answer = host.context.dump(result.value);
    result.value.dispose();
    return answer;
}

/**
 * Rebuilds `value` inside the second realm, so that what the guest gets back from a `vm` context is
 * an object of another realm -- `instanceof Array` and `instanceof Object` false, `Array.isArray`
 * true, `Object.prototype.toString.call` still `[object Array]`, which is what host Node 24.15
 * reports for the same probe.
 *
 * Arrays, plain objects, `Date`s, `RegExp`s, errors, `Map`s, `Set`s, promises, `WeakMap`s,
 * `WeakSet`s, `ArrayBuffer`s, typed arrays and functions are rebuilt. A class instance keeps the
 * name of its constructor. Everything else crosses as it is. A value too deep, a cycle, or one past
 * the cap on rebuilt values also crosses as it is, so nothing here can grow without bound or loop.
 */
function rehomeInto(
    host: VmHost,
    realm: VmRealm,
    value: QuickJSHandle,
    depth: number,
    seen: QuickJSHandle[],
    twins: QuickJSHandle[],
    kept: QuickJSHandle[]
): QuickJSHandle {
    const { context } = host;
    const ctx = realm.ctx;
    if (host.realmValues.length >= REALM_MAX_VALUES) return value;
    const builtin = builtinOf(host, realm, value);
    if (builtin !== undefined) return builtin;
    /* A function is an object to every probe below but not to `typeof`, and it is the one object a
       context hands back whose rebuild has to keep working rather than only reading. */
    const kind = context.typeof(value);
    if (kind !== 'object' && kind !== 'function') return value;
    if (depth >= REALM_MAX_DEPTH) return value;
    /* A proxy is the one value no probe of either realm can name -- this engine answers nothing
       about one -- so what says an object is a proxy is the record the guest realm keeps of the
       proxies it made. The rebuild wraps the original in a proxy of the second realm whose
       `getPrototypeOf` answers that realm's `Object.prototype`: every other trap still reaches the
       original, so the proxy behaves as it did, while `instanceof Object` reads false and
       `util.types.isProxy` reads true, which is what host Node 24.15 reports for a proxy a context
       hands back. */
    if (isProxyValue(host, value)) {
        const wrapped = proxyOf(host, realm, value);
        if (wrapped !== undefined) return pin(host, wrapped);
    }
    for (let i = 0; i < seen.length; i++) {
        if (context.eq(seen[i], value)) return twins[i];
    }
    const probes = probesOf(host);
    /* `Object.prototype.toString.call(value)`: the value is what `this` has to be, not an argument. */
    const tag = String(callFor(host, probes.tag, value, []) ?? '');
    const isArray = callFor(host, probes.isArray, context.undefined, [value]) === true;
    let made: QuickJSHandle;
    try {
        if (isArray) {
            made = ctx.newArray();
            /* An instance of a class that extends a host's own `Array` is an array to every probe --
               `Array.isArray` and the `[object Array]` tag both say so -- but it still answers the
               name of its class, not `Array`, to `o.constructor.name` on host Node 24.15. */
            const arrayCtor = ctorNameOf(host, value);
            if (arrayCtor !== undefined && arrayCtor !== 'Array' && arrayCtor !== 'Object') {
                nameAfter(host, realm, made, arrayCtor);
            }
        } else if (tag === '[object Object]') {
            made = ctx.newObject();
            /* A class instance: `class C {}` out of a context still answers `C` to
               `o.constructor.name` on host Node 24.15, which a bare object of the second realm would
               answer `Object` to. The class itself is the one thing that cannot cross -- its body was
               compiled in the context's realm -- so the rebuild is given a constructor of that name,
               the way an `Error` subclass already was, and keeps the class's own properties. */
            const ctor = ctorNameOf(host, value);
            if (ctor !== undefined && ctor !== 'Object') nameAfter(host, realm, made, ctor);
        } else if (tag === '[object Date]') {
            const ms = Number(methodDump(host, value, 'getTime'));
            return pin(host, context.unwrapResult(ctx.evalCode(`new Date(${Number.isFinite(ms) ? ms : 0})`)));
        } else if (tag === '[object RegExp]') {
            const source = String(propDump(host, value, 'source') ?? '');
            const flags = String(propDump(host, value, 'flags') ?? '');
            return pin(host, context.unwrapResult(ctx.evalCode(`new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)})`)));
        } else if (tag === '[object Error]') {
            /* An error is the one ordinary object a context shares with the caller in host Node --
               it is of the context's realm, so `instanceof Error` is false outside it -- and the
               same is true of every value the caller reads off one: `err.cause`, `err.errors`. */
            const name = typeof propDump(host, value, 'name') === 'string'
                ? String(propDump(host, value, 'name'))
                : 'Error';
            const message = typeof propDump(host, value, 'message') === 'string'
                ? String(propDump(host, value, 'message'))
                : '';
            /* A subclass the second realm has never heard of: `class Z extends Error {}` out of a
               context still answers `Z` to `err.constructor.name` on host Node 24.15, while its
               `err.name` stays the inherited `Error`. The two are different names, so the rebuild
               wears the constructor's and keeps the error's own. */
            const error = errorOf(host, realm, name, ctorNameOf(host, value) ?? name, message);
            if (error === undefined) return value;
            made = error;
        } else if (tag === '[object Promise]') {
            return promiseOf(host, realm, value);
        } else if (tag === '[object Map]' || tag === '[object Set]') {
            /* A `Map` or a `Set` the context has just handed back is finished with: nothing inside
               the guest still holds it, so unlike a live one it can be copied. */
            const empty = emptyOf(host, realm, tag === '[object Map]' ? 'Map' : 'Set');
            if (empty === undefined) return value;
            made = empty;
        } else if (tag === '[object WeakMap]' || tag === '[object WeakSet]') {
            /* The keys of a weak collection are the one part of a collection no walk can read, so a
               copy of one comes back empty -- which is still the realm the host hands one back from:
               `vm.runInNewContext('new WeakMap()') instanceof WeakMap` is false on host Node 24.15,
               and true while the caller's own realm is what a context's objects are of. */
            const empty = emptyOf(host, realm, tag === '[object WeakMap]' ? 'WeakMap' : 'WeakSet');
            if (empty === undefined) return value;
            return pin(host, empty);
        } else if (tag === '[object ArrayBuffer]') {
            const bytes = bytesOf(host, value);
            if (bytes === undefined) return value;
            return pin(host, ctx.newArrayBuffer(bytes.buffer as ArrayBuffer));
        } else if (tag === '[object DataView]') {
            /* A `DataView` is a window on a buffer, and the buffer is the only part of it the caller
               could not otherwise reach, so the rebuild is a copy of those bytes under a view of the
               second realm: `new DataView(new ArrayBuffer(4))` out of a context answers false to
               `instanceof DataView`, as it does on host Node 24.15. */
            const bytes = bytesOf(host, value);
            if (bytes === undefined) return value;
            const built = ctx.evalCode('(function (ab) { return new DataView(ab, 0); })');
            if (built.error) {
                built.error.dispose();
                return value;
            }
            const bridge = context.unwrapResult(built);
            const buffer = ctx.newArrayBuffer(bytes.buffer as ArrayBuffer);
            const result = ctx.callFunction(bridge, ctx.undefined, [buffer]);
            bridge.dispose();
            buffer.dispose();
            if (result.error) {
                result.error.dispose();
                return value;
            }
            return pin(host, context.unwrapResult(result));
        } else if (REALM_TYPED_ARRAYS.indexOf(tag.slice(8, -1)) >= 0) {
            /* A typed array is its bytes and the name of its class: rebuilt in the second realm over
               a copy of them, so `new Uint8Array(2)` out of a context answers false to
               `instanceof Uint8Array`, 2 to `length` and `[object Uint8Array]` to the tag, as on the
               host. `DataView` is left to cross as it is -- byte order aside, it is a view of a
               buffer the caller has no other way to reach, and no probe asks for it. */
            const bytes = bytesOf(host, value);
            const name = tag.slice(8, -1);
            if (bytes === undefined || bytes.length === 0) {
                const empty = emptyOf(host, realm, name);
                if (empty === undefined) return value;
                return pin(host, empty);
            }
            const built = ctx.evalCode(`(function (ab) { return new ${name}(ab); })`);
            if (built.error) {
                built.error.dispose();
                return value;
            }
            const bridge = context.unwrapResult(built);
            const buffer = ctx.newArrayBuffer(bytes.buffer as ArrayBuffer);
            const result = ctx.callFunction(bridge, ctx.undefined, [buffer]);
            bridge.dispose();
            buffer.dispose();
            if (result.error) {
                result.error.dispose();
                return value;
            }
            return pin(host, context.unwrapResult(result));
        } else if (REALM_FUNCTION_TAGS.indexOf(tag) >= 0) {
            /* A function's body belongs to the realm it was compiled in and cannot be recompiled into
               another, so the rebuild is a function of the second realm that calls the original:
               `typeof` still reads `function`, a call still reaches the body -- `this` and arguments
               and all -- while `instanceof Function` reads false, as it does on host Node 24.15 for
               the function a context hands back. */
            const fn = fnOf(host, realm, value, tag);
            if (fn === undefined) return value;
            return pin(host, fn);
        } else {
            return value;
        }
    } catch {
        return value;
    }
    pin(host, made);
    seen.push(value);
    twins.push(made);
    if (tag === '[object Map]' || tag === '[object Set]') {
        fillEntries(host, realm, value, made, tag === '[object Map]', depth, seen, twins, kept);
    }
    try {
        const keys = ownKeysOf(host, value);
        for (const key of keys) {
            const own = context.getProp(value, key);
            /*
             * Not disposed here: a value rebuilt below is remembered in `seen` so that a cycle or a
             * value the context hands back twice becomes one twin, and that entry has to outlive the
             * rebuild of the value it names. Disposing it here left the walk of a second such key
             * comparing against a dead handle, which aborted the walk: a value with two object-valued
             * keys crossed as only its first (`({a:{z:1},b:{y:2}})` lost `b`, `[{a:1},{b:2}]` lost
             * its second element). `kept` frees them once the whole rebuild is done instead.
             */
            kept.push(own);
            ctx.setProp(made, key, rehomeInto(host, realm, own, depth + 1, seen, twins, kept));
        }
    } catch {
        // a value whose own names cannot be read crosses as the empty shell it is so far
    }
    return made;
}

/**
 * The bytes `value` holds: the whole of an `ArrayBuffer`, or the window of one a typed array views.
 *
 * A copy, because the bytes the host reads are a view into the engine's own memory, which the next
 * call into it overwrites, and the rebuild is a buffer of the second realm holding its own.
 */
function bytesOf(host: VmHost, value: QuickJSHandle): Uint8Array | undefined {
    const { context } = host;
    let buffer: QuickJSHandle | undefined;
    try {
        buffer = context.getProp(value, 'buffer');
        const isView = context.typeof(buffer) === 'object';
        const offset = isView ? Number(propDump(host, value, 'byteOffset')) : 0;
        const length = isView ? Number(propDump(host, value, 'byteLength')) : -1;
        const held = context.getArrayBuffer(isView ? buffer : value);
        try {
            const all = new Uint8Array(held.value);
            if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0
                || offset + length > all.length) {
                return all;
            }
            return all.slice(offset, offset + length);
        } finally {
            held.dispose();
        }
    } catch {
        return undefined;
    } finally {
        if (buffer !== undefined) {
            try {
                buffer.dispose();
            } catch {
                // a handle already gone is nothing to report
            }
        }
    }
}

/**
 * A function of the second realm that calls `value`, or undefined when it cannot be built.
 *
 * The wrapper is of the kind the original is -- an async function under an async one, a generator
 * under a generator -- so `constructor.name` reads `AsyncFunction` and `GeneratorFunction` where a
 * host reads them, and `await` and `yield*` reach the body the way a call does. It is a function of
 * the realm it was written in, so `typeof` reads `function` and `instanceof Function` reads false,
 * and everything a call makes of it is the original's: `this`, the arguments, the value it returns,
 * and a throw, which crosses the way any value the context throws out does. Its `name` and `length`
 * are the original's too -- `function foo(a, b)` out of a context is still `foo` of length 2 on host
 * Node 24.15, and a class out of a context is still the name of that class, so `class D extends
 * Array {}` crossing answers `D` and not `''`. The own properties of a function beyond those two are
 * not copied: a class's statics are the walk of an object, not of a function.
 */
const REALM_FUNCTION_WRAPPERS: Record<string, string> = {
    /* A class is a function to every probe but not to `new`: `new C()` on a class a context handed
       back has to construct the original, not call it, which a plain `apply` refuses. */
    '[object Function]': '(function (f) { return function () { if (new.target !== undefined) ' +
        'return Reflect.construct(f, arguments, new.target); return f.apply(this, arguments); }; })',
    '[object AsyncFunction]': '(function (f) { return async function () { return await f.apply(this, arguments); }; })',
    '[object GeneratorFunction]': '(function (f) { return function* () { return yield* f.apply(this, arguments); }; })',
    '[object AsyncGeneratorFunction]': '(function (f) { return async function* () { return yield* f.apply(this, arguments); }; })'
};

function fnOf(host: VmHost, realm: VmRealm, value: QuickJSHandle, tag: string): QuickJSHandle | undefined {
    const ctx = realm.ctx;
    const source = REALM_FUNCTION_WRAPPERS[tag] ?? REALM_FUNCTION_WRAPPERS['[object Function]'];
    try {
        let built = ctx.evalCode(source);
        if (built.error) {
            /* An engine whose parser will not take the kind's own syntax still gets the plain
               wrapper rather than losing the function: a call reaches the body either way. */
            built.error.dispose();
            built = ctx.evalCode(REALM_FUNCTION_WRAPPERS['[object Function]']);
            if (built.error) {
                built.error.dispose();
                return undefined;
            }
        }
        const bridge = host.context.unwrapResult(built);
        const result = ctx.callFunction(bridge, ctx.undefined, [value]);
        bridge.dispose();
        if (result.error) {
            result.error.dispose();
            return undefined;
        }
        const made = host.context.unwrapResult(result);
        const name = typeof propDump(host, value, 'name') === 'string' ? String(propDump(host, value, 'name')) : '';
        const wanted = Number(propDump(host, value, 'length'));
        dressAs(realm, made, name, Number.isInteger(wanted) && wanted >= 0 ? wanted : 0);
        return made;
    } catch {
        return undefined;
    }
}

/** Gives the function `made` of the second realm the `name` and `length` of the function it wraps. */
function dressAs(realm: VmRealm, made: QuickJSHandle, name: string, length: number): void {
    const ctx = realm.ctx;
    try {
        const built = ctx.evalCode(
            '(function (f, n, l) {' +
            'try { Object.defineProperty(f, "name", { value: n, configurable: true }); } catch (x) {}' +
            'try { Object.defineProperty(f, "length", { value: l, configurable: true }); } catch (x) {}' +
            'return f; })'
        );
        if (built.error) {
            built.error.dispose();
            return;
        }
        const bridge = ctx.unwrapResult(built);
        const named = ctx.newString(name);
        const counted = ctx.newNumber(length);
        const result = ctx.callFunction(bridge, ctx.undefined, [made, named, counted]);
        named.dispose();
        counted.dispose();
        bridge.dispose();
        if (result.error) result.error.dispose();
        else result.value.dispose();
    } catch {
        // a function that will not wear the name still calls the original
    }
}

/**
 * Gives `made` a constructor named `name`, so a class instance out of a context keeps the name of its
 * class: an object of the second realm set under a fresh prototype whose constructor wears it.
 */
function nameAfter(host: VmHost, realm: VmRealm, made: QuickJSHandle, name: string): void {
    const ctx = realm.ctx;
    try {
        const built = ctx.evalCode(
            '(function (o, n) {' +
            'var S = function () {};' +
            'try { Object.defineProperty(S, "name", { value: n, configurable: true }); } catch (x) {}' +
            'S.prototype.constructor = S;' +
            'Object.setPrototypeOf(o, S.prototype);' +
            'return o; })'
        );
        if (built.error) {
            built.error.dispose();
            return;
        }
        const bridge = host.context.unwrapResult(built);
        const named = ctx.newString(name);
        const result = ctx.callFunction(bridge, ctx.undefined, [made, named]);
        named.dispose();
        bridge.dispose();
        if (result.error) result.error.dispose();
        else result.value.dispose();
    } catch {
        // an object whose constructor will not wear the name crosses as the plain object it is
    }
}

/** `new Map()` or `new Set()` of the second realm, or undefined when it cannot be built. */
function emptyOf(host: VmHost, realm: VmRealm, name: string): QuickJSHandle | undefined {
    const ctx = realm.ctx;
    try {
        const built = ctx.evalCode(`new ${name}()`);
        if (built.error) {
            built.error.dispose();
            return undefined;
        }
        return host.context.unwrapResult(built);
    } catch {
        return undefined;
    }
}

/**
 * Fills the empty `Map` or `Set` of the second realm with the entries of `value`.
 *
 * `forEach` is the only way in: the entries of a `Map` are not properties, so the own-name walk that
 * fills an array or a plain object finds nothing on one. The callback is a host function, so an entry
 * arrives as a handle -- which a dump could not carry, a live object being nothing a dump can hold.
 *
 * An entry crosses as a rebuild of itself, not as the very object it is: host Node 24.15 hands back
 * the context's own collection, keys and values and all, so what a caller reads out of one -- a key
 * from `keys()`, a value from `get()`, a member of a `Set` -- is an object of the context's realm
 * too and answers `false` to `instanceof Object`. A `Map` is a lookup, so the entries go through the
 * same walk the properties of an array or a plain object do, and through the same `seen`/`twins`
 * guard: a collection that holds itself, or one reached again from an object inside it, comes back
 * holding its own twin rather than a second copy of itself. An entry the walk cannot read is skipped
 * rather than failing the whole rebuild, so a collection with one awkward value still crosses as the
 * rest of itself.
 */
function fillEntries(
    host: VmHost,
    realm: VmRealm,
    value: QuickJSHandle,
    made: QuickJSHandle,
    isMap: boolean,
    depth: number,
    seen: QuickJSHandle[],
    twins: QuickJSHandle[],
    kept: QuickJSHandle[]
): void {
    const ctx = realm.ctx;
    const entries: QuickJSHandle[][] = [];
    let collect: QuickJSHandle | undefined;
    try {
        collect = host.context.newFunction('collect', (one, two) => {
            /* The argument handles die when this call returns: keep copies of the ones the fill
               still needs after `forEach` is over. `forEach` hands a `Map`'s value first and its key
               second, and a `Set`'s value twice, so a `Map` keeps them the other way round. */
            entries.push(isMap ? [two.dup(), one.dup()] : [one.dup()]);
        });
        const result = host.context.callMethod(value, 'forEach', [collect]);
        if (result.error) result.error.dispose();
        else result.value.dispose();
    } catch {
        // an object whose entries cannot be walked crosses as the empty collection it is so far
    } finally {
        if (collect !== undefined) collect.dispose();
    }
    for (const entry of entries) {
        try {
            /* The entries are dups this walk owns and frees below, so they outlive the rebuild of
               the value each one names -- which is what lets `seen` keep them for a twin to come. */
            const into = entry.map((one) => rehomeInto(host, realm, one, depth + 1, seen, twins, kept));
            const result = ctx.callMethod(made, isMap ? 'set' : 'add', into);
            if (result.error) result.error.dispose();
            else result.value.dispose();
        } catch {
            // one entry that will not go in leaves the rest of the collection intact
        } finally {
            for (const handle of entry) {
                try { handle.dispose(); } catch { /* already gone with its context */ }
            }
        }
    }
}

/**
 * A promise of the second realm that settles the way `value` does, so a promise out of a `vm`
 * context answers `false` to `instanceof Promise` -- as it does on host Node 24.15 -- and still
 * resolves to what it promised: the reactions are attached to the promise the context made rather
 * than to a snapshot of it, so a promise that is still pending when it crosses stays pending until
 * it settles, and a rejection crosses as a rejection.
 *
 * What it settles with crosses as any other value the context hands back does -- a rebuild in the
 * second realm, so `await vm.runInNewContext('Promise.resolve({a:1})') instanceof Object` is
 * `false`, and so is the `instanceof Error` of a rejection reason. The settling is a later turn,
 * long after the walk that built the promise has been torn down, so the rebuild runs inside the
 * reaction and carries a walk of its own: a `seen` kept from the earlier one would be compared
 * against handles this binding has already freed.
 */
function promiseOf(host: VmHost, realm: VmRealm, value: QuickJSHandle): QuickJSHandle {
    const ctx = realm.ctx;
    try {
        if (realm.rehomeFn === undefined) {
            realm.rehomeFn = host.context.newFunction('rehome', (settled) => {
                const kept: QuickJSHandle[] = [];
                try {
                    return rehomeInto(host, realm, settled, 1, [], [], kept);
                } catch {
                    return settled;
                } finally {
                    for (const own of kept) {
                        try { own.dispose(); } catch { /* already gone with its context */ }
                    }
                }
            });
        }
        const built = ctx.evalCode(
            /* A promise the context built with a subclass of `Promise` keeps the name of that
               subclass: `class P extends Promise {}` out of a context still answers `P` to
               `constructor.name` on host Node 24.15, and `false` to `instanceof Promise`. The second
               realm has never heard of `P`, so it is given one of that name extending its own. */
            '(function (src, rehome, P) {' +
            'var proto = Object.getPrototypeOf(src);' +
            /* What a host reads off a promise a context handed back is `Promise`, whatever this
               runtime itself calls the class it tracks rejections with: the guest realm's own
               Promise is a subclass of one name or another for its own reasons, and `Tracked` is
               not an answer host Node 24.15 ever gives. A promise of a subclass the context made
               does keep that subclass's name, as it does on the host. */
            'var name = proto && proto.constructor === P ? "Promise"' +
            ' : (proto && typeof proto.constructor === "function" ? String(proto.constructor.name) : "Promise");' +
            'var sub = undefined;' +
            'if (name !== "Promise" && name !== "") {' +
            'try { sub = eval("(class " + name + " extends Promise {})"); } catch (x) { sub = undefined; }' +
            '}' +
            'function react(res, rej) {' +
            'src.then(function (v) { res(rehome(v)); }, function (e) { rej(rehome(e)); });' +
            '}' +
            'return typeof sub === "function" ? Reflect.construct(sub, [react]) : new Promise(react);' +
            '})'
        );
        if (built.error) {
            built.error.dispose();
            return value;
        }
        const bridge = host.context.unwrapResult(built);
        const guestPromise = host.context.getProp(host.context.global, 'Promise');
        const result = ctx.callFunction(bridge, ctx.undefined, [value, realm.rehomeFn!, guestPromise]);
        guestPromise.dispose();
        bridge.dispose();
        if (result.error) {
            result.error.dispose();
            return value;
        }
        return pin(host, host.context.unwrapResult(result));
    } catch {
        return value;
    }
}

/**
 * The own string keys of `value`, read as `Object.getOwnPropertyNames` reads them.
 *
 * All of them, not only the enumerable ones: the properties that make an error what it is --
 * `message`, `stack`, `cause`, an `AggregateError`'s `errors` -- are own and non-enumerable, so an
 * enumerable-only walk handed back an error with none of them, which is not what host Node 24.15
 * does: it hands back the very object the context made, non-enumerable properties and all. The
 * symbol keys are part of that too -- see {@link symbolKeysOf}.
 */
function ownKeysOf(host: VmHost, value: QuickJSHandle): (string | QuickJSHandle)[] {
    const keys: (string | QuickJSHandle)[] = [];
    const probes = probesOf(host);
    const result = host.context.callFunction(probes.names, probes.object, [value]);
    if (result.error) {
        result.error.dispose();
    } else {
        const names = host.context.dump(result.value);
        result.value.dispose();
        if (Array.isArray(names)) {
            for (const name of names) keys.push(String(name));
        }
    }
    /* A symbol key crosses as the symbol itself, not as text: `Reflect.ownKeys` of an object a
       context handed back with one reads `["a", Symbol(k)]` on host Node 24.15, so the twin is set
       under the very symbol the context used rather than under a fresh one of the second realm. */
    for (const symbol of symbolKeysOf(host, value)) keys.push(symbol);
    return keys;
}

/** The own symbol keys of `value`, read as `Object.getOwnPropertySymbols` reads them, as handles. */
function symbolKeysOf(host: VmHost, value: QuickJSHandle): QuickJSHandle[] {
    const out: QuickJSHandle[] = [];
    const { context } = host;
    try {
        const probes = probesOf(host);
        const result = context.callFunction(probes.symbols, probes.object, [value]);
        if (result.error) {
            result.error.dispose();
            return out;
        }
        const list = result.value;
        try {
            const counted = context.getProp(list, 'length');
            const length = Number(context.dump(counted));
            counted.dispose();
            for (let i = 0; i < length; i++) {
                const one = context.getProp(list, String(i));
                if (context.typeof(one) === 'symbol') out.push(one);
                else one.dispose();
            }
        } finally {
            list.dispose();
        }
    } catch {
        // a value whose symbols cannot be read crosses with the keys it has
    }
    return out;
}

/** Keeps a value built in the second realm alive for as long as the binding does, and returns it. */
function pin(host: VmHost, value: QuickJSHandle): QuickJSHandle {
    host.realmValues.push(value);
    return value;
}

/**
 * Retires the oldest pins, the oldest half of them, when the cap on them is reached.
 *
 * Only between rebuilds: a walk in flight keeps its twins in this list, and a twin freed under it is
 * a handle the rest of the walk would still compare against.
 */
function retire(host: VmHost): void {
    if (host.realmValues.length < REALM_MAX_VALUES) return;
    const drop = Math.floor(REALM_MAX_VALUES / 2);
    for (const old of host.realmValues.splice(0, drop)) {
        try {
            old.dispose();
        } catch {
            // a handle already gone is nothing to report
        }
    }
}

/**
 * The error constructors of the second realm an error can be rebuilt as.
 *
 * An `Error` crossing out of a `vm` context is an object of another realm in host Node 24.15 --
 * `vm.runInNewContext('new Error("x")') instanceof Error` is `false` there -- and it keeps the name
 * of the constructor it was built with, so a `TypeError` out of a context is still named
 * `TypeError`. Only the eight the language defines are used: any other name is an ordinary `Error`
 * wearing it, which is the closest a rebuild can come to a class the second realm has never heard of.
 */
const REALM_ERRORS = ['AggregateError', 'Error', 'EvalError', 'RangeError', 'ReferenceError',
    'SyntaxError', 'TypeError', 'URIError'];

/**
 * A new error of the second realm, carrying `message` and named `name`.
 *
 * An error rebuilt here answers `false` to `instanceof Error` in the guest, as an error out of a
 * `vm` context does in host Node 24.15, while `err.message`, `err.name` and
 * `Object.prototype.toString.call(err)` still read as they did inside the context. Its own `stack` is
 * the second realm's, which is the honest answer: the frames of the guest's own realm are the
 * container's, and no realm boundary makes them the host's.
 */
function errorOf(host: VmHost, realm: VmRealm, name: string, ctor: string, message: string): QuickJSHandle | undefined {
    const ctx = realm.ctx;
    try {
        const kind = REALM_ERRORS.indexOf(name) >= 0 ? name : 'Error';
        /* `AggregateError` takes its errors first and its message second, so a message alone would
           be read as the iterable of errors: `new AggregateError('m')` came out with one error --
           the string's one character -- and an empty message. Its `errors` are copied by the walk. */
        const args = kind === 'AggregateError' ? `[], ${JSON.stringify(message)}` : JSON.stringify(message);
        const built = ctx.evalCode(
            `(function () {` +
            `var n = ${JSON.stringify(name)};` +
            `var k = ${JSON.stringify(ctor)};` +
            `var m = ${JSON.stringify(message)};` +
            `var C = globalThis[${JSON.stringify(kind)}];` +
            `var e = typeof C === 'function' ? new C(${args}) : new Error(m);` +
            `if (e.name !== n) e.name = n;` +
            /* A class the second realm has never heard of: an `Error` wearing its name still answers
               `Error` to `constructor.name`, where host Node hands back the context's own object and
               so reads the class. Give the rebuild a constructor of that name instead -- the
               constructor's, which for a subclass is not the same as the error's own `name`. */
            `var p = Object.getPrototypeOf(e);` +
            `if (!(p && p.constructor && p.constructor.name === k)) {` +
            `var S = function (mm) {` +
            `var o = new Error(mm);` +
            `Object.setPrototypeOf(o, S.prototype);` +
            `o.name = n;` +
            `return o; };` +
            `Object.setPrototypeOf(S.prototype, p || Error.prototype);` +
            `S.prototype.constructor = S;` +
            `try { Object.defineProperty(S, 'name', { value: k, configurable: true }); } catch (x) {}` +
            `e = S(m);` +
            `}` +
            /* The order an error's own names come back in: host Node 24.15 builds `stack` first --
               `new Error('x')` is `['stack','message']` and an `AggregateError` is
               `['stack','message','errors']` -- where this engine puts `message` on first and
               appends `stack` after it, so an error out of a context listed its names the other
               way round. The order is what `Object.getOwnPropertyNames` reads and nothing else,
               so it is put right here by taking the whole of the error's own properties off and
               putting them back in the host's order, descriptors and all. */
            `var wanted = ['stack', 'message', 'errors'];` +
            `var had = Object.getOwnPropertyNames(e);` +
            `var order = [];` +
            `for (var w = 0; w < wanted.length; w++) { if (had.indexOf(wanted[w]) >= 0) order.push(wanted[w]); }` +
            `for (var h = 0; h < had.length; h++) { if (order.indexOf(had[h]) < 0) order.push(had[h]); }` +
            `if (order.join(',') !== had.join(',')) {` +
            `var kept = [];` +
            `for (var q = 0; q < order.length; q++) kept.push(Object.getOwnPropertyDescriptor(e, order[q]));` +
            `for (var d = 0; d < order.length; d++) { try { delete e[order[d]]; } catch (x) { } }` +
            `for (var r = 0; r < order.length; r++) { if (kept[r] !== undefined) Object.defineProperty(e, order[r], kept[r]); }` +
            `}` +
            `return e; })()`
        );
        if (built.error) {
            built.error.dispose();
            return undefined;
        }
        return host.context.unwrapResult(built);
    } catch {
        return undefined;
    }
}

/** The `name` of `value`'s constructor, read through the prototype chain as `value.constructor.name`. */
function ctorNameOf(host: VmHost, value: QuickJSHandle): string | undefined {
    try {
        const ctor = host.context.getProp(value, 'constructor');
        const name = host.context.getProp(ctor, 'name');
        const answer = host.context.dump(name);
        name.dispose();
        ctor.dispose();
        return typeof answer === 'string' && answer.length > 0 ? answer : undefined;
    } catch {
        return undefined;
    }
}

/** Reads and dumps `value[key]` in the guest realm, or undefined if it cannot be read. */
function propDump(host: VmHost, value: QuickJSHandle, key: string): unknown {
    try {
        const own = host.context.getProp(value, key);
        const answer = host.context.dump(own);
        own.dispose();
        return answer;
    } catch {
        return undefined;
    }
}

export const VM_CAPABILITIES: Record<string, CapabilityHandler> = {
    /**
     * Runs the guest thunk (api.vmThunk) synchronously under a deadline `timeout` ms from now, never
     * later than an enclosing one. An interruption returns { interrupted: true }; { unbound: true }
     * means no runtime is bound and nothing ran.
     */
    'vm.run': (args, ctx) => {
        const host = hosts.get(ctx);
        if (!host) return { unbound: true };
        const { context } = host;
        const thunk = context.getProp(host.api, 'vmThunk');
        const outer = host.deadline;
        const limit = Date.now() + Number(args.timeout);
        host.deadline = outer === 0 ? limit : Math.min(outer, limit);
        try {
            host.fired = false;
            const result = context.callFunction(thunk, context.undefined);
            if (result.error) {
                const error = context.dump(result.error);
                result.error.dispose();
                return host.fired ? { interrupted: true } : { interrupted: false, error: describeError(error) };
            }
            result.value.dispose();
            return { interrupted: false };
        } finally {
            host.deadline = outer;
            /* the deadline owns this window: whether it or the budget stopped the guest, process.ts
               must not read the reason as its own later */
            host.reason = undefined;
            thunk.dispose();
        }
    },

    /**
     * Runs the code of a `vm` context as global code of that context's own realm, and leaves what
     * it answered at `api.vmOut` -- or what it threw at `api.vmThrow` with `{ ok: false }`.
     *
     * The sandbox goes onto the realm's global object before the run and back onto the sandbox
     * after it, which is what makes the globals the code makes the sandbox's: see {@link syncIn}.
     * The value comes back as it is, which is the whole point -- a value the context made is
     * already of another realm, so `instanceof` reads false for it outside, and it is the very
     * object the context made, so a value it hands back twice is one object.
     *
     * `filename` and `lineOffset` are the ones the `Script` or the options named, and the code is
     * compiled under them: the frames of the error a script throws name the file and the line the
     * host would, and QuickJS is given no line number of its own, so the offset is the newlines in
     * front of the code instead.
     */
    'vm.exec': (args, ctx) => {
        const host = hosts.get(ctx);
        if (!host) return { unbound: true };
        const { context } = host;
        const realm = realmFor(host, realmIdOf(args));
        if (realm === undefined) return { unbound: true };
        const code = context.getProp(host.api, 'vmCode');
        const sandbox = context.getProp(host.api, 'vmSb');
        const view = context.getProp(host.api, 'vmG');
        const cons = context.getProp(host.api, 'vmConsole');
        try {
            syncIn(host, realm, sandbox);
            if (context.typeof(cons) === 'object') {
                /* Neither `setProp` nor the context API's own `defineProp`: the first makes the
                   name enumerable, and host node 24.15 answers '[]' for 'Object.keys(globalThis)'
                   inside a context -- 'console' is a global a context is given and not one Node's
                   own global object enumerates; the second leaves it read-only, where node's is
                   writable. */
                defineHidden(realm, 'console', cons);
                realm.injected.add('console');
            }
            const source = context.dump(code);
            const offset = Number(args.lineOffset);
            const pad = Number.isInteger(offset) && offset > 0 && offset < 65536 ? '\n'.repeat(offset) : '';
            const file = typeof args.filename === 'string' && args.filename !== ''
                ? args.filename : 'evalmachine.<anonymous>';
            const built = realm.ctx.evalCode(pad + (typeof source === 'string' ? source : ''), file);
            if (built.error) {
                /* Whether the run was interrupted, which the guest cannot tell from the error alone:
                   QuickJS raises an interruption as an uncatchable InternalError, but this call is a
                   host boundary -- the throw the guest makes of what is handed back here is an
                   ordinary one its own catch blocks do see, so a vm.run deadline that stopped a
                   context would otherwise surface as that raw InternalError and not as the
                   ERR_SCRIPT_EXECUTION_TIMEOUT host Node 24.15 raises in the context's realm. */
                const fired = host.fired;
                context.setProp(host.api, 'vmThrow', built.error);
                built.error.dispose();
                syncOut(host, realm, sandbox);
                return { ok: false, fired };
            }
            const out = built.value;
            /* `globalThis` of a context is the sandbox's own view of it to the caller and not the
               realm's global object: host Node 24.15 hands back the contextified global, and that
               is one object however many runs hand it back. */
            if (realm.ctx.eq(out, realm.ctx.global)) {
                out.dispose();
                context.setProp(host.api, 'vmOut', view.dup());
            } else {
                context.setProp(host.api, 'vmOut', out);
                out.dispose();
            }
            syncOut(host, realm, sandbox);
            return { ok: true };
        } catch {
            return { unbound: true };
        } finally {
            for (const handle of [code, sandbox, view, cons]) {
                try { handle.dispose(); } catch { /* already gone with its context */ }
            }
        }
    },

    /**
     * Leaves the second realm's own ES globals at `api.vmEs`, under the names the guest's `with`
     * scope answers for: the code of a `vm` context runs in that realm, so the `Array` its `[]` is
     * an instance of has to be the realm's and not the caller's.
     */
    'vm.es': (args, ctx) => {
        const host = hosts.get(ctx);
        if (!host) return { unbound: true };
        const realm = realmFor(host, realmIdOf(args));
        if (realm === undefined) return { unbound: true };
        try {
            const built = realm.ctx.evalCode(
                '(function (names) {' +
                'var o = {};' +
                'for (var i = 0; i < names.length; i++) {' +
                'try { o[names[i]] = eval(names[i]); } catch (x) { }' +
                '}' +
                'return o; })'
            );
            if (built.error) {
                built.error.dispose();
                return { unbound: true };
            }
            const reader = realm.ctx.unwrapResult(built);
            const names = realm.ctx.unwrapResult(realm.ctx.evalCode(JSON.stringify(REALM_ES_NAMES)));
            const result = realm.ctx.callFunction(reader, realm.ctx.undefined, [names]);
            names.dispose();
            reader.dispose();
            if (result.error) {
                result.error.dispose();
                return { unbound: true };
            }
            host.context.setProp(host.api, 'vmEs', result.value);
            result.value.dispose();
            return { built: true };
        } catch {
            return { unbound: true };
        }
    },

    /**
     * Rebuilds the value the guest left at `api.vmValue` inside the second realm and leaves the
     * result at `api.vmBack`, so a value returned from a `vm` context is an object of another realm.
     *
     * The value travels on the api object both ways: a capability carries JSON, and this one carries
     * a live object. Nothing is written to `api.vmBack` when there is no binding, no second realm or
     * nothing to rebuild, and the guest keeps the value it had.
     */
    'vm.realm': (args, ctx) => {
        const host = hosts.get(ctx);
        if (!host) return { unbound: true };
        const { context } = host;
        const value = context.getProp(host.api, 'vmValue');
        /* Own handles read off the value on the way down, freed once the rebuild is over: they are
           what the cycle guard compares against while it still runs. */
        const kept: QuickJSHandle[] = [];
        let rebuilt: QuickJSHandle | undefined;
        try {
            if (context.typeof(value) !== 'object' && context.typeof(value) !== 'function') return { rebuilt: false };
            const realm = realmFor(host, realmIdOf(args));
            if (realm === undefined) return { rebuilt: false };
            /* The whole value a run handed back: recognized before it is rebuilt, so a value the
               context has handed back before comes back as the one object it came back as then, the
               way host Node hands the very object the context made to the caller every time. */
            rebuilt = twinOf(host, value);
            if (rebuilt !== undefined) {
                context.setProp(host.api, 'vmBack', rebuilt);
                return { rebuilt: true };
            }
            retire(host);
            rebuilt = rehomeInto(host, realm, value, 0, [], [], kept);
            if (rebuilt === value) return { rebuilt: false };
            remember(host, value, rebuilt);
            context.setProp(host.api, 'vmBack', rebuilt);
            return { rebuilt: true };
        } catch {
            return { rebuilt: false };
        } finally {
            value.dispose();
            if (rebuilt !== undefined) {
                try {
                    rebuilt.dispose();
                } catch {
                    // a handle already gone is nothing to report
                }
            }
            for (const own of kept) {
                try { own.dispose(); } catch { /* already gone with its context */ }
            }
        }
    }
};
