/**
 * Guest-shell builtins (part 2) and the compound-command script engine (part 1).
 *
 * Two surfaces live in this file.
 *
 *  1. `COMMANDS: Record<string, ShellCommand>` -- the builtins that are callable with the ordinary
 *     command context (args, cwd, env, input, fs). `runScript` dispatches to this same table, so the
 *     two surfaces can never disagree about what a builtin does.
 *
 *  2. `ShellState` / `createShellState` / `runScript` / `setRunner` -- the script engine. `runScript`
 *     parses a whole script (if/elif/else/fi, for/while/until, case/esac, `{ }`, `( )`, functions,
 *     break/continue/return and `!`) and runs every *simple* command through the runner installed
 *     with `setRunner`, so the orchestrator keeps its own per-command dispatch: its `echo`, `cd`,
 *     `cat`, node execution and 127-for-unknown behaviour all stay exactly as they are.
 *
 * Builtins that need shell state (variables, functions, aliases, options, the directory stack, the
 * call stack) are implemented once, against `ShellState`, and are still reachable through
 * `COMMANDS`: the engine binds the live state to every `CommandContext` it builds, and a host that
 * builds contexts itself binds one with `setActiveState`.
 */

import type { ShellCommand, CommandContext, CommandResult } from './types';
import { atPath, inputText } from './types';
import { setCreationMode } from './fileutils';

/* ================================================================== *
 * 0. Shapes
 * ================================================================== */

/** The slice of the container file system this module uses. `IFileSystem` is a superset of it. */
export interface ShellFs {
    readFile(path: string): string | undefined;
    writeFile(path: string, content: string): void;
    listDirectory(path: string): string[];
    isDirectory(path: string): boolean;
    fileExists(path: string): boolean;
    createDirectory(path: string): void;
    deleteFile(path: string, recursive?: boolean): void;
    deleteDirectory(path: string): void;
    resolvePath(path: string, basePath?: string): string;
}

/** What `runScript` calls for a command it does not implement: the host's own dispatch. */
export type SimpleCommandRunner = (
    state: ShellState,
    words: string[],
    input: string | null
) => { stdout: string; stderr: string; exitCode: number };

/**
 * The words `echo` writes, with the escapes the host's `/bin/sh` writes. That shell is bash running
 * in POSIX mode, which turns `xpg_echo` on: every operand has its `\n`, `\t`, `\\` and friends
 * translated, `\0nnn` and `\xHH` become their character, `\c` ends the line without a newline, and
 * an escape it has no meaning for keeps its backslash. Neither `-n` nor `-e` is a flag there, so
 * they are words like any other.
 *
 * Both hosts of this file's builtins keep their own `echo`, so they share this one body rather than
 * each growing a second, slightly different, reading of the same escapes.
 */
export function echoWords(args: string[]): string {
    let out = '';
    let stopped = false;
    for (let i = 0; i < args.length && !stopped; i++) {
        if (i > 0) out += ' ';
        const word = args[i];
        for (let j = 0; j < word.length; j++) {
            if (word[j] !== '\\' || j + 1 >= word.length) { out += word[j]; continue; }
            const escape = word[++j];
            switch (escape) {
                case 'a': out += '\u0007'; break;
                case 'b': out += '\b'; break;
                case 'c': stopped = true; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'v': out += '\u000b'; break;
                case '\\': out += '\\'; break;
                case '0': {
                    const octal = /^[0-7]{1,3}/.exec(word.slice(j + 1));
                    if (octal === null) { out += '\u0000'; break; }
                    out += String.fromCharCode(parseInt(octal[0], 8));
                    j += octal[0].length;
                    break;
                }
                case 'x': {
                    const hex = /^[0-9a-fA-F]{1,2}/.exec(word.slice(j + 1));
                    if (hex === null) { out += '\\x'; break; }
                    out += String.fromCharCode(parseInt(hex[0], 16));
                    j += hex[0].length;
                    break;
                }
                default: out += '\\' + escape; break;
            }
            if (stopped) break;
        }
    }
    return stopped ? out : out + '\n';
}

/**
 * `cmd &` where this engine parsed the `&` -- inside an `if`, a `for`, a `while`, a `case`, a group
 * or a subshell, which is every `&` the host's own line splitter never sees. Registering one is the
 * host's to do: the table `jobs` and `wait` read is the host's, and so are the words a job is run
 * from. It is handed the pipeline as it was written and answers with the job it registered, or with
 * null where it can neither parse nor run it.
 */
export type BackgroundJobStarter = (state: ShellState, source: string) => ShellJob | null;

export interface ShellVar {
    value: string;
    /** Exported into the environment of the commands that run (`export`, `declare -x`). */
    export?: boolean;
    /** Assignment is refused (`readonly`, `declare -r`). */
    readonly?: boolean;
    /**
     * The integer attribute `declare -i` sets: every assignment to the name is arithmetic.
     * `declare -i n=1; n=n+1` leaves a `n` of 2, where a name without it holds the text `n+1`.
     */
    integer?: boolean;
}

export interface TrapSpec {
    action: string;
    /** `trap - SIGNAL`: restore the default. */
    reset: boolean;
    /** `trap '' SIGNAL`: ignore. */
    ignore: boolean;
}

export interface CallFrame {
    name: string;
    source: string;
    line: number;
}

export interface FunctionDef {
    name: string;
    body: Command;
    /** The file the function was defined in. */
    source: string;
    line: number;
    /** The source text between the braces, for `type`. */
    text?: string;
}

/**
 * Every option `set -o` knows about.
 *
 * The names are the ones this machine's `/bin/sh` prints -- bash 3.2 in POSIX mode, which lists
 * twenty-seven of them -- and every one `set -o <name>` takes is here, so the list a caller sees
 * and the list a caller can set are the same list. The eleven this file does not act on are kept
 * as state anyway: `set -o keyword; set -o | grep keyword` answers `on`, and `$-` reads the ones
 * a host's own `$-` spells (`B` for `braceexpand`, `H` for `histexpand`, `b` for `notify`).
 */
export interface ShellOptions {
    allexport: boolean;
    braceexpand: boolean;
    emacs: boolean;
    errexit: boolean;
    errtrace: boolean;
    functrace: boolean;
    hashall: boolean;
    histexpand: boolean;
    history: boolean;
    ignoreeof: boolean;
    interactiveComments: boolean;
    keyword: boolean;
    monitor: boolean;
    noclobber: boolean;
    noexec: boolean;
    noglob: boolean;
    nolog: boolean;
    notify: boolean;
    nounset: boolean;
    onecmd: boolean;
    physical: boolean;
    pipefail: boolean;
    posix: boolean;
    privileged: boolean;
    verbose: boolean;
    vi: boolean;
    xtrace: boolean;
    /** Not a name `set -o` prints: it is set from how the shell was started, not from a flag. */
    interactive: boolean;
}

/**
 * One command started with `&`.
 *
 * The table itself belongs to the host -- `child.ts` keeps it on the shell and leaves the shell in
 * `state.host`, so `jobs` and `wait` here read the very jobs the dispatcher's `&` started. This
 * module never starts one: on a host that runs one command at a time nothing can run alongside the
 * shell, so a job is "started" only in the sense that the shell no longer waits for it, and the
 * host runs it when `wait` asks for it or when the line's foreground is through. A job this module
 * marks done is a job the host no longer runs.
 */
export interface ShellJob {
    /** The number `jobs` prints in `[1]`, and `%1` names. */
    id: number;
    /** The pid `&` printed, `$!` holds and `wait` takes as an argument. */
    pid: number;
    /** The command as it was written, for `jobs`. */
    text: string;
    /**
     * The command as it was written, quoting and all, which is what the job is run from. `text` is
     * the words a shell *prints*, and printing them back is what took the quoting out of a job:
     * `(echo 'a  b') &` was replayed as `echo a b`, so `(trap 'echo inner' EXIT) &` ran the trap
     * `echo` and printed an empty line where a host prints `inner`.
     */
    source?: string;
    /** Run to completion: `wait` no longer has anything to wait for. */
    done: boolean;
    /** The status it left, once it has run. */
    exitCode: number;
    /**
     * Ended by a signal rather than by running out: a job `kill` ended never runs at all, and the
     * shell reports it -- during `wait`, which is when a host notices a job its own `kill` ended.
     */
    terminated?: boolean;
    /** The signal that ended it, for the notice `wait` writes. */
    signal?: { number: number; name: string };
}

export interface ShellState {
    /** One map per scope: index 0 is the global scope, each function call pushes one. */
    scopes: Map<string, ShellVar>[];
    /** Exported variables, recomputed on every read. */
    readonly env: Record<string, string>;
    cwd: string;
    options: ShellOptions;
    /** `$1`, `$2`, ... ; `$0` is `shellName`. */
    positional: string[];
    shellName: string;
    aliases: Map<string, string>;
    functions: Map<string, FunctionDef>;
    /** The directory stack of pushd/popd/dirs; index 0 is the current directory. */
    dirs: string[];
    /** `$?` */
    lastStatus: number;
    /**
     * `$$` -- the pid of the shell itself, which is the pid of the process this state belongs to.
     * A fresh state with no process behind it has 1, the pid of the container's own first process.
     */
    pid: number;
    /** `$!` -- the pid the last `&` printed, 0 before the first one. */
    lastBackgroundPid: number;
    /**
     * The background jobs `&` started, in the order it started them: `jobs` lists them and `wait`
     * waits for them. Read out of the host's own table where the host keeps one, so the two are one
     * table and not two; a state with no host keeps an empty one of its own.
     */
    readonly jobs: ShellJob[];
    /**
     * How a `&` this engine parsed starts a job: `child.ts` installs the host's own
     * `startBackgroundJob` here. Left unset -- a host that keeps no job table, or one that has not
     * wired this -- a `&` runs its command in the foreground instead: waited for, so the command is
     * late rather than lost, and never a job `jobs` would have to invent.
     */
    startJob?: BackgroundJobStarter;
    /** `getopts` state: the 1-based word index and the character offset inside the current word. */
    optind: number;
    optchar: number;
    optarg: string;
    /** `umask`, as an octal mode number. */
    umask: number;
    /** `hash`'s remembered command paths. */
    hash: Map<string, string>;
    traps: Map<string, TrapSpec>;
    /**
     * The descriptors `exec` opened and left open: `3` is the file `exec 3>f` named, and a later
     * `echo hi >&3` writes to it, the way it does in a shell. One `exec 3>&1` opened is the shell's
     * own standard output rather than a file, and one `exec 3<f` opened is a descriptor `cat <&3`
     * reads. The two a redirection names without being opened -- 1 and 2 -- are never in here; they
     * are `stdoutTarget` and `stderrTarget`, which a plan reads as the destination it starts from.
     */
    openFds: Map<number, StreamTarget>;
    /**
     * Where the shell's own standard output goes, as a plan carries it. `exec >f` and `exec 1>&2`
     * are redirections of the shell and not of one command, so every command behind them writes
     * where these point, as it does in a host shell; before any such `exec` they are the output
     * and the error the shell was started with.
     */
    stdoutTarget: StreamTarget;
    stderrTarget: StreamTarget;
    /**
     * Whether the shell's own standard input has been closed by an `exec 0<&-`. A host keeps the
     * number for a closed descriptor and then refuses to hand it out again: `exec 0<&-; exec 3<&0`
     * is `sh: 0: Bad file descriptor` with the status 1, where answering a duplicate of `0` from
     * thin air left the second `exec` a success and the shell a descriptor nothing was behind.
     */
    stdinClosed: boolean;
    callStack: CallFrame[];
    /** Free slot for the host: `child.ts` stores its CapabilityContext here for its runner. */
    host?: unknown;
    /** The container file system. Globs, `source` and PATH lookups need it. */
    fs?: ShellFs;
    /** Standard input as `read`, `mapfile` and `cat` see it, plus the read cursor into it. */
    inputBuffer: string;
    inputCursor: number;
    /**
     * The offset the shell's own standard input is read from, shared with the descriptor an
     * `exec 0<f` or an `exec 0<&3` put there. It is an object a snapshot copies by reference, so
     * what a command inside a pipeline or a subshell -- both of which put the rest of the state they
     * saved back -- read out of it is gone for the commands behind them: `exec 0<f; cat | cat; cat`
     * is `f` once, as it is on a host.
     */
    inputOffset?: { pos: number };
    /** Set by `exec`: the command that "replaced" the shell, for the host to report. */
    execTarget: string[] | null;
    /** Non-zero while evaluating a condition, a negated command or a `&&`/`||` operand. */
    protectedDepth: number;
    /**
     * Set by `exit`: the line ended the shell itself, not a subshell or a function inside it -- both
     * of which put it back with the rest of the state they restore. An interactive shell process
     * stops with it, as /bin/sh does when `exit` is typed into it.
     */
    exitCalled?: boolean;
    /** Where output goes; command substitution swaps in a scratch sink. */
    io: { stdout: string; stderr: string };
    /**
     * The text a write this shell made to a descriptor `>&-` closed could not hold: a host keeps it
     * in the buffer its own writes go through, so it is written out later -- into wherever the
     * standard output is *by then*, and into the output of every subshell and command substitution
     * forked while it is held, which inherits the buffer. It is dropped, not written, by a flush
     * that finds the output still closed, and by the end of a subshell or a pipeline stage, each of
     * which is a process of its own on a host and takes its buffer with it.
     */
    held: string;
    /** Line of the command being run, for `caller`. */
    line: number;
    /** Name of the script being run, for `caller`. */
    source: string;
}

/* ================================================================== *
 * 1. Small utilities
 * ================================================================== */

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `starCrossesSlash` is true for `case` patterns, false for pathname expansion. `quoted` marks the
 * characters that came out of quoted text -- `'*.txt'`, `"*.txt"` and `"$x"` -- which are literal:
 * a quoted `*` is a `*` to match, never a pattern.
 */
function globToRegExp(pattern: string, starCrossesSlash: boolean, quoted?: boolean[]): RegExp {
    let out = '';
    const star = starCrossesSlash ? '.*' : '[^/]*';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (quoted?.[i] === true) {
            out += escapeRegex(ch);
            continue;
        }
        if (ch === '*') {
            out += star;
        } else if (ch === '?') {
            out += starCrossesSlash ? '.' : '[^/]';
        } else if (ch === '[') {
            let j = i + 1;
            let negate = false;
            if (pattern[j] === '!' || pattern[j] === '^') {
                negate = true;
                j++;
            }
            let body = '';
            let closed = false;
            while (j < pattern.length) {
                if (pattern[j] === ']' && j > i + 1) {
                    closed = true;
                    break;
                }
                if (pattern[j] === '\\' && j + 1 < pattern.length) {
                    body += escapeRegex(pattern[j + 1]);
                    j += 2;
                    continue;
                }
                body += escapeRegex(pattern[j]);
                j++;
            }
            if (!closed) {
                out += '\\[';
            } else {
                out += `[${negate ? '^' : ''}${body}]`;
                i = j;
            }
        } else {
            out += escapeRegex(ch);
        }
    }
    return new RegExp(`^${out}$`);
}

/**
 * `quoted` marks the characters that came out of quoted text -- `"a*"` in a `case` pattern -- which
 * are literal: `case abc in "a*")` does not match `abc`, the way it does not in a host shell.
 */
function globMatch(pattern: string, text: string, starCrossesSlash: boolean, quoted?: boolean[]): boolean {
    return globToRegExp(pattern, starCrossesSlash, quoted).test(text);
}

/** True when `text` holds a pattern character that was not quoted: a quoted one is literal. */
function hasGlobChars(text: string, quoted?: boolean[]): boolean {
    for (let i = 0; i < text.length; i++) {
        if (quoted?.[i] === true) continue;
        const ch = text[i];
        if (ch === '*' || ch === '?') return true;
        if (ch === '[') {
            const close = text.indexOf(']', i + 1);
            if (close > i) return true;
        }
    }
    return false;
}

/** The components of a pattern, split on the unquoted `/`: in `'a/b'` the slash is one name. */
function patternComponents(field: string, quoted?: boolean[]): { text: string; quoted: boolean[] }[] {
    const parts: { text: string; quoted: boolean[] }[] = [];
    const mask = quoted ?? [];
    let start = 0;
    for (let i = 0; i < field.length; i++) {
        if (field[i] === '/' && mask[i] !== true) {
            parts.push({ text: field.slice(start, i), quoted: mask.slice(start, i) });
            start = i + 1;
        }
    }
    parts.push({ text: field.slice(start), quoted: mask.slice(start) });
    return parts;
}

/** `isDirectory` as a question: a path that is not there is not a directory. */
function isDir(fs: NonNullable<ShellState['fs']>, path: string): boolean {
    try {
        return fs.isDirectory(path);
    } catch {
        return false;
    }
}

/**
 * Pathname expansion of one field, one path component at a time: a pattern that carries a slash
 * expands its directory part first, then the name inside each directory that part reached. With no
 * match the field survives unchanged (nullglob is off), and so does a field whose pattern
 * characters were all quoted: `echo '*.txt'` prints `*.txt`, which is what keeps
 * `find . -name "*.txt"` working.
 */
function expandGlob(state: ShellState, field: string, quoted?: boolean[]): string[] {
    const fs = state.fs;
    if (!fs || !hasGlobChars(field, quoted)) return [field];
    const absolute = field.startsWith('/');
    const trailing = field.endsWith('/');
    const parts = patternComponents(field, quoted);
    // A leading `/` is the root the walk starts from, and a trailing one only asks for directories.
    if (absolute) parts.shift();
    if (trailing) parts.pop();
    if (parts.length === 0) return [field];
    let dirs: string[] = [absolute ? '/' : resolvePath(state, '.')];
    let stems: string[] = [absolute ? '/' : ''];
    for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        const last = p === parts.length - 1;
        const re = hasGlobChars(part.text, part.quoted) ? globToRegExp(part.text, false, part.quoted) : null;
        const nextDirs: string[] = [];
        const nextStems: string[] = [];
        const found: string[] = [];
        for (let d = 0; d < dirs.length; d++) {
            const dir = dirs[d];
            let entries: string[];
            try {
                entries = fs.listDirectory(dir);
            } catch {
                continue;
            }
            // `.` and `..` are names a pattern beginning with `.` matches, as the host has it
            const names = part.text.startsWith('.') ? ['.', '..', ...entries] : entries;
            for (const name of names) {
                if (name !== '.' && name !== '..' && name.startsWith('.') && !part.text.startsWith('.')) continue;
                const matched = re === null ? name === part.text : re.test(name);
                if (!matched) continue;
                const stem = stems[d] + name;
                if (!last) {
                    const child = joinName(dir, name);
                    if (isDir(fs, child)) {
                        nextDirs.push(child);
                        nextStems.push(stem + '/');
                    }
                    continue;
                }
                if (trailing) {
                    if (isDir(fs, joinName(dir, name))) found.push(stem + '/');
                } else {
                    found.push(stem);
                }
            }
        }
        if (last) return found.length === 0 ? [field] : found.sort();
        dirs = nextDirs;
        stems = nextStems;
        if (dirs.length === 0) return [field];
    }
    return [field];
}

/** One name under `dir`, with a single `/` between them. */
function joinName(dir: string, name: string): string {
    return (dir.endsWith('/') ? dir : dir + '/') + name;
}

/** One field after splitting, with the quoting of each of its characters. */
interface SplitField {
    text: string;
    /** Per character: it came out of quoted text, so pathname expansion reads it as a literal. */
    quoted: boolean[];
}

/**
 * Field splitting on IFS, keeping which characters came out of quoted text: a `*`, `?` or `[` that
 * was quoted is a literal character, and only an unquoted one makes the field a pattern.
 *
 * The rules of POSIX 2.6.5, the way this machine's /bin/sh applies them:
 *   - IFS white space at the two ends of the word is ignored, and a run of it inside the word is one
 *     delimiter: `IFS=' '; v=' a  b '` gives two fields, not four;
 *   - an IFS character that is not white space is a delimiter of its own, and the white space next
 *     to it belongs to that one delimiter: `IFS=' :'; v='a : b'` gives two fields;
 *   - two delimiters with nothing between them still leave the empty field between them, while one
 *     the word ends on opens no field after it: `IFS=:; v='a::b'` gives three and `v='a:'` gives one;
 *   - a null IFS splits nothing at all.
 *
 * `splitable` -- per character, and defaulting to every unquoted one -- says which characters may
 * end a field. Every character of a word holding no unquoted expansion is one: `IFS=:; echo a:b`
 * prints `a:b`, because splitting is something a shell does to the result of an expansion and not to
 * a word it was handed.
 */
function splitFieldsQuoted(text: string, quoted: boolean[], ifs: string, splitable?: boolean[]): SplitField[] {
    const canSplit = (i: number): boolean =>
        splitable === undefined ? quoted[i] !== true : splitable[i] === true;
    if (text === '') return [];
    /* A null IFS: no field splitting is performed, whatever the word holds. */
    if (ifs === '') return [{ text, quoted }];
    const ws: string[] = [...ifs].filter((ch) => ch === ' ' || ch === '\t' || ch === '\n');
    const seps: string[] = [...ifs].filter((ch) => ch !== ' ' && ch !== '\t' && ch !== '\n');
    /* IFS white space at the two ends of the word is not a delimiter, it is ignored. */
    let from = 0;
    let to = text.length;
    while (from < to && canSplit(from) && ws.includes(text[from])) from++;
    while (to > from && canSplit(to - 1) && ws.includes(text[to - 1])) to--;
    if (from >= to) return [];
    const fields: SplitField[] = [];
    let cur = '';
    let curQuoted: boolean[] = [];
    let ended = false;
    for (let i = from; i < to; ) {
        if (canSplit(i) && ws.includes(text[i])) {
            let j = i;
            while (j < to && canSplit(j) && ws.includes(text[j])) j++;
            /* White space standing next to a delimiter is one delimiter with it. */
            if (j < to && canSplit(j) && seps.includes(text[j])) j++;
            while (j < to && canSplit(j) && ws.includes(text[j])) j++;
            fields.push({ text: cur, quoted: curQuoted });
            cur = '';
            curQuoted = [];
            ended = true;
            i = j;
            continue;
        }
        if (canSplit(i) && seps.includes(text[i])) {
            let j = i + 1;
            while (j < to && canSplit(j) && ws.includes(text[j])) j++;
            fields.push({ text: cur, quoted: curQuoted });
            cur = '';
            curQuoted = [];
            ended = true;
            i = j;
            continue;
        }
        cur += text[i];
        curQuoted.push(quoted[i] === true);
        ended = false;
        i++;
    }
    /* A delimiter the word ends on opened no field after it, so `IFS=:; v='a:'` is one field. */
    if (!ended || cur !== '') fields.push({ text: cur, quoted: curQuoted });
    return fields;
}

/** Field splitting on IFS. Whitespace IFS characters collapse; the default IFS is ' \t\n'. */
function splitFields(text: string, quoted: boolean[], ifs: string): string[] {
    return splitFieldsQuoted(text, quoted, ifs).map((field) => field.text);
}

/** Single-quote style, the way `set`, `alias` and `declare -p` print values. */
function quoteSingle(value: string): string {
    if (value !== '' && /^[A-Za-z0-9_./:@+,=-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Double-quote style, the way `declare -x` and `export -p` print values. */
function quoteDouble(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

function joinLines(lines: string[]): string {
    return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Collapses `//`, `.` and `..` the way a shell's path resolution does. */
function normalizePath(path: string): string {
    const absolute = path.startsWith('/');
    const out: string[] = [];
    for (const part of path.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            out.pop();
            continue;
        }
        out.push(part);
    }
    return (absolute ? '/' : '') + out.join('/');
}

/**
 * Resolves `path` against `cwd` here rather than through `IFileSystem.resolvePath`: the container's
 * implementation normalises a relative path against the root, so `resolvePath('d1', '/work')` comes
 * back as `/d1`. Joining and normalising here matches what child.ts's own `shellPath` does.
 */
function resolvePath(state: ShellState, path: string): string {
    return normalizePath(path.startsWith('/') ? path : `${state.cwd}/${path}`);
}

function countLines(src: string, upto: number): number {
    let line = 1;
    for (let i = 0; i < upto && i < src.length; i++) if (src[i] === '\n') line++;
    return line;
}

/* ================================================================== *
 * 2. Variables
 * ================================================================== */

const ARRAY_RE = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/;
const ARRAY_ALL_RE = /^([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/;

function lookupScope(state: ShellState, name: string): Map<string, ShellVar> | undefined {
    for (let i = state.scopes.length - 1; i >= 0; i--) {
        if (state.scopes[i].has(name)) return state.scopes[i];
    }
    return undefined;
}

function getVar(state: ShellState, name: string): string | undefined {
    const all = ARRAY_ALL_RE.exec(name);
    if (all) {
        const values = arrayElements(state, `${all[1]}[0]`);
        return values.length === 0 ? undefined : values.join(' ');
    }
    /* `${v[0]}` on a name that is not an array is the name itself: a host's `FUNCNAME` inside a
       function is one string and `${FUNCNAME[0]}` is it, where reading `[0]` as a subscript of a
       name no array was made of answered nothing at all and left the function nameless. */
    const subscripted = ARRAY_RE.exec(name);
    if (subscripted !== null && subscripted[2] === '0') {
        const values = arrayElements(state, name);
        if (values.length > 0) return values[0];
        const scalar = lookupScope(state, subscripted[1])?.get(subscripted[1])?.value;
        if (scalar !== undefined) return scalar;
    }
    const scope = lookupScope(state, name);
    if (scope) return scope.get(name)?.value;
    if (name === 'PWD') return state.cwd;
    if (name === 'OLDPWD') return state.dirs[1];
    return undefined;
}

function isSet(state: ShellState, name: string): boolean {
    return getVar(state, name) !== undefined;
}

/** Assigns to the nearest scope already holding `name`, else the innermost (`local`) scope. */
function setVar(state: ShellState, name: string, value: string): boolean {
    const scope = lookupScope(state, name) ?? state.scopes[state.scopes.length - 1];
    const existing = scope.get(name);
    if (existing?.readonly) return false;
    /* The integer attribute `declare -i` set: the value assigned is arithmetic, so `n=n+1` behind
       a `declare -i n=1` leaves 2 and not the text `n+1`. A name the attribute was not set on keeps
       its text, and one whose value is not an expression keeps that too -- `declare -i n; n=x` is 0
       on a host, which is what an expression of one unset name evaluates to. */
    const stored = existing?.integer === true ? integerValue(state, value) : value;
    if (existing) existing.value = stored;
    else scope.set(name, { value: stored });
    return true;
}

/**
 * The value an assignment to a `declare -i` name leaves behind: the value of the text read as an
 * arithmetic expression, and the text itself where it is not one.
 */
function integerValue(state: ShellState, text: string): string {
    try {
        return String(Math.trunc(evalArith(state, text)));
    } catch (error) {
        if (error instanceof ArithError) return text;
        throw error;
    }
}

/**
 * Drops every indexed element of `name`: the elements a `a=(x y)` writes over, and the ones an
 * `unset a` takes with it. Only the keys this file's own array emulation made are touched, so a
 * `a[foo]` a caller set by hand is left where it is.
 */
function clearArray(state: ShellState, name: string): void {
    const prefix = `${name}[`;
    for (const scope of state.scopes) {
        for (const key of [...scope.keys()]) {
            if (!key.startsWith(prefix) || !key.endsWith(']')) continue;
            if (!/^-?[0-9]+$/.test(key.slice(prefix.length, -1))) continue;
            scope.delete(key);
        }
    }
}

/**
 * A compound assignment `a=(x y z)` or `a+=(w)`: the elements become `a[0]`, `a[1]`, ... in the
 * order they were written, and `[3]=d` among them names the index it stands on, as it does on a
 * host. The name itself is left holding its first element, which is what `$a` reads there --
 * `a=(x y z); echo $a` prints `x` -- and an assignment that is not an append drops the elements
 * the array held before it, so `a=(x y z); a=(w)` is an array of one.
 */
function assignArray(state: ShellState, name: string, elements: string[], append: boolean): boolean {
    if (!append) {
        clearArray(state, name);
        if (getVar(state, name) !== undefined && !setVar(state, name, '')) return false;
    }
    let index = append ? arrayElements(state, `${name}[0]`).length : 0;
    for (const element of elements) {
        const subscripted = /^\[([^\]]*)\]=([\s\S]*)$/.exec(element);
        if (subscripted !== null) {
            index = Number.parseInt(integerValue(state, subscripted[1]), 10);
            if (Number.isNaN(index)) index = 0;
            if (!setVar(state, `${name}[${index}]`, subscripted[2])) return false;
            index++;
            continue;
        }
        if (!setVar(state, `${name}[${index}]`, element)) return false;
        index++;
    }
    const first = lookupScope(state, `${name}[0]`)?.get(`${name}[0]`)?.value ?? '';
    setVar(state, name, first);
    return true;
}

function unsetVar(state: ShellState, name: string): boolean {
    const scope = lookupScope(state, name);
    if (!scope) return false;
    if (scope.get(name)?.readonly) return false;
    scope.delete(name);
    return true;
}

function varNames(state: ShellState): string[] {
    const seen = new Set<string>();
    for (const scope of state.scopes) for (const name of scope.keys()) seen.add(name);
    for (const name of ['PWD', 'OLDPWD']) if (!seen.has(name)) seen.add(name);
    return [...seen];
}

/** Indexed-array emulation: the elements of `a`, in index order. */
function arrayElements(state: ShellState, name: string): string[] {
    const match = ARRAY_RE.exec(name);
    if (!match) return [];
    const prefix = `${match[1]}[`;
    const found = new Map<number, string>();
    for (const scope of state.scopes) {
        for (const [key, variable] of scope) {
            if (!key.startsWith(prefix) || !key.endsWith(']')) continue;
            const raw = key.slice(prefix.length, -1);
            const index = Number.parseInt(raw, 10);
            if (Number.isNaN(index) || found.has(index)) continue;
            found.set(index, variable.value);
        }
    }
    return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
}

/* ================================================================== *
 * 3. Arithmetic
 * ================================================================== */

/**
 * An expression that will not evaluate. `token` is the text a host points at with `(error token is
 * "...")` -- `x=$((1+))` points at the `+` that has no operand behind it -- and it is left out where
 * a host names none.
 */
class ArithError extends Error {
    constructor(message: string, readonly token?: string) {
        super(message);
    }
}

type ArithToken = { t: 'num'; v: number; at: number } | { t: 'name'; v: string; at: number } | { t: 'op'; v: string; at: number };

function arithLex(text: string): ArithToken[] {
    const tokens: ArithToken[] = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === ' ' || ch === '\t' || ch === '\n') {
            i++;
            continue;
        }
        if (/[0-9]/.test(ch)) {
            let j = i;
            if (ch === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
                j = i + 2;
                while (j < text.length && /[0-9a-fA-F]/.test(text[j])) j++;
                tokens.push({ t: 'num', v: Number.parseInt(text.slice(i + 2, j), 16), at: i });
            } else {
                while (j < text.length && /[0-9]/.test(text[j])) j++;
                const digits = text.slice(i, j);
                const value = digits.length > 1 && digits.startsWith('0') ? Number.parseInt(digits, 8) : Number.parseInt(digits, 10);
                tokens.push({ t: 'num', v: Number.isNaN(value) ? 0 : value, at: i });
            }
            i = j;
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            let j = i;
            while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
            tokens.push({ t: 'name', v: text.slice(i, j), at: i });
            i = j;
            continue;
        }
        const three = text.slice(i, i + 3);
        if (three === '<<=' || three === '>>=') {
            tokens.push({ t: 'op', v: three, at: i });
            i += 3;
            continue;
        }
        const two = text.slice(i, i + 2);
        if (['**', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='].includes(two)) {
            tokens.push({ t: 'op', v: two, at: i });
            i += 2;
            continue;
        }
        /* The `:` of a conditional is an operator of its own, as it is in a host: without it `1?2:3`
           never parses, and a `:` anywhere else is the operator in an expression that has two. */
        if ('+-*/%<>&^|?!~,=():'.includes(ch)) {
            tokens.push({ t: 'op', v: ch, at: i });
            i++;
            continue;
        }
        throw new ArithError('syntax error: invalid arithmetic operator', text.slice(i));
    }
    return tokens;
}

class ArithParser {
    private pos = 0;
    /** Where the operator last eaten ends, so an operand that is not there can be named. */
    private lastEnd = -1;
    constructor(private readonly tokens: ArithToken[], private readonly state: ShellState, private readonly text: string) { }

    /** The text of the expression from `at` on, as a host quotes it in `(error token is "...")`. */
    private from(at: number): string {
        return this.text.slice(at);
    }

    /**
     * What a host points at when the operand behind an operator is missing: the text standing where
     * the operand should -- `$(( 1 + ))` points at the space behind the `+` -- and the operator's
     * own last character when nothing stands there, which is what `$((1+))` and `$((++))` point at.
     */
    private operandToken(): string {
        if (this.lastEnd < 0) return '';
        const rest = this.text.slice(this.lastEnd);
        return rest === '' ? this.text.slice(this.lastEnd - 1) : rest;
    }

    private peek(): ArithToken | undefined {
        return this.tokens[this.pos];
    }

    private next(): ArithToken | undefined {
        return this.tokens[this.pos++];
    }

    private eatOp(value: string): boolean {
        const token = this.peek();
        if (token && token.t === 'op' && token.v === value) {
            this.pos++;
            this.lastEnd = token.at + token.v.length;
            return true;
        }
        return false;
    }

    parse(): number {
        const value = this.comma();
        /* Nothing behind the value: `1 2` is two where one expression was, and a host says so as
           `syntax error in expression` and points at the second of them. */
        if (this.pos < this.tokens.length) throw new ArithError('syntax error in expression', this.from(this.tokens[this.pos].at));
        return value;
    }

    private comma(): number {
        let value = this.assign();
        while (this.eatOp(',')) value = this.assign();
        return value;
    }

    private assign(): number {
        const token = this.peek();
        if (token && token.t === 'name') {
            const save = this.pos;
            this.pos++;
            const op = this.peek();
            const compound = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='];
            if (op && op.t === 'op' && compound.includes(op.v)) {
                this.pos++;
                /* An operand the operator has none of is pointed at from the operator's last
                   character on -- `x=` and `x+=` both name `=` -- which is where a host points. */
                this.lastEnd = op.at + op.v.length - 1;
                const right = this.assign();
                const current = arithValueOf(this.state, token.v);
                let result: number;
                switch (op.v) {
                    case '=':
                        result = right;
                        break;
                    case '+=':
                        result = current + right;
                        break;
                    case '-=':
                        result = current - right;
                        break;
                    case '*=':
                        result = current * right;
                        break;
                    case '/=':
                    case '%=':
                        if (right === 0) throw new ArithError('division by 0');
                        result = op.v === '/=' ? Math.trunc(current / right) : current % right;
                        break;
                    case '&=':
                        result = current & right;
                        break;
                    case '|=':
                        result = current | right;
                        break;
                    case '^=':
                        result = current ^ right;
                        break;
                    case '<<=':
                        result = current << right;
                        break;
                    default:
                        result = current >> right;
                        break;
                }
                setVar(this.state, token.v, String(Math.trunc(result)));
                return Math.trunc(result);
            }
            this.pos = save;
        }
        return this.ternary();
    }

    private ternary(): number {
        const condition = this.logicalOr();
        if (this.eatOp('?')) {
            const at = this.tokens[this.pos]?.at ?? this.text.length;
            const whenTrue = this.comma();
            if (!this.eatOp(':')) throw new ArithError("`:' expected for conditional expression", this.from(at));
            /* A `:` with no branch behind it: a host asks for the expression it did not find and
               points at the `:` -- `x=$((1?2:))` is `expression expected (error token is ":")`,
               where an operand error would name the expression and the wrong token. */
            if (this.pos >= this.tokens.length) throw new ArithError('expression expected', ':');
            const whenFalse = this.comma();
            return condition !== 0 ? whenTrue : whenFalse;
        }
        return condition;
    }

    private logicalOr(): number {
        let left = this.logicalAnd();
        while (this.eatOp('||')) left = left !== 0 || this.logicalAnd() !== 0 ? 1 : 0;
        return left;
    }

    private logicalAnd(): number {
        let left = this.bitOr();
        while (this.eatOp('&&')) left = left !== 0 && this.bitOr() !== 0 ? 1 : 0;
        return left;
    }

    private bitOr(): number {
        let left = this.bitXor();
        while (this.eatOp('|')) left = left | this.bitXor();
        return left;
    }

    private bitXor(): number {
        let left = this.bitAnd();
        while (this.eatOp('^')) left = left ^ this.bitAnd();
        return left;
    }

    private bitAnd(): number {
        let left = this.equality();
        while (this.eatOp('&')) left = left & this.equality();
        return left;
    }

    private equality(): number {
        let left = this.relational();
        for (;;) {
            if (this.eatOp('==')) left = left === this.relational() ? 1 : 0;
            else if (this.eatOp('!=')) left = left !== this.relational() ? 1 : 0;
            else return left;
        }
    }

    private relational(): number {
        let left = this.shift();
        for (;;) {
            if (this.eatOp('<=')) left = left <= this.shift() ? 1 : 0;
            else if (this.eatOp('>=')) left = left >= this.shift() ? 1 : 0;
            else if (this.eatOp('<')) left = left < this.shift() ? 1 : 0;
            else if (this.eatOp('>')) left = left > this.shift() ? 1 : 0;
            else return left;
        }
    }

    private shift(): number {
        let left = this.additive();
        for (;;) {
            if (this.eatOp('<<')) left = left << this.additive();
            else if (this.eatOp('>>')) left = left >> this.additive();
            else return left;
        }
    }

    private additive(): number {
        let left = this.multiplicative();
        for (;;) {
            if (this.eatOp('+')) left = left + this.multiplicative();
            else if (this.eatOp('-')) left = left - this.multiplicative();
            else return left;
        }
    }

    private multiplicative(): number {
        let left = this.power();
        for (;;) {
            if (this.eatOp('*')) left = left * this.power();
            else if (this.eatOp('/')) {
                const at = this.tokens[this.pos]?.at ?? this.text.length;
                const right = this.power();
                if (right === 0) throw new ArithError('division by 0', this.from(at));
                left = Math.trunc(left / right);
            } else if (this.eatOp('%')) {
                const at = this.tokens[this.pos]?.at ?? this.text.length;
                const right = this.power();
                if (right === 0) throw new ArithError('division by 0', this.from(at));
                left = left % right;
            } else return left;
        }
    }

    private power(): number {
        const base = this.unary();
        if (this.eatOp('**')) return Math.pow(base, this.power());
        return base;
    }

    private unary(): number {
        if (this.eatOp('!')) return this.unary() === 0 ? 1 : 0;
        if (this.eatOp('~')) return ~this.unary();
        if (this.eatOp('-')) return -this.unary();
        if (this.eatOp('+')) return this.unary();
        return this.preIncrement();
    }

    private preIncrement(): number {
        if (this.eatOp('++') || this.eatOp('--')) {
            const op = this.tokens[this.pos - 1].v;
            const token = this.next();
            if (!token || token.t !== 'name') throw new ArithError('syntax error: operand expected', this.operandToken());
            const value = arithValueOf(this.state, token.v) + (op === '++' ? 1 : -1);
            setVar(this.state, token.v, String(value));
            return value;
        }
        return this.postfix();
    }

    private postfix(): number {
        const token = this.next();
        /* No operand at all: the operator behind it is the one that has none, and a host names that
           -- `x=$((1+))` points at the `+`. */
        if (!token) throw new ArithError('syntax error: operand expected', this.operandToken());
        if (token.t === 'num') {
            /* A number is nothing `++` or `--` can stand behind, and with nothing behind the
               operator either a host names the operator as the one whose operand is missing --
               `$((1 ++ ))` is `operand expected (error token is " ")`. */
            const inc = this.peek();
            if (inc !== undefined && inc.t === 'op' && (inc.v === '++' || inc.v === '--') && this.tokens[this.pos + 1] === undefined) {
                this.pos++;
                this.lastEnd = inc.at + inc.v.length;
                throw new ArithError('syntax error: operand expected', this.operandToken());
            }
            return token.v;
        }
        if (token.t === 'name') {
            const here = this.pos;
            if (this.eatOp('++') || this.eatOp('--')) {
                const op = this.tokens[here].v;
                const before = arithValueOf(this.state, token.v);
                setVar(this.state, token.v, String(before + (op === '++' ? 1 : -1)));
                return before;
            }
            return arithValueOf(this.state, token.v);
        }
        if (token.t === 'op' && token.v === '(') {
            const value = this.comma();
            if (!this.eatOp(')')) throw new ArithError('syntax error: `)` expected', this.from(token.at));
            return value;
        }
        /* An operator where an operand belongs: a host points at the expression from it on, so
           `$((1+*2))` points at `*2` and not at the `*` alone. */
        throw new ArithError('syntax error: operand expected', this.from(token.at));
    }
}

function arithValueOf(state: ShellState, name: string): number {
    const raw = getVar(state, name);
    if (raw === undefined || raw === '') return 0;
    const text = raw.trim();
    if (/^-?[0-9]+$/.test(text)) return Number.parseInt(text, 10);
    if (/^0[xX][0-9a-fA-F]+$/.test(text)) return Number.parseInt(text, 16);
    try {
        return evalArith(state, text);
    } catch {
        return 0;
    }
}

/** Evaluates `$(( ))`, `let` and `(( ))` arithmetic. Throws `ArithError` on a bad expression. */
export function evalArith(state: ShellState, expression: string): number {
    /* Nothing between the parentheses is the number zero it evaluates to -- `echo $(( ))` prints `0`
       and `x=$(( ))` leaves 0 -- not the operand error an empty expression would otherwise be. */
    if (expression.trim() === '') return 0;
    return new ArithParser(arithLex(expression), state, expression).parse();
}

/**
 * An arithmetic error the way a host writes it: the shell's name, the expression, the reason, and
 * the text it points at -- `/bin/sh: 1+: syntax error: operand expected (error token is "+")`.
 * `label` is the word a host puts in front of the expression when one was named with it, as `let`
 * is: `/bin/sh: let: x=1+: syntax error: operand expected (error token is "+")`.
 */
function arithDiagnostic(state: ShellState, expression: string, error: ArithError, label?: string): string {
    /* The expression as a host prints it: the text between the `$(` and the `))`, with the white
       space it opens with left out -- `$(( 1 + ))` is `1 + :` and not ` 1 + :`. */
    const text = expression.replace(/^[ \t\n]+/, '');
    const at = label === undefined ? '' : `${label}: `;
    const token = error.token === undefined || error.token === '' ? '' : ` (error token is "${error.token}")`;
    return `${state.shellName}: ${at}${text}: ${error.message}${token}`;
}

/* ================================================================== *
 * 4. Words and the parser
 * ================================================================== */

interface VarRef {
    raw: string;
    name: string;
    /** '' | '-' | ':-' | '=' | ':=' | '+' | ':+' | '?' | ':?' | '#' | '##' | '%' | '%%' | '/' | '//' | 'len' | 'substr' */
    op: string;
    arg: string;
}

type Part =
    | { t: 'lit'; v: string }
    | { t: 'sq'; v: string }
    | { t: 'dq'; parts: Part[] }
    | { t: 'var'; ref: VarRef }
    | { t: 'cmd'; script: string }
    | { t: 'arith'; expr: string };

type Word = Part[];

interface Redirect {
    fd: number;
    /** `<<<` is a here-string: the word itself is the command's standard input. */
    op: '>' | '>>' | '<' | '&>' | '&>>' | '>&' | '<&' | '<<' | '<<-' | '<<<';
    target: Word;
    /**
     * The body of a `<<` or `<<-`, exactly as it was written behind the command line -- the lines
     * of the body ended by the delimiter's own line -- which `readHeredocs` keeps because the
     * command's `source` stops where the line stops and so carries none of it. A job is run from
     * that source, and a `cat <<EOF &` without this ran on an empty standard input.
     */
    heredoc?: string;
    /**
     * Where in the script that body starts, so a job can tell a body its source already holds from
     * one that stands behind it: a `( cat <<EOF\nb\nEOF\n )` spans its own body, while a
     * `cat <<EOF &` ends before its body begins.
     */
    heredocFrom?: number;
}

interface Assignment {
    name: string;
    append: boolean;
    value: Word;
    /**
     * The words of a compound assignment `a=(x y z)`, empty for the ordinary `a=x`. They are the
     * elements in the order they were written, and `[3]=d` among them names its own index, as it
     * does in a host shell.
     */
    array?: Word[];
    /** True for `a+=(w)`: the elements are appended behind the ones the array already holds. */
    arrayAppend?: boolean;
}

type CommandBody =
    | { t: 'simple'; assigns: Assignment[]; words: Word[]; redirects: Redirect[] }
    | { t: 'if'; branches: { cond: Node[]; body: Node[] }[]; else_?: Node[]; redirects: Redirect[] }
    | { t: 'for'; name: string; words: Word[] | null; body: Node[]; redirects: Redirect[] }
    /** bash's arithmetic loop: `for ((init; test; next)); do ...; done` */
    | { t: 'forarith'; expr: string; body: Node[]; redirects: Redirect[] }
    /** The arithmetic command `(( ))`: the status is 0 when the expression is non-zero, 1 when it is. */
    | { t: 'arithcmd'; expr: string; redirects: Redirect[] }
    | { t: 'while'; negate: boolean; cond: Node[]; body: Node[]; redirects: Redirect[] }
    | { t: 'case'; word: Word; items: { patterns: Word[]; body: Node[] }[]; redirects: Redirect[] }
    | { t: 'group'; body: Node[]; redirects: Redirect[] }
    | { t: 'subshell'; body: Node[]; redirects: Redirect[] }
    /** bash's conditional command `[[ ... ]]`: its words are not split, globbed or reordered. */
    | { t: 'cond'; words: Word[]; redirects: Redirect[] }
    | { t: 'function'; name: string; body: Command; text?: string };

type Command = CommandBody & { line: number };

interface Node {
    /** `!` in front of the pipeline. */
    bang: boolean;
    commands: Command[];
    /** The operator joining this pipeline to the one before it. */
    op: '&&' | '||' | null;
    /** `&` after the pipeline: the shell does not wait for it, and the host starts it as a job. */
    background?: boolean;
    /** The pipeline as it was written: the source a job started from it is handed to run. */
    source?: string;
    /** Where in the script that source stopped, so a job can tell what it holds from what follows. */
    end?: number;
}

/** Words bash reserves: in command position they end the construct instead of naming a command. */
const RESERVED_WORDS = new Set(['then', 'else', 'elif', 'fi', 'do', 'done', 'esac', 'in', '{', '}', '!']);

class ShellSyntaxError extends Error {
    /**
     * Where in the script the parser stood when it gave up. A host reports the LINE that position
     * is on, not the whole script, so the parser records it as it throws. `Parser.parse` fills it
     * in, which is why a freshly built one may carry none.
     */
    at: number | undefined;
    constructor(message: string) {
        super(message);
        this.name = 'ShellSyntaxError';
    }
}

class UnsetVariableError extends Error {}

class BreakSignal {
    constructor(readonly count: number) {}
}
class ContinueSignal {
    constructor(readonly count: number) {}
}
class ReturnSignal {
    constructor(readonly code: number) {}
}
class ExitSignal {
    constructor(readonly code: number) {}
}

function assignmentOf(text: string): { name: string; append: boolean; rest: string } | null {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]]*\])?)([+]?)=([\s\S]*)$/.exec(text);
    if (!match) return null;
    return { name: match[1] + match[2], append: match[3] === '+', rest: match[4] };
}

