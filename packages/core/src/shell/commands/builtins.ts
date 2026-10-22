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

/** Every option `set -o` knows about. */
export interface ShellOptions {
    allexport: boolean;
    errexit: boolean;
    noglob: boolean;
    hashall: boolean;
    monitor: boolean;
    noexec: boolean;
    nounset: boolean;
    verbose: boolean;
    xtrace: boolean;
    ignoreeof: boolean;
    noclobber: boolean;
    pipefail: boolean;
    posix: boolean;
    vi: boolean;
    emacs: boolean;
    interactive: boolean;
    history: boolean;
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
    callStack: CallFrame[];
    /** Free slot for the host: `child.ts` stores its CapabilityContext here for its runner. */
    host?: unknown;
    /** The container file system. Globs, `source` and PATH lookups need it. */
    fs?: ShellFs;
    /** Standard input as `read`, `mapfile` and `cat` see it, plus the read cursor into it. */
    inputBuffer: string;
    inputCursor: number;
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
    if (existing) existing.value = value;
    else scope.set(name, { value });
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

class ArithError extends Error {}

type ArithToken = { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'op'; v: string };

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
                tokens.push({ t: 'num', v: Number.parseInt(text.slice(i + 2, j), 16) });
            } else {
                while (j < text.length && /[0-9]/.test(text[j])) j++;
                const digits = text.slice(i, j);
                const value = digits.length > 1 && digits.startsWith('0') ? Number.parseInt(digits, 8) : Number.parseInt(digits, 10);
                tokens.push({ t: 'num', v: Number.isNaN(value) ? 0 : value });
            }
            i = j;
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            let j = i;
            while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
            tokens.push({ t: 'name', v: text.slice(i, j) });
            i = j;
            continue;
        }
        const three = text.slice(i, i + 3);
        if (three === '<<=' || three === '>>=') {
            tokens.push({ t: 'op', v: three });
            i += 3;
            continue;
        }
        const two = text.slice(i, i + 2);
        if (['**', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='].includes(two)) {
            tokens.push({ t: 'op', v: two });
            i += 2;
            continue;
        }
        if ('+-*/%<>&^|?!~,=()'.includes(ch)) {
            tokens.push({ t: 'op', v: ch });
            i++;
            continue;
        }
        throw new ArithError(`syntax error: invalid arithmetic operator (error token is "${text.slice(i)}")`);
    }
    return tokens;
}

class ArithParser {
    private pos = 0;
    constructor(private readonly tokens: ArithToken[], private readonly state: ShellState) {}

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
            return true;
        }
        return false;
    }

    parse(): number {
        const value = this.comma();
        if (this.pos < this.tokens.length) throw new ArithError('syntax error in arithmetic expression');
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
            const whenTrue = this.comma();
            if (!this.eatOp(':')) throw new ArithError('syntax error: `:` expected');
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
                const right = this.power();
                if (right === 0) throw new ArithError('division by 0');
                left = Math.trunc(left / right);
            } else if (this.eatOp('%')) {
                const right = this.power();
                if (right === 0) throw new ArithError('division by 0');
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
            if (!token || token.t !== 'name') throw new ArithError('syntax error: operand expected');
            const value = arithValueOf(this.state, token.v) + (op === '++' ? 1 : -1);
            setVar(this.state, token.v, String(value));
            return value;
        }
        return this.postfix();
    }

    private postfix(): number {
        const token = this.next();
        if (!token) throw new ArithError('syntax error: operand expected');
        if (token.t === 'num') return token.v;
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
            if (!this.eatOp(')')) throw new ArithError('syntax error: `)` expected');
            return value;
        }
        throw new ArithError(`syntax error: operand expected (error token is "${token.v}")`);
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
    return new ArithParser(arithLex(expression), state).parse();
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
}

interface Assignment {
    name: string;
    append: boolean;
    value: Word;
}

