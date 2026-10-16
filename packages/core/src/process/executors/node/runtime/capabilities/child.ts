import { Process, ProcessEvent, ProcessState } from '../../../../base';
import { CapabilityContext, CapabilityHandler } from './types';
import { printEvalSource } from '../eval-source';
import { COMMANDS as TEXT_UTILS } from '../../../../../shell/commands/textutils';
import { COMMANDS as FILE_UTILS } from '../../../../../shell/commands/fileutils';
import { COMMANDS as ARCHIVES } from '../../../../../shell/commands/archives';
import { COMMANDS as PROC_INFO } from '../../../../../shell/commands/procinfo';
import {
    COMMANDS as UNSUPPORTED_UTILS,
    UNSUPPORTED_COMMANDS,
    isUnsupported,
    unsupportedResult
} from '../../../../../shell/commands/unsupported';
import {
    COMMANDS as SHELL_BUILTIN_UTILS,
    createShellState,
    evalArith,
    setActiveState,
    setRunner
} from '../../../../../shell/commands/builtins';
import type { ShellState, ShellVar } from '../../../../../shell/commands/builtins';
import type { IFileSystem } from '../../../../../filesystem';
import type { CommandContext, CommandResult, ShellCommand } from '../../../../../shell/commands/types';
import { nodeSyncRunner, syncRunActive } from '../../pump';
import type { SyncChildResult } from '../../pump';

/*
 * Host half of child_process, worker_threads and cluster. The guest half is ../guest/modules/child.ts.
 *
 * A child is a container process started through ctx.services.startProcess and recorded under its pid.
 * Its output reaches the parent guest as 'ev' deliveries when the stdio mode is 'pipe', is forwarded
 * through the parent's ctx.output when 'inherit', and is dropped when 'ignore'.
 *
 * IPC is relayed here. A child attaches its own guest target with child.ipcAttach (the child's pid is
 * ctx.pid). Frames from the parent (child.sendToChild) are delivered to that target as 'ipc'; frames
 * from the child (child.sendToParent) come back to the parent as 'ev' with k 'ipc'. Frames sent before
 * the child attaches are queued and flushed on attach. Every delivery is a macrotask, so no guest is
 * re-entered from inside another guest's call.
 */

type StdioMode = 'pipe' | 'inherit' | 'ignore';

interface ChildRecord {
    token: string;
    kind: string;
    /** The spawning process: deliveries to its guest and inherited output go through it. */
    parent: CapabilityContext;
    /** The parent guest target that receives this child's events. */
    target: number;
    stdout: StdioMode;
    stderr: StdioMode;
    pid?: number;
    process?: Process;
    /** The child guest's IPC target, set when the child attaches. */
    ipcTarget?: number;
    connected: boolean;
    /** Frames addressed to the child that were sent before it attached. */
    queue: unknown[];
    exited: boolean;
    killSignal?: string;
}

interface Registry {
    byPid: Map<number, ChildRecord>;
    pending: Map<string, ChildRecord>;
}

const REGISTRIES = new WeakMap<object, Registry>();

/** Workers that reported an uncaught error to their parent: their own stderr copy of that error is not printed. */
const FAILED_WORKERS = new WeakSet<ChildRecord>();

/** One registry per container (keyed by its services object), so pids of different containers never collide. */
function registryFor(ctx: CapabilityContext): Registry {
    let registry = REGISTRIES.get(ctx.services);
    if (!registry) {
        registry = { byPid: new Map(), pending: new Map() };
        REGISTRIES.set(ctx.services, registry);
    }
    return registry;
}

/**
 * Schedules a delivery as a macrotask, so a guest is never re-entered from inside another guest's call. Inside a
 * synchronous run no macrotask runs before the call returns, so the action runs now: the delivery it makes is queued
 * by the receiving process and taken by that process's pump.
 */
function later(action: () => void): void {
    if (syncRunActive()) {
        action();
        return;
    }
    setTimeout(action, 0);
}

function modeOf(value: unknown): StdioMode {
    return value === 'inherit' || value === 'ignore' ? value : 'pipe';
}

/** The environment a child inherits: the caller's, without the IPC markers of this runtime. */
function childEnvOf(ctx: CapabilityContext): Record<string, string> {
    const env: Record<string, string> = { ...ctx.env() };
    delete env.OWC_IPC_KIND;
    delete env.OWC_IPC_DATA;
    return env;
}

/** Container executables are node, *.js and sh; anything else has no executor and reports ENOENT like Node. */
function spawnFailure(error: unknown, file: string, args: string[]): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('No executor found')) {
        return Object.assign(new Error(`spawn ${file} ENOENT`), {
            code: 'ENOENT',
            errno: -2,
            syscall: `spawn ${file}`,
            path: file,
            spawnargs: args
        });
    }
    return Object.assign(new Error(message), {
        code: 'ERR_CHILD_PROCESS_SPAWN',
        syscall: `spawn ${file}`,
        path: file,
        spawnargs: args
    });
}

function routeOutput(record: ChildRecord, fd: 1 | 2, text: string): void {
    const mode = fd === 1 ? record.stdout : record.stderr;
    if (mode === 'pipe') {
        later(() => record.parent.deliver(record.target, 'ev', { k: 'out', fd, s: text }));
    } else if (mode === 'inherit') {
        record.parent.output(fd === 1 ? { stdout: text } : { stderr: text });
    }
}

/** A frame goes to another guest's sink: always a macrotask, even inside a synchronous run. */
function deliverFrame(ctx: CapabilityContext, pid: number, target: number, frame: unknown): void {
    setTimeout(() => ctx.services.sinkFor(pid)?.deliver(target, 'ipc', frame), 0);
}

const spawnChildAsync: CapabilityHandler = async (args, ctx) => {
    const registry = registryFor(ctx);
    const file = String(args.file);
    const argv: string[] = Array.isArray(args.args) ? args.args.map(String) : [];
    const env: Record<string, string> = args.env ? { ...args.env } : childEnvOf(ctx);
    if (args.ipc) {
        env.OWC_IPC_KIND = String(args.ipcKind);
        env.OWC_IPC_DATA = JSON.stringify({ ...args.ipcData, token: args.token });
    }
    const stdio: unknown[] = Array.isArray(args.stdio) ? args.stdio : [];
    const record: ChildRecord = {
        token: String(args.token),
        kind: String(args.kind),
        parent: ctx,
        target: Number(args.target),
        stdout: modeOf(stdio[1]),
        stderr: modeOf(stdio[2]),
        connected: Boolean(args.ipc),
        queue: [],
        exited: false
    };
    registry.pending.set(record.token, record);
    const child = await ctx.services
        .startProcess({
            parentPid: ctx.pid,
            executable: file,
            args: argv,
            cwd: typeof args.cwd === 'string' ? args.cwd : ctx.cwd(),
            env
        })
        .catch((error: unknown) => {
            registry.pending.delete(record.token);
            throw spawnFailure(error, file, argv);
        });
    record.process = child;
    record.pid = child.pid;
    registry.pending.delete(record.token);
    registry.byPid.set(child.pid, record);

    if (child.state !== ProcessState.RUNNING && child.state !== ProcessState.CREATED) {
        // The process finished inside spawn, before these listeners existed, so its EXIT was never seen.
        // Its output emitted in that window is not recoverable; the exit is reported now.
        record.exited = true;
        record.connected = false;
        registry.byPid.delete(child.pid);
        const code = child.exitCode ?? 0;
        later(() => record.parent.deliver(record.target, 'ev', { k: 'exit', code, signal: null }));
        return { pid: child.pid };
    }
    child.addEventListener(ProcessEvent.MESSAGE, (data: { stdout?: string; stderr?: string }) => {
        if (record.exited) return;
        if (data.stdout !== undefined) routeOutput(record, 1, data.stdout);
        if (data.stderr !== undefined && !FAILED_WORKERS.has(record)) routeOutput(record, 2, data.stderr);
    });
    child.addEventListener(ProcessEvent.ERROR, (data: { error: Error }) => {
        if (record.exited || !data.error) return;
        const { name, message } = data.error;
        const code = (data.error as { code?: unknown }).code;
        later(() => record.parent.deliver(record.target, 'ev', { k: 'error', e: { name, message, code } }));
    });
    child.addEventListener(ProcessEvent.EXIT, (data: { exitCode: number | null }) => {
        // terminate() and start() both emit EXIT for a killed process: the first one wins
        if (record.exited) return;
        record.exited = true;
        record.connected = false;
        registry.byPid.delete(child.pid);
        const signal = record.killSignal ?? null;
        const code = signal === null ? (data.exitCode ?? 0) : null;
        later(() => record.parent.deliver(record.target, 'ev', { k: 'exit', code, signal }));
    });
    return { pid: child.pid };
};

/** A spawn made while a synchronous run is on the stack runs to completion there; any other spawn is asynchronous. */
const spawnChild: CapabilityHandler = (args, ctx) => (syncRunActive() ? spawnChildNow(args, ctx) : spawnChildAsync(args, ctx));

