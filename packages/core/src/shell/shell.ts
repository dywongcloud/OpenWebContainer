import { IFileSystem } from '../filesystem';
import JSZip from 'jszip';
import { IShell, ShellCommandResult, CommandParsedResult } from './types';
import { CommandRegistry } from './commands/registry';
import { CurlCommand } from './commands/curl';
import { UnzipCommand } from './commands/unzip';
import { WgetCommand } from './commands/wget';
import { Process } from '../process';
import { COMMANDS as TEXT_UTILS } from './commands/textutils';
import { COMMANDS as FILE_UTILS, readable, setCreationMode, setUmask } from './commands/fileutils';
import { COMMANDS as ARCHIVES } from './commands/archives';
import { COMMANDS as PROC_INFO } from './commands/procinfo';
import {
    COMMANDS as UNSUPPORTED_UTILS,
    UNSUPPORTED_COMMANDS,
    isUnsupported,
    unsupportedResult
} from './commands/unsupported';
import {
    COMMANDS as SHELL_BUILTIN_UTILS,
    createShellState,
    formatJobText,
    getRunner,
    runPendingJobs,
    runScript,
    setRunner
} from './commands/builtins';
import type { ShellJob, ShellState } from './commands/builtins';
import type { CommandContext, CommandResult, ShellCommand } from './commands/types';
import type { NetworkHandle } from './commands/types';

interface ShellOptions {
    oscMode?: boolean;
    process: Process;
    env?: Map<string, string>;
    /** The directory the shell starts in: the cwd of the process it runs in. */
    cwd?: string;
    /** A read of the container's virtual network, for the commands that list what it holds. */
    network?: NetworkHandle;
    /**
     * True for a shell that reads its lines from a terminal rather than from the one string `sh -c`
     * was given: such a shell has job control, and prints what a shell with job control prints.
     */
    interactive?: boolean;
}

/**
 * Every command the modules under shell/commands provide, merged once at load. The order is the
 * order the modules are tried, the same order the other half of the container builds its own table
 * in: a name the container cannot have at all is last, so the reason in `UNSUPPORTED` wins.
 */
const MODULE_COMMANDS: Record<string, ShellCommand> = {
    ...TEXT_UTILS,
    ...FILE_UTILS,
    ...ARCHIVES,
    ...PROC_INFO,
    ...SHELL_BUILTIN_UTILS,
    ...UNSUPPORTED_UTILS,
    ...UNSUPPORTED_COMMANDS
};

/** The names builtins.ts implements, so their one state-carrying entry point is used. */
const BUILTIN_NAMES: Set<string> = new Set(Object.keys(SHELL_BUILTIN_UTILS));

/**
 * The commands this shell implements itself, as the container's other shell does: they carry no
 * state of their own and are the only ones `cd` can move the directory of.
 */
const SHELL_BUILTINS = new Set([
    'echo', 'cat', 'pwd', 'ls', 'mkdir', 'rm', 'rmdir', 'touch', 'cd', 'cp', 'mv', 'true', 'false'
]);

/** Commands this shell can only reach by spawning a child, so a script engine cannot run them. */
const SPAWNED_COMMANDS = new Set(['node', 'npm', 'npx']);

/** Quotes one word so the shell engine reads it back as exactly that word. */
function quoteWord(word: string): string {
    return `'${word.split("'").join(`'\\''`)}'`;
}

/** True when a character outside any quoting makes the line more than one simple command. */
function isCompoundLine(line: string): boolean {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote !== null) {
            if (ch === '\\' && quote === '"') i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '\\') { i++; continue; }
        if ('|&;<>'.includes(ch)) return true;
        if (ch === '`') return true;
        if (ch === '$' && line[i + 1] === '(') return true;
    }
    return false;
}

export class Shell implements IShell {
    private fileSystem: IFileSystem;
    private currentDirectory: string;
    private env: Map<string, string>;
    private commandHistory: string[] = [];
    private historyIndex: number = -1;
    private oscMode: boolean = false;
    private buildInCommands: Map<string, (args: string[]) => Promise<ShellCommandResult>> = new Map();
    private commandRegistry: CommandRegistry;
    private process: Process;

    /**
     * The state the script engine keeps between lines: variables, functions, aliases, the directory
     * stack and the working directory. One state for the life of the shell, so a line a caller feeds
     * it sees what the line before it left, exactly as /bin/sh does.
     */
    private shellState: ShellState;
    /** The file system the module commands read and write through. */
    private moduleFs: IFileSystem;
    /** A read of the container's virtual network, handed to every command that asks for one. */
    private network: NetworkHandle | undefined;
    /** What `history` prints; the shell process owns the list and installs this. */
    private historySink: (() => ShellCommandResult) | undefined;
    /** Set by `exit`: no later command of the line runs, and the shell process stops. */
    stopped: boolean = false;
    /** The status `exit` left, for the commands of the line after it. */
    stoppedCode: number = 0;
    /** `$?` of the last line, as the expansions of the next one see it. */
    lastStatus: number = 0;
    /**
     * True once `set -e` has ended a line: the shell process stops, as /bin/sh does. A line handed
     * to `sh -c` ends anyway, so only an interactive shell reads this.
     */
    errexitStopped: boolean = false;
    /** True for a shell that reads lines from a terminal, and so has job control. */
    private interactive: boolean = false;
    /**
     * The background jobs `&` started, in the order it started them. `state.jobs` reads this one
     * table out of `state.host`, so `jobs`, `wait`, `fg` and `%1` here name the very jobs the
     * engine's `&` registered.
     */
    readonly jobs: ShellJob[] = [];
    /** Pids of background jobs, counted apart from the container's own processes. */
    private nextBackgroundPid = 62000;

