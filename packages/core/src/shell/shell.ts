import { IFileSystem } from '../filesystem';
import type { PathStat } from '../filesystem/types';
import JSZip from 'jszip';
import { IShell, ShellCommandResult, CommandParsedResult } from './types';
import { CommandRegistry } from './commands/registry';
import { CurlCommand } from './commands/curl';
import { UnzipCommand } from './commands/unzip';
import { WgetCommand } from './commands/wget';
import { Process } from '../process';
import { CONTAINER_WORKDIR } from '../process/executors/default-env';
import { COMMANDS as TEXT_UTILS } from './commands/textutils';
import { COMMANDS as FILE_UTILS, readable, recordedExecutable, resolvedThrough, setCreationMode, setMode, setUmask } from './commands/fileutils';
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
    diagnosticPrefix,
    echoWords,
    formatJobText,
    getRunner,
    isIncompleteSource,
    plainPrefix,
    runPendingJobs,
    runScript,
    setRunner,
    setVar
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

/**
 * True when a file's text is a script the shell can read it as: a program's own bytes are not one,
 * and a host's exec of them would have succeeded where reading them as a script cannot.
 */
function isScriptText(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 9 || code === 10 || code === 13) continue;
        if (code < 32 || code === 0xfffd) return false;
    }
    return true;
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
        this.currentDirectory = options.cwd || CONTAINER_WORKDIR;
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
        /* `$0` -- and the prefix of every diagnostic this shell writes -- is the name the shell was
           started under, which is the path a caller named when it named one: a host's `exec`, which
           runs `/bin/sh`, answers `/bin/sh`, where a `spawn('sh', ...)` answers `sh`. Anything the
           process carries no name for is the bare name, as it was when it was written here. */
        this.shellState.shellName = options.process.executablePath || 'sh';
        this.shellState.host = this;
        /* An interactive shell has job control -- `fg` can resume a job and `&` announces one --
           and `sh -c <line>` has none: it has no terminal to hand to a job, which is why bash
           answers `fg` there with `no job control` whatever jobs the line started. */
        this.interactive = options.interactive === true;
        this.shellState.options.interactive = this.interactive;
        this.shellState.options.monitor = this.interactive;
        /* `histexpand` is on in a shell that reads a terminal and off in one a line was handed to
           with `-c`, which is what puts the `H` in a host's `$-` there: `sh -i -c 'echo $-'` is
           `hiBHc` where `sh -c 'echo $-'` is `hBc`. */
        this.shellState.options.histexpand = this.interactive;
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
            /* What the job is run from when `wait` asks for it: the source the `&` was written on,
               with its quoting, which is not what `jobs` prints it as. */
            source,
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
     * True when `source` is a command the input ran out in the middle of, so what is typed next is
     * the rest of it: `for i in 1 2; do`, `if true; then`, `case x in`, `{`, an unclosed quote.
     *
     * A shell reading a terminal does not run such a line and does not report it -- it asks for the
     * rest behind its secondary prompt and runs the whole once the line that closes it arrives --
     * so the loop that reads the terminal tests a line here before it hands it to the engine. A
     * line handed to `sh -c` is never tested: that shell's input is over the moment the line is,
     * and a host reports what it was given rather than waiting for more.
     */
    isIncomplete(source: string): boolean {
        return isIncompleteSource(this.shellState, source);
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
                /* A name a redirection created carries the mode the umask leaves, as it does on the
                   host; one that was already there keeps the mode it had. */
                const existed = this.fileExistsSafe(filePath);
                if (redirect.type === '>>') {
                    // Append to file; a target no file has yet starts empty, as it does on the host
                    let existingContent = '';
                    try { existingContent = this.fileSystem.readFile(filePath) ?? ''; } catch { existingContent = ''; }
                    this.fileSystem.writeFile(filePath, existingContent + output);
                } else {
                    // Overwrite file
                    this.fileSystem.writeFile(filePath, output);
                }
                if (!existed) setCreationMode(this.moduleFs, filePath, false);
            } catch (error: any) {
                /* A target no directory holds is what a host names, not the file system's own text:
                   `echo hi > /nosuch/x` is `sh: /nosuch/x: No such file or directory`. */
                const missing = error?.code === 'ENOENT' || String(error?.message ?? '').startsWith('ENOENT');
                if (missing) throw new Error(`${this.shellState.shellName}: ${redirect.file}: No such file or directory`);
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
        const script = this.runShebangScript(command, args);
        if (script !== undefined) return script;
        if (this.hasShebang(command)) {
            return this.cannotRun(command, `it is a script, which only a child can run`);
        }

        /* `printf -v var` is the one option a host's own `printf` builtin takes that the utility
           on PATH does not, and what it writes goes into the variable rather than to stdout:
           `printf -v x '%d' 5; echo "[$x]"` is a host's `[5]` and no output at all, where handing
           the flag to the utility printed `-v` and left the name empty. The usage a host writes
           for a printf that has nothing to print -- and the status 2 it gives one -- are this
           shell's to write as well, because the utility's own text names no `-v` in it and
           leaves the status 1 a utility's failure has. */
        if (command === 'printf') {
            const usage = 'printf: usage: printf [-v var] format [arguments]\n';
            if (args.length === 0) return { stdout: '', stderr: usage, exitCode: 2 };
            let name: string | undefined;
            let rest: string[] = args;
            if (args[0] === '-v') {
                name = args[1];
                rest = args.slice(2);
                /* A `-v` with no name behind it is the one option a host complains about, and the
                   complaint carries the shell's name and the line it stands on where the usage
                   behind it does not: `printf -v` is `sh: line 0: printf: -v: option requires an
                   argument` and then the usage, with the status 2. */
                if (name === undefined) {
                    return {
                        stdout: '',
                        stderr: `${diagnosticPrefix(this.shellState)}printf: -v: option requires an argument\n${usage}`,
                        exitCode: 2
                    };
                }
            } else if (args[0].startsWith('-v') && args[0].length > 2) {
                name = args[0].slice(2);
                rest = args.slice(1);
            }
            if (name !== undefined) {
                if (rest.length === 0) return { stdout: '', stderr: usage, exitCode: 2 };
                const printed = MODULE_COMMANDS['printf'](this.moduleContext(rest, input));
                if (printed.exitCode !== 0) return printed;
                setVar(this.shellState, name, printed.stdout);
                return { stdout: '', stderr: '', exitCode: 0 };
            }
        }

        // A utility the container cannot have reports the reason it cannot, with status 1: never 127.
        if (isUnsupported(command)) return unsupportedResult(command);

        const handler = MODULE_COMMANDS[command];
        if (handler !== undefined) {
            try {
                const result = handler(this.moduleContext(args, input));
                /* `printf` and `kill` are built-ins of a host's shell and not utilities on PATH,
                   and a built-in's complaint carries the shell's name and the line it stands on:
                   `printf '%d' notanumber` is `sh: line 0: printf: notanumber: invalid number` and
                   `kill -X 1` is `sh: line 0: kill: X: invalid signal specification`, where the
                   utility's own text named no shell at all. */
                if ((command === 'printf' || command === 'kill') && result.exitCode !== 0 && result.stderr !== ''
                    && !/^(usage:|[a-z]+: usage:)/.test(result.stderr)) {
                    return { ...result, stderr: `${diagnosticPrefix(this.shellState)}${result.stderr}` };
                }
                return result;
            } catch (error: any) {
                return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
            }
        }

        /* A path the file system holds but cannot execute is not a name nothing holds, and a host
           says so with a status of 126 rather than 127: `/tmp` is `is a directory`, and a file with
           no execute bit is `Permission denied` -- both were `Command not found` and 127, which is
           the answer for a name no file answers to at all. A bare name is never such a path: only
           one written with a `/` in it is executed as a file rather than looked up on PATH. */
        if (command.includes('/')) {
            let named: PathStat | undefined;
            try { named = this.fileSystem.statPath(this.at(command)); } catch { named = undefined; }
            if (named !== undefined) {
                if (named.type === 'dir') {
                    return { stdout: '', stderr: `${this.shellState.shellName}: ${command}: is a directory\n`, exitCode: 126 };
                }
                /* The bit that makes a file runnable is the one `chmod` recorded, where it recorded
                   one; a file copied in carries no mode with it, so the mode the file system itself
                   reports is the only one there is to go on, and it is read the same way. */
                const executable = recordedExecutable(this.moduleFs, this.at(command));
                const denied = executable === false
                    || (executable === undefined && named.mode !== undefined && (named.mode & 0o111) === 0);
                if (denied) {
                    return { stdout: '', stderr: `${this.shellState.shellName}: ${command}: Permission denied\n`, exitCode: 126 };
                }
                /* A file with the execute bit and no shebang is one a host still runs: its exec is
                   answered ENOEXEC and the shell reads the file as a script of its own, so `echo hi`
                   in a 755 file prints `hi` there. The bytes of a program are no script, so only a
                   file of text is read that way. A copied file carries no mode with it, so nothing
                   is run on that say-so either -- `false` here is not `undefined`. */
                if (executable === true && named.type === 'file') {
                    let text: string | undefined;
                    try { text = this.fileSystem.readFile(this.at(command)); } catch { text = undefined; }
                    if (text !== undefined && isScriptText(text)) return this.runScriptText(command, args, text);
                }
            }
            /* A path no file answers to is not a name nothing answers to, and a host does not say
               `command not found` for it: `/nosuch/dir/cmd` and `./nope` are both `No such file or
               directory` with 127, the status of a command the shell could not run. */
            if (named === undefined) {
                return { stdout: '', stderr: `${plainPrefix(this.shellState)}${command}: No such file or directory\n`, exitCode: 127 };
            }
        }

        /* The message a host writes for a name no built-in, no utility and no file on PATH answers
           to: the shell's name, then the command, then `command not found`, in the order a host
           puts them -- `Command not found: nosuchcmd` had the name in front of the sentence it
           belongs in the middle of. It ends in the newline every diagnostic of a host's ends in,
           which is what the one the script engine fell back on was missing, so the text a line
           wrote after it ran on into it. */
        /* No line on the line a `sh -c` string opens on, `line N` behind it: `nosuchcmd` is
           `sh: nosuchcmd: command not found` there and `sh: line 2: nosuchcmd: command not found`
           on the third line of one. */
        return { stdout: '', stderr: `${plainPrefix(this.shellState)}${command}: command not found\n`, exitCode: 127 };
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

    /**
     * `./script.sh`: a path naming a file whose first line is a shebang is the script it names, and
     * a host runs it -- `sh -c './execok.sh'` prints what the script prints and carries out its
     * status -- where this shell refused it with `cannot run here: it is a script, which only a
     * child can run` and a 127 nothing had asked for.
     *
     * Only an interpreter this engine is can be run here: a script behind `#!/usr/bin/env node`
     * still needs a child, and goes on saying so. A name written with no `/` in it is never one of
     * these either: a bare word is looked up on PATH and in no other directory, so `execok.sh` in
     * the directory the shell stands in is `command not found` on a host however executable the
     * file beside it is.
     *
     * The script is a process of its own, as it is on a host: it starts in this shell's directory
     * with this shell's exported variables, `$0` is the path it was named by and `$1` on the words
     * behind it, and what it does to either one stops with it.
     */
    private runShebangScript(command: string, args: string[]): CommandResult | undefined {
        if (!command.includes('/')) return undefined;
        const path = this.at(command);
        let stat: PathStat | undefined;
        try { stat = this.fileSystem.statPath(path); } catch { stat = undefined; }
        if (stat === undefined || stat.type === 'dir') return undefined;
        /* The mode `chmod` left on the file is what makes it one a host runs: a script without an
           execute bit is `sh: ./s: Permission denied` and 126 there, however well-formed its
           shebang is. A file copied in carries no mode of its own, so nothing is refused on the
           say-so of a mode this file system never held. */
        if (recordedExecutable(this.moduleFs, path) === false) {
            return { stdout: '', stderr: `${this.shellState.shellName}: ${command}: Permission denied\n`, exitCode: 126 };
        }
        let content: string | undefined;
        try { content = this.fileSystem.readFile(path); } catch { content = undefined; }
        if (content === undefined) return undefined;
        const shebang = /^#!(.*)/.exec(content);
        if (shebang === null) return undefined;
        const words = shebang[1].trim().split(/\s+/).filter((word) => word !== '');
        const first = words[0] === '/usr/bin/env' ? words[1] : words[0];
        const interpreter = first === undefined ? '' : first.replace(/^.*\//, '');
        if (interpreter !== 'sh' && interpreter !== 'bash' && interpreter !== 'dash') return undefined;
        /* The shebang's own line is no part of the script: no shell runs it. */
        const end = content.indexOf('\n');
        const body = end === -1 ? '' : content.slice(end + 1);
        return this.runScriptText(command, args, body);
    }

    /**
     * The lines of `body` run as a script of its own: a fresh child state over this shell's
     * directory and exported variables, `$0` the path it was named by and `$1` on the words behind
     * it, and its stdout, stderr and status as the command's.
     */
    private runScriptText(command: string, args: string[], body: string): CommandResult {
        const child = createShellState(Object.fromEntries(this.env), this.shellState.cwd, this.moduleFs, this.process.pid);
        child.shellName = command;
        child.positional = args;
        const run = runScript(child, body);
        return { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode };
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
                    return ok(echoWords(args));
                case 'true':
                    return ok();
                case 'false':
                    return fail('');
                case 'cat': {
                    /* An option is a word of its own and never a name to open: `cat -n` with a
                       standard input to read is the numbered lines, where taking `-n` as a file
                       made it an ENOENT that read nothing at all. `--` ends the options, so a file
                       whose own name starts with a dash is still an operand. */
                    let number = false;
                    let noMoreOptions = false;
                    const operands: string[] = [];
                    for (const arg of args) {
                        if (!noMoreOptions && arg === '--') { noMoreOptions = true; continue; }
                        if (!noMoreOptions && arg.length > 1 && arg.startsWith('-')) {
                            if (arg === '-n') number = true;
                            continue;
                        }
                        operands.push(arg);
                    }
                    /* The lines of one input, numbered from 1 again for every one of them: `cat -n
                       p1 p1` is 1 2 3 and then 1 2 3, which one counter kept over the whole output
                       would have numbered on. The width is the six a host's `cat` writes. */
                    const numbered = (text: string): string => {
                        if (!number || text === '') return text;
                        const lines = text.split('\n');
                        if (lines[lines.length - 1] === '') lines.pop();
                        return lines.map((line, index) => `${String(index + 1).padStart(6, ' ')}\t${line}\n`).join('');
                    };
                    // no argument reads the standard input, as it does in a shell
                    if (operands.length === 0) {
                        /* A directory put on the standard input is the directory to a read of it,
                           and a host's `cat` names it `stdin`: `mkdir d; cat < d` is `cat: stdin:
                           Is a directory` and 1, where the shell had already read the directory
                           into the input and this printed the `{}` that read leaves, with 0. */
                        if (this.shellState.inputIsDirectory === true) {
                            return { stdout: '', stderr: 'cat: stdin: Is a directory\n', exitCode: 1 };
                        }
                        return ok(numbered(input ?? ''));
                    }
                    let joined = '';
                    let errors = '';
                    for (const name of operands) {
                        /* `-` is the standard input, as it is for the host's `cat`: `printf 'x' |
                           cat -` prints `x`, and a name that is no file at all is still an error.
                           `/dev/stdin` and `/dev/fd/0` are that same stream under the names a
                           host's own `/dev` holds it by: `printf x | cat /dev/stdin` prints `x`,
                           where opening the name as a path found no such file in this file system. */
                        if (name === '-' || name === '/dev/stdin' || name === '/dev/fd/0') {
                            joined += numbered(input ?? '');
                            continue;
                        }
                        /* No terminal stands behind a shell whose line was handed to it, which is
                           what opening `/dev/tty` meets there: `cat: /dev/tty: Device not
                           configured` and 1, the same refusal the redirection `> /dev/tty` already
                           gives. The file system holds no `/dev/tty` to open, so it was answered
                           as a path that is not there -- `No such file or directory` -- which is a
                           different failure than the one a host's own open of the name reports. */
                        if (name === '/dev/tty') {
                            errors += `cat: ${name}: Device not configured\n`;
                            continue;
                        }
                        const path = at(name);
                        /* A directory is named and passed over, not read as if it were a file:
                           `mkdir sd; cat sd` is `cat: sd: Is a directory` on a host, with the
                           status 1, where reading it wrote `{}` and left 0. A link to one is that
                           same directory -- `ln -s d l; cat l` says `Is a directory` as `cat d`
                           does -- so the name is asked about the way a read of it would go, which
                           follows the link, and not the way `lstat` names the link itself. The
                           link is resolved through the table `ln` wrote, the one `chmod` and `ls`
                           already read, because this file system's own stat of a link is the link. */
                        const reached = resolvedThrough(this.moduleFs, path);
                        const operand = this.statPathSafe(reached);
                        if (operand?.type === 'dir') {
                            errors += `cat: ${name}: Is a directory\n`;
                            continue;
                        }
                        /* A link whose target nothing holds is a name nothing holds: `ln -s nope l;
                           cat l` is `cat: l: No such file or directory` and 1 on a host, where the
                           read of the link gave the empty string and left 0. Only the link itself
                           is answered here: a name written *through* one -- `cat l/a` -- is still
                           resolved by the read that opens it. */
                        if (operand === undefined && reached !== path) {
                            errors += `cat: ${name}: No such file or directory\n`;
                            continue;
                        }
                        /* The mode `chmod` set is honoured here: a file whose owner cannot read it
                           is not read, with the message and status the host's `cat` gives, rather
                           than printed as if the mode meant nothing. */
                        if (!readable(this.moduleFs, path)) {
                            errors += `cat: ${name}: Permission denied\n`;
                            continue;
                        }
                        let content: string | undefined;
                        try { content = fs.readFile(path); } catch { content = undefined; }
                        /* A name no file answers to is named the way it was written -- never the
                           container's own path for it -- and the operands behind it are still read:
                           `cat nofile p1` is the one diagnostic, then `p1`, then the status 1. */
                        if (content === undefined) {
                            errors += `cat: ${name}: No such file or directory\n`;
                            continue;
                        }
                        joined += numbered(content);
                    }
                    return errors === '' ? ok(joined) : { stdout: joined, stderr: errors, exitCode: 1 };
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
                    /* `-m mode` names the mode outright, and the umask does not mask it: `umask 077;
                       mkdir -m 700 d` leaves 700 on a host, not 700 with 077 taken out of it.
                       The value is either the next word or the rest of this one (`-m700`). */
                    let named: number | undefined;
                    let namedMode: number | undefined;
                    const paths: string[] = [];
                    for (let i = 0; i < args.length; i++) {
                        const arg = args[i];
                        if (named === i) continue;
                        if (arg === '-m') { named = i + 1; namedMode = Number.parseInt(args[i + 1] ?? '', 8); continue; }
                        if (arg.startsWith('-m') && arg.length > 2) { namedMode = Number.parseInt(arg.slice(2), 8); continue; }
                        if (arg.startsWith('-') && arg !== '-') continue;
                        paths.push(arg);
                    }
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
                    /* `-m` overrides what the umask left, and is recorded the same way so `ls -l`
                       and `stat` read it back. */
                    if (namedMode !== undefined && !Number.isNaN(namedMode)) {
                        for (const path of paths) setMode(this.moduleFs, at(path), namedMode);
                    }
                    return ok();
                }
                case 'rm': {
                    /* `-rf`, `-fr`, `-f -r` and the long forms are all the same two flags: the
                       letters of one word are read one at a time, the way rm reads them. */
                    let force = false;
                    let recursive = false;
                    /* `--` ends the options and everything behind it is an operand, so `rm -- -f`
                       removes the file named `-f` and `rm -- --` the one named `--`, which a filter
                       that dropped every word starting with a dash left behind. */
                    let noMoreOptions = false;
                    for (const arg of args) {
                        if (noMoreOptions) continue;
                        if (arg === '--') { noMoreOptions = true; continue; }
                        if (!arg.startsWith('-') || arg === '-') continue;
                        for (const ch of arg.slice(1)) {
                            if (ch === 'f') force = true;
                            else if (ch === 'r' || ch === 'R') recursive = true;
                        }
                    }
                    const afterDash = args.indexOf('--');
                    const guarded = afterDash < 0 ? [] : args.slice(afterDash + 1);
                    const paths = (afterDash < 0
                        ? args.filter((arg) => !arg.startsWith('-') || arg === '-')
                        : guarded);
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
                    /* `-` is the directory the shell came from, and a host names the one it lands
                       on as it changes: `cd /tmp; cd -` prints the directory it went back to and
                       leaves 0, where reading `-` as the name of a directory gave ENOENT on
                       `/tmp/-`. */
                    const back = target === '-';
                    const previous = this.currentDirectory;
                    const wanted = back ? (this.env.get('OLDPWD') ?? previous) : target;
                    const next = at(wanted);
                    if (!this.isDirectorySafe(next)) {
                        /* The reason a host gives is the one the name itself asks for: a path no
                           directory and no file stand behind is `No such file or directory`, and
                           one a file stands behind is `Not a directory` -- `cd /nosuchdir` is the
                           first and `cd f`, `f` being a file, the second. A built-in's complaint
                           carries the shell's name and the line it stands on, which is how the
                           utility's own bare text read here before. */
                        const reason = this.fileExistsSafe(next) ? 'Not a directory' : 'No such file or directory';
                        return fail(`${diagnosticPrefix(this.shellState)}cd: ${target}: ${reason}\n`);
                    }
                    this.shellState.cwd = next;
                    this.currentDirectory = next;
                    this.env.set('OLDPWD', previous);
                    this.env.set('PWD', next);
                    this.shellState.scopes[0].set('PWD', { value: next, export: true });
                    return back ? ok(`${wanted}\n`) : ok();
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

    /** `statPath` as a question: what a read of `path` would reach, so a link is what it names. */
    private statPathSafe(path: string): PathStat | undefined {
        try {
            return this.fileSystem.statPath(path);
        } catch {
            return undefined;
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
        return this.success(echoWords(args));
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
            /* A name this copy created carries the mode the umask leaves, as `> f` and `touch f`
               leave it: `umask 077; cp a b` is `-rw-------` on a host. One that was already there
               keeps the mode it had, which is what copying over an existing file does. */
            const existed = this.fileExistsSafe(to);
            this.fileSystem.writeBytes(to, bytes);
            if (!existed) setCreationMode(this.moduleFs, to, false);
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