const killChild: CapabilityHandler = (args, ctx) => {
    const record = registryFor(ctx).byPid.get(Number(args.pid));
    if (!record || record.exited || !record.process || record.parent.pid !== ctx.pid) return false;
    if (record.process.state !== ProcessState.RUNNING) return false;
    record.killSignal = String(args.signal ?? 'SIGTERM');
    void record.process.terminate();
    return true;
};

/** Writes to a child's stdin. Only shell processes read Process input; node children do not (documented gap). */
const stdinWrite: CapabilityHandler = (args, ctx) => {
    const record = registryFor(ctx).byPid.get(Number(args.pid));
    if (!record || record.exited || !record.process || record.parent.pid !== ctx.pid) return false;
    try {
        record.process.writeInput(String(args.data));
        return true;
    } catch {
        return false;
    }
};

/** Called by a child guest at bootstrap: records its IPC target and flushes frames queued before it attached. */
const ipcAttach: CapabilityHandler = (args, ctx) => {
    const registry = registryFor(ctx);
    const pending = typeof args.token === 'string' ? registry.pending.get(args.token) : undefined;
    const record = registry.byPid.get(ctx.pid) ?? pending;
    if (!record) return null;
    registry.byPid.set(ctx.pid, record);
    record.pid = ctx.pid;
    record.ipcTarget = Number(args.targetId);
    for (const frame of record.queue.splice(0)) {
        deliverFrame(ctx, ctx.pid, record.ipcTarget, frame);
    }
    return null;
};

/** Child to parent: called from the child's guest (ctx is the child). */
const sendToParent: CapabilityHandler = (args, ctx) => {
    const record = registryFor(ctx).byPid.get(ctx.pid);
    if (!record || !record.connected) return false;
    const frame = args.frame;
    if (frame && frame.t === 'e') FAILED_WORKERS.add(record);
    later(() => record.parent.deliver(record.target, 'ev', { k: 'ipc', f: frame }));
    return true;
};

/** Parent to child: called from the parent's guest (ctx is the parent). */
const sendToChild: CapabilityHandler = (args, ctx) => {
    const record = registryFor(ctx).byPid.get(Number(args.pid));
    if (!record || record.exited || !record.connected || record.parent.pid !== ctx.pid) return false;
    if (record.ipcTarget === undefined || record.pid === undefined) {
        record.queue.push(args.frame);
        return true;
    }
    deliverFrame(ctx, record.pid, record.ipcTarget, args.frame);
    return true;
};

/** Parent closes the channel to one child. */
const disconnectChild: CapabilityHandler = (args, ctx) => {
    const record = registryFor(ctx).byPid.get(Number(args.pid));
    if (!record || record.exited || !record.connected || record.parent.pid !== ctx.pid) return false;
    record.connected = false;
    const frame = { t: 'd' };
    if (record.ipcTarget === undefined || record.pid === undefined) {
        record.queue.push(frame);
    } else {
        deliverFrame(ctx, record.pid, record.ipcTarget, frame);
    }
    return true;
};

/** Child closes its own channel; the parent is told so its ChildProcess emits 'disconnect'. */
const disconnectSelf: CapabilityHandler = (_args, ctx) => {
    const record = registryFor(ctx).byPid.get(ctx.pid);
    if (!record || !record.connected) return false;
    record.connected = false;
    later(() => record.parent.deliver(record.target, 'ev', { k: 'ipcdown' }));
    return true;
};

/** Parent guest is exiting: worker threads are terminated, and IPC children are disconnected, as Node does. */
const parentExit: CapabilityHandler = (_args, ctx) => {
    for (const record of registryFor(ctx).byPid.values()) {
        if (record.parent.pid !== ctx.pid || record.exited || !record.process) continue;
        if (record.kind === 'worker') {
            if (record.process.state === ProcessState.RUNNING) {
                record.killSignal = 'SIGTERM';
                void record.process.terminate();
            }
        } else if (record.connected && record.ipcTarget !== undefined && record.pid !== undefined) {
            record.connected = false;
            deliverFrame(ctx, record.pid, record.ipcTarget, { t: 'd' });
        }
    }
    return null;
};

/*
 * Synchronous family (spawnSync, execSync, execFileSync). child.spawnSync runs the child to completion inside this
 * call (NodeProcess.runToCompletionSync, pump.ts). A node child is a NodeProcess. The container's shell is
 * asynchronous end to end (ShellProcess and Shell await every command), so `sh` runs through shellLine below: the
 * dispatch of ShellProcess.executeCommand and the built-ins of Shell, as synchronous code. A child that waits on
 * asynchronous host work (network, a grandchild, a promise-returning capability) cannot be stepped here: the call
 * fails with ERR_NOT_SUPPORTED and keeps the output written so far.
 */

/** process.argv[0] of every node child: `node` in a shell command and the container's node binary both resolve to it. */
const NODE_BINARY = '/usr/local/bin/node';

/** Pids of synchronous children, counted apart from the container's own process pids. */
let nextSyncPid = 61000;

interface SyncErrorInfo {
    code: string;
    message: string;
    errno?: number;
    syscall?: string;
    path?: string;
    spawnargs?: string[];
}

/** What child.spawnSync returns; the guest shapes it into the SpawnSyncReturns object Node gives. */
interface SyncOutcome {
    pid: number;
    spawned: boolean;
    status: number | null;
    signal: string | null;
    stdout: string | null;
    stderr: string | null;
    error: SyncErrorInfo | null;
}

/** One run of an executable to completion: the pid, status, signal and output the child left. */
type SyncRun = SyncChildResult & { pid: number };

interface ShellStep {
    stdout: string;
    stderr: string;
    exitCode: number;
}

interface SyncShell {
    ctx: CapabilityContext;
    cwd: string;
    env: Record<string, string>;
    input: string | null;
    /** `$0`: the name the shell was started as (`sh`, `/bin/sh`). */
    name?: string;
    /** `$?`: written by shellLine after every command, read by every expansion. */
    lastStatus: number;
    /** The state the builtins of `builtins.ts` share for this line: variables, aliases, the directory stack. */
    state?: ShellState;
    /** Set when a builtin ended the shell (`exec`, or an `exit` inside `eval`): no later command runs. */
    stopped?: boolean;
}

const SHELL_BUILTINS = new Set(['echo', 'cat', 'pwd', 'ls', 'mkdir', 'rm', 'rmdir', 'touch', 'cd', 'cp', 'mv', 'true', 'false']);
const SHELL_EXTERNALS = new Set(['curl', 'unzip', 'wget', 'npm', 'npx']);

/**
 * Every command the modules under shell/commands provide, merged once at load. The order is the
 * order the modules are tried: a name the container cannot have at all is last, so the reason in
 * `UNSUPPORTED` wins over a same-named handler elsewhere (`man`, `open`, `xclip`).
 */
const SHELL_MODULE_COMMANDS: Record<string, ShellCommand> = {
    ...TEXT_UTILS,
    ...FILE_UTILS,
    ...ARCHIVES,
    ...PROC_INFO,
    ...SHELL_BUILTIN_UTILS,
    ...UNSUPPORTED_UTILS,
    ...UNSUPPORTED_COMMANDS
};

/** The names `builtins.ts` implements. Kept apart so their one state-carrying entry point is used. */
const SHELL_BUILTIN_NAMES: Set<string> = new Set(Object.keys(SHELL_BUILTIN_UTILS));

/**
 * The callback `builtins.ts` runs a command it does not implement itself through: `command X`,
 * `builtin echo`, `env FOO=1 cmd`, and every simple command of `eval`, `exec` and `source`. It is
 * this dispatcher's own `shellCommand`, so a command reached from inside a builtin behaves exactly
 * as it does typed on the line. Installed once, at load: one runtime, one dispatcher.
 */
setRunner((state, words, input) => {
    const shell = state.host as SyncShell | undefined;
    if (shell === undefined) return { stdout: '', stderr: `Command not found: ${words[0] ?? ''}`, exitCode: 127 };
    const saved = shell.input;
    shell.input = input;
    try {
        return shellCommand(shell, words);
    } finally {
        shell.input = saved;
    }
});

/**
 * The file system a module command reads and writes through.
 *
 * `atPath` in shell/commands/types.ts resolves a relative path with `fs.resolvePath(path, cwd)`, and
 * the container's own implementation answers a relative path from the file system root rather than
 * from the base it is given: `resolvePath('users.txt', '/work')` is `/users.txt`. Neither the modules
 * nor types.ts may be changed, so the dispatcher hands them a view whose `resolvePath` joins against
 * the base, as the interface describes. Every other method is the container's own untouched, no
 * argument is rewritten before the handler sees it, and the join removes nothing: a name is written
 * to the file system exactly as the handler formed it, `..` included, so a module that refuses a
 * traversal still refuses it.
 */
