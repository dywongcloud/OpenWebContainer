import { Process } from '../../base/process';
import { Shell } from '../../../shell';
import { ProcessEvent, ProcessState, ProcessType } from '../../base';
import { IFileSystem } from '../../../filesystem';
import type { NetworkHandle } from '../../../shell/commands/types';
import { ShellCommandResult } from '../../../shell';
import { isContainerShell } from '../node/runtime/capabilities/child';

interface CommandHistoryEntry {
    command: string;
    timestamp: Date;
}

/**
 * Splits a command line into words the way a POSIX shell quotes them: single quotes keep everything,
 * double quotes keep everything except \" \\ \$ \` and an escaped newline, a bare backslash escapes the
 * next character, and adjacent quoted or plain pieces make one word. No expansion is done.
 */
export function splitCommandLine(line: string): string[] {
    const words: string[] = [];
    let word = '';
    let inWord = false;
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === ' ' || ch === '\t' || ch === '\n') {
            if (inWord) {
                words.push(word);
                word = '';
                inWord = false;
            }
            i++;
        } else if (ch === "'") {
            const close = line.indexOf("'", i + 1);
            const stop = close === -1 ? line.length : close;
            word += line.slice(i + 1, stop);
            inWord = true;
            i = stop + 1;
        } else if (ch === '"') {
            inWord = true;
            i++;
            while (i < line.length && line[i] !== '"') {
                const next = line[i + 1];
                if (line[i] === '\\' && next !== undefined && '"\\$`\n'.includes(next)) {
                    if (next !== '\n') word += next;
                    i += 2;
                } else {
                    word += line[i];
                    i++;
                }
            }
            i++;
        } else if (ch === '\\') {
            const next = line[i + 1];
            if (next !== undefined && next !== '\n') word += next;
            inWord = true;
            i += 2;
        } else {
            word += ch;
            inWord = true;
            i++;
        }
    }
    if (inWord) words.push(word);
    return words;
}

/**
 * The file PATH names for `command`: the directory and the name joined, not `fs.resolvePath`, which
 * answers a relative name from the file system root and never from the base it is given.
 */
function joinOnPath(fileSystem: IFileSystem, dir: string, command: string): string {
    const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
    return fileSystem.normalizePath(`${base}/${command}`);
}

/**
 * The interpreter the shebang of `file` names -- `node` for `#!/usr/bin/env node` -- or undefined
 * when the file has no shebang, so the caller can run the file itself.
 */
function shebangInterpreter(fileSystem: IFileSystem, file: string): string | undefined {
    let content: string | undefined;
    try {
        content = fileSystem.readFile(file);
    } catch {
        return undefined;
    }
    const match = content === undefined ? null : /^#!(.*)/.exec(content);
    if (match === null) return undefined;
    const tokens = match[1].trim().split(/\s+/).filter(token => token !== '');
    const first = tokens[0];
    if (first === undefined) return undefined;
    if (first.endsWith('/env') || first === 'env') {
        return tokens.slice(1).find(token => !token.startsWith('-'));
    }
    return first.split('/').pop();
}

/** A word that opens a construct the script engine parses: a line that opens with one is the engine's whole. */
const COMPOUND_KEYWORDS = new Set(['if', 'for', 'while', 'until', 'case', 'select', 'function']);

/** The first word of a line, as the shell quotes it. */
function firstWordOf(text: string): string {
    return splitCommandLine(text)[0] ?? '';
}

/**
 * The container's own interpreter: `process.execPath` of a guest, and the name no file in the
 * virtual file system holds -- the container's node *is* the interpreter, not a script it has.
 */
const NODE_BINARY = '/usr/local/bin/node';

/** The name a command is spawned as: the container's own interpreter is `node` to every executor. */
function spawnedAs(command: string): string {
    return command === NODE_BINARY ? 'node' : command;
}

/** One step of a compound line: `op` joins it to the step before it, and null opens the line. */
interface CompoundStep {
    op: '|' | '&&' | '||' | ';' | null;
    text: string;
}

/**
 * The steps of a line this shell runs itself: `;`, `&&`, `||` and `|`, split the way a shell splits
 * them, with quoting kept and an operator inside quotes left alone.
 *
 * Null for a line it does not run: a redirection, a background job, a subshell, a command
 * substitution or a compound command, and a line with a step missing beside an operator. Those the
 * script engine takes whole, as it always has.
 */