    constructor(fileSystem: IFileSystem, options: ShellOptions) {
        this.fileSystem = fileSystem;
        this.currentDirectory = options.cwd || '/';
        this.env = options.env || new Map([
            ['PATH', '/bin:/usr/bin'],
            ['HOME', '/home'],
            ['PWD', this.currentDirectory],
        ]);
        this.process = options.process;
        this.oscMode = options.oscMode || false;
        this.network = options.network;
        this.commandRegistry = new CommandRegistry();
        this.moduleFs = this.fsForModules();
        /* `$$` is the pid of this shell's own process, so the state is built with it: a state with
           the default 1 would answer `$$` with 1 in every shell the container runs. */
        this.shellState = createShellState(
            Object.fromEntries(this.env),
            this.currentDirectory,
            this.moduleFs,
            this.process.pid
        );
        this.shellState.shellName = 'sh';
        this.shellState.host = this;
        /* An interactive shell has job control -- `fg` can resume a job and `&` announces one --
           and `sh -c <line>` has none: it has no terminal to hand to a job, which is why bash
           answers `fg` there with `no job control` whatever jobs the line started. */
        this.interactive = options.interactive === true;
        this.shellState.options.interactive = this.interactive;
        this.shellState.options.monitor = this.interactive;
        this.shellState.startJob = this.startBackgroundJob;
        this.registerAllBuiltInCommands()
        this.registerAllExternalCommands();
    }

    /**
     * `cmd &`: the job is registered and nothing runs where it stands, on a host that runs one
     * command at a time. It runs when `wait` asks for it, when `fg` or `%1` brings it to the
     * foreground, or once the line's own commands are through -- and `$!` is its pid from the
     * moment it is registered, which is what the engine sets from the job this hands back.
     *
     * An interactive shell announces it the way bash does, `[1] 12345`. A line handed to `sh -c`
     * gets no such line, as it gets none from /bin/sh.
     */
    private readonly startBackgroundJob = (state: ShellState, source: string): ShellJob => {
        const id = this.jobs.reduce((high, job) => Math.max(high, job.id), 0) + 1;
        const job: ShellJob = {
            id,
            pid: this.nextBackgroundPid++,
            text: formatJobText(source),
            done: false,
            exitCode: 0
        };
        this.jobs.push(job);
        if (this.interactive) state.io.stdout += `[${job.id}] ${job.pid}\n`;
        return job;
    };
    private registerBuiltInCommand(name: string, command: (args: string[]) => Promise<ShellCommandResult>) {
        this.buildInCommands.set(name, command);
    }
    private registerExternalCommand(name: string, commandClass: any) {
        this.commandRegistry.register(name, commandClass);
    }
    private registerAllBuiltInCommands() {
        this.registerBuiltInCommand('cd', this.cd.bind(this));
        this.registerBuiltInCommand('ls', this.ls.bind(this));
        this.registerBuiltInCommand('pwd', this.pwd.bind(this));
        this.registerBuiltInCommand('cat', this.cat.bind(this));
        this.registerBuiltInCommand('echo', this.echo.bind(this));
        this.registerBuiltInCommand('mkdir', this.mkdir.bind(this));
        this.registerBuiltInCommand('rm', this.rm.bind(this));
        this.registerBuiltInCommand('rmdir', this.rmdir.bind(this));
        this.registerBuiltInCommand('touch', this.touch.bind(this));
    }
    private registerAllExternalCommands() {
        this.registerExternalCommand('curl', CurlCommand);
        this.registerExternalCommand('unzip', UnzipCommand);
        this.registerExternalCommand('wget', WgetCommand);
    }