function fsForModules(fs: IFileSystem, cwdOf: () => string): IFileSystem {
    return new Proxy(fs, {
        get(target, prop) {
            if (prop === 'resolvePath') {
                return (path: string, basePath?: string): string => {
                    if (path.startsWith('/')) return fs.normalizePath(path);
                    const base = basePath ?? cwdOf();
                    const root = base === '' ? '/' : fs.normalizePath(base);
                    return (root.endsWith('/') ? root : root + '/') + path;
                };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        }
    });
}

/** The context a module command is called with: the shell's own directory, environment and input. */
function moduleContext(shell: SyncShell, args: string[]): CommandContext {
    return {
        args,
        cwd: shell.cwd,
        env: shell.env,
        input: shell.input,
        fs: fsForModules(shell.ctx.fileSystem, () => shell.cwd)
    };
}

/**
 * The state a line's builtins share, created on the first builtin that needs one and kept on the
 * shell for the rest of the line, so `export FOO=bar; declare -p FOO` behaves as it does in one
 * shell. `host` is the module's free slot for the host: the runner installed above reads the shell
 * back out of it.
 */
function shellStateFor(shell: SyncShell): ShellState {
    let state = shell.state;
    if (state === undefined) {
        state = createShellState(shell.env, shell.cwd, fsForModules(shell.ctx.fileSystem, () => shell.cwd));
        state.host = shell;
        if (shell.name !== undefined) state.shellName = shell.name;
        shell.state = state;
    }
    // `cd` moves the shell's directory; `pushd` moves the state's. The two are one directory.
    state.cwd = shell.cwd;
    return state;
}

/**
 * `builtins.ts` binds one state at a time for the contexts a host builds itself (`setActiveState`).
 * The previous one is restored afterwards, so a shell nested inside this one (a node child running
 * `sh` synchronously) gets its own back.
 */
let activeShellState: ShellState | null = null;

function withShellState<T>(state: ShellState, body: () => T): T {
    const saved = activeShellState;
    activeShellState = state;
    setActiveState(state);
    try {
        return body();
    } finally {
        activeShellState = saved;
        setActiveState(saved);
    }
}

/** Carries the builtins' exported variables into the environment the other commands of the line run with. */
function syncShellEnv(shell: SyncShell, state: ShellState): void {
    const exported = state.env;
    for (const name of Object.keys(shell.env)) if (!(name in exported)) delete shell.env[name];
    for (const name of Object.keys(exported)) shell.env[name] = exported[name];
}

/** `exec` and an `exit` inside `eval` leave the script engine as a thrown signal, not a result. */
function signalName(error: unknown): string {
    return (error as { constructor?: { name?: string } } | null | undefined)?.constructor?.name ?? '';
}

/**
 * One command out of `builtins.ts`. The handler is the module's own and is called with the ordinary
 * module context; three things the other modules do not need are handled here.
 *
 *  - the state: bound for the duration of the call, and written back to the shell afterwards, so
 *    the directory and the exported environment a builtin changed are what the next command sees;
 *  - the module's output sink: a builtin may write with `writeOut`/`writeErr` instead of returning
 *    (`type`, `alias`, `unalias`, `hash`, `wait`), so `state.io` is collected around the call and
 *    joined to what the handler returned;
 *  - the script engine's signals: `exec`, and an `exit` inside `eval`, end the line as they end a
 *    shell, and carry their status with them.
 */
function shellBuiltinModule(shell: SyncShell, command: string, args: string[]): ShellStep {
    // `exec 3>&1` names no command to replace the shell with. Saying it is not supported is true;
    // running it would search for a utility called `3>&1` and report a command that does exist.
    if (command === 'exec' && args.length > 0 && /^[0-9]*(>>?|<<<?|&)/.test(args[0])) {
        return { stdout: '', stderr: `exec: ${args.join(' ')}: a redirection with no command is not supported on this runtime`, exitCode: 1 };
    }
    const handler = SHELL_BUILTIN_UTILS[command];
    const state = shellStateFor(shell);
    const savedIo = state.io;
    const savedBuffer = state.inputBuffer;
    const savedCursor = state.inputCursor;
    // `read` and `mapfile` take their lines out of the state's buffer, not out of the context
    state.inputBuffer = shell.input ?? '';
    state.inputCursor = 0;
    state.io = { stdout: '', stderr: '' };
    try {
        return withShellState(state, () => {
            let step: ShellStep;
            try {
                const result = handler(moduleContext(shell, args));
                step = {
                    stdout: state.io.stdout + result.stdout,
                    stderr: state.io.stderr + result.stderr,
                    exitCode: result.exitCode
                };
            } catch (error) {
                if (isNotSupported(error)) throw error;
                const name = signalName(error);
                const code = (error as { code?: unknown } | null | undefined)?.code;
                if (name === 'ExitSignal' || name === 'ReturnSignal') {
                    shell.stopped = true;
                    step = { stdout: state.io.stdout, stderr: state.io.stderr, exitCode: typeof code === 'number' ? code : 0 };
                } else if (name === 'BreakSignal' || name === 'ContinueSignal') {
                    step = { stdout: state.io.stdout, stderr: state.io.stderr, exitCode: 0 };
                } else {
                    step = {
                        stdout: state.io.stdout,
                        stderr: state.io.stderr + (error instanceof Error ? error.message : String(error)),
                        exitCode: 1
                    };
                }
            } finally {
                if (state.execTarget !== null) shell.stopped = true;
                shell.cwd = state.cwd;
                syncShellEnv(shell, state);
            }
            return step;
        });
    } finally {
        state.io = savedIo;
        state.inputBuffer = savedBuffer;
        state.inputCursor = savedCursor;
    }
}

/**
 * One command out of a shell command module, or null when the name belongs to no module. The module
 * resolves its own paths from `cwd`, so nothing here normalises an argument: `archives.ts` refuses
 * a `..` member rather than rewriting it, and rewriting before the call would undo that.
 */
function shellModuleCommand(shell: SyncShell, command: string, args: string[]): ShellStep | null {
    // builtins.ts keeps state between commands, so it is reached through its own entry point
    if (SHELL_BUILTIN_NAMES.has(command)) return shellBuiltinModule(shell, command, args);
    const handler = SHELL_MODULE_COMMANDS[command];
    if (handler === undefined) return null;
    try {
        const result: CommandResult = handler(moduleContext(shell, args));
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } catch (error) {
        if (isNotSupported(error)) throw error;
        return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
    }
}

function notSupportedSync(what: string): Error {
    return Object.assign(
        new Error(`child_process: ${what} cannot run inside a synchronous call on this runtime; use the asynchronous API`),
        { code: 'ERR_NOT_SUPPORTED' }
    );
}

function isNotSupported(error: unknown): boolean {
    return (error as { code?: unknown } | null | undefined)?.code === 'ERR_NOT_SUPPORTED';
}

/** The error a failed spawn reports, named the way spawnSync names it. */
function syncSpawnError(error: unknown, file: string, argv: string[]): SyncErrorInfo {
    if (isNotSupported(error)) {
        return { code: 'ERR_NOT_SUPPORTED', message: (error as Error).message };
    }
    const failure = spawnFailure(error, file, argv) as Error & { code?: string };
    if (failure.code === 'ENOENT') {
        return { code: 'ENOENT', message: `spawnSync ${file} ENOENT`, errno: -2, syscall: `spawnSync ${file}`, path: file, spawnargs: argv };
    }
    return { code: String(failure.code), message: failure.message, syscall: `spawnSync ${file}`, path: file, spawnargs: argv };
}

/** The file and arguments a node command runs, as NodeProcessExecutor reads them. */
function nodeInvocation(argv: string[]): { file: string; args: string[]; evalSource?: string } {
    if (argv.length === 0) throw new Error('No JavaScript file specified');
    if (argv[0] === '-e' || argv[0] === '--eval') {
        if (argv.length < 2) throw new Error(`${argv[0]} requires an argument`);
        return { file: '[eval]', args: argv.slice(2), evalSource: argv[1] };
    }
    if (argv[0] === '-p' || argv[0] === '--print') {
        if (argv.length < 2) throw new Error(`${argv[0]} requires an argument`);
        return { file: '[eval]', args: argv.slice(2), evalSource: printEvalSource(argv[1]) };
    }
    return { file: argv[0], args: argv.slice(1) };
}

/** One node child run to completion. The caller decides what a blocked or timed-out run means. */
function nodeRun(
    ctx: CapabilityContext,
    invocation: { file: string; args: string[]; evalSource?: string },
    env: Record<string, string>,
    cwd: string,
    timeoutMs: number,
    killSignal: string
): SyncChildResult & { pid: number } {
    const runner = nodeSyncRunner.run;
    if (runner === undefined) throw notSupportedSync('a node child');
    const pid = nextSyncPid++;
    const result = runner({
        pid,
        parentPid: ctx.pid,
        file: invocation.file,
        args: invocation.args,
        cwd,
        env,
        evalSource: invocation.evalSource,
        fileSystem: ctx.fileSystem,
        services: ctx.services,
        timeoutMs,
        killSignal
    });
    return { pid, ...result };
}

function shellPath(shell: SyncShell, path: string): string {
    return path.startsWith('/') ? path : `${shell.cwd}/${path}`.replace(/\/+/g, '/');
}

/** A node command inside the shell: its status and output become the shell command's. */
function shellNode(shell: SyncShell, invocation: { file: string; args: string[]; evalSource?: string }): ShellStep {
    const run = nodeRun(shell.ctx, invocation, shell.env, shell.cwd, 0, 'SIGTERM');
    if (run.blocked !== undefined) throw notSupportedSync(`the shell command ${invocation.file}, which waits on ${run.blocked}`);
    return { stdout: run.stdout, stderr: run.stderr, exitCode: run.status ?? 1 };
}

/** Shell's built-ins with the output and status Shell.executeBuiltin gives them. */
function shellBuiltin(shell: SyncShell, command: string, args: string[]): ShellStep {
    const fs = shell.ctx.fileSystem;
    const at = (path: string) => shellPath(shell, path);
    const ok = (stdout = ''): ShellStep => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr: string): ShellStep => ({ stdout: '', stderr, exitCode: 1 });
    try {
        switch (command) {
            case 'echo':
                return ok(args.join(' ') + '\n');
            case 'true':
                return ok();
            case 'false':
                return fail('');
            case 'cat': {
                // no argument reads the child's input (Shell says 'No file specified'; Node reads stdin)
                if (args.length === 0) return ok(shell.input ?? '');
                const content = fs.readFile(at(args[0]));
                return content === undefined ? fail(`File not found: ${args[0]}`) : ok(content);
            }
            case 'pwd':
                return ok(shell.cwd + '\n');
            case 'ls': {
                const entries = fs.listDirectory(at(args[0] || shell.cwd));
                return ok(entries.length > 0 ? entries.join('\n') + '\n' : '');
            }
            case 'mkdir':
                if (args.length === 0) return fail('No directory specified');
                fs.createDirectory(at(args[0]));
                return ok();
            case 'rm': {
                if (args.length === 0) return fail('No file specified');
                const recursive = args.includes('-r') || args.includes('-rf');
                for (const file of args.filter((arg) => !arg.startsWith('-'))) {
                    fs.deleteFile(at(file), recursive);
                }
                return ok();
            }
            case 'rmdir':
                if (args.length === 0) return fail('No directory specified');
                fs.deleteDirectory(at(args[0]));
                return ok();
            case 'touch':
                if (args.length === 0) return fail('No file specified');
                fs.writeFile(at(args[0]), '');
                return ok();
            case 'cd': {
                const target = args[0] || '/';
                const next = at(target);
                if (!fs.isDirectory(next)) return fail(`Directory not found: ${target}`);
                shell.cwd = next;
                return ok();
            }
            case 'cp':
            case 'mv': {
                if (args.length < 2) return fail('Source and destination required');
                const [src, dest] = args;
                const content = fs.readFile(at(src));
                if (content === undefined) return fail(`Source file not found: ${src}`);
                fs.writeFile(at(dest), content);
                if (command === 'mv') fs.deleteFile(at(src));
                return ok();
            }
            default:
                return fail(`Command not found: ${command}`);
        }
    } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
}

