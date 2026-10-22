import { Process, ProcessEvent, ProcessState } from '../../../../base';
import { CapabilityContext, CapabilityHandler } from './types';
import { nodeCommand } from '../../flags';
import type { NodeFlagAnswer } from '../../flags';
import { COMMANDS as TEXT_UTILS } from '../../../../../shell/commands/textutils';
import { COMMANDS as FILE_UTILS } from '../../../../../shell/commands/fileutils';
import { COMMANDS as ARCHIVES } from '../../../../../shell/commands/archives';
import { COMMANDS as PROC_INFO } from '../../../../../shell/commands/procinfo';
import {
    COMMANDS as UNSUPPORTED_UTILS,
    UNSUPPORTED_COMMANDS,
    curlUsageResult,
    isUnsupported,
    unsupportedResult
} from '../../../../../shell/commands/unsupported';
import {
    COMMANDS as SHELL_BUILTIN_UTILS,
    createShellState,
    diagnosticPrefix,
    echoWords,
    evalArith,
    formatJobText,
    killJobSpecs,
    runScript,
    setActiveState,
    setRunner
} from '../../../../../shell/commands/builtins';
import type { ShellState, ShellVar } from '../../../../../shell/commands/builtins';
import type { IFileSystem } from '../../../../../filesystem';
import type { CommandContext, CommandResult, ShellCommand } from '../../../../../shell/commands/types';
import {
    LIFECYCLE_COMMANDS,
    NPM_VERSION,
    findPackageRoot,
    missingScriptMessage,
    parseScriptArgs,
    readManifest,
    scriptCommandLine,
    scriptEvents,
    scriptFailureMessage,
    scriptHeader,
    scriptLabel,
    scriptList,
    scriptPath
} from '../../../../../npm/scripts';
import { nodeSyncRunner, syncRunActive } from '../../pump';
import type { SyncChildResult } from '../../pump';
import type { MaybeAsync } from './dispatch';
import { InstallSpec, NpmInstaller, parseInstallSpec } from '../../../../../npm/installer';
import type { SaveTarget } from '../../../../../npm/installer';
import { NpmRegistry } from '../../../../../npm/registry';

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
    stdin: StdioMode;
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

/**
 * Everything a child emits is routed to its parent. Installed in startProcess's beforeStart, so the
 * first slice of the child -- a shell that runs one command and exits -- is seen: attaching after the
 * spawn settles loses everything that child wrote before then.
 */
function attachChildListeners(record: ChildRecord, child: Process): void {
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
        registryByPidOf(record).delete(child.pid);
        const signal = record.killSignal ?? null;
        const code = signal === null ? (data.exitCode ?? 0) : null;
        later(() => record.parent.deliver(record.target, 'ev', { k: 'exit', code, signal }));
    });
}

/** The pid table of the container this record belongs to: a process is unregistered from where it was registered. */
function registryByPidOf(record: ChildRecord): Map<number, ChildRecord> {
    return registryFor(record.parent).byPid;
}

const spawnChildAsync: CapabilityHandler = async (args, ctx) => {
    const registry = registryFor(ctx);
    const cwd = typeof args.cwd === 'string' ? args.cwd : ctx.cwd();
    const file = spawnExecutableOf(ctx, executableOf(String(args.file)), args.env ? { ...args.env } : childEnvOf(ctx), cwd);
    const argv: string[] = Array.isArray(args.args) ? args.args.map(String) : [];
    const env: Record<string, string> = args.env ? { ...args.env } : childEnvOf(ctx);
    if (args.ipc) {
        env.OWC_IPC_KIND = String(args.ipcKind);
        env.OWC_IPC_DATA = JSON.stringify({ ...args.ipcData, token: args.token });
    }
    const stdio: unknown[] = Array.isArray(args.stdio) ? args.stdio : [];
    /* A node child whose stdin is a pipe keeps process.stdin open until the parent ends it, as Node
       does: the guest reads OWC_STDIN at bootstrap and drops it from the environment before user code. */
    if (modeOf(stdio[0]) === 'pipe' && (file === 'node' || file.endsWith('.js'))) env.OWC_STDIN = 'pipe';
    const record: ChildRecord = {
        token: String(args.token),
        kind: String(args.kind),
        parent: ctx,
        target: Number(args.target),
        stdin: modeOf(stdio[0]),
        stdout: modeOf(stdio[1]),
        stderr: modeOf(stdio[2]),
        connected: Boolean(args.ipc),
        queue: [],
        exited: false
    };
    registry.pending.set(record.token, record);
    const reserved = Number(args.pid);
    const child = await ctx.services
        .startProcess({
            parentPid: ctx.pid,
            executable: file,
            args: argv,
            cwd,
            env,
            pid: Number.isInteger(reserved) && reserved > 0 ? reserved : undefined,
            beforeStart: (started) => {
                record.process = started;
                record.pid = started.pid;
                registry.pending.delete(record.token);
                registry.byPid.set(started.pid, record);
                attachChildListeners(record, started);
            }
        })
        .catch((error: unknown) => {
            registry.pending.delete(record.token);
            throw spawnFailure(error, file, argv);
        });
    record.process = child;
    record.pid = child.pid;
    registry.pending.delete(record.token);
    registry.byPid.set(child.pid, record);

    if (!record.exited && child.state !== ProcessState.RUNNING && child.state !== ProcessState.CREATED) {
        // The process finished inside spawn, before even beforeStart ran, so its EXIT was never seen.
        // Its output emitted in that window is not recoverable; the exit is reported now.
        record.exited = true;
        record.connected = false;
        registry.byPid.delete(child.pid);
        const code = child.exitCode ?? 0;
        later(() => record.parent.deliver(record.target, 'ev', { k: 'exit', code, signal: null }));
    }
    return { pid: child.pid };
};

/** A spawn made while a synchronous run is on the stack runs to completion there; any other spawn is asynchronous. */
const spawnChild: CapabilityHandler = (args, ctx) => (syncRunActive() ? spawnChildNow(args, ctx) : spawnChildAsync(args, ctx));

const killChild: CapabilityHandler = (args, ctx) => {
    const signal = args.signal === undefined || args.signal === null ? 'SIGTERM' : String(args.signal);
    const record = registryFor(ctx).byPid.get(Number(args.pid));
    if (!record || record.exited || !record.process || record.parent.pid !== ctx.pid) return false;
    if (record.process.state !== ProcessState.RUNNING) return false;
    // Signal 0 is the null signal: it asks only whether the process is still there, so the child is
    // left running and true comes back, which is what a caller probing a pid expects.
    if (signal === '0') return true;
    record.killSignal = signal;
    void record.process.terminate();
    return true;
};

/** Writes to a child's stdin: a shell process reads Process input, a node child reads process.stdin. */
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

/** The parent closed the child's stdin: the child's process.stdin sees end of file, as it does in Node. */
const stdinEnd: CapabilityHandler = (args, ctx) => {
    const record = registryFor(ctx).byPid.get(Number(args.pid));
    if (!record || record.exited || !record.process || record.parent.pid !== ctx.pid) return false;
    try {
        record.process.endStdin();
        return true;
    } catch {
        return false;
    }
};

/** Takes the pid a child will have, so child_process can report it the moment spawn returns, as Node does. */
const reservePid: CapabilityHandler = (args, ctx) => ({ pid: syncRunActive() ? nextSyncPid++ : ctx.services.reservePid() });

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

/** Parent guest is exiting: worker threads are terminated, a piped stdin sees end of file, and IPC children are disconnected, as Node does. */
const parentExit: CapabilityHandler = (_args, ctx) => {
    for (const record of registryFor(ctx).byPid.values()) {
        if (record.parent.pid !== ctx.pid || record.exited || !record.process) continue;
        // the write end of a pipe closes with the process that holds it: a reader left waiting never waits
        if (record.stdin === 'pipe') {
            try {
                record.process.endStdin();
            } catch {
                // the child may have gone already
            }
        }
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

/**
 * The executable a spawn names, as the container's own executors claim it.
 *
 * `process.execPath` in a guest is NODE_BINARY, and no file in the virtual file system holds that
 * path: the container's node *is* the interpreter, not a script it has. A spawn naming it looked for
 * a file and reported ENOENT, where a host runs its own interpreter. It is `node` for the executor,
 * and the arguments are unchanged, so `spawn(execPath, [file, ...args])` runs `node file ...args`.
 * Every other name is left alone: a missing path still fails, a real file still resolves as it does.
 */
function executableOf(file: string): string {
    return file === NODE_BINARY ? 'node' : file;
}

/**
 * The executable an asynchronous spawn starts, with a bare name resolved to the file PATH holds for
 * it -- but only when that file is one the container can run: a node script by its name, or a file
 * whose shebang names node or a shell. Anything else keeps the name it was given, so a name with no
 * file behind it still fails exactly as it failed before. A `node_modules/.bin` shim (`cowsay`) is
 * the file this was written for: a spawn of it reported ENOENT while the very same package ran when
 * it was required.
 */
function spawnExecutableOf(ctx: CapabilityContext, file: string, env: Record<string, string>, cwd: string): string {
    /* `sh` and `node` are the container's own executors and are named as they are, never by a path;
       `npm` and `npx` are the npm process, which PATH also has an entry for and which has to stay
       that process -- a spawn of it as a file would run the shell's npm, which refuses everywhere
       but a line of its own. */
    if (file.includes('/') || CONTAINER_EXECUTABLES.has(file)) return file;
    const found = resolveOnPath({ ctx, cwd, env, input: null, lastStatus: 0 }, file);
    if (found === undefined) return file;
    const base = found.split('/').pop() ?? '';
    if (base === 'sh' || base === 'bash' || base === 'node') return file;
    if (found.endsWith('.js')) return found;
    const interpreter = shebangInterpreter(ctx.fileSystem, found);
    return interpreter === 'node' || interpreter === 'sh' || interpreter === 'bash' ? found : file;
}

/** The names the container runs itself, so a spawn of one is never rewritten into a file on PATH. */
const CONTAINER_EXECUTABLES = new Set(['node', 'npm', 'npx', 'sh', 'bash']);

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
    /** Set when the shell ended on a signal rather than a status: the run reports null and this name. */
    signal?: string;
}

/** A step that produced nothing, for the paths that run no command at all. */
const EMPTY_STEP: ShellStep = { stdout: '', stderr: '', exitCode: 0 };

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
    /** The jobs of this line and the EXIT trap after them: see endOfLine. */
    jobs?: ShellJob[];
    /**
     * True on the one command of a line `runShell` can wait on -- the last one, with nothing beside
     * it -- so a command that would suspend is only started where the suspend can be honoured.
     */
    suspendable?: boolean;
    /**
     * `$$`: the pid this shell answers with. A synchronous shell is not a container process, so it
     * takes a pid of its own from a range no container process is given -- one per shell, as a host
     * gives one to every shell it starts.
     */
    pid?: number;
    /**
     * `$PPID`: the process the shell was started from. Left out for the ordinary case -- the caller
     * of the capability, whose pid `ctx` carries -- and set where the shell answers for a process
     * that is not that caller.
     */
    ppid?: number;
}

/** Pids of synchronous shells, apart from the container's own processes and from synchronous children. */
let nextShellPid = 63000;

/** `$$` of one shell: taken once, and kept for as long as the shell runs. */
function shellPidOf(shell: SyncShell): number {
    return (shell.pid ??= nextShellPid++);
}

/**
 * One command started with `&`.
 *
 * The guest runs as one synchronous call on the host, so nothing can run alongside the shell: a job
 * is *started* only in the sense that the shell no longer waits for it -- its words are kept here
 * and run either by `wait`, or when the line's own foreground commands are through. It is never
 * dropped, and it never waits on host work that cannot finish inside the call: a job that would
 * block fails with the same ERR_NOT_SUPPORTED the foreground path gives.
 */
interface ShellJob {
    /** The number `jobs` prints in `[1]`, and `%1` names. */
    id: number;
    /** The pid `&` prints and `$!` holds. */
    pid: number;
    /** The command as it was written, for `jobs`. */
    text: string;
    /** The pipeline to run, its `|` already split out. Empty for a compound job, which has `line`. */
    stages: RawWord[][];
    /**
     * The whole line of a compound job -- `{ echo a; } &`, `for i in 1 2; do echo $i; done &` -- which
     * this dispatcher's own splitter cannot re-read: the script engine of `builtins.ts` parses it
     * again when the job is run. Undefined for a job of plain commands, which runs from `stages`.
     */
    line?: string;
    /** Run to completion: `wait` no longer has anything to wait for. */
    done: boolean;
    /** The status it left, once it has run. */
    exitCode: number;
}

/** Pids of background jobs, counted apart from the container's own processes and from sync children. */
let nextBackgroundPid = 62000;