    /**
     * The file system a module command reads and writes through.
     *
     * The container's own `resolvePath` answers a relative path from the file system root rather than
     * from the base it is given, so the view handed to the modules joins against the shell's
     * directory, as `CommandContext` describes. Every other method is the container's own untouched.
     */
    private fsForModules(): IFileSystem {
        const fs = this.fileSystem;
        const cwdOf = (): string => this.shellState.cwd;
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

    /** The context a module command is called with: the shell's directory, environment and input. */
    private moduleContext(args: string[], input: string | null): CommandContext {
        /* The mask `umask` last set, handed to the utilities that name a mode of their own: `umask
           077; touch f1` has to leave `-rw-------`, and the file utilities see the shell state
           only through this context. */
        setUmask(this.moduleFs, this.shellState.umask);
        return {
            args,
            cwd: this.shellState.cwd,
            env: this.shellState.env,
            input,
            fs: this.moduleFs,
            network: this.network
        };
    }

    /** A path argument against the shell's directory: absolute paths stay, relative ones join. */
    private at(path: string): string {
        if (path.startsWith('/')) return path;
        return `${this.shellState.cwd}/${path}`.replace(/\/+/g, '/');
    }

    /** Installs what `history` prints. The shell process owns the list and keeps it between lines. */
    setHistorySink(sink: () => ShellCommandResult): void {
        this.historySink = sink;
    }

    private formatOscOutput(type: string, content: string): string {
        if (!this.oscMode) return content;

        switch (type) {
            case 'file':
                return `\x1b[34m${content}\x1b[0m`;
            case 'directory':
                return `\x1b[1;34m${content}/\x1b[0m`;
            case 'executable':
                return `\x1b[32m${content}*\x1b[0m`;
            case 'error':
                return `\x1b[31m${content}\x1b[0m`;
            case 'success':
                return `\x1b[32m${content}\x1b[0m`;
            case 'info':
                return `\x1b[90m${content}\x1b[0m`;
            case 'warning':
                return `\x1b[33m${content}\x1b[0m`;
            case 'path':
                return `\x1b[36m${content}\x1b[0m`;
            case 'command':
                return `\x1b[1;35m${content}\x1b[0m`;
            default:
                return content;
        }
    }

    private getFileType(path: string): string {
        try {
            if (this.fileSystem.isDirectory(path)) {
                return 'directory';
            }
            if (path.endsWith('.js')) {
                return 'executable';
            }
            return 'file';
        } catch {
            return 'file';
        }
    }

    private success(stdout: string = '', type: string = 'success'): ShellCommandResult {
        return {
            stdout: this.oscMode ? this.formatOscOutput(type, stdout) : stdout,
            stderr: '',
            exitCode: 0
        };
    }

    private failure(stderr: string): ShellCommandResult {
        return {
            stdout: '',
            stderr: this.oscMode ? this.formatOscOutput('error', stderr) : stderr,
            exitCode: 1
        };
    }

    private formatCommandOutput(command: string, output: string): string {
        if (!this.oscMode) return output;

        // Format specific command outputs
        switch (command) {
            case 'ls':
                return output.split('\n').map(entry => {
                    if (!entry.trim()) return entry;
                    const type = this.getFileType(this.resolvePath(entry));
                    return this.formatOscOutput(type, entry);
                }).join('\n');

            case 'pwd':
                return this.formatOscOutput('path', output);

            case 'echo':
                return this.formatOscOutput('info', output);

            case 'cat':
                // Attempt to detect and color code content
                if (output.startsWith('{') || output.startsWith('[')) {
                    try {
                        JSON.parse(output);
                        return this.formatOscOutput('info', output);
                    } catch { }
                }
                return output;

            case 'mkdir':
            case 'touch':
            case 'rm':
            case 'rmdir':
            case 'cp':
            case 'mv':
                return this.formatOscOutput('success', output);

            default:
                return output;
        }
    }

    // Add these new methods for history management
    getNextCommand(): string {
        if (this.historyIndex < this.commandHistory.length - 1) {
            this.historyIndex++;
            return this.commandHistory[this.historyIndex];
        }
        this.historyIndex = this.commandHistory.length;
        return '';
    }

    getPreviousCommand(): string {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            return this.commandHistory[this.historyIndex];
        } else if (this.historyIndex === 0) {
            return this.commandHistory[0];
        }
        return '';
    }

    getCurrentHistoryIndex(): number {
        return this.historyIndex;
    }

    getHistoryLength(): number {
        return this.commandHistory.length;
    }
    getWorkingDirectory(): string {
        return this.shellState.cwd;
    }

    setWorkingDirectory(path: string): void {
        const resolvedPath = this.at(path);
        if (!this.fileSystem.isDirectory(resolvedPath)) {
            throw new Error(`Directory not found: ${path}`);
        }
        this.currentDirectory = resolvedPath;
        this.shellState.cwd = resolvedPath;
        this.env.set('PWD', resolvedPath);
        this.shellState.scopes[0].set('PWD', { value: resolvedPath, export: true });
    }
    hasCommand(command: string): boolean {
        return SHELL_BUILTINS.has(command)
            || BUILTIN_NAMES.has(command)
            || MODULE_COMMANDS[command] !== undefined
            || this.commandRegistry.has(command);
    }

    /** True when the command is one this shell can only reach by spawning a child. */
    isSpawnedCommand(command: string): boolean {
        return SPAWNED_COMMANDS.has(command);
    }

    /** True when the command is one of the external commands registered in the registry. */
    hasExternalCommand(command: string): boolean {
        return this.commandRegistry.has(command);
    }