function splitCompoundLine(line: string): CompoundStep[] | null {
    const steps: CompoundStep[] = [];
    let text = '';
    let op: CompoundStep['op'] = null;
    const push = (next: CompoundStep['op']): void => {
        steps.push({ op, text: text.trim() });
        text = '';
        op = next;
    };
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === "'") {
            const close = line.indexOf("'", i + 1);
            if (close === -1) return null;
            text += line.slice(i, close + 1);
            i = close + 1;
            continue;
        }
        if (ch === '"') {
            let j = i + 1;
            while (j < line.length && line[j] !== '"') {
                j += line[j] === '\\' ? 2 : 1;
            }
            if (j >= line.length) return null;
            text += line.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        if (ch === '\\') {
            text += line.slice(i, i + 2);
            i += 2;
            continue;
        }
        if (ch === '|') {
            push(line[i + 1] === '|' ? '||' : '|');
            i += line[i + 1] === '|' ? 2 : 1;
            continue;
        }
        if (ch === '&') {
            if (line[i + 1] !== '&') return null; // a background job
            push('&&');
            i += 2;
            continue;
        }
        if (ch === ';') {
            push(';');
            i++;
            continue;
        }
        /* Anything else that is an operator or opens a construct: the engine's, not this splitter's */
        if ('<>(){`'.includes(ch)) return null;
        if (ch === '$' && line[i + 1] === '(') return null;
        text += ch;
        i++;
    }
    steps.push({ op, text: text.trim() });
    if (steps.length === 0) return null;
    for (const step of steps) if (step.text === '') return null; // a command missing beside an operator
    if (COMPOUND_KEYWORDS.has(firstWordOf(steps[0].text))) return null;
    return steps;
}

/**
 * The utilities that read standard input when they are given no file to read instead: `cat` with no
 * argument reads the pipe its parent writes, and `cat f.txt` reads the file and leaves the pipe
 * alone. A `-c` line that opens with one of these waits for the parent to close the pipe before it
 * runs, as a host's `sh -c 'cat'` waits.
 */
const STDIN_READING_COMMANDS = new Set([
    'base32', 'base64', 'cat', 'cksum', 'comm', 'cut', 'expand', 'fmt', 'fold', 'head', 'join',
    'md5sum', 'nl', 'od', 'pr', 'rev', 'sha1sum', 'sha224sum', 'sha256sum', 'sha384sum',
    'sha512sum', 'sort', 'sum', 'tac', 'tail', 'tr', 'unexpand', 'uniq', 'wc', 'xxd'
]);

/** The builtins that read a line of standard input whatever their operands name: those are variables. */
const STDIN_READING_BUILTINS = new Set(['read', 'readarray', 'mapfile']);

/** The utilities whose first operand is a pattern or a script and not a file: `grep x` reads the pipe. */
const SCRIPT_FIRST_COMMANDS = new Set(['awk', 'egrep', 'fgrep', 'grep', 'sed']);

/**
 * True when a command line reads the standard input this shell was given, which is what makes a
 * `-c` line wait for the parent's end of file rather than run at once with an empty pipe.
 *
 * Only the first step of the line is asked: a step after a `|` reads what the step before it wrote,
 * and an operand that is not a flag and not `-` is a file the command reads instead of the pipe.
 */
/**
 * A `sleep` step of a line, as milliseconds, or null when the step is not one the utility answers
 * with nothing to print and status 0: a bad interval, a flag or no operand at all is left to the
 * engine, which is what prints the utility's own diagnostic for it.
 */
function sleepMsOf(text: string): number | null {
    const words = splitCommandLine(text);
    /* `exec` runs the command behind it in the shell's own place, so the wait is the shell's --
       `exec sleep 3` under a caller's `timeout` is ended by that bound on a host, where the command
       is the process the bound kills, and not by a sleep that outruns it. */
    const command = words[0] === 'exec' ? words.slice(1) : words;
    if (command.length < 2 || command[0] !== 'sleep') return null;
    const units: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    let total = 0;
    for (const word of command.slice(1)) {
        const match = /^([+]?[0-9]*\.?[0-9]+)([smhd]?)$/.exec(word);
        if (match === null) return null;
        const value = Number(match[1]);
        if (!Number.isFinite(value) || value < 0) return null;
        total += value * (units[match[2]] ?? units.s);
    }
    return Math.min(total, 86400000);
}

function lineReadsStdin(line: string): boolean {
    const steps = splitCompoundLine(line);
    const first = steps !== null && steps.length > 0 ? steps[0].text : line;
    const words = splitCommandLine(first);
    if (words.length === 0) return false;
    const name = words[0];
    if (STDIN_READING_BUILTINS.has(name)) return true;
    const operands = words.slice(1).filter((word) => word !== '-' && !word.startsWith('-'));
    if (SCRIPT_FIRST_COMMANDS.has(name)) return operands.length <= 1;
    return STDIN_READING_COMMANDS.has(name) && operands.length === 0;
}

export class ShellProcess extends Process {
    private shell: Shell;
    private prompt: string;
    /** PS2: the prompt a construct that is still open is continued behind. */
    private continuationPrompt: string;
    private currentLine: string = '';
    private running: boolean = true;
    private filteredArgs: string[];
    private commandHistory: CommandHistoryEntry[] = [];
    private historyIndex: number = -1;
    /**
     * The line being typed, kept the first time Up moves off it, so Down can hand it back. Null
     * while the cursor sits on the current line: Down is then a no-op, never a request to replace
     * what is being typed with an empty line.
     */
    private draftLine: string | null = null;

    /**
     * The lines of a command the terminal has typed but not closed yet -- a `for` without its
     * `done`, an `if` without its `fi`, a quote without its match -- joined with the newlines the
     * Enters behind them wrote. Empty while no construct is open.
     *
     * A shell reading a terminal does not run such a line and does not report it: it asks for the
     * rest of it behind its secondary prompt and runs the whole once the line that closes it
     * arrives. `sh -c <line>` has no such state -- its input is over the moment the line is -- so
     * only the loop below ever holds one.
     */
    private pendingSource = '';

