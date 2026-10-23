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

interface VmHost {
    runtime: QuickJSRuntime;
    context: QuickJSContext;
    /** The guest bootstrap API object; vm.run reads the thunk from its `vmThunk` slot. */
    api: QuickJSHandle;
    /**
     * A second realm: a second QuickJS context on the same runtime, made the first time a `vm`
     * context runs code -- or the first time a value of this realm has to cross out of one. The
     * code of a context runs here, and its intrinsics are its own -- `Array` here is not the
     * guest's `Array` -- because QuickJS gives each context its own set, while objects of one
     * context are usable from another of the same runtime. That is the whole of what Node's
     * cross-realm behaviour needs: a value the context made answers `false` to `instanceof Array`
     * while `Array.isArray` still answers `true`, and one the caller put into the context is the
     * caller's own object still.
     */
    realm?: QuickJSContext;
    /** `Object.prototype.toString` and `Array.isArray` of the guest realm, once: see {@link VmProbes}. */
    probes?: VmProbes;
    /** `(v) => boolean`: whether `v` is a proxy the guest realm made, built once in that realm. */
    proxyTest?: QuickJSHandle;
    /** `Proxy` of the guest realm, once: what a rebuild wraps a proxy it hands back in. */
    proxyCtor?: QuickJSHandle;
    /** Values built in {@link VmHost.realm} and handed to the guest, freed with the binding. */
    realmValues: QuickJSHandle[];
    /** Rebuilds the value a promise settles with, once per binding: see {@link promiseOf}. */
    rehomeFn?: QuickJSHandle;
    /** The wrapper {@link REALM_EXEC_SRC} compiles to in {@link VmHost.realm}, once. */
    execFn?: QuickJSHandle;
    /** Hands a cell the realm's tracker built to `api.noteRejection`, once per binding. */
    noteFn?: QuickJSHandle;
    /**
     * A `WeakMap` of the guest realm: the value a `vm` context handed back -> the twin it was
     * rebuilt as, so that what the context hands back twice comes back as one object.
     */
    twins?: QuickJSHandle;
    /** The pairs behind {@link VmHost.twins}, oldest first: the source, and the twin beside it. */
    memo: { src: QuickJSHandle; twin: QuickJSHandle }[];
    /** The standard globals of the guest realm beside their namesakes in the second realm, once. */
    builtins?: { from: QuickJSHandle[]; to: QuickJSHandle[] };
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
 * The standard globals whose namesake in the second realm replaces the guest realm's when one of
 * them is what crosses out of a `vm` context: `runInContext('Array')` is the context's own `Array`,
 * not the caller's, which is why host Node reports `false` for `runInContext('Array') === Array`.
 */
const REALM_BUILTINS = ['AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array',
    'BigUint64Array', 'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry',
    'Float32Array', 'Float64Array', 'Function', 'Int16Array', 'Int32Array', 'Int8Array', 'Intl',
    'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError',
    'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError', 'TypeError',
    'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'URIError', 'WeakMap',
    'WeakRef', 'WeakSet'];

/** The ES globals of the second realm whose names the guest's `with` scope answers for. */
const REALM_ES_NAMES = ['Infinity', 'NaN', 'undefined', 'eval', 'isFinite', 'isNaN', 'parseFloat',
    'parseInt', 'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'escape',
    'unescape'].concat(REALM_BUILTINS);

/**
 * The body a `vm` context's code runs under, compiled *inside* the second realm.
 *
 * A context used to run its code in the caller's own realm, with a `with` scope that handed the ES
 * globals of that realm to it. No change to what the scope hands out can match host Node 24.15
 * then: an array the caller puts into a context and an array the code of the context makes are the
 * same kind of object there, so `e instanceof Array` and `[] instanceof Array` cannot come apart,
 * and on the host they do (`false` and `true`). What separates them is the realm the code runs in,
 * so the `with` scope is handed to a wrapper compiled in the second realm and the code is `eval`ed
 * there: a value the context makes is of the second realm as it is made, one the caller put in is
 * still the caller's, and both are handed back as they are.
 *
 * The names are the ones the scope's proxy leaves alone -- every other free name is the scope's to
 * answer, so a parameter called `sb` would read as a sandbox property and not as the argument.
 */
const REALM_EXEC_SRC = '(function (__owcVmWith, __owcVmCode, __owcVmFns, __owcVmSb) {' +
    'var __owcVmOut;' +
    'try {' +
    'with (__owcVmWith) { __owcVmOut = eval(__owcVmCode); }' +
    '} finally {' +
    'for (var __owcVmI = 0; __owcVmI < __owcVmFns.length; __owcVmI++) {' +
    'try { __owcVmSb[__owcVmFns[__owcVmI]] = eval(__owcVmFns[__owcVmI]); }' +
    'catch (__owcVmErr) {' +
    'if (__owcVmSb[__owcVmFns[__owcVmI]] === undefined) delete __owcVmSb[__owcVmFns[__owcVmI]];' +
    '}' +
    '}' +
    '}' +
    'return __owcVmOut; })';

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
const REALM_REJECTION_SRC = '(function (note) {' +
    'var Native = Promise;' +
    'var CELLS = new WeakMap();' +
    'class Tracked extends Native {' +
    'constructor(executor) {' +
    'var cell = { reason: undefined, rejected: false, handled: false, promise: null, domain: null };' +
    'super(function (resolve, reject) {' +
    'var wrapped = function (reason) { cell.rejected = true; cell.reason = reason; note(cell); reject(reason); };' +
    'try { executor(resolve, wrapped); } catch (err) { wrapped(err); }' +
    '});' +
    'CELLS.set(this, cell);' +
    'cell.promise = this;' +
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
    if (host.builtins !== undefined) {
        for (const handle of [...host.builtins.from, ...host.builtins.to]) {
            try {
                handle.dispose();
            } catch {
                // as above
            }
        }
        host.builtins = undefined;
    }
    if (host.rehomeFn !== undefined) {
        try {
            host.rehomeFn.dispose();
        } catch {
            // a handle already gone is nothing to report
        }
        host.rehomeFn = undefined;
    }
    if (host.execFn !== undefined) {
        try {
            host.execFn.dispose();
        } catch {
            // as above
        }
        host.execFn = undefined;
    }
    if (host.noteFn !== undefined) {
        try {
            host.noteFn.dispose();
        } catch {
            // as above
        }
        host.noteFn = undefined;
    }
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
    if (host.realm !== undefined) {
        try {
            host.realm.dispose();
        } catch {
            // as above
        }
        host.realm = undefined;
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

function describeError(error: unknown): string {
    if (error !== null && typeof error === 'object' && 'message' in error) {
        return String((error as { message: unknown }).message);
    }
    return String(error);
}

/**
 * The second realm, made on the first value that has to cross -- or on the first `vm` context that
 * has to run -- or undefined when it cannot be made.
 *
 * A `vm` context's code runs here, so the realm is given the process's rejection tracker before
 * anything runs in it: a promise the context leaves unhandled is otherwise one this process never
 * hears about, where host Node 24.15 reports it.
 */
function realmOf(host: VmHost): QuickJSContext | undefined {
    if (host.realm !== undefined) return host.realm;
    try {
        const realm = host.runtime.newContext();
        host.realm = realm;
        installRejections(host, realm);
        return realm;
    } catch {
        return undefined;
    }
}

/**
 * Gives a freshly made second realm the process's rejection tracker, whose cells are handed to the
 * guest's `api.noteRejection`.
 */
function installRejections(host: VmHost, realm: QuickJSContext): void {
    try {
        const built = realm.evalCode(REALM_REJECTION_SRC);
        if (built.error) {
            built.error.dispose();
            return;
        }
        const installer = realm.unwrapResult(built);
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
        host.noteFn = note;
        const result = realm.callFunction(installer, realm.undefined, [note]);
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
function builtinOf(host: VmHost, realm: QuickJSContext, value: QuickJSHandle): QuickJSHandle | undefined {
    if (host.builtins === undefined) {
        const from: QuickJSHandle[] = [];
        const to: QuickJSHandle[] = [];
        const { context } = host;
        for (const name of REALM_BUILTINS) {
            const ofGuest = context.getProp(context.global, name);
            const ofRealm = realm.getProp(realm.global, name);
            from.push(ofGuest);
            to.push(ofRealm);
        }
        host.builtins = { from, to };
    }
    const { from, to } = host.builtins;
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
function proxyOf(host: VmHost, realm: QuickJSContext, value: QuickJSHandle): QuickJSHandle | undefined {
    const { context } = host;
    try {
        if (host.proxyCtor === undefined) host.proxyCtor = context.getProp(context.global, 'Proxy');
        const object = realm.getProp(realm.global, 'Object');
        const objectProto = realm.getProp(object, 'prototype');
        const built = realm.evalCode(
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
        const result = realm.callFunction(bridge, realm.undefined, [value, objectProto, host.proxyCtor]);
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
    realm: QuickJSContext,
    value: QuickJSHandle,
    depth: number,
    seen: QuickJSHandle[],
    twins: QuickJSHandle[],
    kept: QuickJSHandle[]
): QuickJSHandle {
    const { context } = host;
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
            made = realm.newArray();
            /* An instance of a class that extends a host's own `Array` is an array to every probe --
               `Array.isArray` and the `[object Array]` tag both say so -- but it still answers the
               name of its class, not `Array`, to `o.constructor.name` on host Node 24.15. */
            const arrayCtor = ctorNameOf(host, value);
            if (arrayCtor !== undefined && arrayCtor !== 'Array' && arrayCtor !== 'Object') {
                nameAfter(host, realm, made, arrayCtor);
            }
        } else if (tag === '[object Object]') {
            made = realm.newObject();
            /* A class instance: `class C {}` out of a context still answers `C` to
               `o.constructor.name` on host Node 24.15, which a bare object of the second realm would
               answer `Object` to. The class itself is the one thing that cannot cross -- its body was
               compiled in the context's realm -- so the rebuild is given a constructor of that name,
               the way an `Error` subclass already was, and keeps the class's own properties. */
            const ctor = ctorNameOf(host, value);
            if (ctor !== undefined && ctor !== 'Object') nameAfter(host, realm, made, ctor);
        } else if (tag === '[object Date]') {
            const ms = Number(methodDump(host, value, 'getTime'));
            return pin(host, context.unwrapResult(realm.evalCode(`new Date(${Number.isFinite(ms) ? ms : 0})`)));
        } else if (tag === '[object RegExp]') {
            const source = String(propDump(host, value, 'source') ?? '');
            const flags = String(propDump(host, value, 'flags') ?? '');
            return pin(host, context.unwrapResult(realm.evalCode(`new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)})`)));
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
            return pin(host, realm.newArrayBuffer(bytes.buffer as ArrayBuffer));
        } else if (tag === '[object DataView]') {
            /* A `DataView` is a window on a buffer, and the buffer is the only part of it the caller
               could not otherwise reach, so the rebuild is a copy of those bytes under a view of the
               second realm: `new DataView(new ArrayBuffer(4))` out of a context answers false to
               `instanceof DataView`, as it does on host Node 24.15. */
            const bytes = bytesOf(host, value);
            if (bytes === undefined) return value;
            const built = realm.evalCode('(function (ab) { return new DataView(ab, 0); })');
            if (built.error) {
                built.error.dispose();
                return value;
            }
            const bridge = context.unwrapResult(built);
            const buffer = realm.newArrayBuffer(bytes.buffer as ArrayBuffer);
            const result = realm.callFunction(bridge, realm.undefined, [buffer]);
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
            const built = realm.evalCode(`(function (ab) { return new ${name}(ab); })`);
            if (built.error) {
                built.error.dispose();
                return value;
            }
            const bridge = context.unwrapResult(built);
            const buffer = realm.newArrayBuffer(bytes.buffer as ArrayBuffer);
            const result = realm.callFunction(bridge, realm.undefined, [buffer]);
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
            realm.setProp(made, key, rehomeInto(host, realm, own, depth + 1, seen, twins, kept));
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

function fnOf(host: VmHost, realm: QuickJSContext, value: QuickJSHandle, tag: string): QuickJSHandle | undefined {
    const source = REALM_FUNCTION_WRAPPERS[tag] ?? REALM_FUNCTION_WRAPPERS['[object Function]'];
    try {
        let built = realm.evalCode(source);
        if (built.error) {
            /* An engine whose parser will not take the kind's own syntax still gets the plain
               wrapper rather than losing the function: a call reaches the body either way. */
            built.error.dispose();
            built = realm.evalCode(REALM_FUNCTION_WRAPPERS['[object Function]']);
            if (built.error) {
                built.error.dispose();
                return undefined;
            }
        }
        const bridge = host.context.unwrapResult(built);
        const result = realm.callFunction(bridge, realm.undefined, [value]);
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
function dressAs(realm: QuickJSContext, made: QuickJSHandle, name: string, length: number): void {
    try {
        const built = realm.evalCode(
            '(function (f, n, l) {' +
            'try { Object.defineProperty(f, "name", { value: n, configurable: true }); } catch (x) {}' +
            'try { Object.defineProperty(f, "length", { value: l, configurable: true }); } catch (x) {}' +
            'return f; })'
        );
        if (built.error) {
            built.error.dispose();
            return;
        }
        const bridge = realm.unwrapResult(built);
        const named = realm.newString(name);
        const counted = realm.newNumber(length);
        const result = realm.callFunction(bridge, realm.undefined, [made, named, counted]);
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
function nameAfter(host: VmHost, realm: QuickJSContext, made: QuickJSHandle, name: string): void {
    try {
        const built = realm.evalCode(
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
        const named = realm.newString(name);
        const result = realm.callFunction(bridge, realm.undefined, [made, named]);
        named.dispose();
        bridge.dispose();
        if (result.error) result.error.dispose();
        else result.value.dispose();
    } catch {
        // an object whose constructor will not wear the name crosses as the plain object it is
    }
}

/** `new Map()` or `new Set()` of the second realm, or undefined when it cannot be built. */
function emptyOf(host: VmHost, realm: QuickJSContext, name: string): QuickJSHandle | undefined {
    try {
        const built = realm.evalCode(`new ${name}()`);
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
    realm: QuickJSContext,
    value: QuickJSHandle,
    made: QuickJSHandle,
    isMap: boolean,
    depth: number,
    seen: QuickJSHandle[],
    twins: QuickJSHandle[],
    kept: QuickJSHandle[]
): void {
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
            const result = realm.callMethod(made, isMap ? 'set' : 'add', into);
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
function promiseOf(host: VmHost, realm: QuickJSContext, value: QuickJSHandle): QuickJSHandle {
    try {
        if (host.rehomeFn === undefined) {
            host.rehomeFn = host.context.newFunction('rehome', (settled) => {
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
        const built = realm.evalCode(
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
        const result = realm.callFunction(bridge, realm.undefined, [value, host.rehomeFn, guestPromise]);
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
    const result = host.context.callFunction(host.probes!.names, host.probes!.object, [value]);
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
        const result = context.callFunction(host.probes!.symbols, host.probes!.object, [value]);
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
function errorOf(host: VmHost, realm: QuickJSContext, name: string, ctor: string, message: string): QuickJSHandle | undefined {
    try {
        const kind = REALM_ERRORS.indexOf(name) >= 0 ? name : 'Error';
        /* `AggregateError` takes its errors first and its message second, so a message alone would
           be read as the iterable of errors: `new AggregateError('m')` came out with one error --
           the string's one character -- and an empty message. Its `errors` are copied by the walk. */
        const args = kind === 'AggregateError' ? `[], ${JSON.stringify(message)}` : JSON.stringify(message);
        const built = realm.evalCode(
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
     * Runs the code of a `vm` context inside the second realm, with the `with` scope the guest built
     * around its sandbox, and leaves what it answered at `api.vmOut` -- or what it threw at
     * `api.vmThrow` with `{ ok: false }`.
     *
     * The code has to run there and not in the guest's own realm: see {@link REALM_EXEC_SRC}. The
     * value comes back as it is, which is the whole point -- a value the context made is already of
     * another realm, so `instanceof` reads false for it outside, and it is the very object the
     * context made, so a value it hands back twice is one object.
     */
    'vm.exec': (_args, ctx) => {
        const host = hosts.get(ctx);
        if (!host) return { unbound: true };
        const { context } = host;
        const realm = realmOf(host);
        if (realm === undefined) return { unbound: true };
        if (host.execFn === undefined) {
            const built = realm.evalCode(REALM_EXEC_SRC);
            if (built.error) {
                built.error.dispose();
                return { unbound: true };
            }
            host.execFn = realm.unwrapResult(built);
        }
        const code = context.getProp(host.api, 'vmCode');
        const scope = context.getProp(host.api, 'vmScope');
        const fns = context.getProp(host.api, 'vmFns');
        const sb = context.getProp(host.api, 'vmSb');
        const self = context.getProp(host.api, 'vmSelf');
        try {
            const result = realm.callFunction(host.execFn, self, [scope, code, fns, sb]);
            if (result.error) {
                /* Whether the run was interrupted, which the guest cannot tell from the error alone:
                   QuickJS raises an interruption as an uncatchable InternalError, but this call is a
                   host boundary -- the throw the guest makes of what is handed back here is an
                   ordinary one its own catch blocks do see, so a vm.run deadline that stopped a
                   context would otherwise surface as that raw InternalError and not as the
                   ERR_SCRIPT_EXECUTION_TIMEOUT host Node 24.15 raises in the context's realm. */
                context.setProp(host.api, 'vmThrow', result.error);
                result.error.dispose();
                return { ok: false, fired: host.fired };
            }
            context.setProp(host.api, 'vmOut', result.value);
            result.value.dispose();
            return { ok: true };
        } catch {
            return { unbound: true };
        } finally {
            for (const handle of [code, scope, fns, sb, self]) {
                try { handle.dispose(); } catch { /* already gone with its context */ }
            }
        }
    },

    /**
     * Leaves the second realm's own ES globals at `api.vmEs`, under the names the guest's `with`
     * scope answers for: the code of a `vm` context runs in that realm, so the `Array` its `[]` is
     * an instance of has to be the realm's and not the caller's.
     */
    'vm.es': (_args, ctx) => {
        const host = hosts.get(ctx);
        if (!host) return { unbound: true };
        const realm = realmOf(host);
        if (realm === undefined) return { unbound: true };
        try {
            const built = realm.evalCode(
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
            const reader = realm.unwrapResult(built);
            const names = realm.unwrapResult(realm.evalCode(JSON.stringify(REALM_ES_NAMES)));
            const result = realm.callFunction(reader, realm.undefined, [names]);
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
    'vm.realm': (_args, ctx) => {
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
            const realm = realmOf(host);
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
