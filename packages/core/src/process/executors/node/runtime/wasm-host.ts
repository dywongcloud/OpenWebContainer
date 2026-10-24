import { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';

/**
 * Host side of the container's WebAssembly support.
 *
 * The guest engine has no WebAssembly: QuickJS is built without it, so `typeof WebAssembly`
 * is 'undefined' and every package that ships a .wasm binary fails at load. The worker this
 * container runs in does have it, so the guest gets a WebAssembly whose modules are compiled
 * and run here, in the host realm, while the guest keeps objects that behave like the real ones.
 *
 * The one thing that cannot be shared is memory. A guest value lives in the QuickJS heap and a
 * host ArrayBuffer lives outside it, and quickjs-emscripten copies an ArrayBuffer in both
 * directions rather than aliasing it. So a `WebAssembly.Memory` is a host memory plus a guest
 * shadow of the same size, and the two are made equal at every call boundary: whenever control
 * crosses between guest and host -- an export being called, or an import calling back into
 * guest code -- the bytes are copied across. Inside one wasm call the module sees ordinary
 * host memory and runs at full speed; the copy is O(memory size) per boundary crossing. The
 * copy is made in chunks rather than in one piece, so the peak is one memory plus a chunk and
 * not two whole memories -- a chunk is what the guest engine can allocate, a whole memory
 * twice over is not.
 *
 * Everything else follows from that. A module compiles and links here. Its exports are host
 * functions the guest reaches through `call`. Its imports are guest values: functions the host
 * calls back into (quickjs-emscripten allows a host call into the VM while the VM is calling
 * out), and memories, tables and globals that are synced like the memory above.
 *
 * Guest functions are kept alive by `retain`: a handle given to a host function dies when that
 * function returns, so it is copied into a host-owned object that outlives the call. That object is
 * the one thing here the host owns past the install, so the caller must dispose it (see
 * {@link WasmBridge.dispose}) before the context is freed.
 */

type SyncKind = 'mem' | 'glob' | 'tab';

/**
 * What `installWasmBridge` hands back.
 *
 * `api` is the `host.wasm` object: the caller owns it and disposes it once it has been set on the
 * host. `dispose` frees the retained-values object, and must run before the context is freed -- a
 * handle the host still holds then keeps its object alive, and QuickJS asserts on the objects still
 * live when the runtime is freed, which is what made every process end in that assertion.
 */
export interface WasmBridge {
    api: QuickJSHandle;
    dispose(): void;
}

interface InstanceRecord {
    instance: WebAssembly.Instance;
    memories: Set<number>;
    tables: Set<number>;
    globals: Set<number>;
    pull: number;
    push: number;
}

interface GuestThrowDetail {
    name: string;
    message: string;
    code?: string;
    /** Set when the guest threw a wasm exception rather than an error: the host exception's id. */
    exc?: number;
}

/** The exception-handling constructors, which a host without the proposal does not carry. */
interface WasmExceptionLike {
    is(tag: unknown): boolean;
    getArg(tag: unknown, index: number): number | bigint;
}
type WasmTagDescriptor = { parameters: string[] };

class GuestThrow extends Error {
    constructor(readonly detail: GuestThrowDetail) {
        super(detail.message);
    }
}

/** A wasm exception the guest threw. It is not an error: a handler in the module may catch it. */
class GuestException extends Error {
    constructor(readonly exceptionId: number) {
        super('WebAssembly.Exception');
    }
}

/** Installs `host.wasm`. See {@link WasmBridge} for what the caller owns. */
export function installWasmBridge(context: QuickJSContext): WasmBridge {
    const modules = new Map<number, WebAssembly.Module>();
    const instances = new Map<number, InstanceRecord>();
    const memories = new Map<number, WebAssembly.Memory>();
    const tables = new Map<number, WebAssembly.Table>();
    const globals = new Map<number, WebAssembly.Global>();
    const hostFns = new Map<number, (...args: Array<number | bigint | string>) => unknown>();
    const tags = new Map<number, unknown>();
    const tagParams = new Map<number, string[]>();
    const exceptions = new Map<number, WasmExceptionLike>();
    /** The tag an exception was built with, when it was built here. */
    const exceptionTag = new Map<number, number>();
    /** Guest values the host must keep: a handle argument dies with the call that received it. */
    const retained = context.newObject();
    let nextId = 1;
    const freshId = () => nextId++;

    const WasmTag = (WebAssembly as unknown as { Tag?: new (descriptor?: unknown) => unknown }).Tag;
    const WasmException = (WebAssembly as unknown as {
        Exception?: new (tag: unknown, payload?: Array<number | bigint>) => WasmExceptionLike;
    }).Exception;

    /**
     * The class the host itself raised.
     *
     * The bridge used to classify by where a failure happened -- a link-time failure became a
     * LinkError, a failure inside a call a RuntimeError -- which is not what the host does. A bad
     * import object and a Number for an i64 parameter are both bad *arguments*, and node raises
     * TypeError for both, while a link against an import that is present but not callable is the
     * one case that really is a LinkError. So the host's own class travels with the message and
     * the guest rebuilds it.
     */
    const errorNameOf = (error: unknown): string => {
        if (error instanceof WebAssembly.CompileError) return 'CompileError';
        if (error instanceof WebAssembly.LinkError) return 'LinkError';
        if (error instanceof WebAssembly.RuntimeError) return 'RuntimeError';
        if (error instanceof TypeError) return 'TypeError';
        if (error instanceof RangeError) return 'RangeError';
        if (error instanceof SyntaxError) return 'SyntaxError';
        return 'Error';
    };
    /** A host failure that carries the host's own class name, not one the bridge picks. */
    const hostFail = (code: string, error: unknown, message?: string) =>
        fail(code, message ?? (error instanceof Error ? error.message : String(error)), {
            name: errorNameOf(error)
        });

    /**
     * The API name inside a host message.
     *
     * The host builds these messages at the call site, so they name `WebAssembly.Instance()` --
     * that is the constructor this bridge links through -- while the guest may have reached it
     * through `WebAssembly.instantiate()`, whose message node names `WebAssembly.instantiate()`.
     * Only the prefix is rewritten; the rest of the sentence is the host's own.
     */
    const INSTANCE_PREFIX = 'WebAssembly.Instance()';
    const relabel = (message: string, label: string) =>
        message.slice(0, INSTANCE_PREFIX.length) === INSTANCE_PREFIX
            ? 'WebAssembly.' + label + '()' + message.slice(INSTANCE_PREFIX.length)
            : message;

    const api = context.newObject();
    const define = (name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle) => {
        const fn = context.newFunction(name, (...args: QuickJSHandle[]) => impl(...args));
        context.setProp(api, name, fn);
        fn.dispose();
    };
    const number = (handle: QuickJSHandle) => context.getNumber(handle);
    const text = (handle: QuickJSHandle) => context.getString(handle);
    const json = (value: unknown) => context.newString(JSON.stringify(value));
    const ok = (value: unknown) => json({ ok: true, value: value === undefined ? null : value });
    const fail = (code: string, message: string, props?: Record<string, unknown>) =>
        json({ ok: false, code, message, props });
    const parse = (handle: QuickJSHandle): unknown => {
        try {
            return JSON.parse(text(handle));
        } catch {
            return undefined;
        }
    };

    /** Copies a guest ArrayBuffer or typed array out of the QuickJS heap. */
    const bytesOf = (handle: QuickJSHandle): Uint8Array => {
        const lifetime = context.getArrayBuffer(handle);
        const view = lifetime.value;
        const copy = new Uint8Array(view.length);
        copy.set(view);
        lifetime.dispose();
        return copy;
    };    const bufferHandle = (bytes: Uint8Array): QuickJSHandle => context.newArrayBuffer(bytes.buffer as ArrayBuffer);

    const retainedHandle = (id: number): QuickJSHandle | undefined => {
        const handle = context.getProp(retained, String(id));
        if (context.typeof(handle) !== 'function') {
            handle.dispose();
            return undefined;
        }
        return handle;
    };

    /** Reads name/message/code off a guest error so the guest can rebuild a faithful error. */
    const detailOf = (handle: QuickJSHandle): GuestThrowDetail => {
        const read = (name: string): string | undefined => {
            const prop = context.getProp(handle, name);
            const value = context.typeof(prop) === 'string' ? context.getString(prop) : undefined;
            prop.dispose();
            return value;
        };
        const readNumber = (name: string): number | undefined => {
            const prop = context.getProp(handle, name);
            const value = context.typeof(prop) === 'number' ? context.getNumber(prop) : undefined;
            prop.dispose();
            return value;
        };
        const detail: GuestThrowDetail = {
            name: read('name') ?? 'Error',
            message: read('message') ?? 'the import threw',
            code: read('code'),
            exc: readNumber('__exc')
        };
        return detail;
    };

    /** Calls a retained guest function. Throws GuestThrow when the guest itself throws. */
    const callGuest = (id: number, args: QuickJSHandle[]): unknown => {
        const target = retainedHandle(id);
        if (!target) throw new GuestThrow({ name: 'Error', message: 'the import function is gone' });
        const result = context.callFunction(target, context.undefined, ...args);
        target.dispose();
        for (const arg of args) arg.dispose();
        if (result.error) {
            const detail = detailOf(result.error);
            result.error.dispose();
            /* A wasm exception is not an error: it goes to the module, which may catch it. */
            if (detail.exc !== undefined) throw new GuestException(detail.exc);
            throw new GuestThrow(detail);
        }
        const handle = result.value;
        const kind = context.typeof(handle);
        let value: unknown = null;
        if (kind === 'number') value = context.getNumber(handle);
        else if (kind === 'bigint') value = context.getBigInt(handle);
        else if (kind === 'string') value = context.getString(handle);
        else if (kind === 'boolean') value = context.dump(handle) === true;
        handle.dispose();
        return value;
    };

    /**
     * One wasm value, restored from the JSON form the guest sent.
     *
     * The JS API takes a BigInt for an i64 and a Number for everything else, and JSON has no
     * BigInt, so a BigInt travels as a string with a NUL and a 'b' in front -- no argument a
     * caller means as a number looks like that -- and is rebuilt here. A string the caller really
     * passed travels as a string with a NUL and an 's': it is handed to the API as it is, so the
     * API does its own conversion and raises its own error for a string that is not a number
     * ('x' for an i64 is a SyntaxError, not 'Cannot convert 0 to a BigInt'). Anything else is
     * coerced the way the JS API coerces it.
     */
    const wasmValue = (value: unknown): number | bigint | string => {
        if (typeof value === 'string' && value.charCodeAt(0) === 0) {
            return value.charCodeAt(1) === 98 ? BigInt(value.slice(2)) : value.slice(2);
        }
        return typeof value === 'number' ? value : Number(value);
    };

    /** The arguments of a wasm call, decoded from the guest's JSON. */
    const numberArgs = (args: unknown): Array<number | bigint | string> =>
        Array.isArray(args) ? args.map((value) => wasmValue(value)) : [];

    /**
     * A handle for one value the host hands to the guest.
     *
     * An i64 arrives here as a BigInt, the way the JS API hands it to an import function, and
     * `newNumber` refuses one: it converts through a C double, which is what throws 'Cannot
     * convert a BigInt value to a number' -- the error that stopped sql.js at module init,
     * since five of the functions it imports take an i64. A BigInt therefore goes into the
     * guest as a BigInt, and QuickJS sees the argument a browser would have passed it.
     */
    const valueHandle = (value: number | bigint): QuickJSHandle =>
        typeof value === 'bigint' ? context.newBigInt(value) : context.newNumber(value);

    // --- memory sync --------------------------------------------------------------------

    /**
     * The size of one piece of a memory sync.
     *
     * The two sides are made equal by copying the memory across, and a copy of the whole thing
     * costs a second memory's worth of bytes for the duration of the copy: with sql.js that is
     * 32-128 MB at once, which the guest engine cannot allocate. Moving the memory in pieces
     * keeps the peak at one memory plus one chunk, and the semantics are unchanged because the
     * pieces cover the memory end to end. Measured against 256 KiB and 4 MiB at 16-2048 pages,
     * 1 MiB is within noise of the faster of the two at every size while keeping the piece
     * small: 4 MiB halves the number of crossings but doubles what is live during the copy.
     */
    const SYNC_CHUNK_BYTES = 1048576;

    const ensurePages = (memory: WebAssembly.Memory, byteLength: number) => {
        const wanted = Math.ceil(byteLength / 65536);
        const current = memory.buffer.byteLength / 65536;
        if (wanted > current) memory.grow(wanted - current);
    };

    /**
     * Hands one piece of a guest value to `use`, which runs while the bytes are still live.
     *
     * `getArrayBuffer` returns a view over the bytes the runtime copied out of the guest heap,
     * and frees them when its lifetime is disposed, so the piece is consumed inside `use`
     * instead of being copied into a second host buffer first. A memory sync therefore pays one
     * copy out of the guest per piece rather than two. Returns the number of bytes handed over,
     * or 0 when the guest answered with something other than bytes.
     */
    const pullChunk = (
        record: InstanceRecord,
        kind: SyncKind,
        id: number,
        offset: number,
        length: number,
        use: (bytes: Uint8Array) => void
    ): number => {
        const target = retainedHandle(record.pull);
        if (!target) return 0;
        const kindHandle = context.newString(kind);
        const idHandle = context.newNumber(id);
        const offsetHandle = context.newNumber(offset);
        const lengthHandle = context.newNumber(length);
        const result = context.callFunction(target, context.undefined, kindHandle, idHandle, offsetHandle, lengthHandle);
        kindHandle.dispose();
        idHandle.dispose();
        offsetHandle.dispose();
        lengthHandle.dispose();
        target.dispose();
        if (result.error) {
            result.error.dispose();
            return 0;
        }
        const handle = result.value;
        let size = 0;
        if (context.typeof(handle) === 'object') {
            const lifetime = context.getArrayBuffer(handle);
            const bytes = lifetime.value;
            size = bytes.length;
            if (size > 0) use(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
            lifetime.dispose();
        } else if (context.typeof(handle) === 'number') {
            size = context.getNumber(handle);
        }
        handle.dispose();
        return size;
    };

    const pushToGuest = (record: InstanceRecord, kind: SyncKind, id: number, offset: number, make: () => QuickJSHandle) => {
        const target = retainedHandle(record.push);
        if (!target) return;
        const kindHandle = context.newString(kind);
        const idHandle = context.newNumber(id);
        const offsetHandle = context.newNumber(offset);
        const payload = make();
        const result = context.callFunction(target, context.undefined, kindHandle, idHandle, offsetHandle, payload);
        kindHandle.dispose();
        idHandle.dispose();
        offsetHandle.dispose();
        payload.dispose();
        target.dispose();
        if (result.error) result.error.dispose();
        else result.value.dispose();
    };

    /** A view over the memory's bytes. newArrayBuffer copies into the guest, so no extra copy here. */
    const hostMemoryBytes = (memory: WebAssembly.Memory): Uint8Array => new Uint8Array(memory.buffer);

    /**
     * One piece of the memory, as bytes the host can hand to the guest. A piece that is the whole
     * memory needs no copy: `newArrayBuffer` reads the bytes itself. Anything smaller does, since
     * a view over part of the buffer would carry the whole buffer with it.
     */
    const hostMemoryChunk = (memory: WebAssembly.Memory, offset: number, length: number): Uint8Array => {
        const buffer = memory.buffer;
        if (offset === 0 && length === buffer.byteLength) return new Uint8Array(buffer);
        return new Uint8Array(buffer, offset, length).slice();
    };

    /**
     * guest -> host, before the host runs wasm or an import. Tables and globals need no sync:
     * the guest writes them through to the host as it sets them. Memory is the one thing the
     * guest can change invisibly, by writing into its shadow.
     *
     * The shadow is read one chunk at a time and each chunk is written straight into the host
     * memory while the bytes the runtime copied out are still live, so at most one chunk exists
     * outside the two memories and no second host buffer is filled. A chunk shorter than the one
     * asked for means the shadow ended, which is also how a zero-page memory ends.
     */
    const syncIn = (record: InstanceRecord) => {
        for (const id of record.memories) {
            const memory = memories.get(id);
            if (!memory) continue;
            let offset = 0;
            while (true) {
                let moved = 0;
                pullChunk(record, 'mem', id, offset, SYNC_CHUNK_BYTES, (bytes) => {
                    moved = bytes.length;
                    if (offset + moved > memory.buffer.byteLength) ensurePages(memory, offset + moved);
                    const view = new Uint8Array(memory.buffer);
                    const room = Math.max(0, view.length - offset);
                    if (room > 0) view.set(bytes.subarray(0, Math.min(moved, room)), offset);
                });
                if (moved === 0) break;
                offset += moved;
                if (moved < SYNC_CHUNK_BYTES) break;
            }
        }
    };

    /** host -> guest, after wasm has run, a chunk at a time. */
    const syncOut = (record: InstanceRecord) => {
        for (const id of record.memories) {
            const memory = memories.get(id);
            if (!memory) continue;
            const total = memory.buffer.byteLength;
            for (let offset = 0; offset < total; offset += SYNC_CHUNK_BYTES) {
                const length = Math.min(SYNC_CHUNK_BYTES, total - offset);
                pushToGuest(record, 'mem', id, offset, () => bufferHandle(hostMemoryChunk(memory, offset, length)));
            }
        }
    };

    const tableEntriesJson = (table: WebAssembly.Table): string => {
        const entries: Array<{ i: number; k: 'fn' | 'null'; id?: number }> = [];
        for (let i = 0; i < table.length; i++) {
            const entry = table.get(i);
            if (typeof entry !== 'function') {
                entries.push({ i, k: 'null' });
                continue;
            }
            const id = freshId();
            hostFns.set(id, entry as (...args: Array<number | bigint | string>) => unknown);
            entries.push({ i, k: 'fn', id });
        }
        return JSON.stringify(entries);
    };

    /**
     * A wasm import that is a function: it may be a guest function (call back into the VM, syncing
     * memory either side of the call) or a function the host took out of a table.
     */
    const resolveImportFunction = (id: number): ((...args: Array<number | bigint | string>) => unknown) => {
        const hostFn = hostFns.get(id);
        if (hostFn) return hostFn;
        return (...args: Array<number | bigint | string>) => {
            const handles = args.map((value) => valueHandle(value as number | bigint));
            return callGuest(id, handles);
        };
    };

    // --- operations ----------------------------------------------------------------------

    define('validate', (bytes) => {
        try {
            const source = bytesOf(bytes);
            return WebAssembly.validate(source) ? context.true : context.false;
        } catch {
            return context.false;
        }
    });

    define('compile', (bytes) => {
        let source: Uint8Array;
        try {
            source = bytesOf(bytes);
        } catch {
            return fail('ERR_WASM_COMPILE', 'the argument is not a typed array or ArrayBuffer');
        }
        try {
            const id = freshId();
            modules.set(id, new WebAssembly.Module(source));
            return ok(id);
        } catch (error) {
            return hostFail('ERR_WASM_COMPILE', error);
        }
    });

    const describeModule = (module: WebAssembly.Module): string => {
        const shape = (list: readonly WebAssembly.ModuleImportDescriptor[] | readonly WebAssembly.ModuleExportDescriptor[]) =>
            list.map((entry) => ({ module: (entry as WebAssembly.ModuleImportDescriptor).module, name: entry.name, kind: entry.kind }));
        return JSON.stringify({ imports: shape(WebAssembly.Module.imports(module)), exports: shape(WebAssembly.Module.exports(module)) });
    };

    define('moduleShape', (id) => {
        const module = modules.get(number(id));
        return module ? context.newString(describeModule(module)) : fail('ERR_WASM', 'no such module');
    });

    define('instantiate', (moduleId, importsJson, pull, push, label) => {
        const module = modules.get(number(moduleId));
        if (!module) return fail('ERR_WASM', 'no such module');
        /* 'null' means no import object at all, which the host reports in its own words. */
        const rawImports = text(importsJson);
        const descriptor = rawImports === 'null'
            ? null
            : (parse(importsJson) as Record<string, Record<string, { k: string; id?: number; v?: number }>> | undefined);
        const api = context.typeof(label) === 'string' ? text(label) : 'Instance';
        const record: InstanceRecord = {
            instance: undefined as unknown as WebAssembly.Instance,
            memories: new Set(),
            tables: new Set(),
            globals: new Set(),
            pull: number(pull),
            push: number(push)
        };
        const imports: Record<string, Record<string, unknown>> = {};
        for (const [namespace, entries] of Object.entries(descriptor ?? {})) {
            const built: Record<string, unknown> = {};
            for (const [name, entry] of Object.entries(entries ?? {})) {
                if (entry.k === 'mem' && entry.id !== undefined && memories.has(entry.id)) {
                    record.memories.add(entry.id);
                    built[name] = memories.get(entry.id);
                } else if (entry.k === 'tab' && entry.id !== undefined && tables.has(entry.id)) {
                    record.tables.add(entry.id);
                    built[name] = tables.get(entry.id);
                } else if (entry.k === 'glob' && entry.id !== undefined && globals.has(entry.id)) {
                    record.globals.add(entry.id);
                    built[name] = globals.get(entry.id);
                } else if (entry.k === 'num') {
                    built[name] = entry.v;
                } else if (entry.k === 'fn' && entry.id !== undefined) {
                    built[name] = wrapImport(record, entry.id);
                }
            }
            imports[namespace] = built;
        }

        let instance: WebAssembly.Instance;
        try {
            instance = descriptor === null
                ? new WebAssembly.Instance(module)
                : new WebAssembly.Instance(module, imports as WebAssembly.Imports);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return hostFail('ERR_WASM_LINK', error, relabel(message, api));
        }
        record.instance = instance;

        const exports: Array<{ name: string; kind: string; id?: number }> = [];
        for (const entry of WebAssembly.Module.exports(module)) {
            const value = (instance.exports as Record<string, unknown>)[entry.name];
            if (value instanceof WebAssembly.Memory) {
                const id = freshId();
                memories.set(id, value);
                record.memories.add(id);
                exports.push({ name: entry.name, kind: 'memory', id });
            } else if (value instanceof WebAssembly.Table) {
                const id = freshId();
                tables.set(id, value);
                record.tables.add(id);
                exports.push({ name: entry.name, kind: 'table', id });
            } else if (value instanceof WebAssembly.Global) {
                const id = freshId();
                globals.set(id, value);
                record.globals.add(id);
                exports.push({ name: entry.name, kind: 'global', id });
            } else {
                exports.push({ name: entry.name, kind: 'function' });
            }
        }

        const id = freshId();
        instances.set(id, record);
        // The guest's shadow memories start equal to the module's, so nothing is stale at first call.
        syncOut(record);
        return ok({ id, exports });
    });

    /**
     * An import function: the module is calling out, so the memory goes the other way round
     * from an export -- the guest is shown what the module has written before the callback
     * runs, and what the guest writes comes back into the module before the module resumes.
     * A function taken out of a table runs here, on the host memory, so only the way back
     * needs a sync.
     */
    const wrapImport = (record: InstanceRecord, id: number) => {
        const hostFn = hostFns.get(id);
        if (hostFn) {
            return (...args: Array<number | bigint>) => {
                const value = hostFn(...args);
                syncOut(record);
                return value;
            };
        }
        return (...args: Array<number | bigint>) => {
            syncOut(record);
            let value: unknown;
            try {
                value = callGuest(id, args.map((arg) => valueHandle(arg)));
            } catch (error) {
                syncIn(record);
                /*
                 * The guest threw a wasm exception. The module must be handed the exception and
                 * not an error, or a handler in the module cannot catch it; an error here would
                 * travel out of the module uncaught instead.
                 */
                if (error instanceof GuestException) throw exceptions.get(error.exceptionId) ?? error;
                throw error;
            }
            syncIn(record);
            /* An import the module declared as returning an i64 gets the BigInt back: only a
               BigInt converts to an i64, the same as in a browser. */
            return typeof value === 'number' || typeof value === 'bigint' ? value : 0;
        };
    };

    define('call', (instanceId, name, argsJson) => {
        const record = instances.get(number(instanceId));
        if (!record) return fail('ERR_WASM', 'no such instance');
        const target = (record.instance.exports as Record<string, unknown>)[text(name)];
        if (typeof target !== 'function') return fail('ERR_WASM', 'no such export: ' + text(name));
        try {
            syncIn(record);
            const value = (target as (...args: Array<number | bigint | string>) => unknown)(...numberArgs(parse(argsJson)));
            syncOut(record);
            /*
             * An export the module declared as i64 answers a BigInt, the way the JS API gives it to
             * a caller, and JSON has no BigInt -- so it travels as the tagged string encodeValue
             * makes and the guest rebuilds it there. A Number here would lose every value past
             * 2**53 the moment the module handed it over, which is what an i64 export used to do.
             */
            return ok(value === undefined ? null : encodeValue(value));
        } catch (error) {
            if (error instanceof GuestThrow) {
                return fail('ERR_WASM_GUEST', error.detail.message, { name: error.detail.name, code: error.detail.code });
            }
            if (WasmException && error instanceof WasmException) {
                return fail('ERR_WASM_EXCEPTION', 'WebAssembly.Exception', exceptionProps(error as WasmExceptionLike));
            }
            return hostFail('ERR_WASM_TRAP', error);
        }
    });

    define('memoryNew', (initial, maximum) => {
        const pages = Math.max(0, Math.floor(number(initial)));
        const limit = Math.floor(number(maximum));
        try {
            const descriptor: WebAssembly.MemoryDescriptor = { initial: pages };
            if (limit >= 0) descriptor.maximum = limit;
            const id = freshId();
            memories.set(id, new WebAssembly.Memory(descriptor));
            return ok(id);
        } catch (error) {
            return hostFail('ERR_WASM', error);
        }
    });
    define('memoryPages', (id) => {
        const memory = memories.get(number(id));
        return memory ? ok(memory.buffer.byteLength / 65536) : fail('ERR_WASM', 'no such memory');
    });
    define('memoryGrow', (id, delta) => {
        const memory = memories.get(number(id));
        if (!memory) return fail('ERR_WASM', 'no such memory');
        try {
            const before = memory.buffer.byteLength / 65536;
            memory.grow(Math.max(0, Math.floor(number(delta))));
            return ok(before);
        } catch (error) {
            return hostFail('ERR_WASM', error);
        }
    });
    /**
     * Returns the host memory's bytes as an ArrayBuffer, or undefined for an unknown id. With an
     * offset and a length it returns just that piece: the guest seeds a shadow for a memory the
     * module created from these, and seeding a large one in one piece costs a second memory.
     */
    define('memoryRead', (id, offset, length) => {
        const memory = memories.get(number(id));
        if (!memory) return context.undefined;
        if (context.typeof(offset) !== 'number') return bufferHandle(hostMemoryBytes(memory));
        const total = memory.buffer.byteLength;
        const start = Math.max(0, Math.min(total, Math.floor(number(offset))));
        const size = Math.max(0, Math.min(total - start, Math.floor(number(length))));
        return bufferHandle(hostMemoryChunk(memory, start, size));
    });
    define('memoryWrite', (id, bytes) => {
        const memory = memories.get(number(id));
        if (!memory) return fail('ERR_WASM', 'no such memory');
        const source = bytesOf(bytes);
        ensurePages(memory, source.length);
        const view = new Uint8Array(memory.buffer);
        view.set(source.subarray(0, Math.min(source.length, view.length)));
        return ok(null);
    });

    define('tableNew', (element, initial, maximum) => {
        const limit = Math.floor(number(maximum));
        try {
            const descriptor: WebAssembly.TableDescriptor = { element: text(element) as 'anyfunc', initial: Math.max(0, Math.floor(number(initial))) };
            if (limit >= 0) descriptor.maximum = limit;
            const id = freshId();
            tables.set(id, new WebAssembly.Table(descriptor));
            return ok(id);
        } catch (error) {
            return hostFail('ERR_WASM', error);
        }
    });
    define('tableLength', (id) => {
        const table = tables.get(number(id));
        return table ? ok(table.length) : fail('ERR_WASM', 'no such table');
    });
    define('tableGrow', (id, delta) => {
        const table = tables.get(number(id));
        if (!table) return fail('ERR_WASM', 'no such table');
        try {
            return ok(table.grow(Math.max(0, Math.floor(number(delta)))));
        } catch (error) {
            return hostFail('ERR_WASM', error);
        }
    });
    define('tableGet', (id, index) => {
        const table = tables.get(number(id));
        if (!table) return fail('ERR_WASM', 'no such table');
        const entry = table.get(Math.floor(number(index)));
        if (typeof entry !== 'function') return ok({ k: 'null' });
        const fnId = freshId();
        hostFns.set(fnId, entry as (...args: Array<number | bigint | string>) => unknown);
        return ok({ k: 'fn', id: fnId });
    });
    define('tableSet', (id, index, value) => {
        const table = tables.get(number(id));
        if (!table) return fail('ERR_WASM', 'no such table');
        const entry = parse(value) as { k: string; id?: number } | undefined;
        const wanted = entry?.k === 'fn' && entry.id !== undefined ? resolveImportFunction(entry.id) : null;
        try {
            table.set(Math.floor(number(index)), wanted);
            return ok(null);
        } catch (error) {
            /*
             * A table of function type takes WebAssembly function objects only: this engine
             * refuses an ordinary JavaScript function, the way it refuses one from any host.
             * The guest keeps its function -- its own `get` still returns it, and the module
             * sees an empty slot -- so report the refusal instead of failing the set.
             */
            if (typeof wanted === 'function' && !hostFns.has(entry!.id!)) {
                return fail('ERR_WASM_TABLE_JSFN', error instanceof Error ? error.message : String(error));
            }
            return hostFail('ERR_WASM', error);
        }
    });
    define('tableDump', (id) => {
        const table = tables.get(number(id));
        return table ? context.newString(tableEntriesJson(table)) : fail('ERR_WASM', 'no such table');
    });

    define('globalNew', (type, mutable, value) => {
        try {
            const descriptor: WebAssembly.GlobalDescriptor = { value: text(type) as 'i32', mutable: context.dump(mutable) === true };
            const id = freshId();
            const global = new WebAssembly.Global(descriptor, descriptor.value === 'i64' ? BigInt(Math.trunc(number(value))) : number(value));
            globals.set(id, global);
            return ok(id);
        } catch (error) {
            return hostFail('ERR_WASM', error);
        }
    });
    define('globalGet', (id) => {
        const global = globals.get(number(id));
        if (!global) return fail('ERR_WASM', 'no such global');
        /* An i64 global's value is a BigInt on a host, and it travels tagged like any other i64. */
        return ok(encodeValue(global.value));
    });
    define('globalSet', (id, value) => {
        const global = globals.get(number(id));
        if (!global) return fail('ERR_WASM', 'no such global');
        try {
            global.value = typeof global.value === 'bigint' ? BigInt(Math.trunc(number(value))) : number(value);
            return ok(null);
        } catch (error) {
            return hostFail('ERR_WASM', error);
        }
    });

    // --- exception handling --------------------------------------------------------------

    /** A value for the guest: JSON has no BigInt, so a BigInt goes over as a tagged string. */
    const encodeValue = (value: unknown): unknown =>
        typeof value === 'bigint' ? '\u0000b' + value.toString() : value;

    /**
     * Everything the guest needs to hold an exception that came out of a module: its id, the tag
     * it answers `is` for when that tag was made here, and its payload -- which cannot be read
     * without the tag, so for an exception whose tag is the module's own the payload is left out
     * and the guest's `getArg` answers for itself.
     */
    const exceptionProps = (exception: WasmExceptionLike): Record<string, unknown> => {
        let id = 0;
        for (const [key, value] of exceptions) {
            if (value === exception) { id = key; break; }
        }
        if (id === 0) {
            id = freshId();
            exceptions.set(id, exception);
        }
        let tagId = exceptionTag.get(id) ?? 0;
        if (tagId === 0) {
            for (const [key, tag] of tags) {
                try {
                    if (exception.is(tag)) { tagId = key; break; }
                } catch { /* not this one */ }
            }
        }
        const props: Record<string, unknown> = { id, tag: tagId };
        const tag = tags.get(tagId);
        const params = tagParams.get(tagId);
        if (tag !== undefined && params !== undefined) {
            try {
                props.args = params.map((_type, index) => encodeValue(exception.getArg(tag, index)));
            } catch { /* the payload is not readable; the guest gets an empty one */ }
        }
        return props;
    };

    /** One payload value: an i64 wants a BigInt and everything else a Number, NaN becoming 0. */
    const payloadValue = (value: unknown): number | bigint => {
        if (typeof value === 'string' && value.charCodeAt(0) === 0) {
            return value.charCodeAt(1) === 98
                ? BigInt(value.slice(2))
                : (Number(value.slice(2)) || 0);
        }
        const number = Number(value);
        return Number.isNaN(number) ? 0 : number;
    };

    define('tagNew', (json) => {
        if (!WasmTag) return fail('ERR_WASM', 'WebAssembly.Tag: this host has no exception handling');
        const raw = text(json);
        const descriptor = raw === 'null' ? undefined : parse(json) as WasmTagDescriptor | undefined;
        try {
            /* Without a descriptor the call has no argument at all, which the host refuses in its
               own words; a descriptor goes through untouched, so every refusal is the host's. */
            const tag = descriptor === undefined ? new WasmTag() : new WasmTag(descriptor);
            const id = freshId();
            tags.set(id, tag);
            tagParams.set(id, descriptor !== undefined && Array.isArray(descriptor.parameters) ? descriptor.parameters : []);
            return ok(id);
        } catch (error) {
            return hostFail('ERR_WASM', error);
        }
    });

    define('exceptionNew', (tagId, argsJson) => {
        if (!WasmException) return fail('ERR_WASM', 'WebAssembly.Exception: this host has no exception handling');
        const id = Math.floor(number(tagId));
        const tag = tags.get(id);
        const raw = text(argsJson);
        const payload = raw === 'null'
            ? undefined
            : ((parse(argsJson) as unknown[] | undefined) ?? []).map((value) => payloadValue(value));
        try {
            /* A tag id of 0 stands for a first argument that is not a tag, which the host refuses
               in its own words, and no payload at all is the call it refuses as well. */
            const exception = payload === undefined
                ? new WasmException(tag ?? 0)
                : new WasmException(tag ?? 0, payload);
            const exceptionId = freshId();
            exceptions.set(exceptionId, exception);
            if (tag !== undefined) exceptionTag.set(exceptionId, id);
            return ok(exceptionId);
        } catch (error) {
            return hostFail('ERR_WASM', error);
        }
    });

    define('exceptionIs', (id, tagId) => {
        const exception = exceptions.get(number(id));
        if (!exception) return fail('ERR_WASM', 'no such exception');
        return ok(exception.is(tags.get(number(tagId)) ?? 0));
    });

    define('exceptionArg', (id, tagId, index) => {
        const exception = exceptions.get(number(id));
        if (!exception) return fail('ERR_WASM', 'no such exception');
        try {
            return ok(encodeValue(exception.getArg(tags.get(number(tagId)) ?? 0, Math.floor(number(index)))));
        } catch (error) {
            return hostFail('ERR_WASM', error);
        }
    });

    /** Calls a function the host holds: one taken from a table, or a retained guest function. */
    define('fnCall', (id, argsJson, instanceId) => {
        const fnId = number(id);
        const hostFn = hostFns.get(fnId);
        const record = instanceId ? instances.get(number(instanceId)) : undefined;
        if (!hostFn) {
            try {
                const guest = callGuest(fnId, numberArgs(parse(argsJson)).map((value) => valueHandle(value as number | bigint)));
                /* Same as an export: a BigInt a guest function answered travels tagged, not as a
                   Number, so a value past 2**53 survives the boundary. */
                return ok(guest === undefined ? null : encodeValue(guest));
            } catch (error) {
                if (error instanceof GuestThrow) {
                    return fail('ERR_WASM_GUEST', error.detail.message, { name: error.detail.name, code: error.detail.code });
                }
                if (error instanceof GuestException) {
                    const thrown = exceptions.get(error.exceptionId);
                    if (thrown) return fail('ERR_WASM_EXCEPTION', 'WebAssembly.Exception', exceptionProps(thrown));
                }
                return hostFail('ERR_WASM', error);
            }
        }
        try {
            if (record) syncIn(record);
            const value = hostFn(...numberArgs(parse(argsJson)));
            if (record) syncOut(record);
            /* A function taken out of a table is a wasm function: one the module declared as
               returning an i64 answers a BigInt, and it travels tagged for the same reason. */
            return ok(value === undefined ? null : encodeValue(value));
        } catch (error) {
            if (error instanceof GuestThrow) {
                return fail('ERR_WASM_GUEST', error.detail.message, { name: error.detail.name, code: error.detail.code });
            }
            if (WasmException && error instanceof WasmException) {
                return fail('ERR_WASM_EXCEPTION', 'WebAssembly.Exception', exceptionProps(error as WasmExceptionLike));
            }
            return hostFail('ERR_WASM_TRAP', error);
        }
    });

    define('retain', (value) => {
        const id = freshId();
        context.setProp(retained, String(id), value);
        return context.newNumber(id);
    });
    define('drop', (id) => {
        context.setProp(retained, String(number(id)), context.undefined);
        hostFns.delete(number(id));
        return context.undefined;
    });
    define('dispose', (id) => {
        const key = number(id);
        modules.delete(key);
        instances.delete(key);
        memories.delete(key);
        tables.delete(key);
        globals.delete(key);
        hostFns.delete(key);
        tags.delete(key);
        tagParams.delete(key);
        exceptions.delete(key);
        exceptionTag.delete(key);
        return context.undefined;
    });

    return {
        api,
        dispose() {
            if (retained.alive) retained.dispose();
        }
    };
}