    /** True when a line is more than one simple command: the script engine runs those. */
    isCompound(line: string): boolean {
        return isCompoundLine(line);
    }

    /**
     * Runs one of the external commands of the registry (`curl`, `unzip`, `wget`). They are
     * asynchronous, so a caller that meets one on its own line runs it through here.
     */
    async executeExternal(command: string, args: string[]): Promise<ShellCommandResult> {
        const commandClass = this.commandRegistry.get(command)!;
        const commandObject = new commandClass({
            cwd: this.getWorkingDirectory(),
            fileSystem: this.fileSystem,
            env: this.env,
            process: this.process
        });
        return await commandObject.execute(args);
    }

    private resolvePath(path: string): string {
        return this.at(path);
    }

    private parseCommand(args: string[]): CommandParsedResult {
        const result: CommandParsedResult = {
            command: '',
            args: [],
            redirects: []
        };

        let i = 0;
        while (i < args.length) {
            const arg = args[i];

            if (arg === '>' || arg === '>>') {
                if (i + 1 >= args.length) {
                    throw new Error(`Syntax error: missing file for redirection ${arg}`);
                }
                result.redirects.push({
                    type: arg as ('>' | '>>'),
                    file: args[i + 1]
                });
                i += 2;
            } else {
                if (!result.command) {
                    result.command = arg;
                } else {
                    result.args.push(arg);
                }
                i++;
            }
        }

        return result;
    }

    private handleRedirection(output: string, redirects: CommandParsedResult['redirects']): void {
        for (const redirect of redirects) {
            const filePath = this.resolvePath(redirect.file);

            try {
                if (redirect.type === '>>') {
                    // Append to file
                    const existingContent = this.fileSystem.readFile(filePath) || '';
                    this.fileSystem.writeFile(filePath, existingContent + output);
                } else {
                    // Overwrite file
                    this.fileSystem.writeFile(filePath, output);
                }
            } catch (error: any) {
                throw new Error(`Failed to redirect to ${redirect.file}: ${error.message}`);
            }
        }
    }

    /**
     * One line, run by the same script engine the container's other shell uses: operators, pipes,
     * redirections, expansions, quoting, the utilities and the built-ins. The state the engine keeps
     * is this shell's own, so variables, functions, aliases and the working directory survive the
     * line and are what the next line sees.
     *
     * `input` is what the line reads on its standard input: the text a pipeline to its left wrote.
     * The engine takes it out of the buffer `read`, `mapfile` and every command that reads stdin in
     * one go -- `cat`, `wc`, `head` -- read, and the line leaves that buffer as it found it.
     */
    executeLine(line: string, input?: string | null): ShellCommandResult {
        const state = this.shellState;
        const previous = getRunner();
        const savedBuffer = state.inputBuffer;
        const savedCursor = state.inputCursor;
        if (input !== undefined && input !== null) {
            state.inputBuffer = input;
            state.inputCursor = 0;
        }
        setRunner(this.runSimpleCommand);
        try {
            const run = runScript(state, line);
            this.lastStatus = run.exitCode;
            this.syncFromState();
            /* A job the line started and never waited for runs once the line's own commands are
               through, as it does in a shell: `echo one & jobs` prints the job, and then `one`.
               Only a line that ends the shell -- the one string `sh -c` was given -- has a "through"
               to run them in: an interactive shell leaves a job in its table until `wait`, `fg`
               or `%1` asks for it, which is what keeps `sleep 5 &` from blocking the terminal and
               what lets `jobs` list it on the next line. */
            const flushed = this.interactive
                ? { stdout: '', stderr: '', exitCode: 0 }
                : runPendingJobs(state);
            /* `exit` ended the line, and the shell with it: the status it left is the shell's, and
               the process reads `stopped` to stop. `sh -c` ends anyway; only the loop that reads
               lines from a terminal needs it, and `exit` inside `( )` or a job never sets it --
               those put the flag back with the rest of the state they restore. */
            if (state.exitCalled === true) {
                state.exitCalled = false;
                this.stopped = true;
                this.stoppedCode = run.exitCode;
            }
            /* `set -e` ended the line: the shell stops with the status of the command that failed,
               the way /bin/sh does -- typed into it, not only handed to it with `-c`. */
            this.errexitStopped = state.options.errexit && run.exitCode !== 0 && !this.stopped;
            let result: ShellCommandResult = {
                stdout: run.stdout + flushed.stdout,
                stderr: run.stderr + flushed.stderr,
                exitCode: run.exitCode
            };
            if (this.oscMode) {
                if (result.stdout) result.stdout = this.formatCommandOutput(this.headOf(line), result.stdout);
                if (result.stderr) result.stderr = this.formatOscOutput('error', result.stderr);
            }
            return result;
        } finally {
            state.inputBuffer = savedBuffer;
            state.inputCursor = savedCursor;
            setRunner(previous);
        }
    }

