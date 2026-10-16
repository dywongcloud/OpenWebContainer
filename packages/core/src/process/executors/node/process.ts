import { IFileSystem } from '../../../filesystem';
import { NetworkManager } from '../../../network/manager';
import { Process, ProcessEvent, ProcessState, ProcessType } from '../../base';
import { QuickJSAsyncWASMModule, QuickJSContext, QuickJSHandle, QuickJSRuntime, newQuickJSAsyncWASMModuleFromVariant } from 'quickjs-emscripten';
import variant from "@jitl/quickjs-singlefile-browser-release-asyncify"
import { BOOTSTRAP_SRC } from './runtime/bootstrap';
import { installHostBridge } from './runtime/host-bridge';
import { NodeResolver, dirnameOf, joinPaths, normalizeAbsolute } from './runtime/resolver';
import { RuntimeServices } from './runtime/services';
import { CapabilityContext, CapabilityEnvelope } from './runtime/capabilities/types';
import { errorEnvelope, invokeAsync, invokeSync } from './runtime/capabilities/dispatch';
import { CAPABILITIES } from './runtime/capabilities/index';
import { bindVmRuntime } from './runtime/capabilities/vm';
import { enterSyncRun, leaveSyncRun, nodeSyncRunner, sleepMs } from './pump';
import type { SyncChildRequest, SyncChildResult } from './pump';

const RESERVED_WORDS = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
    'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
    'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
    'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected',
    'public', 'await', 'arguments', 'eval'
]);

/** The QuickJS module the last boot loaded: a synchronous child boots on it, since it cannot await a new load. */
let lastQuickJs: QuickJSAsyncWASMModule | undefined;

/** A failure inside guest code, already formatted the way Node prints it. */
class GuestFailure extends Error {}

/**
 * One `node` process: a QuickJS guest with a Node-compatible CommonJS/ESM loader, built-in
 * modules and a host-driven event loop. The process lives while anything holds a ref
 * (armed timers, in-flight host operations, open sockets and servers); process.exit, a
 * fatal error or termination ends it.
 */
export class NodeProcess extends Process {
    private fileSystem: IFileSystem;
    private networkManager: NetworkManager;
    private services: RuntimeServices;
    private resolver: NodeResolver;
    private evalSource?: string;
    private quickJs?: QuickJSAsyncWASMModule;
    private runtime?: QuickJSRuntime;
    private context?: QuickJSContext;
    private api?: QuickJSHandle;
    private builtinNames = new Set<string>();
    private timers = new Map<number, ReturnType<typeof setTimeout>>();
    private refs = 0;
    private idleWaiter?: () => void;
    private exitRequested?: number;
    private fatalError?: unknown;
    private lastResolveError?: Error;
    private stopped = false;
    private capabilityContext: CapabilityContext;
    /** Set for a run inside a capability call (runToCompletionSync): timers and host operations are stepped there. */
    private syncMode = false;
    private syncTimers = new Map<number, number>();
    private syncSettles: { opId: number; envelope: CapabilityEnvelope }[] = [];
    private syncBlockedBy?: string;
    private syncTimedOut = false;
    /** Deliveries from children that finished inside this run, taken by the pump in order. */
    private syncTasks: (() => void)[] = [];

    constructor(
        pid: number,
        executablePath: string,
        args: string[],
        fileSystem: IFileSystem,
        networkManager: NetworkManager,
        services: RuntimeServices,
        parentPid?: number,
        cwd?: string,
        env: Record<string, string> = {},
        evalSource?: string
    ) {
        const processEnv = new Map<string, string>([
            ['PATH', '/bin:/usr/bin'],
            ['HOME', '/home'],
            ['PWD', cwd || '/'],
        ]);
        for (const [key, value] of Object.entries(env)) {
            processEnv.set(key, value);
        }
        super(pid, ProcessType.JAVASCRIPT, executablePath, args, parentPid, cwd, processEnv);
        this.fileSystem = fileSystem;
        this.networkManager = networkManager;
        this.services = services;
        this.resolver = new NodeResolver(fileSystem);
        this.evalSource = evalSource;
        this.capabilityContext = {
            pid,
            cwd: () => this.cwd ?? '/',
            env: () => Object.fromEntries(this.env),
            fileSystem,
            resolver: this.resolver,
            services,
            deliver: (targetId, name, payload) => {
                if (this.syncMode) {
                    this.syncTasks.push(() => this.deliver(targetId, name, payload));
                    return;
                }
                setTimeout(() => this.deliver(targetId, name, payload), 0);
            },
            holdRef: (delta) => this.holdRef(delta),
            output: (message) => this.emitGuestOutput(message)
        };
    }

    async execute(): Promise<void> {
        let code = 1;
        try {
            const entryPath = await this.bootGuest();
            this.startEntry(entryPath);
            await this.runEventLoop();
            code = this.finishProcess();
        } catch (error) {
            code = this.handleFatal(error);
        } finally {
            // peers of this process's sockets and listeners see end/close, as they do when a Node process exits
            this.services.network.releaseOwner(this.pid);
            this.disposeGuest();
        }
        if (!this.stopped) {
            this._exitCode = code;
            this._state = code === 0 ? ProcessState.COMPLETED : ProcessState.FAILED;
        }
    }

    protected async onTerminate(): Promise<void> {
        this.stopped = true;
        for (const handle of this.timers.values()) {
            clearTimeout(handle);
        }
        this.timers.clear();
        this.wakeIfIdle();
    }

    /** Delivery into this guest from the virtual network or a capability (VirtualSink). */
    deliver(targetId: number, name: string, payload: unknown): void {
        if (this.stopped || this.exitRequested !== undefined || this.context === undefined) return;
        try {
            const id = this.context.newNumber(targetId);
            const eventName = this.context.newString(name);
            const body = this.context.newString(JSON.stringify(payload === undefined ? null : payload));
            this.callApi('deliver', [id, eventName, body]).dispose();
            id.dispose();
            eventName.dispose();
            body.dispose();
            this.drainJobs();
        } catch (error) {
            this.fatalError = error;
        }
        this.wakeIfIdle();
    }

    /** Keep-alive accounting (VirtualSink): the event loop runs while the count is positive. */
    holdRef(delta: number): void {
        this.refs = Math.max(0, this.refs + delta);
        if (this.refs === 0) this.wakeIfIdle();
    }

