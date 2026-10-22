import { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import { IFileSystem } from '../../../../filesystem';
import { NodeResolver, ResolveMode, dirnameOf } from './resolver';
import { base64ToBytes, bytesToBase64 } from '../../../../utils/bytes';
import { CapabilityEnvelope } from './capabilities/types';
import type { MaybeAsync } from './capabilities/dispatch';
import { installWasmBridge } from './wasm-host';

export interface HostBridgeDeps {
    fileSystem: IFileSystem;
    resolver: NodeResolver;
    pid: number;
    argv: string[];
    env: Record<string, string>;
    cwd: () => string;
    /** Changes the process's working directory; returns '' or an fs error code. */
    chdir: (path: string) => string;
    now: () => number;
    emitStdout: (text: string) => void;
    emitStderr: (text: string) => void;
    exit: (code: number) => void;
    setTimer: (id: number, ms: number) => void;
    clearTimer: (id: number) => void;
    /**
     * Synchronous capability call; returns an envelope -- or a promise of one, when the capability has
     * to wait on host work of its own and the guest is meant to suspend on it. QuickJS hands a promise
     * a host function returns to Asyncify, which unwinds the guest's stack and rewinds it when the
     * promise settles, so the guest stays inside the statement that called.
     */
    capability: (op: string, argsJson: string) => MaybeAsync<CapabilityEnvelope>;
    /**
     * Synchronous capability call over the binary channel: `bytes` is the payload, taken straight out
     * of the guest heap, so nothing encodes or decodes it. The JSON arguments carry metadata only.
     */
    capabilityBytes: (op: string, argsJson: string, bytes: Uint8Array) => CapabilityEnvelope;
    /** Asynchronous capability; the guest's pending operation `opId` is settled later. */
    startOperation: (op: string, argsJson: string, opId: number) => void;
    holdRef: (delta: number) => void;
    /**
     * Registers work that must run before the context is freed: a handle the host still holds then
     * keeps its object alive, and QuickJS asserts on the objects still live when the runtime is freed.
     */
    onTeardown: (dispose: () => void) => void;
    /** Evaluates an ES module synchronously for require(); returns '' or the failure text. */
    loadEsm: (file: string, token: number) => string;
    /**
     * Called on every call the guest makes into the host. A guest that reaches the host is not
     * running a runaway loop, so the runaway guard's clock starts again here.
     */
    onHostCall?: () => void;
}

class FsCodeError extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

/**
 * Builds the `host` object the guest bootstrap receives. Every function returns a
 * fresh handle (quickjs-emscripten disposes returned handles) and reports fs
 * failures as an error code string, which the guest turns into a Node-style error.
 */
export function installHostBridge(context: QuickJSContext, deps: HostBridgeDeps): QuickJSHandle {
    const host = context.newObject();
    const define = (name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle) => {
        const fn = context.newFunction(name, (...args: QuickJSHandle[]) => {
            deps.onHostCall?.();
            return impl(...args);
        });
        context.setProp(host, name, fn);
        fn.dispose();
    };
    /**
     * The one host call that can suspend. QuickJS takes a promise a host function returns as a request
     * to unwind: `newAsyncifiedFunction` is `newFunction` at runtime, and its type admits only a
     * function that always promises, which would suspend on every call. This one promises only when
     * the capability does, so the ordinary synchronous answer stays synchronous.
     */
    const defineSuspendable = (name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle | Promise<QuickJSHandle>) => {
        const asyncified = context as unknown as {
            newFunction(name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle | Promise<QuickJSHandle>): QuickJSHandle;
        };
        const fn = asyncified.newFunction(name, (...args: QuickJSHandle[]) => {
            deps.onHostCall?.();
            return impl(...args);
        });
        context.setProp(host, name, fn);
        fn.dispose();
    };
    const text = (handle: QuickJSHandle) => context.getString(handle);
    const nullable = (value: string | undefined | null) => (value === undefined || value === null ? context.null : context.newString(value));
    const guardFs = (action: () => void): string => {
        try {
            action();
            return '';
        } catch (error) {
            return error instanceof FsCodeError ? error.code : 'EIO';
        }
    };
    const requireParentDirectory = (file: string) => {
        if (deps.fileSystem.statPath(dirnameOf(file))?.type !== 'dir') throw new FsCodeError('ENOENT');
    };

    define('resolve', (specifier, fromDir, mode) => {
        const found = deps.resolver.resolve(text(specifier), text(fromDir), text(mode) as ResolveMode);
        return context.newString(found ?? '');
    });
    /* Why a resolve that found nothing found nothing, as JSON, or '' for a plain missing module.
       require() of a subpath no "exports" map defines throws ERR_PACKAGE_PATH_NOT_EXPORTED in Node,
       not MODULE_NOT_FOUND, and Node names the path that map named rather than the specifier. */
    define('resolveFailure', (specifier, fromDir, mode) => {
        const detail = deps.resolver.resolveDetailed(text(specifier), text(fromDir), text(mode) as ResolveMode);
        return context.newString(detail.kind === 'file' ? '' : JSON.stringify(detail));
    });
    /* The URL import.meta.resolve reports, or '' when the specifier names no URL at all. It does
       not look at the file system, the way Node's does not: './nope.mjs' names a URL whether or not
       the file is there. */
    define('resolveMeta', (specifier, fromDir) => {
        const url = deps.resolver.resolveUrlForMeta(text(specifier), text(fromDir));
        return context.newString(url ?? '');
    });
    define('isESM', (file) => (deps.resolver.isESM(text(file)) ? context.true : context.false));
    define('readText', (path) => nullable(safeRead(() => deps.fileSystem.readFile(text(path)))));
    define('readBase64', (path) => nullable(safeRead(() => {
        const bytes = deps.fileSystem.readBytes(text(path));
        return bytes ? bytesToBase64(bytes) : undefined;
    })));
    define('statJSON', (path) => nullable(safeRead(() => {
        const stat = deps.fileSystem.statPath(text(path));
        return stat ? JSON.stringify(stat) : undefined;
    })));
    define('readdirJSON', (path) => context.newString(JSON.stringify(deps.fileSystem.readdirNames(text(path)) ?? [])));
    /*
     * The mode a new name is created with, when the guest asked for one. Node masks a mode with the
     * process umask and applies it only when the name is created, never to one already there, and
     * the guest has already done the masking; a call that names no mode leaves the file system's
     * own default alone.
     */
    const optionalMode = (handle: QuickJSHandle): number | undefined => {
        if (handle === undefined) return undefined;
        const value = context.dump(handle);
        return typeof value === 'number' ? value : undefined;
    };
    define('writeBase64', (path, data, mode) => context.newString(guardFs(() => {
        const file = text(path);
        requireParentDirectory(file);
        if (deps.fileSystem.statPath(file)?.type === 'dir') throw new FsCodeError('EISDIR');
        deps.fileSystem.writeBytes(file, base64ToBytes(text(data)), optionalMode(mode));
    })));
    define('mkdir', (path, mode) => context.newString(guardFs(() => {
        deps.fileSystem.createDirectory(text(path), optionalMode(mode));
    })));
    define('rm', (path, recursive) => context.newString(guardFs(() => {
        const file = text(path);
        const recursiveRemoval = context.dump(recursive) === true;
        if (!recursiveRemoval && deps.fileSystem.statPath(file)?.type === 'dir' && (deps.fileSystem.readdirNames(file)?.length ?? 0) > 0) {
            throw new FsCodeError('ENOTEMPTY');
        }
        deps.fileSystem.removePath(file, recursiveRemoval);
    })));
    define('rename', (from, to) => context.newString(guardFs(() => {
        deps.fileSystem.renamePath(text(from), text(to));
    })));

    define('cwd', () => context.newString(deps.cwd()));
    /**
     * process.chdir: the working directory lives on the host, so the guest asks for the change
     * and gets back '' or the error code Node would report (ENOENT, ENOTDIR).
     */
    define('chdir', (path) => context.newString(deps.chdir(text(path))));
    define('pid', () => context.newNumber(deps.pid));
    define('argvJSON', () => context.newString(JSON.stringify(deps.argv)));
    define('envJSON', () => context.newString(JSON.stringify(deps.env)));
    define('now', () => context.newNumber(deps.now()));
    define('randomBase64', (size) => {
        const bytes = new Uint8Array(context.getNumber(size));
        crypto.getRandomValues(bytes);
        return context.newString(bytesToBase64(bytes));
    });
    define('stdout', (chunk) => {
        deps.emitStdout(text(chunk));
        return context.undefined;
    });
    define('stderr', (chunk) => {
        deps.emitStderr(text(chunk));
        return context.undefined;
    });
    define('exit', (code) => {
        deps.exit(context.getNumber(code));
        return context.undefined;
    });
    define('setTimer', (id, ms) => {
        deps.setTimer(context.getNumber(id), context.getNumber(ms));
        return context.undefined;
    });
    define('clearTimer', (id) => {
        deps.clearTimer(context.getNumber(id));
        return context.undefined;
    });
    /**
     * A synchronous capability. One that answers a promise instead of an envelope has host work of its
     * own to wait for, and the promise is handed to QuickJS as this function's result: Asyncify unwinds
     * the guest's stack there and rewinds it when the promise settles, so the guest stays inside the
     * statement that called and sees the envelope as the call's own answer.
     */
    defineSuspendable('cap', (op, args) => {
        const envelope = deps.capability(text(op), text(args));
        if (envelope instanceof Promise) {
            return envelope.then((settled) => context.newString(JSON.stringify(settled)));
        }
        return context.newString(JSON.stringify(envelope));
    });
    /**
     * The binary channel. The third argument is a guest ArrayBuffer: `getArrayBuffer` hands back a
     * view over the bytes the runtime copied out of the guest heap, and it is freed with its
     * lifetime, so the payload is copied into a host buffer here -- the one copy this direction pays,
     * in place of a base64 encode in the guest and a decode on this side.
     */
    define('capBytes', (op, args, bytes) => {
        const lifetime = context.getArrayBuffer(bytes);
        const view = lifetime.value;
        const copy = new Uint8Array(view.length);
        copy.set(view);
        lifetime.dispose();
        return context.newString(JSON.stringify(deps.capabilityBytes(text(op), text(args), copy)));
    });
    define('start', (op, args, opId) => {
        deps.startOperation(text(op), text(args), context.getNumber(opId));
        return context.undefined;
    });
    /**
     * Compiles one CommonJS module body into its wrapper function. The host compiles it rather
     * than an in-guest eval so the engine records `file` as the script name: eval'd code is named
     * `<input>`, which leaves every module's stack frames without a path and breaks packages that
     * find their binary from a stack frame (`bindings`, and anything built on it). Returns the
     * wrapper, or the compile failure's message as a string when the source does not parse.
     */
    define('compileCjs', (src, file) => {
        const result = context.evalCode(
            '(function (exports, require, module, __filename, __dirname) {' + text(src) + '\n})',
            text(file),
            { type: 'global' }
        );
        if (result.error) {
            const messageHandle = context.getProp(result.error, 'message');
            const message = context.typeof(messageHandle) === 'string' ? context.getString(messageHandle) : '';
            messageHandle.dispose();
            result.error.dispose();
            return context.newString(message);
        }
        return result.value;
    });
    /**
     * Compiles the body of a `new Function(...)` call into a function. The host compiles it for the
     * same reason it compiles a CommonJS body, and for one more: the engine names eval'd code
     * `<input>`, and a dynamic import written in a body with no path of its own is resolved from the
     * working directory, where Node resolves it from the file that created the function -- which is
     * why prettier's bin, whose `import()` sits in a `new Function` body, looked for its CLI in
     * `/internal/legacy-cli.mjs`. Returns the function, or the compile failure's message as a string.
     */
    define('compileFunction', (src, file) => {
        const result = context.evalCode(text(src), text(file), { type: 'global' });
        if (result.error) {
            const messageHandle = context.getProp(result.error, 'message');
            const message = context.typeof(messageHandle) === 'string' ? context.getString(messageHandle) : '';
            messageHandle.dispose();
            result.error.dispose();
            return context.newString(message);
        }
        return result.value;
    });
    define('esmLoad', (file, token) => context.newString(deps.loadEsm(text(file), context.getNumber(token))));
    define('ref', (delta) => {
        deps.holdRef(context.getNumber(delta));
        return context.undefined;
    });

    // WebAssembly: the guest engine has none, so modules compile and run here.
    const wasm = installWasmBridge(context);
    context.setProp(host, 'wasm', wasm.api);
    deps.onTeardown(wasm.dispose);
    wasm.api.dispose();

    return host;
}

function safeRead<T>(read: () => T | undefined): T | undefined {
    try {
        return read();
    } catch {
        return undefined;
    }
}