/** Shell.execute: `>` and `>>` in a built-in's words write its output to files when it succeeds. */
function shellBuiltinWithRedirects(shell: SyncShell, command: string, args: string[]): ShellStep {
    const words: string[] = [];
    const redirects: { type: '>' | '>>'; file: string }[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '>' || args[i] === '>>') {
            if (i + 1 >= args.length) return { stdout: '', stderr: `Syntax error: missing file for redirection ${args[i]}`, exitCode: 1 };
            redirects.push({ type: args[i] as '>' | '>>', file: args[i + 1] });
            i++;
        } else {
            words.push(args[i]);
        }
    }
    const step = shellBuiltin(shell, command, words);
    if (step.exitCode !== 0 || redirects.length === 0) return step;
    for (const redirect of redirects) {
        try {
            const file = shellPath(shell, redirect.file);
            const fs = shell.ctx.fileSystem;
            fs.writeFile(file, redirect.type === '>>' ? (fs.readFile(file) || '') + step.stdout : step.stdout);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { stdout: '', stderr: `Failed to redirect to ${redirect.file}: ${message}`, exitCode: 1 };
        }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
}

/** One command of a command line, and the operator that joins it to the command before it. */
interface ShellSegment {
    words: RawWord[];
    op: ';' | '&&' | '||' | null;
}

/**
 * Splits a command line on `;`, `&&` and `||`. A quoted run holds an operator, so it is copied
 * whole. A trailing operator leaves a final segment with no command, which the runner skips.
 */
function splitCommandList(line: string): ShellSegment[] {
    const segments: ShellSegment[] = [];
    let text = '';
    let op: ';' | '&&' | '||' | null = null;
    const push = (): void => {
        segments.push({ words: tokenizeLine(text), op });
        text = '';
    };
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === '\\') {
            text += line.slice(i, i + 2);
            i += 2;
        } else if (ch === "'" || ch === '"') {
            // a quoted run holds an operator, so it is copied whole
            let end = i + 1;
            while (end < line.length && line[end] !== ch) {
                const span = ch === '"' ? constructSpan(line, end) : -1;
                if (span !== -1) {
                    end = span;
                    continue;
                }
                end += ch === '"' && line[end] === '\\' ? 2 : 1;
            }
            text += line.slice(i, Math.min(end + 1, line.length));
            i = end + 1;
        } else if (ch === ';') {
            push();
            op = ';';
            i++;
        } else if ((ch === '&' || ch === '|') && line[i + 1] === ch) {
            push();
            op = ch === '&' ? '&&' : '||';
            i += 2;
        } else {
            // a `$( )` or backquoted construct holds an operator too
            const span = constructSpan(line, i);
            if (span !== -1) {
                text += line.slice(i, span);
                i = span;
                continue;
            }
            // a lone & (a background job) is not an operator this shell runs; a lone | is left
            // in the words here and splits the command into a pipeline in splitPipeline
            text += ch;
            i++;
        }
    }
    push();
    return segments;
}

/* ----------------------------------------------------------------------------------------------
 * Parameter expansion
 *
 * The words a command line is made of are kept as *parts* rather than strings, because a shell has
 * to remember which characters came from where: `$x` expands whether or not it is quoted, but only
 * an unquoted expansion is split into fields, and a single-quoted `$x` does not expand at all.
 * Tokenizing records that; expanding reads it back.
 * -------------------------------------------------------------------------------------------- */

/** One piece of a word. `expand`: `$` in this text is expanded. `split`: the result is field-split. */
interface ShellPart {
    text: string;
    expand: boolean;
    split: boolean;
}

/** A word as it was written: the pieces it is made of, in order. */
type RawWord = ShellPart[];

/** The index just past a `$( )`, `${ }` or backquoted construct starting at `i`, or -1 when it is not closed. */
function constructSpan(text: string, i: number): number {
    if (text[i] === '`') {
        const end = findBacktick(text, i + 1);
        return end === -1 ? -1 : end + 1;
    }
    if (text[i] === '$' && text[i + 1] === '(') {
        const end = matchParen(text, i + 1);
        return end === -1 ? -1 : end + 1;
    }
    if (text[i] === '$' && text[i + 1] === '{') {
        const end = matchBrace(text, i + 1);
        return end === -1 ? -1 : end + 1;
    }
    return -1;
}

/**
 * Splits a command line into words the way a POSIX shell quotes them: single quotes keep everything,
 * double quotes keep everything except \" \\ \$ \` and an escaped newline, a bare backslash escapes
 * the next character, and adjacent quoted or plain pieces make one word. No expansion is done.
 *
 * A `$( )`, `${ }` or backquoted construct is one piece whatever it holds, so the white space, the
 * operators and the escaped `$` inside it never split the word or the line.
 */
function tokenizeLine(line: string): RawWord[] {
    const words: RawWord[] = [];
    let word: RawWord = [];
    let inWord = false;
    const push = (text: string, expand: boolean, split: boolean): void => {
        if (text === '') return;
        const last = word[word.length - 1];
        if (last !== undefined && last.expand === expand && last.split === split) last.text += text;
        else word.push({ text, expand, split });
        inWord = true;
    };
    const flush = (): void => {
        if (inWord) {
            words.push(word);
            word = [];
            inWord = false;
        }
    };
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === ' ' || ch === '\t' || ch === '\n') {
            flush();
            i++;
        } else if (ch === "'") {
            const close = line.indexOf("'", i + 1);
            const stop = close === -1 ? line.length : close;
            push(line.slice(i + 1, stop), false, false);
            i = stop + 1;
        } else if (ch === '"') {
            inWord = true;
            i++;
            while (i < line.length && line[i] !== '"') {
                const next = line[i + 1];
                const span = constructSpan(line, i);
                if (span !== -1) {
                    push(line.slice(i, span), true, false);
                    i = span;
                    continue;
                }
                if (line[i] === '\\' && next !== undefined && '"\\$`\n'.includes(next)) {
                    if (next !== '\n') push(next, false, false);
                    i += 2;
                } else {
                    push(line[i], true, false);
                    i++;
                }
            }
            i++;
        } else if (ch === '\\') {
            const next = line[i + 1];
            if (next !== undefined && next !== '\n') push(next, false, false);
            i += 2;
        } else {
            const span = constructSpan(line, i);
            if (span !== -1) {
                push(line.slice(i, span), true, true);
                i = span;
            } else {
                push(ch, true, true);
                i++;
            }
        }
    }
    flush();
    return words;
}