    private resolveEntry(): string {
        const cwd = this.cwd ?? '/';
        const spec = this.executablePath.startsWith('/') ? this.executablePath : './' + this.executablePath;
        const found = this.resolver.resolve(spec, cwd, 'require');
        if (!found) throw new Error(`Cannot find module '${normalizeAbsolute(joinPaths(cwd, this.executablePath))}'`);
        return found;
    }

    /**
     * Creates the QuickJS runtime and the guest, and resolves the entry. The first await comes
     * before any failure can happen, so the parent always sees this process's exit events.
     */
    private async bootGuest(): Promise<string | undefined> {
        const QuickJS = await newQuickJSAsyncWASMModuleFromVariant(variant);
        lastQuickJs = QuickJS;
        return this.bootWith(QuickJS);
    }

    /** Everything after the module load has no suspension point, so a synchronous run boots through it too. */
    private bootWith(QuickJS: QuickJSAsyncWASMModule): string | undefined {
        const entryPath = this.evalSource === undefined ? this.resolveEntry() : undefined;
        this.quickJs = QuickJS;
        const runtime = QuickJS.newRuntime();
        this.runtime = runtime;
        runtime.setModuleLoader(
            (moduleName) => this.loadModule(moduleName),
            (baseName, requestedName) => this.normalizeModule(baseName, requestedName)
        );

        const context = runtime.newContext();
        this.context = context;

        const argv = entryPath !== undefined
            ? ['/usr/local/bin/node', entryPath, ...this.args]
            : ['/usr/local/bin/node', ...this.args];
        const host = installHostBridge(context, {
            fileSystem: this.fileSystem,
            resolver: this.resolver,
            pid: this.pid,
            argv,
            env: Object.fromEntries(this.env),
            cwd: () => this.cwd ?? '/',
            now: () => performance.now(),
            emitStdout: (text) => this.emitGuestOutput({ stdout: text }),
            emitStderr: (text) => this.emitGuestOutput({ stderr: text }),
            exit: (exitCode) => this.requestExit(exitCode),
            setTimer: (id, ms) => this.armTimer(id, ms),
            clearTimer: (id) => this.disarmTimer(id),
            capability: (op, argsJson) => invokeSync(op, argsJson, this.capabilityContext),
            startOperation: (op, argsJson, opId) => this.startOperation(op, argsJson, opId),
            holdRef: (delta) => this.holdRef(delta),
            loadEsm: (file, token) => this.loadEsmSync(file, token)
        });

        const bootstrap = context.unwrapResult(context.evalCode(BOOTSTRAP_SRC, 'owc-bootstrap.js', { type: 'global' }));
        const api = context.unwrapResult(context.callFunction(bootstrap, context.undefined, [host]));
        bootstrap.dispose();
        host.dispose();
        this.api = api;
        bindVmRuntime(this.capabilityContext, runtime, context, api);
        this.builtinNames = new Set<string>(JSON.parse(this.callApiString('builtinNames')));
        return entryPath;
    }

    /** Runs an async capability; its envelope is settled back into the guest on a later macrotask. */
    private startOperation(op: string, argsJson: string, opId: number): void {
        if (this.syncMode) {
            this.startOperationSync(op, argsJson, opId);
            return;
        }
        this.holdRef(1);
        invokeAsync(op, argsJson, this.capabilityContext, (envelope: CapabilityEnvelope) => {
            this.settleOperation(opId, envelope);
        });
    }

    /**
     * Synchronous run: a capability that answers now settles on the next pump step. One that returns a promise has
     * started its work and cannot be awaited here, so it blocks the run.
     */
    private startOperationSync(op: string, argsJson: string, opId: number): void {
        this.holdRef(1);
        const envelope = invokeNow(op, argsJson, this.capabilityContext);
        if (envelope === undefined) {
            this.syncBlockedBy = op;
            return;
        }
        this.syncSettles.push({ opId, envelope });
    }

    /**
     * Runs this process to completion inside the capability call that spawned it (child_process.spawnSync). The guest
     * boots and its entry starts here; the pump then steps guest jobs, due timers and synchronous host operations
     * until nothing refs the process, the deadline passes (the process is killed) or only asynchronous host work is
     * left (blocked names it). Output reaches the caller's MESSAGE listener as the guest writes it.
     */
    runToCompletionSync(deadline: number, killSignal: string): { status: number | null; signal: string | null; timedOut: boolean; blocked?: string } {
        this.syncMode = true;
        enterSyncRun();
        const result: { status: number | null; signal: string | null; timedOut: boolean; blocked?: string } = { status: 1, signal: null, timedOut: false };
        try {
            const QuickJS = lastQuickJs;
            if (QuickJS === undefined) throw new Error('no QuickJS module is loaded');
            this.startEntry(this.bootWith(QuickJS));
            const blocked = this.pumpSync(deadline);
            if (blocked !== undefined) {
                result.blocked = blocked;
            } else if (this.syncTimedOut) {
                result.timedOut = true;
                result.status = null;
                result.signal = killSignal;
            } else {
                if (this.fatalError !== undefined) throw this.fatalError;
                result.status = this.finishProcess();
            }
        } catch (error) {
            result.status = this.handleFatal(error);
        } finally {
            this.services.network.releaseOwner(this.pid);
            this.disposeGuest();
            leaveSyncRun();
        }
        return result;
    }

    /**
     * The synchronous event loop, one step at a time. Returns undefined when nothing refs the process any more, the
     * process exited, or the deadline passed (syncTimedOut is set); otherwise the reason it cannot make progress.
     */
    private pumpSync(deadline: number): string | undefined {
        for (;;) {
            if (this.exitRequested !== undefined || this.fatalError !== undefined || this.stopped) return undefined;
            const task = this.syncTasks.shift();
            if (task !== undefined) {
                task();
                continue;
            }
            const settle = this.syncSettles.shift();
            if (settle !== undefined) {
                this.settleOperation(settle.opId, settle.envelope);
                continue;
            }
            if (this.refs === 0) return undefined;
            const now = performance.now();
            if (now >= deadline) {
                this.syncTimedOut = true;
                return undefined;
            }
            let nextId = -1;
            let nextAt = Infinity;
            for (const [id, at] of this.syncTimers) {
                if (at < nextAt) {
                    nextAt = at;
                    nextId = id;
                }
            }
            if (nextId >= 0 && nextAt <= now) {
                this.syncTimers.delete(nextId);
                this.onTimerFired(nextId);
                continue;
            }
            if (nextId >= 0) {
                sleepMs(Math.min(nextAt, deadline) - now);
                continue;
            }
            return this.syncBlockedBy ?? 'a pending host operation';
        }
    }