/** Parses the inside of `${...}`. */
function parseVarRef(body: string): VarRef {
    const raw = body;
    if (body.startsWith('#')) {
        const rest = body.slice(1);
        if (/^[@*#?]$/.test(rest)) return { raw, name: rest, op: 'len', arg: '' };
        const arrayAll = /^([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]$/.exec(rest);
        if (arrayAll) return { raw, name: `${arrayAll[1]}[@]`, op: 'len', arg: '' };
        /* `${#a[1]}` is the length of the one element, as `${#a[@]}` is the number of them:
           `a=(x y z); echo ${#a[1]}` is a host's `1`, where reading the `1` as part of a name
           nothing was assigned to answered an empty word. */
        if (/^[A-Za-z_][A-Za-z0-9_]*\[[^\]]*\]$/.test(rest)) return { raw, name: rest, op: 'len', arg: '' };
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rest)) return { raw, name: rest, op: 'len', arg: '' };
        if (/^[0-9]$/.test(rest)) return { raw, name: rest, op: 'len', arg: '' };
    }
    /* `${x:3}` is a substring and `${x:-3}` is a default, and a host tells them apart by the one
       character behind the colon -- `-`, `=`, `+` and `?` are the operators that name a default and
       every other character, a space and a digit among them, opens a substring. So the colon is
       looked at before any operator is searched for: a scan that found the `-` first read
       `${v: -3}` as the default `3` and not as the last three characters of `hello`. */
    const colon = body.indexOf(':');
    if (colon > 0 && !'-+=?'.includes(body[colon + 1] ?? '')) {
        return { raw, name: body.slice(0, colon), op: 'substr', arg: body.slice(colon + 1) };
    }
    const operators = ['##', '%%', ':-', ':=', ':+', ':?', '//', '#', '%', '-', '=', '+', '?', '/'];
    let cut = -1;
    let op = '';
    for (const operator of operators) {
        const at = body.indexOf(operator, 1);
        if (at > 0 && (cut === -1 || at < cut || (at === cut && operator.length > op.length))) {
            cut = at;
            op = operator;
        }
    }
    /* `substr` is not an operator that was written: the `:` that opened it was, one character long,
       so the argument starts one past *it* and not one past the name this file gives the operator.
       Reading the name's length sliced the argument away -- `${v:1:3}` asked for six characters
       behind the `:` and got none, which is the whole `hello` and not the `ell` a host prints. */
    const operator = op === 'substr' ? ':' : op;
    if (cut > 0) return { raw, name: body.slice(0, cut), op, arg: body.slice(cut + operator.length) };
    return { raw, name: body, op: '', arg: '' };
}

/** The literal text of a word with all quoting removed: keywords, names, `case` labels. */
function rawText(word: Word): string {
    let out = '';
    for (const part of word) {
        if (part.t === 'lit' || part.t === 'sq') out += part.v;
        else if (part.t === 'dq') out += rawText(part.parts);
        else if (part.t === 'var') out += part.ref.raw;
        else if (part.t === 'arith') out += `$((${part.expr}))`;
        else if (part.t === 'cmd') out += `$(${part.script})`;
    }
    return out;
}

/** Re-lexes the right-hand side of an assignment, which was split off at the `=`. */
function parseValueWord(text: string): Word {
    return [{ t: 'dq', parts: lexParts(text) }];
}

/** Lexes a bare text into word parts (no operator handling): used for assignment values. */
function lexParts(text: string, keepSpaces = false, keepParens = false): Part[] {
    const lexer = new Parser(text, null, keepSpaces, keepParens);
    const word = lexer.readWordPublic();
    return word ?? [];
}

/** The escapes a host decodes inside `$'...'` that are one character behind the backslash. */
const ANSI_C_ESCAPES: Record<string, string> = {
    a: '\u0007', b: '\b', e: '\u001b', E: '\u001b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
    '\\': '\\', "'": "'", '"': '"', '?': '?'
};

/**
 * Reads a `$'...'` body from `at`, the character behind the opening quote.
 *
 * Returns the decoded text and the index behind the closing quote. An escape a host does not know
 * keeps its backslash -- `echo $'a\qb'` is `a\qb` -- and a body with no closing quote takes what
 * there is, as a host takes it to the end of the line.
 */
function readAnsiC(src: string, at: number): { text: string; at: number } {
    let text = '';
    let i = at;
    while (i < src.length) {
        const ch = src[i];
        if (ch === "'") return { text, at: i + 1 };
        if (ch !== '\\') {
            text += ch;
            i++;
            continue;
        }
        i++;
        const esc = src[i];
        if (esc === undefined) {
            text += '\\';
            break;
        }
        if (esc === '0') {
            let digits = '';
            let j = i + 1;
            while (j < src.length && digits.length < 3 && src[j] >= '0' && src[j] <= '7') {
                digits += src[j];
                j++;
            }
            text += String.fromCharCode(Number.parseInt(digits === '' ? '0' : digits, 8));
            i = j;
            continue;
        }
        if (esc === 'x' || esc === 'u' || esc === 'U') {
            const max = esc === 'x' ? 2 : esc === 'u' ? 4 : 8;
            let digits = '';
            let j = i + 1;
            while (j < src.length && digits.length < max && /[0-9a-fA-F]/.test(src[j])) {
                digits += src[j];
                j++;
            }
            if (digits === '') {
                text += '\\' + esc;
                i = j;
                continue;
            }
            text += String.fromCodePoint(Number.parseInt(digits, 16));
            i = j;
            continue;
        }
        /* `\cX` is the control character: `\cA` is 1, `\c@` is NUL and `\c?` is DEL. */
        if (esc === 'c') {
            const control = src[i + 1];
            i += 2;
            if (control === undefined) {
                text += '\\c';
                break;
            }
            const upper = control.toUpperCase();
            text += upper === '?' ? '\u007f' : String.fromCharCode(upper.charCodeAt(0) - 64);
            continue;
        }
        text += ANSI_C_ESCAPES[esc] ?? '\\' + esc;
        i++;
    }
    return { text, at: i };
}

/** The text of a `${x:-word}` modifier: whitespace inside it belongs to the word. */
function modifierText(text: string): Word {
    return [{ t: 'dq', parts: lexParts(text, true) }];
}

/**
 * The text of an arithmetic expression: whitespace *and parentheses* belong to it.
 *
 * `readWord` stops on `(` and `)` because they open a subshell, so the modifier's own lexing cut
 * `$(( 2 * (3 + 1) ))` off at the first paren and left `2 * ` -- and `$(( (3) ))` empty -- which
 * failed as `syntax error: operand expected`.
 */
function arithText(text: string): Word {
    return [{ t: 'dq', parts: lexParts(text, true, true) }];
}

class Parser {
    private pos = 0;
    /** True when whitespace must stay inside the word: `${x:-a b}` and `$((a + b))`. */
    private readonly keepSpaces: boolean;
    /** True when parentheses must stay inside the word too: an arithmetic expression's own `( )`. */
    private readonly keepParens: boolean;
    private static readonly STOP = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
    private heredocs: { delimiter: string; strip: boolean; expand: boolean; target: Redirect }[] = [];
    private expandedAliases = new Set<string>();

    constructor(src: string, state: ShellState | null, keepSpaces = false, keepParens = false) {
        this.src = src;
        this.state = state;
        this.keepSpaces = keepSpaces;
        this.keepParens = keepParens;
    }

    private src: string;
    private readonly state: ShellState | null;

    /** Parses a whole script. Throws `ShellSyntaxError`, which the engine reports as status 2. */
    parse(): Node[] {
        try {
            return this.parseScript();
        } catch (error) {
            /* Where the parser stood when it gave up, so the report names the line it stands on
               and not the whole script. The outermost parse is the last to see the error, and it
               is the one whose `pos` is measured against the script a caller handed over -- an
               inner parse of a substitution measures against its own shorter source. */
            if (error instanceof ShellSyntaxError) error.at = this.pos;
            throw error;
        }
    }

    private parseScript(): Node[] {
        const nodes = this.parseList([]);
        this.skipSpace(true);
        if (this.pos < this.src.length) {
            const rest = this.src.slice(this.pos).trim();
            /* A `;;` nothing is looking for -- the one a `case` item inside a `$( )` leaves behind,
               because the `)` of its pattern is the one that closed the substitution -- is the token
               a host names, and not the `newline` splitting the rest on whitespace and `;` gives. */
            const token = rest.startsWith(';;') ? ';;' : rest.split(/[\s;]/)[0] || 'newline';
            throw new ShellSyntaxError(`syntax error near unexpected token \`${token}'`);
        }
        return nodes;
    }

    /** Public wrapper so `lexParts` can read one word from a bare string. */
    readWordPublic(): Word | null {
        return this.readWord();
    }

    /**
     * Public wrapper so a caller can read every word of a bare string, split on whitespace: the
     * elements of a compound assignment `a=(x y z)` are the words of the text between the parens.
     */
    readAllWordsPublic(): Word[] {
        const words: Word[] = [];
        for (;;) {
            this.skipSpace(true);
            if (this.pos >= this.src.length) break;
            const word = this.readWord();
            if (word === null) break;
            words.push(word);
        }
        return words;
    }

    private eof(): boolean {
        return this.pos >= this.src.length;
    }

    private here(): string {
        return this.src[this.pos] ?? '';
    }

    private skipSpace(includeNewlines: boolean): void {
        while (this.pos < this.src.length) {
            const ch = this.src[this.pos];
            if (ch === ' ' || ch === '\t' || (includeNewlines && ch === '\n')) {
                this.pos++;
                continue;
            }
            if (ch === '\\' && this.src[this.pos + 1] === '\n') {
                this.pos += 2;
                continue;
            }
            if (ch === '#') {
                const end = this.src.indexOf('\n', this.pos);
                this.pos = end === -1 ? this.src.length : end;
                continue;
            }
            return;
        }
    }

    private keywordAt(at: number, word: string): boolean {
        if (!this.src.startsWith(word, at)) return false;
        const after = this.src[at + word.length];
        return after === undefined || Parser.STOP.has(after);
    }

    private readDelimited(open: string, close: string): string {
        let depth = 1;
        let i = this.pos;
        while (i < this.src.length && depth > 0) {
            const ch = this.src[i];
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if (ch === "'") {
                const end = this.src.indexOf("'", i + 1);
                i = end === -1 ? this.src.length : end + 1;
                continue;
            }
            if (ch === '"') {
                i++;
                while (i < this.src.length && this.src[i] !== '"') i += this.src[i] === '\\' ? 2 : 1;
                i++;
                continue;
            }
            if (this.src.startsWith(open, i)) {
                depth++;
                i += open.length;
                continue;
            }
            if (this.src.startsWith(close, i)) {
                depth--;
                i += close.length;
                if (depth === 0) break;
                continue;
            }
            i++;
        }
        const body = this.src.slice(this.pos, i - (depth === 0 ? close.length : 0));
        this.pos = i;
        return body;
    }

    /**
     * Reads a backquoted command substitution: the body ends at the next *unescaped* backquote.
     *
     * A backquote is its own delimiter, so the one that closes the substitution is not an opener --
     * read as one, as `readDelimited` reads it, the body swallowed the rest of the line and every
     * command behind the substitution was lost. Inside the body a backslash escapes only `$`, a
     * backquote, a backslash and a newline; before anything else it is an ordinary character, which
     * is why a body is kept whole and handed to a fresh parser rather than unescaped here.
     */
    private readBackquote(): string {
        let body = '';
        while (this.pos < this.src.length) {
            const ch = this.src[this.pos];
            if (ch === '`') {
                this.pos++;
                return body;
            }
            if (ch === '\\') {
                const next = this.src[this.pos + 1];
                if (next === undefined) {
                    body += ch;
                    this.pos++;
                    continue;
                }
                if (next === '\n') {
                    this.pos += 2;
                    continue;
                }
                /* A backslash escapes a backquote into a nested substitution -- ``echo `echo \`echo
                   deep\`` `` prints `deep` -- and escapes `$` and `\` into themselves; before
                   anything else it is an ordinary character, and before a newline it is a
                   continuation. The escapes are kept, because the body is handed to a fresh parser
                   rather than unescaped here. */
                if (next === '`') {
                    body += next;
                    this.pos += 2;
                    continue;
                }
                /* The backslash goes and the character behind it is left live: the body is a script
                   a fresh parser reads, so `echo \$x` runs `echo $x`, which then expands -- a kept
                   `\$` was a literal `$x` that never expanded -- and `echo \\` runs `echo \`, whose
                   trailing backslash is a line that prints nothing. */
                if ('$\\'.includes(next)) {
                    body += next;
                    this.pos += 2;
                    continue;
                }
                body += ch;
                this.pos++;
                continue;
            }
            body += ch;
            this.pos++;
        }
        throw new ShellSyntaxError('unexpected EOF while looking for matching `\'');
    }

    /**
     * Reads a `$( )` command substitution: the body ends at the `)` closing the one that opened it,
     * however many parentheses the commands inside it open and close on the way.
     *
     * Counting only `$(` and `)` -- which is what `readDelimited` does -- stops at the first `)` of
     * the command's own: `$( (exit 5) & wait $! )` ended at the `)` of `(exit 5)` and the rest of
     * the substitution was left behind as a syntax error. Parentheses inside single quotes, double
     * quotes and backquotes are not counted, because a command inside them does not open one.
     */
    private readCommandSubst(): string {
        const start = this.pos;
        let depth = 0;
        let i = this.pos;
        while (i < this.src.length) {
            const ch = this.src[i];
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if (ch === "'") {
                const end = this.src.indexOf("'", i + 1);
                i = end === -1 ? this.src.length : end + 1;
                continue;
            }
            if (ch === '"') {
                i++;
                while (i < this.src.length && this.src[i] !== '"') i += this.src[i] === '\\' ? 2 : 1;
                i++;
                continue;
            }
            if (ch === '`') {
                i++;
                while (i < this.src.length && this.src[i] !== '`') i += this.src[i] === '\\' ? 2 : 1;
                i++;
                continue;
            }
            /* A `#` that starts a word opens a comment, and a `)` inside one is not the close of
               anything: `echo $( echo a # )` still prints `a`. It runs to the end of its line, and
               the newline behind it ends the comment, not the substitution. */
            if (ch === '#' && (i === start || /[\s;|&<>({]/.test(this.src[i - 1] ?? ''))) {
                const end = this.src.indexOf('\n', i);
                i = end === -1 ? this.src.length : end + 1;
                continue;
            }
            if (ch === '(') {
                depth++;
                i++;
                continue;
            }
            if (ch === ')') {
                if (depth === 0) {
                    this.pos = i + 1;
                    return this.src.slice(start, i);
                }
                depth--;
                i++;
                continue;
            }
            i++;
        }
        /* Nothing closed it -- a comment that swallowed the last `)` leaves one unmatched, and the
           host names that rather than taking the rest of the line as the body. */
        this.pos = this.src.length;
        throw new ShellSyntaxError("unexpected EOF while looking for matching `)'");
    }

    /** Reads `${ ... }`, honouring nested braces and quotes. */
    private readBraced(): string {
        let depth = 1;
        let i = this.pos;
        while (i < this.src.length) {
            const ch = this.src[i];
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if (ch === "'") {
                const close = this.src.indexOf("'", i + 1);
                i = close === -1 ? this.src.length : close + 1;
                continue;
            }
            if (ch === '"') {
                i++;
                while (i < this.src.length && this.src[i] !== '"') i += this.src[i] === '\\' ? 2 : 1;
                i++;
                continue;
            }
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) break;
            }
            i++;
        }
        const body = this.src.slice(this.pos, i);
        this.pos = Math.min(i + 1, this.src.length);
        /* A `${` no `}` ever closed runs to the end of the script, and that is a syntax error a
           host reports: `echo ${x` is `unexpected EOF while looking for matching `}'` and a status
           of 2, where reading the name as complete ran the echo and printed an empty line. */
        if (depth !== 0) throw new ShellSyntaxError("unexpected EOF while looking for matching `}'");
        return body;
    }