type CommandBody =
    | { t: 'simple'; assigns: Assignment[]; words: Word[]; redirects: Redirect[] }
    | { t: 'if'; branches: { cond: Node[]; body: Node[] }[]; else_?: Node[]; redirects: Redirect[] }
    | { t: 'for'; name: string; words: Word[] | null; body: Node[]; redirects: Redirect[] }
    /** bash's `for ((init; test; next)); do ...; done`: the three expressions are arithmetic. */
    | { t: 'forarith'; expr: string; body: Node[]; redirects: Redirect[] }
    | { t: 'while'; negate: boolean; cond: Node[]; body: Node[]; redirects: Redirect[] }
    | { t: 'case'; word: Word; items: { patterns: Word[]; body: Node[] }[]; redirects: Redirect[] }
    | { t: 'group'; body: Node[]; redirects: Redirect[] }
    | { t: 'subshell'; body: Node[]; redirects: Redirect[] }
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
}

/** Words bash reserves: in command position they end the construct instead of naming a command. */
const RESERVED_WORDS = new Set(['then', 'else', 'elif', 'fi', 'do', 'done', 'esac', 'in', '{', '}', '!']);

class ShellSyntaxError extends Error {
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
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rest)) return { raw, name: rest, op: 'len', arg: '' };
        if (/^[0-9]$/.test(rest)) return { raw, name: rest, op: 'len', arg: '' };
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
    if (cut === -1 && body.includes(':')) {
        // `${x:3}` is a substring; `${x:-3}` is a default -- bash decides on the next character
        const at = body.indexOf(':');
        const after = body[at + 1];
        if (after !== undefined && !'-+=?'.includes(after)) {
            cut = at;
            op = 'substr';
        }
    }
    if (cut > 0) return { raw, name: body.slice(0, cut), op, arg: body.slice(cut + op.length) };
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
            if (this.here() === '\n') this.pos++;
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

    private parseList(terminators: string[]): Node[] {
        const nodes: Node[] = [];
        let pendingOp: '&&' | '||' | null = null;
        for (;;) {
            this.skipSpace(false);
            if (this.eof()) break;
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
        }
        const commands: Command[] = [];
        for (;;) {
            commands.push(this.parseCommand());
            this.skipSpace(false);
            if (this.here() === '|' && this.src[this.pos + 1] !== '|' && this.src[this.pos + 1] !== undefined) {
                this.pos++;
                this.skipSpace(true);
                continue;
            }
            break;
        }
        return { bang, commands, op, source: this.src.slice(start, this.pos).trim() };
    }

    private parseCommand(): Command {
        this.skipSpace(false);
        if (this.eof()) throw new ShellSyntaxError('syntax error: unexpected end of file');
        const line = countLines(this.src, this.pos);
        const ch = this.here();
        if (ch === '(') {
            this.pos++;
            const body = this.parseList([')']);
            this.skipSpace(true);
            if (this.here() !== ')') throw new ShellSyntaxError('syntax error: unexpected end of file');
            this.pos++;
            return { t: 'subshell', body, redirects: this.readRedirects(), line };
        }
        if (ch === '{') {
            this.pos++;
            const body = this.parseList(['}']);
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
        return { ...this.parseSimple(), line };
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
            throw new ShellSyntaxError("syntax error near unexpected token `newline'");
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
            if (!this.keywordAt(this.pos, 'then')) throw new ShellSyntaxError("syntax error: `then' expected");
            this.pos += 4;
            const body = this.parseList(['elif', 'else', 'fi']);
            branches.push({ cond, body });
            this.skipSpace(true);
            if (this.keywordAt(this.pos, 'elif')) {
                this.pos += 4;
                continue;
            }
            if (this.keywordAt(this.pos, 'else')) {
                this.pos += 4;
                elseBody = this.parseList(['fi']);
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
        if (!word) throw new ShellSyntaxError(`syntax error near unexpected token \`${this.here() === '' ? 'newline' : this.here()}'`);
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

    /** `do ... done` and the redirects that follow it: the tail every `for` ends with. */
    private parseForTail(): { body: Node[]; redirects: Redirect[] } {
        this.skipSpace(true);
        if (!this.keywordAt(this.pos, 'do')) throw new ShellSyntaxError("syntax error: `do' expected");
        this.pos += 2;
        const body = this.parseList(['done']);
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
        if (!this.keywordAt(this.pos, 'do')) throw new ShellSyntaxError("syntax error: `do' expected");
        this.pos += 2;
        const body = this.parseList(['done']);
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
        if (!this.keywordAt(this.pos, 'in')) throw new ShellSyntaxError("syntax error: `in' expected");
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

function optionFlags(state: ShellState): string {
    let out = '';
    if (state.options.allexport) out += 'a';
    if (state.options.errexit) out += 'e';
    if (state.options.noglob) out += 'f';
    if (state.options.hashall) out += 'h';
    if (state.options.monitor) out += 'm';
    if (state.options.noexec) out += 'n';
    if (state.options.nounset) out += 'u';
    if (state.options.verbose) out += 'v';
    if (state.options.xtrace) out += 'x';
    if (state.options.noclobber) out += 'C';
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
            /* Tilde expansion is the first expansion a word gets, and only where the word opens with
               an unquoted `~`: `echo ~` is the home directory, `echo a~b` and `echo "~"` are not. */
            if (index === 0 && !quoted && target.text.length === 0) {
                appendText(target, expandTilde(part.v, state), quoted, false);
                continue;
            }
            /* Literal text is never field-split: only what an expansion produced is. */
            appendText(target, part.v, quoted, false);
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
            const value = evalArith(state, expandToString(arithText(part.expr), state));
            appendText(target, String(Math.trunc(value)), quoted);
            continue;
        }
        if (part.t === 'cmd') {
            appendText(target, runSubstitution(state, part.script), quoted);
            continue;
        }
        const ref = part.ref;
        if (quoted && ref.op === '' && (ref.name === '@' || ref.name === '*')) {
            for (let i = 0; i < state.positional.length; i++) {
                if (i > 0) appendText(target, ref.name === '*' ? ifsJoiner(state) : FIELD_MARK, true);
                appendText(target, state.positional[i], true);
            }
            continue;
        }
        const name = ref.name;
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

/** Expands a word the way a command argument is expanded: splitting, then pathname expansion. */
function expandWord(state: ShellState, word: Word): string[] {
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

/** Parses and runs a whole script, and reports one that failed the way a shell reports it. */
function runParsed(state: ShellState, script: string): number {
    try {
        const nodes = new Parser(script, state).parse();
        return runCommandList(state, nodes, null);
    } catch (error) {
        if (error instanceof ExitSignal) return error.code;
        if (error instanceof ReturnSignal) return error.code;
        if (error instanceof ShellSyntaxError) {
            /* The message, and then the line it came from, echoed in backquotes the way a host
               handed a script with `-c` echoes it: `/bin/sh: -c: line 0: syntax error near
               unexpected token `)'` followed by the script that would not parse. */
            writeErr(state, `${error.message}\n`);
            writeErr(state, `\`${script}'\n`);
            return 2;
        }
        if (error instanceof UnsetVariableError) {
            writeErr(state, `${error.message}\n`);
            return 127;
        }
        writeErr(state, `${errorMessage(error)}\n`);
        return 1;
    }
}

/** The front door: parses and runs a whole script. */
export function runScript(state: ShellState, script: string): { stdout: string; stderr: string; exitCode: number } {
    state.io = { stdout: '', stderr: '' };
    const exitCode = runParsed(state, script);
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
function startBackgroundNode(state: ShellState, node: Node): number | null {
    const source = node.source;
    if (source === undefined || source === '' || state.startJob === undefined) return null;
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
    let status = statuses.length > 0 ? statuses[statuses.length - 1] : 0;
    if (state.options.pipefail) {
        const failed = statuses.find((entry) => entry !== 0);
        if (failed !== undefined) status = failed;
    }
    if (node.bang) status = status === 0 ? 1 : 0;
    return status;
}

/**
 * Redirections on a compound command: the file becomes the input of the whole construct, and the
 * construct's output is written to the file afterwards, as a shell does.
 */
function runCompoundRedirected(state: ShellState, command: Command, input: string | null, body: () => number): number {
    const redirects = (command as { redirects?: Redirect[] }).redirects ?? [];
    const plan = planRedirects(state, redirects);
    const fromFile = plan.inputFile !== undefined;
    const needsInput = fromFile || plan.inputText !== undefined || input !== null;
    const needsOutput = plan.stdoutTo.kind !== 'out' || plan.stderrTo.kind !== 'err';
    if (!needsInput && !needsOutput) return body();
    const savedBuffer = state.inputBuffer;
    const savedCursor = state.inputCursor;
    if (needsInput) {
        state.inputBuffer = fromFile
            ? readInputFile(state, plan.inputFile as string)
            : plan.inputText ?? (input as string);
        state.inputCursor = 0;
    }
    const savedIo = state.io;
    state.io = { stdout: '', stderr: '' };
    let status = 0;
    try {
        status = body();
    } finally {
        const captured = state.io;
        state.io = savedIo;
        if (needsInput) {
            state.inputBuffer = savedBuffer;
            state.inputCursor = savedCursor;
        }
        finish(state, plan, captured.stdout, captured.stderr, status);
    }
    return status;
}

function runCommand(state: ShellState, command: Command, input: string | null): number {
    state.line = command.line;
    switch (command.t) {
        case 'simple':
            return runSimple(state, command, input);
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
    /** The message of a descriptor nothing opened, which a host reports before running anything. */
    error?: string;
}

/**
 * Where one of the two standard descriptors goes, in the shape the plan carries -- and where a
 * descriptor `exec` opened points, which is the same shape: the shell's own output or error, a
 * file opened for writing (`append` once a write through it has moved its offset) or for reading,
 * or nothing at all because it was closed.
 */
type StreamTarget = { kind: 'out' | 'err' | 'file' | 'null' | 'input'; file?: string; append?: boolean };

/**
 * Where `n>&m`, `n<&m` and `n>&-` point: the destination the named descriptor has *now*, the
 * shell's own output or error for `1` and `2`, or nothing at all for `-`.
 *
 * Undefined for a descriptor number nothing opened, which a host names and fails the command with
 * before it runs: `echo hi >&9` is `sh: 9: Bad file descriptor`, and the command never runs.
 */
function duplicateOf(
    plan: RedirectPlan,
    target: string,
    stdoutTo: StreamTarget = plan.stdoutTo,
    stderrTo: StreamTarget = plan.stderrTo
): StreamTarget | undefined {
    if (target === '-') return { kind: 'null' };
    if (target === '1') return { ...stdoutTo };
    if (target === '2') return { ...stderrTo };
    if (!/^[0-9]+$/.test(target)) return { kind: 'file', file: target, append: false };
    const opened = plan.fds.get(Number.parseInt(target, 10));
    return opened === undefined ? undefined : { ...opened };
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
        opened: [],
        fds: new Map([...state.openFds].map(([fd, entry]) => [fd, { ...entry }]))
    };
    const fds = new Map(state.openFds);
    let stdoutTo: StreamTarget = { ...state.stdoutTarget };
    let stderrTo: StreamTarget = { ...state.stderrTarget };
    const setFd = (fd: number, entry: StreamTarget): void => {
        if (fd === 1) stdoutTo = entry;
        else if (fd === 2) stderrTo = entry;
        else if (entry.kind === 'null') fds.delete(fd);
        else fds.set(fd, entry);
    };
    for (const redirect of redirects) {
        const target = expandToString(redirect.target, state);
        switch (redirect.op) {
            case '>':
            case '>>':
                setFd(redirect.fd, { kind: 'file', file: target, append: redirect.op === '>>' });
                break;
            case '<':
                /* A descriptor above 2 opened for reading: `exec 3<f; cat <&3` reads `f`. The
                   standard input itself is the text the shell was handed, which no file replaces. */
                if (redirect.fd >= 3) setFd(redirect.fd, { kind: 'input', file: target });
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
        stdoutTo: { ...state.stdoutTarget },
        stderrTo: { ...state.stderrTarget },
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
                    plan.opened.push({ fd: redirect.fd, file: target, append: redirect.op === '>>' });
                }
                break;
            case '<':
                /* A descriptor above 2 opened for reading is one only `>&n` and `<&n` name: `cat
                   3<f` reads the shell's own input, not `f`, as it does on a host. */
                if (redirect.fd >= 3) plan.fds.set(redirect.fd, { kind: 'input', file: target });
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
                    const opened = plan.fds.get(Number.parseInt(target, 10));
                    if (opened === undefined) {
                        if (plan.error === undefined) plan.error = `${state.shellName}: ${target}: Bad file descriptor\n`;
                        break;
                    }
                    if (redirect.fd >= 3) plan.fds.set(redirect.fd, { ...opened });
                    else if (opened.kind === 'file' || opened.kind === 'input') plan.inputFile = opened.file;
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
    return fs.readFile(path) ?? '';
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
        throw new Error(`Failed to redirect to ${file}: ${errorMessage(error)}`);
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
        if (plan.stdoutTo.kind === 'null') {
            /* A write to a descriptor `>&-` closed: the text reaches the shell anyway -- a host's
               own write is held in its buffer, which is flushed once the descriptor is put back --
               and the write is still the failure it was, reported with the status a host gives the
               command that made it. `true >&-` writes nothing and keeps its own status. */
            if (stdout !== '' && name !== undefined) {
                writeOut(state, stdout);
                writeErr(state, `${diagnosticPrefix(state)}${name}: write error: Bad file descriptor\n`);
                exitCode = 1;
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
    const pending: { name: string; value: string }[] = [];
    for (const assign of command.assigns) pending.push({ name: assign.name, value: expandAssignment(state, assign) });

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
            state.exitCalled = true;
            const undone = planRedirects(state, command.redirects);
            undone.error = undefined;
            finish(state, undone, '', '', 1, 'exec');
            return throwExit(1);
        }
    }

    const plan = planRedirects(state, command.redirects);
    const commandInput = plan.inputText !== undefined
        ? plan.inputText
        : plan.inputFile !== undefined ? readInputFile(state, plan.inputFile) : input;
    /**
     * What a command with no input of its own reads: the rest of the input of the compound command
     * it stands in. `runCompoundRedirected` put that input in `state.inputBuffer` for the whole
     * construct, and `read` and `mapfile` take it from there, a line at a time, through the cursor;
     * this is the same text for the commands that read their standard input in one go -- `cat`,
     * `wc`, `head` -- which is why `echo hi | if true; then cat; fi` prints the line `echo` wrote.
     * The buffer is not rewinded for them: the cursor stays where the commands before left it.
     */
    const shared = state.inputCursor < state.inputBuffer.length ? state.inputBuffer.slice(state.inputCursor) : '';
    const stdin = commandInput ?? (shared === '' ? null : shared);

    if (words.length === 0) {
        /* An assignment with no command behind it is the substitution it carries: `x=$(false)` is 1
           and `x=$(exit 5)` is 5, the status the subshell ended with, and it is what makes `set -e`
           end the line -- a substitution whose own `set -e` stopped it early leaves that status too. */
        const status = substitutionStatus;
        for (const entry of pending) {
            if (!setVar(state, entry.name, entry.value)) {
                return finish(state, plan, '', `${entry.name}: readonly variable\n`, 1);
            }
            if (state.options.allexport) markExported(state, entry.name);
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
            writeErr(state, `return: can only 'return' from a function or sourced script\n`);
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
            for (const entry of pending) setVar(state, entry.name, entry.value);
            const status = callFunction(state, fn, args);
            for (const entry of pending) setVar(state, entry.name, entry.value);
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
            }
            for (const entry of pending) setVar(state, entry.name, entry.value);
            syncPwd(state);
            return finish(state, plan, result.stdout, result.stderr, result.exitCode, name);
        }

        const step = RUNNER(state, words, stdin);
        for (const entry of pending) setVar(state, entry.name, entry.value);
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
    if (variable.readonly) return `declare -r${variable.export ? 'x' : ''} ${name}=${quoteDouble(variable.value)}`;
    if (variable.export) return `declare -x ${name}=${quoteDouble(variable.value)}`;
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
    if (COMMANDS[name] !== undefined || HOST_BUILTINS.has(name)) return `${name} is a shell builtin`;
    if (state.functions.has(name)) {
        const def = state.functions.get(name) as FunctionDef;
        return `${name} is a function\n${name} () \n{ \n${functionBody(def)}\n}`;
    }
    const path = findOnPath(state, name);
    if (path !== undefined) return `${name} is ${path}`;
    const fs = state.fs;
    if (fs && fs.fileExists(resolvePath(state, name))) return `${name} is ${resolvePath(state, name)}`;
    return '';
}

const OPTION_NAMES: [keyof ShellOptions, string][] = [
    ['allexport', 'allexport'],
    ['errexit', 'errexit'],
    ['noglob', 'noglob'],
    ['hashall', 'hashall'],
    ['monitor', 'monitor'],
    ['noexec', 'noexec'],
    ['nounset', 'nounset'],
    ['verbose', 'verbose'],
    ['xtrace', 'xtrace'],
    ['ignoreeof', 'ignoreeof'],
    ['noclobber', 'noclobber'],
    ['pipefail', 'pipefail'],
    ['posix', 'posix'],
    ['vi', 'vi'],
    ['emacs', 'emacs'],
    ['interactive', 'interactive'],
    ['history', 'history']
];

const SHORT_OPTIONS: Record<string, keyof ShellOptions> = {
    a: 'allexport',
    e: 'errexit',
    f: 'noglob',
    h: 'hashall',
    m: 'monitor',
    n: 'noexec',
    u: 'nounset',
    v: 'verbose',
    x: 'xtrace',
    C: 'noclobber'
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
                    const lines = OPTION_NAMES.map(([key, name]) => `${name.padEnd(14)}${state.options[key] ? 'on' : 'off'}`);
                    return ok(joinLines(lines), state);
                }
                const entry = OPTION_NAMES.find(([, name]) => name === next);
                if (!entry) return failLine(`set: ${next}: invalid option name`, 2);
                state.options[entry[0]] = enable;
                index += 2;
                continue;
            }
            if (body.startsWith('o') && body.length > 1) {
                const name = body.slice(1);
                const entry = OPTION_NAMES.find(([, option]) => option === name);
                if (!entry) return failLine(`set: ${name}: invalid option name`, 2);
                state.options[entry[0]] = enable;
                index++;
                continue;
            }
            for (const ch of body) {
                const key = SHORT_OPTIONS[ch];
                if (!key) return failLine(`set: -${ch}: invalid option`, 2);
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
    for (const arg of ctx.args) {
        const assign = splitAssign(arg);
        if (!assign) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) return failLine(`export: \`${arg}': not a valid identifier`, 1);
            markExported(state, arg);
            continue;
        }
        const base = assign.append ? getVar(state, assign.name) ?? '' : '';
        setVar(state, assign.name, base + (assign.value ?? ''));
        markExported(state, assign.name);
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
        const assign = splitAssign(arg);
        if (!assign) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) return failLine(`readonly: \`${arg}': not a valid identifier`, 1);
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
        else return failLine(`declare: ${flag}: invalid option`, 2);
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
        if (!/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?$/.test(name)) return failLine(`declare: \`${arg}': not a valid identifier`, 1);
        const scope = state.scopes.length > 1 && !global ? state.scopes[state.scopes.length - 1] : state.scopes[0];
        if (assign) {
            const base = assign.append ? getVar(state, name) ?? '' : '';
            const value = base + (assign.value ?? '');
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
    }
    return ok();
}

function localBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    if (state.scopes.length <= 1) return failLine('local: can only be used in a function', 1);
    const scope = state.scopes[state.scopes.length - 1];
    if (ctx.args.length === 0) {
        return ok(joinLines([...scope.keys()].sort().map((name) => declarePrint(name, scope.get(name) ?? { value: '' }))), state);
    }
    for (const arg of ctx.args) {
        const assign = splitAssign(arg);
        if (!assign) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) return failLine(`local: \`${arg}': not a valid identifier`, 1);
            scope.set(arg, { value: '' });
            continue;
        }
        const base = assign.append ? getVar(state, assign.name) ?? '' : '';
        scope.set(assign.name, { value: base + (assign.value ?? '') });
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
        if (arg.startsWith('-')) return failLine(`unset: \`${arg}': invalid option`, 2);
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
            writeErr(state, `unset: ${arg}: cannot unset: readonly variable\n`);
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
    if (Number.isNaN(count) || count < 0) return failLine(`shift: ${ctx.args[0]}: numeric argument required`, 1);
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
            if (value === undefined) return failLine(`alias: ${arg}: not found`, 1);
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
            writeErr(state, `unalias: ${arg}: not found\n`);
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
        const text = describeName(state, name);
        if (text === '') {
            writeErr(state, `type: ${name}: not found\n`);
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
        const text = describeName(state, name);
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
        return failLine(`builtin: ${name}: not a shell builtin`, 1);
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
    for (const arg of ctx.args) {
        if (arg === '-r') {
            state.hash.clear();
            continue;
        }
        if (arg.startsWith('-')) continue;
        const path = findOnPath(state, arg);
        if (path === undefined) {
            writeErr(state, `hash: ${arg}: not found\n`);
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
    if (!entry) return failLine(`ulimit: ${flag}: invalid option`, 2);
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
        if (!/^[0-7]+$/.test(value)) return failLine(`/bin/sh: line 0: umask: ${value}: octal number out of range`, 1);
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
        return failLine(`/bin/sh: line 0: umask: \`${bad === null ? ' ' : bad[0]}': invalid symbolic mode operator`, 1);
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
    if (spec === undefined || name === undefined) return failLine('getopts: usage: getopts optstring name [arg ...]', 2);
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
            if (!silent) writeErr(state, `illegal option -- ${letter}\n`);
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
                if (!silent) writeErr(state, `option requires an argument -- ${letter}\n`);
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

function sourceBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    if (ctx.args.length === 0) return failLine('source: filename argument required', 2);
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
        writeErr(state, step.stderr);
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
    if (Number.isNaN(depth)) return failLine(`caller: ${ctx.args[0]}: invalid number`, 1);
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
        if (state.dirs.length < 2) return failLine('pushd: no other directory', 1);
        const first = state.dirs[0];
        state.dirs[0] = state.dirs[1];
        state.dirs[1] = first;
        state.cwd = state.dirs[0];
        syncPwd(state);
        return ok(state.dirs.map((dir) => abbreviateHome(state, dir)).join(' ') + '\n', state);
    }
    const next = resolvePath(state, target);
    const fs = state.fs;
    if (fs && !fs.isDirectory(next)) return failLine(`pushd: ${target}: No such file or directory`, 1);
    state.dirs.unshift(next);
    state.cwd = next;
    syncPwd(state);
    return ok(state.dirs.map((dir) => abbreviateHome(state, dir)).join(' ') + '\n', state);
}

function popdBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    if (state.dirs.length <= 1) return failLine('popd: directory stack empty', 1);
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
        else if (arg.length > 1 && arg.startsWith('-')) return failLine(`jobs: ${arg}: invalid option`, 2);
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
    void ctx;
    return failLine('suspend: cannot suspend a shell that has no job control', 1);
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
    void ctx;
    return failLine('bind: line editing is not supported in this shell', 1);
}

function letBuiltin(ctx: CommandContext): CommandResult {
    const state = stateOf(ctx);
    if (ctx.args.length === 0) return failLine('let: requires arguments', 1);
    let value = 0;
    try {
        for (const arg of ctx.args) value = evalArith(state, arg);
    } catch (error) {
        return failLine(`let: ${errorMessage(error)}`, 1);
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
    '.': sourceBuiltin,
    source: sourceBuiltin,
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
    const options: ShellOptions = {
        allexport: false,
        errexit: false,
        noglob: false,
        hashall: true,
        monitor: false,
        noexec: false,
        nounset: false,
        verbose: false,
        xtrace: false,
        ignoreeof: false,
        noclobber: false,
        pipefail: false,
        posix: false,
        vi: false,
        emacs: true,
        interactive: false,
        history: false
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
        callStack: [],
        inputBuffer: '',
        inputCursor: 0,
        execTarget: null,
        protectedDepth: 0,
        io: { stdout: '', stderr: '' },
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