/** The jobs of this shell, made on the first one. */
function jobsOf(shell: SyncShell): ShellJob[] {
    return (shell.jobs ??= []);
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
        // The engine (builtins.ts) cannot start a job itself without importing the capability layer, so
        // a `&` inside a compound command is registered through this callback. Returning null makes
        // the engine run the pipeline in the foreground rather than invent a job.
        state.startJob = (_state: ShellState, source: string) => {
            const segments = splitCommandList(source);
            /* A compound command -- `{ echo a; } &`, `for i in 1 2; do echo $i; done &` -- is handed
               over whole: this dispatcher's own splitter reads a line of `;`-separated segments and
               cannot put one construct back together from them, so the job keeps the text and the
               script engine parses it again when the job is run. */
            if (segments.some(segmentStartsCompound)) return startBackgroundJob(shell, [], source);
            const segment = segments[0];
            if (segment === undefined) return null;
            const stages = splitPipeline(segment.words);
            if (stages === null) return null;
            return startBackgroundJob(shell, stages);
        };
        if (shell.name !== undefined) state.shellName = shell.name;
        /* `$$` is this shell's pid in the script engine too, which reads it out of the state: a
           compound line and a simple one have to answer the same number. */
        state.pid = shellPidOf(shell);
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
        return { stdout: result.stdout, stderr: diagnostic(result.stderr), exitCode: result.exitCode };
    } catch (error) {
        if (isNotSupported(error)) throw error;
        return { stdout: '', stderr: diagnostic(error instanceof Error ? error.message : String(error)), exitCode: 1 };
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

/**
 * Thrown by a shell command that can only be answered by work the host has to finish -- `npm install`
 * reaching the registry -- inside a shell line, where the engine around it steps one command at a
 * time and has no promise to hand back. It carries the work, and it is a throw rather than a return
 * so it crosses the whole engine: `shellLine`, the compound-command script engine and every builtin
 * in between stay synchronous, and the one caller that can suspend, `runShell`, catches it.
 *
 * It is never thrown where the guest cannot unwind: `npmInstallStep` answers `undefined` inside a
 * synchronous run, so this only ever escapes from the outermost synchronous call.
 */
class ShellSuspend {
    constructor(readonly work: Promise<ShellStep>) {}
}

function isShellSuspend(error: unknown): error is ShellSuspend {
    return error instanceof ShellSuspend;
}

/**
 * The refusal for a command that would have to wait on the host from inside a synchronous child.
 *
 * A synchronous child's own wasm call sits inside the one that spawned it, so one unwind cannot cover
 * both: the outer call would have to answer before the inner one's work could settle, which would
 * mean answering before the install had happened. The name says which of the two is stuck rather
 * than leaving it to the reader to tell a nested child from the outermost call.
 */
function notSupportedNested(what: string): Error {
    return Object.assign(
        new Error(`child_process: ${what} waits on host work, and a nested synchronous child cannot suspend to wait for it; use the asynchronous API`),
        { code: 'ERR_NOT_SUPPORTED' }
    );
}

/** The error a failed spawn reports, named the way spawnSync names it. */
function syncSpawnError(error: unknown, file: string, argv: string[]): SyncErrorInfo {
    if (isNotSupported(error)) {
        return { code: 'ERR_NOT_SUPPORTED', message: (error as Error).message };
    }
    /* A refusal the dispatcher raised itself -- a file with no execute bit -- carries its own code,
       which `spawnFailure` would replace with the generic one: it is read here instead. */
    const tagged = error as Error & { code?: unknown; errno?: unknown };
    if (tagged?.code === 'EACCES') {
        return {
            code: 'EACCES',
            message: `spawnSync ${file} EACCES`,
            errno: typeof tagged.errno === 'number' ? tagged.errno : -13,
            syscall: `spawnSync ${file}`,
            path: file,
            spawnargs: argv
        };
    }
    const failure = spawnFailure(error, file, argv) as Error & { code?: string };
    if (failure.code === 'ENOENT') {
        return { code: 'ENOENT', message: `spawnSync ${file} ENOENT`, errno: -2, syscall: `spawnSync ${file}`, path: file, spawnargs: argv };
    }
    return { code: String(failure.code), message: failure.message, syscall: `spawnSync ${file}`, path: file, spawnargs: argv };
}

/** The file and arguments a node command runs, as NodeProcessExecutor reads them. */
function nodeInvocation(argv: string[]): { file: string; args: string[]; evalSource?: string; flagAnswer?: NodeFlagAnswer } {
    /* Read as NodeProcessExecutor reads it: the flags node answers for itself -- `--version`,
       `--help`, `--check`, one it does not know -- are answered here as they are on the command
       line, and everything else is a script, a `-e`/`-p` source or a REPL. */
    const command = nodeCommand(argv);
    /* A synchronous child has nowhere to put a REPL: no terminal of its own and no caller to hand
       one to. A bare `node` is refused here, where an asynchronous run would start one. */
    if (command.file === '[repl]') throw new Error('No JavaScript file specified');
    return { file: command.file, args: command.args, evalSource: command.evalSource, flagAnswer: command.flagAnswer };
}

/** One node child run to completion. The caller decides what a blocked or timed-out run means. */
function nodeRun(
    ctx: CapabilityContext,
    invocation: { file: string; args: string[]; evalSource?: string; flagAnswer?: NodeFlagAnswer },
    env: Record<string, string>,
    cwd: string,
    timeoutMs: number,
    killSignal: string,
    /** The whole of spawnSync's `input`: the child reads it on stdin and then sees end of file. */
    input: string | null
): SyncChildResult & { pid: number } {
    const runner = nodeSyncRunner.run;
    if (runner === undefined) throw notSupportedSync('a node child');
    const pid = nextSyncPid++;
    /* A line of flags node answers itself -- `--version`, `--help`, one it does not know. A
       `--check` is the one answer that needs an engine to parse with, so it rides the runner like
       any other child and is answered there, on the module this run already has. */
    if (invocation.flagAnswer !== undefined && invocation.flagAnswer.check === undefined) {
        const answer = invocation.flagAnswer;
        return { pid, status: answer.exitCode, signal: null, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', timedOut: false };
    }
    /* The input travels in the environment the guest reads at bootstrap and drops before user code:
       a synchronous run has no host to push into it later, so it is all there from the start. */
    if (input !== null && input !== '') env.OWC_STDIN_INPUT = input;
    const result = runner({
        pid,
        parentPid: ctx.pid,
        file: invocation.file,
        args: invocation.args,
        cwd,
        env,
        evalSource: invocation.evalSource,
        flagAnswer: invocation.flagAnswer,
        fileSystem: ctx.fileSystem,
        services: ctx.services,
        quickJs: ctx.quickJs(),
        timeoutMs,
        killSignal
    });
    return { pid, ...result };
}

function shellPath(shell: SyncShell, path: string): string {
    const joined = path.startsWith('/') ? path : `${shell.cwd}/${path}`.replace(/\/+/g, '/');
    // `cd ./sub` leaves the shell in `/work/sub`, not in `/work/./sub`
    const parts = joined.split('/').filter((part) => part !== '' && part !== '.');
    return '/' + parts.join('/');
}

/** A node command inside the shell: its status and output become the shell command's. */
function shellNode(shell: SyncShell, invocation: { file: string; args: string[]; evalSource?: string }): ShellStep {
    const run = nodeRun(shell.ctx, invocation, shell.env, shell.cwd, 0, 'SIGTERM', null);
    if (run.blocked !== undefined) throw notSupportedSync(`the shell command ${invocation.file}, which waits on ${run.blocked}`);
    return { stdout: run.stdout, stderr: run.stderr, exitCode: run.status ?? 1 };
}

/** Shell's built-ins with the output and status Shell.executeBuiltin gives them. */
function shellBuiltin(shell: SyncShell, command: string, args: string[]): ShellStep {
    const fs = shell.ctx.fileSystem;
    const at = (path: string) => shellPath(shell, path);
    const ok = (stdout = ''): ShellStep => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr: string): ShellStep => ({ stdout: '', stderr: diagnostic(stderr), exitCode: 1 });
    try {
        switch (command) {
            case 'echo':
                return ok(echoWords(args));
            case 'true':
                return ok();
            case 'false':
                return fail('');
            case 'cat': {
                // no argument reads the child's input (Shell says 'No file specified'; Node reads stdin)
                if (args.length === 0) return ok(shell.input ?? '');
                let joined = '';
                let missing: string | null = null;
                for (const name of args) {
                    let content: string | undefined;
                    try {
                        content = fs.readFile(at(name));
                    } catch {
                        content = undefined;
                    }
                    if (content === undefined) missing ??= name;
                    else joined += content;
                }
                // as cat has it: the files it could read are written, the status is the failure
                return missing === null ? ok(joined) : { stdout: joined, stderr: diagnostic(`File not found: ${missing}`), exitCode: 1 };
            }
            case 'pwd':
                return ok(shell.cwd + '\n');
            case 'ls':
            case 'touch':
                /* The file utilities own these two, as they do in the shell: `ls -l` and `ls -a`
                   read a name's mode and owner, and `touch a b c` has to reach every operand. */
                return (FILE_UTILS[command] as ShellCommand)(moduleContext(shell, args));
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
            if (i + 1 >= args.length) return { stdout: '', stderr: `Syntax error: missing file for redirection ${args[i]}`, exitCode: 2 };
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
            /* `>>` to a name no file has yet: the host shell creates it. Reading it first to append
               throws ENOENT on the read, so the append never reached the write -- a missing target
               is an empty one, while a missing *directory* still fails, on the write instead. */
            let prior = '';
            if (redirect.type === '>>') {
                try { prior = fs.readFile(file) ?? ''; } catch { prior = ''; }
            }
            fs.writeFile(file, prior + step.stdout);
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
    /** Ended by a trailing `&`: started as a background job, and `$?` after it is 0 whatever it leaves. */
    background: boolean;
}

/**
 * Splits a command line on `;`, `&&`, `||` and a lone `&`. A quoted run holds an operator, so it is
 * copied whole. A trailing operator leaves a final segment with no command, which the runner skips.
 */
function splitCommandList(line: string): ShellSegment[] {
    const segments: ShellSegment[] = [];
    let text = '';
    let op: ';' | '&&' | '||' | null = null;
    const push = (background = false): void => {
        const words = tokenizeLine(text);
        if (words.length > 0) segments.push({ words, op, background });
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
        } else if (ch === ';' || ch === '\n') {
            // a newline separates commands as `;` does, which is what makes a comment end there
            push();
            op = ';';
            i++;
        } else if ((ch === '&' || ch === '|') && line[i + 1] === ch) {
            push();
            op = ch === '&' ? '&&' : '||';
            i += 2;
        } else if (ch === '&' && isBackgroundAmp(line, i)) {
            // a lone & ends the command before it and starts it in the background; what follows runs
            // whatever that command leaves, so it joins the next one the way `;` does
            push(true);
            op = ';';
            i++;
        } else {
            // a `$( )` or backquoted construct holds an operator too
            const span = constructSpan(line, i);
            if (span !== -1) {
                text += line.slice(i, span);
                i = span;
                continue;
            }
            // a lone & (a background job) is not split out of the text here: `2>&1` and `>&2` hold
            // one too, so it is recognised as a word after tokenizing, where the quoting is known.
            // A lone | is left in the words here and splits the command into a pipeline in
            // splitPipeline
            text += ch;
            i++;
        }
    }
    push();
    return segments;
}

/**
 * `#` starts a comment where it begins a word: everything from there to the end of the line is
 * dropped, the operators in it included, so `echo a # b; c` runs one command. Inside quotes, and
 * after a backslash, it is an ordinary character.
 */
function stripComment(line: string): string {
    let text = line;
    let atWordStart = true;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            i += 2;
            atWordStart = false;
            continue;
        }
        if (ch === "'" || ch === '"') {
            const close = findQuoteClose(text, i, ch);
            const stop = close === -1 ? text.length : close + 1;
            i = stop;
            atWordStart = false;
            continue;
        }
        // a comment ends at the next newline, not at the end of the line: `a # c` + newline + `b`
        if (ch === '#' && atWordStart) {
            const nl = text.indexOf('\n', i);
            text = nl === -1 ? text.slice(0, i) : text.slice(0, i) + text.slice(nl);
            continue;
        }
        const span = constructSpan(text, i);
        if (span !== -1) {
            i = span;
            atWordStart = false;
            continue;
        }
        atWordStart = ch === ' ' || ch === '\t' || ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')';
        i++;
    }
    return text;
}

/** The index of the `quote` closing the one at `start`, or -1 when the line ends first. */
function findQuoteClose(text: string, start: number, quote: string): number {
    let i = start + 1;
    while (i < text.length) {
        const ch = text[i];
        if (quote === '"' && ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === quote) return i;
        i++;
    }
    return -1;
}

/**
 * A line the shell cannot even parse: a quote, a `$( `, a `${ ` or a backquote that is never closed
 * anywhere on it. `tokenizeLine` would quietly close all four at the end of the line and print the
 * text; the host reports a syntax error and exits 2, which is what this returns.
 */
function syntaxErrorOf(line: string): string | null {
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === "'" || ch === '"') {
            const close = findQuoteClose(line, i, ch);
            if (close === -1) return `Syntax error: unexpected EOF while looking for matching ${ch === "'" ? "`''" : "`\"'"}`;
            i = close + 1;
            continue;
        }
        if (ch === '`') {
            const end = findBacktick(line, i + 1);
            if (end === -1) return 'Syntax error: unexpected EOF while looking for matching `` ` ``';
            i = end + 1;
            continue;
        }
        if (ch === '&' && line[i + 1] !== '&') {
            /* `cmd &; cmd` is a syntax error in bash: the `&` already ended the command, so nothing
               is left for the `;` to separate. A `&` of a redirect (`2>&1`) is never one of these --
               what follows it is the descriptor, not a `;`. */
            let after = i + 1;
            while (after < line.length && (line[after] === ' ' || line[after] === '\t')) after++;
            if (line[after] === ';') return "Syntax error: `&' cannot be followed by `;'";
        }
        if (ch === '$' && line[i + 1] === '(') {
            const arithmetic = line[i + 2] === '(';
            const end = arithmetic ? matchArithmetic(line, i + 2) : matchParen(line, i + 1);
            if (end === -1) return 'Syntax error: unexpected EOF while looking for matching `)\'';
            i = end + 1;
            continue;
        }
        if (ch === '$' && line[i + 1] === '{') {
            const end = matchBrace(line, i + 1);
            if (end === -1) return 'Syntax error: unexpected EOF while looking for matching `}\'';
            i = end + 1;
            continue;
        }
        i++;
    }
    return null;
}