    private readDollar(): Part {
        const next = this.src[this.pos + 1];
        this.pos++;
        if (next === '(') {
            if (this.src[this.pos + 1] === '(') {
                this.pos += 2;
                return { t: 'arith', expr: this.readDelimited('$(', '))') };
            }
            this.pos++;
            return { t: 'cmd', script: this.readCommandSubst() };
        }
        if (next === '{') {
            this.pos++;
            return { t: 'var', ref: parseVarRef(this.readBraced()) };
        }
        /* `$[ ]` is the arithmetic a shell wrote before POSIX gave it the `$(( ))` it writes now,
           and a host still expands it: `echo $[1+1]` prints `2`, and the operand error a bad
           expression is names the same text either way -- `$[1+]` is `1+: syntax error: operand
           expected`. Left alone as text, `echo $[1+1]` printed `$[1+1]` and `$[1+]` was a command
           nothing could find. */
        if (next === '[') {
            this.pos++;
            return { t: 'arith', expr: this.readDelimited('$[', ']') };
        }
        /* `$'...'`: ANSI-C quoting. The escapes are decoded and nothing inside expands, so the whole
           run is one literal part -- `echo $'a\tb'` prints the tab a host prints, and a `)` inside
           one is text, which is why `x=$( echo $'a)b' )` is `[a)b]`. */
        if (next === "'") {
            const decoded = readAnsiC(this.src, this.pos + 1);
            this.pos = decoded.at;
            return { t: 'sq', v: decoded.text };
        }
        if (next !== undefined && /[A-Za-z_0-9@*#?!$-]/.test(next)) {
            let i = this.pos;
            /* `$-` is one character like `$?` and `$$` are: left out of this set it was read as a
               name of no characters at all, and a bare `$` next to a literal `-` was what expanded. */
            if (/[0-9@*#?!$-]/.test(next)) i = this.pos + 1;
            else while (i < this.src.length && /[A-Za-z0-9_]/.test(this.src[i])) i++;
            const name = this.src.slice(this.pos, i);
            this.pos = i;
            return { t: 'var', ref: parseVarRef(name) };
        }
        return { t: 'lit', v: '$' };
    }

    /** Reads one word, keeping quoted parts apart so expansion knows what is quoted. */
    private readWord(): Word | null {
        const parts: Part[] = [];
        let literal = '';
        const flush = (): void => {
            if (literal !== '') {
                parts.push({ t: 'lit', v: literal });
                literal = '';
            }
        };
        while (this.pos < this.src.length) {
            const ch = this.src[this.pos];
            if (Parser.STOP.has(ch) && !(this.keepSpaces && (ch === ' ' || ch === '\t')) && !(this.keepParens && (ch === '(' || ch === ')'))) break;
            if (ch === '\\') {
                const next = this.src[this.pos + 1];
                if (next === '\n') {
                    this.pos += 2;
                    continue;
                }
                /* A brace the backslash escaped is not the brace that opens a group, and the
                   backslash itself is gone from the word by the time it is expanded, so the mark
                   goes in its place: `echo a\{b,c\}d` is one word, `a{b,c}d`. */
                if (next === '{' || next === '}') {
                    literal += ESCAPED_BRACE + next;
                    this.pos += 2;
                    continue;
                }
                literal += next ?? '';
                this.pos += 2;
                continue;
            }
            if (ch === "'") {
                flush();
                const close = this.src.indexOf("'", this.pos + 1);
                if (close === -1) throw new ShellSyntaxError("unexpected EOF while looking for matching `''");
                parts.push({ t: 'sq', v: this.src.slice(this.pos + 1, close) });
                this.pos = close + 1;
                continue;
            }
            if (ch === '"') {
                flush();
                this.pos++;
                const inner: Part[] = [];
                let text = '';
                while (this.pos < this.src.length && this.src[this.pos] !== '"') {
                    const cur = this.src[this.pos];
                    if (cur === '\\' && '"\\$`'.includes(this.src[this.pos + 1] ?? '')) {
                        text += this.src[this.pos + 1];
                        this.pos += 2;
                        continue;
                    }
                    if (cur === '$') {
                        if (text !== '') {
                            inner.push({ t: 'lit', v: text });
                            text = '';
                        }
                        inner.push(this.readDollar());
                        continue;
                    }
                    if (cur === '`') {
                        if (text !== '') {
                            inner.push({ t: 'lit', v: text });
                            text = '';
                        }
                        this.pos++;
                        inner.push({ t: 'cmd', script: this.readBackquote() });
                        continue;
                    }
                    text += cur;
                    this.pos++;
                }
                /* A `"` no second `"` ever closed runs to the end of the script, and that is the
                   syntax error a host reports -- `echo "abc` is `unexpected EOF while looking for
                   matching `"'` and a status of 2, where taking the quote as closed at the end of
                   the input printed `abc`. A word that really ends in `"` leaves the loop on it. */
                if (this.pos >= this.src.length) throw new ShellSyntaxError("unexpected EOF while looking for matching `\"'");
                this.pos++;
                if (text !== '') inner.push({ t: 'lit', v: text });
                parts.push({ t: 'dq', parts: inner });
                continue;
            }
            if (ch === '`') {
                flush();
                this.pos++;
                parts.push({ t: 'cmd', script: this.readBackquote() });
                continue;
            }
            if (ch === '$') {
                flush();
                parts.push(this.readDollar());
                continue;
            }
            literal += ch;
            this.pos++;
        }
        flush();
        return parts.length === 0 ? null : parts;
    }

    private readRedirect(fd: number, op: Redirect['op']): Redirect {
        this.skipSpace(false);
        const start = this.pos;
        const word = this.readWord();
        if (!word) throw new ShellSyntaxError("syntax error near unexpected token `newline'");
        const redirect: Redirect = { fd, op, target: word };
        if (op === '<<' || op === '<<-') {
            this.heredocs.push({ delimiter: rawText(word), strip: op === '<<-', expand: this.expandsHeredoc(word, this.src.slice(start, this.pos)), target: redirect });
        }
        return redirect;
    }

    /**
     * True for a here-document whose delimiter was written unquoted: `<<EOF` expands the variables
     * and substitutions of its body, while `<<'EOF'`, `<<"EOF"` and `<<\EOF` take it literally.
     *
     * The backslash counts as quoting here as it does in a shell, and it is one the parsed word has
     * already lost -- `\EOF` and `EOF` leave the same parts behind -- so the source the delimiter was
     * read from is what says whether there was one.
     */
    private expandsHeredoc(word: Word, raw = ''): boolean {
        if (/['"\\]/.test(raw)) return false;
        for (const part of word) if (part.t === 'sq' || part.t === 'dq') return false;
        return true;
    }

    /**
     * The body of an expanding here-document, as one word: its variables, substitutions and
     * arithmetic are expanded when the command is run, as a host shell expands them.
     *
     * The newline that ends each line is put back as literal text: a word is read a line at a time,
     * and a body is the lines it was written with, joined by the newlines between them.
     */
    private heredocWord(text: string): Word {
        /* A here-document body is not a word: the quotes are ordinary characters in it -- `cat <<EOF`
           with a body of `'abc'` prints `'abc'` -- and a backslash keeps its meaning only before
           `$`, a backquote, a backslash and the newline it continues. Lexing each line as a word
           took the quotes as quoting and lost the continuation, so the body is scanned here. */
        const savedSrc = this.src;
        const savedPos = this.pos;
        this.src = text;
        this.pos = 0;
        const parts: Part[] = [];
        let literal = '';
        const flush = (): void => {
            if (literal !== '') {
                parts.push({ t: 'lit', v: literal });
                literal = '';
            }
        };
        try {
            while (this.pos < this.src.length) {
                const ch = this.src[this.pos];
                if (ch === '\\') {
                    const next = this.src[this.pos + 1];
                    if (next === '\n') {
                        this.pos += 2;
                        continue;
                    }
                    if (next === '$' || next === '`' || next === '\\') {
                        literal += next;
                        this.pos += 2;
                        continue;
                    }
                    literal += ch;
                    this.pos++;
                    continue;
                }
                if (ch === '$') {
                    flush();
                    parts.push(this.readDollar());
                    continue;
                }
                if (ch === '`') {
                    flush();
                    this.pos++;
                    parts.push({ t: 'cmd', script: this.readBackquote() });
                    continue;
                }
                literal += ch;
                this.pos++;
            }
            flush();
        } finally {
            this.src = savedSrc;
            this.pos = savedPos;
        }
        return [{ t: 'dq', parts }];
    }

    /** Reads the here-document bodies that follow the newline ending the command line. */
    private readHeredocs(): void {
        if (this.heredocs.length === 0) return;
        const pending = this.heredocs;
        this.heredocs = [];
        for (const entry of pending) {
            /* No newline is eaten here: every caller has already stepped past the one that ended
               the command line, so what stands here is the body's own first character -- eating one
               more took the body's leading blank line with it, and `cat <<EOF` written over
               `\n\na\n\nEOF` printed `a\n\n` where a host printed `\na\n\n`. */
            const bodyStart = this.pos;
            const lines: string[] = [];
            while (!this.eof()) {
                const end = this.src.indexOf('\n', this.pos);
                const line = end === -1 ? this.src.slice(this.pos) : this.src.slice(this.pos, end);
                this.pos = end === -1 ? this.src.length : end + 1;
                const candidate = entry.strip ? line.replace(/^\t+/, '') : line;
                if (candidate === entry.delimiter) break;
                lines.push(entry.strip ? candidate : line);
                if (end === -1) break;
            }
            const text = lines.length === 0 ? '' : lines.join('\n') + '\n';
            /* The source of the body, kept for a job's sake: a `&` ends the command line before the
               body starts, so the source a job is handed stops at the `&` and the body behind it is
               not part of it. Replayed from what is kept here, `cat <<EOF &` reads what it read
               inline, instead of an end of input that was never written. */
            entry.target.heredoc = this.src.slice(bodyStart, this.pos);
            entry.target.heredocFrom = bodyStart;
            /* The body is the input itself, not the name of a file holding it: it stays a `<<`
               redirection, which `planRedirects` reads as text the command reads on its standard
               input. Reading it as a file looked for a file called `hi` and failed with ENOENT.
               A quoted delimiter takes the body as it was written; an unquoted one expands it. */
            entry.target.target = entry.expand ? this.heredocWord(text) : [{ t: 'sq', v: text }];
        }
    }

    /**
     * A sequence of pipelines separated by `;` or a newline, stopping at EOF or at one of
     * `terminators`. Each node carries the operator joining it to the one before it.
     */
    /** True when one of the terminator words starts here (they are the closing words of a construct). */
    private atTerminator(terminators: string[]): boolean {
        for (const word of terminators) if (this.keywordAt(this.pos, word)) return true;
        return false;
    }

    /**
     * The token a host names where it wanted something else: the two-character operators first, then
     * the one-character ones, then the whole word that stands there -- `for x in a; echo hi; done`
     * names `echo`, not the `do` it wanted -- and `newline` where the line or the input ends, which
     * is what a host prints for `echo a >`. Naming one never reads it: the position is put back.
     */
    private tokenHere(): string {
        const two = this.src.slice(this.pos, this.pos + 2);
        if (two === ';;' || two === '&&' || two === '||') return two;
        const ch = this.here();
        if (ch === '' || ch === '\n') return 'newline';
        if (';&|()<>'.includes(ch)) return ch;
        const save = this.pos;
        let word: Word | null = null;
        try {
            word = this.readWord();
        } catch {
            word = null;
        }
        this.pos = save;
        return word === null ? 'newline' : rawText(word);
    }

    /**
     * The error for a word a construct needs and does not find -- `then`, `do` and `in`. A host
     * names the token standing in its place: `for x in a; echo hi; done` is `unexpected token
     * `echo'', and `for x in a; done` is `unexpected token `done''. With no token left to name it
     * says the input ended, which is what `for x`, `while true` and `if true` are.
     */
    private expectedKeyword(): ShellSyntaxError {
        const token = this.eof() ? 'newline' : this.tokenHere();
        if (token === 'newline') return new ShellSyntaxError('syntax error: unexpected end of file');
        return new ShellSyntaxError(`syntax error near unexpected token \`${token}'`);
    }

    private parseList(terminators: string[]): Node[] {
        const nodes: Node[] = [];
        let pendingOp: '&&' | '||' | null = null;
        for (;;) {
            this.skipSpace(false);
            /* `echo a &&` is not `echo a` and nothing: a host is still waiting for the command
               behind the operator, and says so by saying the input ended -- it prints no `a`,
               and exits 2, which stopping at the operator and running what stood in front of it
               did not do. */
            if (this.eof()) {
                if (pendingOp !== null) throw new ShellSyntaxError('syntax error: unexpected end of file');
                break;
            }
            if (this.here() === '\n') {
                this.pos++;
                this.readHeredocs();
                pendingOp = null;
                continue;
            }
            if (this.atTerminator(terminators)) break;
            const node = this.parsePipelineWithOp(pendingOp);
            pendingOp = null;
            nodes.push(node);
            this.skipSpace(false);
            if (this.here() === '\n') {
                this.pos++;
                this.readHeredocs();
                continue;
            }
            if (this.eof()) {
                this.readHeredocs();
                break;
            }
            const two = this.src.slice(this.pos, this.pos + 2);
            if (two === ';;') {
                // a case item terminator; only parseCase consumes it
                break;
            }
            if (two === '&&' || two === '||') {
                this.pos += 2;
                pendingOp = two === '&&' ? '&&' : '||';
                this.skipSpace(true);
                continue;
            }
            if (this.here() === ';') {
                /* No body is read here: a here-document's body starts on the line behind the one its
                   `<<` is on, so the `;` that ends `cat <<EOF1; cat <<EOF2` still has a second `<<`
                   to parse before either body can be read -- reading it now took ` cat <<EOF2` and
                   `a` as the body of the first, and left the real first body for the second. */
                this.pos++;
                continue;
            }
            if (this.here() === '&') {
                // `cmd &`: the shell does not wait for the pipeline, and the host starts it as a job
                this.pos++;
                const last = nodes[nodes.length - 1];
                if (last !== undefined) last.background = true;
                continue;
            }
            if (this.atTerminator(terminators)) break;
            const rest = this.src.slice(this.pos).trim();
            if (rest !== '') {
                throw new ShellSyntaxError(`syntax error near unexpected token \`${rest.split(/[\s;]/)[0]}'`);
            }
            break;
        }
        return nodes;
    }

    private parsePipelineWithOp(op: '&&' | '||' | null): Node {
        let bang = false;
        this.skipSpace(false);
        const start = this.pos;
        if (this.keywordAt(this.pos, '!')) {
            this.pos += 1;
            bang = true;
            this.skipSpace(false);
            /* A `!` nothing stands behind: a host names the newline it found where the negated
               command should have been -- `!`, `! ` and a `!` the input ends behind are all `syntax
               error near unexpected token `newline'' -- rather than the end of file a bare end of
               input would report. */
            if (this.eof() || this.here() === '\n') throw new ShellSyntaxError("syntax error near unexpected token `newline'");
        }
        const commands: Command[] = [];
        for (;;) {
            commands.push(this.parseCommand());
            this.skipSpace(false);
            /* A `|` at the very end of the input is still the operator it is: the command behind it
               is the one that is missing, and a host says so by saying the input ended -- `echo |`
               is `syntax error: unexpected end of file`, where stopping at the `|` and leaving it
               for the caller named the `|` itself as the token it did not expect. */
            if (this.here() === '|' && this.src[this.pos + 1] !== '|') {
                this.pos++;
                /* The body of a here-document stands on the line behind the one its `<<` is on, so
                   a line the pipeline continues onto is not the command it continues with until that
                   body has been read: `cat <<EOF |\na\nEOF\ncat` is `a` through `cat`, where taking
                   the line behind the `|` as its next command made `a` a command of its own and left
                   the here-document with an end of input nothing had written. */
                this.skipSpace(false);
                if (this.heredocs.length > 0 && this.here() === '\n') {
                    this.pos++;
                    this.readHeredocs();
                }
                this.skipSpace(true);
                continue;
            }
            break;
        }
        return { bang, commands, op, source: this.src.slice(start, this.pos).trim(), end: this.pos };
    }

    private parseCommand(): Command {
        this.skipSpace(false);
        if (this.eof()) throw new ShellSyntaxError('syntax error: unexpected end of file');
        const line = countLines(this.src, this.pos);
        const ch = this.here();
        /* `(( ))` is the arithmetic command, not a subshell holding a subshell: a host evaluates the
           expression between the brackets and takes the command's status from its value -- `((1));
           echo $?` prints `0`, `((0)); echo $?` prints `1`, and `((x=5)); echo $x` prints `5` --
           where reading the brackets as two nested subshells ran `1` as a command and reported it
           as not found. The expression is read to the `))` that closes it, as bash reads it: even
           `((echo hi))` is an expression that will not evaluate, and not a subshell that echoes. */
        if (this.src.startsWith('((', this.pos)) {
            this.pos += 2;
            const expr = this.readDelimited('((', '))');
            return { t: 'arithcmd', expr, redirects: this.readRedirects(), line };
        }
        if (ch === '(') {
            this.pos++;
            const body = this.parseBody([')']);
            this.skipSpace(true);
            if (this.here() !== ')') throw new ShellSyntaxError('syntax error: unexpected end of file');
            this.pos++;
            return { t: 'subshell', body, redirects: this.readRedirects(), line };
        }
        if (ch === '{') {
            this.pos++;
            const body = this.parseBody(['}']);
            this.skipSpace(true);
            if (this.here() !== '}') throw new ShellSyntaxError('syntax error: unexpected end of file');
            this.pos++;
            return { t: 'group', body, redirects: this.readRedirects(), line };
        }
        if (this.keywordAt(this.pos, 'if')) return { ...this.parseIf(), line };
        if (this.keywordAt(this.pos, 'for')) return { ...this.parseFor(), line };
        if (this.keywordAt(this.pos, 'while') || this.keywordAt(this.pos, 'until')) return { ...this.parseWhile(), line };
        if (this.keywordAt(this.pos, 'case')) return { ...this.parseCase(), line };
        if (this.keywordAt(this.pos, 'function')) return { ...this.parseFunction(), line };
        /* `[[ ... ]]` is bash's conditional command, not a `[` that runs as one: a host evaluates
           the expression inside it itself -- `[[ abc == a* ]]` is true -- where reading the brackets
           as a command ran `[` and answered `[[: command not found` with 127. The words between
           them are kept whole, because nothing inside one is field-split or globbed: `[[ -f * ]]`
           asks whether the file `*` is there, and `[[ $x == a* ]]` takes the `*` as a pattern even
           where the directory holds a file it would have matched. */
        if (this.src.startsWith('[[', this.pos)) {
            const words = this.parseCondWords();
            return { t: 'cond', words, redirects: this.readRedirects(), line };
        }
        return { ...this.parseSimple(), line };
    }

    /**
     * The words of a `[[ ... ]]`, read to the `]]` that closes it.
     *
     * A word is read with `readWord`, which stops on the whitespace and the operators a command
     * line stops on, and every one of them is kept as it was written so the evaluation can tell a
     * quoted `a*` -- a literal -- from an unquoted one, which is a pattern.
     */
    private parseCondWords(): Word[] {
        this.pos += 2;
        const words: Word[] = [];
        for (;;) {
            this.skipSpace(true);
            if (this.eof()) throw new ShellSyntaxError('syntax error: unexpected end of file');
            if (this.src.startsWith(']]', this.pos)) {
                this.pos += 2;
                return words;
            }
            const ch = this.here();
            /* The operators a conditional expression is written with are the ones a command line
               stops a word on, so they are taken as words of their own here rather than left for
               `readWord`, which stops on every one of them and answers nothing at all: `[[ a == a
               || b == c ]]` was `syntax error: unexpected end of file` where a host answers true. */
            if (ch === '|' || ch === '&' || ch === '<' || ch === '>') {
                const two = this.src.slice(this.pos, this.pos + 2);
                if (two === '||' || two === '&&') {
                    this.pos += 2;
                    words.push([{ t: 'lit', v: two }]);
                    continue;
                }
                this.pos++;
                words.push([{ t: 'lit', v: ch }]);
                continue;
            }
            if (ch === ')' && words.length > 0) {
                /* A `)` is one of the parentheses a conditional expression groups with -- `[[ (a == a)
                   && (b == b) ]]` -- and not the one that would close a subshell, so it is a word
                   of its own here. */
                this.pos++;
                words.push([{ t: 'lit', v: ')' }]);
                continue;
            }
            if (ch === '(') {
                this.pos++;
                words.push([{ t: 'lit', v: '(' }]);
                continue;
            }
            const word = this.readWord();
            if (word === null) throw new ShellSyntaxError('syntax error: unexpected end of file');
            words.push(word);
        }
    }

    private readRedirects(): Redirect[] {
        const redirects: Redirect[] = [];
        for (;;) {
            this.skipSpace(false);
            /* `2>&1` written after a compound command -- `{ echo a; } 2>&1`, `while ...; done 2>&1`
               -- has no word in front of it to carry the descriptor, so the number is read here: a
               bare number immediately before an operator is that operator's fd, as it is after a
               simple command. Only a number an operator really follows is taken, so a stray one is
               left for the caller to report as the syntax error it is. */
            const numbered = /^([0-9]+)(?=[<>])/.exec(this.src.slice(this.pos));
            let fd = -1;
            if (numbered !== null) {
                fd = Number.parseInt(numbered[1], 10);
                this.pos += numbered[1].length;
            }
            const three = this.src.slice(this.pos, this.pos + 3);
            const two = this.src.slice(this.pos, this.pos + 2);
            let op: Redirect['op'] | null = null;
            let width = 0;
            /* The operator's own descriptor is the default it has with no number in front of it;
               a number there -- `2>`, `2>>`, `2>&1`, `3<` -- is the one that was read above, and it
               is never overwritten by the default. Every branch below used to set it unconditionally,
               which is why `{ echo a; } 2>f` sent the group's *output* to `f`, as `&>` would. */
            const defaultFd = (value: number): number => (fd === -1 ? value : fd);
            if (three === '&>>') {
                op = '&>>';
                width = 3;
                fd = defaultFd(1);
            } else if (two === '&>') {
                op = '&>';
                width = 2;
                fd = defaultFd(1);
            } else if (two === '>>') {
                op = '>>';
                width = 2;
                fd = defaultFd(1);
            } else if (three === '<<<') {
                /* A here-string is read before `<<` is, so `<<<` never looks like `<<` and a
                   delimiter: the word after it is the input, not the name of a here-document. */
                op = '<<<';
                width = 3;
                fd = defaultFd(0);
            } else if (two === '<<') {
                const dash = this.src[this.pos + 2] === '-';
                op = dash ? '<<-' : '<<';
                width = dash ? 3 : 2;
                fd = defaultFd(0);
            } else if (two === '>&') {
                op = '>&';
                width = 2;
                fd = defaultFd(1);
            } else if (two === '<&') {
                op = '<&';
                width = 2;
                fd = defaultFd(0);
            } else if (this.here() === '>') {
                op = '>';
                width = 1;
                fd = defaultFd(1);
            } else if (this.here() === '<') {
                op = '<';
                width = 1;
                fd = defaultFd(0);
            }
            if (op === null) break;
            this.pos += width;
            redirects.push(this.readRedirect(fd, op));
        }
        return redirects;
    }

    /** `2>file`: a bare number immediately before a redirect operator is that operator's fd. */
    private readRedirectsWithFd(words: Word[]): Redirect[] {
        let fd = -1;
        const last = words[words.length - 1];
        if (last && last.length === 1 && last[0].t === 'lit' && /^[0-9]+$/.test(last[0].v)) {
            fd = Number.parseInt(last[0].v, 10);
            words.pop();
        }
        const found = this.readRedirects();
        /* Only the operator the number was written in front of is the one it numbers: `echo hi 3>f
           >&3` is a `3` opened on `f` and a standard output duplicated onto that `3` -- numbering
           every operator behind it as well made the `>&3` a third descriptor pointing at `f`, so
           the command's own output stayed where it was. An operator of its own number -- the `4<`
           of `cat 3<f 4<g` -- read it itself, and is left alone. */
        if (fd !== -1 && found[0] !== undefined) found[0].fd = fd;
        return found;
    }

    private parseSimple(): CommandBody {
        const assigns: Assignment[] = [];
        const words: Word[] = [];
        const redirects: Redirect[] = [];
        let sawCommandWord = false;
        for (;;) {
            this.skipSpace(false);
            if (this.eof()) break;
            const ch = this.here();
            if (ch === '\n') break;
            if (ch === '(' || ch === ')') break;
            if (ch === '>' || ch === '<') {
                redirects.push(...this.readRedirectsWithFd(words));
                continue;
            }
            const two = this.src.slice(this.pos, this.pos + 2);
            if (two === '&&' || two === '||') break;
            if (ch === ';' || ch === '&' || ch === '|') break;
            const start = this.pos;
            const word = this.readWord();
            if (!word) break;
            const text = rawText(word);
            // the source span keeps the quoting that rawText strips: `x='a b'` is one assignment
            const raw = this.src.slice(start, this.pos);
            if (!sawCommandWord) {
                if (RESERVED_WORDS.has(text)) throw new ShellSyntaxError(`syntax error near unexpected token \`${text}'`);
                /* A compound assignment `a=(x y z)`, `a=([2]=c)` and `a+=(w)`: the `(` stands where
                   an ordinary assignment's value would, and the words between the parens are the
                   elements of the array it makes. Read as text, `a=(x y z)` was the syntax error
                   `syntax error near unexpected token `(x'' where a host makes an array of three.
                   The body is taken from the source so nothing in it is expanded here -- a `$( )`
                   in it is run when the command runs, not when the line is read.
                   It is looked for *before* the ordinary assignment is: `readWord` stops on the
                   `(`, so `a=(x y z)` reads as the assignment `a=` with nothing behind it, and
                   taking that left the parens for the caller to report as a syntax error. */
                const compound = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=\(/.exec(this.src.slice(start));
                if (compound !== null) {
                    this.pos = start + compound[0].length;
                    const body = this.readDelimited('(', ')');
                    const elements = new Parser(body, this.state).readAllWordsPublic();
                    assigns.push({
                        name: compound[1],
                        append: compound[2] === '+',
                        value: [],
                        array: elements,
                        arrayAppend: compound[2] === '+'
                    });
                    continue;
                }
                const assign = assignmentOf(raw);
                if (assign) {
                    assigns.push({ name: assign.name, append: assign.append, value: parseValueWord(assign.rest) });
                    continue;
                }
                if (this.expandAlias(word, start)) continue;
                if (this.tryFunctionDefinition(text)) return this.parseFunctionDefinition(text);
            }
            words.push(word);
            sawCommandWord = true;
        }
        if (words.length === 0 && assigns.length === 0 && redirects.length === 0) {
            /* What stands where the command should is what a host names, and not the `newline` it
               names only when a line or the input ends: `if; then` and `while; do echo; done` are
               `unexpected token `;'', and a bare `|`, `&`, `;` and `)` name themselves. It is the
               `;` a `{ cat <<EOF\na\nEOF\n; }` is closed on too -- that is a syntax error in a host
               as well, and the token it names for it is `;`, not `newline`. */
            throw new ShellSyntaxError(`syntax error near unexpected token \`${this.tokenHere()}'`);
        }
        return { t: 'simple', assigns, words, redirects };
    }

    private expandAlias(word: Word, start: number): boolean {
        if (!this.state) return false;
        if (word.length !== 1 || word[0].t !== 'lit') return false;
        const name = word[0].v;
        if (this.expandedAliases.has(name)) return false;
        const value = this.state.aliases.get(name);
        if (value === undefined) return false;
        this.expandedAliases.add(name);
        this.src = this.src.slice(0, start) + value + this.src.slice(this.pos);
        this.pos = start;
        return true;
    }

    private tryFunctionDefinition(text: string): boolean {
        if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(text)) return false;
        // this.pos is just past the word that was read
        let i = this.pos;
        while (i < this.src.length && (this.src[i] === ' ' || this.src[i] === '\t')) i++;
        return this.src[i] === '(' && this.src[i + 1] === ')';
    }

    private parseFunctionDefinition(name: string): CommandBody {
        this.skipSpace(false);
        this.pos = this.src.indexOf('(', this.pos) + 1;
        this.pos = this.src.indexOf(')', this.pos) + 1;
        this.skipSpace(true);
        const bodyStart = this.pos;
        const body = this.parseCommand();
        return { t: 'function', name, body, text: this.src.slice(bodyStart, this.pos) };
    }

    private parseFunction(): CommandBody {
        this.pos += 'function'.length;
        this.skipSpace(false);
        const word = this.readWord();
        if (!word) throw new ShellSyntaxError('syntax error: function name expected');
        const name = rawText(word);
        this.skipSpace(false);
        if (this.here() === '(') this.pos = this.src.indexOf(')', this.pos) + 1;
        this.skipSpace(true);
        const bodyStart = this.pos;
        const body = this.parseCommand();
        return { t: 'function', name, body, text: this.src.slice(bodyStart, this.pos) };
    }

    private parseIf(): CommandBody {
        this.pos += 2;
        const branches: { cond: Node[]; body: Node[] }[] = [];
        let elseBody: Node[] | undefined;
        for (;;) {
            const cond = this.parseList(['then']);
            this.skipSpace(true);
            if (!this.keywordAt(this.pos, 'then')) throw this.expectedKeyword();
            this.pos += 4;
            const body = this.parseBody(['elif', 'else', 'fi']);
            branches.push({ cond, body });
            this.skipSpace(true);
            if (this.keywordAt(this.pos, 'elif')) {
                this.pos += 4;
                continue;
            }
            if (this.keywordAt(this.pos, 'else')) {
                this.pos += 4;
                elseBody = this.parseBody(['fi']);
                this.skipSpace(true);
            }
            if (!this.keywordAt(this.pos, 'fi')) throw new ShellSyntaxError('syntax error: unexpected end of file');
            this.pos += 2;
            break;
        }
        const redirects = this.readRedirects();
        return elseBody !== undefined ? { t: 'if', branches, else_: elseBody, redirects } : { t: 'if', branches, redirects };
    }

    private parseFor(): CommandBody {
        this.pos += 3;
        this.skipSpace(false);
        /* bash's arithmetic loop: `for ((init; test; next)); do ...; done`. The three expressions
           are arithmetic, as they are in `$(( ))`, and every one of them may be empty: an empty test
           is true, which is what makes `for ((;;))` the loop that never ends by itself. */
        if (this.src.startsWith('((', this.pos)) {
            this.pos += 2;
            const expr = this.readDelimited('((', '))');
            this.skipSpace(true);
            if (this.here() === ';') this.pos++;
            const tail = this.parseForTail();
            return { t: 'forarith', expr, body: tail.body, redirects: tail.redirects };
        }
        const word = this.readWord();
        if (!word) throw new ShellSyntaxError(`syntax error near unexpected token \`${this.tokenHere()}'`);
        const name = rawText(word);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ShellSyntaxError('syntax error: bad for loop variable');
        let words: Word[] | null = null;
        for (;;) {
            this.skipSpace(false);
            if (this.eof()) break;
            if (this.here() === '\n') {
                /* a newline may stand where the `;` stands: `for i` newline `in 1 2` and `for i`
                   newline `do` are both a loop, as they are in bash. The newline is eaten and the
                   search goes on, so the `in` or the `do` of the next line is still found. */
                this.pos++;
                continue;
            }
            if (this.here() === ';') {
                this.pos++;
                break;
            }
            if (this.keywordAt(this.pos, 'in')) {
                this.pos += 2;
                words = [];
                for (;;) {
                    /* not `skipSpace(true)`: a newline ends the list of words, as it ends it in
                       bash -- `for i in 1` newline `2` newline `do` is a syntax error there, and
                       skipping the newline here read the `do` as one of the words instead. */
                    this.skipSpace(false);
                    if (this.eof()) throw new ShellSyntaxError('syntax error: unexpected end of file');
                    if (this.here() === ';') {
                        this.pos++;
                        break;
                    }
                    if (this.here() === '\n') {
                        this.pos++;
                        break;
                    }
                    const item = this.readWord();
                    if (!item) break;
                    words.push(item);
                }
                break;
            }
            break;
        }
        const tail = this.parseForTail();
        return { t: 'for', name, words, body: tail.body, redirects: tail.redirects };
    }

    /**
     * The commands between the words that open a construct and the ones that close it. A host does
     * not accept an empty body: `if true; then` newline `fi` is `syntax error near unexpected token
     * `fi'', and `{ }`, `( )`, `for i in 1; do` newline `done` and `while true; do` newline `done`
     * name their own closing word the same way. Reading one as a body that holds no commands parsed
     * the line as valid and ran nothing where a host reports it, and a `while` whose body cannot
     * change its condition looped forever instead -- the one construct a caller cannot time out.
     *
     * The token named is whatever stands where the body should have been, which is not always the
     * word the construct closes with: an `if` whose `then` is followed by an `elif` names the
     * `elif`. Nothing is named where the input ends instead -- that is the end of file the caller
     * reports, and not a token at all.
     */
    private parseBody(terminators: string[]): Node[] {
        const body = this.parseList(terminators);
        if (body.length === 0 && !this.eof()) {
            throw new ShellSyntaxError(`syntax error near unexpected token \`${this.tokenHere()}'`);
        }
        return body;
    }

    /** `do ... done` and the redirects that follow it: the tail every `for` ends with. */
    private parseForTail(): { body: Node[]; redirects: Redirect[] } {
        this.skipSpace(true);
        if (!this.keywordAt(this.pos, 'do')) throw this.expectedKeyword();
        this.pos += 2;
        const body = this.parseBody(['done']);
        this.skipSpace(true);
        if (!this.keywordAt(this.pos, 'done')) throw new ShellSyntaxError('syntax error: unexpected end of file');
        this.pos += 4;
        return { body, redirects: this.readRedirects() };
    }

    private parseWhile(): CommandBody {
        const negate = this.keywordAt(this.pos, 'until');
        this.pos += 5;
        const cond = this.parseList(['do']);
        this.skipSpace(true);
        if (!this.keywordAt(this.pos, 'do')) throw this.expectedKeyword();
        this.pos += 2;
        const body = this.parseBody(['done']);
        this.skipSpace(true);
        if (!this.keywordAt(this.pos, 'done')) throw new ShellSyntaxError('syntax error: unexpected end of file');
        this.pos += 4;
        return { t: 'while', negate, cond, body, redirects: this.readRedirects() };
    }

    private parseCase(): CommandBody {
        this.pos += 4;
        this.skipSpace(false);
        const word = this.readWord();
        if (!word) throw new ShellSyntaxError('syntax error: case word expected');
        this.skipSpace(true);
        if (!this.keywordAt(this.pos, 'in')) throw this.expectedKeyword();
        this.pos += 2;
        const items: { patterns: Word[]; body: Node[] }[] = [];
        for (;;) {
            this.skipSpace(true);
            if (this.eof()) throw new ShellSyntaxError('syntax error: unexpected end of file');
            if (this.keywordAt(this.pos, 'esac')) {
                this.pos += 4;
                break;
            }
            const patterns: Word[] = [];
            for (;;) {
                this.skipSpace(true);
                if (this.here() === '(') this.pos++;
                const pattern = this.readWord();
                if (pattern) patterns.push(pattern);
                this.skipSpace(true);
                if (this.here() === '|') {
                    this.pos++;
                    continue;
                }
                if (this.here() === ')') {
                    this.pos++;
                    break;
                }
                throw new ShellSyntaxError('syntax error: unexpected end of file');
            }
            const body = this.parseList([';;', 'esac']);
            items.push({ patterns, body });
            this.skipSpace(true);
            if (this.src.slice(this.pos, this.pos + 2) === ';;') {
                this.pos += 2;
                continue;
            }
            if (this.keywordAt(this.pos, 'esac')) {
                this.pos += 4;
                break;
            }
            if (this.eof()) throw new ShellSyntaxError('syntax error: unexpected end of file');
        }
        return { t: 'case', word, items, redirects: this.readRedirects() };
    }
}

/* ================================================================== *
 * 5. Expansion
 * ================================================================== */

/**
 * Brace expansion: the words one word becomes before anything else is expanded.
 *
 * `a{b,c}d` is `abd acd`, `{1..3}` is `1 2 3`, and the expansion is done before a variable is,
 * which is why `x=q; echo pre{a,b}$x` is `preaq prebq` and `x=q; echo {$x,b}` is `q b`. A brace
 * with no comma and no `..` in it is text -- `echo {a}` prints `{a}` -- and so is one inside
 * quotes, which is why only the word's *literal* parts are looked at here.
 *
 * Returns null where the word holds no brace group, so a caller can tell "nothing to expand" from
 * "expanded to one word".
 */
function braceExpand(text: string): string[] | null {
    let depth = 0;
    let open = -1;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ESCAPED_BRACE) {
            i++;
            continue;
        }
        if (ch === '\\') {
            i++;
            continue;
        }
        if (ch === '{') {
            if (depth === 0) open = i;
            depth++;
            continue;
        }
        if (ch !== '}') continue;
        depth--;
        if (depth < 0) {
            /* A `}` with no `{` behind it is text -- `echo x}` prints `x}` -- and not the close of
               a group the loop will look for later. */
            depth = 0;
            open = -1;
            continue;
        }
        if (depth > 0) continue;
        if (open < 0) continue;
        const parts = splitBraceBody(text.slice(open + 1, i));
        /* One alternative and no range is not a brace group: `echo {a}` is the text `{a}`. */
        if (parts.length < 2) {
            open = -1;
            continue;
        }
        const prefix = text.slice(0, open);
        const suffix = text.slice(i + 1);
        const out: string[] = [];
        for (const part of parts) {
            /* An alternative may hold a brace group of its own -- `{a,{b,c}}` is `a b c` -- and the
               text behind the group it stood in may hold the next one: `a{b,c}d{e,f}` is four words.
               Each pass takes one group out, so the expansion ends. */
            for (const piece of braceExpand(part) ?? [part]) {
                const combined = prefix + piece + suffix;
                const again = braceExpand(combined);
                if (again !== null) out.push(...again);
                else out.push(combined);
            }
        }
        return out;
    }
    return null;
}

/** Splits the inside of a brace group on its top-level commas, and expands `n..m` into a range. */
function splitBraceBody(body: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === ESCAPED_BRACE) {
            current += ch + (body[i + 1] ?? '');
            i++;
            continue;
        }
        if (ch === '\\') {
            current += ch + (body[i + 1] ?? '');
            i++;
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    parts.push(current);
    if (parts.length === 1) {
        const range = /^(-?[0-9]+)\.\.(-?[0-9]+)$/.exec(parts[0]);
        if (range === null) return parts;
        const from = Number.parseInt(range[1], 10);
        const to = Number.parseInt(range[2], 10);
        const step = from <= to ? 1 : -1;
        const out: string[] = [];
        for (let value = from; step > 0 ? value <= to : value >= to; value += step) out.push(String(value));
        return out;
    }
    return parts;
}

/**
 * The letters `$-` spells, in the order this machine's `/bin/sh` spells them: `a b e f h i m u v x
 * B H C`, then the `c` of a shell a line was handed to with `-c` (the `s` of one reading its lines
 * from its standard input, and neither for one reading a file). A host's own default is `hBc` --
 * `hashall` and `braceexpand` on, and every other option off -- and `set -e -x -u` there answers
 * `ehuxBc`, which is the order below and not the order the options were named in.
 *
 * `interactive-comments`, `posix` and the rest a host has on by default are not letters at all:
 * `set -o posix; echo $-` is still `hBc`.
 */
function optionFlags(state: ShellState): string {
    let out = '';
    if (state.options.allexport) out += 'a';
    if (state.options.notify) out += 'b';
    if (state.options.errexit) out += 'e';
    if (state.options.noglob) out += 'f';
    if (state.options.hashall) out += 'h';
    if (state.options.interactive) out += 'i';
    if (state.options.monitor) out += 'm';
    if (state.options.noexec) out += 'n';
    if (state.options.nounset) out += 'u';
    if (state.options.verbose) out += 'v';
    if (state.options.xtrace) out += 'x';
    if (state.options.braceexpand) out += 'B';
    if (state.options.histexpand) out += 'H';
    if (state.options.noclobber) out += 'C';
    /* A shell that reads no terminal and no file of its own was handed its one line with `-c`,
       which is the only way this container starts one. */
    if (!state.options.interactive) out += 'c';
    return out;
}

function specialValue(state: ShellState, name: string): string | undefined {
    switch (name) {
        case '?':
            return String(state.lastStatus);
        case '0':
            return state.shellName;
        case '#':
            return String(state.positional.length);
        case '$':
            return String(state.pid);
        case '!':
            /* No background job yet: `$!` is unset and expands to nothing, the way it does in a
               host shell -- a `0` there read as a pid the shell never printed. */
            return state.lastBackgroundPid === 0 ? '' : String(state.lastBackgroundPid);
        case '-':
            return optionFlags(state);
        default:
            return undefined;
    }
}

const FIELD_MARK = ' ';

/**
 * The word a `\{` and a `\}` read as, so the expansion behind it knows the brace was escaped.
 *
 * The backslash is gone by the time the word is expanded -- a host expands braces *before* it takes
 * the backslashes out, and this file's lexer takes them out as it reads -- so the mark is put in
 * front of the brace instead: `a\{b,c\}d` lexes to `a<mark>{b,c<mark>}d`, which opens no group.
 */
const ESCAPED_BRACE = '\u0001';

interface Expanded {
    text: string;
    quoted: boolean[];
    /**
     * Per character: it came out of an unquoted expansion, so field splitting may break the word
     * on it. Literal text of the word is never split, whatever IFS holds -- `IFS=:; echo a:b`
     * prints `a:b` in a host shell, because splitting is something a shell does to the result of
     * an expansion and not to a word it was handed.
     */
    split: boolean[];
}

function appendText(target: Expanded, text: string, quoted: boolean, split = !quoted): void {
    for (const ch of text) {
        target.text += ch;
        target.quoted.push(quoted);
        target.split.push(split);
    }
}

function stripPrefix(text: string, pattern: string, greedy: boolean): string {
    if (pattern === '') return text;
    const re = globToRegExp(pattern, true);
    if (greedy) {
        for (let i = text.length; i >= 0; i--) if (re.test(text.slice(0, i))) return text.slice(i);
        return text;
    }
    for (let i = 0; i <= text.length; i++) if (re.test(text.slice(0, i))) return text.slice(i);
    return text;
}

function stripSuffix(text: string, pattern: string, greedy: boolean): string {
    if (pattern === '') return text;
    const re = globToRegExp(pattern, true);
    if (greedy) {
        for (let i = 0; i <= text.length; i++) if (re.test(text.slice(i))) return text.slice(0, i);
        return text;
    }
    for (let i = text.length; i >= 0; i--) if (re.test(text.slice(i))) return text.slice(0, i);
    return text;
}

function replaceGlob(text: string, pattern: string, replacement: string, all: boolean): string {
    if (pattern === '') return text;
    const re = globToRegExp(pattern, true);
    let out = '';
    let i = 0;
    while (i <= text.length) {
        let hit = -1;
        let hitEnd = -1;
        for (let start = i; start <= text.length && hit === -1; start++) {
            for (let end = text.length; end >= start; end--) {
                const piece = text.slice(start, end);
                if (re.test(piece) && (all || piece !== '')) {
                    hit = start;
                    hitEnd = end;
                    break;
                }
            }
        }
        if (hit === -1) {
            out += text.slice(i);
            break;
        }
        out += text.slice(i, hit) + replacement;
        i = hitEnd === hit ? hit + 1 : hitEnd;
        if (!all) {
            out += text.slice(i);
            break;
        }
    }
    return out;
}

function applyModifier(state: ShellState, ref: VarRef, value: string | undefined, set: boolean, name: string): string {
    const arg = ref.arg === '' ? '' : expandToString(modifierText(ref.arg), state);
    switch (ref.op) {
        case '':
            if (value !== undefined) return value;
            if (state.options.nounset) throw new UnsetVariableError(`${name}: unbound variable`);
            return '';
        case 'len':
            if (name === '@' || name === '*' || name === '#') return String(state.positional.length);
            if (ARRAY_ALL_RE.test(name)) return String(arrayElements(state, name.replace(/\[[@*]\]$/, '[0]')).length);
            return String((value ?? '').length);
        case 'substr': {
            const parts = arg.split(':');
            const text = value ?? '';
            let offset = evalArith(state, parts[0] === undefined || parts[0] === '' ? '0' : parts[0]);
            const length = parts[1] === undefined ? undefined : evalArith(state, parts[1]);
            if (offset < 0) offset = Math.max(text.length + offset, 0);
            return length === undefined ? text.slice(offset) : text.slice(offset, offset + length);
        }
        case '-':
            return value !== undefined ? value : arg;
        case ':-':
            return value !== undefined && value !== '' ? value : arg;
        case '=':
            if (value !== undefined) return value;
            setVar(state, name, arg);
            return arg;
        case ':=':
            if (value !== undefined && value !== '') return value;
            setVar(state, name, arg);
            return arg;
        case '+':
            return set ? arg : '';
        case ':+':
            return value !== undefined && value !== '' ? arg : '';
        case '?':
            if (value !== undefined) return value;
            throw new UnsetVariableError(`${name}: ${arg || 'parameter null or not set'}`);
        case ':?':
            if (value !== undefined && value !== '') return value;
            throw new UnsetVariableError(`${name}: ${arg || 'parameter null or not set'}`);
        case '#':
            return stripPrefix(value ?? '', arg, false);
        case '##':
            return stripPrefix(value ?? '', arg, true);
        case '%':
            return stripSuffix(value ?? '', arg, false);
        case '%%':
            return stripSuffix(value ?? '', arg, true);
        case '/':
        case '//': {
            const slash = arg.indexOf('/');
            if (slash === -1) return value ?? '';
            return replaceGlob(value ?? '', arg.slice(0, slash), arg.slice(slash + 1), ref.op === '//');
        }
        default:
            return value ?? '';
    }
}

/**
 * Tilde expansion of the word a literal part opened: `~` and `~/rest` are the home directory, with
 * the rest of the word kept after it. A `~` that names a user -- `~root` -- is left as it was
 * written: the container holds no passwd table to answer a login name with a home directory, and a
 * path invented for one would be a path no file has.
 */
function expandTilde(text: string, state: ShellState): string {
    if (!text.startsWith('~')) return text;
    const slash = text.indexOf('/');
    const name = slash === -1 ? text.slice(1) : text.slice(1, slash);
    if (name !== '') return text;
    const home = getVar(state, 'HOME');
    if (home === undefined || home === '') return text;
    return home + (slash === -1 ? '' : text.slice(slash));
}

function expandParts(state: ShellState, parts: Part[], quoted: boolean, target: Expanded): void {
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        if (part.t === 'lit') {
            /* The mark a `\{` left is not text, and it goes out here -- everywhere the literal is
               read, including the tilde expansion a word opening with `~` gets. */
            const literal = part.v.split(ESCAPED_BRACE).join('');
            /* Tilde expansion is the first expansion a word gets, and only where the word opens with
               an unquoted `~`: `echo ~` is the home directory, `echo a~b` and `echo "~"` are not. */
            if (index === 0 && !quoted && target.text.length === 0) {
                appendText(target, expandTilde(literal, state), quoted, false);
                continue;
            }
            /* Literal text is never field-split: only what an expansion produced is. */
            appendText(target, literal, quoted, false);
            continue;
        }
        if (part.t === 'sq') {
            appendText(target, part.v, true);
            continue;
        }
        if (part.t === 'dq') {
            expandParts(state, part.parts, true, target);
            continue;
        }
        if (part.t === 'arith') {
            /* An expression that will not evaluate fails the line it stands on, with the status a
               host gives it: `x=$((1+))` is `sh: 1+: syntax error: operand expected (error token is
               "+")` and 127, where the message alone and a status of 1 left the line runnable. */
            let value: number;
            try {
                value = evalArith(state, expandToString(arithText(part.expr), state));
            } catch (error) {
                if (error instanceof ArithError) throw new ArithFailure(`${arithDiagnostic(state, part.expr, error)}\n`, 127);
                throw error;
            }
            appendText(target, String(Math.trunc(value)), quoted);
            continue;
        }
        if (part.t === 'cmd') {
            appendText(target, runSubstitution(state, part.script), quoted);
            continue;
        }
        const ref = part.ref;
        /* `"${a[@]}"` is one word per element, as `"$@"` is one word per positional parameter:
           `a=(x y z); for e in "${a[@]}"; do echo "<$e>"; done` is three lines on a host, where
           reading the array as one string gave one field holding all three. `"${a[*]}"` joins them
           with the first character of IFS, the way `"$*"` joins the positional parameters. */
        const allElements = quoted && ref.op === '' ? ARRAY_ALL_RE.exec(ref.name) : null;
        if (quoted && ref.op === '' && (ref.name === '@' || ref.name === '*' || allElements !== null)) {
            const elements = allElements !== null
                ? arrayElements(state, `${allElements[1]}[0]`)
                : state.positional;
            for (let i = 0; i < elements.length; i++) {
                if (i > 0) appendText(target, ref.name === '*' ? ifsJoiner(state) : FIELD_MARK, true);
                appendText(target, elements[i], true);
            }
            continue;
        }
        let name = ref.name;
        /* Indirection: `${!k}` names the variable *in* `k` -- `k=target; target=hit; echo ${!k}` is
           `hit`, and a `k` nothing was assigned to is an empty word, as it is on a host. The `!` is
           only indirection where it stands in front of the name with no operator behind it, so
           `${!k:-x}`, `${!k#y}` and the rest still mean what they meant. */
        if (name.startsWith('!') && ref.op === '') name = getVar(state, name.slice(1)) ?? '';
        let value: string | undefined;
        let set = false;
        if (name === '@' || name === '*') {
            value = state.positional.join(ifsJoiner(state));
            set = state.positional.length > 0;
        } else if (/^[0-9]$/.test(name)) {
            // `$0` is the name the shell was started as, not a positional: `sh -c 'echo $0' nm a1`
            // prints `nm`, and `$1` is then `a1`.
            if (name === '0') {
                value = state.shellName;
                set = true;
            } else {
                value = state.positional[Number(name) - 1];
                set = value !== undefined;
            }
        } else if (name.length === 1 && '?$!#-'.includes(name)) {
            value = specialValue(state, name);
            set = value !== undefined;
        } else {
            value = getVar(state, name);
            set = isSet(state, name);
        }
        if (value === undefined && state.options.nounset && ref.op === '') throw new UnsetVariableError(`${name}: unbound variable`);
        const substituted = ref.op !== '' && /^\s*['"`]/.test(ref.arg);
        appendText(target, applyModifier(state, ref, value, set, name), quoted || substituted);
    }
}

/** Expands a word to one string: no field splitting, no pathname expansion. */
function expandToString(word: Word, state: ShellState): string {
    const target: Expanded = { text: '', quoted: [], split: [] };
    expandParts(state, word, false, target);
    return target.text.split(FIELD_MARK).join(' ');
}

/**
 * What `$*` joins the positional parameters with: the first character of IFS, a space where IFS is
 * unset, and nothing at all where it is null -- `IFS=; set -- a b; echo "$*"` prints `ab`.
 */
function ifsJoiner(state: ShellState): string {
    const ifs = getVar(state, 'IFS') ?? ' \t\n';
    return ifs === '' ? '' : ifs.slice(0, 1);
}

/**
 * Whether a word is quoted somewhere, so that a word coming to nothing is still one empty field:
 * `set -- ''; echo $#` prints 1 while `set -- $undef; echo $#` prints 0, the field splitting having
 * nothing to split. `"$@"` is the one exception a host shell makes -- it gives no field at all while
 * no positional parameter stands behind it, where `"$*"` in the same place is one empty field.
 */
function wordIsQuoted(word: Word): boolean {
    for (const part of word) {
        if (part.t === 'sq') return true;
        if (part.t !== 'dq') continue;
        if (part.parts.length === 0) return true;
        for (const inner of part.parts) {
            if (inner.t === 'var' && inner.ref.op === '' && inner.ref.name === '@') continue;
            return true;
        }
    }
    return false;
}

/**
 * The words a brace group in one of `word`'s literal parts makes, or null where the word holds
 * none. The parts around the one that holds the group are kept as they are, so `pre{a,b}$x` is two
 * words that each still carry the `$x` behind them.
 */
function braceWord(word: Word): Word[] | null {
    for (let i = 0; i < word.length; i++) {
        const part = word[i];
        if (part.t !== 'lit') continue;
        const expanded = braceExpand(part.v);
        if (expanded === null) continue;
        return expanded.map((text) => {
            const copy = word.slice();
            copy[i] = { t: 'lit', v: text };
            return copy;
        });
    }
    return null;
}

/** Expands a word the way a command argument is expanded: splitting, then pathname expansion. */
function expandWord(state: ShellState, word: Word): string[] {
    /* Brace expansion is the first expansion a word gets, and it is the only one that makes one
       word into several: `echo a{b,c}d` runs `echo` with two arguments. It is done before the
       word's own parts are expanded, because a brace group may stand next to a variable -- `x=q;
       echo pre{a,b}$x` is `preaq prebq` -- and it never touches quoted text, which is why only the
       literal parts are looked at. `set +B` turns it off, as it does on a host. */
    if (state.options.braceexpand) {
        const braced = braceWord(word);
        if (braced !== null) {
            const out: string[] = [];
            for (const piece of braced) out.push(...expandWord(state, piece));
            return out;
        }
    }
    const target: Expanded = { text: '', quoted: [], split: [] };
    expandParts(state, word, false, target);
    if (target.text.includes(FIELD_MARK)) return target.text.split(FIELD_MARK);
    const ifs = getVar(state, 'IFS');
    /* Field splitting is something a shell does to the result of an expansion, so a word holding no
       unquoted expansion is never split: `IFS=:; echo a:b` prints `a:b`. Where the word does hold
       one, every unquoted character of it may end a field, its own literal text included, which is
       why `IFS=:; s=a:b; echo $s:y` prints `a b y`. */
    const splits = target.split.includes(true);
    const fields = splitFieldsQuoted(
        target.text,
        target.quoted,
        ifs === undefined ? ' \t\n' : ifs,
        target.quoted.map((isQuoted) => splits && !isQuoted)
    );
    if (fields.length === 0) {
        /* A word that expanded to nothing and was never quoted is no argument at all; a quoted one
           is one empty argument, which is what `printf ''` and `set -- ''` turn on. */
        if (!wordIsQuoted(word)) return [];
        return state.options.noglob ? [''] : expandGlob(state, '', []);
    }
    if (state.options.noglob) return fields.map((field) => field.text);
    const out: string[] = [];
    for (const field of fields) out.push(...expandGlob(state, field.text, field.quoted));
    return out;
}

function expandWords(state: ShellState, words: Word[]): string[] {
    const out: string[] = [];
    for (const word of words) out.push(...expandWord(state, word));
    return out;
}

function expandAssignment(state: ShellState, assign: Assignment): string {
    const base = assign.append ? getVar(state, assign.name) ?? '' : '';
    return base + expandToString(assign.value, state);
}

/**
 * One assignment a command carries in front of it, expanded.
 *
 * A compound assignment carries its elements rather than one value: `a=(x y z)` is three of them,
 * and each is expanded as a word is -- `a=($v w)` takes `$v` for what it holds.
 */
interface PendingAssign {
    name: string;
    value: string;
    array?: string[];
    arrayAppend?: boolean;
}

function expandAssign(state: ShellState, assign: Assignment): PendingAssign {
    if (assign.array !== undefined) {
        return {
            name: assign.name,
            value: '',
            array: assign.array.map((word) => expandToString(word, state)),
            arrayAppend: assign.arrayAppend === true
        };
    }
    return { name: assign.name, value: expandAssignment(state, assign) };
}

/**
 * Puts the assignments a command carried in front of it in place.
 *
 * An assignment in front of a command is one the command *sees* and one the shell does not keep:
 * `IFS=: read x y` splits on the colon and `IFS` is the default again behind it, and `v=1 read x`
 * leaves no `v` at all -- which is what this machine's `/bin/sh` does for a builtin, special or
 * not, and why `pending` is undone below. An assignment with no command behind it is the one the
 * shell keeps, and it never comes through here.
 *
 * Returns false where a readonly name refused the assignment, which is the one case the caller
 * reports instead of running the command.
 */
function pushPending(state: ShellState, pending: PendingAssign[]): boolean {
    for (const entry of pending) {
        if (entry.array !== undefined) {
            if (!assignArray(state, entry.name, entry.array, entry.arrayAppend === true)) return false;
            continue;
        }
        if (!setVar(state, entry.name, entry.value)) return false;
        if (state.options.allexport) markExported(state, entry.name);
    }
    return true;
}

/** What each of `pending` displaced: its value, or the fact that it had none. */
interface PendingSaved {
    value: string | undefined;
    /** The elements the name held, for an assignment that is an array's. */
    elements: string[] | undefined;
}

function savePending(state: ShellState, pending: PendingAssign[]): PendingSaved[] {
    return pending.map((entry) => ({
        value: getVar(state, entry.name),
        elements: entry.array === undefined ? undefined : arrayElements(state, `${entry.name}[0]`)
    }));
}

function restorePending(state: ShellState, pending: PendingAssign[], saved: PendingSaved[]): void {
    for (let i = 0; i < pending.length; i++) {
        const entry = pending[i];
        const before = saved[i];
        if (entry.array !== undefined) {
            clearArray(state, entry.name);
            const elements = before?.elements ?? [];
            for (let index = 0; index < elements.length; index++) setVar(state, `${entry.name}[${index}]`, elements[index]);
            if (before?.value === undefined) {
                const scope = lookupScope(state, entry.name);
                if (scope !== undefined) scope.delete(entry.name);
            } else setVar(state, entry.name, before.value);
            continue;
        }
        if (before?.value === undefined) {
            const scope = lookupScope(state, entry.name);
            if (scope !== undefined) scope.delete(entry.name);
            continue;
        }
        setVar(state, entry.name, before.value);
    }
}

/** Reads one line out of the shell's input buffer. */
function readLine(state: ShellState, delimiter: string, keep: boolean): { text: string; hit: boolean } {
    if (state.inputCursor >= state.inputBuffer.length) return { text: '', hit: false };
    let text = '';
    let i = state.inputCursor;
    let hit = false;
    while (i < state.inputBuffer.length) {
        const ch = state.inputBuffer[i];
        if (ch === delimiter) {
            hit = true;
            i++;
            break;
        }
        if (ch === '\\' && !keep) {
            const next = state.inputBuffer[i + 1];
            if (next === '\n') {
                i += 2;
                continue;
            }
            if (next !== undefined) {
                text += next;
                i += 2;
                continue;
            }
        }
        text += ch;
        i++;
    }
    state.inputCursor = i;
    return { text, hit };
}

function splitForRead(state: ShellState, line: string, count: number): string[] {
    if (count <= 1) return [line];
    const ifs = getVar(state, 'IFS') ?? ' \t\n';
    const fields = splitFields(line, line.split('').map(() => false), ifs);
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        if (i < count - 1) out.push(fields[i] ?? '');
        else out.push(fields.slice(i).join(ifs[0] ?? ' '));
    }
    return out;
}

/* ================================================================== *
 * 6. Output, snapshots, traps
 * ================================================================== */

function writeOut(state: ShellState, text: string): void {
    state.io.stdout += text;
}

function writeErr(state: ShellState, text: string): void {
    state.io.stderr += text;
}

/**
 * Writes text where the shell's standard output points *now*, which is not always the stream it
 * was started with: `exec >f` moved it to a file and `exec >&2` to the error stream.
 */
function writeThroughStdout(state: ShellState, text: string): void {
    const target = state.stdoutTarget;
    if (target.kind === 'err') writeErr(state, text);
    else if (target.kind === 'file' && target.file !== undefined) writeOutputFile(state, target.file, text, Boolean(target.append));
    else if (target.kind === 'out') writeOut(state, text);
    /* A closed output keeps the text rather than losing it: the write a host makes is the one that
       fails again, and what it could not write is still there for the next one. */
}

/**
 * Puts out what the shell has been holding since a write to a closed descriptor could not hold it.
 *
 * The flush is late, which is the whole of the difference: `exec >d; echo hi >&-; exec >&2; echo
 * O=[$(cat d)]` is a host's `hi` on the error stream -- where the output had got to by the time the
 * buffer went out -- and `O=[hi]`, because the substitution forked while the text was still held
 * and inherited it. Writing it where the shell's output pointed when the write failed gives `hi`
 * on the output `O=[]` was read from, and nothing at all for the substitution to inherit.
 *
 * A flush that finds the output still closed writes nothing and holds the text on, exactly as a
 * host's own failed flush does: `exec 1>&-; echo hi` leaves no `hi` behind it.
 */
function flushHeld(state: ShellState): void {
    if (state.held === '') return;
    if (state.stdoutTarget.kind === 'null') return;
    const text = state.held;
    state.held = '';
    writeThroughStdout(state, text);
}

interface Snapshot {
    scopes: Map<string, ShellVar>[];
    cwd: string;
    options: ShellOptions;
    positional: string[];
    dirs: string[];
    umask: number;
    traps: Map<string, TrapSpec>;
    openFds: Map<number, StreamTarget>;
    stdoutTarget: StreamTarget;
    stderrTarget: StreamTarget;
    stdinClosed: boolean;
    held: string;
    aliases: Map<string, string>;
    functions: Map<string, FunctionDef>;
    optind: number;
    optchar: number;
    optarg: string;
    inputBuffer: string;
    inputCursor: number;
    lastStatus: number;
    exitCalled: boolean;
}

function snapshotState(state: ShellState): Snapshot {
    return {
        scopes: state.scopes.map((scope) => new Map([...scope].map(([name, variable]) => [name, { ...variable }]))),
        cwd: state.cwd,
        options: { ...state.options },
        positional: state.positional.slice(),
        dirs: state.dirs.slice(),
        umask: state.umask,
        traps: new Map([...state.traps].map(([name, spec]) => [name, { ...spec }])),
        openFds: new Map([...state.openFds].map(([fd, entry]) => [fd, { ...entry }])),
        stdoutTarget: { ...state.stdoutTarget },
        stderrTarget: { ...state.stderrTarget },
        stdinClosed: state.stdinClosed,
        held: state.held,
        aliases: new Map(state.aliases),
        functions: new Map(state.functions),
        optind: state.optind,
        optchar: state.optchar,
        optarg: state.optarg,
        inputBuffer: state.inputBuffer,
        inputCursor: state.inputCursor,
        lastStatus: state.lastStatus,
        exitCalled: state.exitCalled === true
    };
}

function restoreState(state: ShellState, snapshot: Snapshot): void {
    state.scopes = snapshot.scopes;
    state.cwd = snapshot.cwd;
    state.options = snapshot.options;
    state.positional = snapshot.positional;
    state.dirs = snapshot.dirs;
    state.umask = snapshot.umask;
    state.traps = snapshot.traps;
    state.openFds = snapshot.openFds;
    state.stdoutTarget = { ...snapshot.stdoutTarget };
    state.stderrTarget = { ...snapshot.stderrTarget };
    state.stdinClosed = snapshot.stdinClosed;
    /* A subshell and a pipeline stage are processes of their own on a host, so what either held
       when it ended went with it: `(echo hi) >&-` and `echo hi >&- | cat` print no `hi` at all. */
    state.held = snapshot.held;
    state.aliases = snapshot.aliases;
    state.functions = snapshot.functions;
    state.optind = snapshot.optind;
    state.optchar = snapshot.optchar;
    state.optarg = snapshot.optarg;
    state.inputBuffer = snapshot.inputBuffer;
    state.inputCursor = snapshot.inputCursor;
    state.exitCalled = snapshot.exitCalled;
    state.lastStatus = snapshot.lastStatus;
}

/**
 * The status the command substitution that ran last ended with. A substitution is a subshell, and
 * one that ended on a failure under `set -e` inside it -- `x=$(false; echo hi)` -- leaves that
 * status behind it for the command it stood in, which is why `set -e; x=$(false; echo hi); echo
 * after` prints nothing and exits 1 on a host. Read by the assignment of `runSimple`, and only
 * there: `echo $(false)` is 0, because it is `echo` whose status the line takes.
 */
let substitutionStatus = 0;

/** Command substitution: runs a script in a copied state and returns its stdout minus newlines. */
function runSubstitution(state: ShellState, script: string): string {
    const snapshot = snapshotState(state);
    const savedIo = state.io;
    /* What the substitution captures is the standard output of the script it runs, so the script
       starts with the shell's own output target put back however `exec` had moved it: `exec >f;
       echo [$(echo hi)]` writes `[hi]` into `f`, where inheriting the target wrote `hi` to the file
       and captured nothing at all. The error is still the shell's own, as it is on a host -- only
       the output is the substitution's. */
    state.stdoutTarget = { kind: 'out' };
    const inherited = state.traps.get('EXIT');
    state.io = { stdout: '', stderr: '' };
    let status = 0;
    try {
        const nodes = new Parser(script, state).parse();
        status = runCommandList(state, nodes, null);
    } catch (error) {
        if (error instanceof ExitSignal || error instanceof ReturnSignal) status = error.code;
        else if (!(error instanceof BreakSignal) && !(error instanceof ContinueSignal)) {
            writeErr(state, errorMessage(error) + '\n');
        }
    }
    /* A substitution's own EXIT trap runs before its output is taken, so `x=$(trap 'echo inner'
       EXIT; echo hi)` captures `inner` into `x` -- and the shell's own trap is left for its exit. */
    runOwnExitTrap(state, inherited);
    /* What the shell was still holding when this substitution forked is part of what it captured:
       a host forks the substitution out of a shell whose buffer still holds the text a closed
       descriptor could not take, and the child writes it out of its own copy of that buffer --
       `exec >d; echo hi >&-; exec >&2; echo O=[$(cat d)]` is a host's `O=[hi]`, with `d` empty. */
    if (state.held !== '') {
        const carried = state.held;
        state.held = '';
        state.io.stdout += carried;
    }
    const captured = state.io;
    state.io = savedIo;
    writeErr(state, captured.stderr);
    restoreState(state, snapshot);
    substitutionStatus = status;
    return captured.stdout.replace(/\n+$/, '');
}

function runTrap(state: ShellState, name: string): void {
    const trap = state.traps.get(name);
    if (!trap || trap.reset || trap.ignore) return;
    try {
        const nodes = new Parser(trap.action, state).parse();
        for (const node of nodes) runCommandList(state, [node], null);
    } catch {
        /* a trap does not change the shell's own status here */
    }
}

/* ================================================================== *
 * 7. The engine
 * ================================================================== */

let RUNNER: SimpleCommandRunner = (_state, words) => ({
    stdout: '',
    stderr: `Command not found: ${words[0] ?? ''}\n`,
    exitCode: 127
});

/** Installs the callback `runScript` runs every simple command through. */
export function setRunner(runner: SimpleCommandRunner): void {
    RUNNER = runner;
    HAS_RUNNER = true;
}

/** The installed runner, so a host can chain to it. */
export function getRunner(): SimpleCommandRunner {
    return RUNNER;
}

/** Set once a host has installed a runner; the default one only ever reports 127. */
let HAS_RUNNER = false;

/** True when a host has installed a runner with `setRunner`. */
export function hasRunner(): boolean {
    return HAS_RUNNER;
}

/**
 * Runs one command through the installed runner, for a utility that is not itself a builtin.
 *
 * `nice`, `nohup`, `time` and `watch` in `procinfo.ts` exist to run something. They ask the process
 * host first, and a host that only lists processes has no `run`, so they would otherwise report
 * that they cannot run a command. The runner this falls back to is the shell's own dispatcher: it
 * reads `state.host`, casts it to its own shell and dispatches the words through it, so the state
 * it is handed carries the smallest object that answers every field that dispatch reads from a
 * shell -- its file system, its directory, its environment, its input and its last status.
 *
 * Null when no host has installed a runner, which is the one case the caller must report itself.
 */
export function runWithRunner(ctx: CommandContext, words: string[], input: string | null): CommandResult | null {
    if (!HAS_RUNNER) return null;
    const shell = {
        ctx: { fileSystem: ctx.fs },
        cwd: ctx.cwd ?? '/',
        env: ctx.env ?? {},
        input: input ?? null,
        lastStatus: 0
    };
    const state = createShellState(shell.env, shell.cwd, ctx.fs as unknown as ShellFs);
    state.host = shell;
    return RUNNER(state, words, input ?? null);
}

let ACTIVE: ShellState | null = null;

/** Binds a state for `COMMANDS` entries a host calls with its own contexts. */
export function setActiveState(state: ShellState | null): void {
    ACTIVE = state;
}

const CTX_STATE = new WeakMap<object, ShellState>();

function stateOf(ctx: CommandContext): ShellState {
    const bound = CTX_STATE.get(ctx as object);
    if (bound) return bound;
    if (ACTIVE) return ACTIVE;
    const fresh = createShellState(ctx.env ?? {}, ctx.cwd ?? '/');
    fresh.fs = ctx.fs as unknown as ShellFs;
    CTX_STATE.set(ctx as object, fresh);
    return fresh;
}

function bindState(ctx: CommandContext, state: ShellState): CommandContext {
    CTX_STATE.set(ctx as object, state);
    return ctx;
}

/**
 * An arithmetic error written the way a host writes it, and carrying the status a host gives it.
 * The whole line fails on it and nothing behind it runs, which is what `x=$((1+)); echo after`
 * does on a host: no `after`, and a status of 127.
 */
class ArithFailure extends Error {
    constructor(readonly detail: string, readonly status: number) {
        super(detail);
    }
}

/**
 * The offsets each physical line of `src` occupies. `end` stops behind the line's own newline, so
 * a slice of `0 .. spans[n].end` is the lines up to and including line `n`.
 */
function lineSpans(src: string): { start: number; end: number }[] {
    const spans: { start: number; end: number }[] = [];
    let start = 0;
    while (start < src.length) {
        const at = src.indexOf('\n', start);
        if (at === -1) {
            spans.push({ start, end: src.length });
            break;
        }
        spans.push({ start, end: at + 1 });
        start = at + 1;
    }
    return spans;
}

/** Which line of `src` a position is on: the newline count in front of it. */
function lineIndexOf(src: string, at: number): number {
    let line = 0;
    const upto = Math.min(Math.max(at, 0), src.length);
    for (let i = 0; i < upto; i++) if (src[i] === '\n') line++;
    return line;
}

/**
 * Runs the lines that stand in front of the one a syntax error stands on.
 *
 * A host reads a script a line at a time and runs each line the moment it has parsed it, so by the
 * time it reports a line that will not parse, the lines in front of it have already run -- `echo
 * a` newline `if; then` prints `a`, and `cat <<EOF` newline `x` newline `EOF` newline `if; then`
 * prints `x`. Nothing of the failing line runs, not even the commands in front of the construct on
 * it, which is why `echo a; if; then` prints nothing at all.
 *
 * A construct that spans lines is one unit to a host, so a prefix that stops inside one has not
 * been read yet and must not run: `echo a` newline `(echo b` newline `if; then)` prints only the
 * `a` of the line before, and `(echo a` newline `if; then)` prints nothing. Backing a line off at
 * a time until what is left parses is what keeps such a half-read construct from running, which is
 * also why a here-document keeps its body -- `cat <<EOF` alone has none, and running it printed
 * nothing where a host printed the body.
 *
 * A prefix that ended the shell is one a host never came back from: it reads a script a line at a
 * time and stops where the `exit` is, so the line behind it that will not parse is never read and no
 * syntax error is ever reported -- `exit 3` newline `if; then` is status 3 and empty, and `echo a`
 * newline `exit 5` newline `if; then` is `a` and status 5. The signal is handed on rather than
 * swallowed, which is also what keeps the shorter prefix the loop falls back to from running the
 * same commands a second time.
 */
function runLinesBefore(state: ShellState, script: string, errorLine: number): void {
    const spans = lineSpans(script);
    for (let end = errorLine - 1; end >= 0; end--) {
        const prefix = script.slice(0, spans[end].end);
        try {
            runCommandList(state, new Parser(prefix, state).parse(), null);
            return;
        } catch (error) {
            if (error instanceof ExitSignal) throw error;
            /* A `return` with nowhere to return to does not end the shell -- a host writes its own
               complaint about it and reads on -- so what stands in front of it has run and the line
               behind it is still the one that will not parse. Falling back to a shorter prefix would
               run those commands a second time, so this is where the walk back stops. */
            if (error instanceof ReturnSignal) return;
            /* not a whole unit: drop the line it ends on and try what stands in front of it */
        }
    }
}

/** Parses and runs a whole script, and reports one that failed the way a shell reports it. */
function runParsed(state: ShellState, script: string): number {
    try {
        const nodes = new Parser(script, state).parse();
        return runCommandList(state, nodes, null);
    } catch (error) {
        if (error instanceof ExitSignal) return error.code;
        if (error instanceof ReturnSignal) return error.code;
        if (error instanceof ShellSyntaxError) {
            const at = error.at ?? script.length;
            try {
                runLinesBefore(state, script, lineIndexOf(script, at));
            } catch (signal) {
                /* The lines in front of the bad one ended the shell, so the bad one was never read:
                   the `exit`'s status is the script's, and no syntax error is reported at all. */
                if (signal instanceof ExitSignal) return signal.code;
            }
            /* A host names the line it read, and says it read the one `-c` was handed: `/bin/sh: -c:
               line 1: syntax error near unexpected token `;''. Where the input ended it names the
               line the end stands on -- the empty one a trailing newline leaves behind it, or the
               one past the last when the script stops mid-line -- which is not the line the token
               that opened the unclosed quote stands on, so an unclosed quote is two reports on two
               different lines. */
            const heading = (line: number): string =>
                `${state.shellName === '' ? 'sh' : state.shellName}: -c: line ${line}: `;
            const eofLine = lineIndexOf(script, script.length) + (script.endsWith('\n') ? 0 : 1);
            const line = error.message === 'syntax error: unexpected end of file' ? eofLine : lineIndexOf(script, at);
            writeErr(state, `${heading(line)}${error.message}\n`);
            if (error.message.startsWith('syntax error near unexpected token')) {
                const spans = lineSpans(script);
                const span = spans[Math.min(line, spans.length - 1)];
                if (span !== undefined) writeErr(state, `${heading(line)}\`${script.slice(span.start, span.end).replace(/\n$/, '')}'\n`);
            } else if (error.message.startsWith('unexpected EOF while looking for matching')) {
                /* An unclosed quote is two reports on a host, not one: the lexer names the quote
                   it never found the match for, and the parser then finds the input ended where a
                   command should have been -- `echo 'abc` is the one line and then the other. */
                writeErr(state, `${heading(eofLine)}syntax error: unexpected end of file\n`);
            }
            return 2;
        }
        if (error instanceof UnsetVariableError) {
            /* The complaint about a variable `set -u` will not read is one a host writes without the
               line it stands on -- `$0: nope: unbound variable` -- and the shell a line was handed
               to with `-c` ends on it, leaving 127. */
            writeErr(state, `${state.shellName}: ${error.message}\n`);
            return 127;
        }
        /* An arithmetic error already written the way a host writes it, carrying the status a host
           gives it -- 127 for an expression that will not evaluate, and 1 for `let` behind it. */
        if (error instanceof ArithFailure) {
            writeErr(state, error.detail);
            return error.status;
        }
        writeErr(state, `${errorMessage(error)}\n`);
        return 1;
    }
}

/** The front door: parses and runs a whole script. */
export function runScript(state: ShellState, script: string): { stdout: string; stderr: string; exitCode: number } {
    state.io = { stdout: '', stderr: '' };
    const exitCode = runParsed(state, script);
    /* The line is over, so whatever the shell was still holding goes out now: `sh -c 'echo hi >&-'`
       prints `hi`, and `sh -c 'exec >d; echo hi >&-'` leaves it in `d`. */
    flushHeld(state);
    runTrap(state, 'EXIT');
    return { stdout: state.io.stdout, stderr: state.io.stderr, exitCode };
}

/**
 * One script run without the shell's EXIT trap: a job, a subshell and a substitution are not the
 * shell's own exit, and only the shell's own exit runs the trap -- `trap 'echo t' EXIT; (exit 0) &
 * wait; echo main` prints `main` then `t`, once, as it does in a host shell. Running a job through
 * `runScript` fired the trap for the job as well, which is why it came out before the rest of the
 * line and then again at the end of it.
 */
/**
 * Runs the EXIT trap a subshell set for ITSELF, and only that one.
 *
 * A job, a subshell and a substitution are not the shell's own exit, so the trap *the shell* set is
 * not run for them -- `trap 'echo t' EXIT; (echo s) & wait; echo main` prints `main` then `t` -- but
 * one they set themselves is: `trap 'echo t' EXIT; (trap 'echo inner' EXIT) & wait` prints `inner`,
 * and `x=$(trap 'echo inner' EXIT; echo hi)` captures it into the substitution. `inherited` is the
 * entry the parent had, so an entry that is still that one is the parent's and stays unrun.
 */
function runOwnExitTrap(state: ShellState, inherited: TrapSpec | undefined): void {
    /* Compared by value, not by identity: a subshell that ran inside has already put its state
       back, and what it put back is a copy of the entry the parent had -- a different object that
       is still the parent's trap, which must stay unrun. */
    if (trapsEqual(state.traps.get('EXIT'), inherited)) return;
    runTrap(state, 'EXIT');
}

function trapsEqual(a: TrapSpec | undefined, b: TrapSpec | undefined): boolean {
    if (a === b) return true;
    if (a === undefined || b === undefined) return false;
    return a.action === b.action && a.reset === b.reset && a.ignore === b.ignore;
}

function runScriptNoExitTrap(state: ShellState, script: string): { stdout: string; stderr: string; exitCode: number } {
    const inherited = state.traps.get('EXIT');
    state.io = { stdout: '', stderr: '' };
    const exitCode = runParsed(state, script);
    runOwnExitTrap(state, inherited);
    return { stdout: state.io.stdout, stderr: state.io.stderr, exitCode };
}

/** Parses a script and reports a syntax error the way `runScript` would (status 2). */
export function checkSyntax(state: ShellState, script: string): { ok: boolean; message: string } {
    try {
        new Parser(script, state).parse();
        return { ok: true, message: '' };
    } catch (error) {
        return { ok: false, message: error instanceof ShellSyntaxError ? error.message : errorMessage(error) };
    }
}

function runCommandList(state: ShellState, nodes: Node[], input: string | null): number {
    let status = 0;
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.op === '&&' && status !== 0) continue;
        if (node.op === '||' && status === 0) continue;
        /* What `set -e` must not end the shell on, the way this machine's /bin/sh has it: a command
           of an AND-OR list that is not its last -- `set -e; false && true; echo after` prints
           `after`, and `set -e; true && false; echo after` does not, because `false` is the last --
           and one whose status `!` inverts, `set -e; ! true; echo after`. The test has to happen
           while the depth is still raised: below the `finally` it is already back to 0, so every
           failure ended the shell and no exemption ever held. */
        const exempt = node.bang === true || (i + 1 < nodes.length && nodes[i + 1].op !== null);
        if (exempt) state.protectedDepth++;
        try {
            status = runNode(state, node, input);
            state.lastStatus = status;
            if (status !== 0 && state.protectedDepth === 0) {
                runTrap(state, 'ERR');
                if (state.options.errexit) throw new ExitSignal(status);
            }
        } finally {
            if (exempt) state.protectedDepth--;
        }
    }
    return status;
}