    // Add readline state
    private cursorPosition: number = 0;
    private lineBuffer: string[] = [];

    private fileSystem: IFileSystem;
    /** The command of this line was a child process: its output reached the terminal as it ran, so the
     *  result's own copy of that output is not written again. */
    private liveChildOutput = false;
    /**
     * The `timeout` of the spawn that started this shell, in milliseconds; 0 when the caller named
     * none. The bound belongs to the whole command line, not to one command of it, so it is kept as
     * the moment it runs out -- see `armKillDeadline`.
     */
    private killDeadlineMs = 0;
    /** The wall-clock moment that bound runs out: one moment for every command of the line. */
    private killDeadlineAt = 0;
    /** The signal the caller's `killSignal` named, which is the one the line is ended with. */
    private killSignalName = 'SIGTERM';
    /** What the caller is told when the bound ends the line, so it reports the kill it asked for. */
    private onKillDeadline?: () => void;
    /** True once the bound has been reported; it is reported once. */
    private killDeadlineFired = false;
    /** The host timer behind the bound, cleared when this shell ends. */
    private killDeadlineTimer?: ReturnType<typeof setTimeout>;

    /**
     * True when the spawn that started this shell gave it a piped standard input, so a parent may
     * still write to it and will close it. Only that parent's writes and that close are what a `-c`
     * line waits on; a shell the container started another way has no pipe to wait for.
     */
    private stdinPiped = false;
    /** The text written to this shell's stdin pipe, in the order it arrived. */
    private stdinText = '';
    /** True once that pipe is closed: a reader of it then sees end of file, as it does in Node. */
    private stdinClosed = false;
    /** What to wake when the pipe closes: a `-c` line that reads it waits there. */
    private stdinWaiters: (() => void)[] = [];
    /** The text the line now being run reads on standard input, or null when it reads none. */
    private lineInput: string | null = null;

    constructor(
        pid: number,
        executablePath: string,
        args: string[],
        fileSystem: IFileSystem,
        parentPid?: number,
        cwd?: string,
        env?: Map<string, string>,
        /** A read of the container's virtual network, passed on to the shell for its commands. */
        network?: NetworkHandle
    ) {
        super(pid, ProcessType.SHELL, executablePath, args, parentPid,cwd,env);
        this.fileSystem = fileSystem;
        const oscMode = args.includes('--osc');
        this.filteredArgs = args.filter(arg => arg !== '--osc');

        /* A shell started with no arguments reads its lines from a terminal, and so has the job
           control `sh -c <line>` has none of: `&` announces the job it started there, and `fg`
           can resume one. The interactive loop below is the only reader of the lines it gets. */
        const interactive = this.filteredArgs.length === 0;
        this.shell = new Shell(fileSystem, { oscMode, process: this,env: this.env, cwd: this.cwd, network, interactive });
        this.shell.setHistorySink(() => ({
            stdout: this.commandHistory
                .map((entry, index) => `${index + 1}: [${entry.timestamp.toISOString()}] ${entry.command}`)
                .join('\n'),
            stderr: '',
            exitCode: 0
        }));
        this.prompt = oscMode ? '\x1b[1;32m$\x1b[0m ' : '$ ';
        /* PS2: the prompt a host writes while a construct is still open. It is `> ` in every shell
           that reads a terminal, and it is what tells the person typing that the Enter they just
           pressed ended a line and not a command. */
        this.continuationPrompt = oscMode ? '\x1b[1;32m>\x1b[0m ' : '> ';
    }

    /**
     * Puts the `timeout` of the spawn that started this shell on the line it runs.
     *
     * A command of that line can hold the host thread -- a `node` script busy-looping does, and so
     * does a line of this shell's own that never ends -- and while it does, no host timer runs, so
     * neither this shell nor its caller can end it from outside. The line keeps one wall-clock
     * moment for all of its commands, and what is left of it travels to each child this shell
     * starts, which is the only thing that can interrupt the guest actually holding the thread: see
     * `killDeadlineLeft` and what `NodeProcess` does with it. A line that keeps to its bound never
     * reaches the moment, and the caller's own timer ends it as it always did.
     */
    armKillDeadline(ms: number, signal: string, onFire?: () => void): void {
        if (!(ms > 0)) return;
        this.killDeadlineMs = ms;
        this.killDeadlineAt = Date.now() + ms;
        this.killSignalName = signal;
        this.onKillDeadline = onFire;
        /* A backstop for a line this shell can step itself: a shell in a loop of its own, or one
           whose child has already gone. The child's own bound is what ends a line that blocks. */
        this.killDeadlineTimer = setTimeout(() => this.fireKillDeadline(), ms);
    }

    /**
     * What is left of this shell's bound, for a child of it to run under: the shell's own line is
     * what the caller timed out, and the child is the thing that runs it.
     */
    killDeadlineLeft(): { ms: number; signal: string } | undefined {
        if (this.killDeadlineAt === 0) return undefined;
        const left = this.killDeadlineAt - Date.now();
        return { ms: left > 0 ? left : 1, signal: this.killSignalName };
    }

    /** True once the moment this shell's line was bounded by has come, and not reported yet. */
    private deadlinePassed(): boolean {
        return this.deadlineReached() && !this.killDeadlineFired;
    }