    private settleOperation(opId: number, envelope: CapabilityEnvelope): void {
        this.holdRef(-1);
        if (this.stopped || this.exitRequested !== undefined || this.context === undefined) return;
        try {
            const id = this.context.newNumber(opId);
            const body = this.context.newString(JSON.stringify(envelope));
            this.callApi('settle', [id, body]).dispose();
            id.dispose();
            body.dispose();
            this.drainJobs();
        } catch (error) {
            this.fatalError = error;
        }
        this.wakeIfIdle();
    }

    /**
     * require() of an ES module: evaluates it as a module whose namespace is recorded under
     * `token`. A graph with top-level await leaves the record unset; the guest reports that.
     */
    private loadEsmSync(file: string, token: number): string {
        const context = this.context!;
        const source = `import * as __owc_ns from ${JSON.stringify(file)};\n` +
            `globalThis.__owc_esm_registry = globalThis.__owc_esm_registry || Object.create(null);\n` +
            `globalThis.__owc_esm_registry[${token}] = __owc_ns;\n`;
        const result = context.evalCode(source, `${file}?owc-require`, { type: 'module' });
        if (result.error) {
            const failure = String(context.dump(result.error));
            result.error.dispose();
            return failure;
        }
        result.value.dispose();
        this.drainJobs();
        return '';
    }

    private startEntry(entryPath: string | undefined): void {
        if (this.evalSource !== undefined) {
            const source = this.context!.newString(this.evalSource);
            this.callApi('runEval', [source]).dispose();
            source.dispose();
        } else if (entryPath !== undefined && this.resolver.isESM(entryPath)) {
            this.runEsmEntry(entryPath);
        } else {
            const file = this.context!.newString(entryPath!);
            this.callApi('runMain', [file]).dispose();
            file.dispose();
        }
        this.drainJobs();
    }

    private runEsmEntry(entryPath: string): void {
        const context = this.context!;
        const source = this.esmSource(this.fileSystem.readFile(entryPath) ?? '', entryPath, true);
        const result = context.evalCode(source, entryPath, { type: 'module' });
        if (result.error) throw this.guestFailure(result.error);
        const promise = result.value;
        this.drainJobs();
        try {
            const state = context.getPromiseState(promise);
            if (state.type === 'rejected') throw this.guestFailure(state.error);
        } catch (error) {
            if (error instanceof GuestFailure) throw error;
        } finally {
            promise.dispose();
        }
    }

    private finishProcess(): number {
        const exitCode = this.readFinalExitCode();
        this.safeEmitExit(exitCode);
        return this.readFinalExitCode();
    }

    private handleFatal(error: unknown): number {
        if (this.exitRequested !== undefined) {
            const code = this.exitRequested;
            this.safeEmitExit(code);
            return code;
        }
        if (this.stopped) return -1;
        const message = error instanceof GuestFailure
            ? error.message
            : error instanceof Error ? (error.stack ?? error.message) : String(error);
        this.emitGuestOutput({ stderr: message + '\n' });
        return 1;
    }

    /** Runs until no ref is held, process.exit runs, a fatal error occurs, or the process is stopped. */
    private async runEventLoop(): Promise<void> {
        while (this.refs > 0 && this.exitRequested === undefined && this.fatalError === undefined && !this.stopped) {
            await new Promise<void>((resolve) => {
                this.idleWaiter = resolve;
            });
        }
        if (this.fatalError !== undefined) throw this.fatalError;
    }

    /** Host timers only schedule; guest timers hold refs themselves while armed and ref'd. */
    private armTimer(id: number, ms: number): void {
        if (this.syncMode) {
            this.syncTimers.set(id, performance.now() + Math.max(0, ms));
            return;
        }
        const existing = this.timers.get(id);
        if (existing !== undefined) clearTimeout(existing);
        this.timers.set(id, setTimeout(() => this.onTimerFired(id), ms));
    }

    private disarmTimer(id: number): void {
        this.syncTimers.delete(id);
        const existing = this.timers.get(id);
        if (existing !== undefined) clearTimeout(existing);
        this.timers.delete(id);
    }

    private onTimerFired(id: number): void {
        this.timers.delete(id);
        if (this.stopped || this.exitRequested !== undefined) {
            this.wakeIfIdle();
            return;
        }
        try {
            const idArg = this.context!.newNumber(id);
            this.callApi('fire', [idArg]).dispose();
            idArg.dispose();
            this.drainJobs();
        } catch (error) {
            this.fatalError = error;
        }
        this.wakeIfIdle();
    }

    private wakeIfIdle(): void {
        const done = this.refs === 0 || this.exitRequested !== undefined || this.fatalError !== undefined || this.stopped;
        if (!done) return;
        const waiter = this.idleWaiter;
        this.idleWaiter = undefined;
        waiter?.();
    }

    private requestExit(code: number): void {
        this.exitRequested = code;
        for (const handle of this.timers.values()) {
            clearTimeout(handle);
        }
        this.timers.clear();
        this.wakeIfIdle();
    }

    private emitGuestOutput(message: { stdout?: string; stderr?: string }): void {
        if (this.exitRequested !== undefined || this.stopped) return;
        this.emit(ProcessEvent.MESSAGE, message);
    }

    private safeEmitExit(code: number): void {
        try {
            const arg = this.context!.newNumber(code);
            this.callApi('emitExit', [arg]).dispose();
            arg.dispose();
        } catch {
            // exit listeners that throw must not mask the exit status
        }
    }

    private readFinalExitCode(): number {
        const value = this.callApi('finalExitCode', []);
        const code = this.context!.getNumber(value);
        value.dispose();
        return code;
    }

    /**
     * Runs guest work until nothing is pending: process.nextTick callbacks at each checkpoint, then
     * the promise queue as one batch, as Node orders them. An exception that escaped a callback
     * arrives from the guest as text and ends the process.
     */
    private drainJobs(): void {
        const runtime = this.runtime!;
        for (;;) {
            const pending = this.callApi('drainTicks', []);
            const uncaught = this.context!.dump(pending);
            pending.dispose();
            if (typeof uncaught === 'string') throw new GuestFailure(uncaught);
            if (!runtime.hasPendingJob()) break;
            // the promise queue drains as one batch, as V8 does; ticks queued by those jobs wait for the batch
            const result = runtime.executePendingJobs(10000);
            if (result.error) throw this.guestFailure(result.error);
        }
    }