/**
 * A pipeline the shell does not wait for: `cmd &`, where the `&` is one this engine parsed.
 *
 * The job is the host's to start. The table `jobs` and `wait` read is the host's -- `state.jobs`
 * takes it out of `state.host` -- and so are the words a job is run from, so `state.startJob` is
 * asked to register it. A compound command is one too: `{ echo a; } &` and `for i in 1 2; do echo
 * $i; done &` are jobs a shell lists and waits for, and the host keeps the text of such a job and
 * hands it back to this engine to run, rather than losing the `&` and running it in the foreground.
 * Nothing is printed for the job: bash prints `[1] 12345` only in an interactive shell, and a line
 * handed to `sh -c` -- which is every line here -- gets no such line from it. The status of a
 * command the shell did not wait for is 0.
 *
 * Null where the foreground path must have the pipeline instead: a pipeline with no source to hand
 * over, a state with nothing installed to start one, or a host that declined the source it was
 * given. Waited for, such a command is late rather than lost -- and no job is ever invented for a
 * table that cannot run it.
 */
/**
 * Every node list a compound command holds its words in: the bodies an `if` and a `while` branch
 * into, the one a loop repeats, the items of a `case`.
 */
function nestedNodes(body: CommandBody): Node[][] {
    switch (body.t) {
        case 'if': {
            const lists = body.branches.flatMap((branch) => [branch.cond, branch.body]);
            if (body.else_ !== undefined) lists.push(body.else_);
            return lists;
        }
        case 'while': return [body.cond, body.body];
        case 'for':
        case 'forarith': return [body.body];
        case 'case': return body.items.map((item) => item.body);
        case 'group':
        case 'subshell': return [body.body];
        default: return [];
    }
}

/**
 * The here-document bodies a command was written with, in the order their `<<` stand in, each one
 * the source `readHeredocs` kept for it: the lines of the body and the delimiter line behind them.
 */
function collectHeredocs(command: Command, out: { text: string; from: number }[]): void {
    const redirects = (command as { redirects?: Redirect[] }).redirects;
    if (redirects !== undefined) {
        for (const redirect of redirects) {
            if (redirect.heredoc !== undefined && redirect.heredoc !== '') {
                out.push({ text: redirect.heredoc, from: redirect.heredocFrom ?? -1 });
            }
        }
    }
    for (const nodes of nestedNodes(command)) {
        for (const node of nodes) for (const inner of node.commands) collectHeredocs(inner, out);
    }
}

/**
 * What a job started from this pipeline is run as: the source it was written as, with the body of
 * every here-document on it put back behind it. The source ends at the `&`, and a body starts on
 * the line behind that one, so a job handed the source alone read an end of input its own command
 * line never wrote -- `cat <<EOF &` printed nothing where a host printed the body.
 */
function backgroundSource(node: Node): string {
    const source = node.source ?? '';
    const bodies: { text: string; from: number }[] = [];
    for (const command of node.commands) collectHeredocs(command, bodies);
    /* Only a body the source does not already hold is put back: a compound whose `&` lands behind
       its closing word -- `( cat <<EOF\nb\nEOF\n ) &`, `if ... fi &`, `for ... done &` -- spans its
       own body, and appending it again ran `b` and `EOF` as commands behind it. A body is inside
       the source when it starts before the source stops. */
    const behind = bodies.filter((body) => body.from >= (node.end ?? 0)).map((body) => body.text);
    if (behind.length === 0) return source;
    return source + '\n' + behind.join('');
}