    /** True once that moment has come, reported or not: what ends the line, step by step. */
    private deadlineReached(): boolean {
        return this.killDeadlineAt > 0 && Date.now() >= this.killDeadlineAt;
    }

    /**
     * Ends this shell as a child its caller killed: the caller is told, which is what makes the
     * spawn report the signal it named and `killed` true, and the line stops where it stands -- a
     * host's `sh` is dead at that moment and runs no command after it.
     */
    private fireKillDeadline(): void {
        if (this.killDeadlineFired) return;
        this.killDeadlineFired = true;
        if (this.killDeadlineTimer !== undefined) {
            clearTimeout(this.killDeadlineTimer);
            this.killDeadlineTimer = undefined;
        }
        const notify = this.onKillDeadline;
        this.onKillDeadline = undefined;
        notify?.();
    }

    /** The bound is over when this shell is: its timer is not left behind. */
    private disarmKillDeadline(): void {
        if (this.killDeadlineTimer !== undefined) {
            clearTimeout(this.killDeadlineTimer);
            this.killDeadlineTimer = undefined;
        }
    }

    /**
     * The spawn that started this shell gave it a piped standard input. A `-c` line whose command
     * reads standard input then waits for the parent's end of file instead of running at once with
     * an empty pipe, which is what a host's `sh -c 'cat'` does with what the parent writes.
     */
    openStdinPipe(): void {
        this.stdinPiped = true;
    }

    /** A write to this shell's stdin pipe: kept as the text a command of the line reads. */
    override writeInput(input: string): void {
        this.stdinText += input;
        super.writeInput(input);
    }

    /** The parent closed this shell's stdin pipe: whatever is waiting for end of file wakes. */
    override endStdin(): void {
        this.closeStdin();
    }

    /** End of input, whether the parent closed the pipe or this shell was terminated waiting on it. */
    private closeStdin(): void {
        if (this.stdinClosed) return;
        this.stdinClosed = true;
        for (const waiter of this.stdinWaiters.splice(0)) waiter();
    }

    /** Waits for end of file on this shell's stdin pipe, which a line that reads it does. */
    private stdinEnded(): Promise<void> {
        if (this.stdinClosed) return Promise.resolve();
        return new Promise<void>((resolve) => {
            this.stdinWaiters.push(resolve);
        });
    }

    protected async execute(): Promise<void> {
        try {
            // Handle initial command if provided in args
            if (this.filteredArgs.length > 0) {
                const commandLine = this.filteredArgs[0] === '-c'
                    ? (this.filteredArgs[1] ?? '')
                    : this.filteredArgs.join(' ');
                /* A line that reads the pipe this shell was given waits for the parent to close it,
                   so everything the parent writes is the text the line reads. A line that reads
                   nothing -- `sh -c 'echo hi'`, which a host ends without a parent ever writing --
                   runs at once, as it does there. */
                if (this.stdinPiped && !this.stdinClosed && lineReadsStdin(commandLine)) {
                    await this.stdinEnded();
                }
                this.lineInput = this.stdinText === '' ? null : this.stdinText;
                const result = await this.executeCommand(commandLine);
                /* The line outran the bound the caller put on it: the caller is told now, before the
                   exit this shell is about to emit, so the exit is the one a killed child gives --
                   the caller's signal and no status -- and not the status the line happened to end
                   with. A host's `sh` is killed by the same moment, which is why it reports none. */
                if (this.deadlinePassed()) this.fireKillDeadline();
                this.disarmKillDeadline();
                /* A child process wrote its output to this shell as it ran and the shell's terminal
                   saw it there; writing what the result collected as well would print it twice. */
                const live = this.liveChildOutput;
                /* `sh -c <line>` is not a terminal: what the line wrote is what the caller reads, to
                   the byte, and a newline the shell added to `printf x` would be a byte `sh -c
                   'printf x'` does not print on a host. Only the interactive loop below, which puts
                   the prompt back where the cursor is, ends a line that did not end itself. */
                if (result.stdout && !live) {
                    this.emitOutput(result.stdout);
                }
                if (result.stderr && !live) {
                    this.emitError(result.stderr);
                }
                this._exitCode = result.exitCode;
                return;
            }

            // Initial prompt
            this.emitOutput(this.prompt);

            // Interactive shell loop
            while (this.running && this.state === ProcessState.RUNNING) {
                const input = await this.readInput();
                await this.handleInput(input);
                if (this.deadlinePassed()) this.fireKillDeadline();
            }
        } catch (error: any) {
            this.emitError(`Shell error: ${error.message}\n`);
            throw error;
        } finally {
            this.disarmKillDeadline();
        }
    }

    protected async onTerminate(): Promise<void> {
        this.running = false;
        this.disarmKillDeadline();
        /* A line waiting for the parent's end of file is waiting on a process that has just been
           ended: it is woken, so `start` is not left waiting for a close that will never come. */
        this.closeStdin();
        /* A shell that was given a line is not a terminal: ended, it prints nothing, as a host's
           `sh -c <line>` prints nothing when the caller that started it ends it -- which is what a
           spawn's `timeout` does. Only the shell reading lines from a terminal says it is through,
           and only to that terminal. */
        if (this.filteredArgs.length === 0) this.emitOutput('\nShell terminated.\n');
    }