    private callApi(name: string, args: QuickJSHandle[]): QuickJSHandle {
        const context = this.context!;
        const api = this.api!;
        const fn = context.getProp(api, name);
        try {
            const result = context.callFunction(fn, api, args);
            if (result.error) throw this.guestFailure(result.error);
            return result.value;
        } finally {
            fn.dispose();
        }
    }

    private callApiString(name: string, args: QuickJSHandle[] = []): string {
        const value = this.callApi(name, args);
        const text = this.context!.getString(value);
        value.dispose();
        return text;
    }

    /** Formats a guest exception with the guest's own formatter, then disposes the handle. */
    private guestFailure(errorHandle: QuickJSHandle): GuestFailure {
        const context = this.context!;
        let message: string;
        try {
            const formatter = context.getProp(this.api!, 'formatUncaught');
            const result = context.callFunction(formatter, this.api!, [errorHandle]);
            formatter.dispose();
            if (result.error) {
                result.error.dispose();
                message = String(context.dump(errorHandle));
            } else {
                message = context.getString(result.value);
                result.value.dispose();
            }
        } catch {
            message = String(context.dump(errorHandle));
        }
        errorHandle.dispose();
        return new GuestFailure(message);
    }

    private loadModule(moduleName: string): { value: string } | { error: Error } {
        if (moduleName === '') {
            // QuickJS loads an empty name only after the normalizer failed; surface that failure
            return { error: this.lastResolveError ?? new Error('Cannot resolve module') };
        }
        try {
            if (moduleName.startsWith('builtin:')) {
                return { value: this.syntheticModule(moduleName.slice('builtin:'.length), true) };
            }
            if (moduleName.startsWith(ERROR_MODULE_PREFIX)) {
                return { value: errorModuleSource(moduleName) };
            }
            if (moduleName.endsWith('.json')) {
                return { value: `export default ${this.readRequired(moduleName)};` };
            }
            if (this.resolver.isESM(moduleName)) {
                return { value: this.esmSource(this.readRequired(moduleName), moduleName, false) };
            }
            return { value: this.syntheticModule(moduleName, false) };
        } catch (error) {
            return { error: error as Error };
        }
    }

    /**
     * The ES module source the engine compiles: prepareEsmSource, then the guest's compatibility
     * rewrite (the one the CommonJS loader retries with after a SyntaxError) when the source may hold
     * a class element named get, set or async. The rewrite is used only when it changes the source
     * and the engine fails to parse the source as it is; a source that parses reaches the engine
     * unchanged.
     */
    private esmSource(source: string, file: string, isMain: boolean): string {
        const prepared = prepareEsmSource(source, file, isMain);
        if (!CLASS_ELEMENT_CANDIDATE.test(prepared)) return prepared;
        const sourceArg = this.context!.newString(prepared);
        let rewritten: string;
        try {
            rewritten = this.callApiString('compatRewrite', [sourceArg]);
        } finally {
            sourceArg.dispose();
        }
        return rewritten === prepared || this.parsesAsModule(prepared, file) ? prepared : rewritten;
    }

    /**
     * Whether the engine parses `source` as an ES module, checked without running it: a module that
     * fails to parse cannot be recompiled. A throwaway runtime compiles a probe module importing
     * `file` (answered with `source`, compiled as any import is; its own imports get empty modules),
     * then a module whose load fails, so nothing links or runs and nothing reaches the guest. Only a
     * SyntaxError means `source` does not parse. Compile-only module evaluation is not used: in
     * quickjs-emscripten 0.32 it reads an uninitialized module pointer.
     */
    private parsesAsModule(source: string, file: string): boolean {
        const runtime = this.quickJs!.newRuntime();
        runtime.setModuleLoader((name) => {
            if (name === PARSE_CHECK_STOP) return { error: new Error(PARSE_CHECK_STOP) };
            return name === file ? source : '';
        });
        const context = runtime.newContext();
        try {
            const probe = `import ${JSON.stringify(file)};\nimport ${JSON.stringify(PARSE_CHECK_STOP)};\n`;
            const result = context.evalCode(probe, PARSE_CHECK_ENTRY, { type: 'module' });
            const failure = result.error ? context.dump(result.error) as { name?: unknown } | undefined : undefined;
            result.dispose();
            return failure?.name !== 'SyntaxError';
        } finally {
            context.dispose();
            runtime.dispose();
        }
    }

    /** Maps a specifier to the module name QuickJS will load (a plain string on success). */
    private normalizeModule(baseName: string | undefined, requestedName: string): string | { error: Error } {
        const missingAttribute = requestedName.endsWith(MISSING_ATTRIBUTE_MARK);
        const spec = missingAttribute ? requestedName.slice(0, -MISSING_ATTRIBUTE_MARK.length) : requestedName;
        const bare = spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
        if (this.builtinNames.has(bare)) return `builtin:${bare}`;
        const baseDir = baseName && baseName.startsWith('/') ? dirnameOf(baseName) : (this.cwd ?? '/');
        const found = this.resolver.resolve(spec, baseDir, 'import');
        if (!found) {
            this.lastResolveError = new Error(`Cannot find module '${spec}'${baseName ? ` imported from ${baseName}` : ''}`);
            return { error: this.lastResolveError };
        }
        if (missingAttribute) {
            // a .json import without `with { type: 'json' }`: evaluating the module throws ERR_IMPORT_ATTRIBUTE_MISSING
            return ERROR_MODULE_PREFIX + encodeURIComponent(JSON.stringify({
                code: 'ERR_IMPORT_ATTRIBUTE_MISSING',
                message: `Module "${toFileUrl(found)}" needs an import attribute of "type: json"`,
            }));
        }
        return found;
    }