function startBackgroundNode(state: ShellState, node: Node): number | null {
    const source = backgroundSource(node);
    if (source === '' || state.startJob === undefined) return null;
    const job = state.startJob(state, source);
    if (job === null || job === undefined) return null;
    state.lastBackgroundPid = job.pid;
    return 0;
}

function runNode(state: ShellState, node: Node, input: string | null): number {
    if (node.background === true) {
        const backgrounded = startBackgroundNode(state, node);
        if (backgrounded !== null) return backgrounded;
    }
    const protectedInner = node.bang || node.commands.length > 1;
    if (protectedInner) state.protectedDepth++;
    const statuses: number[] = [];
    let carried = input;
    let pendingOut = '';
    try {
        const isolated = node.commands.length > 1;
        for (let i = 0; i < node.commands.length; i++) {
            const savedIo = state.io;
            state.io = { stdout: '', stderr: '' };
            // bash runs every stage of a pipeline in a subshell: `echo x | read v` leaves v unset
            const snapshot = isolated ? snapshotState(state) : null;
            let status = 0;
            try {
                status = runCommand(state, node.commands[i], carried);
            } finally {
                const captured = state.io;
                state.io = savedIo;
                if (snapshot !== null) restoreState(state, snapshot);
                writeErr(state, captured.stderr);
                carried = captured.stdout;
                pendingOut = captured.stdout;
            }
            statuses.push(status);
        }
    } finally {
        if (protectedInner) state.protectedDepth--;
        // reaches the sink even when the command threw: `exec echo hi` still prints
        writeOut(state, pendingOut);
    }
    /* `PIPESTATUS` is the status of every stage of the pipeline, in the order the stages ran:
       `true | false | true; echo ${PIPESTATUS[1]}` is a host's `1`, and `${PIPESTATUS[@]}` after
       `false | true` is `1 0`. It is written before `!` and `pipefail` are applied, because both
       move the status of the pipeline and neither moves the status a stage ended with, and a
       command that ran on its own is a pipeline of one: `echo hi; echo ${PIPESTATUS[@]}` is `0`. */
    setPipeStatus(state, statuses);
    let status = statuses.length > 0 ? statuses[statuses.length - 1] : 0;
    if (state.options.pipefail) {
        const failed = statuses.find((entry) => entry !== 0);
        if (failed !== undefined) status = failed;
    }
    if (node.bang) status = status === 0 ? 1 : 0;
    return status;
}

/**
 * The status of every stage of the last pipeline, as `PIPESTATUS` reads it.
 *
 * The array is this file's own indexed-array emulation -- the elements live in the scopes as
 * `PIPESTATUS[0]`, `PIPESTATUS[1]`, ... -- and the name is left holding its first element, so
 * `$PIPESTATUS` and `${PIPESTATUS[1]}` both answer. A pipeline shorter than the one before it
 * drops the elements it no longer has: `true|false|true` and then `echo hi` leaves one.
 */
function setPipeStatus(state: ShellState, statuses: number[]): void {
    clearArray(state, 'PIPESTATUS');
    for (let i = 0; i < statuses.length; i++) setVar(state, `PIPESTATUS[${i}]`, String(statuses[i]));
    setVar(state, 'PIPESTATUS', statuses.length === 0 ? '' : String(statuses[0]));
}

/**
 * Redirections on a compound command: the file becomes the input of the whole construct, and the
 * construct's output is written to the file afterwards, as a shell does.
 */
function runCompoundRedirected(state: ShellState, command: Command, input: string | null, body: () => number): number {
    const redirects = (command as { redirects?: Redirect[] }).redirects ?? [];
    const plan = planRedirects(state, redirects);
    /* A redirection nothing can be made of ends the construct before a single command of it runs,
       as it does on a host: `{ echo hi; } >&9` is the bad descriptor's diagnostic and a status of
       1, with no `hi` written. The files the redirections ahead of the failure opened stay created
       and empty -- `{ echo a; } 3>f 2>&9` leaves an empty `f` -- and the ones behind it are never
       opened at all. */
    if (plan.error !== undefined) return finish(state, plan, '', '', 1);
    const fromFile = plan.inputFile !== undefined;
    const needsInput = fromFile || plan.inputText !== undefined || input !== null;
    const needsOutput = plan.stdoutTo.kind !== 'out' || plan.stderrTo.kind !== 'err';
    if (!needsInput && !needsOutput) return body();
    const savedBuffer = state.inputBuffer;
    const savedCursor = state.inputCursor;
    const given = plan.inputFd !== undefined ? readFdAt(state, plan.inputFd) : '';
    if (needsInput) {
        state.inputBuffer = fromFile
            ? (plan.inputFd !== undefined ? given : readInputFile(state, plan.inputFile as string))
            : plan.inputText ?? (input as string);
        state.inputCursor = 0;
    }
    const savedIo = state.io;
    state.io = { stdout: '', stderr: '' };
    /* A descriptor the construct closed is closed for every command inside it, not only for the
       write the construct makes of its own collected output at the end: `{ echo hi; } >&-` is a
       host's `hi` on the output behind it and `sh: line 0: echo: write error: Bad file descriptor`
       beside it, and `{ echo e >&2; } 2>&-` is `sh: 2: Bad file descriptor` -- the `>&2` inside it
       duplicates a descriptor the construct closed. Collecting the commands' text and closing the
       descriptor only afterwards left both silent, with no failure at all to report. */
    const closedOut = plan.stdoutTo.kind === 'null';
    const closedErr = plan.stderrTo.kind === 'null';
    const savedStdoutTarget = state.stdoutTarget;
    const savedStderrTarget = state.stderrTarget;
    if (closedOut) state.stdoutTarget = { kind: 'null' };
    if (closedErr) state.stderrTarget = { kind: 'null' };
    let status = 0;
    try {
        status = body();
    } finally {
        state.stdoutTarget = savedStdoutTarget;
        state.stderrTarget = savedStderrTarget;
        const captured = state.io;
        /* What the construct read out of a descriptor it was handed: a `read` inside it took its
           line through the cursor, and every command that reads in one go took the rest. */
        const offset = plan.inputFd?.read;
        if (offset !== undefined && needsInput) {
            offset.pos += state.inputCursor > 0 && state.inputCursor <= given.length ? state.inputCursor : given.length;
        }
        state.io = savedIo;
        if (needsInput) {
            state.inputBuffer = savedBuffer;
            state.inputCursor = savedCursor;
        }
        /* A diagnostic a command inside wrote reaches the shell's own error even where the
           construct closed the descriptor it would have gone to: a host undoes the redirection
           before it reports, so `{ echo e >&2; } 2>&-` is `sh: 2: Bad file descriptor`, while
           what a command wrote to that descriptor -- `{ ls nofile; } 2>&-` -- is gone with it. */
        if (closedErr && captured.stderr !== '') {
            writeClosedWriteError(state, plan, captured.stderr);
            finish(state, plan, captured.stdout, '', status);
        } else {
            finish(state, plan, captured.stdout, captured.stderr, status);
        }
    }
    return status;
}

/**
 * One word of a `[[ ... ]]`: the text it expanded to, and whether it was written quoted, which is
 * what tells a pattern from the text it would match -- `[[ abc == "a*" ]]` is false, while
 * `[[ abc == a* ]]` is true.
 */
interface CondWord {
    text: string;
    quoted: boolean;
}

/** True where any part of the word was written inside quotes. */
function condWordQuoted(word: Word): boolean {
    for (const part of word) if (part.t === 'sq' || part.t === 'dq') return true;
    return false;
}

/** The file tests a `[[ ]]` answers, read through the file system the shell holds. */
function condFileTest(state: ShellState, op: string, path: string): boolean {
    const fs = state.fs;
    if (fs === undefined || fs === null) return false;
    try {
        const exists = fs.fileExists(path) || fs.isDirectory(path);
        switch (op) {
            case '-e': case '-a': return exists;
            case '-f': return fs.fileExists(path) && !fs.isDirectory(path);
            case '-d': return fs.isDirectory(path);
            case '-r': case '-w': case '-x': return exists;
            case '-s': return fs.fileExists(path) && (fs.readFile(path) ?? '') !== '';
            default: return false;
        }
    } catch {
        /* A path this file system will not look at -- one in a directory it has no read bit for on
           a host -- is a path nothing is there, and a conditional expression asks about it without
           complaining: `[[ -f /etc/hosts ]]` is plain false here, not a diagnostic. */
        return false;
    }
}

/**
 * The value of a `[[ ... ]]`: true where the expression holds, which is the status 0 a host gives
 * it, and false where it does not, which is 1.
 *
 * Nothing inside the brackets is field-split or globbed, so the words are expanded as strings and
 * taken as they stand, and the operators are the ones bash reads there: `==` and `!=` with a
 * pattern on the right, `=~` with a regular expression, `<` and `>` for the order two strings
 * collate in, the arithmetic `-eq` to `-ge`, `&&`, `||`, `!` and the parentheses that group them.
 */
function evalConditional(state: ShellState, words: Word[]): boolean {
    const tokens: CondWord[] = words.map((word) => ({ text: expandToString(word, state), quoted: condWordQuoted(word) }));
    let at = 0;
    const peek = (offset = 0): CondWord | undefined => tokens[at + offset];
    const globMatch = (text: string, pattern: string): boolean => new RegExp(`^${globToRegExp(pattern, true).source}$`).test(text);
    const numeric = (text: string): number => {
        const value = Number(text.trim());
        return Number.isNaN(value) ? 0 : value;
    };
    const primary = (): boolean => {
        const token = peek();
        if (token === undefined) return false;
        if (token.text === '!') {
            at++;
            return !primary();
        }
        if (token.text === '(') {
            at++;
            const value = disjunction();
            if (peek()?.text === ')') at++;
            return value;
        }
        if (token.text === '-z') {
            at++;
            const value = (peek()?.text ?? '') === '';
            if (peek() !== undefined) at++;
            return value;
        }
        if (token.text === '-n') {
            at++;
            const value = (peek()?.text ?? '') !== '';
            if (peek() !== undefined) at++;
            return value;
        }
        if (/^-(e|a|f|d|r|w|x|s|L|h)$/.test(token.text) && peek(1) !== undefined) {
            const op = token.text;
            at++;
            const path = peek()?.text ?? '';
            at++;
            if (op === '-L' || op === '-h') return false;
            return condFileTest(state, op, resolvePath(state, path));
        }
        at++;
        const operator = peek();
        if (operator === undefined) return token.text !== '';
        const right = peek(1);
        if (right === undefined) return token.text !== '';
        if (operator.text === '==') {
            at += 2;
            /* A quoted right-hand side is the text it was written as, and an unquoted one is a
               pattern: `[[ abc == a* ]]` is true and `[[ abc == "a*" ]]` is false. */
            return right.quoted ? token.text === right.text : globMatch(token.text, right.text);
        }
        if (operator.text === '!=') {
            at += 2;
            return right.quoted ? token.text !== right.text : !globMatch(token.text, right.text);
        }
        if (operator.text === '=~') {
            at += 2;
            try {
                return new RegExp(right.text).test(token.text);
            } catch {
                return false;
            }
        }
        if (operator.text === '<') {
            at += 2;
            return token.text < right.text;
        }
        if (operator.text === '>') {
            at += 2;
            return token.text > right.text;
        }
        if (['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(operator.text)) {
            at += 2;
            const left = numeric(token.text);
            const value = numeric(right.text);
            switch (operator.text) {
                case '-eq': return left === value;
                case '-ne': return left !== value;
                case '-lt': return left < value;
                case '-le': return left <= value;
                case '-gt': return left > value;
                default: return left >= value;
            }
        }
        return token.text !== '';
    };
    const conjunction = (): boolean => {
        let value = primary();
        while (peek()?.text === '&&') {
            at++;
            value = primary() && value;
        }
        return value;
    };
    const disjunction = (): boolean => {
        let value = conjunction();
        while (peek()?.text === '||') {
            at++;
            value = conjunction() || value;
        }
        return value;
    };
    return disjunction();
}

function runCommand(state: ShellState, command: Command, input: string | null): number {
    state.line = command.line;
    switch (command.t) {
        case 'simple':
            return runSimple(state, command, input);
        case 'cond':
            return runCompoundRedirected(state, command, input, () => (evalConditional(state, command.words) ? 0 : 1));
        case 'arithcmd':
            return runCompoundRedirected(state, command, input, () => {
                try {
                    /* The status is the one a host takes from the value: 0 when the expression is
                       non-zero, 1 when it is zero, and 1 as well for one that will not evaluate --
                       `((1+))` is `sh: ((: 1+: syntax error: operand expected (error token is "+")`
                       and the status 1, never the 127 a `$((1+))` that will not expand is. */
                    return evalArith(state, command.expr) === 0 ? 1 : 0;
                } catch (error) {
                    if (error instanceof ArithError) {
                        writeErr(state, `${arithDiagnostic(state, command.expr, error, '((')}\n`);
                        return 1;
                    }
                    throw error;
                }
            });
        case 'if':
            return runCompoundRedirected(state, command, input, () => {
            for (const branch of command.branches) {
                state.protectedDepth++;
                let condition = 0;
                try {
                    condition = runCommandList(state, branch.cond, null);
                } finally {
                    state.protectedDepth--;
                }
                if (condition !== 0) continue;
                return runCommandList(state, branch.body, null);
            }
            if (command.else_ !== undefined) return runCommandList(state, command.else_, null);
            return 0;
            });
        case 'for':
            return runCompoundRedirected(state, command, input, () => {
            const items = command.words === null ? state.positional.slice() : expandWords(state, command.words);
            let status = 0;
            for (const item of items) {
                setVar(state, command.name, item);
                try {
                    status = runCommandList(state, command.body, null);
                } catch (error) {
                    if (error instanceof BreakSignal) {
                        if (error.count > 1) throw new BreakSignal(error.count - 1);
                        break;
                    }
                    if (error instanceof ContinueSignal) {
                        if (error.count > 1) throw new ContinueSignal(error.count - 1);
                        continue;
                    }
                    throw error;
                }
            }
            return status;
            });
        case 'forarith':
            return runCompoundRedirected(state, command, input, () => {
            /* `for ((init; test; next))`: the three parts are split on their `;`, an empty part is
               left out, and an empty test is true -- which is what `for ((;;))` loops on. */
            const parts = command.expr.split(';');
            const test = (parts[1] ?? '').trim();
            const next = (parts[2] ?? '').trim();
            const first = (parts[0] ?? '').trim();
            if (first !== '') evalArith(state, first);
            let status = 0;
            for (;;) {
                if (test !== '' && evalArith(state, test) === 0) break;
                try {
                    status = runCommandList(state, command.body, null);
                } catch (error) {
                    if (error instanceof BreakSignal) {
                        if (error.count > 1) throw new BreakSignal(error.count - 1);
                        break;
                    }
                    if (error instanceof ContinueSignal) {
                        if (error.count > 1) throw new ContinueSignal(error.count - 1);
                    } else throw error;
                }
                if (next !== '') evalArith(state, next);
            }
            return status;
            });
        case 'while':
            return runCompoundRedirected(state, command, input, () => {
            let status = 0;
            for (;;) {
                state.protectedDepth++;
                let condition = 0;
                try {
                    condition = runCommandList(state, command.cond, null);
                } finally {
                    state.protectedDepth--;
                }
                const proceed = command.negate ? condition !== 0 : condition === 0;
                if (!proceed) break;
                try {
                    status = runCommandList(state, command.body, null);
                } catch (error) {
                    if (error instanceof BreakSignal) {
                        if (error.count > 1) throw new BreakSignal(error.count - 1);
                        break;
                    }
                    if (error instanceof ContinueSignal) {
                        if (error.count > 1) throw new ContinueSignal(error.count - 1);
                        continue;
                    }
                    throw error;
                }
            }
            return status;
            });
        case 'case':
            return runCompoundRedirected(state, command, input, () => {
            const subject = expandToString(command.word, state);
            for (const item of command.items) {
                let matched = false;
                for (const pattern of item.patterns) {
                    /* The pattern is expanded with its quoting kept, so a `*` a quote took out of
                       the pattern is a `*` to match and not a wildcard: `case abc in "a*")` is a
                       case that does not match, as it does not in a host shell. */
                    const expanded: Expanded = { text: '', quoted: [], split: [] };
                    expandParts(state, pattern, false, expanded);
                    if (globMatch(expanded.text, subject, true, expanded.quoted)) {
                        matched = true;
                        break;
                    }
                }
                if (!matched) continue;
                return runCommandList(state, item.body, null);
            }
            return 0;
            });
        case 'group':
            return runCompoundRedirected(state, command, input, () => runCommandList(state, command.body, null));
        case 'subshell':
            return runCompoundRedirected(state, command, input, () => {
            const snapshot = snapshotState(state);
            const inheritedTrap = state.traps.get('EXIT');
            try {
                return runCommandList(state, command.body, null);
            } catch (error) {
                // `exit` inside ( ) leaves the subshell, not the script
                if (error instanceof ExitSignal) return error.code;
                throw error;
            } finally {
                /* A subshell is its own exit, so the EXIT trap it set for itself runs here -- before
                   the state is put back, which is the only place the trap it set is still the one
                   it set. `(trap 'echo inner' EXIT)` prints `inner`, and the shell's own `t` is
                   left for the shell. */
                runOwnExitTrap(state, inheritedTrap);
                restoreState(state, snapshot);
            }
            });
        case 'function': {
            state.functions.set(command.name, {
                name: command.name,
                body: command.body,
                source: state.source,
                line: command.line,
                text: command.text
            });
            return 0;
        }
        default:
            return 1;
    }
}

interface RedirectPlan {
    stdoutTo: StreamTarget;
    stderrTo: StreamTarget;
    inputFile?: string;
    /** The input a here-string wrote: text already read, never the name of a file to open. */
    inputText?: string;
    /**
     * The descriptor this command reads its standard input through -- one `exec 3<f` left open, or
     * one this command's own redirections opened -- where `inputFile` only ever named the file. It
     * is the descriptor and not the name because a read through it starts at the offset the reads
     * before it left, and moves it: `cat <&3` twice is the file once.
     */
    inputFd?: StreamTarget;
    /**
     * Descriptors above 2 a redirection opened for this one command: `cmd 3>f` creates `f` and
     * leaves it empty -- the command's own output still goes where it went -- and `exec 3>f` is
     * the one that keeps the descriptor open for the commands behind it.
     */
    opened: { fd: number; file: string; append: boolean }[];
    /**
     * The descriptors this command can name with `>&n` and `<&n`, in the order its own
     * redirections opened them: a copy of the ones `exec` left open, so `echo hi 3>f >&3` is a
     * write to `f` -- the descriptor the command opened itself is visible to the redirection
     * behind it -- while nothing a command opened outlives the command.
     */
    fds: Map<number, StreamTarget>;
    /** Whether `exec 0<&-` closed the standard input: a duplicate of `0` is then a bad descriptor. */
    stdinClosed?: boolean;
    /** The message of a descriptor nothing opened, which a host reports before running anything. */
    error?: string;
}

/**
 * Where one of the two standard descriptors goes, in the shape the plan carries -- and where a
 * descriptor `exec` opened points, which is the same shape: the shell's own output or error, a
 * file opened for writing (`append` once a write through it has moved its offset) or for reading,
 * or nothing at all because it was closed.
 */
type StreamTarget = { kind: 'out' | 'err' | 'file' | 'null' | 'input'; file?: string; append?: boolean; read?: ReadOffset };

/**
 * The offset a descriptor opened for reading carries through the file it holds: how far into that
 * file the reads made through the descriptor have gone. `exec 3<f` opens `f` and leaves `3` at its
 * first byte, and every read through `3` moves the offset on -- so `cat <&3` twice is `f` then
 * nothing, and `read x <&3; read y <&3` is the first line then the second, as they are on a host.
 *
 * One offset is shared by every descriptor that duplicates the same open file -- `exec 4<&3` puts
 * `4` on the offset `3` has, not on a second one of its own, so `cat <&4` is what `cat <&3` behind
 * it does not read again -- which is why it is a box a `{ ...entry }` copy carries with it rather
 * than a number: `exec 3<f` a second time opens `f` again and is a fresh offset of its own.
 */
interface ReadOffset { pos: number }

/**
 * Where `n>&m`, `n<&m` and `n>&-` point: the destination the named descriptor has *now*, the
 * shell's own output or error for `1` and `2`, the shell's own input for `0`, or nothing at all
 * for `-`.
 *
 * Undefined for a descriptor number nothing opened, which a host names and fails the command with
 * before it runs: `echo hi >&9` is `sh: 9: Bad file descriptor`, and the command never runs.
 *
 * `0` is the one standard descriptor a host holds open without anything having been redirected onto
 * it, so it is answered even where no `exec` ever named it: `exec 3>&0` duplicates the shell's own
 * standard input, and `echo hi >&3` behind it is the write error a write through a descriptor opened
 * for reading is -- not the `Bad file descriptor` a number nothing opened gives.
 */
function duplicateOf(
    plan: RedirectPlan,
    target: string,
    stdoutTo: StreamTarget = plan.stdoutTo,
    stderrTo: StreamTarget = plan.stderrTo,
    stdinTo: StreamTarget = { kind: 'input' }
): StreamTarget | undefined {
    if (target === '-') return { kind: 'null' };
    if (target === '1') return { ...stdoutTo };
    if (target === '2') return { ...stderrTo };
    if (!/^[0-9]+$/.test(target)) return { kind: 'file', file: target, append: false };
    const opened = plan.fds.get(Number.parseInt(target, 10));
    if (opened !== undefined) return { ...opened };
    if (target === '0') return plan.stdinClosed === true ? undefined : { ...stdinTo };
    return undefined;
}

/**
 * `n>&m`, `n>&-`: a descriptor moved to where another one already points, or closed.
 *
 * `1` and `2` are the two every command has, and the plan carries where they go. A higher one is a
 * descriptor `exec` opened earlier -- or one this very command opened ahead of this redirection,
 * which is why `echo hi 3>f >&3` writes `hi` into `f` -- and a number nothing opened is a bad
 * descriptor, which a host names and fails the command with before it runs.
 */
function planDuplicate(state: ShellState, plan: RedirectPlan, fd: number, target: string): void {
    const sink = (entry: StreamTarget): void => {
        if (fd === 2) plan.stderrTo = { ...entry };
        else if (fd === 1) plan.stdoutTo = { ...entry };
        else plan.fds.set(fd, { ...entry });
    };
    const resolved = duplicateOf(plan, target);
    if (resolved === undefined) {
        /* `echo hi >&9` on a host: `sh: 9: Bad file descriptor`, written without the `line 0`
           the jobspec diagnostics carry, and the command does not run. */
        if (plan.error === undefined) plan.error = `${state.shellName}: ${target}: Bad file descriptor\n`;
        return;
    }
    /* A number whose descriptor this very line closed: `echo hi 3>&- 2>&3` is `sh: 3: Bad file
       descriptor` on a host, because duplicating a descriptor that is no longer open is the
       failure a host names before the command runs -- not a sink the write disappears into. The
       descriptor it is duplicated *onto* being the same one is a host's no-op and not a failure at
       all: `echo hi 3>&- 3>&3` and `echo hi 2>&- 2>&2` both write `hi` and leave 0, so only a
       copy onto a different descriptor is the error. */
    if (resolved.kind === 'null' && /^[0-9]+$/.test(target) && Number.parseInt(target, 10) !== fd) {
        if (plan.error === undefined) plan.error = `${state.shellName}: ${target}: Bad file descriptor\n`;
        return;
    }
    /* `>&word` with a word no descriptor answers to is a name, not a number: the standard output
       takes both streams, the way `&>word` writes them -- `{ echo o; echo e >&2; } >&f` is `o` and
       `e` both in `f` -- while any other descriptor in front of the operator is a host's ambiguous
       redirect, which it names and fails the command with: `echo hi 2>&f` is `sh: f: ambiguous
       redirect` and writes nothing at all. */
    if (target !== '-' && !/^[0-9]+$/.test(target) && resolved.kind === 'file') {
        if (fd !== 1) {
            if (plan.error === undefined) plan.error = `${state.shellName}: ${target}: ambiguous redirect\n`;
            return;
        }
        plan.stdoutTo = { ...resolved };
        plan.stderrTo = { ...resolved };
        return;
    }
    sink(resolved);
    if (resolved.kind === 'file' && resolved.file !== undefined && /^[0-9]+$/.test(target)) {
        const number = Number.parseInt(target, 10);
        const moved: StreamTarget = { kind: 'file', file: resolved.file, append: true };
        plan.fds.set(number, moved);
        /* Only a descriptor the shell keeps open -- one `exec` opened -- is the one whose offset a
           write moved: `echo hi 3>f >&3` opens its own `3`, and nothing of it outlives the command. */
        if (state.openFds.has(number)) state.openFds.set(number, { ...moved });
    }
}

/**
 * Keeps the redirections of an `exec` that names no command, so the descriptors it opens are open
 * for the rest of the line and for the lines behind it: `exec 3>f; echo hi >&3; exec 3>&-`.
 *
 * Every descriptor is one the shell itself keeps -- `exec >f` sends the shell's own output to `f`,
 * `exec 3>&1` leaves `3` pointing where the output goes, and `exec 3<f` leaves it a descriptor that
 * is read -- and every one is applied in the order it was written, so `exec 4>f 3>&4` is a `3` that
 * names `f`, as it is in a host shell.
 *
 * The message of a redirection that cannot be made -- `exec 3>&4` with no `4` -- which a host
 * reports and ends a shell that is not reading a terminal with. Undefined when every one was made.
 */
function applyExecRedirects(state: ShellState, redirects: Redirect[]): string | undefined {
    const plan: RedirectPlan = {
        stdoutTo: { ...state.stdoutTarget },
        stderrTo: { ...state.stderrTarget },
        stdinClosed: state.stdinClosed,
        opened: [],
        fds: new Map([...state.openFds].map(([fd, entry]) => [fd, { ...entry }]))
    };
    const fds = new Map(state.openFds);
    let stdoutTo: StreamTarget = { ...state.stdoutTarget };
    let stderrTo: StreamTarget = { ...state.stderrTarget };
    const setFd = (fd: number, entry: StreamTarget): void => {
        /* The plan is what a redirection further along this same `exec` reads, so it is written
           as every descriptor is set and not only once the line ends: `exec 3>&1 4>&3` is a `4`
           pointing where the `3` opened one operator earlier points -- which is what a host
           gives, where each descriptor is opened in the order it was written -- while a plan
           filled once at the start held no `3` at all and named it a bad file descriptor. */
        if (fd === 1) {
            stdoutTo = entry;
            plan.stdoutTo = { ...entry };
        } else if (fd === 2) {
            stderrTo = entry;
            plan.stderrTo = { ...entry };
        } else if (entry.kind === 'null') {
            fds.delete(fd);
            plan.fds.delete(fd);
            /* A closed standard input is a number a host keeps and then refuses to hand out again,
               so the close is remembered and not only the missing descriptor: without it a later
               `exec 3<&0` answered a duplicate of nothing at all and succeeded. */
            if (fd === 0) {
                state.stdinClosed = true;
                plan.stdinClosed = true;
            }
        } else {
            fds.set(fd, entry);
            plan.fds.set(fd, { ...entry });
            if (fd === 0) {
                state.stdinClosed = false;
                plan.stdinClosed = false;
            }
            /* The standard input is the text the commands behind it read, so a file put on it is
               the shell's own input from here on: `exec 0<f; cat` prints `f`, and `read l` reads
               its first line, as they do on a host. */
            if (fd === 0 && entry.kind === 'input' && entry.file !== undefined) {
                /* A descriptor put on the standard input is one the shell itself reads from, and it
                   reads from the offset that descriptor has -- `exec 3<f; cat <&3; exec 0<&3; cat`
                   prints nothing the second time, where the `3` the first `cat` read to the end of
                   left nothing behind it for the shell to read. */
                state.inputBuffer = readFdAt(state, entry);
                state.inputCursor = 0;
                if (entry.read !== undefined) state.inputOffset = entry.read;
            }
        }
    };
    for (const redirect of redirects) {
        const target = expandToString(redirect.target, state);
        switch (redirect.op) {
            case '>':
            case '>>':
                setFd(redirect.fd, { kind: 'file', file: target, append: redirect.op === '>>' });
                break;
            case '<':
                /* A descriptor opened for reading: `exec 3<f; cat <&3` reads `f`, and the standard
                   input itself is the file from here on -- `exec 0<f; cat` prints `f`, which is what
                   a host's `exec 0<f` leaves behind it. Every `<` is a new open of the file, so it
                   starts at its first byte again even where the descriptor held it before:
                   `exec 3<f` twice is `f` read from the beginning, as it is on a host. */
                if (redirect.fd === 0 || redirect.fd >= 3) {
                    setFd(redirect.fd, { kind: 'input', file: target, read: { pos: 0 } });
                }
                break;
            case '>&':
            case '<&': {
                const resolved = duplicateOf(plan, target, stdoutTo, stderrTo);
                if (resolved === undefined) return `${state.shellName}: ${target}: Bad file descriptor\n`;
                setFd(redirect.fd, resolved);
                break;
            }
            default:
                break;
        }
    }
    state.openFds = fds;
    state.stdoutTarget = stdoutTo;
    state.stderrTarget = stderrTo;
    return undefined;
}

/**
 * A target `exec` left the shell with, read as the descriptor a host's `exec` left open: it is
 * already open, so a command writing through it writes at the offset the commands before it left.
 *
 * `exec >f; echo a; echo b` is both lines in `f`, which opening `f` again for `echo b` lost -- the
 * second open truncated the `a` away -- and a command that writes nothing leaves the file exactly
 * as it was, where opening it again emptied it: the `true` behind `exec 2>f; echo e >&2; true`
 * wiped the `e` the echo had just written. Only a redirection this command wrote itself opens the
 * file again, so only one of those truncates.
 */
function inherited(target: StreamTarget): StreamTarget {
    return target.kind === 'file' ? { ...target, append: true } : { ...target };
}

/**
 * The plan of one command: where its output and error go, what it reads, and the descriptors above
 * 2 its own redirections opened.
 *
 * The two standard descriptors start where the shell's own are -- which is where `exec` last put
 * them, so `exec >f; echo hi` writes into `f` -- and every redirection is applied in the order it
 * was written, so `2>&1 >f` and `>f 2>&1` send the error to two different places, as they do in a
 * host shell. A redirection nothing can be made of ends the plan: `echo hi >&3 3>f` names the bad
 * descriptor first, and the `f` behind it is never even opened.
 */
function planRedirects(state: ShellState, redirects: Redirect[]): RedirectPlan {
    const plan: RedirectPlan = {
        stdoutTo: inherited(state.stdoutTarget),
        stderrTo: inherited(state.stderrTarget),
        stdinClosed: state.stdinClosed,
        opened: [],
        fds: new Map([...state.openFds].map(([fd, entry]) => [fd, { ...entry }]))
    };
    for (const redirect of redirects) {
        if (plan.error !== undefined) break;
        const target = expandToString(redirect.target, state);
        switch (redirect.op) {
            case '>':
            case '>>':
                if (redirect.fd === 2) plan.stderrTo = { kind: 'file', file: target, append: redirect.op === '>>' };
                else if (redirect.fd === 1) plan.stdoutTo = { kind: 'file', file: target, append: redirect.op === '>>' };
                else {
                    plan.fds.set(redirect.fd, { kind: 'file', file: target, append: redirect.op === '>>' });
                }
                /* Every file a redirection names is opened where the operator stands, the standard
                   descriptors' with the rest: `echo hi >f >&-` leaves an empty `f` behind the write
                   error `>&-` gave, and `echo hi >f 2>&9` leaves it behind the bad descriptor's,
                   which is what a host leaves, where a file opened only as the command's output was
                   written came and went with the write itself. */
                plan.opened.push({ fd: redirect.fd, file: target, append: redirect.op === '>>' });
                break;
            case '<':
                /* A descriptor above 2 opened for reading is one only `>&n` and `<&n` name: `cat
                   3<f` reads the shell's own input, not `f`, as it does on a host. The open is this
                   command's own, so it starts at the first byte of `f`, whatever a descriptor `exec`
                   opened on the same file has read of it. */
                if (redirect.fd >= 3) plan.fds.set(redirect.fd, { kind: 'input', file: target, read: { pos: 0 } });
                else plan.inputFile = target;
                break;
            case '<<<':
                /* A here-string is the word, expanded as one word -- no field splitting, no globbing
                   -- with the newline a host shell writes after it: `read -r l <<< "x y"` reads the
                   line `x y`, and `cat <<< hi` prints `hi`. */
                plan.inputText = `${target}\n`;
                break;
            case '<<':
            case '<<-':
                /* A here-document's body: `readHeredocs` put the text itself in the target, and it
                   already ends in the newline its last line was written with. */
                plan.inputText = target;
                break;
            case '&>':
            case '&>>':
                plan.stdoutTo = { kind: 'file', file: target, append: redirect.op === '&>>' };
                plan.stderrTo = { kind: 'file', file: target, append: redirect.op === '&>>' };
                break;
            case '>&':
                /* A duplicate copies the destination the named descriptor has *now*, not where it
                   started: `> f 2>&1` sends both to `f`, while `2>&1 > f` leaves stderr on the
                   terminal. `2>&1` on a bare line therefore copies stdout's own destination. A
                   higher descriptor is one `exec` opened, or one this command's own redirections
                   opened ahead of it, and `>&3` is a write to the file it holds -- which used to be
                   read as a write to a file *named* `3`, so `echo hi >&3` made a file called `3`
                   instead of writing `hi` where `exec 3>f` had pointed it. */
                planDuplicate(state, plan, redirect.fd, target);
                break;
            case '<&': {
                if (target === '-') {
                    plan.inputFile = NULL_DEVICE;
                    break;
                }
                if (/^[0-9]+$/.test(target)) {
                    /* `1` and `2` are the two every command carries, and they are where this
                       command's own plan sends them: `exec 3<&1` duplicates the standard output,
                       which is not a descriptor nothing opened. */
                    const opened = duplicateOf(plan, target);
                    if (opened === undefined) {
                        if (plan.error === undefined) plan.error = `${state.shellName}: ${target}: Bad file descriptor\n`;
                        break;
                    }
                    if (redirect.fd >= 3) plan.fds.set(redirect.fd, { ...opened });
                    else if (opened.kind === 'file' || opened.kind === 'input') {
                        plan.inputFile = opened.file;
                        /* What the command reads is the file *from the offset this descriptor has*,
                           not the file from its first byte: `exec 3<f; cat <&3; cat <&3` is `f` and
                           then nothing, and the second `cat` has to move the offset too, so the
                           descriptor itself is what the plan keeps. */
                        plan.inputFd = opened;
                    }
                    else if (opened.kind === 'null') plan.inputFile = NULL_DEVICE;
                    break;
                }
                plan.inputFile = target;
                break;
            }
            default:
                break;
        }
    }
    return plan;
}

/**
 * `/dev/null` as a redirection names it: a sink, not a file in the tree.
 *
 * The container has no `/dev` to hold it, and a redirect that tried to open it there failed with
 * ENOENT on '/dev' before the command ran at all. What is written to the sink is discarded and what
 * is read from it is empty, which is what the host's own `/dev/null` does; no directory is created
 * and nothing else in the tree learns the name.
 */
const NULL_DEVICE = '/dev/null';

function readInputFile(state: ShellState, file: string): string {
    const fs = state.fs;
    if (!fs) return '';
    const path = resolvePath(state, file);
    if (path === NULL_DEVICE) return '';
    try {
        return fs.readFile(path) ?? '';
    } catch (error) {
        throw redirectFailure(state, file, error);
    }
}

/**
 * A redirection that could not open its target, the way a host reports it: the shell's name and the
 * file as it was written -- `cat < /nosuch/f` is `/bin/sh: /nosuch/f: No such file or directory`,
 * and `echo hi > /nosuch/x` the same for the `x` no directory holds. Any other failure keeps the
 * text the file system gave.
 */
function redirectFailure(state: ShellState, file: string, error: unknown): Error {
    const code = (error as { code?: string } | null | undefined)?.code;
    if (code === 'ENOENT' || errorMessage(error).startsWith('ENOENT')) {
        return new Error(`${state.shellName}: ${file}: No such file or directory`);
    }
    return new Error(`Failed to redirect to ${file}: ${errorMessage(error)}`);
}

/**
 * What a command reads through a descriptor it was handed with `<&3`: the file that descriptor
 * holds from the offset the reads through it have reached, so a second read through it reads what
 * the first left behind it -- which is nothing at all once a `cat` has been to the end of the file.
 */
function readFdAt(state: ShellState, target: StreamTarget): string {
    /* A descriptor a duplicate of the standard input left on the shell's own input: what it holds is
       what the shell has not read of that input yet, which is what a host's `cat <&3` behind an
       `exec 3>&0` reads. */
    if (target.file === undefined) {
        return state.inputCursor < state.inputBuffer.length ? state.inputBuffer.slice(state.inputCursor) : '';
    }
    const text = readInputFile(state, target.file);
    const offset = target.read;
    if (offset === undefined) return text;
    return offset.pos >= text.length ? '' : text.slice(offset.pos);
}

/**
 * The commands that take their standard input, and so move the offset of a descriptor they were
 * handed with `<&3`. A command that never reads -- `echo hi <&3` -- leaves the descriptor exactly
 * where it was, as it does on a host, and so does one whose operands name the files it reads.
 */
const STDIN_READERS = new Set([
    'awk', 'base32', 'base64', 'cat', 'comm', 'cut', 'dd', 'diff', 'fmt', 'grep', 'head', 'join',
    'mapfile', 'nl', 'paste', 'pr', 'read', 'readarray', 'sed', 'sort', 'split', 'tabs', 'tac',
    'tail', 'tr', 'unexpand', 'uniq', 'wc', 'xargs', 'xxd'
]);

/** True when `head` reads its standard input: no operand but the `-` that names it is a file. */
function headReadsStdin(args: string[]): boolean {
    let value = false;
    for (const arg of args) {
        if (value) {
            value = false;
            continue;
        }
        if (arg === '-n' || arg === '-c') {
            value = true;
            continue;
        }
        if (arg.startsWith('-')) continue;
        return false;
    }
    return true;
}

/**
 * Moves the offset of the descriptor a command read through, by what the command took from it: the
 * commands that read to the end of a file leave it at the end -- `cat <&3` twice is the file once --
 * and the two that read a part of one and leave the rest, `read` and `head`, leave it behind the
 * last byte they took: `read x <&3; read y <&3` is the first line and then the second, and
 * `head -1 <&3` twice is the first line and then the second, as they are on a host. The command's
 * own name and words are what says how much it took: one that never reads its standard input --
 * `echo hi <&3` -- leaves the descriptor where it was, and `head` leaves it behind what it wrote.
 */
function advanceReadFd(
    state: ShellState,
    plan: RedirectPlan,
    name: string,
    args: string[],
    stdout: string,
    given: string
): void {
    const offset = plan.inputFd?.read;
    if (offset === undefined) return;
    if (!STDIN_READERS.has(name)) return;
    if (state.inputCursor > 0 && state.inputCursor <= given.length) {
        offset.pos += state.inputCursor;
        return;
    }
    /* `head` writes exactly the bytes it took and puts the rest back, so what it wrote is what it
       read: `head -1 <&3` leaves the offset behind the first line, which is where a host's own
       `head` leaves it after it seeks back over the tail of the buffer it read. */
    if (name === 'head' && headReadsStdin(args) && stdout !== '' && given.startsWith(stdout)) {
        offset.pos += stdout.length;
        return;
    }
    offset.pos += given.length;
}

/**
 * True when a command's operands name the files it reads, so its standard input is left where it
 * was: `exec 0<f; cat nofile; cat` is `f` behind the diagnostic -- the `cat` that failed on `nofile`
 * never read the input -- while `cat -n` is an option and not a name, and does read it.
 */
function argNamesFile(args: string[]): boolean {
    return args.some((arg) => !arg.startsWith('-'));
}

/**
 * Moves the shell's own standard input by what a command took out of it. That input is the file an
 * `exec 0<f` or an `exec 0<&3` put there, and a host shares one offset across the commands that read
 * it, so `exec 0<f; cat; cat` is `f` once and not twice -- the first `cat` leaves the offset at the
 * end -- and `exec 0<f; echo A=[$(head -1)]; echo B=[$(head -1)]` is the first line and then the
 * second. The offset is the descriptor's own, which a pipeline and a subshell both copy by
 * reference, so a command inside one of those is a read the commands behind it do not repeat.
 *
 * A command that moved the cursor itself -- `read`, `mapfile`, which take their line through it --
 * has already said how far it got, and one that never reads its standard input leaves it alone.
 */
function advanceShellInput(
    state: ShellState,
    name: string,
    args: string[],
    stdout: string,
    given: string,
    cursorBefore: number
): void {
    const offset = state.inputOffset;
    if (offset === undefined) return;
    if (!STDIN_READERS.has(name)) return;
    if (state.inputCursor !== cursorBefore) {
        offset.pos = state.inputCursor;
        return;
    }
    if (argNamesFile(args)) return;
    /* `head` writes exactly the bytes it took and puts the rest back, so what it wrote is what it
       read: `head -1` leaves the offset behind the first line, and a second one reads the second. */
    const taken =
        name === 'head' && headReadsStdin(args) && stdout !== '' && given.startsWith(stdout)
            ? stdout.length
            : given.length;
    offset.pos += taken;
    state.inputCursor = Math.min(offset.pos, state.inputBuffer.length);
}

function writeOutputFile(state: ShellState, file: string, text: string, append: boolean): void {
    const fs = state.fs;
    if (!fs) throw new Error(`Failed to redirect to ${file}: no file system`);
    const path = resolvePath(state, file);
    if (path === NULL_DEVICE) return;
    /* `>>` onto a name nothing has yet is a create, not a failure: the host writes `hi` into a new
       `f` and leaves 0, where a read of the missing name threw ENOENT and the line ended at 1. */
    const existed = fs.fileExists(path);
    let existing = '';
    if (append) {
        try { existing = fs.readFile(path) ?? ''; } catch { existing = ''; }
    }
    try {
        fs.writeFile(path, existing + text);
    } catch (error) {
        throw redirectFailure(state, file, error);
    }
    /* A name a redirection created carries the mode the umask leaves, exactly as `touch f` leaves
       it: `umask 077; echo hi > f` is `-rw-------` on a host, and so is a here-document written
       the same way. One that was already there keeps the mode it had. */
    if (!existed) setCreationMode(fs, path, false);
}

/**
 * Applies the redirection plan and sends the result to the current output sink. `name` is the
 * command that wrote, for the one diagnostic that names it.
 */
/**
 * Where the "could not write" of a closed descriptor is reported: where this command's own `2>` and
 * `2>&1` sent its error, which is not always the shell's -- `echo hi 2>&1 >&-` writes the write
 * error on the standard output, because `2>&1` had pointed the error there before the `>&-` behind
 * it closed the output. Closed by this command's own `2>&-`, it reaches the shell's error after
 * all: a host has put the descriptor back by the time it reports.
 */
/**
 * A descriptor a write through cannot reach: one `>&-` closed, and one a duplicate put on a file
 * opened for reading -- `exec 3>&0; echo hi >&3`, where the `3` the standard input was duplicated
 * onto takes no write. A host's write to either is the same failure: the text stays in the shell's
 * own buffer, which is flushed once the descriptor is back, and the command that made the write is
 * left with the status a failed write gives it.
 */
function unwritable(target: StreamTarget): boolean {
    return target.kind === 'null' || target.kind === 'input';
}

function writeClosedWriteError(state: ShellState, plan: RedirectPlan, text: string): void {
    const target = plan.stderrTo;
    if (target.kind === 'null') {
        if (state.stderrTarget.kind === 'out') writeOut(state, text);
        else writeErr(state, text);
        return;
    }
    if (target.kind === 'out') {
        writeOut(state, text);
        return;
    }
    if (target.kind === 'file' && target.file !== undefined) {
        writeOutputFile(state, target.file, text, Boolean(target.append));
        return;
    }
    writeErr(state, text);
}

function finish(
    state: ShellState,
    plan: RedirectPlan,
    stdout: string,
    stderr: string,
    exitCode: number,
    name?: string
): number {
    try {
        /* A descriptor a redirection opened and nothing wrote to: `cmd 3>f` leaves `f` created and
           empty, and `exec 3>f` opens the one the commands behind it write through with `>&3`.
           A redirection nothing could be made of leaves the ones behind it unopened, so `echo hi
           >&3 3>f` reports the bad descriptor without ever creating `f`. */
        for (const opened of plan.opened) writeOutputFile(state, opened.file, '', Boolean(opened.append));
        if (plan.error !== undefined) {
            writeErr(state, plan.error);
            return 1;
        }
        /* One file both streams name -- `&>f`, and `>f 2>&1` -- is one descriptor a host opened
           once, so what the command wrote lands in it in the order it was written: `{ echo o; echo
           e >&2; } &>f` holds `o` then `e`. Writing each stream on its own put the second over the
           first, and the file kept only one of them. */
        if (
            plan.stdoutTo.kind === 'file' && plan.stderrTo.kind === 'file'
            && plan.stdoutTo.file !== undefined && plan.stderrTo.file !== undefined
            && resolvePath(state, plan.stdoutTo.file) === resolvePath(state, plan.stderrTo.file)
        ) {
            writeOutputFile(state, plan.stdoutTo.file, stdout + stderr, Boolean(plan.stdoutTo.append));
            return exitCode;
        }
        if (plan.stderrTo.kind === 'null') stderr = '';
        else if (plan.stderrTo.kind === 'out') {
            if (plan.stdoutTo.kind === 'out') {
                /* `cmd 2>&1` with nothing moved behind it: both go to the shell's own output, the
                   output first, which is the order a host wrote them in. */
                writeOut(state, stdout + stderr);
                return exitCode;
            }
            /* `echo hi 2>&1 >f`: the error stays where the output was going when `2>&1` was read,
               and the output behind it goes to `f` -- so the error is written to the shell's own
               output and the output is left for the plan to place. */
            writeOut(state, stderr);
            stderr = '';
        } else if (plan.stderrTo.kind === 'file' && plan.stderrTo.file !== undefined) {
            writeOutputFile(state, plan.stderrTo.file, stderr, Boolean(plan.stderrTo.append));
            stderr = '';
        }
        /* A write the shell is still holding -- one a closed descriptor could not hold -- goes out
           with the next output the shell writes itself, into wherever that write is going: a host's
           buffer is flushed as a whole, so the text it had no room for lands ahead of the text
           written after it. Only a command the shell carries in itself writes through that buffer:
           a utility writes to the descriptor itself, and its own text lands *before* the held
           text -- `echo hi >&-; cat p1; echo end` is a host's `p q r`, then `hi`, then `end`. */
        if (
            state.held !== ''
            && !unwritable(plan.stdoutTo)
            && stdout !== ''
            && name !== undefined
            && SHELL_OWN_NAMES.has(name)
        ) {
            stdout = state.held + stdout;
            state.held = '';
        }
        if (unwritable(plan.stdoutTo)) {
            /* A write to a descriptor `>&-` closed: the text reaches the shell anyway -- a host's
               own write is held in its buffer, which is flushed once the descriptor is put back --
               and the write is still the failure it was, reported with the status a host gives the
               command that made it. `true >&-` writes nothing and keeps its own status. */
            if (name !== undefined) {
                    /* A command the shell carries in itself writes into the shell's own buffer, which a
                       host flushes once the descriptor is back, so the text reaches the shell after
                       all -- wherever the output is then, which is why it is held here and written
                       by `flushHeld` and not put on the output now. It reports the failed write only
                       where the buffer was flushed at all, which is where the text ended in a
                       newline: `printf x >&-` writes `x` and says nothing, where `printf 'x\n' >&-`
                       says it and so does every `echo`. */
                if (SHELL_OWN_NAMES.has(name)) {
                    if (stdout.endsWith('\n')) {
                        writeClosedWriteError(state, plan, `${diagnosticPrefix(state)}${name}: write error: Bad file descriptor\n`);
                    }
                    if (stdout !== '') {
                        state.held += stdout;
                        exitCode = 1;
                    }
                } else if (stdout !== '' || CLOSES_ITS_STREAM.has(name)) {
                    /* A command that is not the shell's own writes through the descriptor itself, so
                       a closed one loses the text instead: `cat p1 >&-` prints nothing and names the
                       stream it could not write, `cat: stdout: Bad file descriptor`, with no `sh:`
                       in front of it and no `write error`. */
                    writeClosedWriteError(state, plan, `${name}: stdout: Bad file descriptor\n`);
                    exitCode = 1;
                }
            }
            stdout = '';
        } else if (plan.stdoutTo.kind === 'file' && plan.stdoutTo.file !== undefined) {
            writeOutputFile(state, plan.stdoutTo.file, stdout, Boolean(plan.stdoutTo.append));
            stdout = '';
        } else if (plan.stdoutTo.kind === 'err') {
            writeErr(state, stdout);
            stdout = '';
        }
        writeOut(state, stdout);
        writeErr(state, stderr);
        return exitCode;
    } catch (error) {
        writeErr(state, `${errorMessage(error)}\n`);
        return 1;
    }
}

function traceWords(name: string, args: string[]): string {
    return [name, ...args.map((arg) => (/^[A-Za-z0-9_./:@=,+%-]+$/.test(arg) && arg !== '' ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))].join(' ');
}

function syncPwd(state: ShellState): void {
    const current = getVar(state, 'PWD');
    if (current !== state.cwd) {
        if (current !== undefined) setVar(state, 'OLDPWD', current);
        setVar(state, 'PWD', state.cwd);
    }
}

function callFunction(state: ShellState, fn: FunctionDef, args: string[]): number {
    const savedPositional = state.positional;
    const savedOptind = state.optind;
    const savedOptchar = state.optchar;
    const savedOptarg = state.optarg;
    state.positional = args;
    state.optind = 1;
    state.optchar = 1;
    state.optarg = '';
    state.scopes.push(new Map());
    /* `FUNCNAME` is the function a line stands in: it is a name the function's own scope carries, so
       it is there while the body runs and gone -- along with the scope -- the moment it returns, the
       way a host's own is. */
    state.scopes[state.scopes.length - 1].set('FUNCNAME', { value: fn.name });
    state.callStack.push({ name: fn.name, source: state.source, line: state.line });
    let status = 0;
    try {
        status = runCommandList(state, [{ bang: false, commands: [fn.body], op: null }], null);
    } catch (error) {
        if (error instanceof ReturnSignal) status = error.code;
        else throw error;
    } finally {
        state.callStack.pop();
        state.scopes.pop();
        state.positional = savedPositional;
        state.optind = savedOptind;
        state.optchar = savedOptchar;
        state.optarg = savedOptarg;
    }
    return status;
}

/** A simple command: assignments, redirections, then the command word. */
function runSimple(state: ShellState, command: Extract<Command, { t: 'simple' }>, input: string | null): number {
    substitutionStatus = 0;
    const pending: PendingAssign[] = [];
    for (const assign of command.assigns) pending.push(expandAssign(state, assign));

    const words: string[] = [];
    for (const word of command.words) words.push(...expandWord(state, word));

    /* `exec` with nothing to run: the redirections it carries are the shell's from here on, not one
       command's -- `exec 3>f; echo hi >&3` writes `hi` to `f`, `exec >f` sends every command's
       output there, and `exec 3>&-` closes the descriptor again, as they do in a host shell. They
       are applied before this command's own plan is made, so the plan reads the destination `exec`
       has just set: `exec >f` is a write to `f` from this command on. */
    if (words[0] === 'exec' && words.length === 1) {
        const failed = applyExecRedirects(state, command.redirects);
        if (failed !== undefined) {
            /* A redirection `exec` cannot make ends the shell, the way `exec 3>&4` ends the
               /bin/sh a line was handed to with `-c`: the host's own message, and nothing behind
               it -- not the `echo rc=$?` written after it -- runs at all. The files its own
               redirections had already opened before the one that failed are still opened. */
            writeErr(state, failed);
            const undone = planRedirects(state, command.redirects);
            undone.error = undefined;
            finish(state, undone, '', '', 1, 'exec');
            /* Only a shell that is not already testing the status ends: `if exec 3>&4`, `exec 3>&4 ||
               echo y`, `exec 3>&4 | cat` and `! exec 3>&4` are a host's plain false -- the branch
               behind the operator runs and the line behind it does too -- where a bare `exec 3>&4`
               still ends the shell and nothing behind it runs at all. The files its own redirections
               had already opened before the one that failed are opened either way. */
            if (state.protectedDepth > 0) return 1;
            state.exitCalled = true;
            return throwExit(1);
        }
    }

    const plan = planRedirects(state, command.redirects);
    /* A descriptor a duplicate put on the standard input -- `cat <&3` behind an `exec 3>&0` -- is the
       shell's own input read through the shell's own cursor, not a copy of it: what a `read` through
       it takes is taken from the shell too, which is why `read a <&3; read b <&3` is the first line
       and then the second on a host and not the first one twice. */
    const ownStdin = plan.inputFd !== undefined && plan.inputFd.file === undefined;
    const commandInput = ownStdin
        ? input
        : plan.inputText !== undefined
        ? plan.inputText
        : plan.inputFd !== undefined ? readFdAt(state, plan.inputFd)
        : plan.inputFile !== undefined ? readInputFile(state, plan.inputFile) : input;
    /**
     * What a command with no input of its own reads: the rest of the input of the compound command
     * it stands in. `runCompoundRedirected` put that input in `state.inputBuffer` for the whole
     * construct, and `read` and `mapfile` take it from there, a line at a time, through the cursor;
     * this is the same text for the commands that read their standard input in one go -- `cat`,
     * `wc`, `head` -- which is why `echo hi | if true; then cat; fi` prints the line `echo` wrote.
     * The buffer is not rewinded for them: the cursor stays where the commands before left it.
     */
    /* Where the shell's own input stands. The offset is the descriptor's, and a pipeline or a
       subshell puts the cursor it saved back while leaving that offset where the reads inside it
       left it, so the cursor is read back out of it here rather than trusted to have survived. */
    if (state.inputOffset !== undefined) state.inputCursor = Math.min(state.inputOffset.pos, state.inputBuffer.length);
    const shared = state.inputCursor < state.inputBuffer.length ? state.inputBuffer.slice(state.inputCursor) : '';
    const stdin = commandInput ?? (shared === '' ? null : shared);
    const cursorBefore = state.inputCursor;
    const shellInput = commandInput === null ? stdin : null;

    if (words.length === 0) {
        /* An assignment with no command behind it is the substitution it carries: `x=$(false)` is 1
           and `x=$(exit 5)` is 5, the status the subshell ended with, and it is what makes `set -e`
           end the line -- a substitution whose own `set -e` stopped it early leaves that status too. */
        const status = substitutionStatus;
        /* An assignment with no command behind it is the one the shell keeps, so it is applied here
           and not undone: `IFS=:` on a line of its own is the shell's IFS from here on. One at a
           time, so the name a readonly variable refused is the name the complaint names. */
        for (const entry of pending) {
            if (pushPending(state, [entry])) continue;
            /* An assignment a readonly variable refuses ends the shell a line was handed to with
               `-c`, the way a host's own does: `readonly R=1; R=2; echo after` writes nothing
               behind its diagnostic and leaves 127. The complaint is one a host writes without
               the line it stands on -- `$0: R: readonly variable`. */
            finish(state, plan, '', `${state.shellName}: ${entry.name}: readonly variable\n`, 127);
            state.exitCalled = true;
            return throwExit(127);
        }
        syncPwd(state);
        return finish(state, plan, '', '', status);
    }

    let name = words[0];
    let args = words.slice(1);

    /* A jobspec typed as a command is `fg` with that jobspec as its argument: `%1` on a line of
       its own resumes the job in the foreground, and where the shell has no job control it is
       `fg`'s own error that comes back -- `sh: line 0: fg: no job control`, never `Command not
       found`. */
    if (name.startsWith('%')) {
        args = [name, ...args];
        name = 'fg';
    }
    /*
     * `kill %1` names a job of this shell's own table. The `kill` of `procinfo.ts` can only signal
     * the container's processes, and a job's pid is not one of them, so a jobspec ends here. A
     * signal name or number in front of it is kept: `kill -TERM %1` is the same kill.
     */
    if (name === 'kill' && args.some((arg) => arg.startsWith('%') || isPendingJobPid(state, arg))) {
        const killed = killJobSpecs(state, args);
        return finish(state, plan, killed.stdout, killed.stderr, killed.exitCode);
    }

    // control flow: these are parsed as commands but never reach the runner
    if (name === 'exit') {
        const code = args.length === 0 ? state.lastStatus : Number.parseInt(args[0], 10);
        const status = Number.isNaN(code) ? 0 : code;
        state.exitCalled = true;
        /* `exit 0` ends the line as `exit 1` does: the status it leaves is falsy, so a `&&` that
           asked for it would have skipped the exit itself and run the commands behind it. */
        finish(state, plan, '', '', status);
        return throwExit(status);
    }
    if (name === 'break') {
        const count = args.length === 0 ? 1 : Number.parseInt(args[0], 10);
        throw new BreakSignal(Number.isNaN(count) ? 1 : count);
    }
    if (name === 'continue') {
        const count = args.length === 0 ? 1 : Number.parseInt(args[0], 10);
        throw new ContinueSignal(Number.isNaN(count) ? 1 : count);
    }
    if (name === 'return') {
        if (state.callStack.length === 0) {
            /* The wording is a host's own, backquotes and all: `can only `return' from a function
               or sourced script`, behind the shell's name and the line it stands on. */
            writeErr(state, `${diagnosticPrefix(state)}return: can only \`return' from a function or sourced script\n`);
            return 1;
        }
        const code = args.length === 0 ? state.lastStatus : Number.parseInt(args[0], 10);
        throw new ReturnSignal(Number.isNaN(code) ? 0 : code);
    }

    if (state.options.xtrace) writeErr(state, `+ ${traceWords(name, args)}\n`);
    if (state.options.verbose) writeErr(state, `${traceWords(name, args)}\n`);
    runTrap(state, 'DEBUG');

    const savedBuffer = state.inputBuffer;
    const savedCursor = state.inputCursor;
    if (commandInput !== null) {
        state.inputBuffer = commandInput;
        state.inputCursor = 0;
    }
    try {
        const fn = state.functions.get(name);
        if (fn !== undefined) {
            /* A function its own redirections could not be made of is not called: `f >&9` with no
               `9` is the diagnostic and a status of 1 on a host, and no `x` from the body. */
            if (plan.error !== undefined) return finish(state, plan, '', '', 1, name);
            /* In front of a *function* the assignment is one the shell keeps, which is the one
               place a host differs from a builtin: `v=1; f() { echo $v; }; v=2 f; echo "[$v]"` is
               a host's `2` and then `[2]`, where `IFS=: true; echo "$IFS"` is the default again.
               So it is put in place before the call and left for the body to write over, which is
               why it is not put back afterwards: `v=1; f() { v=inner; }; v=2 f; echo "[$v]"` is a
               host's `[inner]` and not the `[2]` a second assignment behind the call would leave. */
            pushPending(state, pending);
            const status = callFunction(state, fn, args);
            syncPwd(state);
            return finish(state, plan, '', '', status, name);
        }

        const builtin = COMMANDS[name];
        if (builtin !== undefined) {
            const ctx: CommandContext = {
                args,
                cwd: state.cwd,
                env: state.env,
                input: stdin,
                fs: (state.fs ?? NO_FS) as never
            };
            bindState(ctx, state);
            /* The assignments in front of the command are in place *while it runs*, which is the
               only time a builtin can read them: `IFS=: read x y` splits the line on the colon,
               where setting IFS behind the read left it split on whitespace and answered the whole
               line as one field. `env: state.env` above was already read out of the scopes the
               assignments land in, so a builtin that reads `ctx.env` sees them too. */
            const saved = savePending(state, pending);
            pushPending(state, pending);
            let result: CommandResult;
            try {
                result = builtin(ctx);
            } catch (error) {
                if (
                    error instanceof ExitSignal ||
                    error instanceof ReturnSignal ||
                    error instanceof BreakSignal ||
                    error instanceof ContinueSignal
                ) {
                    throw error;
                }
                result = { stdout: '', stderr: `${errorMessage(error)}\n`, exitCode: 1 };
            } finally {
                restorePending(state, pending, saved);
            }
            /* What the built-in read through a descriptor it was handed -- `read x <&3` -- is what
               the descriptor's own offset moves by, so the line behind it reads on from there. */
            advanceReadFd(state, plan, name, args, result.stdout, commandInput ?? '');
            if (shellInput !== null) advanceShellInput(state, name, args, result.stdout, shellInput, cursorBefore);
            syncPwd(state);
            return finish(state, plan, result.stdout, result.stderr, result.exitCode, name);
        }

        const saved = savePending(state, pending);
        pushPending(state, pending);
        let step: { stdout: string; stderr: string; exitCode: number };
        try {
            step = RUNNER(state, words, stdin);
        } finally {
            restorePending(state, pending, saved);
        }
        advanceReadFd(state, plan, name, args, step.stdout, commandInput ?? '');
        if (shellInput !== null) advanceShellInput(state, name, args, step.stdout, shellInput, cursorBefore);
        syncPwd(state);
        return finish(state, plan, step.stdout, step.stderr, step.exitCode, name);
    } finally {
        if (commandInput !== null) {
            state.inputBuffer = savedBuffer;
            state.inputCursor = savedCursor;
        }
    }
}

function throwExit(code: number): never {
    throw new ExitSignal(Number.isNaN(code) ? 0 : code);
}

/* ================================================================== *
 * 8. The builtins
 * ================================================================== */

const NO_FS: ShellFs = {
    readFile: () => undefined,
    writeFile: () => undefined,
    listDirectory: () => [],
    isDirectory: () => false,
    fileExists: () => false,
    createDirectory: () => undefined,
    deleteFile: () => undefined,
    deleteDirectory: () => undefined,
    resolvePath: (path, base) => (path.startsWith('/') ? path : `${base ?? ''}/${path}`.replace(/\/{2,}/g, '/'))
};

function ok(stdout = '', _state?: ShellState): CommandResult {
    return { stdout, stderr: '', exitCode: 0 };
}

function failLine(message: string, code = 1): CommandResult {
    return { stdout: '', stderr: message === '' ? '' : message + '\n', exitCode: code };
}

/**
 * A builtin's own complaint, the way a host prints one: the shell's name and the line it stands on
 * ahead of the builtin's own words -- `sh: line 0: type: nosuchcmd: not found`. Every builtin a host
 * names itself is named through here, so a diagnostic and the command it belongs to can never
 * disagree about where the line stood.
 */
function failDiag(state: ShellState, message: string, code = 1): CommandResult {
    return failLine(`${diagnosticPrefix(state)}${message}`, code);
}

function splitAssign(text: string): { name: string; value: string | undefined; append: boolean } | null {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]]*\])?)([+]?)=([\s\S]*)$/.exec(text);
    if (!match) return null;
    return { name: match[1] + match[2], value: match[4], append: match[3] === '+' };
}