    private async handleInput(input: string): Promise<void> {

        // Detect paste by checking if input is multiple characters 
        // and doesn't start with an escape sequence
        if (input.length > 1 && !input.startsWith('\x1b')) {
            await this.handlePaste(input);
            return;
        }

        switch (input) {
            case '\r': // Enter
                await this.handleEnterKey();
                break;

            case '\x7F': // Backspace
            case '\b':
                this.handleBackspace();
                break;

            case '\x1b[A': // Up arrow
                this.handleUpArrow();
                break;

            case '\x1b[B': // Down arrow
                this.handleDownArrow();
                break;

            case '\x1b[C': // Right arrow
                this.handleRightArrow();
                break;

            case '\x1b[D': // Left arrow
                this.handleLeftArrow();
                break;

            case '\x03': // Ctrl+C
                this.handleCtrlC();
                break;

            case '\x04': // Ctrl+D
                this.handleCtrlD();
                break;

            default:
                if (input.length === 1 && input >= ' ') {
                    this.handleCharacterInput(input);
                }
                break;
        }
    }
    private async handlePaste(pastedText: string): Promise<void> {
        // Split the pasted text by lines
        const lines = pastedText.split(/\r?\n/);

        // Handle first line - insert at cursor position
        const firstLine = lines[0];
        const before = this.currentLine.slice(0, this.cursorPosition);
        const after = this.currentLine.slice(this.cursorPosition);

        this.currentLine = before + firstLine + after;
        this.cursorPosition += firstLine.length;

        // Update display for first line
        this.emitOutput(firstLine);
        if (after) {
            // Redraw rest of the line
            this.emitOutput(after);
            // Move cursor back to position
            this.emitOutput(`\x1b[${after.length}D`);
        }

        // If there are multiple lines, handle them one by one
        if (lines.length > 1) {
            for (let i = 1; i < lines.length; i++) {
                // Execute current line
                await this.handleEnterKey();

                // Handle next line
                const line = lines[i];
                if (line.length > 0) {
                    this.currentLine = line;
                    this.cursorPosition = line.length;
                    this.emitOutput(line);
                }
            }
        }
    }
    private async handleEnterKey(): Promise<void> {
        this.emitOutput('\n');

        /* The line as it was typed, whitespace and all: what a line holds behind a construct that
           is still open is text of the command, not layout around it -- the four spaces a
           continuation line of `echo "hello` starts with are four spaces of the string it prints,
           the two `echo "a  ` ends on are two of theirs, and so are the three of a line that is
           nothing but spaces. A host's shell keeps every one of them, so this one keeps them too
           and trims only a line it runs as it stands: see `commandLine` below. */
        const typed = this.currentLine;
        /* What this shell has of the command so far: the lines a construct that is still open was
           typed on, and the one just typed behind them. */
        const source = this.pendingSource === '' ? typed : `${this.pendingSource}\n${typed}`;
        /* A line typed at the top level, and only one, is the whole of the command: the whitespace
           around it is nothing the grammar reads, so it is trimmed before it runs. A construct is
           run exactly as it was typed. */
        const single = this.pendingSource === '';
        /* A construct that is still open is not a command yet: a host's shell asks for the rest of
           it behind `> ` and runs it only once the line that closes it arrives. `sh -c <line>` is
           never asked -- its input is over the moment the line is, and a host reports what it was
           given -- so only the loop that reads the terminal takes this path. An empty Enter inside
           an open construct is a blank line of it, not a command: `echo "a` newline newline `b"`
           prints two lines. */
        if (this.pendingSource !== '' || typed !== '') {
            if (this.shell.isIncomplete(source)) {
                this.pendingSource = source;
                this.currentLine = '';
                this.cursorPosition = 0;
                this.draftLine = null;
                this.emitOutput(this.continuationPrompt);
                return;
            }
        }
        this.pendingSource = '';

        const commandLine = single ? source.trim() : source;
        if (commandLine) {
            // Add to history
            this.commandHistory.push({
                command: commandLine,
                timestamp: new Date()
            });
            this.historyIndex = this.commandHistory.length;

            // Execute command
            const result = await this.executeCommand(commandLine);

            // Handle output: a child process already wrote its own to the terminal as it ran
            const live = this.liveChildOutput;
            if (result.stdout && !live) {
                this.emitOutput(result.stdout);
                if (!result.stdout.endsWith('\n')) {
                    this.emitOutput('\n');
                }
            }
            if (result.stderr && !live) {
                this.emitError(result.stderr);
                if (!result.stderr.endsWith('\n')) {
                    this.emitOutput('\n');
                }
            }
        }

        // Reset current line and show new prompt
        this.currentLine = '';
        this.cursorPosition = 0;
        this.draftLine = null;
        /* A line that ended the shell -- `exit`, or a command that failed under `set -e` -- leaves
           no prompt behind it, as it leaves none in /bin/sh. */
        if (this.running) this.emitOutput(this.prompt);
    }