/**
 * The words a command has to be handed to the script engine of `builtins.ts` for: the reserved words
 * that open a compound command (`if`, `for`, `while`, `until`, `case`, `{ }`, `( )`) and a function
 * definition. Only the *first* word is looked at, so `echo {` and `find . -name "*.txt"` keep going
 * through this dispatcher: there, `{` is an argument and the parser would expand the glob.
 *
 * The first word of *every* stage of a pipeline is looked at, not only the line's: `echo a |
 * while read v; do ...; done` is a compound line whose first word is `echo`, and the `while` on the
 * right of the `|` is one only the engine parses.
 */
const COMPOUND_KEYWORDS = new Set(['if', 'for', 'while', 'until', 'case', 'select', 'function']);
/** `g()`, `f(){ ... }` and the same written with no space: a function definition. */
const FUNCTION_DEFINITION = /^[A-Za-z_][A-Za-z0-9_]*\(\)/;
const NAME_WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;

function startsCompound(words: RawWord[]): boolean {
    if (words.length === 0) return false;
    const first = rawText(words[0]);
    if (COMPOUND_KEYWORDS.has(first)) return true;
    // `(echo hi)` and `{ echo a; }` are written with the brace or the parenthesis against the command
    if (/^[({]/.test(first)) return true;
    if (FUNCTION_DEFINITION.test(first)) return true;
    // `g () { ... }`: the name, then the parenthesis as a word of its own (`g ()` gives `()`)
    return NAME_WORD.test(first) && words.length > 1 && /^\(/.test(rawText(words[1]));
}

/** True when any stage of the segment's pipeline opens a compound command. */
function segmentStartsCompound(segment: ShellSegment): boolean {
    const stages = splitPipeline(segment.words);
    if (stages === null) return false;
    return stages.some(startsCompound);
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
        /* A piece the quoting emptied still opens a word: `printf ''` writes a format, it does not
           leave the command without one. Only an unquoted piece can come out empty, and none does. */
        if (text === '' && split) return;
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

/**
 * True for the `&` at `i`, which ends a command in the background. One that belongs to a redirection
 * is not one: `2>&1` and `>&2` write it next to a `>`, and `&>file` opens with it. Neither is a `&&`,
 * which the branch above has already taken. A quoted run, a `$( )`, a `${ }` and a backquoted
 * construct are copied whole before this is ever reached, so the `&` one of those holds is safe.
 */
function isBackgroundAmp(line: string, i: number): boolean {
    const before = line[i - 1];
    const after = line[i + 1];
    if (after === '>' || after === '<') return false;
    return before !== '>' && before !== '<';
}

/** What a word expands to: `text` plus `split` (field splitting applies) and, for `"$@"`, the field boundary. */
interface ExpandAtom {
    text: string;
    /** The text is open to field splitting: it came out of an unquoted expansion. */
    split: boolean;
    /** The text came out of an unquoted piece, so pathname expansion applies to it. */
    glob: boolean;
    /** The text was written quoted or escaped, so field splitting never breaks it. */
    quoted?: boolean;
    /** The field before this one ends here. */
    before?: boolean;
    /** This field ends here, even where the next piece would otherwise join it. */
    after?: boolean;
}

/** One field of a word after expansion, and whether pathname expansion may still rewrite it. */
interface ExpandedField {
    text: string;
    glob: boolean;
}

/** Where one expansion reports an error (`${x:?}`) and the status of a command substitution. */
interface ExpandCtx {
    error: string | null;
    code: number;
    substStatus: number | null;
}

/**
 * Field splitting on the shell's `IFS`, in the three rules of POSIX 2.6.5 the way this machine's
 * /bin/sh applies them:
 *   - IFS white space at the two ends of the word is ignored, and a run of it inside the word is one
 *     delimiter, so `IFS=' '; s=' a  b '; set -- $s` gives two fields and not four;
 *   - an IFS character that is not white space is a delimiter of its own, and the white space next
 *     to it belongs to that one delimiter, so `IFS=' :'; s='a : b'; set -- $s` gives two fields;
 *   - two delimiters with nothing between them still leave the empty field between them, while one
 *     the word ends on opens no field after it, so `IFS=:; s='a::b'` gives three and `s='a:'` one.
 *
 * `mask` is per character: it says which of them a field may end on, which is every unquoted one of
 * a word holding an unquoted expansion and no character of a word holding none -- `IFS=:; echo a:b`
 * prints `a:b` in a host shell. A null `IFS` splits nothing at all.
 */
function splitOnIFS(text: string, mask: boolean[], ifs: string): string[] {
    if (text === '') return [];
    if (ifs === '') return [text];
    const ws: string[] = [...ifs].filter((ch) => ch === ' ' || ch === '\t' || ch === '\n');
    const seps: string[] = [...ifs].filter((ch) => ch !== ' ' && ch !== '\t' && ch !== '\n');
    let from = 0;
    let to = text.length;
    while (from < to && mask[from] === true && ws.includes(text[from])) from++;
    while (to > from && mask[to - 1] === true && ws.includes(text[to - 1])) to--;
    if (from >= to) return [];
    const fields: string[] = [];
    let cur = '';
    let ended = false;
    for (let i = from; i < to; ) {
        if (mask[i] === true && ws.includes(text[i])) {
            let j = i;
            while (j < to && mask[j] === true && ws.includes(text[j])) j++;
            /* White space standing next to a delimiter is one delimiter with it. */
            if (j < to && mask[j] === true && seps.includes(text[j])) j++;
            while (j < to && mask[j] === true && ws.includes(text[j])) j++;
            fields.push(cur);
            cur = '';
            ended = true;
            i = j;
            continue;
        }
        if (mask[i] === true && seps.includes(text[i])) {
            let j = i + 1;
            while (j < to && mask[j] === true && ws.includes(text[j])) j++;
            fields.push(cur);
            cur = '';
            ended = true;
            i = j;
            continue;
        }
        cur += text[i];
        ended = false;
        i++;
    }
    /* A delimiter the word ends on opened no field after it, so `IFS=:; s='a:'` is one field. */
    if (!ended || cur !== '') fields.push(cur);
    return fields;
}

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
            return String(shellPidOf(shell));
        /* `$PPID`: the process that started this shell, which on a host is the node the shell was
           spawned from. A synchronous shell is not a container process of its own -- `$$` is a pid
           of its own range -- but the caller behind it is one, so that is the pid reported. A
           subshell is the same process as the shell that made it, so it reads the same number. */
        case 'PPID':
            return String(shell.ppid ?? shell.ctx.pid);
        // `$!`: the pid the last `&` printed, now that this shell starts background jobs
        case '!':
            return String(shell.state?.lastBackgroundPid ?? 0);
        case '-':
            return '';
        default:
            break;
    }
    if (/^[1-9][0-9]*$/.test(name)) return positionalOf(shell)[Number(name) - 1] ?? '';
    const found = lookupVar(shell, name);
    /* IFS is a variable of the shell rather than one of its environment, so a host shell has it in
       every shell it starts and never in the environment of the children it runs: it reads as
       space-tab-newline until a line sets it, and is never written into `shell.env` for a child. */
    if (found === undefined && name === 'IFS') return ' \t\n';
    return found ?? '';
}

/**
 * `$@` and `$*` are the two that are not one string. `"$@"` is one field per positional parameter,
 * and `$*` in quotes is one field with them joined; unquoted, the two behave alike and are split.
 */
function parameterAtoms(shell: SyncShell, name: string, split: boolean, out: ExpandAtom[]): void {
    const params = positionalOf(shell);
    if (!split && name === '@') {
        for (let i = 0; i < params.length; i++) {
            out.push({ text: params[i], split: false, glob: false, before: i > 0, after: i < params.length - 1 });
        }
        return;
    }
    /* `$*` is one field with the parameters joined by the first character of IFS, a space where IFS
       is unset and nothing at all where it is null; unquoted `$@` joins the same way, the two being
       alike once field splitting has been at them. */
    const ifs = valueOfName(shell, 'IFS');
    out.push({ text: params.join(ifs === '' ? '' : ifs[0]), split, glob: split });
}

/**
 * `NAME=value` in the shell's own variables, and in the environment where it is already exported.
 * Returns the error of assigning to a read-only variable, which ends the line as it ends a shell.
 */
function assignVar(shell: SyncShell, name: string, value: string): string | null {
    const state = shellStateFor(shell);
    let existing: ShellVar | undefined;
    for (let i = state.scopes.length - 1; i >= 0; i--) {
        const found = state.scopes[i].get(name);
        if (found !== undefined) {
            existing = found;
            break;
        }
    }
    if (existing?.readonly === true) return `${name}: readonly variable`;
    const exported = existing?.export === true || (existing === undefined && Object.prototype.hasOwnProperty.call(shell.env, name));
    state.scopes[0].set(name, exported ? { value, export: true } : { value });
    if (exported) shell.env[name] = value;
    return null;
}

/**
 * Runs a `$( )` or backquoted script in a shell of its own and strips the trailing newlines, as a
 * shell does. The jobs it starts stay pending: what a substitution captures is what its own commands
 * wrote, and a job nobody has waited for has written nothing yet -- it runs when the line that holds
 * the substitution is through, so `$(jobs)` captures the list and not the output of the jobs in it.
 */
function runSubstitution(shell: SyncShell, script: string): { text: string; status: number } {
    const child: SyncShell = {
        ctx: shell.ctx,
        cwd: shell.cwd,
        env: { ...shell.env },
        input: shell.input,
        name: shell.name,
        // a substitution is a subshell, and a subshell is the same process: `$$` reads the same in it
        pid: shell.pid,
        lastStatus: shell.lastStatus,
        // one job table: a job a substitution started is the shell's own, and `wait` can wait for it
        jobs: shell.jobs,
        state: shell.state
    };
    const step = shellLine(child, script, true);
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
    let literalGlob = false;
    const flushLiteral = (): void => {
        if (literal !== '') {
            // a glob character only counts where it was written unquoted: `\*` is an ordinary `*`
            // Field splitting is something a shell does to the result of an expansion, never to the
            // word's own literal text, so this piece is no ground for a delimiter of its own.
            out.push({ text: literal, split: false, glob: split && literalGlob });
            literal = '';
            literalGlob = false;
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
            out.push({ text: run.text, split, glob: split });
            i = end + 1;
            continue;
        }
        if (ch !== '$') {
            if (ch === '*' || ch === '?' || ch === '[') literalGlob = true;
            literal += ch;
            i++;
            continue;
        }
        const next = text[i + 1];
        if (next === '(' && text[i + 2] === '(') {
            const end = matchArithmetic(text, i + 2);
            if (end !== -1) {
                flushLiteral();
                const value = arithmeticValue(shell, text.slice(i + 3, end - 1));
                // `1/0`: an expansion error, which ends the line as it ends a shell
                if (value.error !== null) {
                    ctx.error = value.error;
                    ctx.code = 127;
                    return;
                }
                out.push({ text: value.text, split, glob: split });
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
                out.push({ text: run.text, split, glob: split });
                i = end + 1;
                continue;
            }
        }
        if (next === '{') {
            const end = matchBrace(text, i + 1);
            if (end !== -1) {
                flushLiteral();
                const from = out.length;
                paramExpansion(shell, text.slice(i + 2, end), split, out, ctx);
                if (ctx.error !== null) return;
                for (let k = from; k < out.length; k++) out[k].glob = split;
                i = end + 1;
                continue;
            }
        }
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
        if (name !== null) {
            flushLiteral();
            out.push({ text: valueOfName(shell, name[0]), split, glob: split });
            i += 1 + name[0].length;
            continue;
        }
        if (next !== undefined && '0123456789#@*?$!-'.includes(next)) {
            flushLiteral();
            if (next === '@' || next === '*') parameterAtoms(shell, next, split, out);
            else out.push({ text: valueOfName(shell, next), split, glob: split });
            i += 2;
            continue;
        }
        literal += ch;
        i++;
    }
    flushLiteral();
}

/** `$(( ))`. The expression is the module's own evaluator, so the operators are the ones it already has. */
function arithmeticValue(shell: SyncShell, expression: string): { text: string; error: string | null } {
    try {
        return { text: String(evalArith(shellStateFor(shell), expression)), error: null };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { text: '', error: `${expression}: ${message}` };
    }
}

/** One `${...}`: the operators POSIX has, plus `${x/p/r}` and `${x:o:l}`. */
function paramExpansion(shell: SyncShell, body: string, split: boolean, out: ExpandAtom[], ctx: ExpandCtx): void {
    const literal = (): void => {
        out.push({ text: '${' + body + '}', split: false, glob: false });
    };
    if (body.startsWith('#') && body.length > 1) {
        const name = parameterName(body.slice(1));
        if (name === null) return literal();
        const length = name === '@' || name === '*' ? positionalOf(shell).length : valueOfName(shell, name).length;
        out.push({ text: String(length), split, glob: split });
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
        else out.push({ text: valueOfName(shell, name), split, glob: split });
        return;
    }
    const substring = /^:(-?\d+)(?::(-?\d+))?$/.exec(rest);
    if (substring !== null) {
        const from = Number(substring[1]);
        const value = scalar().split('');
        const start = from < 0 ? Math.max(0, value.length + from) : from;
        const count = substring[2] === undefined ? undefined : Number(substring[2]);
        out.push({ text: (count === undefined ? value.slice(start) : count < 0 ? value.slice(start, value.length + count) : value.slice(start, start + count)).join(''), split, glob: split });
        return;
    }
    if (rest.startsWith(':-')) {
        out.push({ text: empty ? word(rest.slice(2)) : scalar(), split, glob: split });
        return;
    }
    if (rest.startsWith('-') && rest[1] !== '}') {
        out.push({ text: set ? scalar() : word(rest.slice(1)), split, glob: split });
        return;
    }
    if (rest.startsWith(':=') || rest.startsWith('=')) {
        const value = rest.startsWith(':=') ? rest.slice(2) : rest.slice(1);
        if (empty) {
            const assigned = word(value);
            const refused = assignVar(shell, name, assigned);
            if (refused !== null) {
                ctx.error = refused;
                ctx.code = 127;
                return;
            }
            out.push({ text: assigned, split, glob: split });
        } else {
            out.push({ text: scalar(), split, glob: split });
        }
        return;
    }
    if (rest.startsWith(':+')) {
        out.push({ text: empty ? '' : word(rest.slice(2)), split, glob: split });
        return;
    }
    if (rest.startsWith('+')) {
        out.push({ text: set ? word(rest.slice(1)) : '', split, glob: split });
        return;
    }
    if (rest.startsWith(':?') || rest.startsWith('?')) {
        const colon = rest.startsWith(':?');
        if (colon ? empty : !set) {
            const message = word(rest.slice(colon ? 2 : 1));
            ctx.error = `${name}: ${message === '' ? 'parameter null or not set' : message}`;
            ctx.code = 127;
        } else {
            out.push({ text: scalar(), split, glob: split });
        }
        return;
    }
    /**
     * `${x#p}` and `${x%p}`. A regular expression matches leftmost-first, which is the wrong
     * direction for a shell's shortest match, so the cut points are tried in the order the operator
     * means instead of being anchored: `#` takes the shortest matching prefix (the first cut from
     * the left), `##` the longest, `%` the shortest matching suffix (the first cut from the right)
     * and `%%` the longest. `${x%.*}` on `a.b.c` is `a.b`, not `a`.
     */
    const trimmed = (operator: '#' | '%', longest: boolean, pattern: string): string => {
        const source = scalar();
        const regexp = patternRegExp(pattern, true);
        if (regexp === null) return source;
        const whole = new RegExp('^(?:' + regexp.source + ')$');
        const cuts: number[] = [];
        if (operator === '#') {
            for (let j = 0; j <= source.length; j++) cuts.push(j);
            if (longest) cuts.reverse();
            for (const j of cuts) if (whole.test(source.slice(0, j))) return source.slice(j);
            return source;
        }
        for (let k = source.length; k >= 0; k--) cuts.push(k);
        if (longest) cuts.reverse();
        for (const k of cuts) if (whole.test(source.slice(k))) return source.slice(0, k);
        return source;
    };
    if (rest.startsWith('##')) {
        out.push({ text: trimmed('#', true, word(rest.slice(2))), split, glob: split });
        return;
    }
    if (rest.startsWith('#')) {
        out.push({ text: trimmed('#', false, word(rest.slice(1))), split, glob: split });
        return;
    }
    if (rest.startsWith('%%')) {
        out.push({ text: trimmed('%', true, word(rest.slice(2))), split, glob: split });
        return;
    }
    if (rest.startsWith('%')) {
        out.push({ text: trimmed('%', false, word(rest.slice(1))), split, glob: split });
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
            out.push({ text: scalar(), split, glob: split });
            return;
        }
        const source = scalar();
        const flags = every ? 'g' : '';
        out.push({ text: source.replace(new RegExp(anchor + regexp.source, flags), replacement.replace(/\$/g, '$$')), split, glob: split });
        return;
    }
    literal();
}

/**
 * One word's worth of fields. Field splitting happens here and only here, on the `IFS` the shell
 * holds at this moment rather than on white space: a run of IFS white space that came out of an
 * unquoted expansion ends the field, and an empty unquoted expansion leaves none. A word the quoting
 * emptied is the other way round -- `printf ''` is one empty argument, not a command without one.
 */
function assembleFields(shell: SyncShell, atoms: ExpandAtom[]): ExpandedField[] {
    const ifs = valueOfName(shell, 'IFS');
    /* A word no unquoted expansion stands in is never split: `IFS=:; echo a:b` prints `a:b`. */
    const splits = atoms.some((atom) => atom.split === true);
    const fields: ExpandedField[] = [];
    let text = '';
    let mask: boolean[] = [];
    let glob = false;
    let have = false;
    const push = (): void => {
        if (have) {
            for (const piece of text === '' ? [''] : splitOnIFS(text, mask, ifs)) {
                fields.push({ text: piece, glob });
            }
        }
        text = '';
        mask = [];
        glob = false;
        have = false;
    };
    for (const atom of atoms) {
        if (atom.before === true && have) push();
        for (const ch of atom.text) {
            text += ch;
            mask.push(splits && atom.quoted !== true);
        }
        /* An unquoted expansion that came to nothing is no field at all: `set -- $undef` is none. */
        if (atom.text !== '' || atom.split !== true) have = true;
        glob = glob || atom.glob;
        if (atom.after === true && have) push();
    }
    push();
    return fields;
}

/* ----------------------------------------------------------------------------------------------
 * Pathname expansion
 *
 * A field that came out of an unquoted piece holding a `*`, a `?` or a `[` is a pattern: it is
 * replaced by the names it matches, and by itself when it matches none. As in a shell, `*` and `?`
 * never cross a `/`, a name beginning with `.` is matched only by a pattern that begins with `.`,
 * and a pattern ending in `/` matches directories only, with the `/` kept.
 * -------------------------------------------------------------------------------------------- */

/** The names a pattern component matches, as a regular expression; `*` and `?` never cross a `/`. */
function componentRegExp(pattern: string): RegExp | null {
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') {
            source += escapeRegExp(pattern[i + 1] ?? '\\');
            i++;
        } else if (ch === '*') {
            source += '[^/]*';
        } else if (ch === '?') {
            source += '[^/]';
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
        return new RegExp('^(?:' + source + ')$');
    } catch {
        return null;
    }
}