function markExported(state: ShellState, name: string): void {
    const scope = lookupScope(state, name) ?? state.scopes[state.scopes.length - 1];
    const variable = scope.get(name);
    if (variable) variable.export = true;
    else scope.set(name, { value: getVar(state, name) ?? '', export: true });
}

function markReadonly(state: ShellState, name: string): void {
    const scope = lookupScope(state, name) ?? state.scopes[state.scopes.length - 1];
    const variable = scope.get(name);
    if (variable) variable.readonly = true;
    else scope.set(name, { value: getVar(state, name) ?? '', readonly: true });
}

function declarePrint(name: string, variable: ShellVar): string {
    /* The attributes a host spells in the order they stand in `declare -irx`, and the integer one
       among them: `declare -i n=1; n=n+1; declare -p n` is a host's `declare -i n="2"`. */
    const flags = `${variable.integer ? 'i' : ''}${variable.readonly ? 'r' : ''}${variable.export ? 'x' : ''}`;
    if (flags !== '') return `declare -${flags} ${name}=${quoteDouble(variable.value)}`;
    return `declare -- ${name}=${quoteDouble(variable.value)}`;
}

function signalNames(): string[] {
    return ['HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'EMT', 'FPE', 'KILL', 'BUS', 'SEGV', 'SYS', 'PIPE', 'ALRM', 'TERM', 'URG', 'STOP', 'TSTP', 'CONT', 'CHLD', 'TTIN', 'TTOU', 'IO', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'INFO', 'USR1', 'USR2'];
}

/**
 * `ulimit -a`: the shape of the host's resource limits, measured on the oracle host
 * (macOS arm64, bash 3.2 as /bin/sh). There is no getrlimit in the guest, so these are the host's
 * own soft limits, reported verbatim in the host's `ulimit -a` layout rather than queried.
 */
const ULIMIT_TABLE: { flag: string; line: string; soft: string; hard: string }[] = [
    { flag: '-c', line: 'core file size          (blocks, -c) 0', soft: '0', hard: 'unlimited' },
    { flag: '-d', line: 'data seg size           (kbytes, -d) unlimited', soft: 'unlimited', hard: 'unlimited' },
    { flag: '-f', line: 'file size               (blocks, -f) unlimited', soft: 'unlimited', hard: 'unlimited' },
    { flag: '-l', line: 'max locked memory       (kbytes, -l) unlimited', soft: 'unlimited', hard: 'unlimited' },
    { flag: '-m', line: 'max memory size         (kbytes, -m) unlimited', soft: 'unlimited', hard: 'unlimited' },
    { flag: '-n', line: 'open files                      (-n) 1048576', soft: '1048576', hard: 'unlimited' },
    { flag: '-p', line: 'pipe size            (512 bytes, -p) 1', soft: '1', hard: '1' },
    { flag: '-s', line: 'stack size              (kbytes, -s) 8176', soft: '8176', hard: '65520' },
    { flag: '-t', line: 'cpu time               (seconds, -t) unlimited', soft: 'unlimited', hard: 'unlimited' },
    { flag: '-u', line: 'max user processes              (-u) 6000', soft: '6000', hard: '8000' },
    { flag: '-v', line: 'virtual memory          (kbytes, -v) unlimited', soft: 'unlimited', hard: 'unlimited' }
];

function umaskString(mask: number): string {
    return mask.toString(8).padStart(4, '0');
}

function umaskSymbolic(mask: number): string {
    const groups: [string, number, number][][] = [
        [['u', 0o400, 4], ['u', 0o200, 2], ['u', 0o100, 1]],
        [['g', 0o040, 4], ['g', 0o020, 2], ['g', 0o010, 1]],
        [['o', 0o004, 4], ['o', 0o002, 2], ['o', 0o001, 1]]
    ] as unknown as [string, number, number][][];
    void groups;
    const allowed = ~mask & 0o777;
    const parts: string[] = [];
    const letters: [string, number][] = [
        ['u', 0o700],
        ['g', 0o070],
        ['o', 0o007]
    ];
    for (const [letter, bits] of letters) {
        let text = '';
        const group = allowed & bits;
        if (letter === 'u') {
            if (group & 0o400) text += 'r';
            if (group & 0o200) text += 'w';
            if (group & 0o100) text += 'x';
        } else if (letter === 'g') {
            if (group & 0o040) text += 'r';
            if (group & 0o020) text += 'w';
            if (group & 0o010) text += 'x';
        } else {
            if (group & 0o004) text += 'r';
            if (group & 0o002) text += 'w';
            if (group & 0o001) text += 'x';
        }
        parts.push(`${letter}=${text}`);
    }
    return parts.join(',');
}

function abbreviateHome(state: ShellState, path: string): string {
    const home = getVar(state, 'HOME');
    if (home && (path === home || path.startsWith(home + '/'))) return `~${path.slice(home.length)}`;
    return path;
}

/** Resolves a command name against PATH with the shell's file system. */
function findOnPath(state: ShellState, name: string): string | undefined {
    const fs = state.fs;
    if (!fs) return undefined;
    if (name.includes('/')) {
        const direct = resolvePath(state, name);
        return fs.fileExists(direct) && !fs.isDirectory(direct) ? direct : undefined;
    }
    const path = getVar(state, 'PATH');
    if (!path) return undefined;
    for (const dir of path.split(':')) {
        if (dir === '') continue;
        const candidate = `${dir}/${name}`.replace(/\/{2,}/g, '/');
        try {
            if (fs.fileExists(candidate) && !fs.isDirectory(candidate)) return candidate;
        } catch {
            /* unreadable */
        }
    }
    return undefined;
}

/**
 * The commands the host's dispatch already runs as builtins (child.ts: echo, cd, ls, ...).
 * `type`, `command` and `builtin` must describe and reach them, because this module deliberately
 * leaves those to the runner.
 */
export const HOST_BUILTINS = new Set([
    'echo', 'cat', 'pwd', 'ls', 'mkdir', 'rm', 'rmdir', 'touch', 'cd', 'cp', 'mv', 'true', 'false', 'exit', 'history'
]);

/** The source text of a function body, indented the way `type` prints it. */
function functionBody(def: FunctionDef): string {
    let text = def.text ?? '';
    // a `{ ... }` body arrives with its braces; bash prints what is between them
    if (text.startsWith('{') && text.endsWith('}')) text = text.slice(1, -1);
    return text
        .split(/[;\n]/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => `    ${line}`)
        .join('\n');
}

function describeName(state: ShellState, name: string): string {
    if (state.aliases.has(name)) return `${name} is aliased to \`${state.aliases.get(name)}'`;
    if (SHELL_OWN_NAMES.has(name)) return `${name} is a shell builtin`;
    if (state.functions.has(name)) {
        const def = state.functions.get(name) as FunctionDef;
        return `${name} is a function\n${name} () \n{ \n${functionBody(def)}\n}`;
    }
    /* The file on PATH comes before the builtin of the same name: `ls` is one here and a file out
       there, and a host describes the file. */
    const path = findOnPath(state, name);
    if (path !== undefined) return `${name} is ${path}`;
    if (COMMANDS[name] !== undefined || HOST_BUILTINS.has(name)) return `${name} is a shell builtin`;
    const fs = state.fs;
    if (fs && fs.fileExists(resolvePath(state, name))) return `${name} is ${resolvePath(state, name)}`;
    return '';
}

/** The names a POSIX shell carries in itself rather than on PATH. `command -v` names one of these
 *  instead of a file even where the file is also there -- a host answers `echo` and not `/bin/echo`
 *  -- because the shell's own is what a line would run. */
const SHELL_OWN_NAMES = new Set([
    '.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'continue',
    'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fg',
    'getopts', 'hash', 'history', 'jobs', 'kill', 'let', 'local', 'popd', 'printf', 'pushd', 'pwd',
    'read', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'test', 'times', 'trap', 'true',
    'type', 'ulimit', 'umask', 'unalias', 'unset', 'wait'
]);

/**
 * The utilities a host's own build of which closes the stream it writes and reports the write that
 * failed, even where it wrote nothing at all: `cat /dev/null >&-` is `cat: stdout: Bad file
 * descriptor` and a status of 1, where `mkdir d >&-`, `touch t >&-` and `cp a b >&-` -- utilities
 * whose output never goes through that stream -- are silent and keep their own status.
 */
const CLOSES_ITS_STREAM = new Set(['cat']);

/** What `command -v` writes: the pathname of the file a line would run, or -- for a name the shell
 *  carries itself, and for one no directory on PATH holds -- the name, as a host writes it. */
function pathOfName(state: ShellState, name: string): string {
    if (SHELL_OWN_NAMES.has(name)) return name;
    const path = findOnPath(state, name);
    if (path !== undefined) return path;
    const fs = state.fs;
    if (fs && fs.fileExists(resolvePath(state, name))) return resolvePath(state, name);
    if (state.aliases.has(name) || state.functions.has(name) || COMMANDS[name] !== undefined || HOST_BUILTINS.has(name)) {
        return name;
    }
    return '';
}

/**
 * Every name `set -o` prints, in the order a host prints them -- alphabetical, twenty-seven of
 * them -- each with the state it reads. `interactive` is not one of them: a host's `set -o` has
 * `interactive-comments` but no `interactive`, which is set from how the shell was started.
 */
const OPTION_NAMES: [keyof ShellOptions, string][] = [
    ['allexport', 'allexport'],
    ['braceexpand', 'braceexpand'],
    ['emacs', 'emacs'],
    ['errexit', 'errexit'],
    ['errtrace', 'errtrace'],
    ['functrace', 'functrace'],
    ['hashall', 'hashall'],
    ['histexpand', 'histexpand'],
    ['history', 'history'],
    ['ignoreeof', 'ignoreeof'],
    ['interactiveComments', 'interactive-comments'],
    ['keyword', 'keyword'],
    ['monitor', 'monitor'],
    ['noclobber', 'noclobber'],
    ['noexec', 'noexec'],
    ['noglob', 'noglob'],
    ['nolog', 'nolog'],
    ['notify', 'notify'],
    ['nounset', 'nounset'],
    ['onecmd', 'onecmd'],
    ['physical', 'physical'],
    ['pipefail', 'pipefail'],
    ['posix', 'posix'],
    ['privileged', 'privileged'],
    ['verbose', 'verbose'],
    ['vi', 'vi'],
    ['xtrace', 'xtrace']
];

const SHORT_OPTIONS: Record<string, keyof ShellOptions> = {
    a: 'allexport',
    b: 'notify',
    e: 'errexit',
    f: 'noglob',
    h: 'hashall',
    k: 'keyword',
    m: 'monitor',
    n: 'noexec',
    p: 'privileged',
    t: 'onecmd',
    u: 'nounset',
    v: 'verbose',
    x: 'xtrace',
    B: 'braceexpand',
    C: 'noclobber',
    H: 'histexpand',
    P: 'physical'
};

function setBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const args = ctx.args;
    if (args.length === 0) {
        const names = varNames(state).sort();
        const lines = names.map((name) => `${name}=${quoteSingle(getVar(state, name) ?? '')}`);
        return ok(joinLines(lines), state);
    }
    let index = 0;
    let positional: string[] | null = null;
    while (index < args.length) {
        const arg = args[index];
        if (arg === '--' || arg === '-') {
            positional = args.slice(index + 1);
            break;
        }
        if (arg.startsWith('-') || arg.startsWith('+')) {
            const enable = arg[0] === '-';
            const body = arg.slice(1);
            if (body === 'o') {
                const next = args[index + 1];
                if (next === undefined) {
                    /* The list a host prints: the name in a column fifteen characters wide, a tab,
                       and `on` or `off` -- `allexport      \toff`, and `interactive-comments` longer
                       than the column, so the tab is the only thing between it and its answer. */
                    const lines = OPTION_NAMES.map(([key, name]) => `${name.padEnd(15)}\t${state.options[key] ? 'on' : 'off'}`);
                    return ok(joinLines(lines), state);
                }
                const entry = OPTION_NAMES.find(([, name]) => name === next);
                /* The status of a name `set -o` does not know is 1, not the 2 of an option letter it
                   does not know: `set -o badopt; echo st=$?` is a host's `st=1`. */
                if (!entry) return failDiag(state, `set: ${next}: invalid option name`, 1);
                state.options[entry[0]] = enable;
                index += 2;
                continue;
            }
            if (body.startsWith('o') && body.length > 1) {
                const name = body.slice(1);
                const entry = OPTION_NAMES.find(([, option]) => option === name);
                if (!entry) return failDiag(state, `set: ${name}: invalid option name`, 1);
                state.options[entry[0]] = enable;
                index++;
                continue;
            }
            for (const ch of body) {
                const key = SHORT_OPTIONS[ch];
                if (!key) {
                    /* An option letter `set` does not know ends the shell a line was handed to with
                       `-c`, the way a host's own does: `set -q; echo st=$?` prints nothing at all
                       behind the two lines it writes and leaves 2. */
                    writeErr(state, `${diagnosticPrefix(state)}set: -${ch}: invalid option\n`
                        + 'set: usage: set [--abefhkmnptuvxBCHP] [-o option] [arg ...]\n');
                    state.exitCalled = true;
                    return throwExit(2);
                }
                state.options[key] = enable;
            }
            index++;
            continue;
        }
        positional = args.slice(index);
        break;
    }
    if (positional !== null) state.positional = positional;
    return ok();
}