    /**
     * ES module wrapper for a CommonJS module or built-in: default export is the
     * exports object, and each enumerable export is re-exported by name.
     */
    private syntheticModule(id: string, builtin: boolean): string {
        // a built-in exposes its own enumerable keys; a CommonJS file exposes the names its source declares
        const keys = builtin ? this.builtinExportKeys(id) : [...this.cjsExportNames(id, new Set<string>())];
        let source = `const __owc_m = __owc_api.exportsOf(${JSON.stringify(id)}, ${builtin});\nexport default __owc_m;\n`;
        for (const key of keys) {
            if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && !RESERVED_WORDS.has(key) && key !== 'default' && !key.startsWith('__owc')) {
                source += `export const ${key} = __owc_m[${JSON.stringify(key)}];\n`;
            }
        }
        return source;
    }

    /** Export names of a CommonJS file, scanned from its source (never executed), following its re-exports. */
    private cjsExportNames(file: string, seen: Set<string>): Set<string> {
        const names = new Set<string>();
        if (seen.has(file)) return names;
        seen.add(file);
        const scan = scanCjsExports(this.fileSystem.readFile(file) ?? '');
        scan.names.forEach((name) => names.add(name));
        for (const spec of scan.reexports) {
            const bare = spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
            if (this.builtinNames.has(bare)) {
                this.builtinExportKeys(bare).forEach((key) => names.add(key));
                continue;
            }
            const found = this.resolver.resolve(spec, dirnameOf(file), 'require');
            if (found !== undefined && !found.endsWith('.json')) {
                this.cjsExportNames(found, seen).forEach((name) => names.add(name));
            }
        }
        return names;
    }

    private builtinExportKeys(id: string): string[] {
        const idArg = this.context!.newString(id);
        const builtinArg = this.context!.newNumber(1);
        try {
            return JSON.parse(this.callApiString('keysOf', [idArg, builtinArg])) as string[];
        } finally {
            idArg.dispose();
            builtinArg.dispose();
        }
    }

    private readRequired(file: string): string {
        const text = this.fileSystem.readFile(file);
        if (text === undefined) throw new Error(`Cannot find module '${file}'`);
        return text;
    }

    private disposeGuest(): void {
        for (const handle of this.timers.values()) {
            clearTimeout(handle);
        }
        this.timers.clear();
        if (this.api) {
            this.api.dispose();
            this.api = undefined;
        }
        this.context?.dispose();
        this.context = undefined;
        try {
            // Teardown is best-effort: a leaked guest object must not change the process status
            this.runtime?.dispose();
        } catch {
            // QuickJS asserts on leaked objects at teardown; the process already has its result
        }
        this.runtime = undefined;
    }
}

// ---------------------------------------------------------------------------
// ES module sources and CommonJS export names, prepared on the host. QuickJS does not
// populate import.meta, does not parse import attributes, and does not export names bound
// by destructuring patterns, so module sources are rewritten by a small tokenizer before
// they compile. CommonJS export names are scanned from source the way cjs-module-lexer
// does, so the module is not executed to find them.
// ---------------------------------------------------------------------------

/** Appended to the specifier of a .json import that has no `with { type: 'json' }` attribute. */
const MISSING_ATTRIBUTE_MARK = '\u0001owc-attr-missing';
/** Module-name prefix of a synthetic module whose evaluation throws a recorded error. */
const ERROR_MODULE_PREFIX = 'owc-error:';
/**
 * get, set or async followed by a semicolon or a comment: a cheap superset of the class elements the
 * guest's compatibility rewrite quotes, so its slower scan runs only on sources that may hold one.
 */