/** The names `pattern` expands to, sorted as a shell sorts them, or null when it matches none. */
function shellGlob(shell: SyncShell, pattern: string): string[] | null {
    if (!/[*?[]/.test(pattern)) return null;
    const fs = shell.ctx.fileSystem;
    const absolute = pattern.startsWith('/');
    const trailing = pattern.endsWith('/');
    const parts = (absolute ? pattern.slice(1) : pattern).split('/');
    if (trailing) parts.pop();
    if (parts.length === 0) return null;
    let dirs: string[] = [absolute ? '/' : shell.cwd];
    let stems: string[] = [absolute ? '/' : ''];
    for (let p = 0; p < parts.length; p++) {
        const component = parts[p];
        const last = p === parts.length - 1;
        const regexp = /[*?[]/.test(component) ? componentRegExp(component) : null;
        const nextDirs: string[] = [];
        const nextStems: string[] = [];
        const found: string[] = [];
        for (let d = 0; d < dirs.length; d++) {
            let entries: string[];
            try {
                entries = fs.listDirectory(dirs[d]);
            } catch {
                continue;
            }
            // `.` and `..` are real names a pattern beginning with `.` matches, as the host has it
            const names = component.startsWith('.') ? ['.', '..', ...entries] : entries;
            for (const name of names) {
                if (name !== '.' && name !== '..' && name.startsWith('.') && !component.startsWith('.')) continue;
                const matched = regexp === null ? name === component : regexp.test(name);
                if (!matched) continue;
                const stem = stems[d] + name;
                if (!last) {
                    const child = joinPath(dirs[d], name);
                    if (isDirectory(fs, child)) {
                        nextDirs.push(child);
                        nextStems.push(stem + '/');
                    }
                    continue;
                }
                if (trailing) {
                    if (isDirectory(fs, joinPath(dirs[d], name))) found.push(stem + '/');
                } else {
                    found.push(stem);
                }
            }
        }
        if (last) return found.length === 0 ? null : found.sort();
        dirs = nextDirs;
        stems = nextStems;
        if (dirs.length === 0) return null;
    }
    return null;
}

function joinPath(dir: string, name: string): string {
    return (dir.endsWith('/') ? dir : dir + '/') + name;
}

function isDirectory(fs: IFileSystem, path: string): boolean {
    try {
        return fs.isDirectory(path);
    } catch {
        return false;
    }
}

/** The names `ls` prints for one directory: sorted, and without the dot files, as the host has it. */
function lsNames(fs: IFileSystem, dir: string): string[] {
    return fs.listDirectory(dir).filter((name) => !name.startsWith('.')).sort();
}

/**
 * The fields one simple command runs with. Leading `NAME=value` words are assignments, not a
 * command: they go into the shell's variables, and a line that is nothing but assignments has no
 * command to run. Returns null for that, and for a word list with no words at all.
 */
function expandCommandWords(shell: SyncShell, words: RawWord[], ctx: ExpandCtx): string[] | null {
    let i = 0;
    while (i < words.length && ASSIGNMENT_WORD.test(rawText(words[i]))) i++;
    const assignments: string[] = [];
    for (let k = 0; k < i; k++) assignments.push(expandWordText(shell, words[k], ctx));
    const fields: string[] = [];
    for (let j = i; j < words.length; j++) {
        for (const field of assembleFields(shell, expandParts(shell, words[j], ctx))) {
            // `set -f` turns pathname expansion off; otherwise no match leaves the word as written
            if (field.glob && shell.state?.options.noglob !== true) {
                fields.push(...(shellGlob(shell, field.text) ?? [field.text]));
            } else {
                fields.push(field.text);
            }
        }
    }
    /* Every word of the command is expanded before its assignment prefixes take effect, the way a
       host shell has it: `IFS=:; s=a:b; IFS=, echo $s` prints `a b`, and not `a:b`. */
    for (const assignment of assignments) {
        const at = assignment.indexOf('=');
        if (at > 0) {
            const refused = assignVar(shell, assignment.slice(0, at), assignment.slice(at + 1));
            if (refused !== null) {
                ctx.error = refused;
                ctx.code = 127;
                return null;
            }
        }
    }
    if (i === words.length) return null;
    return fields;
}

/** The value of a whole word with no field splitting: an assignment, a redirect's file. */
function expandWordText(shell: SyncShell, word: RawWord, ctx: ExpandCtx): string {
    return expandParts(shell, word, ctx)
        .map((atom) => atom.text)
        .join('');
}

/**
 * Tilde expansion of the piece a word opens with: `~` and `~/rest` are the home directory. Only a
 * piece `tokenizeLine` pushed with field splitting still on is one -- an unquoted one -- so `echo ~`
 * is the home directory and `echo "~"` is a tilde. A `~` that names a user, `~root`, is left as it
 * was written: the container has no passwd table to answer a login name with a home directory.
 */
function expandTildePiece(text: string, shell: SyncShell): string {
    const slash = text.indexOf('/');
    const name = slash === -1 ? text.slice(1) : text.slice(1, slash);
    if (name !== '') return text;
    const home = shell.env.HOME;
    if (home === undefined || home === '') return text;
    return home + (slash === -1 ? '' : text.slice(slash));
}

function expandParts(shell: SyncShell, parts: ShellPart[], ctx: ExpandCtx): ExpandAtom[] {
    /* `''` and `""` leave a word with no piece in it at all, and one empty field is what they mean:
       the quoting wrote a word, the expansion of it is empty, and `printf ''` is a format. */
    if (parts.length === 0) return [{ text: '', split: false, glob: false, quoted: true }];
    const atoms: ExpandAtom[] = [];
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        const from = atoms.length;
        if (index === 0 && part.split && part.text.startsWith('~')) {
            atoms.push({ text: expandTildePiece(part.text, shell), split: false, glob: false });
        } else if (part.expand) {
            expandInto(shell, part.text, part.split, atoms, ctx);
        } else {
            atoms.push({ text: part.text, split: false, glob: false });
        }
        /* Quoted where the piece was, so field splitting leaves it alone however the word splits. */
        for (let k = from; k < atoms.length; k++) atoms[k].quoted = !part.split;
    }
    return atoms;
}

/* ----------------------------------------------------------------------------------------------
 * Redirection
 *
 * A redirection is an operator *and* a destination, and the two are resolved left to right before
 * the command runs: `2>&1` points stderr at wherever stdout points at that moment, so `> f 2>&1`
 * sends both to `f` while `2>&1 > f` leaves stderr on the terminal. `/dev/null` is a sink, not a
 * container file, and a destination that cannot be opened fails the command with status 1 without
 * running it, while an operator with no file after it is a syntax error, status 2, as the host has
 * both.
 * -------------------------------------------------------------------------------------------- */

/** Where one descriptor of a command goes once its redirections are resolved. */
type RedirectDest = { kind: 'stdout' } | { kind: 'stderr' } | { kind: 'null' } | { kind: 'file'; file: string; append: boolean };

/** One `<`, `>`, `>>` or `N>&M` of a command, in the order it was written. */
interface RedirectSpec {
    kind: 'in' | 'out' | 'dup';
    fd: number;
    /** The descriptor a `dup` copies the destination of, at this point in the list. */
    from?: number;
    append?: boolean;
    /** The file name as it was written; expanded when the redirection is resolved. */
    file?: RawWord;
    /** Set for `<<<`: `file` is the input itself, not the name of a file holding it. */
    hereString?: boolean;
}

/** `>`, `>>`, `<`, `2>`, `2>>`, `1<` ... with the file standing as a word of its own. */
const REDIRECT_OPERATOR = /^([0-9]?)(>>?|<)$/;
/** `cat <<< hi`: the here-string operator with the word it feeds written against it. */
const REDIRECT_HERESTRING_ATTACHED = /^([0-9]?)<<<(.+)$/;
/** `2>/dev/null`, `>out.txt`, `>>out.txt`, `<in.txt` ... : the file written against the operator. */
const REDIRECT_ATTACHED = /^([0-9]?)(>>?|<)(.+)$/;
/** `2>&1`, `1>&2`, `>&2` ... */
const REDIRECT_DUP = /^([0-9]?)>&([0-9])$/;

/**
 * The text of a word that is one *unquoted* piece, so a bare `>` counts and a quoted one does not:
 * `printf "<%s>"` writes a format, it opens no file. A quoted piece is the one `tokenizeLine` pushed
 * with field splitting off, and an escaped `>` with no expansion at all.
 */
function operatorText(word: RawWord): string | null {
    return word.length === 1 && word[0].expand && word[0].split ? word[0].text : null;
}

/** Removes every redirection from a command's words; `missing` names an operator with no file after it. */
function takeRedirects(words: RawWord[]): { ops: RedirectSpec[]; missing: string | null } {
    const ops: RedirectSpec[] = [];
    for (let i = 0; i < words.length; i++) {
        const text = operatorText(words[i]);
        if (text === null) continue;
        const dup = REDIRECT_DUP.exec(text);
        if (dup !== null) {
            words.splice(i, 1);
            i--;
            ops.push({ kind: 'dup', fd: dup[1] === '' ? 1 : Number(dup[1]), from: Number(dup[2]) });
            continue;
        }
        // `read -r line <<< "x y"`: the word after the operator is the input, not a file name
        if (text === '<<<') {
            if (i + 1 >= words.length) return { ops, missing: text };
            const word = words[i + 1];
            words.splice(i, 2);
            i--;
            ops.push({ kind: 'in', fd: 0, file: word, hereString: true });
            continue;
        }
        const op = REDIRECT_OPERATOR.exec(text);
        if (op !== null) {
            if (i + 1 >= words.length) return { ops, missing: text };
            const file = words[i + 1];
            words.splice(i, 2);
            i--;
            ops.push({ kind: op[2] === '<' ? 'in' : 'out', fd: fdOf(op[1], op[2]), file, append: op[2] === '>>' });
            continue;
        }
        // `2>/dev/null`, `>out.txt` -- and `<<<hi`, the here-string written against its operator
        const hereString = REDIRECT_HERESTRING_ATTACHED.exec(text);
        if (hereString !== null) {
            words.splice(i, 1);
            i--;
            ops.push({
                kind: 'in',
                fd: 0,
                file: [{ text: hereString[2], expand: true, split: false }],
                hereString: true
            });
            continue;
        }
        const attached = REDIRECT_ATTACHED.exec(text);
        if (attached === null) continue;
        words.splice(i, 1);
        i--;
        ops.push({
            kind: attached[2] === '<' ? 'in' : 'out',
            fd: fdOf(attached[1], attached[2]),
            // a redirect's file name is expanded but neither field-split nor globbed, as a shell has it
            file: [{ text: attached[3], expand: true, split: false }],
            append: attached[2] === '>>'
        });
    }
    return { ops, missing: null };
}

/** The descriptor a redirect names: 0 for a bare `<`, 1 for a bare `>` or `>>`. */
function fdOf(digits: string, operator: string): number {
    if (digits !== '') return Number(digits);
    return operator === '<' ? 0 : 1;
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

/**
 * A diagnostic as the shell writes one: with the newline that ends it, so `2>&1` puts it on stdout
 * the way the host does. `runShell` adds the newline a command left out, and adds no second one.
 */
function diagnostic(text: string): string {
    return text === '' || text.endsWith('\n') ? text : text + '\n';
}

/** The text `< file` feeds a command; a file that is not there fails the command, as a shell's does. */
function readShellInput(shell: SyncShell, file: string): { text: string; error: string | null } {
    try {
        const text = shell.ctx.fileSystem.readFile(shellPath(shell, file));
        return text === undefined ? { text: '', error: `No such file or directory: ${file}` } : { text, error: null };
    } catch {
        // the file system's own message carries its absolute path; the shell names the file it was given
        return { text: '', error: `No such file or directory: ${file}` };
    }
}

/** What a file holds, or undefined where it is not there or cannot be read. */
function readFileOrUndefined(shell: SyncShell, file: string): string | undefined {
    try {
        return shell.ctx.fileSystem.readFile(file);
    } catch {
        return undefined;
    }
}

/** Opens the destination of a `>` or `>>` before the command runs: `>` empties it, `>>` creates it. */
function openRedirectFile(shell: SyncShell, dest: { file: string; append: boolean }): string | null {
    const fs = shell.ctx.fileSystem;
    try {
        if (!dest.append || readFileOrUndefined(shell, dest.file) === undefined) fs.writeFile(dest.file, '');
        return null;
    } catch {
        return `No such file or directory: ${dest.file}`;
    }
}

/** Sends what a command wrote to stdout and to stderr to the destinations its redirections named. */
function finishRedirects(shell: SyncShell, dest: (RedirectDest | null)[], step: ShellStep): ShellStep {
    let stdout = '';
    let stderr = '';
    const write = (d: RedirectDest & { kind: 'file' }, text: string): void => {
        if (text === '') return;
        try {
            const existing = d.append ? readFileOrUndefined(shell, d.file) ?? '' : '';
            shell.ctx.fileSystem.writeFile(d.file, existing + text);
        } catch {
            /* a destination that closed under the command's feet is left as it is */
        }
    };
    const one = dest[1];
    const two = dest[2];
    // `> f 2>&1`: one destination, so the two streams reach it in the order the command wrote them
    if (one !== null && one === two && one.kind === 'file') {
        write(one, step.stdout + step.stderr);
        return { stdout: '', stderr: '', exitCode: step.exitCode, signal: step.signal };
    }
    for (const fd of [1, 2] as const) {
        const d = dest[fd];
        const text = fd === 1 ? step.stdout : step.stderr;
        if (d === null || d.kind === 'null') continue;
        if (d.kind === 'stdout') stdout += text;
        else if (d.kind === 'stderr') stderr += text;
        else write(d, text);
    }
    return { stdout, stderr, exitCode: step.exitCode, signal: step.signal };
}

/**
 * One command of a pipeline, run with `input` as its standard input: its own `< file` wins over the
 * pipe, and its redirections apply to it alone, not to the pipeline.
 */
function shellStage(shell: SyncShell, words: RawWord[], input: string | null): ShellStep {
    const stageWords = words.slice();
    const { ops, missing } = takeRedirects(stageWords);
    if (missing !== null) return { stdout: '', stderr: diagnostic(`Syntax error: missing file for redirection ${missing}`), exitCode: 2 };
    const ctx: ExpandCtx = { error: null, code: 0, substStatus: null };
    // 0 is the command's input; 1 and 2 start as the shell's own two outputs
    const dest: (RedirectDest | null)[] = [null, { kind: 'stdout' }, { kind: 'stderr' }];
    let stageInput = input;
    for (const op of ops) {
        if (op.kind === 'dup') {
            dest[op.fd] = dest[op.from ?? 1] ?? { kind: 'null' };
            continue;
        }
        const file = expandWordText(shell, op.file as RawWord, ctx);
        if (ctx.error !== null) {
            shell.stopped = true;
            return { stdout: '', stderr: diagnostic(ctx.error), exitCode: ctx.code };
        }
        if (op.kind === 'in') {
            /* A here-string is the word itself, with the newline a host shell writes after it; only a
               `<` names a file to read. */
            if (op.hereString === true) {
                stageInput = `${file}\n`;
                continue;
            }
            const read = readShellInput(shell, file);
            if (read.error !== null) return { stdout: '', stderr: diagnostic(read.error), exitCode: 1 };
            stageInput = read.text;
            continue;
        }
        dest[op.fd] = file === '/dev/null' ? { kind: 'null' } : { kind: 'file', file: shellPath(shell, file), append: op.append === true };
    }
    for (const fd of [1, 2] as const) {
        const d = dest[fd];
        if (d === null || d.kind !== 'file') continue;
        const failed = openRedirectFile(shell, d);
        // the command never runs where a destination cannot be opened, as it never does in a shell
        if (failed !== null) return { stdout: '', stderr: diagnostic(failed), exitCode: 1 };
    }
    const saved = shell.input;
    shell.input = stageInput;
    try {
        const fields = expandCommandWords(shell, stageWords, ctx);
        if (ctx.error !== null) {
            // `${x:?}` and an assignment to a read-only variable end the line, as they end a shell
            shell.stopped = true;
            return { stdout: '', stderr: diagnostic(ctx.error), exitCode: ctx.code };
        }
        // a line of assignments and nothing else has no command to run
        if (fields === null) return finishRedirects(shell, dest, { stdout: '', stderr: '', exitCode: ctx.substStatus ?? 0 });
        return finishRedirects(shell, dest, shellCommand(shell, fields));
    } finally {
        shell.input = saved;
    }
}

/**
 * A pipeline: every command reads what the command before it wrote. The status is the last
 * command's, or the first that failed under `set -o pipefail`, and every command's error output is
 * the pipeline's.
 */
function shellPipeline(shell: SyncShell, stages: RawWord[][]): ShellStep {
    let input = shell.input;
    let stderr = '';
    let step: ShellStep = { stdout: '', stderr: '', exitCode: 0 };
    let firstFailure: number | null = null;
    for (let i = 0; i < stages.length; i++) {
        step = shellStage(shell, stages[i], input);
        input = step.stdout;
        if (step.exitCode !== 0 && firstFailure === null) firstFailure = step.exitCode;
        if (i < stages.length - 1) stderr += step.stderr;
    }
    const exitCode = shell.state?.options.pipefail === true && firstFailure !== null ? firstFailure : step.exitCode;
    return { stdout: step.stdout, stderr: stderr + step.stderr, exitCode, signal: step.signal };
}

/** The command as `jobs` prints it: the words of every stage, joined as they were written. */
function jobText(stages: RawWord[][]): string {
    return stages.map((stage) => stage.map(rawText).join(' ')).join(' | ');
}

/**
 * `cmd &`: records the job and runs nothing, as a shell that does not wait for the command runs
 * nothing where it stands. `line` is the whole text of a compound job (`{ echo a; } &`), which is
 * run through the script engine when something asks for it; a job of plain commands runs from
 * `stages`. The shell's own `$?` after it is 0, as it is after any command it does not wait for,
 * and `$!` is the pid of the job.
 *
 * Nothing is printed: bash prints `[1] 12345` only in an interactive shell, and a line handed to
 * `sh -c` -- which is every line here -- gets no such line from it.
 */
function startBackgroundJob(shell: SyncShell, stages: RawWord[][], line?: string): ShellJob {
    const jobs = jobsOf(shell);
    const id = jobs.reduce((high, job) => Math.max(high, job.id), 0) + 1;
    const job: ShellJob = {
        id,
        pid: nextBackgroundPid++,
        text: line === undefined ? jobText(stages) : formatJobText(line),
        stages,
        line,
        done: false,
        exitCode: 0
    };
    jobs.push(job);
    // `$!` lives in the state the builtins share, so it is the same pid `wait` and `$!` see
    shellStateFor(shell).lastBackgroundPid = job.pid;
    return job;
}

/**
 * The parts of the engine's state a compound job may change and the line around it must not see. A
 * job is a subshell in bash, so what it does to the variables, the functions and the options stays
 * in it -- `f(){ echo fn; } & wait; f` is `f: command not found`, and `{ g=2; } & wait` leaves `g`
 * as the line before it set it -- while everything it inherits, `g` included, is still there when it
 * starts.
 */
function snapshotEngineState(state: ShellState) {
    return {
        scopes: state.scopes.map((scope) => new Map([...scope].map(([name, variable]) => [name, { ...variable }]))),
        functions: [...state.functions],
        aliases: [...state.aliases]
    };
}

function restoreEngineState(state: ShellState, saved: ReturnType<typeof snapshotEngineState>): void {
    state.scopes.length = 0;
    for (const scope of saved.scopes) state.scopes.push(scope);
    state.functions.clear();
    for (const [name, body] of saved.functions) state.functions.set(name, body);
    state.aliases.clear();
    for (const [name, value] of saved.aliases) state.aliases.set(name, value);
}

/**
 * A compound job, run as the subshell bash runs it in. The engine's state is put back afterwards, so
 * the line around the job keeps its own variables and functions. A job the job itself started stays
 * in the table: the line's own flush runs it, as the shell runs the child of a subshell it waits for.
 */
function runCompoundJob(shell: SyncShell, line: string): ShellStep {
    const state = shellStateFor(shell);
    const saved = snapshotEngineState(state);
    try {
        return runCompoundLine(shell, line);
    } finally {
        restoreEngineState(state, saved);
    }
}

/** Runs one job to completion. A job is a subshell: what it does to the directory and to `$?` stays in it. */
function runJob(shell: SyncShell, job: ShellJob): ShellStep {
    const savedCwd = shell.cwd;
    const savedStatus = shell.lastStatus;
    const savedStopped = shell.stopped;
    try {
        const step = job.line === undefined ? shellPipeline(shell, job.stages) : runCompoundJob(shell, job.line);
        job.done = true;
        job.exitCode = step.exitCode;
        return step;
    } finally {
        shell.cwd = savedCwd;
        shell.lastStatus = savedStatus;
        shell.stopped = savedStopped;
        if (shell.state !== undefined) {
            shell.state.cwd = savedCwd;
            shell.state.lastStatus = savedStatus;
        }
    }
}

/**
 * Drops the jobs that have run out of the table. A shell keeps a job only while it has something to
 * say about it: once `wait` has reaped it -- or the line's own flush has run it -- `jobs` lists it no
 * more, which is why `cmd & wait; jobs` prints nothing where `cmd & jobs` prints one line.
 */
function reapJobs(shell: SyncShell): void {
    const jobs = shell.jobs;
    if (jobs === undefined) return;
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].done) jobs.splice(i, 1);
}