/** The word as it was written, before any expansion. */
function rawText(word: RawWord): string {
    return word.map((part) => part.text).join('');
}

/** True when the word is one unquoted piece of exactly `text`: an unquoted `|`, `<` or `2>&1`. */
function rawIs(word: RawWord, text: string): boolean {
    return word.length === 1 && word[0].expand && word[0].text === text;
}

/** What a word expands to: `text` plus `split` (field splitting applies) and, for `"$@"`, the field boundary. */
interface ExpandAtom {
    text: string;
    split: boolean;
    /** The field before this one ends here. */
    before?: boolean;
    /** This field ends here, even where the next piece would otherwise join it. */
    after?: boolean;
}

/** Where one expansion reports an error (`${x:?}`) and the status of a command substitution. */
interface ExpandCtx {
    error: string | null;
    code: number;
    substStatus: number | null;
}

/** `IFS` is the default one; only its white space is split on. */
const IFS_SPLIT = /[ \t\n]+/;

/** A leading `NAME=` turns a word into an assignment rather than a command. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

function positionalOf(shell: SyncShell): string[] {
    return shell.state?.positional ?? [];
}

/** `$name`: the shell's own variables first, then the environment the line started with. */
function lookupVar(shell: SyncShell, name: string): string | undefined {
    const state = shell.state;
    if (state !== undefined) {
        for (let i = state.scopes.length - 1; i >= 0; i--) {
            const found = state.scopes[i].get(name);
            if (found !== undefined) return found.value;
        }
    }
    const value = shell.env[name];
    return typeof value === 'string' ? value : undefined;
}

function isSetVar(shell: SyncShell, name: string): boolean {
    if ('?0#$!-@*'.includes(name)) return true;
    if (/^[0-9]+$/.test(name)) return Number(name) <= positionalOf(shell).length;
    return lookupVar(shell, name) !== undefined;
}

/** The value of one parameter, special names included; `$@` and `$*` are handled by parameterAtoms. */
function valueOfName(shell: SyncShell, name: string): string {
    switch (name) {
        case '?':
            return String(shell.lastStatus);
        case '0':
            return shell.name ?? shell.state?.shellName ?? 'sh';
        case '#':
            return String(positionalOf(shell).length);
        case '$':
            return '1';
        case '!':
            return '0';
        case '-':
            return '';
        default:
            break;
    }
    if (/^[1-9][0-9]*$/.test(name)) return positionalOf(shell)[Number(name) - 1] ?? '';
    return lookupVar(shell, name) ?? '';
}

/**
 * `$@` and `$*` are the two that are not one string. `"$@"` is one field per positional parameter,
 * and `$*` in quotes is one field with them joined; unquoted, the two behave alike and are split.
 */
function parameterAtoms(shell: SyncShell, name: string, split: boolean, out: ExpandAtom[]): void {
    const params = positionalOf(shell);
    if (!split && name === '@') {
        for (let i = 0; i < params.length; i++) {
            out.push({ text: params[i], split: false, before: i > 0, after: i < params.length - 1 });
        }
        return;
    }
    out.push({ text: params.join(' '), split });
}

/** `NAME=value` in the shell's own variables, and in the environment where it is already exported. */
function assignVar(shell: SyncShell, name: string, value: string): void {
    const state = shellStateFor(shell);
    let existing: ShellVar | undefined;
    for (let i = state.scopes.length - 1; i >= 0; i--) {
        const found = state.scopes[i].get(name);
        if (found !== undefined) {
            existing = found;
            break;
        }
    }
    if (existing?.readonly === true) return;
    const exported = existing?.export === true || (existing === undefined && Object.prototype.hasOwnProperty.call(shell.env, name));
    state.scopes[0].set(name, exported ? { value, export: true } : { value });
    if (exported) shell.env[name] = value;
}

/** Runs a `$( )` or backquoted script in a shell of its own and strips the trailing newlines, as a shell does. */
function runSubstitution(shell: SyncShell, script: string): { text: string; status: number } {
    const child: SyncShell = {
        ctx: shell.ctx,
        cwd: shell.cwd,
        env: { ...shell.env },
        input: shell.input,
        name: shell.name,
        lastStatus: shell.lastStatus,
        state: shell.state
    };
    const step = shellLine(child, script);
    // `cd` inside the substitution is the substitution's own, not the shell's
    if (child.state !== undefined) child.state.cwd = shell.cwd;
    return { text: step.stdout.replace(/\n+$/, ''), status: step.exitCode };
}

/** The index of the `)` closing the `(` at `start`, or -1 when it is never closed. */
function matchParen(text: string, start: number): number {
    let depth = 0;
    let i = start;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            i += 2;
        } else if (ch === "'") {
            const close = text.indexOf("'", i + 1);
            i = close === -1 ? text.length : close + 1;
        } else if (ch === '"') {
            i++;
            while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
            i++;
        } else if (ch === '(') {
            depth++;
            i++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0) return i;
            i++;
        } else {
            i++;
        }
    }
    return -1;
}

/** The index of the final `)` of a `$(( ))`, or -1 when the expression is not closed. */
function matchArithmetic(text: string, start: number): number {
    const close = matchParen(text, start);
    return close !== -1 && text[close + 1] === ')' ? close + 1 : -1;
}

/** The index of the `}` closing the `{` at `start`, counting nested `${`. */
function matchBrace(text: string, start: number): number {
    let depth = 0;
    let i = start;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            i += 2;
        } else if (ch === '{') {
            depth++;
            i++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
            i++;
        } else {
            i++;
        }
    }
    return -1;
}

/** The index of the next unescaped backtick at or after `from`, or -1. */
function findBacktick(text: string, from: number): number {
    for (let i = from; i < text.length; i++) {
        if (text[i] === '\\') {
            i++;
            continue;
        }
        if (text[i] === '`') return i;
    }
    return -1;
}

/** Inside backquotes only `$`, `` ` `` and `\` may be escaped; every other backslash stays. */
function unescapeBacktick(text: string): string {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\' && '$`\\'.includes(text[i + 1] ?? '')) {
            out += text[i + 1];
            i++;
        } else {
            out += text[i];
        }
    }
    return out;
}

/** A glob pattern as a regular expression: `*`, `?` and `[...]`, with `*` greedy when `greedy` is set. */
function patternRegExp(pattern: string, greedy: boolean): RegExp | null {
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') {
            source += escapeRegExp(pattern[i + 1] ?? '\\');
            i++;
        } else if (ch === '*') {
            source += greedy ? '(.*)' : '(.*?)';
        } else if (ch === '?') {
            source += '.';
        } else if (ch === '[') {
            let end = i + 1;
            if (pattern[end] === '!' || pattern[end] === '^') end++;
            if (pattern[end] === ']') end++;
            while (end < pattern.length && pattern[end] !== ']') end += pattern[end] === '\\' ? 2 : 1;
            if (end >= pattern.length) {
                source += '\\[';
            } else {
                let body = pattern.slice(i + 1, end);
                if (body.startsWith('!')) body = '^' + body.slice(1);
                source += '[' + body + ']';
                i = end;
            }
        } else {
            source += escapeRegExp(ch);
        }
    }
    try {
        return new RegExp(source);
    } catch {
        return null;
    }
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The parameter name at the start of the inside of a `${ }`. */
function parameterName(text: string): string | null {
    if (text === '') return null;
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text);
    if (name !== null) return name[0];
    const digits = /^[0-9]+/.exec(text);
    if (digits !== null) return digits[0];
    return '@*#?$!-'.includes(text[0]) ? text[0] : null;
}

/** The whole value of one piece of a word, with no field splitting: an assignment, a pattern, a redirect's file. */
function expandText(shell: SyncShell, text: string, ctx: ExpandCtx): string {
    const atoms: ExpandAtom[] = [];
    expandInto(shell, text, false, atoms, ctx);
    return atoms.map((atom) => atom.text).join('');
}

/** Expands one piece of a word into atoms. `split` says whether the result is subject to field splitting. */
function expandInto(shell: SyncShell, text: string, split: boolean, out: ExpandAtom[], ctx: ExpandCtx): void {
    let literal = '';
    const flushLiteral = (): void => {
        if (literal !== '') {
            out.push({ text: literal, split });
            literal = '';
        }
    };
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            const next = text[i + 1];
            if (next !== undefined && '$`\\"'.includes(next)) {
                literal += next;
                i += 2;
                continue;
            }
            literal += ch;
            i++;
            continue;
        }
        if (ch === '`') {
            const end = findBacktick(text, i + 1);
            if (end === -1) {
                literal += ch;
                i++;
                continue;
            }
            flushLiteral();
            const run = runSubstitution(shell, unescapeBacktick(text.slice(i + 1, end)));
            ctx.substStatus = run.status;
            out.push({ text: run.text, split });
            i = end + 1;
            continue;
        }
        if (ch !== '$') {
            literal += ch;
            i++;
            continue;
        }
        const next = text[i + 1];
        if (next === '(' && text[i + 2] === '(') {
            const end = matchArithmetic(text, i + 2);
            if (end !== -1) {
                flushLiteral();
                out.push({ text: String(arithmeticValue(shell, text.slice(i + 3, end - 1))), split });
                i = end + 1;
                continue;
            }
        }
        if (next === '(') {
            const end = matchParen(text, i + 1);
            if (end !== -1) {
                flushLiteral();
                const run = runSubstitution(shell, text.slice(i + 2, end));
                ctx.substStatus = run.status;
                out.push({ text: run.text, split });
                i = end + 1;
                continue;
            }
        }
        if (next === '{') {
            const end = matchBrace(text, i + 1);
            if (end !== -1) {
                flushLiteral();
                paramExpansion(shell, text.slice(i + 2, end), split, out, ctx);
                i = end + 1;
                continue;
            }
        }
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
        if (name !== null) {
            flushLiteral();
            out.push({ text: valueOfName(shell, name[0]), split });
            i += 1 + name[0].length;
            continue;
        }
        if (next !== undefined && '0123456789#@*?$!-'.includes(next)) {
            flushLiteral();
            if (next === '@' || next === '*') parameterAtoms(shell, next, split, out);
            else out.push({ text: valueOfName(shell, next), split });
            i += 2;
            continue;
        }
        literal += ch;
        i++;
    }
    flushLiteral();
}

