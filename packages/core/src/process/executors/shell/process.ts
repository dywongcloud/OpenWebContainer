import { Process } from '../../base/process';
import { Shell } from '../../../shell';
import { ProcessEvent, ProcessState, ProcessType } from '../../base';
import { IFileSystem } from '../../../filesystem';
import type { NetworkHandle } from '../../../shell/commands/types';
import { ShellCommandResult } from '../../../shell';

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

export class ShellProcess extends Process {
    private shell: Shell;
    private prompt: string;
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
        return this.killDeadlineAt > 0 && !this.killDeadlineFired && Date.now() >= this.killDeadlineAt;
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

    protected async execute(): Promise<void> {
        try {
            // Handle initial command if provided in args
            if (this.filteredArgs.length > 0) {
                const commandLine = this.filteredArgs[0] === '-c'
                    ? (this.filteredArgs[1] ?? '')
                    : this.filteredArgs.join(' ');
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
        this.emitOutput('\nShell terminated.\n');
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

        const commandLine = this.currentLine.trim();
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
            if (steps !== null && steps.some((step) => this.shell.isSpawnedCommand(spawnedAs(firstWordOf(step.text))))) {
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

        const result = this.shell.executeLine(commandLine);
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
            const stage = await this.runStep(step.text, step.op === '|' ? piped : null);
            stderr += stage.stderr;
            exitCode = stage.exitCode;
            const next = steps[i + 1];
            if (next !== undefined && next.op === '|') {
                piped = stage.stdout;
            } else {
                stdout += stage.stdout;
                piped = '';
            }
            if (this.shell.stopped) break;
            /* The bound ran out while that step held the thread: no step after it runs, the way no
               command of a host's `sh` runs once the shell has been killed -- `sh -c 'echo a; node
               busy.js; echo b'` prints no `b` when its timeout ends inside the busy one. */
            if (this.deadlinePassed()) break;
        }
        return { stdout, stderr, exitCode };
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
        return this.shell.executeLine(text, input);
    }

    /** `exit` on a line of its own: the status it gave is the shell's. */
    private rememberStopped(_exitCode: number): void {
        if (!this.shell.stopped) return;
        this.running = false;
        this._exitCode = this.shell.stoppedCode;
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
            /* `sh -c <line>` is a shell of its own, and it runs that line the way this shell runs one:
               a command only a child can run -- `sh -c 'node x.js'` -- reaches a child through it,
               where the engine's own `sh`, which cannot spawn, would refuse it with 127. */
            if (command === 'sh' && cmdArgs[0] === '-c') {
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
                content = this.fileSystem.readFile(command);
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
                        return await this.spawnChild(newCommand, [command, ...cmdArgs]);
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