/**
 * Runs every job of the line that has not run yet, in the order it was started. This is what a
 * background job means on a host that runs one command at a time: the command is not waited for
 * where it is written, and it is run -- with its output kept -- once the line's foreground is
 * through, or the moment `wait` asks for it.
 */
function runPendingJobs(shell: SyncShell): ShellStep {
    const jobs = shell.jobs;
    if (jobs === undefined) return { stdout: '', stderr: '', exitCode: 0 };
    let stdout = '';
    let stderr = '';
    for (const job of jobs) {
        if (job.done) continue;
        const step = runJob(shell, job);
        stdout += step.stdout;
        stderr += step.stderr;
    }
    reapJobs(shell);
    return { stdout, stderr, exitCode: 0 };
}

/** The job `wait` or `jobs` names: `%2` is the second job, a bare number is a pid. */
function findJob(shell: SyncShell, name: string): ShellJob | undefined {
    const jobs = jobsOf(shell);
    if (name.startsWith('%')) {
        const spec = name.slice(1);
        const last = jobs[jobs.length - 1];
        if (spec === '+' || spec === '%' || spec === '') return last;
        if (spec === '-') return jobs[jobs.length - 2];
        return jobs.find((job) => job.id === Number(spec));
    }
    const pid = Number(name);
    return Number.isNaN(pid) ? undefined : jobs.find((job) => job.pid === pid);
}