/** `$(( ))`. The expression is the module's own evaluator, so the operators are the ones it already has. */
function arithmeticValue(shell: SyncShell, expression: string): number | string {
    try {
        return evalArith(shellStateFor(shell), expression);
    } catch {
        return '';
    }
}

/** One `${...}`: the operators POSIX has, plus `${x/p/r}` and `${x:o:l}`. */
function paramExpansion(shell: SyncShell, body: string, split: boolean, out: ExpandAtom[], ctx: ExpandCtx): void {
    const literal = (): void => {
        out.push({ text: '${' + body + '}', split: false });
    };
    if (body.startsWith('#') && body.length > 1) {
        const name = parameterName(body.slice(1));
        if (name === null) return literal();
        const length = name === '@' || name === '*' ? positionalOf(shell).length : valueOfName(shell, name).length;
        out.push({ text: String(length), split });
        return;
    }
    const name = parameterName(body);
    if (name === null) return literal();
    const rest = body.slice(name.length);
    const scalar = (): string => (name === '@' || name === '*' ? positionalOf(shell).join(' ') : valueOfName(shell, name));
    const set = isSetVar(shell, name);
    const empty = !set || scalar() === '';
    const word = (text: string): string => expandText(shell, text, ctx);
    if (rest === '') {
        if (name === '@' || name === '*') parameterAtoms(shell, name, split, out);
        else out.push({ text: valueOfName(shell, name), split });
        return;
    }
    const substring = /^:(-?\d+)(?::(-?\d+))?$/.exec(rest);
    if (substring !== null) {
        const from = Number(substring[1]);
        const value = scalar().split('');
        const start = from < 0 ? Math.max(0, value.length + from) : from;
        const count = substring[2] === undefined ? undefined : Number(substring[2]);
        out.push({ text: (count === undefined ? value.slice(start) : count < 0 ? value.slice(start, value.length + count) : value.slice(start, start + count)).join(''), split });
        return;
    }
    if (rest.startsWith(':-')) {
        out.push({ text: empty ? word(rest.slice(2)) : scalar(), split });
        return;
    }
    if (rest.startsWith('-') && rest[1] !== '}') {
        out.push({ text: set ? scalar() : word(rest.slice(1)), split });
        return;
    }
    if (rest.startsWith(':=') || rest.startsWith('=')) {
        const value = rest.startsWith(':=') ? rest.slice(2) : rest.slice(1);
        if (empty) {
            const assigned = word(value);
            assignVar(shell, name, assigned);
            out.push({ text: assigned, split });
        } else {
            out.push({ text: scalar(), split });
        }
        return;
    }
    if (rest.startsWith(':+')) {
        out.push({ text: empty ? '' : word(rest.slice(2)), split });
        return;
    }
    if (rest.startsWith('+')) {
        out.push({ text: set ? word(rest.slice(1)) : '', split });
        return;
    }
    if (rest.startsWith(':?') || rest.startsWith('?')) {
        const colon = rest.startsWith(':?');
        if (colon ? empty : !set) {
            const message = word(rest.slice(colon ? 2 : 1));
            ctx.error = `${name}: ${message === '' ? 'parameter null or not set' : message}`;
            ctx.code = 127;
        } else {
            out.push({ text: scalar(), split });
        }
        return;
    }
    const trimmed = (operator: '#' | '%', pattern: string): string => {
        const source = scalar();
        const regexp = patternRegExp(pattern, operator === '#' ? rest.startsWith('##') : rest.startsWith('%%'));
        if (regexp === null) return source;
        const anchored = new RegExp(operator === '#' ? '^' + regexp.source : regexp.source + '$');
        return source.replace(anchored, '');
    };
    if (rest.startsWith('##')) {
        out.push({ text: trimmed('#', word(rest.slice(2))), split });
        return;
    }
    if (rest.startsWith('#')) {
        out.push({ text: trimmed('#', word(rest.slice(1))), split });
        return;
    }
    if (rest.startsWith('%%')) {
        out.push({ text: trimmed('%', word(rest.slice(2))), split });
        return;
    }
    if (rest.startsWith('%')) {
        out.push({ text: trimmed('%', word(rest.slice(1))), split });
        return;
    }
    if (rest.startsWith('/')) {
        const every = rest.startsWith('//');
        let rest2 = rest.slice(every ? 2 : 1);
        let anchor = '';
        if (rest2.startsWith('#')) {
            anchor = '^';
            rest2 = rest2.slice(1);
        } else if (rest2.startsWith('%')) {
            anchor = '$';
            rest2 = rest2.slice(1);
        }
        let at = -1;
        for (let i = 0; i < rest2.length; i++) {
            if (rest2[i] === '\\') {
                i++;
                continue;
            }
            if (rest2[i] === '/') {
                at = i;
                break;
            }
        }
        const pattern = word(at === -1 ? rest2 : rest2.slice(0, at));
        const replacement = word(at === -1 ? '' : rest2.slice(at + 1));
        const regexp = patternRegExp(pattern, false);
        if (regexp === null) {
            out.push({ text: scalar(), split });
            return;
        }
        const source = scalar();
        const flags = every ? 'g' : '';
        out.push({ text: source.replace(new RegExp(anchor + regexp.source, flags), replacement.replace(/\$/g, '$$')), split });
        return;
    }
    literal();
}

/**
 * One word's worth of fields. Field splitting happens here and only here: a run of white space that
 * came out of an unquoted expansion ends the field, and an empty unquoted expansion leaves none.
 */
function assembleFields(atoms: ExpandAtom[]): string[] {
    const fields: string[] = [];
    let cur = '';
    let have = false;
    for (const atom of atoms) {
        if (atom.before === true && have) {
            fields.push(cur);
            cur = '';
            have = false;
        }
        if (atom.split) {
            const pieces = atom.text.split(IFS_SPLIT);
            for (let i = 0; i < pieces.length; i++) {
                if (i > 0) {
                    if (have) fields.push(cur);
                    cur = '';
                    have = false;
                }
                if (pieces[i] !== '') {
                    cur += pieces[i];
                    have = true;
                }
            }
        } else {
            cur += atom.text;
            have = true;
        }
        if (atom.after === true && have) {
            fields.push(cur);
            cur = '';
            have = false;
        }
    }
    if (have) fields.push(cur);
    return fields;
}

/**
 * The fields one simple command runs with. Leading `NAME=value` words are assignments, not a
 * command: they go into the shell's variables, and a line that is nothing but assignments has no
 * command to run. Returns null for that, and for a word list with no words at all.
 */
function expandCommandWords(shell: SyncShell, words: RawWord[], ctx: ExpandCtx): string[] | null {
    let i = 0;
    while (i < words.length && ASSIGNMENT_WORD.test(rawText(words[i]))) {
        const assignment = expandWordText(shell, words[i], ctx);
        const at = assignment.indexOf('=');
        if (at > 0) assignVar(shell, assignment.slice(0, at), assignment.slice(at + 1));
        i++;
    }
    if (i === words.length) return null;
    const fields: string[] = [];
    for (let j = i; j < words.length; j++) fields.push(...assembleFields(expandParts(shell, words[j], ctx)));
    return fields;
}

/** The value of a whole word with no field splitting: an assignment, a redirect's file. */
function expandWordText(shell: SyncShell, word: RawWord, ctx: ExpandCtx): string {
    return expandParts(shell, word, ctx)
        .map((atom) => atom.text)
        .join('');
}

function expandParts(shell: SyncShell, parts: ShellPart[], ctx: ExpandCtx): ExpandAtom[] {
    const atoms: ExpandAtom[] = [];
    for (const part of parts) {
        if (part.expand) expandInto(shell, part.text, part.split, atoms, ctx);
        else atoms.push({ text: part.text, split: false });
    }
    return atoms;
}