const CLASS_ELEMENT_CANDIDATE = /\b(?:get|set|async)\s*(?:;|\/[/*])/;
/** Module names of parsesAsModule's probe; the scheme prefix keeps them apart from file paths. */
const PARSE_CHECK_ENTRY = 'owc:parse-check';
const PARSE_CHECK_STOP = 'owc:parse-check-stop';

interface JsToken {
    t: 'id' | 'str' | 'num' | 'punc' | 'tpl' | 're';
    v: string;
    s: number;
    e: number;
    nl: boolean;
}

interface SourceEdit {
    start: number;
    end: number;
    text: string;
}

interface CjsExportScan {
    names: Set<string>;
    reexports: string[];
}

class BindingPatternError extends Error {}

const PUNCTUATORS = [
    '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
    '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=',
    '&=', '|=', '^=', '**', '<<', '>>',
];
const REGEX_AFTER_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const STATEMENT_KEYWORDS = new Set(['export', 'import', 'const', 'let', 'var', 'function', 'class', 'if', 'for', 'while', 'do', 'return', 'throw', 'try', 'switch']);

function isIdentChar(ch: string): boolean {
    return /[A-Za-z0-9_$\u0080-￿]/.test(ch);
}

function regexAllowedAfter(last: JsToken | undefined): boolean {
    if (last === undefined) return true;
    switch (last.t) {
        case 'punc': return last.v !== ')' && last.v !== ']' && last.v !== '}';
        case 'id': return REGEX_AFTER_KEYWORDS.has(last.v);
        case 'tpl': return last.v === 'head' || last.v === 'middle';
        default: return false;
    }
}

/**
 * Tokenizes JavaScript just far enough for the rewrites below: comments, strings, template
 * literals with their substitutions, regular expressions and punctuators.
 */
function tokenizeJs(src: string): JsToken[] {
    const tokens: JsToken[] = [];
    const braces: string[] = [];
    const n = src.length;
    let i = 0;
    let nl = false;
    if (src.startsWith('#!')) {
        while (i < n && src[i] !== '\n') i++;
    }
    const push = (t: JsToken['t'], v: string, s: number, e: number): void => {
        tokens.push({ t, v, s, e, nl });
        nl = false;
    };
    // a template chunk from `start` (a backtick, or the brace that closes a substitution) to `${` or the closing backtick
    const scanTemplate = (start: number, head: boolean): void => {
        let j = start + 1;
        while (j < n) {
            const ch = src[j];
            if (ch === '\\') {
                j += 2;
            } else if (ch === '`') {
                push('tpl', head ? 'full' : 'tail', start, j + 1);
                i = j + 1;
                return;
            } else if (ch === '$' && src[j + 1] === '{') {
                push('tpl', head ? 'head' : 'middle', start, j + 2);
                braces.push('${');
                i = j + 2;
                return;
            } else {
                j++;
            }
        }
        i = n;
    };
    while (i < n) {
        const ch = src[i];
        if (ch === '\n' || ch === '\r' || ch === ' ' || ch === ' ') {
            nl = true;
            i++;
            continue;
        }
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (ch === '/' && src[i + 1] === '/') {
            while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            const close = src.indexOf('*/', i + 2);
            const stop = close < 0 ? n : close + 2;
            if (/[\n\r]/.test(src.slice(i, stop))) nl = true;
            i = stop;
            continue;
        }
        const start = i;
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
            i++;
            while (i < n && (isIdentChar(src[i]) || src[i] === '.' || ((src[i] === '+' || src[i] === '-') && /[eE]/.test(src[i - 1])))) i++;
            push('num', src.slice(start, i), start, i);
            continue;
        }
        if (isIdentChar(ch)) {
            while (i < n && isIdentChar(src[i])) i++;
            push('id', src.slice(start, i), start, i);
            continue;
        }
        if (ch === '"' || ch === "'") {
            i++;
            while (i < n && src[i] !== ch && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
            const end = Math.min(i, n);
            push('str', src.slice(start + 1, end), start, Math.min(end + 1, n));
            i = Math.min(end + 1, n);
            continue;
        }
        if (ch === '`') {
            scanTemplate(start, true);
            continue;
        }
        if (ch === '}' && braces[braces.length - 1] === '${') {
            braces.pop();
            scanTemplate(start, false);
            continue;
        }
        if (ch === '/' && regexAllowedAfter(tokens[tokens.length - 1])) {
            i++;
            let inClass = false;
            while (i < n && src[i] !== '\n' && src[i] !== '\r') {
                const c = src[i];
                if (c === '\\') {
                    i += 2;
                    continue;
                }
                if (inClass) {
                    if (c === ']') inClass = false;
                } else if (c === '[') {
                    inClass = true;
                } else if (c === '/') {
                    i++;
                    break;
                }
                i++;
            }
            while (i < n && isIdentChar(src[i])) i++;
            push('re', '', start, i);
            continue;
        }
        let op = ch;
        for (const candidate of PUNCTUATORS) {
            if (src.startsWith(candidate, i)) {
                op = candidate;
                break;
            }
        }
        if (op === '{') braces.push('{');
        else if (op === '}') braces.pop();
        push('punc', op, start, start + op.length);
        i += op.length;
    }
    return tokens;
}

function isPunc(tok: JsToken | undefined, v: string): boolean {
    return tok !== undefined && tok.t === 'punc' && tok.v === v;
}

function isId(tok: JsToken | undefined, v: string): boolean {
    return tok !== undefined && tok.t === 'id' && tok.v === v;
}

/** The value of a string token with simple escapes resolved. */
function cookString(tok: JsToken): string {
    return tok.v.replace(/\\(.)/g, '$1');
}

/** Index of the bracket that closes the opener at `open`, or -1. */
function matchingClose(tokens: JsToken[], open: number): number {
    let depth = 0;
    for (let k = open; k < tokens.length; k++) {
        const tok = tokens[k];
        if (tok.t !== 'punc') continue;
        if (tok.v === '(' || tok.v === '[' || tok.v === '{') {
            depth++;
        } else if (tok.v === ')' || tok.v === ']' || tok.v === '}') {
            depth--;
            if (depth === 0) return k;
        }
    }
    return -1;
}

/** Index of the token that ends the expression starting at `k`: a top-level comma, semicolon, closer or new statement. */
function skipExpression(tokens: JsToken[], k: number): number {
    let depth = 0;
    for (let m = k; m < tokens.length; m++) {
        const tok = tokens[m];
        if (depth === 0 && m > k && tok.nl && tok.t === 'id' && STATEMENT_KEYWORDS.has(tok.v)) return m;
        if (tok.t !== 'punc') continue;
        if (tok.v === '(' || tok.v === '[' || tok.v === '{') {
            depth++;
        } else if (tok.v === ')' || tok.v === ']' || tok.v === '}') {
            if (depth === 0) return m;
            depth--;
        } else if (depth === 0 && (tok.v === ',' || tok.v === ';')) {
            return m;
        }
    }
    return tokens.length;
}

/** Parses a binding identifier or pattern at `k`, pushing the names it binds; returns the index after it. */
function parseBindingTarget(tokens: JsToken[], k: number, names: string[]): number {
    const tok = tokens[k];
    if (tok !== undefined && tok.t === 'id') {
        names.push(tok.v);
        return k + 1;
    }
    if (isPunc(tok, '{')) return parseObjectPattern(tokens, k, names);
    if (isPunc(tok, '[')) return parseArrayPattern(tokens, k, names);
    throw new BindingPatternError(`no binding target at token ${k}`);
}

function parseBindingElement(tokens: JsToken[], k: number, names: string[]): number {
    const after = parseBindingTarget(tokens, k, names);
    return isPunc(tokens[after], '=') ? skipExpression(tokens, after + 1) : after;
}

function parseObjectPattern(tokens: JsToken[], open: number, names: string[]): number {
    let m = open + 1;
    while (!isPunc(tokens[m], '}')) {
        const tok = tokens[m];
        if (tok === undefined) throw new BindingPatternError('unterminated object pattern');
        if (isPunc(tok, ',')) {
            m++;
            continue;
        }
        if (isPunc(tok, '...')) {
            m = parseBindingTarget(tokens, m + 1, names);
            continue;
        }
        let key: JsToken | undefined = tok;
        if (isPunc(tok, '[')) {
            const close = matchingClose(tokens, m);
            if (close < 0) throw new BindingPatternError('unterminated computed key');
            m = close + 1;
            key = undefined;
        } else if (tok.t === 'id' || tok.t === 'str' || tok.t === 'num') {
            m++;
        } else {
            throw new BindingPatternError(`unexpected token in object pattern at ${m}`);
        }
        if (isPunc(tokens[m], ':')) {
            m = parseBindingElement(tokens, m + 1, names);
        } else {
            if (key !== undefined && key.t === 'id') names.push(key.v);
            if (isPunc(tokens[m], '=')) m = skipExpression(tokens, m + 1);
        }
    }
    return m + 1;
}

function parseArrayPattern(tokens: JsToken[], open: number, names: string[]): number {
    let m = open + 1;
    while (!isPunc(tokens[m], ']')) {
        if (tokens[m] === undefined) throw new BindingPatternError('unterminated array pattern');
        if (isPunc(tokens[m], ',')) {
            m++;
            continue;
        }
        if (isPunc(tokens[m], '...')) {
            m = parseBindingTarget(tokens, m + 1, names);
            continue;
        }
        m = parseBindingElement(tokens, m, names);
    }
    return m + 1;
}

/** Walks `export const|let|var <declarators>` from the export token; true when a declarator is a pattern. */
function destructuringDeclaration(tokens: JsToken[], exportIndex: number, names: string[]): boolean {
    let pattern = false;
    let m = exportIndex + 2;
    for (;;) {
        if (isPunc(tokens[m], '{') || isPunc(tokens[m], '[')) pattern = true;
        m = parseBindingTarget(tokens, m, names);
        if (isPunc(tokens[m], '=')) m = skipExpression(tokens, m + 1);
        if (!isPunc(tokens[m], ',')) return pattern;
        m++;
    }
}

function isJsonAttributeClause(tokens: JsToken[], from: number, to: number): boolean {
    for (let k = from; k + 2 < to; k++) {
        const key = tokens[k];
        if (key.t !== 'id' && key.t !== 'str') continue;
        const name = key.t === 'str' ? cookString(key) : key.v;
        if (name === 'type' && isPunc(tokens[k + 1], ':') && tokens[k + 2].t === 'str' && cookString(tokens[k + 2]) === 'json') return true;
    }
    return false;
}

/**
 * Rewrites the attribute clause of a static import or export-from declaration at `i`: a
 * `with { type: 'json' }` clause is removed (the engine cannot parse it); a .json specifier
 * without one gets the missing-attribute mark. The legacy `assert` clause is left alone, as
 * Node 24 rejects it at parse time.
 */
function rewriteModuleSpecifier(tokens: JsToken[], src: string, i: number, edits: SourceEdit[]): void {
    let specIndex = -1;
    if (tokens[i].v === 'import') {
        if (tokens[i + 1]?.t === 'str') {
            specIndex = i + 1;
        } else {
            for (let k = i + 1; k < tokens.length && k < i + 400 && !isPunc(tokens[k], ';'); k++) {
                if (isId(tokens[k], 'from')) {
                    if (tokens[k + 1]?.t === 'str') specIndex = k + 1;
                    break;
                }
            }
        }
    } else if (isPunc(tokens[i + 1], '*')) {
        const k = isId(tokens[i + 2], 'as') ? i + 4 : i + 2;
        if (isId(tokens[k], 'from') && tokens[k + 1]?.t === 'str') specIndex = k + 1;
    } else {
        const close = matchingClose(tokens, i + 1);
        if (close > 0 && isId(tokens[close + 1], 'from') && tokens[close + 2]?.t === 'str') specIndex = close + 2;
    }
    if (specIndex < 0) return;
    const spec = tokens[specIndex];
    const after = tokens[specIndex + 1];
    if (isId(after, 'with') && isPunc(tokens[specIndex + 2], '{')) {
        const close = matchingClose(tokens, specIndex + 2);
        if (close > 0 && isJsonAttributeClause(tokens, specIndex + 3, close)) {
            edits.push({ start: after.s, end: tokens[close].e, text: '' });
        }
        return;
    }
    if (isId(after, 'assert')) return;
    if (cookString(spec).endsWith('.json')) {
        const quote = src[spec.s];
        edits.push({ start: spec.s, end: spec.e, text: `${quote}${spec.v}\\u0001owc-attr-missing${quote}` });
    }
}

/**
 * Rewrites one ES module source: `import.meta` becomes a per-module object, dynamic import()
 * arguments pass through the attribute check, static attribute clauses are resolved, and
 * `export const { a } = ...` (a binding pattern the engine does not export) becomes a plain
 * declaration followed by an explicit export list.
 */
function prepareEsmSource(source: string, file: string, isMain: boolean): string {
    if (!/\b(?:import|export)\b/.test(source)) return source;
    const tokens = tokenizeJs(source);
    const edits: SourceEdit[] = [];
    const exportNames: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.t !== 'id' || isPunc(tokens[i - 1], '.') || isPunc(tokens[i - 1], '?.')) continue;
        if (tok.v === 'import') {
            const next = tokens[i + 1];
            if (isPunc(next, '.') && isId(tokens[i + 2], 'meta')) {
                const meta = tokens[i + 2];
                edits.push({ start: tok.s, end: meta.e, text: `globalThis.__owc_importMeta(${JSON.stringify(file)}, ${isMain})` });
                i += 2;
            } else if (isPunc(next, '(')) {
                const close = matchingClose(tokens, i + 1);
                if (close > 0) {
                    edits.push({ start: next.e, end: next.e, text: 'globalThis.__owc_importArg(' });
                    edits.push({ start: tokens[close].s, end: tokens[close].s, text: ')' });
                }
            } else if (next !== undefined && (next.t === 'str' || next.t === 'id' || isPunc(next, '*') || isPunc(next, '{'))) {
                rewriteModuleSpecifier(tokens, source, i, edits);
            }
        } else if (tok.v === 'export') {
            const next = tokens[i + 1];
            if (isPunc(next, '*') || isPunc(next, '{')) {
                rewriteModuleSpecifier(tokens, source, i, edits);
            } else if (isId(next, 'const') || isId(next, 'let') || isId(next, 'var')) {
                const names: string[] = [];
                let pattern = false;
                try {
                    pattern = destructuringDeclaration(tokens, i, names);
                } catch (error) {
                    if (!(error instanceof BindingPatternError)) throw error;
                }
                if (pattern) {
                    edits.push({ start: tok.s, end: next.s, text: '' });
                    exportNames.push(...names);
                }
            }
        }
    }
    edits.sort((a, b) => a.start - b.start || a.end - b.end);
    let out = '';
    let cursor = 0;
    for (const edit of edits) {
        if (edit.start < cursor) continue;
        out += source.slice(cursor, edit.start) + edit.text;
        cursor = edit.end;
    }
    out += source.slice(cursor);
    if (exportNames.length > 0) {
        out += `\nexport { ${[...new Set(exportNames)].join(', ')} };\n`;
    }
    return out;
}