/**
 * `wait`, the one command of the job table a builtin cannot answer. The builtins of `builtins.ts`
 * read the same table -- the state takes it out of `state.host`, which is this shell -- so their own
 * `jobs` lists these very jobs in the columns a shell prints them in, and is reached like any other
 * builtin. Running one is another matter: on a host that runs one command at a time a job runs only
 * when something asks for it, and nothing in that module can ask this dispatcher to run one.
 */
function shellWait(shell: SyncShell, args: string[]): ShellStep {
    // `wait`: no argument waits for every job, as it does in a shell, and its status is 0
    if (args.length === 0) return runPendingJobs(shell);
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    for (const arg of args) {
        if (arg === '-n' || arg === '-f') continue;
        const job = findJob(shell, arg);
        if (job === undefined) {
            /* bash says which of the three went wrong: a job spec that names no job, a number that is
               no child of the shell, or a word that is neither a pid nor a job spec. The middle one
               is written without the `line 0` the other two carry, as bash writes it. */
            const prefix = diagnosticPrefix(shellStateFor(shell));
            if (arg.startsWith('%')) stderr += `${prefix}wait: ${arg}: no such job\n`;
            else if (/^[0-9]+$/.test(arg)) stderr += `${shell.name ?? 'sh'}: wait: pid ${arg} is not a child of this shell\n`;
            else stderr += `${prefix}wait: \`${arg}': not a pid or valid job spec\n`;
            exitCode = arg.startsWith('%') || /^[0-9]+$/.test(arg) ? 127 : 1;
            continue;
        }
        const step = job.done ? { stdout: '', stderr: '', exitCode: job.exitCode } : runJob(shell, job);
        stdout += step.stdout;
        stderr += step.stderr;
        exitCode = step.exitCode;
    }
    // a job `wait` has reaped is a job `jobs` no longer lists, as it is in a shell
    reapJobs(shell);
    return { stdout, stderr, exitCode };
}

/**
 * A line that opens with a compound command -- `if`, `for`, `while`, `until`, `case`, a `{ }` group,
 * a `( )` subshell or a function definition -- handed to the script engine of `builtins.ts`, which
 * already parses all of them. Every simple command it meets comes back through the runner installed
 * at the top of this file, so the line keeps this dispatcher's own commands, its node execution and
 * its 127 for an unknown name, and the engine keeps `set -e` and `set -o pipefail` inside the
 * construct, which this loop cannot see.
 */
function runCompoundLine(shell: SyncShell, line: string): ShellStep {
    const state = shellStateFor(shell);
    const savedIo = state.io;
    const savedBuffer = state.inputBuffer;
    const savedCursor = state.inputCursor;
    // `read` and `mapfile` take their lines out of the state's buffer, not out of the context
    state.inputBuffer = shell.input ?? '';
    state.inputCursor = 0;
    state.io = { stdout: '', stderr: '' };
    try {
        const step = withShellState(state, () => {
            try {
                const result = runScript(state, line);
                return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
            } catch (error) {
                if (isNotSupported(error) || isShellSuspend(error)) throw error;
                return {
                    stdout: state.io.stdout,
                    stderr: state.io.stderr + (error instanceof Error ? error.message : String(error)),
                    exitCode: 1
                };
            } finally {
                if (state.execTarget !== null) shell.stopped = true;
                shell.cwd = state.cwd;
                syncShellEnv(shell, state);
            }
        });
        // runScript has already run the EXIT trap; drop it so runExitTrap cannot run it a second time
        state.traps.delete('EXIT');
        shell.lastStatus = step.exitCode;
        state.lastStatus = step.exitCode;
        return step;
    } finally {
        state.io = savedIo;
        state.inputBuffer = savedBuffer;
        state.inputCursor = savedCursor;
    }
}

/**
 * ShellProcess.executeCommand for one command line: `;`, `&&` and `||`, with the exit status of the
 * last command that ran. `exit` stops the line, as it stops a shell -- not, however, when it is the
 * command of a background segment: there it is the subshell the job runs in that ends, as it is in
 * bash, and the line goes on. A `|` with a command missing beside it is a syntax error the whole
 * line fails on, before anything runs, as /bin/sh has it.
 *
 * `deferPendingJobs` is for a command substitution, which is a shell of its own inside this one: it
 * leaves the jobs it started for the line around it to run, so they are run after it, never in it.
 */
function shellLine(shell: SyncShell, line: string, deferPendingJobs = false): ShellStep {
    const body = stripComment(line);
    const syntax = syntaxErrorOf(body);
    if (syntax !== null) return { stdout: '', stderr: diagnostic(syntax), exitCode: 2 };
    const segments = splitCommandList(body).filter((segment) => segment.words.length > 0);
    const pipelines: (RawWord[][] | null)[] = segments.map((segment) => splitPipeline(segment.words));
    if (pipelines.some((pipeline) => pipeline === null)) {
        return { stdout: '', stderr: diagnostic('Syntax error: a command is missing beside `|`'), exitCode: 2 };
    }
    if (segments.some(segmentStartsCompound)) {
        /* A compound line ends the same way any other does: the jobs it started -- `{ echo a; } &`
           is one -- are run once its own commands are through, and the EXIT trap fires after them. */
        const step = runCompoundLine(shell, body);
        return endOfLine(shell, step.stdout, step.stderr, step.exitCode, deferPendingJobs);
    }
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    for (let i = 0; i < segments.length; i++) {
        // `exec` replaced the shell, or an expansion error ended it: nothing after it runs
        if (shell.stopped) break;
        const segment = segments[i];
        if (segment.op === '&&' && exitCode !== 0) continue;
        if (segment.op === '||' && exitCode === 0) continue;
        let step: ShellStep;
        if (segment.background === true) {
            // nothing runs where the `&` stands, and nothing is printed for it: see startBackgroundJob
            startBackgroundJob(shell, pipelines[i] as RawWord[][]);
            step = EMPTY_STEP;
        } else {
            const pipeline = pipelines[i] as RawWord[][];
            /* Only a trailing command can suspend. The engine steps one command at a time, so a
               command *after* an `npm install` on the same line could not run -- it would be
               skipped, and a line that quietly runs half of itself is worse than one that says it
               cannot run. Setting the flag before the step is what keeps the install from being
               started in that case at all. */
            shell.suspendable = i + 1 === segments.length && pipeline.length === 1;
            try {
                step = shellPipeline(shell, pipeline);
            } finally {
                shell.suspendable = undefined;
            }
        }
        stdout += step.stdout;
        stderr += step.stderr;
        exitCode = step.exitCode;
        // a command that signalled this shell ends the line on the signal: nothing after it runs
        if (step.signal !== undefined) return { stdout, stderr, exitCode: 0, signal: step.signal };
        // `$?` is what the last command left, for the expansions of the next one
        shell.lastStatus = exitCode;
        if (shell.state !== undefined) shell.state.lastStatus = exitCode;
        // `exit` ends the line -- but a backgrounded one ends only the subshell of its job
        if (segment.background !== true && rawText(segment.words[0]) === 'exit') break;
        // `set -e`: a command that fails ends the line, unless it is an operand of `&&` or `||`
        const operand =
            segment.op === '&&' ||
            segment.op === '||' ||
            (i + 1 < segments.length && (segments[i + 1].op === '&&' || segments[i + 1].op === '||'));
        if (!operand && shell.state?.options.errexit === true && exitCode !== 0) break;
    }
    return endOfLine(shell, stdout, stderr, exitCode, deferPendingJobs);
}

/**
 * The end of a line: a job no one waited for cannot outlive the line on a host that runs one command
 * at a time, so it runs here, after the foreground is through -- started late rather than never, and
 * never before. Then the EXIT trap, and then a job the trap itself started.
 */
function endOfLine(
    shell: SyncShell,
    stdout: string,
    stderr: string,
    exitCode: number,
    deferPendingJobs: boolean
): ShellStep {
    const flushed = deferPendingJobs ? EMPTY_STEP : runPendingJobs(shell);
    const trapped = runExitTrap(
        shell,
        { stdout: stdout + flushed.stdout, stderr: stderr + flushed.stderr, exitCode },
        deferPendingJobs
    );
    // a job the EXIT trap itself started is run the same way
    const afterTrap = deferPendingJobs ? EMPTY_STEP : runPendingJobs(shell);
    return { stdout: trapped.stdout + afterTrap.stdout, stderr: trapped.stderr + afterTrap.stderr, exitCode: trapped.exitCode };
}

/**
 * `trap ACTION EXIT`: the action runs when the line ends, and the line's status is the status it had.
 * The trap is removed first, so its own commands cannot fire it again. No other condition ever arises
 * in this dispatcher -- there are no signals, and no `DEBUG` or `ERR` hook -- so a trap set on one of
 * those is recorded and listed by `trap -p` and never runs.
 */
function runExitTrap(shell: SyncShell, step: ShellStep, deferPendingJobs = false): ShellStep {
    const state = shell.state;
    if (state === undefined) return step;
    const trap = state.traps.get('EXIT');
    if (trap === undefined || trap.reset || trap.ignore || trap.action === '') return step;
    state.traps.delete('EXIT');
    const fired = shellLine(shell, trap.action, deferPendingJobs);
    return { stdout: step.stdout + fired.stdout, stderr: step.stderr + fired.stderr, exitCode: step.exitCode };
}

/** The version `curl --version` and `wget --version` report: the one in packages/core/package.json. */
const CONTAINER_VERSION = '0.1.0';

/**
 * `curl --version` and `wget --version`: the two words of `SHELL_EXTERNALS` that name no request,
 * so they can be answered without a network. What is printed is the container's own version of the
 * two, and it says so: a fetch here is `fetch`, not a libcurl or a GNU build, and a line that only
 * looks like the host's would be a lie. Anything else -- a URL, an option, no argument at all --
 * falls through to the honest failure it gives today.
 */
function externalVersion(command: string, args: string[]): string | null {
    if (command !== 'curl' && command !== 'wget') return null;
    if (args.length === 0 || !args.every((arg) => arg === '--version' || arg === '-V')) return null;
    if (command === 'curl') return `curl ${CONTAINER_VERSION} (OpenWebContainer)\nProtocols: http https\nFeatures: fetch\n`;
    return `Wget ${CONTAINER_VERSION} (OpenWebContainer)\n`;
}

/** The first line of `file`, or undefined when it cannot be read. */
function readFirstLine(fs: IFileSystem, file: string): string | undefined {
    try {
        return fs.readFile(file);
    } catch {
        return undefined;
    }
}

/**
 * `npm` in a synchronous call, reached from a line that names it and from `spawnSync('npm', ...)`.
 *
 * `npm run` and the lifecycle commands run the package's script here, in the shell engine already
 * on the stack, so a script of shell commands and `node` files works where the container's own npm
 * process -- which is asynchronous end to end -- cannot be stepped. `npm install` is answered by
 * `npmInstallStep`, which suspends the guest while the host installs; `npm uninstall` is answered
 * here, without leaving the call; every other command that has to reach the registry still cannot,
 * and says so rather than answering with a status that means nothing.
 */