    private handleBackspace(): void {
        if (this.cursorPosition > 0) {
            const before = this.currentLine.slice(0, this.cursorPosition - 1);
            const after = this.currentLine.slice(this.cursorPosition);
            this.currentLine = before + after;
            this.cursorPosition--;

            // Update display
            this.emitOutput('\b \b'); // Move back, clear character, move back
            if (after) {
                // Redraw rest of the line
                this.emitOutput(after + '\x1b[K'); // Clear to end of line
                // Move cursor back to position
                this.emitOutput(`\x1b[${after.length}D`);
            }
        }
    }

    private handleUpArrow(): void {
        if (this.historyIndex > 0) {
            if (this.draftLine === null && this.historyIndex >= this.commandHistory.length) {
                this.draftLine = this.currentLine;
            }
            this.historyIndex--;
            this.updateInputLine(this.commandHistory[this.historyIndex].command);
        }
    }

    private handleDownArrow(): void {
        /* Down only means something once Up has moved the cursor off the line being typed. Before
           that it is a no-op, the way it is in /bin/sh: it never replaces a line the user is still
           typing -- quoting and all -- with an empty one. */
        if (this.draftLine === null) return;
        if (this.historyIndex < this.commandHistory.length - 1) {
            this.historyIndex++;
            this.updateInputLine(this.commandHistory[this.historyIndex].command);
            return;
        }
        this.historyIndex = this.commandHistory.length;
        this.updateInputLine(this.draftLine);
        this.draftLine = null;
    }

    private handleLeftArrow(): void {
        if (this.cursorPosition > 0) {
            this.cursorPosition--;
            this.emitOutput('\x1b[D');
        }
    }

    private handleRightArrow(): void {
        if (this.cursorPosition < this.currentLine.length) {
            this.cursorPosition++;
            this.emitOutput('\x1b[C');
        }
    }

    private handleCtrlC(): void {
        this.currentLine = '';
        this.cursorPosition = 0;
        this.draftLine = null;
        /* The construct being typed is thrown away with the line: `^C` at a `> ` is how a person
           abandons a command they opened and never closed. */
        this.pendingSource = '';
        this.emitOutput('^C\n' + this.prompt);
    }

    private handleCtrlD(): void {
        if (this.currentLine.length === 0) {
            this.emitOutput('exit\n');
            this.running = false;
            this._exitCode = 0;
        }
    }

    private handleCharacterInput(char: string): void {
        // Insert character at cursor position
        const before = this.currentLine.slice(0, this.cursorPosition);
        const after = this.currentLine.slice(this.cursorPosition);
        this.currentLine = before + char + after;
        this.cursorPosition++;
        this.draftLine = null;

        // Update display
        this.emitOutput(char);
        if (after) {
            // Redraw rest of the line
            this.emitOutput(after);
            // Move cursor back to position
            this.emitOutput(`\x1b[${after.length}D`);
        }
    }

    private updateInputLine(newLine: string): void {
        // Clear current line
        this.emitOutput('\r\x1b[K');
        // Write prompt and new line
        this.emitOutput(this.prompt + newLine);
        this.currentLine = newLine;
        this.cursorPosition = newLine.length;
    }

    /**
     * One line, run by the same script engine the container's other shell runs `sh -c <line>` with.
     *
     * The engine is synchronous, so a command that only a child process can run -- `node`, `npm`,
     * `npx`, a file found on PATH, a script behind a shebang, and the network commands of the
     * registry -- is spawned on a line of its own, where the shell can wait for it, before the line
     * reaches the engine. Everything else -- the operators, pipes, redirections and expansions, and
     * every built-in and utility -- is the engine's, and is what the other path runs.
     *
     * One line the engine cannot take whole is a compound line with such a command in it --
     * `cd /app; node x.js`, `printf 'x' | node ...`, `node ... && echo done`. The engine is
     * synchronous and a child is not, so this shell runs that line itself, one step at a time, and
     * gives the child the text the step before it wrote.
     */
    private async executeCommand(commandLine: string): Promise<ShellCommandResult> {
        const processedArgs = splitCommandLine(commandLine);
        this.liveChildOutput = false;

        if (processedArgs.length === 0) {
            return { stdout: '', stderr: '', exitCode: 0 };
        }

        const [head, ...cmdArgs] = processedArgs;
        const command = spawnedAs(head);

        if (this.shell.isCompound(commandLine)) {
            const steps = splitCompoundLine(commandLine);
            /* The bound the caller put on this spawn is only honoured between the steps of the line:
               a step that holds the host thread holds the timer too. A caller's own line is taken
               apart for the other reason there is: a host's `sh -c <line>` writes what a command
               wrote as that command runs, so `echo A; sleep 2` reaches its caller at once and not
               two seconds later, and collecting every step's output to write it once the line ends
               is what puts it after that moment -- which is also the moment a `timeout` ends the
               line, and then the caller gets nothing at all. A line typed into the loop below is
               a screen that loop redraws, and has no caller waiting on a pipe. */
            if (steps !== null && (steps.length > 1 && (this.streamsSteps() || this.killDeadlineAt > 0)
                || steps.some((step) => this.shell.isSpawnedCommand(spawnedAs(firstWordOf(step.text)))))) {
                const run = await this.executeSteps(steps);
                if (this.shell.stopped) {
                    this.running = false;
                    this._exitCode = run.exitCode;
                }
                return run;
            }
        } else {
            const spawned = await this.spawnOneCommand(command, cmdArgs);
            if (spawned !== undefined) {
                this.rememberStopped(spawned.exitCode);
                return spawned;
            }
        }

        const result = await this.runEngineLine(commandLine, this.lineInput);
        this.rememberStopped(result.exitCode);
        /* `set -e` and a command that failed: the shell ends, with the status the command left, as
           /bin/sh does. Typed into the loop below -- which is the only reader of this flag -- it
           is what stops a script pasted or typed into the terminal where bash would have stopped. */
        if (this.shell.errexitStopped) {
            this.running = false;
            this._exitCode = result.exitCode;
        }
        return result;
    }