function exportedNames(state: ShellState): string[] {
    return varNames(state)
        .filter((name) => lookupScope(state, name)?.get(name)?.export === true)
        .sort();
}

function printExported(state: ShellState): string {
    return joinLines(
        exportedNames(state).map((name) => {
            const value = getVar(state, name);
            return value === undefined ? `export ${name}` : `export ${name}=${quoteDouble(value)}`;
        })
    );
}

function exportBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    if (ctx.args.length === 0 || ctx.args[0] === '-p') return ok(printExported(state), state);
    /* `export -n NAME` takes the export attribute back off a name the shell is still holding:
       `export FOO=1; export -n FOO` leaves a `FOO` of 1 that `env` no longer lists, and a status
       of 0 -- where reading the `-n` as a name made it `export: `-n': not a valid identifier`. */
    let unexport = false;
    for (const arg of ctx.args) {
        if (arg === '-n') {
            unexport = true;
            continue;
        }
        if (arg.startsWith('-')) {
            if (arg === '-f') continue;
            return failDiag(state, `export: ${arg}: invalid option\nexport: usage: export [-nf] [name[=value] ...] or export -p`, 2);
        }
        const assign = splitAssign(arg);
        if (!assign) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) return failDiag(state, `export: \`${arg}': not a valid identifier`, 1);
            if (unexport) {
                const variable = lookupScope(state, arg)?.get(arg);
                if (variable !== undefined) variable.export = false;
                continue;
            }
            markExported(state, arg);
            continue;
        }
        const base = assign.append ? getVar(state, assign.name) ?? '' : '';
        setVar(state, assign.name, base + (assign.value ?? ''));
        if (!unexport) markExported(state, assign.name);
    }
    return ok();
}

function readonlyBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    if (ctx.args.length === 0 || ctx.args[0] === '-p') {
        const names = varNames(state).filter((name) => lookupScope(state, name)?.get(name)?.readonly === true).sort();
        return ok(joinLines(names.map((name) => `readonly ${name}=${quoteDouble(getVar(state, name) ?? '')}`)), state);
    }
    for (const arg of ctx.args) {
        /* `-f` asks for the functions, which a host names without complaining: `readonly -f` is a
           host's plain 0 and nothing written. */
        if (arg === '-f') continue;
        const assign = splitAssign(arg);
        if (!assign) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) return failDiag(state, `readonly: \`${arg}': not a valid identifier`, 1);
            if (!isSet(state, arg)) setVar(state, arg, '');
            markReadonly(state, arg);
            continue;
        }
        const base = assign.append ? getVar(state, assign.name) ?? '' : '';
        setVar(state, assign.name, base + (assign.value ?? ''));
        markReadonly(state, assign.name);
    }
    return ok();
}

function declareBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const args = ctx.args.slice();
    let exportFlag: boolean | null = null;
    let readonlyFlag: boolean | null = null;
    let integer: boolean | null = null;
    let global = false;
    let print = false;
    let functions = false;
    let functionNames = false;
    let index = 0;
    while (index < args.length && (args[index].startsWith('-') || args[index].startsWith('+'))) {
        const flag = args[index];
        if (flag === '--') {
            index++;
            break;
        }
        if (flag === '-p') print = true;
        else if (flag === '-f') functions = true;
        else if (flag === '-F') functionNames = true;
        else if (flag === '-g') global = true;
        else if (flag === '-x') exportFlag = true;
        else if (flag === '+x') exportFlag = false;
        else if (flag === '-r') readonlyFlag = true;
        else if (flag === '+r') readonlyFlag = false;
        else if (flag === '-i') integer = true;
        else if (flag === '+i') integer = false;
        else return failDiag(
            state,
            `declare: ${flag}: invalid option\ndeclare: usage: declare [-afFirtx] [-p] [name[=value] ...]`,
            2
        );
        index++;
    }
    const rest = args.slice(index);
    if (functions) return ok(joinLines([...state.functions.keys()].sort().map((name) => `${name} ()`)), state);
    if (functionNames) return ok(joinLines([...state.functions.keys()].sort().map((name) => `declare -f ${name}`)), state);
    if (rest.length === 0 && !print) {
        const names = varNames(state).sort();
        return ok(joinLines(names.map((name) => declarePrint(name, lookupScope(state, name)?.get(name) ?? { value: getVar(state, name) ?? '' }))), state);
    }
    if (print) {
        const names = rest.length > 0 ? rest : varNames(state).sort();
        const lines: string[] = [];
        for (const name of names) {
            const variable = lookupScope(state, name)?.get(name);
            lines.push(variable === undefined ? '' : declarePrint(name, variable));
        }
        return ok(joinLines(lines.filter((line) => line !== '')), state);
    }
    for (const arg of rest) {
        const assign = splitAssign(arg);
        const name = assign ? assign.name : arg;
        if (!/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?$/.test(name)) return failDiag(state, `declare: \`${arg}': not a valid identifier`, 1);
        const scope = state.scopes.length > 1 && !global ? state.scopes[state.scopes.length - 1] : state.scopes[0];
        if (assign) {
            const base = assign.append ? getVar(state, name) ?? '' : '';
            /* `-i` makes the value arithmetic: `declare -i z=1+2` is a `z` of 3, which is what a
               host's own integer attribute leaves behind it. */
            const raw = base + (assign.value ?? '');
            const value = integer === true && !assign.append ? arithmeticValue(state, raw) : raw;
            if (!scope.has(name)) scope.set(name, { value });
            else setVar(state, name, value);
        } else if (!lookupScope(state, name)) {
            scope.set(name, { value: '' });
        }
        if (exportFlag !== null) {
            const variable = lookupScope(state, name)?.get(name);
            if (variable) variable.export = exportFlag;
        }
        if (readonlyFlag !== null) {
            const variable = lookupScope(state, name)?.get(name);
            if (variable) variable.readonly = readonlyFlag;
        }
        /* `-i` is an attribute the name keeps, not one the value it was given alone: every
           assignment behind it is arithmetic, so `declare -i n=1; n=n+1` is a `n` of 2 and
           `declare -i n; n=x` is a `n` of 0, as they are on a host. Setting it after the value
           was put in place is what makes the assignments behind this line arithmetic too. */
        if (integer !== null) {
            const variable = lookupScope(state, name)?.get(name);
            if (variable) variable.integer = integer;
        }
    }
    return ok();
}

/** The value of an arithmetic expression, or the text itself where it is not one. */
function arithmeticValue(state: ShellState, text: string): string {
    try {
        return String(evalArith(state, text));
    } catch (error) {
        if (error instanceof ArithError) return text;
        throw error;
    }
}

function localBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    if (state.scopes.length <= 1) return failDiag(state, 'local: can only be used in a function', 1);
    const scope = state.scopes[state.scopes.length - 1];
    if (ctx.args.length === 0) {
        return ok(joinLines([...scope.keys()].sort().map((name) => declarePrint(name, scope.get(name) ?? { value: '' }))), state);
    }
    let integer = false;
    for (const arg of ctx.args) {
        /* The attributes `local` takes are the ones `declare` takes: `local -i n=3` is an integer
           `n` in the function's own scope, as it is on a host. */
        if (arg === '-i') {
            integer = true;
            continue;
        }
        const assign = splitAssign(arg);
        if (!assign) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) return failDiag(state, `local: \`${arg}': not a valid identifier`, 1);
            scope.set(arg, { value: '' });
            continue;
        }
        const base = assign.append ? getVar(state, assign.name) ?? '' : '';
        const raw = base + (assign.value ?? '');
        scope.set(assign.name, { value: integer && !assign.append ? arithmeticValue(state, raw) : raw, integer: integer || undefined });
    }
    return ok();
}

function unsetBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    let functions = false;
    let variables = false;
    let status = 0;
    for (const arg of ctx.args) {
        if (arg === '-f') {
            functions = true;
            continue;
        }
        if (arg === '-v') {
            variables = true;
            continue;
        }
        if (arg.startsWith('-')) {
            /* An option `unset` does not know ends the shell a line was handed to with `-c`, the way
               a host's own does: `unset -x; echo st=$?` prints nothing behind the two lines it
               writes and leaves 2. */
            writeErr(state, `${diagnosticPrefix(state)}unset: ${arg}: invalid option\n`
                + 'unset: usage: unset [-f] [-v] [name ...]\n');
            state.exitCalled = true;
            return throwExit(2);
        }
        if (functions) {
            state.functions.delete(arg);
            continue;
        }
        if (!variables && lookupScope(state, arg) === undefined && state.functions.has(arg)) {
            state.functions.delete(arg);
            continue;
        }
        const scope = lookupScope(state, arg);
        if (scope?.get(arg)?.readonly) {
            writeErr(state, `${diagnosticPrefix(state)}unset: ${arg}: cannot unset: readonly variable\n`);
            status = 1;
            continue;
        }
        unsetVar(state, arg);
    }
    return { stdout: '', stderr: '', exitCode: status };
}

function shiftBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const count = ctx.args.length === 0 ? 1 : Number.parseInt(ctx.args[0], 10);
    if (Number.isNaN(count) || count < 0) {
        /* A count `shift` cannot read ends the shell a line was handed to with `-c`, the way a
           host's own does: `shift foo; echo st=$?` prints nothing behind the diagnostic and leaves 1. */
        writeErr(state, `${diagnosticPrefix(state)}shift: ${ctx.args[0]}: numeric argument required\n`);
        state.exitCalled = true;
        return throwExit(1);
    }
    if (count > state.positional.length) {
        state.positional = [];
        return { stdout: '', stderr: '', exitCode: 1 };
    }
    state.positional = state.positional.slice(count);
    return ok();
}

function aliasList(state: ShellState): string {
    return joinLines([...state.aliases.keys()].sort().map((name) => `alias ${name}='${state.aliases.get(name) ?? ''}'`));
}

function aliasBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    if (ctx.args.length === 0 || ctx.args[0] === '-p') return ok(aliasList(state), state);
    for (const arg of ctx.args) {
        const eq = arg.indexOf('=');
        if (eq === -1) {
            const value = state.aliases.get(arg);
            if (value === undefined) return failDiag(state, `alias: ${arg}: not found`, 1);
            return ok(`alias ${arg}='${value}'\n`, state);
        }
        state.aliases.set(arg.slice(0, eq), arg.slice(eq + 1));
    }
    return ok();
}

function unaliasBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    let status = 0;
    for (const arg of ctx.args) {
        if (arg === '-a') {
            state.aliases.clear();
            continue;
        }
        if (!state.aliases.delete(arg)) {
            writeErr(state, `${diagnosticPrefix(state)}unalias: ${arg}: not found\n`);
            status = 1;
        }
    }
    return { stdout: '', stderr: '', exitCode: status };
}

function typeBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const flags = new Set<string>();
    const names: string[] = [];
    for (const arg of ctx.args) {
        if (arg.length > 1 && arg.startsWith('-')) for (const ch of arg.slice(1)) flags.add(ch);
        else names.push(arg);
    }
    if (names.length === 0) return ok();
    let status = 0;
    const lines: string[] = [];
    for (const name of names) {
        if (flags.has('t')) {
            if (state.aliases.has(name)) lines.push('alias');
            else if (COMMANDS[name] !== undefined || HOST_BUILTINS.has(name)) lines.push('builtin');
            else if (state.functions.has(name)) lines.push('function');
            else if (findOnPath(state, name) !== undefined) lines.push('file');
            else {
                status = 1;
                continue;
            }
            continue;
        }
        if (flags.has('p') || flags.has('P')) {
            const path = findOnPath(state, name);
            if (path === undefined) {
                status = 1;
                continue;
            }
            lines.push(path);
            continue;
        }
        /* `-a` is every answer and not the first one: `type -a echo` is the builtin and then the
           file PATH holds under the same name, in that order, as a host lists them. */
        if (flags.has('a')) {
            const described = describeName(state, name);
            const onPath = findOnPath(state, name);
            if (described !== '') lines.push(described);
            if (onPath !== undefined) lines.push(`${name} is ${onPath}`);
            if (described === '' && onPath === undefined) {
                writeErr(state, `${diagnosticPrefix(state)}type: ${name}: not found\n`);
                status = 1;
            }
            continue;
        }
        const text = describeName(state, name);
        if (text === '') {
            writeErr(state, `${diagnosticPrefix(state)}type: ${name}: not found\n`);
            status = 1;
            continue;
        }
        lines.push(text);
    }
    return { stdout: joinLines(lines), stderr: '', exitCode: status };
}

function whichBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    let status = 0;
    const lines: string[] = [];
    for (const arg of ctx.args) {
        if (arg === '-a') continue;
        const path = findOnPath(state, arg);
        if (path === undefined) {
            status = 1;
            continue;
        }
        lines.push(path);
    }
    return { stdout: joinLines(lines), stderr: '', exitCode: status };
}

function commandBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const args = ctx.args;
    let index = 0;
    let describe = false;
    let describeFull = false;
    while (index < args.length && args[index].startsWith('-') && args[index] !== '-') {
        const flag = args[index];
        if (flag === '--') {
            index++;
            break;
        }
        if (flag.includes('v')) describe = true;
        if (flag.includes('V')) {
            describe = true;
            describeFull = true;
        }
        index++;
    }
    const name = args[index];
    if (name === undefined) return ok();
    if (describe) {
        /* `-V` is the one that describes; `-v` is the one that names, and prints the path alone. */
        const text = describeFull ? describeName(state, name) : pathOfName(state, name);
        if (text === '') return { stdout: '', stderr: '', exitCode: 1 };
        return { stdout: (describeFull ? text.split('\n')[0] : text) + '\n', stderr: '', exitCode: 0 };
    }
    const rest = args.slice(index + 1);
    const entry = COMMANDS[name];
    if (entry !== undefined) {
        const inner: CommandContext = { args: rest, cwd: state.cwd, env: state.env, input: ctx.input, fs: ctx.fs };
        bindState(inner, state);
        try {
            return entry(inner);
        } catch (error) {
            return failLine(errorMessage(error), 1);
        }
    }
    const step = RUNNER(state, [name, ...rest], ctx.input);
    return { stdout: step.stdout, stderr: step.stderr, exitCode: step.exitCode };
}

function builtinBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    if (ctx.args.length === 0) return ok();
    const name = ctx.args[0];
    const entry = COMMANDS[name];
    if (entry === undefined) {
        // the host's own builtins count as builtins: `builtin echo hi` must echo
        if (HOST_BUILTINS.has(name)) {
            const step = RUNNER(state, ctx.args, ctx.input);
            return { stdout: step.stdout, stderr: step.stderr, exitCode: step.exitCode };
        }
        return failDiag(state, `builtin: ${name}: not a shell builtin`, 1);
    }
    const inner: CommandContext = { args: ctx.args.slice(1), cwd: state.cwd, env: state.env, input: ctx.input, fs: ctx.fs };
    bindState(inner, state);
    try {
        return entry(inner);
    } catch (error) {
        return failLine(errorMessage(error), 1);
    }
}

function hashBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    let status = 0;
    /* `hash -d name` forgets the command it was remembering: the option a host lists in its own
       usage line -- `hash [-lr] [-p pathname] [-dt] [name ...]` -- and one that leaves a status of
       0 whatever the table held, where reading it as an option `hash` did not know answered
       `hash: -d: invalid option` and 2. */
    let remove = false;
    for (const arg of ctx.args) {
        if (arg === '-r') {
            state.hash.clear();
            continue;
        }
        if (arg === '-d') {
            remove = true;
            continue;
        }
        /* `-l` prints the table in a form a script can read back, `-p path name` remembers a path
           of its own, and `-t` prints the paths the names hold: none of them is a name to look
           up, and a host takes each with the argument behind it. */
        if (arg === '-l' || arg === '-t') continue;
        if (arg === '-p') continue;
        if (arg.startsWith('-')) {
            /* An option `hash` does not know: the two lines a host writes, and the 2 it leaves. */
            return failDiag(
                state,
                `hash: ${arg}: invalid option\nhash: usage: hash [-lr] [-p pathname] [-dt] [name ...]`,
                2
            );
        }
        if (remove) {
            state.hash.delete(arg);
            continue;
        }
        const path = findOnPath(state, arg);
        if (path === undefined) {
            writeErr(state, `${diagnosticPrefix(state)}hash: ${arg}: not found\n`);
            status = 1;
            continue;
        }
        state.hash.set(arg, path);
    }
    if (ctx.args.length === 0) {
        const lines = [...state.hash.entries()].map(([, path]) => `   0\t${path}`);
        return { stdout: joinLines(lines), stderr: '', exitCode: status };
    }
    return { stdout: '', stderr: '', exitCode: status };
}

/** Every builtin name this module implements, sorted. */
export const IMPLEMENTED_BUILTINS: string[] = [
    ':', '.', 'alias', 'bg', 'bind', 'builtin', 'caller', 'command', 'declare', 'dirs', 'disown', 'eval', 'exec',
    'export', 'fg', 'getopts', 'hash', 'help', 'jobs', 'let', 'local', 'mapfile', 'popd', 'pushd', 'read',
    'readarray', 'readonly', 'set', 'shift', 'source', 'suspend', 'times', 'trap', 'type', 'typeset', 'ulimit',
    'umask', 'unalias', 'unset', 'wait', 'which'
].sort();

/**
 * The one line `help <name>` prints for each builtin: its arguments, then ` -- `, then what it does.
 * Exported because `man` prints the same text as a manual page (shell/commands/procinfo.ts).
 */
export const HELP: Record<string, string> = {
    alias: 'alias [-p] [name[=value] ...] -- define or list aliases',
    bg: 'bg [job_spec ...] -- unsupported: this shell stops no job, so none can be resumed',
    bind: 'bind -- unsupported: this shell has no line editing',
    builtin: 'builtin [shell-builtin [arg ...]] -- run a shell builtin, bypassing functions',
    caller: 'caller [expr] -- print the current subroutine call stack',
    command: 'command [-pVv] command [arg ...] -- run a command, ignoring shell functions',
    declare: 'declare [-aAfFgilrtux] [-p] [name[=value] ...] -- declare variables and attributes',
    dirs: 'dirs [-clpv] [+N] [-N] -- display the directory stack',
    disown: 'disown [-h] [-ar] [job_spec ...] -- unsupported: this shell runs its own jobs and keeps them',
    eval: 'eval [arg ...] -- join the arguments and run them as a command',
    exec: 'exec [-cl] [-a name] [command [arguments]] -- replace the shell (documented limits apply)',
    export: 'export [-nf] [name[=value] ...] -- mark names for the environment of commands',
    fg: 'fg [job_spec] -- unsupported: this shell has no terminal to bring a job to',
    getopts: 'getopts optstring name [arg] -- parse positional parameters as options',
    hash: 'hash [-lr] [-p pathname] [name ...] -- remember command locations',
    help: 'help [-s] [pattern ...] -- display information about builtin commands',
    jobs: 'jobs [-lnprs] [jobspec ...] -- list the jobs `&` started, running and done',
    let: 'let arg [arg ...] -- evaluate arithmetic expressions',
    local: 'local [option] name[=value] ... -- declare variables local to a function',
    mapfile: 'mapfile [-t] [-n count] [-s count] [-O origin] [array] -- read lines into an array',
    popd: 'popd [-n] [+N] [-N] -- remove a directory from the stack',
    pushd: 'pushd [-n] [+N] [-N] [dir] -- push a directory onto the stack',
    read: 'read [-ers] [-a array] [-d delim] [-n nchars] [-p prompt] [name ...]',
    readonly: 'readonly [-aAf] [name[=value] ...] -- mark names as readonly',
    set: 'set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [arg ...] -- set options and positional parameters',
    shift: 'shift [n] -- shift the positional parameters',
    source: 'source filename [arguments] -- run commands from a file in this shell',
    suspend: 'suspend [-f] -- unsupported: this shell cannot suspend itself',
    times: 'times -- print the accumulated user and system times',
    trap: 'trap [-lp] [[arg] signal_spec ...] -- run a command when a condition arises',
    type: 'type [-afptP] name [name ...] -- say how each name would be interpreted',
    typeset: 'typeset [-aAfFgilrtux] [-p] name[=value] -- a synonym for declare',
    ulimit: 'ulimit [-SHacdefilmnpqrstuvx] [limit] -- report or set resource limits',
    umask: 'umask [-p] [-S] [mode] -- report or set the file creation mask',
    unalias: 'unalias [-a] name [name ...] -- remove aliases',
    unset: 'unset [-f] [-v] [name ...] -- remove variables or functions',
    wait: 'wait [id ...] -- wait for background jobs; with no id, for every one of them',
    which: 'which [-a] name ... -- print the file that would be executed'
};

function helpBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    void state;
    if (ctx.args.length === 0) {
        const names = IMPLEMENTED_BUILTINS.filter((name) => HELP[name] !== undefined);
        const lines: string[] = [];
        let line = '';
        for (const name of names) {
            if (line.length + name.length + 2 > 66) {
                lines.push(line.trimEnd());
                line = '';
            }
            line += `${name}  `;
        }
        if (line.trimEnd() !== '') lines.push(line.trimEnd());
        return ok(joinLines(lines), state);
    }
    const lines: string[] = [];
    let status = 0;
    for (const name of ctx.args) {
        const text = HELP[name];
        if (text === undefined) {
            lines.push(`help: no help topics match \`${name}'.  Try \`help help'.`);
            status = 1;
            continue;
        }
        lines.push(text);
    }
    return { stdout: joinLines(lines), stderr: '', exitCode: status };
}

function envBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const args = ctx.args;
    let ignore = false;
    let index = 0;
    const additions: Record<string, string> = {};
    for (; index < args.length; index++) {
        const arg = args[index];
        if (arg === '-i') {
            ignore = true;
            continue;
        }
        if (arg === '-u') {
            index++;
            continue;
        }
        if (arg.startsWith('-')) continue;
        const eq = arg.indexOf('=');
        if (eq === -1) break;
        additions[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
    const base: Record<string, string> = ignore ? {} : { ...state.env };
    const merged = { ...base, ...additions };
    const command = args.slice(index);
    if (command.length === 0) {
        return ok(
            joinLines(
                Object.keys(merged).map((name) => `${name}=${merged[name]}`)
            ),
            state
        );
    }
    const saved = state.scopes.map((scope) => new Map(scope));
    for (const [name, value] of Object.entries(merged)) {
        setVar(state, name, value);
        markExported(state, name);
    }
    try {
        const step = RUNNER(state, command, ctx.input);
        return { stdout: step.stdout, stderr: step.stderr, exitCode: step.exitCode };
    } finally {
        state.scopes = saved;
    }
}

function timesBuiltin(ctx: CommandContext): CommandResult {
    void ctx;
    return ok('0m0.000s 0m0.000s\n0m0.000s 0m0.000s\n');
}

function ulimitBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const args = ctx.args;
    let all = false;
    let hard = false;
    let flag: string | null = null;
    let value: string | undefined;
    for (const arg of args) {
        if (arg === '-a') all = true;
        else if (arg === '-H') hard = true;
        else if (arg === '-S') hard = false;
        else if (/^-[a-zA-Z]$/.test(arg)) flag = arg;
        else value = arg;
    }
    if (all) {
        const lines = ULIMIT_TABLE.map((row) => (hard ? row.line.replace(/(\S+)$/, row.hard) : row.line));
        return ok(joinLines(lines), state);
    }
    if (flag === null) {
        if (args.length === 0) {
            const entry = ULIMIT_TABLE.find((row) => row.flag === '-f');
            return ok(`${entry?.soft ?? 'unlimited'}\n`, state);
        }
        if (value !== undefined) return failLine(`ulimit: ${value}: cannot modify limit: Operation not permitted`, 1);
        return ok('unlimited\n', state);
    }
    const entry = ULIMIT_TABLE.find((row) => row.flag === flag);
    if (!entry) return failDiag(
        state,
        `ulimit: ${flag}: invalid option\nulimit: usage: ulimit [-SHacdfilmnpqstuvx] [limit]`,
        2
    );
    if (value === undefined) return ok(`${hard ? entry.hard : entry.soft}\n`, state);
    return failLine(`ulimit: ${value}: cannot modify limit: Operation not permitted`, 1);
}

function umaskBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    let symbolic = false;
    let value: string | undefined;
    for (const arg of ctx.args) {
        if (arg === '-S') symbolic = true;
        else if (arg === '-p') continue;
        else if (arg.startsWith('-')) continue;
        else value = arg;
    }
    if (value === undefined) return ok(symbolic ? `${umaskSymbolic(state.umask)}\n` : `${umaskString(state.umask)}\n`, state);
    /* A value that begins with a digit is octal, and one the host cannot read as octal is out of
       range rather than not a number: `umask 888`, `umask 08` and `umask 7x` all say so. */
    if (/^[0-9]/.test(value)) {
        if (!/^[0-7]+$/.test(value)) return failDiag(state, `umask: ${value}: octal number out of range`, 1);
        state.umask = Number.parseInt(value, 8) & 0o777;
        return ok();
    }
    /* Anything else is a symbolic mode, which the host reads too: `umask u+r` allows owner read
       back and `umask u-r` takes it away, both leaving 0. A character that is neither a class, an
       operator nor a permission is named back the way the host names it -- the first one it could
       not read, or a space where the value ended before it found one. */
    const symbolicMode = parseUmaskSymbolic(state.umask, value);
    if (symbolicMode === undefined) {
        const bad = /[^ugoa]/.exec(value.replace(/^[ugoa]*/, ''));
        /* A builtin's own complaint carries the shell's name and line, as bash prefixes it. */
        return failDiag(state, `umask: \`${bad === null ? ' ' : bad[0]}': invalid symbolic mode operator`, 1);
    }
    state.umask = symbolicMode;
    return ok();
}

/**
 * The mask a symbolic `umask` value leaves, or undefined where the value is not one. The mask is
 * the permissions creation withholds, so `+` grants -- it clears bits -- and `-` withholds: from
 * 022, `g+w` gives 002 and from 077, `u-r` gives 477 and `u=rwx` gives 077.
 */
function parseUmaskSymbolic(mask: number, spec: string): number | undefined {
    let result = mask;
    for (const clause of spec.split(',')) {
        const match = /^([ugoa]*)([-+=])([rwxst]*)$/.exec(clause);
        if (match === null) return undefined;
        let who = match[1] === '' ? 'ugo' : match[1];
        if (who.indexOf('a') >= 0) who = 'ugo';
        let bits = 0;
        for (const letter of match[3]) {
            if (letter === 'r') bits |= 0o444;
            else if (letter === 'w') bits |= 0o222;
            else if (letter === 'x') bits |= 0o111;
            else if (letter === 's') bits |= 0o6000;
            else if (letter === 't') bits |= 0o1000;
        }
        let scope = 0;
        if (who.indexOf('u') >= 0) scope |= 0o700;
        if (who.indexOf('g') >= 0) scope |= 0o070;
        if (who.indexOf('o') >= 0) scope |= 0o007;
        if (match[2] === '+') result &= ~(bits & scope) & 0o777;
        else if (match[2] === '-') result |= bits & scope;
        else result = (result & ~scope) | (~bits & scope);
        result &= 0o777;
    }
    return result;
}

function getoptsBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const spec = ctx.args[0];
    const name = ctx.args[1];
    if (spec === undefined || name === undefined) return failLine('getopts: usage: getopts optstring name [arg]', 2);
    const silent = spec.startsWith(':');
    const letters = silent ? spec.slice(1) : spec;
    const words = ctx.args.length > 2 ? ctx.args.slice(2) : state.positional;
    const declared = Number.parseInt(getVar(state, 'OPTIND') ?? '', 10);
    if (!Number.isNaN(declared) && declared > 0) state.optind = declared;
    const put = (value: number): void => {
        state.optind = value;
        setVar(state, 'OPTIND', String(value));
    };
    let index = state.optind - 1;
    if (index < 0) index = 0;
    if (state.optchar < 1) state.optchar = 1;
    for (;;) {
        if (index >= words.length) {
            state.optarg = '';
            setVar(state, 'OPTARG', '');
            setVar(state, name, '?');
            put(index + 1);
            state.optchar = 1;
            return { stdout: '', stderr: '', exitCode: 1 };
        }
        const word = words[index];
        if (!word.startsWith('-') || word === '-' || word === '--') {
            state.optarg = '';
            setVar(state, 'OPTARG', '');
            setVar(state, name, '?');
            put(index + 1);
            state.optchar = 1;
            return { stdout: '', stderr: '', exitCode: 1 };
        }
        const letter = word[state.optchar];
        if (letter === undefined) {
            index++;
            put(index + 1);
            state.optchar = 1;
            continue;
        }
        const at = letters.indexOf(letter);
        if (at === -1) {
            setVar(state, 'OPTARG', silent ? letter : '');
            state.optarg = silent ? letter : '';
            setVar(state, name, '?');
            /* `getopts` names the option it could not read without the line a builtin's own
               complaint carries: a host's `sh: illegal option -- x`. */
            if (!silent) writeErr(state, `${state.shellName}: illegal option -- ${letter}\n`);
            if (state.optchar + 1 >= word.length) {
                put(index + 2);
                state.optchar = 1;
            } else {
                state.optchar += 1;
            }
            return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (letters[at + 1] === ':') {
            if (state.optchar + 1 < word.length) {
                state.optarg = word.slice(state.optchar + 1);
                put(index + 2);
                state.optchar = 1;
            } else {
                state.optarg = words[index + 1] ?? '';
                put(index + 3);
                state.optchar = 1;
            }
            if (state.optarg === '') {
                setVar(state, 'OPTARG', silent ? letter : '');
                setVar(state, name, silent ? ':' : '?');
                if (!silent) writeErr(state, `${state.shellName}: option requires an argument -- ${letter}\n`);
                return { stdout: '', stderr: '', exitCode: 0 };
            }
        } else {
            state.optarg = '';
            if (state.optchar + 1 >= word.length) {
                put(index + 2);
                state.optchar = 1;
            } else {
                state.optchar += 1;
            }
        }
        setVar(state, 'OPTARG', state.optarg);
        setVar(state, name, letter);
        return { stdout: '', stderr: '', exitCode: 0 };
    }
}

function evalBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    let status = 0;
    try {
        const nodes = new Parser(ctx.args.join(' '), state).parse();
        status = runCommandList(state, nodes, null);
    } catch (error) {
        if (error instanceof ShellSyntaxError) return failLine(error.message, 2);
        if (error instanceof ExitSignal || error instanceof ReturnSignal || error instanceof BreakSignal || error instanceof ContinueSignal) throw error;
        return failLine(errorMessage(error), 1);
    }
    return { stdout: '', stderr: '', exitCode: status };
}

/**
 * The two lines a host writes when `source` is given no file: the name it was called by -- `.` and
 * `source` each name themselves -- and then its usage: `/bin/sh: .: filename argument required`
 * followed by `.: usage: . filename [arguments]`.
 */
function sourceBuiltin(ctx: CommandContext, name = 'source'): CommandResult {
    const state = stateOf(ctx);
    if (ctx.args.length === 0) {
        return failLine(`${state.shellName}: ${name}: filename argument required\n${name}: usage: ${name} filename [arguments]`, 2);
    }
    const file = ctx.args[0];
    // resolve here and hand `inputText` an absolute path, so its own resolution cannot move it
    const path = resolvePath(state, file);
    const fileCtx: CommandContext = { args: [path], cwd: state.cwd, env: state.env, input: null, fs: (state.fs ?? NO_FS) as never };
    let text: string | undefined;
    try {
        text = inputText(fileCtx)[0].text;
    } catch (error) {
        return failLine(`${path}: ${errorMessage(error).replace(/^[^:]*: /, '')}`, 1);
    }
    const savedPositional = state.positional;
    const savedSource = state.source;
    state.positional = ctx.args.slice(1);
    state.source = path;
    let status = 0;
    try {
        const nodes = new Parser(text, state).parse();
        status = runCommandList(state, nodes, null);
    } catch (error) {
        if (error instanceof ReturnSignal) return { stdout: '', stderr: '', exitCode: error.code };
        if (error instanceof ShellSyntaxError) return failLine(error.message, 2);
        throw error;
    } finally {
        state.positional = savedPositional;
        state.source = savedSource;
    }
    return { stdout: '', stderr: '', exitCode: status };
}

function execBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    if (ctx.args.length === 0) return ok();
    state.execTarget = ctx.args.slice();
    const name = ctx.args[0];
    const entry = COMMANDS[name];
    let status: number;
    if (entry !== undefined) {
        const inner: CommandContext = { args: ctx.args.slice(1), cwd: state.cwd, env: state.env, input: ctx.input, fs: ctx.fs };
        bindState(inner, state);
        const result = entry(inner);
        writeOut(state, result.stdout);
        writeErr(state, result.stderr);
        status = result.exitCode;
    } else {
        const step = RUNNER(state, ctx.args, ctx.input);
        writeOut(state, step.stdout);
        /* `exec nosuchcmd` is a host's `sh: line 0: exec: nosuchcmd: not found`: the builtin that
           failed is named, with the line a jobspec diagnostic carries, where the same name on a
           line of its own is only `sh: nosuchcmd: command not found` -- the lookup reported as a
           bare command rather than as the `exec` that went looking for it. */
        if (step.exitCode === 127 && /: command not found\n$/.test(step.stderr)) {
            writeErr(state, `${diagnosticPrefix(state)}exec: ${name}: not found\n`);
        } else {
            writeErr(state, step.stderr);
        }
        status = step.exitCode;
    }
    throw new ExitSignal(status);
}

function readBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const args = ctx.args;
    let delimiter = '\n';
    let keep = false;
    let arrayName: string | undefined;
    let count = -1;
    let prompt: string | undefined;
    const names: string[] = [];
    let index = 0;
    while (index < args.length) {
        const arg = args[index];
        if (arg === '--') {
            names.push(...args.slice(index + 1));
            break;
        }
        if (!arg.startsWith('-')) {
            names.push(...args.slice(index));
            break;
        }
        for (let i = 1; i < arg.length; i++) {
            const ch = arg[i];
            if (ch === 'r') keep = true;
            else if (ch === 'a') {
                arrayName = args[index + 1];
                index++;
            } else if (ch === 'd') {
                delimiter = args[index + 1] ?? '\n';
                index++;
            } else if (ch === 'n' || ch === 'N') {
                count = Number.parseInt(args[index + 1] ?? '0', 10);
                index++;
            } else if (ch === 'p') {
                prompt = args[index + 1] ?? '';
                index++;
            } else if (ch === 's' || ch === 't' || ch === 'u' || ch === 'e') {
                index++;
            } else {
                /* An option `read` does not know: the two lines a host writes, and the 2 it leaves. */
                return failDiag(
                    state,
                    `read: -${ch}: invalid option\n`
                        + 'read: usage: read [-ers] [-u fd] [-t timeout] [-p prompt] [-a array] [-n nchars] [-d delim] [name ...]',
                    2
                );
            }
        }
        index++;
    }
    if (prompt !== undefined) writeOut(state, prompt);
    let line = '';
    let hit = false;
    if (count >= 0) {
        let text = '';
        for (let i = 0; i < count; i++) {
            if (state.inputCursor >= state.inputBuffer.length) break;
            text += state.inputBuffer[state.inputCursor];
            state.inputCursor++;
        }
        line = text;
        hit = text.length === count;
    } else {
        const result = readLine(state, delimiter, keep);
        line = result.text;
        hit = result.hit;
    }
    if (arrayName !== undefined) {
        const fields = splitFields(line, line.split('').map(() => false), getVar(state, 'IFS') ?? ' \t\n');
        for (let i = 0; i < fields.length; i++) setVar(state, `${arrayName}[${i}]`, fields[i]);
        setVar(state, arrayName, fields.join(' '));
        return { stdout: '', stderr: '', exitCode: hit ? 0 : 1 };
    }
    if (names.length === 0) {
        setVar(state, 'REPLY', line);
        return { stdout: '', stderr: '', exitCode: hit ? 0 : 1 };
    }
    const values = splitForRead(state, line, names.length);
    for (let i = 0; i < names.length; i++) setVar(state, names[i], values[i] ?? '');
    return { stdout: '', stderr: '', exitCode: hit ? 0 : 1 };
}

function mapfileBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    let strip = false;
    let name = 'MAPFILE';
    let skip = 0;
    let count = -1;
    let origin = 0;
    const args = ctx.args;
    let index = 0;
    while (index < args.length) {
        const arg = args[index];
        if (!arg.startsWith('-')) break;
        if (arg === '-t') strip = true;
        else if (arg === '-n') {
            count = Number.parseInt(args[index + 1] ?? '0', 10);
            index++;
        } else if (arg === '-s') {
            skip = Number.parseInt(args[index + 1] ?? '0', 10);
            index++;
        } else if (arg === '-O') {
            origin = Number.parseInt(args[index + 1] ?? '0', 10);
            index++;
        } else if (arg === '-u' || arg === '-C' || arg === '-c') index++;
        index++;
    }
    if (index < args.length) name = args[index];
    const lines: string[] = [];
    let text = state.inputBuffer.slice(state.inputCursor);
    state.inputCursor = state.inputBuffer.length;
    while (text.length > 0) {
        const at = text.indexOf('\n');
        if (at === -1) {
            lines.push(text);
            break;
        }
        lines.push(text.slice(0, at));
        text = text.slice(at + 1);
    }
    const chosen = lines.slice(skip, count === -1 ? undefined : skip + count);
    for (let i = 0; i < chosen.length; i++) setVar(state, `${name}[${origin + i}]`, strip ? chosen[i] : chosen[i] + '\n');
    setVar(state, name, chosen.join(''));
    return { stdout: '', stderr: '', exitCode: 0 };
}

function callerBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const depth = ctx.args.length > 0 ? Number.parseInt(ctx.args[0], 10) : 0;
    /* A word that is no depth says nothing at all -- a host's `caller x` is the plain false of a
       builtin that found no frame, with no complaint about the word it could not read. */
    if (Number.isNaN(depth)) return { stdout: '', stderr: '', exitCode: 1 };
    // `caller` is the caller of the current function: one frame below the innermost
    const frame = state.callStack[state.callStack.length - 2 - depth];
    if (frame === undefined) return { stdout: '', stderr: '', exitCode: 1 };
    if (ctx.args.length > 0) return ok(`${frame.line} ${frame.name} ${frame.source}\n`, state);
    return ok(`${frame.line} ${frame.source}\n`, state);
}

function dirsBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    let clear = false;
    let numbered = false;
    let expand = false;
    for (const arg of ctx.args) {
        if (arg === '-c') clear = true;
        else if (arg === '-v') numbered = true;
        else if (arg === '-l') expand = true;
        /* Any other option is `dirs`' own complaint -- a host calls the one it could not read an
           invalid *number* -- with the usage line behind it and the 1 it leaves. */
        else if (arg.startsWith('-') && !/^-[0-9]+$/.test(arg)) {
            return failDiag(state, `dirs: ${arg}: invalid number\ndirs: usage: dirs [-clpv] [+N] [-N]`, 1);
        }
    }
    if (clear) {
        state.dirs = [state.cwd];
        return ok();
    }
    const list = state.dirs.map((dir) => (expand ? dir : abbreviateHome(state, dir)));
    if (numbered) return ok(joinLines(list.map((dir, index) => ` ${index}  ${dir}`)), state);
    return ok(list.join(' ') + '\n', state);
}

function pushdBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const target = ctx.args.filter((arg) => !arg.startsWith('-'))[0] ?? '';
    if (target === '') {
        // no argument: rotate the top two entries, the way bash's pushd does
        if (state.dirs.length < 2) return failDiag(state, 'pushd: no other directory', 1);
        const first = state.dirs[0];
        state.dirs[0] = state.dirs[1];
        state.dirs[1] = first;
        state.cwd = state.dirs[0];
        syncPwd(state);
        return ok(state.dirs.map((dir) => abbreviateHome(state, dir)).join(' ') + '\n', state);
    }
    const next = resolvePath(state, target);
    const fs = state.fs;
    /* A name nothing in the tree holds is the diagnostic a host writes, not the file system's own
       error: `pushd /nosuchdir` is `sh: line 0: pushd: /nosuchdir: No such file or directory`. */
    let isDirectory = true;
    try {
        if (fs) isDirectory = fs.isDirectory(next);
    } catch {
        isDirectory = false;
    }
    if (!isDirectory) return failDiag(state, `pushd: ${target}: No such file or directory`, 1);
    state.dirs.unshift(next);
    state.cwd = next;
    syncPwd(state);
    return ok(state.dirs.map((dir) => abbreviateHome(state, dir)).join(' ') + '\n', state);
}

function popdBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    if (state.dirs.length <= 1) return failDiag(state, 'popd: directory stack empty', 1);
    state.dirs.shift();
    state.cwd = state.dirs[0];
    syncPwd(state);
    return ok(state.dirs.map((dir) => abbreviateHome(state, dir)).join(' ') + '\n', state);
}

/**
 * The front of a builtin's own diagnostic, as bash 3.2 prints it: `$0: line N: ` for a shell
 * running the string `sh -c` was given -- numbered from 0, which is why its first line is
 * `line 0` -- and `$0: ` with no line at all for an interactive one.
 */
export function diagnosticPrefix(state: ShellState): string {
    const name = state.shellName === '' ? 'sh' : state.shellName;
    if (state.options.interactive) return `${name}: `;
    return `${name}: line ${state.line > 1 ? state.line - 1 : 0}: `;
}

/** Drops the jobs that have run out of the table: a shell lists a job only while it has one to run. */
function reapJobs(state: ShellState): void {
    const jobs = state.jobs;
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].done) jobs.splice(i, 1);
}

/**
 * Runs every job the shell has not run yet, in the order it was started, and drops them. This is
 * what a background job means on a host that runs one command at a time: the command is not waited
 * for where it stands, and it runs -- with its output kept -- once the line's foreground is through.
 */
export function runPendingJobs(state: ShellState): { stdout: string; stderr: string; exitCode: number } {
    const jobs = state.jobs;
    let stdout = '';
    let stderr = '';
    for (const job of jobs) {
        /* A job `kill` ended and `wait` never asked for still gets its notice written here, which is
           the only "later" a line handed to `sh -c` has. */
        if (job.done && job.terminated !== true) continue;
        const step = runPendingJob(state, job);
        stdout += step.stdout;
        stderr += step.stderr;
    }
    reapJobs(state);
    return { stdout, stderr, exitCode: 0 };
}

/**
 * `kill %1`: the job is over, with the status a process killed by SIGTERM leaves (128 + 15). A
 * jobspec that names no job is bash's own `kill: %1: no such job`, with status 1 -- not the
 * `illegal process id` a word that is no pid at all gets.
 */
/**
 * True when `word` is the pid of a job this shell has started and not run yet: the pid `$!` holds.
 *
 * Such a job has no process behind it -- it runs when the line around it is through -- which is why
 * the `kill` of `procinfo.ts` cannot reach it and answered `kill $!` with `No such process` and 1.
 */
function isPendingJobPid(state: ShellState, word: string): boolean {
    if (word === '' || !/^[0-9]+$/.test(word)) return false;
    const pid = Number.parseInt(word, 10);
    return state.jobs.some((job) => job.pid === pid && !job.done);
}

/** What a host writes for a process a signal ended: `Terminated` for SIGTERM, `Killed` for SIGKILL. */
const SIGNAL_DESCRIPTIONS: Record<string, string> = {
    HUP: 'Hangup',
    INT: 'Interrupt',
    QUIT: 'Quit',
    ILL: 'Illegal instruction',
    TRAP: 'Trace/breakpoint trap',
    ABRT: 'Abort trap',
    FPE: 'Floating point exception',
    KILL: 'Killed',
    BUS: 'Bus error',
    SEGV: 'Segmentation fault',
    PIPE: 'Broken pipe',
    ALRM: 'Alarm clock',
    TERM: 'Terminated',
    USR1: 'User defined signal 1',
    USR2: 'User defined signal 2'
};

/**
 * The signal word `kill` was given: `-TERM` and `-15`, and the word behind `-s` or `-n`. Null when
 * no option was given at all, which is the TERM a bare `kill` sends.
 */
function killSignalWord(args: string[]): string | null {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-s' || arg === '-n') return args[i + 1] ?? '';
        if (arg.startsWith('-') && arg !== '-') return arg.slice(1);
    }
    return null;
}

/**
 * The signal `kill` was asked for: `-TERM`, `-15`, `-s TERM` and `-n 15` are all the same one, and
 * TERM is the one `kill` sends when it is given none.
 *
 * Null is a specification the host refuses: bash 3.2 rejects the `SIG` prefix outright, so both
 * `kill -SIGTERM` and `kill -s SIGTERM` answer `invalid signal specification`, and it rejects a name
 * no signal has. A name may carry a digit -- `-USR1` is a signal, and a pattern of letters only
 * silently turned it into the default TERM.
 */
function killSignal(args: string[]): { number: number; name: string } | null {
    const word = killSignalWord(args);
    if (word === null) return { number: 15, name: 'TERM' };
    if (/^SIG/i.test(word)) return null;
    if (/^[0-9]+$/.test(word)) {
        const number = Number.parseInt(word, 10);
        // 0 is the "does it exist" signal: `kill -0` sends nothing.
        return number <= signalNames().length ? { number, name: signalNames()[number - 1] ?? '' } : null;
    }
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(word)) return null;
    const at = signalNames().indexOf(word.toUpperCase());
    return at === -1 ? null : { number: at + 1, name: signalNames()[at] };
}

/**
 * The line a shell writes when a job it started ends on a signal: `sh: line 0: 62000 Terminated:
 * 15          ( exit 3 )`, with the pid the job was given, the signal that ended it and the command
 * it was started from -- a subshell carrying its own parens, which is how a host prints one.
 */
function jobTerminatedNotice(state: ShellState, job: ShellJob, signal: { number: number; name: string }): string {
    /* A job SIGINT or SIGPIPE ended gets no notice at all from a non-interactive bash: it names
       SIGTERM, SIGKILL, SIGHUP and the rest, and stays silent on those two. */
    if (signal.number === 2 || signal.number === 13) return '';
    const description = SIGNAL_DESCRIPTIONS[signal.name] ?? signal.name;
    const label = `${description}: ${signal.number}`;
    /* The host right-aligns the signal to one column, so `Hangup: 1` and `Killed: 9` both start
       their `( exit 3 )` at the same place; a label too long for the column keeps a single space. */
    const pad = ' '.repeat(Math.max(1, 24 - label.length));
    return `${diagnosticPrefix(state)}${job.pid} ${label}${pad}${job.text}\n`;
}

export function killJobSpecs(state: ShellState, args: string[]): CommandResult {
    const signal = killSignal(args);
    /* A specification the host refuses: `kill -SIGTERM %1` is `kill: SIGTERM: invalid signal
       specification` and status 1, and nothing is signalled. */
    if (signal === null) {
        return { stdout: '', stderr: `${diagnosticPrefix(state)}kill: ${killSignalWord(args) ?? ''}: invalid signal specification\n`, exitCode: 1 };
    }
    /* `kill -0` only asks whether the job exists: bash sends nothing, leaves the job running and
       reports success, so a `wait` behind it still sees the job's own status -- not 128 + 0. */
    const existenceOnly = signal.number === 0;
    let stderr = '';
    let exitCode = 0;
    for (const arg of args) {
        if (!arg.startsWith('%')) {
            /* A pid of this shell's own job, as `kill $!` names one: it is over, with the status a
               process killed by SIGTERM leaves, and `kill` reports the success a host reports. */
            if (isPendingJobPid(state, arg)) {
                if (existenceOnly) continue;
                const pid = Number.parseInt(arg, 10);
                const job = state.jobs.find((entry) => entry.pid === pid && !entry.done);
                if (job !== undefined) {
                    job.done = true;
                    job.exitCode = 128 + signal.number;
                    job.terminated = true;
                    job.signal = signal;
                }
            }
            continue;
        }
        const job = findJob(state.jobs, arg);
        if (job === undefined) {
            stderr += `${diagnosticPrefix(state)}kill: ${arg}: no such job\n`;
            exitCode = 1;
            continue;
        }
        if (existenceOnly) continue;
        job.done = true;
        job.exitCode = 128 + signal.number;
        job.terminated = true;
        job.signal = signal;
    }
    /* A job `kill` ended stays in the table for `wait` to report: a host reaps it -- and writes the
       notice that names it -- while `wait` is waiting, not at the moment of the `kill`. */
    for (let i = state.jobs.length - 1; i >= 0; i--) {
        if (state.jobs[i].done && state.jobs[i].terminated !== true) state.jobs.splice(i, 1);
    }
    return { stdout: '', stderr, exitCode };
}

/**
 * The job a `jobs` or `wait` argument names: `%2` is the second job, `%+` the newest and `%-` the
 * one before it, and a bare number is a pid -- the one `&` printed and `$!` holds.
 */
function findJob(jobs: ShellJob[], name: string): ShellJob | undefined {
    if (name.startsWith('%')) {
        const spec = name.slice(1);
        if (spec === '' || spec === '%' || spec === '+') return jobs[jobs.length - 1];
        if (spec === '-') return jobs[jobs.length - 2];
        const id = Number(spec);
        return spec === '' || Number.isNaN(id) ? undefined : jobs.find((job) => job.id === id);
    }
    const pid = Number(name);
    return name === '' || Number.isNaN(pid) ? undefined : jobs.find((job) => job.pid === pid);
}

/** The `+` and the `-` of `jobs`: the newest job is the current one, the one before it the previous. */
function jobMarker(jobs: ShellJob[], job: ShellJob): string {
    if (job === jobs[jobs.length - 1]) return '+';
    if (job === jobs[jobs.length - 2]) return '-';
    return ' ';
}

/**
 * Splits `source` at the operators that sit between commands, keeping quoting: `|`, `&&`, `||` and
 * `;`. The operators themselves are kept, in the order they were met.
 */
function splitJobSegments(source: string): { op: string | null; text: string }[] {
    const out: { op: string | null; text: string }[] = [];
    let text = '';
    let op: string | null = null;
    /* An operator inside a subshell or a group belongs to the construct, not to the list around it:
       `(echo a;echo b)` is one job, not a `;` list of half a paren and half a paren. */
    let depth = 0;
    const push = (next: string): void => {
        out.push({ op, text: text.trim() });
        text = '';
        op = next;
    };
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        if (ch === "'") {
            const close = source.indexOf("'", i + 1);
            const stop = close === -1 ? source.length : close;
            text += source.slice(i, stop + 1);
            i = stop + 1;
            continue;
        }
        if (ch === '"') {
            let j = i + 1;
            while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
            text += source.slice(i, Math.min(j + 1, source.length));
            i = j + 1;
            continue;
        }
        if (ch === '\\') {
            text += source.slice(i, i + 2);
            i += 2;
            continue;
        }
        if (ch === '(' || ch === '{') depth++;
        else if (ch === ')' || ch === '}') depth--;
        if (ch === '|') {
            if (depth > 0) {
                text += ch;
                i++;
                continue;
            }
            push(source[i + 1] === '|' ? '||' : '|');
            i += source[i + 1] === '|' ? 2 : 1;
            continue;
        }
        if (ch === '&' && source[i + 1] === '&') {
            if (depth > 0) {
                text += '&&';
                i += 2;
                continue;
            }
            push('&&');
            i += 2;
            continue;
        }
        if (ch === ';') {
            if (depth > 0) {
                text += ch;
                i++;
                continue;
            }
            push(';');
            i++;
            continue;
        }
        text += ch;
        i++;
    }
    out.push({ op, text: text.trim() });
    return out.filter((segment) => segment.text !== '' || segment.op !== null);
}

/**
 * How the operator in front of one segment of a job is printed: `;` closes the command before it
 * and takes no space of its own, while `|`, `&&` and `||` are spaced on both sides.
 */
function joinJobOp(op: string | null): string {
    if (op === null) return '';
    return op === ';' ? '; ' : ` ${op} `;
}

/** The words a shell would read out of `text`, joined by one space: `echo  a` is `echo a`. */
function jobWords(text: string): string {
    const words: string[] = [];
    let word = '';
    let inWord = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === ' ' || ch === '\t' || ch === '\n') {
            if (inWord) {
                words.push(word);
                word = '';
                inWord = false;
            }
            i++;
        } else if (ch === "'") {
            const close = text.indexOf("'", i + 1);
            const stop = close === -1 ? text.length : close;
            word += text.slice(i + 1, stop);
            inWord = true;
            i = stop + 1;
        } else if (ch === '"') {
            inWord = true;
            i++;
            while (i < text.length && text[i] !== '"') {
                const next = text[i + 1];
                if (text[i] === '\\' && next !== undefined && '"\\$`'.includes(next)) {
                    word += next;
                    i += 2;
                } else {
                    word += text[i];
                    i++;
                }
            }
            i++;
        } else if (ch === '\\') {
            const next = text[i + 1];
            if (next !== undefined) word += next;
            inWord = true;
            i += 2;
        } else {
            word += ch;
            inWord = true;
            i++;
        }
    }
    if (inWord) words.push(word);
    return words.join(' ');
}

/** The index of the `)` closing the `(` at `start`, or -1 when it is never closed. */
function closingParen(text: string, start: number): number {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'" || ch === '"') {
            const quote = ch;
            let j = i + 1;
            while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1;
            i = j;
            continue;
        }
        if (ch === '\\') {
            i++;
            continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function jobSegmentText(text: string): string {
    const trimmed = text.trim();
    /* A subshell is printed with a space inside each paren, as bash prints it: `(echo a)` is the
       job `( echo a )`, which is why `set -- $(jobs)` counts seven words for it and not five. */
    if (trimmed.startsWith('(')) {
        const close = closingParen(trimmed, 0);
        if (close === trimmed.length - 1) return `( ${jobSegmentText(trimmed.slice(1, -1))} )`;
    }
    const parts = splitJobSegments(trimmed);
    if (parts.length > 1) {
        let out = '';
        for (const part of parts) out += joinJobOp(part.op) + jobSegmentText(part.text);
        return out;
    }
    return jobWords(trimmed);
}

/**
 * The command as `jobs` prints it: the source of the pipeline the `&` was written on, in the one
 * shape bash prints it in -- words joined by single spaces, `|`, `&&`, `||` and `;` spaced, and a
 * subshell opened and closed with a space inside its parens.
 */
export function formatJobText(source: string): string {
    const segments = splitJobSegments(source);
    let out = '';
    for (const segment of segments) {
        if (segment.text === '') continue;
        out += joinJobOp(segment.op) + jobSegmentText(segment.text);
    }
    return out === '' ? source.trim() : out;
}

/**
 * One line of `jobs`, in the columns a shell prints them in: `[1]+  Running                 echo a &`.
 * A job that has run is reported `Done` and without the `&`, as a shell reports one.
 */
function jobLine(jobs: ShellJob[], job: ShellJob, long: boolean): string {
    /* The pid of `-l` is right-aligned in a column five wide, as bash prints it: `[1]+  9120`
       for a four-digit pid and `[1]+ 51920` for a five-digit one. */
    const pid = long ? `${String(job.pid).padStart(5)} ` : ' ';
    return `[${job.id}]${jobMarker(jobs, job)} ${pid}${(job.done ? 'Done' : 'Running').padEnd(24)}${job.text}${job.done ? '' : ' &'}\n`;
}

function jobsBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const jobs = state.jobs;
    let long = false;
    let pidOnly = false;
    const specs: string[] = [];
    for (const arg of ctx.args) {
        if (arg === '-l') long = true;
        else if (arg === '-p') pidOnly = true;
        // `-r`, `-s` and `-n` narrow the list to running, stopped and newly changed jobs. This shell
        // stops no job and keeps no notification history, so they narrow nothing; the dispatcher's
        // own `jobs` reads the three the same way
        else if (arg === '-r' || arg === '-s' || arg === '-n') continue;
        else if (arg.length > 1 && arg.startsWith('-')) return failDiag(
            state,
            `jobs: ${arg}: invalid option\njobs: usage: jobs [-lnprs] [jobspec ...] or jobs -x command [args]`,
            2
        );
        else specs.push(arg);
    }
    let listed = jobs;
    if (specs.length > 0) {
        listed = [];
        for (const spec of specs) {
            const job = findJob(jobs, spec);
            if (job === undefined) return failLine(`${diagnosticPrefix(state)}jobs: ${spec}: no such job`, 1);
            listed.push(job);
        }
    }
    let out = '';
    for (const job of listed) out += pidOnly ? `${job.pid}\n` : jobLine(jobs, job, long);
    return ok(out, state);
}

/**
 * `fg`, and the `%1` that bash reads as `fg %1`: the job is brought to the foreground, which here
 * means it is run now and waited for, with its command printed first as a shell prints it.
 *
 * A shell with no job control -- every `sh -c`, which has no terminal to give a job -- cannot do
 * that at all, and says so: `sh: line 0: fg: no job control`, whatever jobs the line has started.
 */
function fgBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const prefix = diagnosticPrefix(state);
    if (state.options.monitor !== true) return failLine(`${prefix}fg: no job control`, 1);
    const jobs = state.jobs;
    const named = ctx.args.length > 0;
    const spec = named ? ctx.args[0] : '%+';
    const job = findJob(jobs, spec);
    if (job === undefined) {
        return failLine(`${prefix}fg: ${named ? spec : 'current'}: no such job`, 1);
    }
    const step = runPendingJob(state, job);
    reapJobs(state);
    return { stdout: `${job.text}\n${step.stdout}`, stderr: step.stderr, exitCode: step.exitCode };
}

/**
 * `bg`: the job is already running in the one sense this shell can run one -- it runs when the line
 * around it is through -- so the answer is bash's own, `sh: bg: job 1 already in background`, with
 * status 0. A shell with no job control says what `fg` says.
 */
function bgBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const prefix = diagnosticPrefix(state);
    if (state.options.monitor !== true) return failLine(`${prefix}bg: no job control`, 1);
    const jobs = state.jobs;
    const named = ctx.args.length > 0;
    const spec = named ? ctx.args[0] : '%+';
    const job = findJob(jobs, spec);
    if (job === undefined) {
        return failLine(`${prefix}bg: ${named ? spec : 'current'}: no such job`, 1);
    }
    return { stdout: '', stderr: `${state.shellName}: bg: job ${job.id} already in background\n`, exitCode: 0 };
}

/**
 * `disown`: the job is taken out of the table, so `jobs` lists it no more and `wait` has nothing
 * left to wait for. It is the one of the four that succeeds on a shell with no job control.
 */
function disownBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const jobs = state.jobs;
    const named = ctx.args.length > 0;
    const spec = named ? ctx.args[0] : '%+';
    const job = findJob(jobs, spec);
    if (job === undefined) return failLine(`${diagnosticPrefix(state)}disown: ${named ? spec : 'current'}: no such job`, 1);
    jobs.splice(jobs.indexOf(job), 1);
    return ok();
}

function suspendBuiltin(ctx: CommandContext): CommandResult {
    /* A host's own words for it, behind the shell's name and line: `suspend` on a shell with no job
       control cannot suspend, and says so. */
    return failDiag(stateOf(ctx), 'suspend: cannot suspend: no job control', 1);
}

/**
 * Runs one job to completion, as a subshell: what it does to the directory, the variables and `$?`
 * stays in it, and its output is what the caller prints. The job is left done, so the host's own
 * run of it at the end of the line no longer runs it a second time.
 */
function runPendingJob(state: ShellState, job: ShellJob): { stdout: string; stderr: string; exitCode: number } {
    /* A job `kill` ended never runs: a host writes the notice for it while `wait` is waiting, which
       is when it reaps the process, so the notice comes out after the `kill` that sent the signal
       and before the command behind `wait` -- not at the moment of the `kill` itself. */
    if (job.terminated === true) {
        job.terminated = false;
        return { stdout: '', stderr: jobTerminatedNotice(state, job, job.signal ?? { number: 15, name: 'TERM' }), exitCode: job.exitCode };
    }
    const snapshot = snapshotState(state);
    const savedIo = state.io;
    try {
        /* The source the `&` was written on, not the text `jobs` prints: printing a command is what
           takes its quoting out, and a job replayed from unquoted words is a different command. */
        const result = runScriptNoExitTrap(state, job.source ?? job.text);
        job.done = true;
        job.exitCode = result.exitCode;
        return result;
    } finally {
        state.io = savedIo;
        restoreState(state, snapshot);
    }
}

function waitBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const jobs = state.jobs;
    let stdout = '';
    let stderr = '';
    if (ctx.args.length === 0) {
        // no argument waits for every job, in the order it was started, and its status is 0 -- a
        // shell reports what a job failed with only when the job is named
        for (const job of jobs) {
            /* A job `kill` ended is `wait`ed for like any other: it is over, and the shell writes
               the notice for it here rather than keeping it to write later. */
            if (job.done && job.terminated !== true) continue;
            const step = runPendingJob(state, job);
            stdout += step.stdout;
            stderr += step.stderr;
        }
        // a job `wait` has waited for is a job `jobs` lists no more, as it is in a shell
        reapJobs(state);
        return { stdout, stderr, exitCode: 0 };
    }
    let exitCode = 0;
    for (const arg of ctx.args) {
        if (arg === '-n' || arg === '-f') continue;
        const job = findJob(jobs, arg);
        if (job === undefined) {
            /* bash says which of the three went wrong: a jobspec that names no job, a number that
               is no child of the shell, or a word that is neither. The middle one is written
               without the `line 0` the other two carry, as bash writes it. */
            if (arg.startsWith('%')) stderr += `${diagnosticPrefix(state)}wait: ${arg}: no such job\n`;
            else if (/^[0-9]+$/.test(arg)) stderr += `${state.shellName}: wait: pid ${arg} is not a child of this shell\n`;
            else stderr += `${diagnosticPrefix(state)}wait: \`${arg}': not a pid or valid job spec\n`;
            exitCode = arg.startsWith('%') || /^[0-9]+$/.test(arg) ? 127 : 1;
            continue;
        }
        const step = job.done && job.terminated !== true
            ? { stdout: '', stderr: '', exitCode: job.exitCode }
            : runPendingJob(state, job);
        stdout += step.stdout;
        stderr += step.stderr;
        exitCode = step.exitCode;
    }
    reapJobs(state);
    return { stdout, stderr, exitCode };
}

function bindBuiltin(ctx: CommandContext): CommandResult {
    /* `bind` with nothing behind it is a host's plain failure: no line editing to list, no complaint
       about it either -- the status 1 and nothing written at all. */
    void ctx;
    return { stdout: '', stderr: '', exitCode: 1 };
}

function letBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    /* No expression at all is the complaint a host writes for one: `sh: line 0: let: expression
       expected`, where `let ''` and `let 1+` are named by the expression that failed instead. */
    if (ctx.args.length === 0) return failDiag(state, 'let: expression expected', 1);
    let value = 0;
    for (const arg of ctx.args) {
        try {
            value = evalArith(state, arg);
        } catch (error) {
            /* A host names the word the expression came from and the expression itself, and keeps
               the status `let` has for a bad expression -- 1, where an expansion's own error is
               127: `/bin/sh: let: x=1+: syntax error: operand expected (error token is "+")`. */
            if (error instanceof ArithError) return failLine(arithDiagnostic(state, arg, error, 'let'), 1);
            return failDiag(state, `let: ${errorMessage(error)}`, 1);
        }
    }
    return { stdout: '', stderr: '', exitCode: value === 0 ? 1 : 0 };
}

function trapBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    const args = ctx.args;
    if (args.length === 0 || args[0] === '-p') {
        const names = [...state.traps.keys()].sort();
        return ok(joinLines(names.map((name) => `trap -- '${state.traps.get(name)?.action ?? ''}' ${name}`)), state);
    }
    if (args[0] === '-l') {
        const names = signalNames();
        let out = '';
        for (let i = 0; i < names.length; i++) {
            out += `${String(i + 1).padStart(2)}) SIG${names[i]}`;
            out += (i + 1) % 4 === 0 ? '\n' : '\t';
        }
        return ok(out + '\n', state);
    }
    const action = args[0];
    const reset = action === '-';
    const ignore = action === '';
    for (const signal of args.slice(1)) {
        const name = signal.replace(/^SIG/, '');
        if (reset) state.traps.delete(name);
        else state.traps.set(name, { action, reset, ignore });
    }
    return ok();
}

function colonBuiltin(ctx: CommandContext): CommandResult {
    void ctx;
    return { stdout: '', stderr: '', exitCode: 0 };
}

/** The part-2 surface: every builtin this module implements, keyed by name. */
export const COMMANDS: Record<string, ShellCommand> = {
    ':': colonBuiltin,
    '.': (ctx) => sourceBuiltin(ctx, '.'),
    source: (ctx) => sourceBuiltin(ctx, 'source'),
    set: setBuiltin,
    shift: shiftBuiltin,
    unset: unsetBuiltin,
    export: exportBuiltin,
    readonly: readonlyBuiltin,
    local: localBuiltin,
    declare: declareBuiltin,
    typeset: declareBuiltin,
    alias: aliasBuiltin,
    unalias: unaliasBuiltin,
    type: typeBuiltin,
    which: whichBuiltin,
    command: commandBuiltin,
    builtin: builtinBuiltin,
    hash: hashBuiltin,
    help: helpBuiltin,
    env: envBuiltin,
    times: timesBuiltin,
    ulimit: ulimitBuiltin,
    umask: umaskBuiltin,
    getopts: getoptsBuiltin,
    eval: evalBuiltin,
    exec: execBuiltin,
    read: readBuiltin,
    mapfile: mapfileBuiltin,
    readarray: mapfileBuiltin,
    caller: callerBuiltin,
    dirs: dirsBuiltin,
    pushd: pushdBuiltin,
    popd: popdBuiltin,
    jobs: jobsBuiltin,
    fg: fgBuiltin,
    bg: bgBuiltin,
    disown: disownBuiltin,
    suspend: suspendBuiltin,
    wait: waitBuiltin,
    bind: bindBuiltin,
    trap: trapBuiltin,
    let: letBuiltin
};

/* ================================================================== *
 * 9. Creating a state
 * ================================================================== */

/**
 * Creates the state of a fresh shell: `env` becomes its exported variables, and `pid` -- what `$$`
 * reads -- is the pid of the process it belongs to, 1 for a state with no process behind it.
 */
export function createShellState(env: Record<string, string>, cwd: string, fs?: ShellFs, pid = 1): ShellState {
    const globals = new Map<string, ShellVar>();
    for (const [name, value] of Object.entries(env)) globals.set(name, { value, export: true });
    if (!globals.has('PWD')) globals.set('PWD', { value: cwd, export: true });
    if (!globals.has('PATH')) globals.set('PATH', { value: '/bin:/usr/bin', export: true });
    /* IFS is set in every shell a host starts, to space-tab-newline, and is a variable of the shell
       rather than one of its environment: `echo "$IFS"` prints it, `env` does not list it. It is not
       written over a value the caller's environment already gave it. */
    if (!globals.has('IFS')) globals.set('IFS', { value: ' \t\n', export: false });
    /** The table of a state whose host keeps none: `child.ts` leaves its own in `state.host`. */
    const ownJobs: ShellJob[] = [];
    /* The defaults this machine's `/bin/sh` starts with -- bash 3.2 in POSIX mode -- so `set -o`
       and `$-` answer the way they do there: `hashall`, `braceexpand`, `interactive-comments` and
       `posix` are on, `emacs` is *off* (a host's own `set -o` prints `emacs off`), and every other
       option is off besides. */
    const options: ShellOptions = {
        allexport: false,
        braceexpand: true,
        emacs: false,
        errexit: false,
        errtrace: false,
        functrace: false,
        hashall: true,
        histexpand: false,
        history: false,
        ignoreeof: false,
        interactiveComments: true,
        keyword: false,
        monitor: false,
        noclobber: false,
        noexec: false,
        noglob: false,
        nolog: false,
        notify: false,
        nounset: false,
        onecmd: false,
        physical: false,
        pipefail: false,
        posix: true,
        privileged: false,
        verbose: false,
        vi: false,
        xtrace: false,
        interactive: false
    };
    const state: ShellState = {
        scopes: [globals],
        get env(): Record<string, string> {
            const out: Record<string, string> = {};
            for (const scope of this.scopes) {
                for (const [name, variable] of scope) if (variable.export) out[name] = variable.value;
            }
            return out;
        },
        cwd,
        options,
        positional: [],
        shellName: 'sh',
        aliases: new Map(),
        functions: new Map(),
        dirs: [cwd],
        lastStatus: 0,
        pid,
        lastBackgroundPid: 0,
        get jobs(): ShellJob[] {
            const host = this.host as { jobs?: ShellJob[] } | null | undefined;
            return host?.jobs ?? ownJobs;
        },
        optind: 1,
        optchar: 1,
        optarg: '',
        umask: 0o022,
        hash: new Map(),
        traps: new Map(),
        openFds: new Map(),
        stdoutTarget: { kind: 'out' },
        stderrTarget: { kind: 'err' },
        stdinClosed: false,
        callStack: [],
        inputBuffer: '',
        inputCursor: 0,
        execTarget: null,
        protectedDepth: 0,
        io: { stdout: '', stderr: '' },
        held: '',
        line: 1,
        source: '<stdin>'
    };
    if (fs !== undefined) state.fs = fs;
    setVar(state, 'OPTIND', '1');
    return state;
}

/** The host object `child.ts` stores in `state.host`, for hosts that want it back. */
export function hostOf(state: ShellState): unknown {
    return state.host;
}
