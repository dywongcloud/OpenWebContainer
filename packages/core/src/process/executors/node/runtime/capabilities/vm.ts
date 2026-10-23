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
     * A second realm: a second QuickJS context on the same runtime, made the first time a value has
     * to cross out of a `vm` context. Its intrinsics are its own -- `Array` here is not the guest's
     * `Array` -- because QuickJS gives each context its own set, while objects of one context are
     * usable from another of the same runtime. That is the whole of what Node's cross-realm
     * behaviour needs, and it is why a value from `runInContext` answers `false` to
     * `instanceof Array` while `Array.isArray` still answers `true`.
     */
    realm?: QuickJSContext;
    /** Values built in {@link VmHost.realm} and handed to the guest, freed with the binding. */
    realmValues: QuickJSHandle[];
    /** `Array.isArray`, `Object.prototype.toString`, `Object.keys` and `Object.prototype`, once. */
    probes?: VmProbes;
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

/** How deep a value is rebuilt in the second realm: past this it crosses as it is. */
const REALM_MAX_DEPTH = 8;
/** How many values one process rebuilds: past this they cross as they are, rather than pinning memory. */
const REALM_MAX_VALUES = 4096;

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

/** `Array.isArray`, `Object.prototype.toString`, `Object.getOwnPropertyNames` and `Object.prototype`, once. */
interface VmProbes {
    /** `Object` itself, the `this` of `Object.getOwnPropertyNames`. */
    object: QuickJSHandle;
    /** `Object.getOwnPropertyNames`: every own string key, enumerable or not. */
    names: QuickJSHandle;
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
    if (host.probes !== undefined) {
        for (const handle of [host.probes.object, host.probes.names, host.probes.isArray, host.probes.tag, host.probes.objectProto]) {
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

/** The second realm, made on the first value that has to cross, or undefined when it cannot be made. */
function realmOf(host: VmHost): QuickJSContext | undefined {
    if (host.realm !== undefined) return host.realm;
    try {
        host.realm = host.runtime.newContext();
        return host.realm;
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
 * Only arrays, plain objects, `Date`s and `RegExp`s are rebuilt. Everything else -- a function, a
 * `Map`, a class instance -- crosses as it is: a function's body belongs to the realm it was
 * compiled in and cannot be recompiled into another, and a live `Map` cannot be copied without
 * running code that could itself be interrupted. A value too deep, a cycle, or one past the cap on
 * rebuilt values also crosses as it is, so nothing here can grow without bound or loop.
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
    if (context.typeof(value) !== 'object') return value;
    if (depth >= REALM_MAX_DEPTH) return value;
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
        } else if (tag === '[object Object]') {
            made = realm.newObject();
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
            const error = errorOf(host, realm, name, message);
            if (error === undefined) return value;
            made = error;
        } else {
            return value;
        }
    } catch {
        return value;
    }
    pin(host, made);
    seen.push(value);
    twins.push(made);
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
 * The own string keys of `value`, read as `Object.getOwnPropertyNames` reads them.
 *
 * All of them, not only the enumerable ones: the properties that make an error what it is --
 * `message`, `stack`, `cause`, an `AggregateError`'s `errors` -- are own and non-enumerable, so an
 * enumerable-only walk handed back an error with none of them, which is not what host Node 24.15
 * does: it hands back the very object the context made, non-enumerable properties and all. Symbols
 * still do not cross, and are named in the Readme.
 */
function ownKeysOf(host: VmHost, value: QuickJSHandle): string[] {
    const result = host.context.callFunction(host.probes!.names, host.probes!.object, [value]);
    if (result.error) {
        result.error.dispose();
        return [];
    }
    const names = host.context.dump(result.value);
    result.value.dispose();
    if (!Array.isArray(names)) return [];
    return names.map((name) => String(name));
}

/** Keeps a value built in the second realm alive for as long as the binding does, and returns it. */
function pin(host: VmHost, value: QuickJSHandle): QuickJSHandle {
    host.realmValues.push(value);
    return value;
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
function errorOf(host: VmHost, realm: QuickJSContext, name: string, message: string): QuickJSHandle | undefined {
    try {
        const ctor = REALM_ERRORS.indexOf(name) >= 0 ? name : 'Error';
        /* `AggregateError` takes its errors first and its message second, so a message alone would
           be read as the iterable of errors: `new AggregateError('m')` came out with one error --
           the string's one character -- and an empty message. Its `errors` are copied by the walk. */
        const args = ctor === 'AggregateError' ? `[], ${JSON.stringify(message)}` : JSON.stringify(message);
        const built = realm.evalCode(
            `(function () {` +
            `var n = ${JSON.stringify(name)};` +
            `var m = ${JSON.stringify(message)};` +
            `var C = globalThis[${JSON.stringify(ctor)}];` +
            `var e = typeof C === 'function' ? new C(${args}) : new Error(m);` +
            `if (e.name !== n) e.name = n;` +
            /* A class the second realm has never heard of: an `Error` wearing its name still answers
               `Error` to `constructor.name`, where host Node hands back the context's own object and
               so reads the class. Give the rebuild a constructor of that name instead. */
            `var p = Object.getPrototypeOf(e);` +
            `if (!(p && p.constructor && p.constructor.name === n)) {` +
            `var S = function (mm) {` +
            `var o = new Error(mm);` +
            `Object.setPrototypeOf(o, S.prototype);` +
            `o.name = n;` +
            `return o; };` +
            `Object.setPrototypeOf(S.prototype, p || Error.prototype);` +
            `S.prototype.constructor = S;` +
            `try { Object.defineProperty(S, 'name', { value: n, configurable: true }); } catch (x) {}` +
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
        try {
            if (context.typeof(value) !== 'object' && context.typeof(value) !== 'function') return { rebuilt: false };
            const realm = realmOf(host);
            if (realm === undefined) return { rebuilt: false };
            const rebuilt = rehomeInto(host, realm, value, 0, [], [], kept);
            if (rebuilt === value) return { rebuilt: false };
            context.setProp(host.api, 'vmBack', rebuilt);
            return { rebuilt: true };
        } catch {
            return { rebuilt: false };
        } finally {
            value.dispose();
            for (const own of kept) {
                try { own.dispose(); } catch { /* already gone with its context */ }
            }
        }
    }
};