function npmCommand(shell: SyncShell, args: string[]): ShellStep {
    const [sub, ...rest] = args;
    if (sub === '-v' || sub === '--version' || sub === 'version') {
        return { stdout: NPM_VERSION + '\n', stderr: '', exitCode: 0 };
    }
    if (sub !== undefined && REMOVE_SUBCOMMANDS.has(sub)) return npmRemove(shell, args);
    if (sub !== undefined && INSTALL_SUBCOMMANDS.has(sub)) {
        /* Reached only where the install cannot suspend: inside a nested synchronous child, whose own
           wasm call sits inside the one that spawned it, or with another command on the line that
           would have to run after it. Name which of the two it is. */
        if (syncRunActive()) throw notSupportedNested(`npm ${sub}`);
        throw notSupportedSync(`npm ${sub} as anything but the last command of a synchronous line`);
    }
    const event = LIFECYCLE_COMMANDS[sub ?? ''];
    if (sub !== 'run' && sub !== 'run-script' && event === undefined) {
        throw notSupportedSync(`the shell command npm ${sub ?? ''}`.trim());
    }
    const { name, ifPresent, extra } = parseScriptArgs(rest, event);
    const packageDir = findPackageRoot(shell.ctx.fileSystem, shell.cwd) ?? shell.cwd;
    const manifest = readManifest(shell.ctx.fileSystem, packageDir);
    if (manifest === undefined) {
        return { stdout: '', stderr: diagnostic(`npm error code ENOENT\nnpm error enoent Could not read package.json in ${packageDir}`), exitCode: 1 };
    }
    const label = scriptLabel(manifest, packageDir);
    const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
    if (name === undefined) return { stdout: scriptList(label, scripts), stderr: '', exitCode: 0 };
    if (typeof scripts[name] !== 'string') {
        if (ifPresent) return EMPTY_STEP;
        return { stdout: '', stderr: diagnostic(missingScriptMessage(name)), exitCode: 1 };
    }
    const PATH = scriptPath(shell.ctx.fileSystem, packageDir, shell.env.PATH);
    let stdout = '';
    for (const step of scriptEvents(name, scripts)) {
        const command = String(scripts[step]);
        const line = scriptCommandLine(scripts, step, name, extra);
        stdout += scriptHeader(label, step, line);
        /* one shell per script, as npm has: the directory, the exported variables and `$?` of one
           script are its own, and only PATH and the npm_package_* names carry over. */
        const child: SyncShell = {
            ctx: shell.ctx,
            cwd: packageDir,
            env: {
                ...shell.env,
                PATH,
                npm_package_name: String(manifest.name ?? ''),
                npm_package_version: String(manifest.version ?? ''),
                npm_package_json: `${packageDir === '/' ? '' : packageDir}/package.json`,
                npm_lifecycle_event: step
            },
            input: shell.input,
            lastStatus: shell.lastStatus
        };
        const result = shellLine(child, line);
        stdout += result.stdout;
        if (result.exitCode !== 0) {
            return { stdout, stderr: diagnostic(result.stderr + scriptFailureMessage(label, step, command, result.exitCode)), exitCode: result.exitCode };
        }
        stdout += result.stderr;
    }
    return { stdout, stderr: '', exitCode: 0 };
}

/** `npm install <spec...>`: what npm reads out of the words after the subcommand. */
function installRequest(args: string[]): { specs: InstallSpec[]; save: SaveTarget } {
    let save: SaveTarget = 'dependencies';
    const specs: InstallSpec[] = [];
    for (const arg of args) {
        if (arg === '-D' || arg === '--save-dev') save = 'devDependencies';
        else if (arg === '-P' || arg === '--save-prod' || arg === '-S' || arg === '--save') save = 'dependencies';
        else if (arg === '--no-save') save = 'none';
        else if (arg.startsWith('-')) continue;
        else specs.push(parseInstallSpec(arg));
    }
    return { specs, save };
}

/** The npm subcommands that remove a package: every alias npm itself gives `npm uninstall`. */
const REMOVE_SUBCOMMANDS = new Set(['uninstall', 'unlink', 'remove', 'rm', 'un']);

/** Where a project's own files sit: `package.json`, and the `node_modules` beside it. */
function projectFile(dir: string, name: string): string {
    return `${dir === '/' ? '' : dir}/${name}`;
}

/**
 * `npm uninstall <name...>`.
 *
 * Nothing here reaches the registry -- it reads and writes the project's own files -- so it answers
 * inside the synchronous call, without suspending the guest. What npm does beyond this is prune the
 * dependencies the removed package brought with it and nothing else wanted; they are left in place,
 * which costs disk and changes nothing a later install resolves.
 */
function npmRemove(shell: SyncShell, args: string[]): ShellStep {
    const rest = args.slice(1);
    if (rest.includes('-g') || rest.includes('--global')) {
        return { stdout: '', stderr: diagnostic('npm error code EUNSUPPORTED\nnpm error Global installs are not supported by this runtime'), exitCode: 1 };
    }
    const names = rest.filter((arg) => !arg.startsWith('-'));
    const packageDir = findPackageRoot(shell.ctx.fileSystem, shell.cwd) ?? shell.cwd;
    const started = performance.now();
    let removed = 0;
    for (const name of names) {
        const dir = projectFile(packageDir, `node_modules/${name}`);
        if (shell.ctx.fileSystem.statPath(dir)?.type !== 'dir') continue;
        shell.ctx.fileSystem.removePath(dir, true);
        removed += 1;
    }
    if (removed > 0 && !rest.includes('--no-save')) {
        const manifest = readManifest(shell.ctx.fileSystem, packageDir);
        if (manifest !== undefined) {
            for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
                const entries = manifest[field];
                if (entries === null || typeof entries !== 'object') continue;
                for (const name of names) delete (entries as Record<string, unknown>)[name];
            }
            shell.ctx.fileSystem.writeFile(projectFile(packageDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
        }
        /* The lockfile records the whole tree, so the entry of what is gone is dropped from it: a
           later install reads it back and would otherwise keep the package in the tree. */
        const lockPath = projectFile(packageDir, 'package-lock.json');
        try {
            const text = shell.ctx.fileSystem.readFile(lockPath);
            const lock = JSON.parse(text ?? '{}');
            const packages = lock?.packages;
            if (packages !== null && typeof packages === 'object') {
                for (const name of names) delete packages[`node_modules/${name}`];
                shell.ctx.fileSystem.writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
            }
        } catch {
            // no lockfile, or one that does not parse: nothing of it to drop
        }
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (removed === 0) return { stdout: `up to date in ${seconds}s\n`, stderr: '', exitCode: 0 };
    return { stdout: `removed ${removed} package${removed === 1 ? '' : 's'} in ${seconds}s\n`, stderr: '', exitCode: 0 };
}

/** The npm subcommands that install, and so the ones that have to reach the registry. */
const INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'add']);

/**
 * `npm install` inside a synchronous call, as a step the caller can wait on.
 *
 * The install fetches from the registry, which nothing inside a synchronous call can wait for on its
 * own -- the host thread is the thread the call is blocking. So this is the one place a synchronous
 * capability answers with a promise instead of a result: the guest's stack unwinds on it (see
 * `callFunctionMaybe` in process.ts), the host installs, and the guest resumes inside the very
 * `spawnSync` that asked. The statement after that call has not run yet when the promise settles,
 * which is the whole of what a synchronous call means.
 *
 * Where the guest cannot unwind, undefined comes back and the caller gives the refusal it has always
 * given. That is the case of a synchronous child: its own wasm call sits inside the one that spawned
 * it, one unwind cannot cover both, and the outer call would have to answer before this promise
 * could settle -- which would mean answering before the install had happened.
 *
 * Install scripts are not run. One runs a node child, and a child cannot be started while the guest
 * is unwound; skipping is what the installer already does with a script this runtime cannot run, and
 * it says so on the step's own output.
 */
function npmInstallStep(shell: SyncShell, args: string[]): Promise<ShellStep> | undefined {
    const [sub, ...rest] = args;
    if (sub === undefined || !INSTALL_SUBCOMMANDS.has(sub)) return undefined;
    if (syncRunActive()) return undefined;
    if (rest.includes('-g') || rest.includes('--global')) {
        return Promise.resolve({ stdout: '', stderr: diagnostic('npm error code EUNSUPPORTED\nnpm error Global installs are not supported by this runtime'), exitCode: 1 });
    }
    const { specs, save } = installRequest(rest);
    return (async () => {
        let stdout = '';
        const log = (line: string) => {
            stdout += line + '\n';
        };
        const installer = new NpmInstaller(shell.ctx.fileSystem, new NpmRegistry(), log);
        const started = performance.now();
        try {
            const report = specs.length > 0
                ? await installer.addPackages(shell.cwd, specs, save)
                : await installer.installManifest(shell.cwd);
            const seconds = ((performance.now() - started) / 1000).toFixed(1);
            stdout += report.added.length === 0
                ? `up to date in ${seconds}s\n`
                : `\nadded ${report.added.length} package${report.added.length === 1 ? '' : 's'} in ${seconds}s\n`;
            return { stdout, stderr: '', exitCode: 0 };
        } catch (error) {
            const failure = error as { exitCode?: unknown; message?: unknown };
            const stderr = typeof failure?.message === 'string' ? failure.message : String(error);
            return { stdout, stderr: diagnostic(stderr), exitCode: typeof failure?.exitCode === 'number' ? failure.exitCode : 1 };
        }
    })();
}

/** PATH as a host falls back to when a command asks for one and the environment carries none. */
const DEFAULT_PATH = '/bin:/usr/bin:/usr/local/bin';

function isFileAt(fs: IFileSystem, path: string): boolean {
    try {
        return fs.statPath(path)?.type === 'file';
    } catch {
        return false;
    }
}

/**
 * The file a command or a spawn names, as a host finds it.
 *
 * A name holding a slash is a path of its own: absolute, or relative to the caller's directory. Any
 * other name is looked for in the directories of PATH, and an empty entry of PATH -- `PATH=:/bin` --
 * means the current directory, as it does on a host. Undefined when no file stands at any of them.
 */
function resolveOnPath(shell: SyncShell, name: string): string | undefined {
    const fs = shell.ctx.fileSystem;
    if (name.includes('/')) {
        const path = fs.normalizePath(name.startsWith('/') ? name : `${shell.cwd.replace(/\/+$/, '')}/${name}`);
        return isFileAt(fs, path) ? path : undefined;
    }
    for (const entry of (shell.env.PATH ?? DEFAULT_PATH).split(':')) {
        const base = entry === '' ? shell.cwd : entry.endsWith('/') ? entry.slice(0, -1) : entry;
        const path = fs.normalizePath(`${base}/${name}`);
        if (isFileAt(fs, path)) return path;
    }
    return undefined;
}

/** The interpreter the first line of a file names, as the kernel reads it: `#!/usr/bin/env node` gives `node`. */
function shebangInterpreter(fs: IFileSystem, path: string): string | undefined {
    const first = readFirstLine(fs, path);
    if (first === undefined) return undefined;
    const match = /^#!([^\n]*)/.exec(first);
    if (match === null) return undefined;
    const tokens = match[1].trim().split(/\s+/).filter((token) => token !== '');
    if (tokens.length === 0) return undefined;
    return tokens[0] === 'env' || tokens[0].endsWith('/env')
        ? tokens.slice(1).find((token) => !token.startsWith('-'))
        : tokens[0].split('/').pop();
}

/**
 * One file the shell was asked to run, through the interpreter its name or its shebang names. A
 * `node_modules/.bin` shim is such a file -- a script with no .js name, so nothing claims it by
 * name -- and so is a script whose first line is `#!/bin/sh`. Undefined when neither this shell nor
 * the container has an interpreter for it, which is when the caller reports why.
 */
function runFileCommand(shell: SyncShell, path: string, args: string[], typed = path): ShellStep | undefined {
    const base = path.split('/').pop() ?? '';
    /* `sh -c <line>` and `sh <file> <args>`: the shell itself, named by what `$0` reads inside it,
       which is argv[0] -- the name the caller typed, not the path PATH resolved it to. */
    if (base === 'sh' || base === 'bash') {
        const inner = innerShell(shell, typed);
        return shellLine(inner, args[0] === '-c' ? (args[1] ?? '') : args.join(' '));
    }
    if (path.endsWith('.js') || base === 'node') return shellNode(shell, { file: path, args });
    const interpreter = shebangInterpreter(shell.ctx.fileSystem, path);
    if (interpreter === 'node') return shellNode(shell, { file: path, args });
    /* A script the kernel runs through its shebang is named by the path it was started from: the one
       PATH resolved when a name was typed, the one that was typed when a path was. */
    if (interpreter === 'sh' || interpreter === 'bash') {
        return shellScriptStep(shell, path, args, typed.includes('/') ? typed : path);
    }
    return undefined;
}

/** A shell of its own for one file: the caller's directory, environment and input, and its own state. */
function innerShell(shell: SyncShell, name: string): SyncShell {
    return { ctx: shell.ctx, cwd: shell.cwd, env: shell.env, input: shell.input, name, lastStatus: shell.lastStatus };
}

/**
 * A file whose shebang names a shell: its body runs in a shell of its own -- the shebang is the
 * kernel's line, not the script's -- with the words behind the file as its positional parameters, as
 * `sh <file> <args>` runs it on a host.
 */