/** Removes a `2>&1` or `2>/dev/null` from a command's words and reports which of the two it was. */
function takeStderrRedirect(words: RawWord[]): 'stdout' | 'null' | null {
    for (let i = words.length - 1; i >= 0; i--) {
        if (rawIs(words[i], '2>&1')) {
            words.splice(i, 1);
            return 'stdout';
        }
        if (rawIs(words[i], '2>/dev/null')) {
            words.splice(i, 1);
            return 'null';
        }
    }
    return null;
}

/**
 * One command of a pipeline: its words, the `|` that bounded it already taken out. A `|` splits only
 * where it stands as a word of its own and was not quoted, so `echo "a | b"` is one command.
 */
function splitPipeline(words: RawWord[]): RawWord[][] | null {
    if (!words.some((word) => rawIs(word, '|'))) return [words];
    const stages: RawWord[][] = [[]];
    for (const word of words) {
        if (rawIs(word, '|')) stages.push([]);
        else stages[stages.length - 1].push(word);
    }
    if (stages.some((stage) => stage.length === 0)) return null;
    return stages;
}

/** Removes a `< file` from a command's words; `missing` is the syntax error of a `<` with no file after it. */
function takeInputRedirect(words: RawWord[]): { file: RawWord } | 'missing' | null {
    const at = words.findIndex((word) => rawIs(word, '<'));
    if (at === -1) return null;
    if (at + 1 >= words.length) return 'missing';
    const file = words[at + 1];
    words.splice(at, 2);
    return { file };
}

/** Removes every `> file` and `>> file` from a command's words; `missing` names a redirect with no file after it. */
function takeOutputRedirects(words: string[]): { redirects: { type: '>' | '>>'; file: string }[]; missing: string | null } {
    const redirects: { type: '>' | '>>'; file: string }[] = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (word !== '>' && word !== '>>') continue;
        if (i + 1 >= words.length) return { redirects, missing: word };
        redirects.push({ type: word as '>' | '>>', file: words[i + 1] });
        words.splice(i, 2);
        i--;
    }
    return { redirects, missing: null };
}

/** The text `< file` feeds a command; a file that is not there fails the command, as a shell's does. */
function readShellInput(shell: SyncShell, file: string): { text: string; error: string | null } {
    try {
        const text = shell.ctx.fileSystem.readFile(shellPath(shell, file));
        return text === undefined ? { text: '', error: `No such file or directory: ${file}` } : { text, error: null };
    } catch (error) {
        return { text: '', error: error instanceof Error ? error.message : String(error) };
    }
}