    /**
     * The steps of a compound line, in order: `;` sequences them, `&&` and `||` run one on the status
     * of the one before it, and `|` hands what a step wrote to the step after it.
     */
    private async executeSteps(steps: CompoundStep[]): Promise<ShellCommandResult> {
        let stdout = '';
        let stderr = '';
        let exitCode = 0;
        let piped = '';
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (step.op === '&&' && exitCode !== 0) continue;
            if (step.op === '||' && exitCode === 0) continue;
            const stage = await this.runStep(step.text, step.op === '|' ? piped : (i === 0 ? this.lineInput : null));
            exitCode = stage.exitCode;
            const next = steps[i + 1];
            if (next !== undefined && next.op === '|') {
                piped = stage.stdout;
                stderr += stage.stderr;
            } else if (this.streamsSteps()) {
                /* A host's `sh -c <line>` writes what a command wrote as that command runs, so a
                   caller has it before the moment its `timeout` ends the line. Collecting every
                   step's output and writing it once the line ends puts it after that moment, and
                   the kill takes it: `spawn('sh', ['-c', 'echo A; sleep 3; echo B'], { timeout:
                   400, killSignal: 'SIGKILL' })` gave a caller nothing at all when the kill was the
                   first of the two to be serviced, where host node 24.15 gives it 'A\n'. */
                if (stage.stdout) this.emitOutput(stage.stdout);
                if (stage.stderr) this.emitError(stage.stderr);
                piped = '';
            } else {
                stdout += stage.stdout;
                stderr += stage.stderr;
                piped = '';
            }
            if (this.shell.stopped) break;
            /* The bound ran out while that step held the thread: no step after it runs, the way no
               command of a host's `sh` runs once the shell has been killed -- `sh -c 'echo a; node
               busy.js; echo b'` prints no `b` when its timeout ends inside the busy one. */
            if (this.deadlineReached()) break;
        }
        return { stdout, stderr, exitCode };
    }

    /**
     * True when this shell was given the line it runs -- `sh -c <line>`, or the name of a script --
     * and not the terminal the interactive loop below reads. A caller's line writes into a pipe the
     * caller holds, so it is written as each command of the line runs; a terminal is a screen the
     * loop redraws, and the loop is what puts there what a line it took wrote.
     */
    private streamsSteps(): boolean {
        return this.filteredArgs.length > 0;
    }

    /**
     * One step of a compound line. A command only a child can run is spawned with the text the step
     * before it wrote on its stdin, and its own output is read back rather than written to the
     * terminal, so a pipe takes it. Every other step is the engine's.
     */
    private async runStep(text: string, input: string | null): Promise<ShellCommandResult> {
        const words = splitCommandLine(text);
        if (words.length === 0) return { stdout: '', stderr: '', exitCode: 0 };
        const [head, ...args] = words;
        const command = spawnedAs(head);
        if (this.shell.isSpawnedCommand(command)) {
            const env = Object.fromEntries(this.env);
            /* The child reads its stdin only when it is told it has one, the way a pipe tells it */
            if (input !== null) env.OWC_STDIN = 'pipe';
            const run = await this.spawnChild(command, args, env, this.shell.getWorkingDirectory(), {
                stdin: input ?? undefined,
                silent: true
            });
            /* A child runs beside the script engine, never through it, so the engine's own `$?` is
               still the one the line before this one left: without this, `node -e 'process.exit(3)';
               echo $?` prints 0, where a host shell prints 3. */
            this.shell.noteChildStatus(run.exitCode);
            return run;
        }
        return this.runEngineLine(text, input);
    }

    /**
     * One step of a line, run on the script engine.
     *
     * The engine's `sleep` blocks the host thread for the whole of its wait -- `blockFor` in
     * `shell/commands/fileutils.ts` -- and no timer runs on a thread that is blocked, so a line
     * under the caller's `timeout` would sit out the whole sleep and never see the bound. A bounded
     * line therefore waits on a timer instead, and only until the bound runs out: the thread is
     * free meanwhile, the bound fires, and the line stops where it stands, as a host's `sh` does.
     * A line with no bound waits on that timer too, for the sleep's own whole wait: the thread a
     * blocked one takes is what keeps what a step before it wrote from reaching the caller until
     * the line ends -- `sh -c 'echo A; sleep 2'` gave its caller 'A\n' two seconds late, where a
     * host gives it at once.
     */
    private async runEngineLine(text: string, input: string | null): Promise<ShellCommandResult> {
        const ms = sleepMsOf(text);
        if (ms === null) return this.shell.executeLine(text, input);
        const left = this.killDeadlineAt > 0 ? this.killDeadlineAt - Date.now() : ms;
        if (left > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, left)));
        /* An `exec` that was given its whole wait replaced the shell with the command it named, the
           way it does on a host, so the rest of the line stands behind a command that is no longer
           there: `sh -c 'exec sleep 1; echo AFTER'` under a `timeout` of 4 s prints nothing and
           exits 0 at 1 s. A wait the bound cut short is the other case, and there the bound is what
           ends the line -- and the process -- rather than an `exec` that never ran out. */
        if (ms <= left && firstWordOf(text) === 'exec') {
            this.shell.stopped = true;
            this.shell.stoppedCode = 0;
        }
        return { stdout: '', stderr: '', exitCode: 0 };
    }

    /** `exit` on a line of its own: the status it gave is the shell's. */
    private rememberStopped(_exitCode: number): void {
        if (!this.shell.stopped) return;
        this.running = false;
        this._exitCode = this.shell.stoppedCode;
    }

    /**
     * The file a command naming one stands at. A name written with a `/` in it is a path already;
     * any other is a file in the directory this shell stands in -- `./node_modules/.bin/cowsay`,
     * which a host's `sh` executes from there and which the file system answers only once the
     * directory is put in front of it.
     */
    private commandFile(command: string): string {
        if (command.startsWith('/')) return command;
        return joinOnPath(this.fileSystem, this.shell.getWorkingDirectory(), command);
    }

    /**
     * Runs a command that only a child process can run, or returns undefined when the command is not
     * one of those and the line belongs to the script engine.
     */
    private async spawnOneCommand(command: string, cmdArgs: string[]): Promise<ShellCommandResult | undefined> {
        try {
            if (this.shell.isSpawnedCommand(command)) {
                /* A child process writes to this shell's output as it runs, so the result's copy is
                   not written again: `sh -c 'node x.js'` printed every line twice otherwise. */
                this.liveChildOutput = true;
                return await this.spawnChild(
                    command,
                    cmdArgs,
                    Object.fromEntries(this.env),
                    this.shell.getWorkingDirectory()
                );
            }
            /* `sh -c <line>` is a shell of its own, and so is any spelling of the path it stands at:
               it runs that line the way this shell runs one, so a command only a child can run --
               `sh -c 'node x.js'` -- reaches a child through it, where the engine's own `sh`, which
               cannot spawn, would refuse it with 127. Only the bare name was recognised, so
               `/bin/sh -c 'echo hi'` fell through to a file lookup and closed 0 having run nothing. */
            if (isContainerShell(command) && cmdArgs[0] === '-c') {
                this.liveChildOutput = true;
                return await this.spawnChild(
                    command,
                    cmdArgs,
                    Object.fromEntries(this.env),
                    this.shell.getWorkingDirectory()
                );
            }
            if (this.shell.hasExternalCommand(command)) {
                return await this.shell.executeExternal(command, cmdArgs);
            }
            // A built-in or a utility is never looked for on PATH, the way it never is in a shell
            if (this.shell.hasCommand(command)) return undefined;
            // check if the command is in env PATH
            let PATH = this.env.get('PATH');
            if (PATH) {
                for (const path of PATH.split(':')) {
                    const executablePath = joinOnPath(this.fileSystem, path, command);
                    if (!this.fileSystem.fileExists(executablePath)) continue;
                    /* A file on PATH is run the way the kernel runs it: through the interpreter its
                       shebang names. A node_modules/.bin shim is one -- a `node` script with no
                       executor of its own -- so a script that calls an installed bin by name works. */
                    const interpreter = shebangInterpreter(this.fileSystem, executablePath);
                    const spawnArgs = interpreter === undefined ? cmdArgs : [executablePath, ...cmdArgs];
                    return await this.spawnChild(
                        interpreter ?? executablePath,
                        spawnArgs,
                        Object.fromEntries(this.env),
                        this.shell.getWorkingDirectory()
                    );
                }
            }
            // check for shebang: a name that is not a file to read is not one, and says so by throwing
            let content: string | undefined;
            try {
                content = this.fileSystem.readFile(this.commandFile(command));
            } catch {
                content = undefined;
            }
            if (content) {
                const shebang = content.match(/^#!(.*)/);
                if (shebang) {
                    const interpreterName = shebang[1];
                    let name = interpreterName.split(" ")[0]
                    if (name == '/usr/bin/env') {
                        let tokens = interpreterName.split(" ")
                        if (tokens.length == 1)
                            throw "executor not specified"
                        let newCommand = tokens[1]
                        /* The script is run where this shell stands and with this shell's variables,
                           the way a host's `sh` hands it to its interpreter: a relative name means
                           the file beside the shell and nothing at all from the file system root,
                           which is where a child with no directory of its own looks for it. As in
                           every other path here, the child writes to this shell as it runs, so the
                           result's own copy of that output is not written again. */
                        this.liveChildOutput = true;
                        return await this.spawnChild(newCommand, [command, ...cmdArgs],
                            Object.fromEntries(this.env), this.shell.getWorkingDirectory());
                    }
                }
            }
            return undefined;
        } catch (error: any) {
            return {
                stdout: '',
                stderr: error.message,
                exitCode: 1
            };
        }
    }
}