function shellScriptStep(shell: SyncShell, path: string, args: string[], argv0 = path): ShellStep {
    let body = '';
    try {
        body = (shell.ctx.fileSystem.readFile(path) ?? '').replace(/^#![^\n]*\n?/, '');
    } catch {
        body = '';
    }
    const inner = innerShell(shell, argv0);
    shellStateFor(inner).positional = args;
    return runCompoundLine(inner, body);
}

/** The signal table of `kill` on the host, by number; index 0 is the null signal that only asks. */
const SIGNAL_NAMES = [
    '0', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'EMT', 'FPE', 'KILL', 'BUS', 'SEGV', 'SYS',
    'PIPE', 'ALRM', 'TERM', 'URG', 'STOP', 'TSTP', 'CONT', 'CHLD', 'TTIN', 'TTOU', 'IO', 'XCPU',
    'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'INFO', 'USR1', 'USR2'
];

/**
 * `kill` aimed at this shell's own pid, which is the step that ends the line on a signal. Undefined
 * when the command names no pid of this shell, or asks only whether one is alive.
 */
function selfSignal(shell: SyncShell, args: string[]): ShellStep | undefined {
    const pid = shell.pid ?? shellPidOf(shell);
    let signal = 'TERM';
    const pids: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const word = args[i];
        if (word === '-s' || word === '-n') {
            signal = args[i + 1] ?? signal;
            i += 1;
            continue;
        }
        if (word.startsWith('-') && word !== '-' && !/^-\d+$/.test(word)) {
            signal = word.slice(1);
            continue;
        }
        if (word.startsWith('-')) {
            signal = word.slice(1);
            continue;
        }
        pids.push(word);
    }
    if (!pids.includes(String(pid))) return undefined;
    const bare = signal.toUpperCase().replace(/^SIG/, '');
    const name = /^\d+$/.test(bare) ? SIGNAL_NAMES[Number(bare)] : (SIGNAL_NAMES.includes(bare) ? bare : undefined);
    /* The null signal only asks whether the process is there, and this one is: nothing ends. */
    if (name === undefined || name === '0') return { stdout: '', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0, signal: `SIG${name}` };
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
        // `jobs` reads the job table this dispatcher keeps for `&` -- the state the builtins share
        // takes it out of `state.host`, which is this shell -- so the builtin's own `jobs` answers it,
        // in the columns a shell prints them in
        if (command === 'jobs') return shellBuiltinModule(shell, command, cmdArgs);
        // `wait` has to run a job, and running one is something only this dispatcher can do
        if (command === 'wait') return shellWait(shell, cmdArgs);
        /* A jobspec typed as a command is `fg` with that jobspec as its argument, as it is in
           /bin/sh: `%1` never reaches a search for a command called `%1`. */
        if (command.startsWith('%')) return shellBuiltinModule(shell, 'fg', [command, ...cmdArgs]);
        /* `kill %1` names a job of this dispatcher's own table; `kill` itself can only signal the
           container's processes, and a job's pid is not one of them. */
        if (command === 'kill' && cmdArgs.some((arg) => arg.startsWith('%'))) {
            return killJobSpecs(shellStateFor(shell), cmdArgs);
        }
        /* `kill -9 $$` signals this shell, and a shell that is signalled ends on the signal rather
           than on a status: the run that started it reports null and the name, as a host reports a
           child the shell died from. Without this the pid went to the container's own process table,
           where no such pid exists, and `kill -9 $$` inside a synchronous run reached the guest that
           was running it -- the one pid `$$` used to answer -- and killed the program itself. */
        if (command === 'kill') {
            const own = selfSignal(shell, cmdArgs);
            if (own !== undefined) return own;
        }
        if (SHELL_BUILTINS.has(command)) return shellBuiltinWithRedirects(shell, command, cmdArgs);
        const version = externalVersion(command, cmdArgs);
        if (version !== null) return { stdout: version, stderr: '', exitCode: 0 };
        if (command === 'npm') {
            /* `npm install` is the one command here that can suspend instead of refusing. The shell
               engine steps one command at a time and has no promise to hand back, so the install
               travels out as a throw that `runShell` catches and waits on. */
            const install = shell.suspendable === true ? npmInstallStep(shell, cmdArgs) : undefined;
            if (install !== undefined) throw new ShellSuspend(install);
            return npmCommand(shell, cmdArgs);
        }
        // `curl` that names no URL has nothing to wait for: its own usage failure, with its own
        // status 2, so a synchronous caller gets what the utility would answer rather than the
        // blanket refusal a command that needs the network gets.
        if (command === 'curl') {
            const withoutNetwork = curlUsageResult(cmdArgs);
            if (withoutNetwork !== null) {
                return { stdout: withoutNetwork.stdout, stderr: withoutNetwork.stderr, exitCode: withoutNetwork.exitCode };
            }
        }
        if (SHELL_EXTERNALS.has(command)) throw notSupportedSync(`the shell command ${command}`);
        if (command === 'node' || command === NODE_BINARY) return shellNode(shell, nodeInvocation(cmdArgs));
        // A builtin is never looked for on PATH, the way it never is in a shell: `.` is the source
        // builtin, not the current directory, and `env` is not `/usr/bin/env`.
        if (!SHELL_BUILTIN_NAMES.has(command)) {
            const found = resolveOnPath(shell, command);
            if (found !== undefined) {
                const step = runFileCommand(shell, found, cmdArgs, command);
                if (step !== undefined) return step;
                return { stdout: '', stderr: diagnostic(`No executor found for: ${found}`), exitCode: 1 };
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
        return { stdout: '', stderr: diagnostic(`Command not found: ${command}`), exitCode: 127 };
    } catch (error) {
        if (isNotSupported(error) || isShellSuspend(error)) throw error;
        return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
    }
}

/**
 * `sh -c <line>` (or `sh <words>`): stdout exactly as the built-ins wrote it, stderr with a newline
 * after it, as ShellProcess prints it.
 *
 * A line that reaches `npm install` cannot be stepped to the end inside this call -- the install has
 * to reach the registry, and the host thread is the thread this call is blocking -- so it answers
 * with a promise instead, and the guest's stack unwinds on it exactly as it does for
 * `spawnSync('npm', ['install'])`. The line's own end -- its pending jobs and its EXIT trap -- runs
 * once the install is through, so a bare `npm install` line ends the way any other line ends.
 */
function runShell(
    ctx: CapabilityContext,
    argv: string[],
    env: Record<string, string>,
    cwd: string,
    input: string | null,
    name: string
): MaybeAsync<{ status: number | null; signal: string | null; stdout: string; stderr: string }> {
    if (argv.length === 0) throw notSupportedSync('an interactive sh (no command given)');
    const line = argv[0] === '-c' ? (argv[1] ?? '') : argv.join(' ');
    const shell: SyncShell = { ctx, cwd, env, input, name, lastStatus: 0 };
    let step: MaybeAsync<ShellStep>;
    try {
        step = shellLine(shell, line);
    } catch (error) {
        if (!isShellSuspend(error)) throw error;
        step = error.work.then((done) => endOfLine(shell, done.stdout, done.stderr, done.exitCode, false));
    }
    /* A shell the line signalled -- `sh -c 'kill -9 $$'` -- ends on the signal: no status, as a host
       reports for a child that died from one. */
    const shaped = (settled: ShellStep) => ({
        status: settled.signal === undefined ? settled.exitCode : null,
        signal: settled.signal ?? null,
        stdout: settled.stdout,
        stderr: ended(settled.stderr)
    });
    if (step instanceof Promise) return step.then(shaped);
    return shaped(step);
}

/** `sh` ends a diagnostic with a newline; a command that wrote its own already ends in one. */
function ended(stderr: string): string {
    return stderr === '' || stderr.endsWith('\n') ? stderr : stderr + '\n';
}

/** One completed shell step as a synchronous run: the pid npm and the shell commands get. */
function syncStep(step: ShellStep): SyncRun {
    return {
        pid: nextSyncPid++,
        status: step.signal === undefined ? step.exitCode : null,
        signal: step.signal ?? null,
        stdout: step.stdout,
        stderr: step.stderr,
        timedOut: false
    };
}

/**
 * Refuses a file the container would otherwise run as a program but a host cannot: one whose mode
 * carries no execute bit. A file system that keeps no modes leaves `mode` out, and such a file is
 * left alone -- there is no bit to read, and refusing it would break every file it holds.
 */
function refuseWithoutExecuteBit(ctx: CapabilityContext, file: string, found: string, argv: string[]): void {
    const mode = ctx.fileSystem.statPath(found)?.mode;
    if (typeof mode !== 'number' || (mode & 0o111) !== 0) return;
    throw Object.assign(new Error(`spawnSync ${file} EACCES`), {
        code: 'EACCES',
        errno: -13,
        syscall: `spawnSync ${file}`,
        path: file,
        spawnargs: argv
    });
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
): SyncRun | Promise<SyncRun> {
    if (file === 'sh' || file === '/bin/sh') {
        const step = runShell(ctx, argv, env, cwd, input, file);
        const done = (r: { status: number | null; signal: string | null; stdout: string; stderr: string }): SyncRun =>
            ({ pid: nextSyncPid++, status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, timedOut: false });
        return step instanceof Promise ? step.then(done) : done(step);
    }
    if (file === 'node' || file === NODE_BINARY) return nodeRun(ctx, nodeInvocation(argv), env, cwd, timeoutMs, killSignal, input);
    if (file.endsWith('.js')) return nodeRun(ctx, { file, args: argv }, env, cwd, timeoutMs, killSignal, input);
    if (file === 'npm' || file === 'npx') {
        const shell: SyncShell = { ctx, cwd, env, input, lastStatus: 0 };
        // `npm install` is the one command here that can suspend the guest instead of refusing
        const install = file === 'npm' ? npmInstallStep(shell, argv) : undefined;
        if (install !== undefined) {
            return install.then(syncStep);
        }
        return syncStep(npmCommand(shell, argv));
    }
    // `spawnSync('curl', ['--version'])`, `execFileSync('ls', ['-l'])` and every other name the
    // container's own synchronous shell can run: one dispatch for all three synchronous calls, the
    // way all three look up one PATH on a host. A name the shell has no command for stays a failed
    // spawn, as it stays one on a host.
    if (SHELL_BUILTINS.has(file) || SHELL_BUILTIN_NAMES.has(file) || SHELL_EXTERNALS.has(file)
        || isUnsupported(file) || SHELL_MODULE_COMMANDS[file] !== undefined) {
        const step = shellCommand({ ctx, cwd, env, input, lastStatus: 0 }, [file, ...argv]);
        return syncStep(step);
    }
    /* Nothing claims the name, so it is looked for on PATH, the way a host looks for it, and runs
       through the interpreter its name or its shebang names: that is what makes
       `spawnSync('cowsay')` run the shim a package left in node_modules/.bin instead of failing with
       ENOENT while `require('cowsay')` out of the same tree works. */
    const shell: SyncShell = { ctx, cwd, env, input, name: file, lastStatus: 0 };
    const found = resolveOnPath(shell, file);
    /* A file with no execute bit is one a host's execve refuses: `spawnSync('./x.sh')` on a 0644
       script reports EACCES there, and ran the script here -- the container took the shebang as
       enough. The bit is what the kernel reads, so it is what is read here. */
    if (found !== undefined) refuseWithoutExecuteBit(ctx, file, found, argv);
    const step = found === undefined ? undefined : runFileCommand(shell, found, argv, file);
    if (step !== undefined) return syncStep(step);
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
    let run: SyncRun | Promise<SyncRun>;
    try {
        run = runSyncCommand(ctx, file, argv, env, cwd, 0, 'SIGTERM', null);
    } catch (error) {
        if (isNotSupported(error)) throw error;
        throw spawnFailure(error, file, argv);
    }
    /* A synchronous child's own wasm call sits inside the one that spawned it, so nothing here can
       suspend: `npmInstallStep` answers undefined in that case, which is what keeps this a run. */
    if (run instanceof Promise) throw notSupportedNested(`the child ${file}`);
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
const spawnSyncChild: CapabilityHandler = (args, ctx): SyncOutcome | Promise<SyncOutcome> => {
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

    /** What the call reports for a run that is finished, whether it finished now or after a suspend. */
    const report = (run: SyncRun): SyncOutcome => {
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

    let run: SyncRun | Promise<SyncRun>;
    try {
        run = runSyncCommand(ctx, file, argv, env, cwd, timeoutMs, killSignal, input);
    } catch (error) {
        if (isNotSupported(error)) {
            return { pid: nextSyncPid++, spawned: true, status: null, signal: null, stdout: null, stderr: null, error: syncSpawnError(error, file, argv) };
        }
        return { pid: 0, spawned: false, status: null, signal: null, stdout: null, stderr: null, error: syncSpawnError(error, file, argv) };
    }
    /* A run that came back as a promise suspended the guest: the install is under way and this is
       answered the moment it is, still inside the statement that asked for it. */
    return run instanceof Promise ? run.then(report) : report(run);
};

export const CHILD_CAPABILITIES: Record<string, CapabilityHandler> = {
    'child.spawn': spawnChild,
    'child.kill': killChild,
    'child.stdin': stdinWrite,
    'child.stdinEnd': stdinEnd,
    'child.reservePid': reservePid,
    'child.ipcAttach': ipcAttach,
    'child.sendToParent': sendToParent,
    'child.sendToChild': sendToChild,
    'child.disconnectChild': disconnectChild,
    'child.disconnectSelf': disconnectSelf,
    'child.parentExit': parentExit,
    'child.spawnSync': spawnSyncChild
};