/** Writes what a command wrote to the files of its `>` and `>>`, as Shell.execute does for a built-in. */
function applyOutputRedirects(shell: SyncShell, redirects: { type: '>' | '>>'; file: string }[], step: ShellStep): ShellStep {
    if (step.exitCode !== 0 || redirects.length === 0) return step;
    for (const redirect of redirects) {
        try {
            const file = shellPath(shell, redirect.file);
            const fs = shell.ctx.fileSystem;
            fs.writeFile(file, redirect.type === '>>' ? (fs.readFile(file) || '') + step.stdout : step.stdout);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { stdout: '', stderr: `Failed to redirect to ${redirect.file}: ${message}`, exitCode: 1 };
        }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
}

/**
 * One command with its `>` and `>>` applied. A built-in keeps exactly what Shell.execute gives it
 * (shellBuiltinWithRedirects, untouched); every other command has the same redirects applied here,
 * so a module command writes its output to a file the way a built-in does.
 */
function shellCommandRedirected(shell: SyncShell, words: string[]): ShellStep {
    if (SHELL_BUILTINS.has(words[0])) return shellCommand(shell, words);
    const rest = words.slice(1);
    const { redirects, missing } = takeOutputRedirects(rest);
    if (missing !== null) return { stdout: '', stderr: `Syntax error: missing file for redirection ${missing}`, exitCode: 1 };
    if (redirects.length === 0) return shellCommand(shell, words);
    return applyOutputRedirects(shell, redirects, shellCommand(shell, [words[0], ...rest]));
}

/**
 * One command of a pipeline, run with `input` as its standard input: its own `< file` wins over the
 * pipe, and its own `2>&1` or `2>/dev/null` applies to it alone, not to the pipeline.
 */
function shellStage(shell: SyncShell, words: RawWord[], input: string | null): ShellStep {
    const stageWords = words.slice();
    const errRedirect = takeStderrRedirect(stageWords);
    const inRedirect = takeInputRedirect(stageWords);
    if (inRedirect === 'missing') return { stdout: '', stderr: 'Syntax error: missing file for redirection <', exitCode: 1 };
    let stageInput = input;
    if (inRedirect !== null) {
        const file = expandWordText(shell, inRedirect.file, { error: null, code: 0, substStatus: null });
        const read = readShellInput(shell, file);
        if (read.error !== null) return { stdout: '', stderr: read.error, exitCode: 1 };
        stageInput = read.text;
    }
    const saved = shell.input;
    shell.input = stageInput;
    try {
        const ctx: ExpandCtx = { error: null, code: 0, substStatus: null };
        const fields = expandCommandWords(shell, stageWords, ctx);
        if (ctx.error !== null) return { stdout: '', stderr: ctx.error, exitCode: ctx.code };
        // a line of assignments and nothing else has no command to run
        if (fields === null) return { stdout: '', stderr: '', exitCode: ctx.substStatus ?? 0 };
        const step = shellCommandRedirected(shell, fields);
        if (errRedirect === 'stdout') return { stdout: step.stderr + step.stdout, stderr: '', exitCode: step.exitCode };
        if (errRedirect === 'null') return { stdout: step.stdout, stderr: '', exitCode: step.exitCode };
        return step;
    } finally {
        shell.input = saved;
    }
}

/**
 * A pipeline: every command reads what the command before it wrote. The status is the last
 * command's, as POSIX has it without pipefail, and every command's error output is the pipeline's.
 */
function shellPipeline(shell: SyncShell, stages: RawWord[][]): ShellStep {
    let input = shell.input;
    let stderr = '';
    let step: ShellStep = { stdout: '', stderr: '', exitCode: 0 };
    for (let i = 0; i < stages.length; i++) {
        step = shellStage(shell, stages[i], input);
        input = step.stdout;
        if (i < stages.length - 1) stderr += step.stderr;
    }
    return { stdout: step.stdout, stderr: stderr + step.stderr, exitCode: step.exitCode };
}

/**
 * ShellProcess.executeCommand for one command line: `;`, `&&` and `||`, with the exit status of the
 * last command that ran. `exit` stops the line, as it stops a shell. A `|` with a command missing
 * beside it is a syntax error the whole line fails on, before anything runs, as /bin/sh has it.
 */
function shellLine(shell: SyncShell, line: string): ShellStep {
    const segments = splitCommandList(line).filter((segment) => segment.words.length > 0);
    const pipelines: (RawWord[][] | null)[] = segments.map((segment) => splitPipeline(segment.words));
    if (pipelines.some((pipeline) => pipeline === null)) {
        return { stdout: '', stderr: 'Syntax error: a command is missing beside `|`', exitCode: 2 };
    }
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    for (let i = 0; i < segments.length; i++) {
        // `exec` replaced the shell: nothing after it runs, whatever operator joins it
        if (shell.stopped) break;
        const segment = segments[i];
        if (segment.op === '&&' && exitCode !== 0) continue;
        if (segment.op === '||' && exitCode === 0) continue;
        const step = shellPipeline(shell, pipelines[i] as RawWord[][]);
        stdout += step.stdout;
        stderr += step.stderr;
        exitCode = step.exitCode;
        // `$?` is what the last command left, for the expansions of the next one
        shell.lastStatus = exitCode;
        if (shell.state !== undefined) shell.state.lastStatus = exitCode;
        if (rawText(segment.words[0]) === 'exit') break;
    }
    return runExitTrap(shell, { stdout, stderr, exitCode });
}

/**
 * `trap ACTION EXIT`: the action runs when the line ends, and the line's status is the status it had.
 * The trap is removed first, so its own commands cannot fire it again. No other condition ever arises
 * in this dispatcher -- there are no signals, and no `DEBUG` or `ERR` hook -- so a trap set on one of
 * those is recorded and listed by `trap -p` and never runs.
 */
function runExitTrap(shell: SyncShell, step: ShellStep): ShellStep {
    const state = shell.state;
    if (state === undefined) return step;
    const trap = state.traps.get('EXIT');
    if (trap === undefined || trap.reset || trap.ignore || trap.action === '') return step;
    state.traps.delete('EXIT');
    const fired = shellLine(shell, trap.action);
    return { stdout: step.stdout + fired.stdout, stderr: step.stderr + fired.stderr, exitCode: step.exitCode };
}

/** ShellProcess.executeCommand for one command, in the same order of dispatch. */
function shellCommand(shell: SyncShell, words: string[]): ShellStep {
    if (words.length === 0) return { stdout: '', stderr: '', exitCode: 0 };
    const [command, ...cmdArgs] = words;
    try {
        if (command === 'exit') {
            const status = Number.parseInt(cmdArgs[0] ?? '0', 10);
            return { stdout: '', stderr: '', exitCode: Number.isNaN(status) ? 0 : status };
        }
        if (command === 'history') return { stdout: '', stderr: '', exitCode: 0 };
        if (SHELL_BUILTINS.has(command)) return shellBuiltinWithRedirects(shell, command, cmdArgs);
        if (SHELL_EXTERNALS.has(command)) throw notSupportedSync(`the shell command ${command}`);
        if (command === 'node' || command === NODE_BINARY) return shellNode(shell, nodeInvocation(cmdArgs));
        // A builtin is never looked for on PATH, the way it never is in a shell: `.` is the source
        // builtin, not the current directory, and `env` is not `/usr/bin/env`.
        const PATH = SHELL_BUILTIN_NAMES.has(command) ? undefined : shell.env.PATH;
        if (PATH) {
            for (const dir of PATH.split(':')) {
                const found = shell.ctx.fileSystem.resolvePath(command, dir);
                if (shell.ctx.fileSystem.fileExists(found)) {
                    if (found.endsWith('.js')) return shellNode(shell, { file: found, args: cmdArgs });
                    return { stdout: '', stderr: `No executor found for: ${found}`, exitCode: 1 };
                }
            }
        }
        let content: string | undefined;
        try {
            content = shell.ctx.fileSystem.readFile(command);
        } catch {
            content = undefined;
        }
        const shebang = content ? /^#!(.*)/.exec(content) : null;
        if (shebang) {
            const tokens = shebang[1].split(' ');
            if (tokens[0] === '/usr/bin/env') {
                if (tokens.length === 1) return { stdout: '', stderr: '', exitCode: 1 };
                if (tokens[1] === 'node') return shellNode(shell, { file: command, args: cmdArgs });
                throw notSupportedSync(`the shebang interpreter ${tokens[1]}`);
            }
        }
        // A utility the container cannot have reports the reason it cannot, with status 1: never 127.
        if (isUnsupported(command)) {
            const result = unsupportedResult(command);
            return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
        }
        const moduleStep = shellModuleCommand(shell, command, cmdArgs);
        if (moduleStep !== null) return moduleStep;
        return { stdout: '', stderr: `Command not found: ${command}`, exitCode: 127 };
    } catch (error) {
        if (isNotSupported(error)) throw error;
        return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
    }
}

/** `sh -c <line>` (or `sh <words>`): stdout exactly as the built-ins wrote it, stderr with a newline after it, as ShellProcess prints it. */
function runShell(
    ctx: CapabilityContext,
    argv: string[],
    env: Record<string, string>,
    cwd: string,
    input: string | null,
    name: string
): { status: number; stdout: string; stderr: string } {
    if (argv.length === 0) throw notSupportedSync('an interactive sh (no command given)');
    const line = argv[0] === '-c' ? (argv[1] ?? '') : argv.join(' ');
    const step = shellLine({ ctx, cwd, env, input, name, lastStatus: 0 }, line);
    return {
        status: step.exitCode,
        stdout: step.stdout,
        stderr: step.stderr ? step.stderr + '\n' : ''
    };
}

/** Runs an executable to completion. A spawn that cannot start (no executor, bad invocation) throws. */
function runSyncCommand(
    ctx: CapabilityContext,
    file: string,
    argv: string[],
    env: Record<string, string>,
    cwd: string,
    timeoutMs: number,
    killSignal: string,
    input: string | null
): SyncRun {
    if (file === 'sh' || file === '/bin/sh') {
        const step = runShell(ctx, argv, env, cwd, input, file);
        return { pid: nextSyncPid++, status: step.status, signal: null, stdout: step.stdout, stderr: step.stderr, timedOut: false };
    }
    if (file === 'node' || file === NODE_BINARY) return nodeRun(ctx, nodeInvocation(argv), env, cwd, timeoutMs, killSignal);
    if (file.endsWith('.js')) return nodeRun(ctx, { file, args: argv }, env, cwd, timeoutMs, killSignal);
    throw new Error(`No executor found for: ${file}`);
}

/** child.spawn inside a synchronous run: the child runs to completion inside this call, its output and exit are queued for the pump, and its pid is returned at once. */
function spawnChildNow(args: Record<string, any>, ctx: CapabilityContext): { pid: number } {
    if (args.ipc) throw notSupportedSync('an IPC child (fork, cluster or worker thread)');
    const file = String(args.file);
    const argv: string[] = Array.isArray(args.args) ? args.args.map(String) : [];
    const env: Record<string, string> = args.env ? { ...args.env } : childEnvOf(ctx);
    const cwd = typeof args.cwd === 'string' ? args.cwd : ctx.cwd();
    const stdio: unknown[] = Array.isArray(args.stdio) ? args.stdio : [];
    const target = Number(args.target);
    let run: SyncRun;
    try {
        run = runSyncCommand(ctx, file, argv, env, cwd, 0, 'SIGTERM', null);
    } catch (error) {
        if (isNotSupported(error)) throw error;
        throw spawnFailure(error, file, argv);
    }
    if (run.blocked !== undefined) throw notSupportedSync(`the child, which waits on ${run.blocked},`);
    const stdoutMode = modeOf(stdio[1]);
    const stderrMode = modeOf(stdio[2]);
    if (stdoutMode === 'pipe' && run.stdout) ctx.deliver(target, 'ev', { k: 'out', fd: 1, s: run.stdout });
    if (stdoutMode === 'inherit' && run.stdout) ctx.output({ stdout: run.stdout });
    if (stderrMode === 'pipe' && run.stderr) ctx.deliver(target, 'ev', { k: 'out', fd: 2, s: run.stderr });
    if (stderrMode === 'inherit' && run.stderr) ctx.output({ stderr: run.stderr });
    const signal = run.signal;
    ctx.deliver(target, 'ev', { k: 'exit', code: signal === null ? (run.status ?? 0) : null, signal });
    return { pid: run.pid };
}

/** child.spawnSync: one executable run to completion inside this call, reported the way Node's spawnSync reports it. */
const spawnSyncChild: CapabilityHandler = (args, ctx): SyncOutcome => {
    const file = String(args.file);
    const argv: string[] = Array.isArray(args.args) ? args.args.map(String) : [];
    const env: Record<string, string> = args.env ? { ...args.env } : childEnvOf(ctx);
    const cwd = typeof args.cwd === 'string' ? args.cwd : ctx.cwd();
    const timeoutMs = Number(args.timeout) > 0 ? Number(args.timeout) : 0;
    const killSignal = typeof args.killSignal === 'string' ? args.killSignal : 'SIGTERM';
    const input = typeof args.input === 'string' ? args.input : null;
    const stdio: unknown[] = Array.isArray(args.stdio) ? args.stdio : [];
    const stdoutMode = modeOf(stdio[1]);
    const stderrMode = modeOf(stdio[2]);

    let run: SyncRun;
    try {
        run = runSyncCommand(ctx, file, argv, env, cwd, timeoutMs, killSignal, input);
    } catch (error) {
        if (isNotSupported(error)) {
            return { pid: nextSyncPid++, spawned: true, status: null, signal: null, stdout: null, stderr: null, error: syncSpawnError(error, file, argv) };
        }
        return { pid: 0, spawned: false, status: null, signal: null, stdout: null, stderr: null, error: syncSpawnError(error, file, argv) };
    }

    let error: SyncErrorInfo | null = null;
    let status = run.status;
    let signal = run.signal;
    if (run.blocked !== undefined) {
        error = { code: 'ERR_NOT_SUPPORTED', message: notSupportedSync(`the child, which waits on ${run.blocked},`).message };
        status = null;
        signal = null;
    } else if (run.timedOut) {
        error = { code: 'ETIMEDOUT', message: `spawnSync ${file} ETIMEDOUT`, errno: -110, syscall: `spawnSync ${file}`, path: file, spawnargs: argv };
        status = null;
        signal = killSignal;
    }
    if (stdoutMode === 'inherit' && run.stdout) ctx.output({ stdout: run.stdout });
    if (stderrMode === 'inherit' && run.stderr) ctx.output({ stderr: run.stderr });
    return {
        pid: run.pid,
        spawned: true,
        status,
        signal,
        stdout: stdoutMode === 'pipe' ? run.stdout : null,
        stderr: stderrMode === 'pipe' ? run.stderr : null,
        error
    };
};

export const CHILD_CAPABILITIES: Record<string, CapabilityHandler> = {
    'child.spawn': spawnChild,
    'child.kill': killChild,
    'child.stdin': stdinWrite,
    'child.ipcAttach': ipcAttach,
    'child.sendToParent': sendToParent,
    'child.sendToChild': sendToChild,
    'child.disconnectChild': disconnectChild,
    'child.disconnectSelf': disconnectSelf,
    'child.parentExit': parentExit,
    'child.spawnSync': spawnSyncChild
};