/** The module source for a recorded error: evaluating it throws the error with its Node code. */
function errorModuleSource(name: string): string {
    const info = JSON.parse(decodeURIComponent(name.slice(ERROR_MODULE_PREFIX.length))) as { code: string; message: string };
    // the default export exists so that a static import links; evaluation of the module then throws
    return `export default undefined;\nthrow Object.assign(new TypeError(${JSON.stringify(info.message)}), { code: ${JSON.stringify(info.code)} });\n`;
}

function toFileUrl(file: string): string {
    return 'file://' + encodeURI(file).replace(/\?/g, '%3F').replace(/#/g, '%23');
}

/**
 * Export names of a CommonJS source, with the shapes cjs-module-lexer detects: exports.x = and
 * exports['x'] =, module.exports = { a, b: c, 'd': e, ...require('x') }, module.exports = require('x'),
 * Object.defineProperty(exports, 'x', { value } | { get returning an identifier }), and the
 * __exportStar / __export re-exports TypeScript emits.
 */
function scanCjsExports(src: string): CjsExportScan {
    const names = new Set<string>();
    const reexports: string[] = [];
    if (!/exports|__export/.test(src)) return { names, reexports };
    const t = tokenizeJs(src);

    // j is the `exports` token: exports.name = ... or exports['name'] = ...
    const addAssigned = (j: number): void => {
        const nameTok = t[j + 2];
        if (isPunc(t[j + 1], '.') && nameTok?.t === 'id' && isPunc(t[j + 3], '=')) {
            names.add(nameTok.v);
        } else if (isPunc(t[j + 1], '[') && nameTok?.t === 'str' && isPunc(t[j + 3], ']') && isPunc(t[j + 4], '=')) {
            names.add(cookString(nameTok));
        }
    };

    // module.exports = { ... }: entries are read until the first one that is not a plain export
    const scanLiteral = (start: number): void => {
        let k = start;
        for (;;) {
            const tok = t[k];
            if (tok === undefined) return;
            if (tok.t === 'id') {
                k++;
                if (isPunc(t[k], ':')) {
                    k++;
                    if (t[k]?.t !== 'id') return;
                    k++;
                }
                names.add(tok.v);
            } else if (isPunc(tok, '...')) {
                if (isId(t[k + 1], 'require') && isPunc(t[k + 2], '(') && t[k + 3]?.t === 'str' && isPunc(t[k + 4], ')')) {
                    reexports.push(cookString(t[k + 3]));
                    k += 5;
                } else if (t[k + 1]?.t === 'id') {
                    k += 2;
                } else {
                    return;
                }
            } else if (tok.t === 'str') {
                k++;
                if (isPunc(t[k], ':')) {
                    k++;
                    if (t[k]?.t !== 'id') return;
                    k++;
                    names.add(cookString(tok));
                }
            } else {
                return;
            }
            if (t[k] === undefined || !isPunc(t[k], ',')) return;
            k++;
        }
    };

    // Object.defineProperty(exports, 'name', { ... }) where `open` is the call's parenthesis
    const scanDefine = (open: number): void => {
        let k = open + 1;
        if (isId(t[k], 'exports')) {
            k += 1;
        } else if (isId(t[k], 'module') && isPunc(t[k + 1], '.') && isId(t[k + 2], 'exports')) {
            k += 3;
        } else {
            return;
        }
        if (!isPunc(t[k], ',') || t[k + 1]?.t !== 'str' || !isPunc(t[k + 2], ',') || !isPunc(t[k + 3], '{')) return;
        const name = cookString(t[k + 1]);
        const close = matchingClose(t, k + 3);
        if (close < 0) return;
        let depth = 0;
        let detected = false;
        for (let m = k + 4; m < close && !detected; m++) {
            const tok = t[m];
            if (tok.t === 'punc') {
                if (tok.v === '(' || tok.v === '[' || tok.v === '{') depth++;
                else if (tok.v === ')' || tok.v === ']' || tok.v === '}') depth--;
                continue;
            }
            if (depth !== 0 || tok.t !== 'id') continue;
            if (tok.v === 'value' && isPunc(t[m + 1], ':')) {
                detected = true;
            } else if (tok.v === 'get' && (isPunc(t[m + 1], ':') || isPunc(t[m + 1], '('))) {
                for (let g = m + 1; g < close; g++) {
                    const gt = t[g];
                    if (isId(gt, 'return') && t[g + 1]?.t === 'id' && t[g + 1].v !== 'function') {
                        detected = true;
                        break;
                    }
                    if (isPunc(gt, '=>') && t[g + 1]?.t === 'id' && t[g + 1].v !== 'function') {
                        detected = true;
                        break;
                    }
                }
            }
        }
        if (detected) names.add(name);
    };

    for (let i = 0; i < t.length; i++) {
        const tok = t[i];
        if (tok.t !== 'id') continue;
        if (tok.v === '__exportStar' || tok.v === '__export') {
            if (isPunc(t[i + 1], '(') && isId(t[i + 2], 'require') && isPunc(t[i + 3], '(') && t[i + 4]?.t === 'str') {
                reexports.push(cookString(t[i + 4]));
            }
            continue;
        }
        if (isPunc(t[i - 1], '.') || isPunc(t[i - 1], '?.')) continue;
        if (tok.v === 'exports') {
            addAssigned(i);
        } else if (tok.v === 'module' && isPunc(t[i + 1], '.') && isId(t[i + 2], 'exports')) {
            if (isPunc(t[i + 3], '=')) {
                if (isId(t[i + 4], 'require') && isPunc(t[i + 5], '(') && t[i + 6]?.t === 'str' && isPunc(t[i + 7], ')')) {
                    reexports.push(cookString(t[i + 6]));
                } else if (isPunc(t[i + 4], '{')) {
                    scanLiteral(i + 5);
                }
            } else {
                addAssigned(i + 2);
            }
        } else if (tok.v === 'Object' && isPunc(t[i + 1], '.') && isId(t[i + 2], 'defineProperty') && isPunc(t[i + 3], '(')) {
            scanDefine(i + 3);
        }
    }
    return { names, reexports };
}

/** Runs a synchronous capability now. Undefined when its handler returns a promise: the work has started and cannot be awaited here. */
function invokeNow(op: string, argsJson: string, context: CapabilityContext): CapabilityEnvelope | undefined {
    const handler = CAPABILITIES[op];
    if (!handler) return errorEnvelope(Object.assign(new Error(`unknown capability ${op}`), { code: 'ERR_UNKNOWN_CAPABILITY' }));
    let value: unknown;
    try {
        value = handler(JSON.parse(argsJson), context);
    } catch (error) {
        return errorEnvelope(error);
    }
    if (value instanceof Promise) {
        value.catch(() => undefined);
        return undefined;
    }
    return { ok: true, value: value === undefined ? null : value };
}

/** The node runner behind child_process.spawnSync: a NodeProcess run to completion inside the caller's capability call. */
function runNodeSync(request: SyncChildRequest): SyncChildResult {
    // NodeProcess keeps its NetworkManager and never reads it; a synchronous child reaches the network through services
    const child = new NodeProcess(
        request.pid,
        request.file,
        request.args,
        request.fileSystem,
        undefined as unknown as NetworkManager,
        request.services,
        request.parentPid,
        request.cwd,
        request.env,
        request.evalSource
    );
    let stdout = '';
    let stderr = '';
    child.addEventListener(ProcessEvent.MESSAGE, (data: { stdout?: string; stderr?: string }) => {
        if (data.stdout !== undefined) stdout += data.stdout;
        if (data.stderr !== undefined) stderr += data.stderr;
    });
    const deadline = request.timeoutMs > 0 ? performance.now() + request.timeoutMs : Infinity;
    const run = child.runToCompletionSync(deadline, request.killSignal);
    return { status: run.status, signal: run.signal, stdout, stderr, timedOut: run.timedOut, blocked: run.blocked };
}

nodeSyncRunner.run = runNodeSync;