    /** The first word of a line, for the one OSC decoration that is chosen by command name. */
    private headOf(line: string): string {
        const match = /^\s*([^\s|&;<>$`'"]+)/.exec(line);
        return match === null ? '' : match[1];
    }

    /** Carries what the engine changed -- the directory and the exported variables -- back to the process. */
    private syncFromState(): void {
        this.currentDirectory = this.shellState.cwd;
        const exported = this.shellState.env;
        for (const name of [...this.env.keys()]) if (!(name in exported)) this.env.delete(name);
        for (const name of Object.keys(exported)) this.env.set(name, exported[name]);
    }

    /**
     * The status a child process left, told to the engine so the rest of the line reads it: a child
     * is spawned beside the engine, never through it, so `node -e 'process.exit(3)'; echo $?` would
     * print 0 without this -- the engine's own `$?` is still the one the line before it left.
     */
    noteChildStatus(code: number): void {
        this.lastStatus = code;
        this.shellState.lastStatus = code;
    }

    /**
     * One command the script engine does not implement itself. The dispatch is the container's other
     * shell's, in the same order: this shell's own built-ins, then a command only a child can run,
     * then a name found on PATH or behind a shebang, then a utility the container cannot have, then
     * a utility a module provides, and `Command not found` with 127 last.
     */
    private readonly runSimpleCommand = (state: ShellState, words: string[], input: string | null): CommandResult => {
        const command = words[0] ?? '';
        const args = words.slice(1);

        // `exit` ended the line: nothing after it runs, whatever operator joins it
        if (this.stopped) return { stdout: '', stderr: '', exitCode: this.stoppedCode };
        if (command === '') return { stdout: '', stderr: '', exitCode: 0 };

        if (command === 'exit') {
            const status = Number.parseInt(args[0] ?? '0', 10);
            this.stopped = true;
            this.stoppedCode = Number.isNaN(status) ? 0 : status;
            return { stdout: '', stderr: '', exitCode: this.stoppedCode };
        }
        if (command === 'history') {
            return this.historySink === undefined ? { stdout: '', stderr: '', exitCode: 0 } : this.historySink();
        }

        if (SHELL_BUILTINS.has(command)) return this.runShellBuiltin(command, args, input);

        // A name only a child can run: the shell process reaches it on a line of its own, where the
        // caller can await it. Inside a pipeline or a compound command there is no way to wait, and
        // saying so is better than a status with nothing beside it.
        if (SPAWNED_COMMANDS.has(command)) {
            return this.cannotRun(command, 'it can only be run on a line of its own, where the shell can wait for it');
        }
        if (this.commandRegistry.has(command)) {
            return this.cannotRun(command, 'it needs the network, so the shell can only run it on a line of its own');
        }

        const found = this.lookupOnPath(state, command);
        if (found !== undefined) {
            return this.cannotRun(command, `it is the file ${found}, which only a child can run`);
        }
        if (this.hasShebang(command)) {
            return this.cannotRun(command, `it is a script, which only a child can run`);
        }

        // A utility the container cannot have reports the reason it cannot, with status 1: never 127.
        if (isUnsupported(command)) return unsupportedResult(command);

        const handler = MODULE_COMMANDS[command];
        if (handler !== undefined) {
            try {
                return handler(this.moduleContext(args, input));
            } catch (error: any) {
                return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
            }
        }

        return { stdout: '', stderr: `Command not found: ${command}`, exitCode: 127 };
    };

    /** The status and message of a command this shell cannot run inside the script engine. */
    private cannotRun(command: string, reason: string): CommandResult {
        return { stdout: '', stderr: `${command}: cannot run here: ${reason}`, exitCode: 127 };
    }

    /** The file PATH names for `command`, as the container's other shell looks it up. */
    private lookupOnPath(state: ShellState, command: string): string | undefined {
        const PATH = BUILTIN_NAMES.has(command) ? undefined : this.shellState.env.PATH;
        if (!PATH) return undefined;
        for (const dir of PATH.split(':')) {
            /* the name is joined against the directory: fs.resolvePath answers a relative name from
               the file system root, never from the base it is given */
            const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
            const found = this.fileSystem.normalizePath(`${base}/${command}`);
            if (this.fileSystem.fileExists(found)) return found;
        }
        return undefined;
    }

    /** True when `command` names a file that starts with a shebang. */
    private hasShebang(command: string): boolean {
        let content: string | undefined;
        try {
            content = this.fileSystem.readFile(this.at(command));
        } catch {
            content = undefined;
        }
        return content !== undefined && /^#!/.test(content);
    }

    /**
     * This shell's own built-ins, with the output and status the container's other shell gives them.
     * `cd` moves the engine's directory, so the next command of the line -- and the next line the
     * caller feeds -- runs there.
     */
    private runShellBuiltin(command: string, args: string[], input: string | null): CommandResult {
        const fs = this.fileSystem;
        const at = (path: string): string => this.at(path);
        /* The mask `umask` last set, for the same reason `moduleContext` hands it over: `mkdir` is
           one of this shell's own built-ins and never sees a context, so it would otherwise give a
           directory the mask the shell started with rather than the one the line before set. */
        setUmask(this.moduleFs, this.shellState.umask);
        const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', exitCode: 0 });
        const fail = (stderr: string): CommandResult => ({ stdout: '', stderr, exitCode: 1 });
        try {
            switch (command) {
                case 'echo':
                    return ok(args.join(' ') + '\n');
                case 'true':
                    return ok();
                case 'false':
                    return fail('');
                case 'cat': {
                    // no argument reads the standard input, as it does in a shell
                    if (args.length === 0) return ok(input ?? '');
                    let joined = '';
                    for (const name of args) {
                        /* The mode `chmod` set is honoured here: a file whose owner cannot read it
                           is not read, with the message and status the host's `cat` gives, rather
                           than printed as if the mode meant nothing. */
                        if (!readable(this.moduleFs, at(name))) return fail(`cat: ${name}: Permission denied\n`);
                        const content = fs.readFile(at(name));
                        if (content === undefined) return fail(`File not found: ${name}`);
                        joined += content;
                    }
                    return ok(joined);
                }
                case 'pwd':
                    return ok(this.shellState.cwd + '\n');
                case 'ls':
                case 'touch':
                    /* The file utilities own these two: `ls -l` and `ls -a` read the mode and owner
                       of a name, and `touch a b c` has to reach every operand, neither of which a
                       built-in that only lists names and writes the first one could do. */
                    return (FILE_UTILS[command] as ShellCommand)(this.moduleContext(args, input));
                case 'mkdir': {
                    if (args.length === 0) return fail('No directory specified');
                    const recursive = args.includes('-p');
                    const paths = args.filter((arg) => !arg.startsWith('-'));
                    if (paths.length === 0) return fail('No directory specified');
                    /* A directory this shell creates carries the mode the umask leaves, which is
                       what `umask 077; mkdir d1` leaves on a host: `drwx------`. */
                    if (recursive) {
                        for (const path of paths) this.createDirectoryTree(at(path));
                    } else {
                        for (const path of paths) {
                            fs.createDirectory(at(path));
                            /* The file utilities keep their side table against the file system they
                               are handed, which is `moduleFs` and not the one this arm writes
                               through, so the mode has to be recorded there or `ls -l` cannot
                               see it. */
                            setCreationMode(this.moduleFs, at(path), true);
                        }
                    }
                    return ok();
                }
                case 'rm': {
                    /* `-rf`, `-fr`, `-f -r` and the long forms are all the same two flags: the
                       letters of one word are read one at a time, the way rm reads them. */
                    let force = false;
                    let recursive = false;
                    for (const arg of args) {
                        if (!arg.startsWith('-') || arg === '-') continue;
                        for (const ch of arg.slice(1)) {
                            if (ch === 'f') force = true;
                            else if (ch === 'r' || ch === 'R') recursive = true;
                        }
                    }
                    const paths = args.filter((arg) => !arg.startsWith('-') || arg === '-');
                    /* No operand at all is a usage error and not a missing file, with the status a
                       host gives for one -- 64, which `echo $?` reads where a plain failure reads
                       1. `-f` is the one flag that swallows it: `rm -f` names nothing and says
                       nothing, which is 0 on both sides. */
                    if (paths.length === 0) {
                        if (force) return ok();
                        return {
                            stdout: '',
                            stderr: 'usage: rm [-f | -i] [-dIPRrvWx] file ...\n       unlink [--] file\n',
                            exitCode: 64
                        };
                    }
                    let stderr = '';
                    let failed = false;
                    for (const file of paths) {
                        const target = at(file);
                        /* `-f` is exactly what it promises: a path that is not there is not an error,
                           and the operand behind it is reached with the status the line had -- `rm -f
                           a b` with only `a` missing is 0, as it is on a host. Nothing else is
                           forgiven: a directory without `-r`, and a missing path without `-f`. */
                        if (!this.fileExistsSafe(target)) {
                            if (force) continue;
                            stderr += `rm: ${file}: No such file or directory\n`;
                            failed = true;
                            continue;
                        }
                        if (!recursive && this.isDirectorySafe(target)) {
                            stderr += `rm: ${file}: is a directory\n`;
                            failed = true;
                            continue;
                        }
                        fs.deleteFile(target, recursive);
                    }
                    return failed ? { stdout: '', stderr, exitCode: 1 } : ok();
                }
                case 'rmdir':
                    if (args.length === 0) return fail('No directory specified');
                    fs.deleteDirectory(at(args[0]));
                    return ok();
                case 'cd': {
                    const target = args[0] || '/';
                    const next = at(target);
                    if (!fs.isDirectory(next)) return fail(`Directory not found: ${target}`);
                    this.shellState.cwd = next;
                    this.currentDirectory = next;
                    this.env.set('PWD', next);
                    this.shellState.scopes[0].set('PWD', { value: next, export: true });
                    return ok();
                }
                case 'cp':
                    return this.copyCommand(args);
                case 'mv':
                    return this.moveCommand(args);
                default:
                    return fail(`Command not found: ${command}`);
            }
        } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
        }
    }

    /** The names `ls` prints for one directory: sorted, and without the dot files, as a shell has it. */
    private lsNames(path: string): string[] {
        return this.fileSystem.listDirectory(path).filter((name) => !name.startsWith('.')).sort();
    }

    /** `mkdir -p`: the directory and every directory above it. */
    private createDirectoryTree(path: string): void {
        const parts = path.split('/').filter((part) => part !== '');
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            if (this.isDirectorySafe(current)) continue;
            this.fileSystem.createDirectory(current);
            setCreationMode(this.moduleFs, current, true);
        }
    }

    /** `isDirectory` as a question: a path that is not there is not a directory. */
    private isDirectorySafe(path: string): boolean {
        try {
            return this.fileSystem.isDirectory(path);
        } catch {
            return false;
        }
    }

    /** `fileExists` as a question: a path `ls` cannot stat is not there. */
    private fileExistsSafe(path: string): boolean {
        try {
            return this.fileSystem.fileExists(path);
        } catch {
            return false;
        }
    }

    // Modified execute method to include history
    async execute(command: string, args: string[]): Promise<ShellCommandResult> {
        try {
            if (!command) {
                return this.success();
            }
            this.commandHistory.push(command);

            // Parse command and redirections
            const parsedCommand = this.parseCommand([command, ...args]);

            // Execute the actual command
            const result = await this.executeCommand(
                parsedCommand.command,
                parsedCommand.args
            );


            // Handle redirections
            if (result.exitCode === 0 && parsedCommand.redirects.length > 0) {
                try {
                    this.handleRedirection(result.stdout, parsedCommand.redirects);
                    result.stdout = '';
                } catch (error: any) {
                    let ret = {
                        stdout: '',
                        stderr: error.message,
                        exitCode: 1
                    };
                    if (this.oscMode && ret.stderr) {
                        ret.stderr = this.formatOscOutput('error', ret.stderr);
                    }
                    return ret;
                }
            }

            // Format output
            if (result.exitCode === 0 && result.stdout) {
                result.stdout = this.formatCommandOutput(command, result.stdout);
            }
            if (this.oscMode && result.stderr) {
                result.stderr = this.formatOscOutput('error', result.stderr);
            }

            return result;
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async executeCommand(command: string, args: string[]): Promise<ShellCommandResult> {
        // check if the command is a built-in command this shell implements itself
        if (SHELL_BUILTINS.has(command)) {
            return this.runShellBuiltin(command, args, null);
        }
        if (BUILTIN_NAMES.has(command) || MODULE_COMMANDS[command] !== undefined) {
            return this.executeLine([command, ...args].map(quoteWord).join(' '));
        }
        if (this.commandRegistry.has(command)) {
            return await this.executeExternal(command, args);
        }
        // check if the command is in env PATH
        let PATH = this.env.get('PATH');
        if (PATH) {
            const paths = PATH.split(':');
            for (const path of paths) {
                const executablePath = this.fileSystem.resolvePath(command, path);
                if (this.fileSystem.fileExists(executablePath)) {
                    return { stdout: '', stderr: `No executor found for: ${executablePath}`, exitCode: 1 };
                }
            }
        }
        // check for shebang
        let content: string | undefined;
        try {
            content = this.fileSystem.readFile(this.at(command));
        } catch {
            content = undefined;
        }
        const shebang = content ? /^#!(.*)/.exec(content) : null;
        if (shebang) {
            const tokens = shebang[1].split(' ');
            if (tokens[0] === '/usr/bin/env') {
                if (tokens.length === 1) return { stdout: '', stderr: '', exitCode: 1 };
                return { stdout: '', stderr: `No executor found for: ${tokens[1]}`, exitCode: 1 };
            }
        }

        // Handle built-in commands as before
        return { stdout: '', stderr: `Command not found: ${command}`, exitCode: 127 };
    }

    private async ls(args: string[]): Promise<ShellCommandResult> {
        try {
            const path = args[0] || this.currentDirectory;
            const resolvedPath = this.resolvePath(path);
            const entries = this.fileSystem.listDirectory(resolvedPath);

            return this.success(entries.join('\n'));
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async cat(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No file specified');
        }
        try {
            const content = this.fileSystem.readFile(this.resolvePath(args[0]));
            if (content === undefined) {
                return this.failure(`File not found: ${args[0]}`);
            }
            return this.success(content);
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async mkdir(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No directory specified');
        }
        try {
            this.fileSystem.createDirectory(this.resolvePath(args[0]));
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async rm(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No file specified');
        }
        try {
            const recursive = args.includes('-r') || args.includes('-rf');
            const files = args.filter(arg => !arg.startsWith('-'));

            for (const file of files) {
                this.fileSystem.deleteFile(this.resolvePath(file), recursive);
            }
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async rmdir(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No directory specified');
        }
        try {
            this.fileSystem.deleteDirectory(this.resolvePath(args[0]));
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async touch(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No file specified');
        }
        try {
            this.fileSystem.writeFile(this.resolvePath(args[0]), '');
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async pwd(): Promise<ShellCommandResult> {
        return this.success(this.currentDirectory);
    }

    private async cd(args: string[]): Promise<ShellCommandResult> {
        try {
            const path = args[0] || '/';
            const newPath = this.resolvePath(path);
            if (!this.fileSystem.isDirectory(newPath)) {
                return this.failure(`Directory not found: ${path}`);
            }
            this.currentDirectory = newPath;
            this.env.set('PWD', newPath);
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async echo(args: string[]): Promise<ShellCommandResult> {
        return this.success(args.join(' ') + '\n');
    }

    /*
     * Both take flags, and both work on directories, which the versions here did not: `cp -r src
     * dst` read '-r' as the name of the source and failed with ENOENT on '/-r', and `mv` of a
     * directory read the directory's bytes -- a directory has none -- and failed with a size
     * mismatch, leaving the source where it was. A move is one rename when it can be; a copy walks
     * the tree and carries each file's bytes, so a binary survives it.
     */
    private parseFileArgs(args: string[]): { operands: string[]; recursive: boolean } {
        const operands: string[] = [];
        let recursive = false;
        for (const arg of args) {
            if (arg !== '-' && arg.startsWith('-') && arg.length > 1) {
                if (/^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg) || arg === '--recursive') recursive = true;
                continue;
            }
            operands.push(arg);
        }
        return { operands, recursive };
    }

    private baseName(path: string): string {
        const parts = path.split('/').filter((part) => part.length > 0);
        return parts.length > 0 ? parts[parts.length - 1] : path;
    }

    /** Where a source lands when it is named against a destination: inside it, if it is a directory. */
    private landingPath(src: string, dest: string): string {
        return this.isDirectorySafe(dest) ? `${dest}/${this.baseName(src)}`.replace(/\/+/g, '/') : dest;
    }

    private copyTree(from: string, to: string): void {
        this.fileSystem.createDirectory(to);
        for (const name of this.fileSystem.listDirectory(from)) {
            const source = `${from}/${name}`.replace(/\/+/g, '/');
            const target = `${to}/${name}`.replace(/\/+/g, '/');
            if (this.isDirectorySafe(source)) {
                this.copyTree(source, target);
                continue;
            }
            const bytes = this.fileSystem.readBytes(source);
            if (bytes !== undefined) this.fileSystem.writeBytes(target, bytes);
        }
    }

    private copyCommand(args: string[]): CommandResult {
        const { operands, recursive } = this.parseFileArgs(args);
        const fail = (stderr: string): CommandResult => ({ stdout: '', stderr, exitCode: 1 });
        if (operands.length < 2) return fail('cp: Source and destination required');
        try {
            const src = this.resolvePath(operands[0]);
            const dest = this.resolvePath(operands[1]);
            if (!this.fileExistsSafe(src)) return fail(`cp: ${operands[0]}: No such file or directory`);
            const to = operands.length > 2 ? dest : this.landingPath(src, dest);
            if (this.isDirectorySafe(src)) {
                if (!recursive) return fail(`cp: -r not specified; omitting directory '${operands[0]}'`);
                this.copyTree(src, to);
                return { stdout: '', stderr: '', exitCode: 0 };
            }
            const bytes = this.fileSystem.readBytes(src);
            if (bytes === undefined) return fail(`cp: ${operands[0]}: No such file or directory`);
            this.fileSystem.writeBytes(to, bytes);
            return { stdout: '', stderr: '', exitCode: 0 };
        } catch (error: any) {
            return fail(error instanceof Error ? error.message : String(error));
        }
    }

    private moveCommand(args: string[]): CommandResult {
        const operands = args.filter((arg) => arg === '-' || !arg.startsWith('-'));
        const fail = (stderr: string): CommandResult => ({ stdout: '', stderr, exitCode: 1 });
        if (operands.length < 2) return fail('mv: Source and destination required');
        try {
            const src = this.resolvePath(operands[0]);
            const dest = this.resolvePath(operands[1]);
            if (!this.fileExistsSafe(src)) return fail(`mv: ${operands[0]}: No such file or directory`);
            const to = operands.length > 2 ? dest : this.landingPath(src, dest);
            this.fileSystem.renamePath(src, to);
            return { stdout: '', stderr: '', exitCode: 0 };
        } catch (error: any) {
            return fail(error instanceof Error ? error.message : String(error));
        }
    }

    private async cp(args: string[]): Promise<ShellCommandResult> {
        return this.copyCommand(args);
    }

    private async mv(args: string[]): Promise<ShellCommandResult> {
        return this.moveCommand(args);
    }
}
