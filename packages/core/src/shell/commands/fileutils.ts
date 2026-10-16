/**
 * File and text inspection utilities for the OWC guest shell.
 *
 * Every command here is a synchronous handler: it reads and writes through the virtual file
 * system handed to it in the context and never spawns a child. The module exports one record,
 * `COMMANDS`, which the shell's dispatcher consults before falling back to a spawned process.
 *
 * The virtual file system (see filesystem/types.ts) carries no owner, permission, inode or link
 * metadata, so this module keeps a per-file-system side table for the mode, owner, symlink target
 * and inode number that `chmod`, `chown`, `ln`, `link`, `stat` and `find -type l` need. The table
 * lives in a WeakMap keyed by the file system object, so two containers never share it and it is
 * dropped with the container.
 *
 * Where BSD (the measured host) and GNU disagree, this module follows POSIX where POSIX speaks and
 * the host otherwise; every such choice is recorded in the delivery manifest.
 */
import type { CommandContext, CommandResult, ShellCommand } from './types';
import { atPath, inputText } from './types';

/** The file system as the context hands it to a command. */
type Fs = CommandContext['fs'];

/* ------------------------------------------------------------------ results */

function ok(stdout = ''): CommandResult {
    return { stdout, stderr: '', exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): CommandResult {
    if (stderr === '') return { stdout: '', stderr: '', exitCode };
    return { stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', exitCode };
}

function result(stdout: string, stderr: string, exitCode: number): CommandResult {
    return { stdout, stderr, exitCode };
}

/* -------------------------------------------------------------------- paths */

/** Collapses `//`, `.` and `..` in an absolute path. `..` at the root stays at the root. */
function clean(path: string): string {
    const out: string[] = [];
    for (const part of path.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (out.length > 0) out.pop();
            continue;
        }
        out.push(part);
    }
    return '/' + out.join('/');
}

/**
 * Resolves a path argument against the shell's directory.
 *
 * `atPath` alone is not enough: the file system's `normalizePath` turns `sub` into `/sub` and `.`
 * into `/`, so a relative argument would escape the working directory. Absolute paths go through
 * `atPath` as before; relative ones are joined here and cleaned.
 */
function resolveAt(ctx: CommandContext, path: string): string {
    if (path.startsWith('/')) return atPath(ctx, path);
    return clean(ctx.cwd + '/' + path);
}

/** Joins a parent and one entry name. */
function joinPath(base: string, name: string): string {
    return base === '/' ? '/' + name : base + '/' + name;
}

/** The parent of a path; the parent of `/a` is `/`. */
function parentOf(path: string): string {
    const at = path.lastIndexOf('/');
    return at <= 0 ? '/' : path.slice(0, at);
}

/** Byte-order comparison, so listings do not depend on the host locale. */
function cmpStr(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** A path that starts with `-`, for the utilities that accept `--` before their operands. */
function isOption(word: string): boolean {
    return word.length > 1 && word[0] === '-';
}

/* --------------------------------------------------------- metadata side table */

interface Owner {
    uid: number;
    gid: number;
}

interface Meta {
    /** Permission and special bits (12 bits) that `chmod` set, keyed by normalized path. */
    modes: Map<string, number>;
    /** Owner that `chown` set. */
    owners: Map<string, Owner>;
    /** Symlink target, for paths `ln -s` created. */
    links: Map<string, string>;
    /** The synthetic inode number of a path. */
    inodes: Map<string, number>;
    /** How many paths share an inode, which is what `link` and `ln` do. */
    nlink: Map<number, number>;
    nextInode: number;
}

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
const DEFAULT_OWNER: Owner = { uid: 0, gid: 0 };

const METAS = new WeakMap<object, Meta>();

function metaOf(fs: Fs): Meta {
    let meta = METAS.get(fs as unknown as object);
    if (meta === undefined) {
        meta = {
            modes: new Map(),
            owners: new Map(),
            links: new Map(),
            inodes: new Map(),
            nlink: new Map(),
            nextInode: 10
        };
        METAS.set(fs as unknown as object, meta);
    }
    return meta;
}

function modeOf(fs: Fs, path: string, isDir: boolean): number {
    const key = clean(path);
    const meta = metaOf(fs);
    const stored = meta.modes.get(key);
    if (stored !== undefined) return stored;
    // a symlink reports 755 on the host, which is what `ln -s` leaves behind
    if (meta.links.has(key)) return 0o755;
    return isDir ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE;
}

function setMode(fs: Fs, path: string, mode: number): void {
    metaOf(fs).modes.set(clean(path), mode & 0o7777);
}

function ownerOf(fs: Fs, path: string): Owner {
    return metaOf(fs).owners.get(clean(path)) ?? DEFAULT_OWNER;
}

function setOwner(fs: Fs, path: string, owner: Owner): void {
    metaOf(fs).owners.set(clean(path), owner);
}

function linkTarget(fs: Fs, path: string): string | undefined {
    return metaOf(fs).links.get(clean(path));
}

function isSymlink(fs: Fs, path: string): boolean {
    return metaOf(fs).links.has(clean(path));
}

function inodeOf(fs: Fs, path: string): number {
    const meta = metaOf(fs);
    const key = clean(path);
    const existing = meta.inodes.get(key);
    if (existing !== undefined) return existing;
    const next = meta.nextInode++;
    meta.inodes.set(key, next);
    meta.nlink.set(next, (meta.nlink.get(next) ?? 0) + 1);
    return next;
}

function linksOf(fs: Fs, path: string): number {
    const meta = metaOf(fs);
    const inode = meta.inodes.get(clean(path));
    if (inode === undefined) return 1;
    return meta.nlink.get(inode) ?? 1;
}

/** Makes two paths share one inode, which is what a hard link is. Returns the inode. */
function shareInode(fs: Fs, a: string, b: string): void {
    const meta = metaOf(fs);
    const inode = inodeOf(fs, a);
    const keyB = clean(b);
    const previous = meta.inodes.get(keyB);
    if (previous !== undefined) {
        const count = (meta.nlink.get(previous) ?? 1) - 1;
        if (count > 0) meta.nlink.set(previous, count);
        else meta.nlink.delete(previous);
    }
    meta.inodes.set(keyB, inode);
    meta.nlink.set(inode, (meta.nlink.get(inode) ?? 0) + 1);
}

/** Forgets everything recorded about a path, for the utilities that remove it. */
function dropMeta(fs: Fs, path: string): void {
    const meta = metaOf(fs);
    const key = clean(path);
    meta.modes.delete(key);
    meta.owners.delete(key);
    meta.links.delete(key);
    const inode = meta.inodes.get(key);
    if (inode !== undefined) {
        const count = (meta.nlink.get(inode) ?? 1) - 1;
        if (count > 0) meta.nlink.set(inode, count);
        else meta.nlink.delete(inode);
        meta.inodes.delete(key);
    }
}

/* -------------------------------------------------------- file system helpers */

interface Entry {
    /** Absolute, normalized path. */
    path: string;
    /** The path as the caller wrote it, which is what `find` and `du` print. */
    shown: string;
    depth: number;
    type: 'file' | 'dir';
    size: number;
    mtimeMs: number;
}

function statOf(fs: Fs, path: string): Entry | undefined {
    let stat;
    try {
        stat = fs.statPath(path);
    } catch {
        return undefined;
    }
    if (stat === undefined) return undefined;
    return {
        path,
        shown: path,
        depth: 0,
        type: stat.type,
        size: stat.size,
        mtimeMs: stat.mtimeMs
    };
}

/**
 * Reads a file. The file system throws for a path that is not there, and every caller here wants
 * `undefined` instead, so the throw is caught once.
 */
function readFileOrNone(fs: Fs, path: string): string | undefined {
    try {
        return fs.readFile(path);
    } catch {
        return undefined;
    }
}

function isDir(fs: Fs, path: string): boolean {
    try {
        return fs.isDirectory(path);
    } catch {
        return false;
    }
}

function exists(fs: Fs, path: string): boolean {
    try {
        return fs.fileExists(path) || fs.isDirectory(path);
    } catch {
        return false;
    }
}

/** The entries of a directory, sorted so that a walk is reproducible. */
function dirEntries(fs: Fs, path: string): string[] {
    let names: string[] | undefined;
    try {
        names = fs.readdirNames(path);
    } catch {
        names = undefined;
    }
    if (names === undefined) {
        try {
            names = fs.listDirectory(path);
        } catch {
            return [];
        }
    }
    const out: string[] = [];
    for (const name of names) {
        const trimmed = name.replace(/\/+$/, '');
        if (trimmed !== '' && trimmed !== '.' && trimmed !== '..') out.push(trimmed);
    }
    return out.sort(cmpStr);
}

/**
 * Walks one root. `-maxdepth` prunes the descent; the list is in pre-order, and the entries of a
 * directory come before the entries of its subdirectories.
 */
function walkRoot(
    fs: Fs,
    root: string,
    shownRoot: string,
    maxDepth: number
): { entries: Entry[]; missing: boolean } {
    const entries: Entry[] = [];
    const first = statOf(fs, root);
    if (first === undefined) return { entries, missing: true };
    const stack: { path: string; shown: string; depth: number; type: 'file' | 'dir' }[] = [
        { path: root, shown: shownRoot, depth: 0, type: first.type }
    ];
    while (stack.length > 0) {
        const node = stack.pop() as { path: string; shown: string; depth: number; type: 'file' | 'dir' };
        const stat = statOf(fs, node.path);
        if (stat === undefined) continue;
        entries.push({
            path: node.path,
            shown: node.shown,
            depth: node.depth,
            type: stat.type,
            size: stat.size,
            mtimeMs: stat.mtimeMs
        });
        if (stat.type !== 'dir' || node.depth >= maxDepth) continue;
        const children = dirEntries(fs, node.path);
        for (let i = children.length - 1; i >= 0; i--) {
            stack.push({
                path: joinPath(node.path, children[i]),
                shown: node.shown === '/' ? '/' + children[i] : node.shown + '/' + children[i],
                depth: node.depth + 1,
                type: 'file'
            });
        }
    }
    return { entries, missing: false };
}

/** Every path under a root, deepest first, which is the order `-delete` needs. */
function walkBottomUp(fs: Fs, root: string, shownRoot: string): { entries: Entry[]; missing: boolean } {
    const walked = walkRoot(fs, root, shownRoot, Number.MAX_SAFE_INTEGER);
    return { entries: walked.entries.slice().reverse(), missing: walked.missing };
}

/* ------------------------------------------------------------------ safety */

/**
 * The paths `-delete` and `-exec` refuse to act on: the file system root, and the container root
 * when the shell publishes one. Everything else is fair game.
 */
function containerRoot(env: Record<string, string>): string {
    const published = env.OWC_CONTAINER_ROOT;
    return published !== undefined && published !== '' ? clean(published) : '/';
}

function isProtected(path: string, env: Record<string, string>): boolean {
    const normalized = clean(path);
    return normalized === '/' || normalized === containerRoot(env);
}

/** Utilities that destroy or overwrite what they are pointed at. */
const DESTRUCTIVE = new Set([
    'rm',
    'rmdir',
    'mv',
    'unlink',
    'install',
    'dd',
    'truncate',
    'shred',
    'find',
    'chmod',
    'chown'
]);

/* ------------------------------------------------------- running a utility */

/**
 * `-exec` and `xargs` must run something, and a synchronous handler cannot spawn a child, so they
 * run the shell's own command table: the utilities in this module, plus the built-ins below.
 */
type Runner = (ctx: CommandContext) => CommandResult;

const BUILTINS: Record<string, Runner> = {
    echo: (ctx) => ok(ctx.args.join(' ') + '\n'),
    true: () => ok(),
    false: () => fail('', 1),
    ':': () => ok(),
    pwd: (ctx) => ok(ctx.cwd + '\n'),
    cat: (ctx) => {
        if (ctx.args.length === 0) return ok(ctx.input ?? '');
        try {
            return ok(inputText(ctx).map((entry) => entry.text).join(''));
        } catch (error) {
            return fail(message(error));
        }
    },
    ls: (ctx) => {
        const target = ctx.args.find((arg) => !isOption(arg)) ?? ctx.cwd;
        const path = resolveAt(ctx, target);
        if (!exists(ctx.fs, path)) return fail(`ls: ${target}: No such file or directory`);
        if (!isDir(ctx.fs, path)) return ok(target + '\n');
        const names = dirEntries(ctx.fs, path);
        return ok(names.length > 0 ? names.join('\n') + '\n' : '');
    },
    mkdir: (ctx) => {
        const targets = ctx.args.filter((arg) => !isOption(arg));
        if (targets.length === 0) return fail('mkdir: No directory specified');
        for (const target of targets) {
            try {
                ctx.fs.createDirectory(resolveAt(ctx, target));
            } catch (error) {
                return fail(`mkdir: ${target}: ${message(error)}`);
            }
        }
        return ok();
    },
    rmdir: (ctx) => {
        const targets = ctx.args.filter((arg) => !isOption(arg));
        if (targets.length === 0) return fail('rmdir: No directory specified');
        for (const target of targets) {
            const path = resolveAt(ctx, target);
            if (!isDir(ctx.fs, path)) return fail(`rmdir: ${target}: Not a directory`);
            try {
                ctx.fs.deleteDirectory(path);
            } catch (error) {
                return fail(`rmdir: ${target}: ${message(error)}`);
            }
        }
        return ok();
    },
    rm: (ctx) => {
        const targets = ctx.args.filter((arg) => !isOption(arg));
        if (targets.length === 0) return fail('rm: No file specified');
        const recursive = ctx.args.some((arg) => arg === '-r' || arg === '-R' || arg === '-rf' || arg === '-fr');
        for (const target of targets) {
            const path = resolveAt(ctx, target);
            if (isProtected(path, ctx.env)) return fail(`rm: refusing to remove ${target}`);
            if (!exists(ctx.fs, path)) {
                if (ctx.args.includes('-f')) continue;
                return fail(`rm: ${target}: No such file or directory`);
            }
            if (isDir(ctx.fs, path) && !recursive) return fail(`rm: ${target}: is a directory`);
            try {
                ctx.fs.removePath(path, recursive);
                dropMeta(ctx.fs, path);
            } catch (error) {
                return fail(`rm: ${target}: ${message(error)}`);
            }
        }
        return ok();
    },
    touch: (ctx) => {
        const targets = ctx.args.filter((arg) => !isOption(arg));
        if (targets.length === 0) return fail('touch: No file specified');
        for (const target of targets) {
            const path = resolveAt(ctx, target);
            if (!exists(ctx.fs, path)) {
                try {
                    ctx.fs.writeFile(path, '');
                } catch (error) {
                    return fail(`touch: ${target}: ${message(error)}`);
                }
            }
        }
        return ok();
    },
    cp: (ctx) => copyOrMove(ctx, false),
    mv: (ctx) => copyOrMove(ctx, true)
};

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function copyOrMove(ctx: CommandContext, move: boolean): CommandResult {
    const name = move ? 'mv' : 'cp';
    const operands = ctx.args.filter((arg) => !isOption(arg));
    if (operands.length < 2) return fail(`${name}: Source and destination required`);
    const destArg = operands[operands.length - 1];
    const destPath = resolveAt(ctx, destArg);
    if (move && isProtected(destPath, ctx.env)) return fail(`${name}: refusing to act on ${destArg}`);
    const intoDir = isDir(ctx.fs, destPath);
    for (const source of operands.slice(0, -1)) {
        const sourcePath = resolveAt(ctx, source);
        const content = readFileOrNone(ctx.fs, sourcePath);
        if (content === undefined) return fail(`${name}: ${source}: No such file or directory`);
        const target = intoDir ? joinPath(destPath, source.split('/').pop() as string) : destPath;
        try {
            ctx.fs.writeFile(target, content);
            if (move) {
                ctx.fs.removePath(sourcePath, false);
                dropMeta(ctx.fs, sourcePath);
            }
        } catch (error) {
            return fail(`${name}: ${message(error)}`);
        }
    }
    return ok();
}

/** One utility invocation: this module's commands first, then the built-ins. */
function runUtility(
    ctx: CommandContext,
    name: string,
    args: string[]
): { stdout: string; stderr: string; exitCode: number } | undefined {
    const own = COMMANDS[name];
    if (own !== undefined) {
        const out = own({ args, cwd: ctx.cwd, env: ctx.env, input: null, fs: ctx.fs });
        return { stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode };
    }
    const builtin = BUILTINS[name];
    if (builtin !== undefined) {
        const out = builtin({ args, cwd: ctx.cwd, env: ctx.env, input: null, fs: ctx.fs });
        return { stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode };
    }
    // `/bin/echo` and friends name a utility the host has and the container does not; the container
    // answers with the command of the same name, which is what a script ported from a host expects.
    if (name.indexOf('/') >= 0) {
        const bare = name.split('/').pop() as string;
        if (COMMANDS[bare] !== undefined) {
            const out = (COMMANDS[bare] as ShellCommand)({ args, cwd: ctx.cwd, env: ctx.env, input: null, fs: ctx.fs });
            return { stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode };
        }
        if (BUILTINS[bare] !== undefined) {
            const out = (BUILTINS[bare] as Runner)({ args, cwd: ctx.cwd, env: ctx.env, input: null, fs: ctx.fs });
            return { stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode };
        }
    }
    return undefined;
}

function notFound(utility: string, name: string): CommandResult {
    return fail(`${utility}: ${name}: No such file or directory`, 127);
}

/* --------------------------------------------------------------------- find */

type Predicate =
    | { kind: 'name'; pattern: string; ignoreCase: boolean }
    | { kind: 'path'; pattern: string; ignoreCase: boolean }
    | { kind: 'type'; letter: string }
    | { kind: 'newer'; time: number }
    | { kind: 'size'; size: number; unit: number; comparison: '+' | '-' | '=' }
    | { kind: 'empty' }
    | { kind: 'option' }
    | { kind: 'print'; terminator: string }
    | { kind: 'exec'; words: string[]; batched: boolean }
    | { kind: 'delete' };

type Node =
    | { kind: 'pred'; predicate: Predicate }
    | { kind: 'not'; child: Node }
    | { kind: 'and'; left: Node; right: Node }
    | { kind: 'or'; left: Node; right: Node };

/** Shell glob to regular expression. `-path` lets `*` cross a `/`, `-name` does not. */
function globToRegExp(pattern: string, ignoreCase: boolean, whole: boolean): RegExp {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '*') out += whole ? '.*' : '[^/]*';
        else if (ch === '?') out += whole ? '.' : '[^/]';
        else if (ch === '[') {
            let end = i + 1;
            if (pattern[end] === '!' || pattern[end] === '^') end++;
            if (pattern[end] === ']') end++;
            while (end < pattern.length && pattern[end] !== ']') end++;
            if (end >= pattern.length) {
                out += '\\[';
            } else {
                let body = pattern.slice(i + 1, end);
                if (body[0] === '!' || body[0] === '^') body = '^' + body.slice(1);
                out += '[' + body.replace(/\\/g, '\\\\') + ']';
                i = end;
            }
        } else if ('.+^${}()|\\]'.indexOf(ch) >= 0) {
            out += '\\' + ch;
        } else {
            out += ch;
        }
    }
    return new RegExp('^' + out + '$', ignoreCase ? 'i' : '');
}

/** Matches a glob against the last component (`-name`) or the whole path (`-path`). */
function globMatch(pattern: string, value: string, ignoreCase: boolean, whole: boolean): boolean {
    const regex = globToRegExp(pattern, ignoreCase, whole);
    const target = whole ? value : value.split('/').pop() as string;
    return regex.test(target);
}

const SIZE_UNITS: Record<string, number> = { b: 512, c: 1, w: 2, k: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 };

/** How many units a file occupies, rounded up: bytes for `-size 10c`, 512-byte blocks otherwise. */
function sizeInUnits(size: number, unitBytes: number): number {
    return Math.ceil(size / unitBytes);
}

function parseFindSize(text: string): { size: number; unit: number; comparison: '+' | '-' | '=' } | undefined {
    const match = /^([+-]?)([0-9]+)([bckwMG]?)$/.exec(text);
    if (match === null) return undefined;
    const comparison: '+' | '-' | '=' = match[1] === '+' ? '+' : match[1] === '-' ? '-' : '=';
    const count = Number.parseInt(match[2], 10);
    const unit = SIZE_UNITS[match[3] === '' ? 'b' : match[3]];
    if (unit === undefined) return undefined;
    return { size: count, unit, comparison };
}

/** The words of an expression up to the `;` or `+` that ends it. */
function takeExec(words: string[], from: number): { words: string[]; batched: boolean; next: number } | undefined {
    const collected: string[] = [];
    for (let i = from; i < words.length; i++) {
        if (words[i] === ';') return { words: collected, batched: false, next: i + 1 };
        if (words[i] === '{}' && i + 1 < words.length && words[i + 1] === ';') {
            collected.push('{}');
            return { words: collected, batched: false, next: i + 2 };
        }
        if (words[i] === '+') return { words: collected, batched: true, next: i + 1 };
        collected.push(words[i]);
    }
    return undefined;
}

interface ParsedFind {
    node: Node;
    maxDepth: number;
    minDepth: number;
    hasAction: boolean;
    deletes: boolean;
}

function parseFindExpression(words: string[], from: number): { parsed: ParsedFind; next: number } | { error: string } {
    let maxDepth = Number.MAX_SAFE_INTEGER;
    let minDepth = 0;
    let hasAction = false;
    let deletes = false;

    const primary = (index: number): { node: Node; next: number } | { error: string } => {
        const word = words[index];
        if (word === undefined) return { error: 'missing argument' };
        switch (word) {
            case '-name':
            case '-iname': {
                const pattern = words[index + 1];
                if (pattern === undefined) return { error: `${word}: requires additional arguments` };
                return {
                    node: { kind: 'pred', predicate: { kind: 'name', pattern, ignoreCase: word === '-iname' } },
                    next: index + 2
                };
            }
            case '-path':
            case '-ipath': {
                const pattern = words[index + 1];
                if (pattern === undefined) return { error: `${word}: requires additional arguments` };
                return {
                    node: { kind: 'pred', predicate: { kind: 'path', pattern, ignoreCase: word === '-ipath' } },
                    next: index + 2
                };
            }
            case '-type': {
                const letter = words[index + 1];
                if (letter === undefined) return { error: '-type: requires additional arguments' };
                return { node: { kind: 'pred', predicate: { kind: 'type', letter } }, next: index + 2 };
            }
            case '-newer': {
                const reference = words[index + 1];
                if (reference === undefined) return { error: '-newer: requires additional arguments' };
                const stat = statOf(fsOfParse, atPathOfParse(reference));
                if (stat === undefined) return { error: `${reference}: No such file or directory` };
                return { node: { kind: 'pred', predicate: { kind: 'newer', time: stat.mtimeMs } }, next: index + 2 };
            }
            case '-size': {
                const text = words[index + 1];
                if (text === undefined) return { error: '-size: requires additional arguments' };
                const parsedSize = parseFindSize(text);
                if (parsedSize === undefined) return { error: `-size: invalid size: ${text}` };
                return { node: { kind: 'pred', predicate: { kind: 'size', ...parsedSize } }, next: index + 2 };
            }
            case '-empty':
                return { node: { kind: 'pred', predicate: { kind: 'empty' } }, next: index + 1 };
            case '-maxdepth': {
                const text = words[index + 1];
                const value = text === undefined ? Number.NaN : Number.parseInt(text, 10);
                if (!Number.isFinite(value) || value < 0) return { error: '-maxdepth: requires a non-negative integer' };
                maxDepth = value;
                return { node: { kind: 'pred', predicate: { kind: 'option' } }, next: index + 2 };
            }
            case '-mindepth': {
                const text = words[index + 1];
                const value = text === undefined ? Number.NaN : Number.parseInt(text, 10);
                if (!Number.isFinite(value) || value < 0) return { error: '-mindepth: requires a non-negative integer' };
                minDepth = value;
                return { node: { kind: 'pred', predicate: { kind: 'option' } }, next: index + 2 };
            }
            case '-print':
                hasAction = true;
                return { node: { kind: 'pred', predicate: { kind: 'print', terminator: '\n' } }, next: index + 1 };
            case '-print0':
                hasAction = true;
                return { node: { kind: 'pred', predicate: { kind: 'print', terminator: '\0' } }, next: index + 1 };
            case '-delete':
                hasAction = true;
                deletes = true;
                return { node: { kind: 'pred', predicate: { kind: 'delete' } }, next: index + 1 };
            case '-exec':
            case '-ok': {
                const taken = takeExec(words, index + 1);
                if (taken === undefined || taken.words.length === 0) return { error: '-exec: no command specified' };
                hasAction = true;
                return {
                    node: { kind: 'pred', predicate: { kind: 'exec', words: taken.words, batched: taken.batched } },
                    next: taken.next
                };
            }
            case '-true':
                return { node: { kind: 'pred', predicate: { kind: 'option' } }, next: index + 1 };
            case '-false':
                return { node: { kind: 'not', child: { kind: 'pred', predicate: { kind: 'option' } } }, next: index + 1 };
            default:
                return { error: `${word}: unknown primary or operator` };
        }
    };

    const unary = (index: number): { node: Node; next: number } | { error: string } => {
        const word = words[index];
        if (word === '!' || word === '-not') {
            const child = unary(index + 1);
            if ('error' in child) return child;
            return { node: { kind: 'not', child: child.node }, next: child.next };
        }
        if (word === '(' || word === '\\(') {
            const inner = orExpr(index + 1);
            if ('error' in inner) return inner;
            const close = words[inner.next];
            if (close !== ')' && close !== '\\)') return { error: 'missing closing parenthesis' };
            return { node: inner.node, next: inner.next + 1 };
        }
        return primary(index);
    };

    const andExpr = (index: number): { node: Node; next: number } | { error: string } => {
        let left = unary(index);
        if ('error' in left) return left;
        for (;;) {
            const word = words[left.next];
            if (word === undefined || word === '-o' || word === '-or' || word === ')' || word === '\\)') break;
            if (word === '-a' || word === '-and') {
                const right = unary(left.next + 1);
                if ('error' in right) return right;
                left = { node: { kind: 'and', left: left.node, right: right.node }, next: right.next };
                continue;
            }
            if (isPrimaryWord(word)) {
                const right = unary(left.next);
                if ('error' in right) return right;
                left = { node: { kind: 'and', left: left.node, right: right.node }, next: right.next };
                continue;
            }
            break;
        }
        return left;
    };

    const orExpr = (index: number): { node: Node; next: number } | { error: string } => {
        let left = andExpr(index);
        if ('error' in left) return left;
        while (words[left.next] === '-o' || words[left.next] === '-or') {
            const right = andExpr(left.next + 1);
            if ('error' in right) return right;
            left = { node: { kind: 'or', left: left.node, right: right.node }, next: right.next };
        }
        return left;
    };

    let fsOfParse: Fs = FALLBACK_FS;
    let atPathOfParse = (path: string): string => path;
    const ctxHolder = parseContext;
    if (ctxHolder !== null) {
        fsOfParse = ctxHolder.fs;
        atPathOfParse = (path: string): string => resolveAt(ctxHolder as CommandContext, path);
    }

    const top = words.length <= from
        ? { node: { kind: 'pred', predicate: { kind: 'option' } } as Node, next: from }
        : orExpr(from);
    if ('error' in top) return { error: top.error };
    if (top.next < words.length) {
        const extra = words[top.next];
        if (extra !== ')' && extra !== '\\)') return { error: `${extra}: unknown primary or operator` };
    }
    return { parsed: { node: top.node, maxDepth, minDepth, hasAction, deletes }, next: top.next };
}

/** The context the `-newer` primary needs, set for the duration of one parse. */
let parseContext: CommandContext | null = null;
/** Only used when a parse runs without a context, which no command in this module does. */
const FALLBACK_FS = undefined as unknown as Fs;

const PRIMARY_WORDS = new Set([
    '-name',
    '-iname',
    '-path',
    '-ipath',
    '-type',
    '-newer',
    '-size',
    '-empty',
    '-maxdepth',
    '-mindepth',
    '-print',
    '-print0',
    '-delete',
    '-exec',
    '-ok',
    '-true',
    '-false'
]);

function isPrimaryWord(word: string): boolean {
    return PRIMARY_WORDS.has(word);
}

const FIND_USAGE =
    'usage: find [-H | -L | -P] [-EXdsx] [-f path] path ... [expression]\n' +
    '       find [-H | -L | -P] [-EXdsx] -f path [path ...] [expression]\n';

const find: ShellCommand = (ctx) => {
    const words = ctx.args;
    if (words.length === 0 || isOption(words[0]) || words[0] === '!' || words[0] === '(') {
        return fail(FIND_USAGE);
    }
    const roots: string[] = [];
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        if (word === '!' || word === '(' || word === '\\)' || word === ')' || PRIMARY_WORDS.has(word) || isOption(word)) {
            break;
        }
        roots.push(word);
        index++;
    }
    if (roots.length === 0) return fail(FIND_USAGE);

    parseContext = ctx;
    let parsed: ParsedFind;
    try {
        const outcome = parseFindExpression(words, index);
        if ('error' in outcome) return fail(`find: ${outcome.error}`);
        parsed = outcome.parsed;
    } finally {
        parseContext = null;
    }

    let node = parsed.node;
    if (!parsed.hasAction) {
        node = { kind: 'and', left: node, right: { kind: 'pred', predicate: { kind: 'print', terminator: '\n' } } };
    }

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    for (const root of roots) {
        const path = resolveAt(ctx, root);
        const shown = root.replace(/\/+$/, '') === '' ? '/' : root.replace(/\/+$/, '');
        const walked = parsed.deletes
            ? walkBottomUp(ctx.fs, path, shown)
            : walkRoot(ctx.fs, path, shown, parsed.maxDepth);
        if (walked.missing) {
            stderr += `find: ${root}: No such file or directory\n`;
            exitCode = 1;
            continue;
        }
        const batch: { shown: string; words: string[] }[] = [];
        for (const entry of walked.entries) {
            if (entry.depth < parsed.minDepth) continue;
            const outcome = evaluate(ctx, node, entry, batch);
            if (outcome.stderr !== '') stderr += outcome.stderr;
            stdout += outcome.stdout;
            if (outcome.exitCode !== 0) exitCode = outcome.exitCode;
        }
        if (batch.length > 0) {
            const run = execBatch(ctx, batch);
            stdout += run.stdout;
            stderr += run.stderr;
            if (run.exitCode !== 0) exitCode = run.exitCode;
        }
    }
    return result(stdout, stderr, exitCode);
};

interface EvalOutcome {
    stdout: string;
    stderr: string;
    exitCode: number;
    truth: boolean;
}

function evaluate(ctx: CommandContext, node: Node, entry: Entry, batch: ExecBatchItem[]): EvalOutcome {
    const none: EvalOutcome = { stdout: '', stderr: '', exitCode: 0, truth: false };
    switch (node.kind) {
        case 'not': {
            const inner = evaluate(ctx, node.child, entry, batch);
            return { ...inner, truth: !inner.truth };
        }
        case 'and': {
            const left = evaluate(ctx, node.left, entry, batch);
            if (!left.truth) return left;
            const right = evaluate(ctx, node.right, entry, batch);
            return {
                stdout: left.stdout + right.stdout,
                stderr: left.stderr + right.stderr,
                exitCode: right.exitCode !== 0 ? right.exitCode : left.exitCode,
                truth: right.truth
            };
        }
        case 'or': {
            const left = evaluate(ctx, node.left, entry, batch);
            if (left.truth) return left;
            const right = evaluate(ctx, node.right, entry, batch);
            return {
                stdout: left.stdout + right.stdout,
                stderr: left.stderr + right.stderr,
                exitCode: right.exitCode !== 0 ? right.exitCode : left.exitCode,
                truth: right.truth
            };
        }
        case 'pred':
            return evaluatePredicate(ctx, node.predicate, entry, batch);
    }
}

function evaluatePredicate(ctx: CommandContext, predicate: Predicate, entry: Entry, batch: ExecBatchItem[]): EvalOutcome {
    const base: EvalOutcome = { stdout: '', stderr: '', exitCode: 0, truth: true };
    switch (predicate.kind) {
        case 'option':
            return base;
        case 'name':
            return { ...base, truth: globMatch(predicate.pattern, entry.shown, predicate.ignoreCase, false) };
        case 'path':
            return { ...base, truth: globMatch(predicate.pattern, entry.shown, predicate.ignoreCase, true) };
        case 'type': {
            let letter = 'f';
            if (entry.type === 'dir') letter = 'd';
            else if (isSymlink(ctx.fs, entry.path)) letter = 'l';
            return { ...base, truth: letter === predicate.letter };
        }
        case 'newer':
            return { ...base, truth: entry.mtimeMs > predicate.time };
        case 'size': {
            const quantity = sizeInUnits(entry.size, predicate.unit);
            let truth: boolean;
            if (predicate.comparison === '+') truth = quantity > predicate.size;
            else if (predicate.comparison === '-') truth = quantity < predicate.size;
            else truth = quantity === predicate.size;
            return { ...base, truth };
        }
        case 'empty': {
            if (entry.type === 'dir') {
                return { ...base, truth: dirEntries(ctx.fs, entry.path).length === 0 };
            }
            return { ...base, truth: entry.size === 0 };
        }
        case 'print':
            return { stdout: entry.shown + predicate.terminator, stderr: '', exitCode: 0, truth: true };
        case 'delete':
            return deleteEntry(ctx, entry);
        case 'exec': {
            // `+` collects every match into one invocation, `;` runs one invocation per match
            if (predicate.batched) {
                batch.push({ shown: entry.shown, words: predicate.words });
                return base;
            }
            const substituted = predicate.words.map((word) => word.split('{}').join(entry.shown));
            return execOnce(ctx, substituted, entry.shown);
        }
    }
}

function deleteEntry(ctx: CommandContext, entry: Entry): EvalOutcome {
    if (isProtected(entry.path, ctx.env)) {
        return {
            stdout: '',
            stderr: `find: refusing to delete ${entry.shown}: it is the file system root\n`,
            exitCode: 1,
            truth: false
        };
    }
    try {
        if (entry.type === 'dir') {
            if (dirEntries(ctx.fs, entry.path).length > 0) {
                return {
                    stdout: '',
                    stderr: `find: -delete: ${entry.shown}: Directory not empty\n`,
                    exitCode: 1,
                    truth: false
                };
            }
            ctx.fs.deleteDirectory(entry.path);
        } else {
            ctx.fs.removePath(entry.path, false);
        }
        dropMeta(ctx.fs, entry.path);
        return { stdout: '', stderr: '', exitCode: 0, truth: true };
    } catch (error) {
        return {
            stdout: '',
            stderr: `find: -delete: ${entry.shown}: ${message(error)}\n`,
            exitCode: 1,
            truth: false
        };
    }
}

interface ExecBatchItem {
    shown: string;
    words: string[];
}

/** Runs one `-exec ... +`, where every matched path replaces every `{}` of the command. */
function execBatch(
    ctx: CommandContext,
    batch: ExecBatchItem[]
): { stdout: string; stderr: string; exitCode: number } {
    const paths = batch.map((item) => item.shown);
    const words = batch[0].words;
    const substituted: string[] = [];
    let placed = false;
    for (const word of words) {
        if (word.indexOf('{}') >= 0) {
            placed = true;
            substituted.push(word.split('{}').join(paths.join(' ')));
        } else {
            substituted.push(word);
        }
    }
    if (!placed) substituted.push(paths.join(' '));
    const run = execOnce(ctx, substituted, paths.join(' '));
    return { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode };
}

function execOnce(ctx: CommandContext, words: string[], shown: string): EvalOutcome {
    const name = words[0];
    const args = words.slice(1);
    if (DESTRUCTIVE.has(name)) {
        for (const arg of args) {
            const candidate = arg === shown ? shown : arg;
            if (isProtected(resolveAt(ctx, candidate), ctx.env)) {
                return {
                    stdout: '',
                    stderr: `find: refusing to run ${name} on ${candidate}: it is the file system root\n`,
                    exitCode: 1,
                    truth: false
                };
            }
        }
    }
    const run = runUtility(ctx, name, args);
    if (run === undefined) {
        return {
            stdout: '',
            stderr: `find: -exec: ${name}: No such file or directory\n`,
            exitCode: 1,
            truth: false
        };
    }
    return {
        stdout: run.stdout,
        stderr: run.stderr,
        exitCode: run.exitCode === 0 ? 0 : run.exitCode,
        truth: run.exitCode === 0
    };
}

/* -------------------------------------------------------------------- xargs */

const XARGS_USAGE =
    'usage: xargs [-0opt] [-E eofstr] [-I replstr [-R replacements] [-S replsize]]\n' +
    '             [-J replstr] [-L number] [-n number [-x]] [-P maxprocs]\n' +
    '             [-s size] [utility [argument ...]]\n';

interface XargsOptions {
    zero: boolean;
    delimiter: string;
    replace: string | null;
    maxArgs: number;
    maxChars: number;
    trace: boolean;
    noRunIfEmpty: boolean;
}

/** Splits the input of `xargs`. Quotes and backslashes group words, as POSIX says. */
function splitDefault(text: string): string[] {
    const items: string[] = [];
    let current = '';
    let quote: string | null = null;
    let started = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote !== null) {
            if (ch === quote) {
                quote = null;
                continue;
            }
            current += ch;
            continue;
        }
        if (ch === '\\') {
            current += text[i + 1] ?? '';
            i++;
            started = true;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
            if (started) {
                items.push(current);
                current = '';
                started = false;
            }
            continue;
        }
        current += ch;
        started = true;
    }
    if (started) items.push(current);
    return items;
}

function unescapeDelimiter(text: string): string {
    if (text.length === 2 && text[0] === '\\') {
        const map: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            '\\': '\\',
            '0': '\0',
            a: '\x07',
            b: '\b',
            f: '\f',
            v: '\v'
        };
        const mapped = map[text[1]];
        if (mapped !== undefined) return mapped;
    }
    return text;
}

const xargs: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    const options: XargsOptions = {
        zero: false,
        delimiter: '',
        replace: null,
        maxArgs: 0,
        maxChars: 65536,
        trace: false,
        noRunIfEmpty: false
    };
    let index = 0;
    let endOfOptions = false;
    while (index < words.length) {
        const word = words[index];
        if (endOfOptions || word === '--') {
            if (word === '--') index++;
            endOfOptions = true;
            break;
        }
        if (!isOption(word) && word !== '-0') break;
        switch (word) {
            case '-0':
                options.zero = true;
                index++;
                break;
            case '-d': {
                const value = words[index + 1];
                if (value === undefined) return fail('xargs: option requires an argument -- d\n' + XARGS_USAGE);
                options.delimiter = unescapeDelimiter(value);
                index += 2;
                break;
            }
            case '-I': {
                const value = words[index + 1];
                if (value === undefined) return fail('xargs: option requires an argument -- I\n' + XARGS_USAGE);
                options.replace = value;
                index += 2;
                break;
            }
            case '-n': {
                const value = words[index + 1];
                const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
                if (!Number.isFinite(parsed) || parsed < 1) return fail(`xargs: invalid -n argument: ${value ?? ''}\n` + XARGS_USAGE);
                options.maxArgs = parsed;
                index += 2;
                break;
            }
            case '-s': {
                const value = words[index + 1];
                const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
                if (!Number.isFinite(parsed) || parsed < 1) return fail(`xargs: invalid -s argument: ${value ?? ''}\n` + XARGS_USAGE);
                options.maxChars = parsed;
                index += 2;
                break;
            }
            case '-t':
                options.trace = true;
                index++;
                break;
            case '-r':
                options.noRunIfEmpty = true;
                index++;
                break;
            case '-o':
            case '-p':
            case '-x':
                index++;
                break;
            default: {
                const letter = word.slice(1, 2);
                return fail(`xargs: invalid option -- ${letter}\n${XARGS_USAGE}`);
            }
        }
    }

    const utility = words[index];
    const prefixArgs = words.slice(index + 1);
    const text = ctx.input ?? '';

    let items: string[];
    if (options.replace !== null) {
        items = text.split('\n').filter((line, at) => line !== '' || at < text.split('\n').length - 1);
        if (items.length > 0 && items[items.length - 1] === '') items.pop();
    } else if (options.zero) {
        items = text.split('\0');
        if (items.length > 0 && items[items.length - 1] === '') items.pop();
    } else if (options.delimiter !== '') {
        items = text.split(options.delimiter);
        if (items.length > 0 && items[items.length - 1] === '') items.pop();
    } else {
        items = splitDefault(text);
    }

    if (items.length === 0) {
        if (options.noRunIfEmpty || utility === undefined || utility === '') return ok();
        if (options.replace !== null) return ok();
    }

    const name = utility === undefined || utility === '' ? 'echo' : utility;
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    const invoke = (args: string[]): number => {
        const command = options.trace ? name + ' ' + args.join(' ') : '';
        if (command !== '') stderr += command + '\n';
        const run = runUtility(ctx, name, args);
        if (run === undefined) {
            stderr += `xargs: ${name}: No such file or directory\n`;
            return 127;
        }
        stdout += run.stdout;
        stderr += run.stderr;
        return run.exitCode;
    };

    if (options.replace !== null) {
        for (const item of items) {
            const args = prefixArgs.map((word) => word.split(options.replace as string).join(item));
            const status = invoke(args);
            if (status === 127) return result(stdout, stderr, 127);
            if (status === 126) return result(stdout, stderr, 126);
            if (status !== 0 && exitCode === 0) exitCode = status === 255 ? 124 : status;
        }
        return result(stdout, stderr, exitCode);
    }

    const fits = (args: string[]): boolean => {
        let total = name.length + 1;
        for (const arg of args) total += arg.length + 1;
        return total <= options.maxChars;
    };

    if (items.some((item) => !fits(prefixArgs.concat([item])))) {
        return result(stdout, stderr + 'xargs: insufficient space for argument\n', 1);
    }
    let batch: string[] = [];
    const limit = options.maxArgs > 0 ? options.maxArgs : Number.MAX_SAFE_INTEGER;
    for (const item of items) {
        const candidate = batch.concat([item]);
        if (batch.length > 0 && (candidate.length > limit || !fits(prefixArgs.concat(candidate)))) {
            const status = invoke(prefixArgs.concat(batch));
            if (status === 127) return result(stdout, stderr, 127);
            if (status === 126) return result(stdout, stderr, 126);
            if (status !== 0 && exitCode === 0) exitCode = status === 255 ? 124 : status;
            batch = [];
        }
        batch.push(item);
        if (batch.length >= limit) {
            const status = invoke(prefixArgs.concat(batch));
            if (status === 127) return result(stdout, stderr, 127);
            if (status === 126) return result(stdout, stderr, 126);
            if (status !== 0 && exitCode === 0) exitCode = status === 255 ? 124 : status;
            batch = [];
        }
    }
    if (batch.length > 0) {
        const status = invoke(prefixArgs.concat(batch));
        if (status === 127) return result(stdout, stderr, 127);
        if (status === 126) return result(stdout, stderr, 126);
        if (status !== 0 && exitCode === 0) exitCode = status === 255 ? 124 : status;
    }
    return result(stdout, stderr, exitCode);
};

/* -------------------------------------------------------- basename / dirname */

const basename: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let all = false;
    let suffix: string | null = null;
    let index = 0;
    while (index < words.length && isOption(words[index])) {
        const word = words[index];
        if (word === '-a') {
            all = true;
            index++;
        } else if (word === '-s') {
            suffix = words[index + 1];
            if (suffix === undefined) return fail('basename: option requires an argument -- s\nusage: basename string [suffix]\n       basename [-a] [-s suffix] string [...]');
            index += 2;
        } else if (word === '--') {
            index++;
            break;
        } else {
            return fail(`basename: illegal option -- ${word.slice(1, 2)}\nusage: basename string [suffix]\n       basename [-a] [-s suffix] string [...]`);
        }
    }
    const operands = words.slice(index);
    if (operands.length === 0) {
        return fail('usage: basename string [suffix]\n       basename [-a] [-s suffix] string [...]');
    }
    const positional: string[] = [];
    if (!all && suffix === null && operands.length >= 2) {
        positional.push(operands[0]);
        suffix = operands[1];
    } else {
        for (const operand of operands) positional.push(operand);
    }
    let out = '';
    for (const operand of positional) {
        const trimmed = operand.replace(/\/+$/, '');
        if (operand === '') { out += '\n'; continue; }
        const last = trimmed === '' ? '/' : trimmed.split('/').pop() as string;
        let name = last;
        if (suffix !== null && suffix !== '' && name !== suffix && name.length > suffix.length && name.endsWith(suffix)) {
            name = name.slice(0, name.length - suffix.length);
        }
        out += name + '\n';
    }
    return ok(out);
};

const dirname: ShellCommand = (ctx) => {
    const operands = ctx.args.filter((arg) => arg !== '--');
    if (operands.length === 0) return fail('usage: dirname string [...]');
    let out = '';
    for (const operand of operands) {
        const trimmed = operand.replace(/\/+$/, '');
        if (operand === '') {
            out += '.\n';
            continue;
        }
        if (trimmed === '') {
            out += '/\n';
            continue;
        }
        if (trimmed.indexOf('/') < 0) {
            out += '.\n';
            continue;
        }
        const parent = trimmed.slice(0, trimmed.lastIndexOf('/'));
        out += (parent === '' ? '/' : parent) + '\n';
    }
    return ok(out);
};

/* --------------------------------------------------------------------- expr */

interface ExprToken {
    text: string;
}

const EXPR_OPERATORS = new Set(['|', '&', '=', '!=', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', ':', '(', ')']);

/** Turns a POSIX basic regular expression into the ECMAScript spelling of the same pattern. */
function breToRegExp(bre: string): RegExp {
    let out = '';
    for (let i = 0; i < bre.length; i++) {
        const ch = bre[i];
        if (ch === '\\') {
            const next = bre[i + 1];
            if (next === '(') {
                out += '(';
                i++;
                continue;
            }
            if (next === ')') {
                out += ')';
                i++;
                continue;
            }
            if (next === '{') {
                let end = bre.indexOf('\\}', i + 2);
                if (end < 0) end = bre.length;
                out += bre.slice(i + 2, end);
                i = end + 1;
                continue;
            }
            if (next === '+' || next === '?' || next === '|') {
                out += '\\' + next;
                i++;
                continue;
            }
            out += next === undefined ? '\\' : next;
            i++;
            continue;
        }
        if (ch === '*') {
            if (out === '' || out.endsWith('(') || out.endsWith('|')) out += '\\*';
            else out += '*';
            continue;
        }
        if (ch === '^' && out !== '' && !out.endsWith('(') && !out.endsWith('|')) {
            out += '\\^';
            continue;
        }
        if (ch === '$' && i !== bre.length - 1) {
            out += '\\$';
            continue;
        }
        if (ch === '{' || ch === '}' || ch === '[' || ch === ']') {
            out += ch;
            continue;
        }
        out += ch;
    }
    return new RegExp('^(?:' + out + ')');
}

function exprError(message: string): never {
    throw { exprError: message };
}

function isInteger(text: string): boolean {
    return /^-?[0-9]+$/.test(text);
}

/** Evaluates the token list of `expr`, throwing `{ exprError }` for anything it cannot do. */
function evalExpr(tokens: string[], from: number): { value: string; next: number } {
    // level 0: | and &
    const levelOr = (index: number): { value: string; next: number } => {
        let left = levelAnd(index);
        while (tokens[left.next] === '|' || tokens[left.next] === '&') {
            const operator = tokens[left.next];
            const right = levelAnd(left.next + 1);
            if (operator === '|') {
                left = { value: left.value !== '' && left.value !== '0' ? left.value : right.value, next: right.next };
            } else {
                const both = left.value !== '' && left.value !== '0' && right.value !== '' && right.value !== '0';
                left = { value: both ? left.value : '0', next: right.next };
            }
        }
        return left;
    };
    // level 1: comparison
    const levelAnd = (index: number): { value: string; next: number } => {
        const left = levelAdd(index);
        const operator = tokens[left.next];
        if (operator === '=' || operator === '!=' || operator === '<' || operator === '<=' || operator === '>' || operator === '>=') {
            const right = levelAdd(left.next + 1);
            let truth: boolean;
            if (isInteger(left.value) && isInteger(right.value)) {
                const a = Number.parseInt(left.value, 10);
                const b = Number.parseInt(right.value, 10);
                truth =
                    operator === '=' ? a === b
                        : operator === '!=' ? a !== b
                            : operator === '<' ? a < b
                                : operator === '<=' ? a <= b
                                    : operator === '>' ? a > b
                                        : a >= b;
            } else {
                const compared = cmpStr(left.value, right.value);
                truth =
                    operator === '=' ? compared === 0
                        : operator === '!=' ? compared !== 0
                            : operator === '<' ? compared < 0
                                : operator === '<=' ? compared <= 0
                                    : operator === '>' ? compared > 0
                                        : compared >= 0;
            }
            return { value: truth ? '1' : '0', next: right.next };
        }
        return left;
    };
    // level 2: + and -
    const levelAdd = (index: number): { value: string; next: number } => {
        let left = levelMul(index);
        while (tokens[left.next] === '+' || tokens[left.next] === '-') {
            const operator = tokens[left.next];
            const right = levelMul(left.next + 1);
            if (!isInteger(left.value) || !isInteger(right.value)) exprError('non-integer argument');
            const a = Number.parseInt(left.value, 10);
            const b = Number.parseInt(right.value, 10);
            left = { value: String(operator === '+' ? a + b : a - b), next: right.next };
        }
        return left;
    };
    // level 3: * / %
    const levelMul = (index: number): { value: string; next: number } => {
        let left = levelUnary(index);
        while (tokens[left.next] === '*' || tokens[left.next] === '/' || tokens[left.next] === '%') {
            const operator = tokens[left.next];
            const right = levelUnary(left.next + 1);
            if (!isInteger(left.value) || !isInteger(right.value)) exprError('non-integer argument');
            const a = Number.parseInt(left.value, 10);
            const b = Number.parseInt(right.value, 10);
            if (b === 0 && (operator === '/' || operator === '%')) exprError('division by zero');
            left = {
                value: String(operator === '*' ? a * b : operator === '/' ? Math.trunc(a / b) : a - b * Math.trunc(a / b)),
                next: right.next
            };
        }
        return left;
    };
    // level 4: optional minus
    const levelUnary = (index: number): { value: string; next: number } => {
        if (tokens[index] === '-') {
            const inner = levelUnary(index + 1);
            if (!isInteger(inner.value)) exprError('non-integer argument');
            return { value: String(-Number.parseInt(inner.value, 10)), next: inner.next };
        }
        return levelPrimary(index);
    };
    // level 5: atom, parenthesis, and the `:` match
    const levelPrimary = (index: number): { value: string; next: number } => {
        const token = tokens[index];
        if (token === undefined) exprError('syntax error');
        if (token === '(') {
            const inner = levelOr(index + 1);
            if (tokens[inner.next] !== ')') exprError('syntax error');
            return { value: inner.value, next: inner.next + 1 };
        }
        if (token === ')') exprError('syntax error');
        if (EXPR_OPERATORS.has(token) && token !== '-') exprError('syntax error');
        if (tokens[index + 1] === ':') {
            const pattern = tokens[index + 2];
            if (pattern === undefined) exprError('syntax error');
            const regex = breToRegExp(pattern);
            const match = regex.exec(token);
            if (match === null) return { value: pattern.indexOf('\\(') >= 0 ? '' : '0', next: index + 3 };
            if (match.length > 1 && match[1] !== undefined) return { value: match[1], next: index + 3 };
            return { value: String(match[0].length), next: index + 3 };
        }
        return { value: token, next: index + 1 };
    };
    return levelOr(from);
}

const expr: ShellCommand = (ctx) => {
    if (ctx.args.length === 0) return result('', 'expr: syntax error\n', 2);
    if (ctx.args.some((arg) => arg === '--')) {
        const rest = ctx.args.slice(ctx.args.indexOf('--') + 1);
        if (rest.length === 0) return result('', 'expr: syntax error\n', 2);
        return expr({ ...ctx, args: rest });
    }
    try {
        const outcome = evalExpr(ctx.args, 0);
        if (outcome.next !== ctx.args.length) exprError('syntax error');
        const value = outcome.value;
        const exitCode = value === '' || value === '0' ? 1 : 0;
        return result(value + '\n', '', exitCode);
    } catch (error) {
        const text = error !== null && typeof error === 'object' && 'exprError' in error
            ? String((error as { exprError: string }).exprError)
            : 'syntax error';
        return result('', `expr: ${text}\n`, 2);
    }
};

/* ------------------------------------------------------------------ test / [ */

interface TestFile {
    exists: boolean;
    type: 'file' | 'dir';
    size: number;
    mode: number;
    symlink: boolean;
}

function testFile(ctx: CommandContext, path: string): TestFile {
    const resolved = resolveAt(ctx, path);
    const stat = statOf(ctx.fs, resolved);
    if (stat === undefined) {
        return { exists: false, type: 'file', size: 0, mode: 0, symlink: false };
    }
    return {
        exists: true,
        type: stat.type,
        size: stat.size,
        mode: modeOf(ctx.fs, resolved, stat.type === 'dir'),
        symlink: isSymlink(ctx.fs, resolved)
    };
}

type TestOutcome = { value: boolean; next: number } | { error: string };

/** The operators that take two operands and stand between them. */
const BINARY_OPERATORS = new Set(['=', '!=', '-eq', '-ne', '-gt', '-ge', '-lt', '-le', '-nt', '-ot', '-ef']);

function evalTest(ctx: CommandContext, args: string[], from: number): TestOutcome {
    const orLevel = (index: number): TestOutcome => {
        let left = andLevel(index);
        if ('error' in left) return left;
        while (args[left.next] === '-o') {
            const right = andLevel(left.next + 1);
            if ('error' in right) return right;
            left = { value: left.value || right.value, next: right.next };
        }
        return left;
    };
    const andLevel = (index: number): TestOutcome => {
        let left = unaryLevel(index);
        if ('error' in left) return left;
        while (args[left.next] === '-a') {
            const right = unaryLevel(left.next + 1);
            if ('error' in right) return right;
            left = { value: left.value && right.value, next: right.next };
        }
        return left;
    };
    const unaryLevel = (index: number): TestOutcome => {
        const word = args[index];
        if (word === undefined) return { error: 'argument expected' };
        if (word === '!') {
            const inner = unaryLevel(index + 1);
            if ('error' in inner) return inner;
            return { value: !inner.value, next: inner.next };
        }
        if (word === '(') {
            const inner = orLevel(index + 1);
            if ('error' in inner) return inner;
            if (args[inner.next] !== ')') return { error: 'closing paren expected' };
            return { value: inner.value, next: inner.next + 1 };
        }
        if (word === ')') return { error: 'unexpected )' };

        // unary
        if (isOption(word)) {
            let value: boolean;
            switch (word) {
                case '-b':
                case '-c':
                case '-p':
                case '-S':
                    value = false;
                    break;
                case '-d': {
                    const file = testFile(ctx, args[index + 1] ?? '');
                    value = file.exists && file.type === 'dir';
                    break;
                }
                case '-e':
                    value = testFile(ctx, args[index + 1] ?? '').exists;
                    break;
                case '-f': {
                    const file = testFile(ctx, args[index + 1] ?? '');
                    value = file.exists && file.type === 'file' && !file.symlink;
                    break;
                }
                case '-g': {
                    const file = testFile(ctx, args[index + 1] ?? '');
                    value = file.exists && (file.mode & 0o2010) !== 0;
                    break;
                }
                case '-h':
                case '-L':
                    value = testFile(ctx, args[index + 1] ?? '').symlink;
                    break;
                case '-n':
                    value = (args[index + 1] ?? '') !== '';
                    break;
                case '-r':
                case '-w':
                case '-x':
                    // the container has no permission model and runs as the superuser
                    value = testFile(ctx, args[index + 1] ?? '').exists;
                    break;
                case '-s': {
                    const file = testFile(ctx, args[index + 1] ?? '');
                    value = file.exists && file.size > 0;
                    break;
                }
                case '-t':
                    value = false;
                    break;
                case '-u': {
                    const file = testFile(ctx, args[index + 1] ?? '');
                    value = file.exists && (file.mode & 0o4000) !== 0;
                    break;
                }
                case '-z':
                    value = (args[index + 1] ?? '') === '';
                    break;
                default:
                    return { error: `${word}: unknown operator` };
            }
            return { value, next: index + 2 };
        }
        // three argument forms: the operator stands between its two operands
        const second = args[index + 1];
        const third = args[index + 2];
        if (second !== undefined && BINARY_OPERATORS.has(second) && third !== undefined) {
            if (second === '=' || second === '!=') {
                const equal = word === third;
                return { value: second === '=' ? equal : !equal, next: index + 3 };
            }
            if (second === '-ef') {
                return { value: clean(resolveAt(ctx, word)) === clean(resolveAt(ctx, third)), next: index + 3 };
            }
            if (second === '-nt' || second === '-ot') {
                const leftStat = statOf(ctx.fs, resolveAt(ctx, word));
                const rightStat = statOf(ctx.fs, resolveAt(ctx, third));
                if (leftStat !== undefined && rightStat !== undefined) {
                    const newer = (leftStat as Entry).mtimeMs > (rightStat as Entry).mtimeMs;
                    return { value: second === '-nt' ? newer : !newer, next: index + 3 };
                }
                return { value: false, next: index + 3 };
            }
            if (!isInteger(word) || !isInteger(third)) return { error: `integer expression expected: ${word}` };
            const a = Number.parseInt(word, 10);
            const b = Number.parseInt(third, 10);
            const value =
                second === '-eq' ? a === b
                    : second === '-ne' ? a !== b
                        : second === '-gt' ? a > b
                            : second === '-ge' ? a >= b
                                : second === '-lt' ? a < b
                                    : a <= b;
            return { value, next: index + 3 };
        }
        if (second !== undefined && BINARY_OPERATORS.has(second)) return { error: 'argument expected' };
        if (second !== undefined && isOption(second)) return { error: `${second}: unknown operator` };
        return { value: word !== '', next: index + 1 };
    };
    return orLevel(from);
}

function runTest(ctx: CommandContext, args: string[]): CommandResult {
    if (args.length === 0) return result('', '', 1);
    const outcome = evalTest(ctx, args, 0);
    if ('error' in outcome) return result('', `test: ${outcome.error}\n`, 2);
    if (outcome.next !== args.length) return result('', `test: ${args[outcome.next]}: unexpected operator\n`, 2);
    return result('', '', outcome.value ? 0 : 1);
}

const test: ShellCommand = (ctx) => runTest(ctx, ctx.args);

const bracket: ShellCommand = (ctx) => {
    const args = ctx.args.slice();
    if (args.length === 0 || args[args.length - 1] !== ']') return result('', '[: missing ]\n', 2);
    return runTest(ctx, args.slice(0, -1));
};

/* ------------------------------------------------------------------- printf */

const PRINTF_ESCAPES: Record<string, string> = {
    '\\': '\\',
    a: '\x07',
    b: '\b',
    c: '',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v'
};

/** Interprets the backslash escapes of a format or of a `%b` argument. */
function decodeEscapes(text: string): { text: string; stop: boolean } {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '\\') {
            out += text[i];
            continue;
        }
        const next = text[i + 1];
        if (next === undefined) {
            out += '\\';
            continue;
        }
        if (next >= '0' && next <= '7') {
            let digits = '';
            let at = i + 1;
            while (digits.length < 3 && at < text.length && text[at] >= '0' && text[at] <= '7') {
                digits += text[at];
                at++;
            }
            out += String.fromCharCode(Number.parseInt(digits, 8));
            i = at - 1;
            continue;
        }
        const mapped = PRINTF_ESCAPES[next];
        if (mapped === undefined) {
            out += next;
        } else if (next === 'c') {
            return { text: out, stop: true };
        } else {
            out += mapped;
        }
        i++;
    }
    return { text: out, stop: false };
}

/** Applies one conversion to one argument, honouring flags, width and precision. */
function applyConversion(spec: string, argument: string): string {
    const match = /^([-+# 0]*)(\*|[0-9]+)?(?:\.(\*|[0-9]+))?([diouxXsceEfFgGbaA%])$/.exec(spec);
    if (match === null) return spec;
    const flags = match[1];
    const widthText = match[2];
    const precisionText = match[3];
    const conversion = match[4];
    let width = widthText === undefined || widthText === '*' ? 0 : Number.parseInt(widthText, 10);
    let precision = precisionText === undefined || precisionText === '*' ? -1 : Number.parseInt(precisionText, 10);

    if (conversion === 's') {
        let text = precision >= 0 ? argument.slice(0, precision) : argument;
        if (width > text.length) {
            text = flags.indexOf('-') >= 0 ? text + ' '.repeat(width - text.length) : ' '.repeat(width - text.length) + text;
        }
        return text;
    }
    if (conversion === 'c') {
        return argument.length === 0 ? '' : argument[0];
    }
    if (conversion === 'b') {
        return decodeEscapes(argument).text;
    }
    if (conversion === 'd' || conversion === 'i') {
        const value = Number.parseInt(argument, 10);
        if (Number.isNaN(value)) throw new Error(`${argument}: expected numeric value`);
        let digits = String(Math.abs(value));
        const sign = value < 0 ? '-' : flags.indexOf('+') >= 0 ? '+' : flags.indexOf(' ') >= 0 ? ' ' : '';
        if (precision >= 0 && digits.length < precision) digits = '0'.repeat(precision - digits.length) + digits;
        let body = sign + digits;
        if (width > body.length) {
            if (flags.indexOf('-') >= 0) body = body + ' '.repeat(width - body.length);
            else if (flags.indexOf('0') >= 0 && precision < 0) body = sign + '0'.repeat(width - body.length) + digits;
            else body = ' '.repeat(width - body.length) + body;
        }
        return body;
    }
    if (conversion === 'o' || conversion === 'u' || conversion === 'x' || conversion === 'X') {
        const parsed = Number.parseInt(argument, 10);
        if (Number.isNaN(parsed)) throw new Error(`${argument}: expected numeric value`);
        const base = conversion === 'o' ? 8 : conversion === 'u' ? 10 : 16;
        let digits = (parsed < 0 ? parsed >>> 0 : parsed).toString(base);
        if (conversion === 'X') digits = digits.toUpperCase();
        if (precision >= 0 && digits.length < precision) digits = '0'.repeat(precision - digits.length) + digits;
        if (flags.indexOf('#') >= 0 && digits !== '0') {
            if (conversion === 'o') digits = '0' + digits;
            else if (conversion !== 'u') digits = (conversion === 'X' ? '0X' : '0x') + digits;
        }
        if (width > digits.length) {
            digits = flags.indexOf('-') >= 0
                ? digits + ' '.repeat(width - digits.length)
                : (flags.indexOf('0') >= 0 && precision < 0 ? '0' : ' ').repeat(width - digits.length) + digits;
        }
        return digits;
    }
    // floating point
    const value = Number(argument);
    if (Number.isNaN(value)) throw new Error(`${argument}: expected numeric value`);
    let text: string;
    if (conversion === 'e' || conversion === 'E') {
        text = value.toExponential(precision < 0 ? 6 : precision);
        if (conversion === 'E') text = text.toUpperCase();
    } else if (conversion === 'f' || conversion === 'F') {
        text = value.toFixed(precision < 0 ? 6 : precision);
    } else if (conversion === 'g' || conversion === 'G') {
        text = precision === 0 ? value.toPrecision(1) : value.toPrecision(precision < 0 ? 6 : precision);
        text = String(Number(text));
        if (conversion === 'G') text = text.toUpperCase();
    } else if (conversion === 'a' || conversion === 'A') {
        text = value.toString(16);
    } else {
        text = argument;
    }
    let body = text;
    if (width > body.length) {
        body = flags.indexOf('-') >= 0
            ? body + ' '.repeat(width - body.length)
            : (flags.indexOf('0') >= 0 ? '0' : ' ').repeat(width - body.length) + body;
    }
    return body;
}

const printf: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let index = 0;
    while (index < words.length && words[index] === '--') index++;
    const format = words[index];
    if (format === undefined) return fail('usage: printf format [arguments ...]');
    const args = words.slice(index + 1);
    let out = '';
    let argument = 0;
    let done = false;
    let badNumber: string | null = null;

    // the format is reused while arguments remain, exactly as the shell's printf does
    while (!done && (argument === 0 || argument < args.length)) {
        let i = 0;
        let consumed = false;
        while (i < format.length) {
            const ch = format[i];
            if (ch === '\\') {
                const next = format[i + 1];
                if (next === undefined) {
                    out += '\\';
                    i++;
                    continue;
                }
                if (next === 'c') {
                    done = true;
                    break;
                }
                if (next >= '0' && next <= '7') {
                    let digits = '';
                    let at = i + 1;
                    while (digits.length < 3 && at < format.length && format[at] >= '0' && format[at] <= '7') {
                        digits += format[at];
                        at++;
                    }
                    out += String.fromCharCode(Number.parseInt(digits, 8));
                    i = at;
                    continue;
                }
                const mapped = PRINTF_ESCAPES[next];
                out += mapped === undefined ? next : mapped;
                i += 2;
                continue;
            }
            if (ch !== '%') {
                out += ch;
                i++;
                continue;
            }
            if (format[i + 1] === '%') {
                out += '%';
                i += 2;
                continue;
            }
            const rest = format.slice(i + 1);
            const match = /^([-+# 0]*)(\*|[0-9]+)?(?:\.(\*|[0-9]+))?([diouxXsceEfFgGbaA])/.exec(rest);
            if (match === null) {
                out += ch;
                i++;
                continue;
            }
            let spec = match[0];
            while (spec.indexOf('*') >= 0) {
                const widthArg = args[argument++];
                const widthValue = widthArg === undefined ? 0 : Number.parseInt(widthArg, 10);
                spec = spec.replace('*', String(Number.isNaN(widthValue) ? 0 : widthValue));
            }
            const value = args[argument++];
            consumed = true;
            try {
                out += applyConversion(spec, value ?? '');
            } catch (error) {
                out += '0';
                badNumber = `printf: ${message(error)}\n`;
            }
            i += 1 + spec.length;
        }
        if (!consumed) break;
        if (argument === 0) break;
    }
    if (badNumber !== null) return result(out, badNumber, 1);
    return ok(out);
};

/* ---------------------------------------------------------------------- seq */

/** How BSD `seq` prints a number when no format is given: integral values lose the decimal point. */
function formatSeqNumber(value: number, width: number): string {
    let text: string;
    if (Number.isInteger(value)) text = String(value);
    else text = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    if (width > text.length && /^-?[0-9]+$/.test(text)) {
        const sign = text[0] === '-' ? '-' : '';
        const digits = sign === '' ? text : text.slice(1);
        text = sign + '0'.repeat(width - digits.length) + digits;
    }
    return text;
}

const seq: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let format: string | null = null;
    let separator = '\n';
    let equalWidth = false;
    let index = 0;
    while (index < words.length && isOption(words[index]) && !/^-[0-9.]/.test(words[index])) {
        const word = words[index];
        if (word === '-w') {
            equalWidth = true;
            index++;
        } else if (word === '-f') {
            format = words[index + 1];
            if (format === undefined) return fail('seq: option requires an argument -- f\nusage: seq [-w] [-f format] [-s string] [-t string] [first [incr]] last');
            index += 2;
        } else if (word === '-s') {
            const value = words[index + 1];
            if (value === undefined) return fail('seq: option requires an argument -- s\nusage: seq [-w] [-f format] [-s string] [-t string] [first [incr]] last');
            separator = decodeEscapes(value).text;
            index += 2;
        } else if (word === '--') {
            index++;
            break;
        } else {
            return fail(`seq: illegal option -- ${word.slice(1, 2)}\nusage: seq [-w] [-f format] [-s string] [-t string] [first [incr]] last`);
        }
    }
    const operands = words.slice(index).map((word) => Number(word));
    if (operands.length === 0 || operands.length > 3 || operands.some((value) => !Number.isFinite(value))) {
        return fail('usage: seq [-w] [-f format] [-s string] [-t string] [first [incr]] last');
    }
    let first = 1;
    let step = 1;
    let last: number;
    if (operands.length === 1) {
        last = operands[0];
    } else if (operands.length === 2) {
        first = operands[0];
        last = operands[1];
    } else {
        first = operands[0];
        step = operands[1];
        last = operands[2];
    }
    // BSD counts down when only the bounds are given and they descend
    if (operands.length <= 2 && first > last) step = -1;
    const values: number[] = [];
    if (step === 0) {
        if (first !== last) return ok('');
        values.push(first);
    } else if (step > 0) {
        for (let value = first; value <= last + step * 1e-9; value += step) values.push(value);
    } else {
        for (let value = first; value >= last + step * 1e-9; value += step) values.push(value);
    }
    let width = 0;
    if (equalWidth) {
        for (const value of values) {
            const text = formatSeqNumber(value, 0);
            width = Math.max(width, text.length);
        }
    }
    let out = '';
    for (let at = 0; at < values.length; at++) {
        if (format !== null) {
            const single = /%[-+# 0]*[0-9]*(?:\.[0-9]+)?[a-zA-Z]/.exec(format);
            if (single !== null) {
                out += format.slice(0, single.index) + applyConversion(single[0].slice(1), String(values[at])) + format.slice(single.index + single[0].length);
            } else {
                out += format;
            }
        } else {
            out += formatSeqNumber(values[at], width);
        }
        out += separator;
    }
    return ok(out);
};

/* ----------------------------------------------------------- yes and sleep */

/** A synchronous handler cannot write forever, so `yes` stops after this many lines. */
const YES_MAX_LINES = 65536;

const yes: ShellCommand = (ctx) => {
    // the host's yes repeats its first operand; POSIX repeats every operand joined by a space
    const text = ctx.args.length === 0 ? 'y' : ctx.args[0];
    let out = '';
    for (let line = 0; line < YES_MAX_LINES; line++) out += text + '\n';
    return ok(out);
};

const SLEEP_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

function parseDuration(word: string): number | undefined {
    const match = /^([+]?[0-9]*\.?[0-9]+)([smhd]?)$/.exec(word);
    if (match === null) return undefined;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) return undefined;
    return value * (SLEEP_UNITS[match[2] === '' ? 's' : match[2]] ?? 1);
}

/** Blocks for the given milliseconds without yielding, since a handler must not return early. */
function blockFor(ms: number): void {
    if (ms <= 0) return;
    try {
        const shared = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(shared, 0, 0, Math.ceil(ms));
        return;
    } catch {
        // Atomics.wait is unavailable on some runtimes; a busy wait is the only other option
    }
    const until = Date.now() + ms;
    while (Date.now() < until) {
        /* spin */
    }
}

const sleep: ShellCommand = (ctx) => {
    if (ctx.args.length === 0) {
        return fail('usage: sleep number[unit] [...]\nUnit can be \'s\' (seconds, the default), m (minutes), h (hours), or d (days).');
    }
    let total = 0;
    for (const word of ctx.args) {
        if (word.length > 1 && word[0] === '-') {
            return fail(`sleep: illegal option -- ${word.slice(1, 2)}\nusage: sleep number[unit] [...]\nUnit can be 's' (seconds, the default), m (minutes), h (hours), or d (days).`);
        }
        const seconds = parseDuration(word);
        if (seconds === undefined) {
            return fail(`sleep: invalid time interval: ${word}\nusage: sleep number[unit] [...]\nUnit can be 's' (seconds, the default), m (minutes), h (hours), or d (days).`);
        }
        total += seconds;
    }
    blockFor(Math.min(total, 86400) * 1000);
    return ok();
};

/* --------------------------------------------------------------------- date */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(value: number, width = 2): string {
    let text = String(Math.abs(value));
    while (text.length < width) text = '0' + text;
    return (value < 0 ? '-' : '') + text;
}

function startOfYearYear(date: Date, utc: boolean): number {
    // ISO week-numbering year: the Thursday of the week the day belongs to decides the year
    const probe = utc ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) : new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = (utc ? probe.getUTCDay() : probe.getDay()) || 7;
    probe.setUTCDate(probe.getUTCDate() + 4 - day);
    return utc ? probe.getUTCFullYear() : probe.getFullYear();
}

function isoWeek(date: Date, utc: boolean): number {
    const yearDay = utc ? getUtcDayOfYear(date) : getDayOfYear(date);
    const day = (utc ? date.getUTCDay() : date.getDay()) || 7;
    const week = Math.floor((yearDay - day + 10) / 7);
    if (week < 1) return 53;
    if (week > 52) {
        const last = Math.floor((yearDay - day + 10) / 7);
        return last === 53 ? 53 : 1;
    }
    return week;
}

function getDayOfYear(date: Date): number {
    const start = new Date(date.getFullYear(), 0, 0);
    return Math.floor((date.getTime() - start.getTime()) / 86400000);
}

function getUtcDayOfYear(date: Date): number {
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    return Math.floor((date.getTime() - start) / 86400000);
}

function weekOfYear(date: Date, utc: boolean): number {
    const yearDay = utc ? getUtcDayOfYear(date) : getDayOfYear(date);
    const firstDay = utc
        ? new Date(Date.UTC(date.getUTCFullYear(), 0, 1)).getUTCDay()
        : new Date(date.getFullYear(), 0, 1).getDay();
    return Math.floor((yearDay + firstDay) / 7) + (firstDay === 0 ? 1 : 0);
}

/** The short name of the zone the container was started in, or UTC under `-u`. */
function zoneName(date: Date, utc: boolean): string {
    if (utc) return 'UTC';
    try {
        const resolved = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(date);
        for (const part of resolved) if (part.type === 'timeZoneName') return part.value;
    } catch {
        /* fall through */
    }
    return 'UTC';
}

/** The `+HHMM` offset of local time, which is what `%z` prints. */
function zoneOffset(date: Date): string {
    const minutes = -date.getTimezoneOffset();
    const sign = minutes < 0 ? '-' : '+';
    const absolute = Math.abs(minutes);
    return sign + pad(Math.floor(absolute / 60)) + pad(absolute % 60);
}

function formatDate(date: Date, format: string, utc: boolean): string {
    const year = utc ? date.getUTCFullYear() : date.getFullYear();
    const month = utc ? date.getUTCMonth() : date.getMonth();
    const day = utc ? date.getUTCDate() : date.getDate();
    const hour = utc ? date.getUTCHours() : date.getHours();
    const minute = utc ? date.getUTCMinutes() : date.getMinutes();
    const second = utc ? date.getUTCSeconds() : date.getSeconds();
    const weekDay = utc ? date.getUTCDay() : date.getDay();
    let out = '';
    for (let i = 0; i < format.length; i++) {
        if (format[i] !== '%' || i + 1 >= format.length) {
            out += format[i];
            continue;
        }
        i++;
        const code = format[i];
        switch (code) {
            case '%': out += '%'; break;
            case 'a': out += DAY_NAMES[weekDay]; break;
            case 'A': out += DAY_LONG[weekDay]; break;
            case 'b': case 'h': out += MONTH_NAMES[month]; break;
            case 'B': out += MONTH_LONG[month]; break;
            case 'c': out += `${DAY_NAMES[weekDay]} ${MONTH_NAMES[month]} ${day <= 9 ? ' ' + day : day} ${pad(hour)}:${pad(minute)}:${pad(second)} ${year}`; break;
            case 'C': out += pad(Math.floor(year / 100)); break;
            case 'd': out += pad(day); break;
            case 'D': out += `${pad(month + 1)}/${pad(day)}/${pad(year % 100)}`; break;
            case 'e': out += day <= 9 ? ' ' + day : String(day); break;
            case 'F': out += `${year}-${pad(month + 1)}-${pad(day)}`; break;
            case 'G': out += startOfYearYear(date, utc); break;
            case 'g': out += pad(startOfYearYear(date, utc) % 100); break;
            case 'H': out += pad(hour); break;
            case 'I': out += pad(hour % 12 === 0 ? 12 : hour % 12); break;
            case 'j': out += pad(utc ? getUtcDayOfYear(date) : getDayOfYear(date), 3); break;
            case 'k': out += hour <= 9 ? ' ' + hour : String(hour); break;
            case 'l': { const h12 = hour % 12 === 0 ? 12 : hour % 12; out += h12 <= 9 ? ' ' + h12 : String(h12); break; }
            case 'm': out += pad(month + 1); break;
            case 'M': out += pad(minute); break;
            case 'n': out += '\n'; break;
            case 'N': out += pad(date.getMilliseconds(), 3) + '000000'; break;
            case 'p': out += hour < 12 ? 'AM' : 'PM'; break;
            case 'P': out += hour < 12 ? 'am' : 'pm'; break;
            case 'r': out += `${pad(hour % 12 === 0 ? 12 : hour % 12)}:${pad(minute)}:${pad(second)} ${hour < 12 ? 'AM' : 'PM'}`; break;
            case 'R': out += `${pad(hour)}:${pad(minute)}`; break;
            case 's': out += String(Math.floor(date.getTime() / 1000)); break;
            case 'S': out += pad(second); break;
            case 't': out += '\t'; break;
            case 'T': out += `${pad(hour)}:${pad(minute)}:${pad(second)}`; break;
            case 'u': out += String(weekDay === 0 ? 7 : weekDay); break;
            case 'U': out += pad(weekOfYear(date, utc)); break;
            case 'V': out += pad(isoWeek(date, utc)); break;
            case 'w': out += String(weekDay); break;
            case 'W': out += pad(weekOfYear(date, utc)); break;
            case 'x': out += `${pad(month + 1)}/${pad(day)}/${pad(year % 100)}`; break;
            case 'X': out += `${pad(hour)}:${pad(minute)}:${pad(second)}`; break;
            case 'y': out += pad(year % 100); break;
            case 'Y': out += String(year); break;
            case 'z': out += utc ? '+0000' : zoneOffset(date); break;
            case 'Z': out += zoneName(date, utc); break;
            default: out += '%' + code; break;
        }
    }
    return out;
}

const RELATIVE_UNITS: Record<string, number> = {
    second: 1, seconds: 1, sec: 1, s: 1,
    minute: 60, minutes: 60, min: 60,
    hour: 3600, hours: 3600, h: 3600,
    day: 86400, days: 86400, d: 86400,
    week: 604800, weeks: 604800, w: 604800
};

/** Parses the argument of GNU `date -d`: an epoch, an ISO timestamp, or relative terms. */
function parseDateSpec(spec: string, now: number): number | undefined {
    const text = spec.trim();
    if (text === '' || text === 'now') return now;
    const epoch = /^@(-?[0-9]+(?:\.[0-9]+)?)$/.exec(text);
    if (epoch !== null) return Math.floor(Number(epoch[1]) * 1000);
    const iso = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[ T]([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$/.exec(text);
    if (iso !== null) {
        const year = Number(iso[1]);
        const month = Number(iso[2]) - 1;
        const day = Number(iso[3]);
        const hour = iso[4] === undefined ? 0 : Number(iso[4]);
        const minute = iso[5] === undefined ? 0 : Number(iso[5]);
        const second = iso[6] === undefined ? 0 : Number(iso[6]);
        const zone = iso[7];
        if (zone === undefined || zone === 'Z') {
            return Date.UTC(year, month, day, hour, minute, second);
        }
        const sign = zone[0] === '-' ? -1 : 1;
        const digits = zone.slice(1).replace(':', '');
        const offset = sign * (Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2)) * 60);
        return Date.UTC(year, month, day, hour, minute, second) - offset * 1000;
    }
    // relative terms: "+1 day", "-2 hours", "3 weeks ago"
    let value = now;
    let matched = false;
    const terms = text.split(/\s+/);
    for (let i = 0; i < terms.length; i++) {
        const term = terms[i];
        const ago = term.toLowerCase() === 'ago';
        if (ago) continue;
        const match = /^([+-]?)([0-9]+)\s*([a-zA-Z]+)$/.exec(term);
        if (match === null) return undefined;
        const unit = RELATIVE_UNITS[match[3].toLowerCase()];
        if (unit === undefined) return undefined;
        const count = Number(match[2]);
        const sign = match[1] === '-' || (terms[i + 1] !== undefined && terms[i + 1].toLowerCase() === 'ago') ? -1 : 1;
        value += sign * count * unit * 1000;
        matched = true;
    }
    return matched ? value : undefined;
}

const DATE_USAGE =
    'usage: date [-jnRu] [-I[date|hours|minutes|seconds|ns]] [-f input_fmt]\n' +
    '            [ -z output_zone ] [-r filename|seconds] [-v[+|-]val[y|m|w|d|H|M|S]]\n' +
    '            [[[[mm]dd]HH]MM[[cc]yy][.SS] | new_date] [+output_fmt]\n';

const date: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let utc = false;
    let format: string | null = null;
    let spec: string | null = null;
    let seconds: number | null = null;
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        if (word.startsWith('+')) {
            format = word.slice(1);
            index++;
            break;
        }
        if (word === '-u') {
            utc = true;
            index++;
        } else if (word === '-d') {
            spec = words[index + 1];
            if (spec === undefined) return fail('date: option requires an argument -- d\n' + DATE_USAGE);
            index += 2;
        } else if (word === '-r') {
            const value = words[index + 1];
            const parsed = value === undefined ? Number.NaN : Number(value);
            if (!Number.isFinite(parsed)) return fail(`date: invalid seconds: ${value ?? ''}\n` + DATE_USAGE);
            seconds = parsed;
            index += 2;
        } else if (word === '-j' || word === '-n' || word === '-R') {
            index++;
        } else if (word === '--') {
            index++;
            break;
        } else if (isOption(word)) {
            return fail(`date: illegal option -- ${word.slice(1, 2)}\n${DATE_USAGE}`);
        } else {
            return fail(DATE_USAGE);
        }
    }
    const now = Date.now();
    let time: number;
    if (seconds !== null) time = seconds * 1000;
    else if (spec !== null) {
        const parsed = parseDateSpec(spec, now);
        if (parsed === undefined) return fail(`date: invalid date: ${spec}\n${DATE_USAGE}`);
        time = parsed;
    } else time = now;
    const moment = new Date(time);
    if (Number.isNaN(moment.getTime())) return fail(`date: invalid date\n${DATE_USAGE}`);
    const used = format === null ? '%a %b %e %H:%M:%S %Z %Y' : format;
    return ok(formatDate(moment, used, utc) + '\n');
};

/* ---------------------------------------------------------------------- tee */

const tee: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let append = false;
    const files: string[] = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (word === '-a' || word === '--append') append = true;
        else if (word === '-i' || word === '--ignore-interrupts') continue;
        else if (word === '--') continue;
        else if (isOption(word)) return fail(`tee: illegal option -- ${word.slice(1, 2)}\nusage: tee [-ai] [file ...]`);
        else files.push(word);
    }
    const text = ctx.input ?? '';
    if (files.length === 0) return ok(text);
    for (const file of files) {
        const path = resolveAt(ctx, file);
        try {
            if (append) {
                const previous = readFileOrNone(ctx.fs, path);
                ctx.fs.writeFile(path, (previous ?? '') + text);
            } else {
                ctx.fs.writeFile(path, text);
            }
        } catch (error) {
            return fail(`tee: ${file}: ${message(error)}`);
        }
    }
    return ok(text);
};

/* ---------------------------------------------------------- base64 / base32 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const BASE64_REVERSE: Record<string, number> = {};
for (let i = 0; i < BASE64_ALPHABET.length; i++) BASE64_REVERSE[BASE64_ALPHABET[i]] = i;
const BASE32_REVERSE: Record<string, number> = {};
for (let i = 0; i < BASE32_ALPHABET.length; i++) BASE32_REVERSE[BASE32_ALPHABET[i]] = i;

/** The UTF-8 bytes of a string, which is how the text-typed standard input reaches a command. */
function utf8Bytes(text: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
        let code = text.charCodeAt(i);
        if (code < 0x80) {
            out.push(code);
        } else if (code < 0x800) {
            out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const low = text.charCodeAt(i + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
                const point = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                out.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
                i++;
            } else {
                out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
            }
        } else {
            out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
    }
    return out;
}

/**
 * The text of bytes. Bytes that are not valid UTF-8 are kept as the characters they stand for, so
 * binary data survives a round trip through the text-typed standard input.
 */
function utf8Text(bytes: number[]): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i] & 0xff;
        if (byte < 0x80) {
            out += String.fromCharCode(byte);
            continue;
        }
        if (byte >= 0xc2 && byte <= 0xdf && i + 1 < bytes.length) {
            out += String.fromCodePoint(((byte & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
            i += 1;
            continue;
        }
        if (byte >= 0xe0 && byte <= 0xef && i + 2 < bytes.length) {
            out += String.fromCodePoint(((byte & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
            i += 2;
            continue;
        }
        if (byte >= 0xf0 && byte <= 0xf4 && i + 3 < bytes.length) {
            const point = ((byte & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
            out += String.fromCodePoint(point);
            i += 3;
            continue;
        }
        out += String.fromCharCode(byte);
    }
    return out;
}

function readInputBytes(ctx: CommandContext, file: string | null): number[] | undefined {
    if (file === null || file === '-') return utf8Bytes(ctx.input ?? '');
    const path = resolveAt(ctx, file);
    const raw = ctx.fs.readBytes(path);
    if (raw === undefined) return undefined;
    return Array.from(raw);
}

function base64Encode(bytes: number[]): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        out += BASE64_ALPHABET[b0 >> 2];
        out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
        out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
        out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f];
    }
    return out;
}

function base32Encode(bytes: number[]): string {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    while (out.length % 8 !== 0) out += '=';
    return out;
}

function wrap(text: string, columns: number): string {
    if (columns <= 0) return text;
    let out = '';
    for (let i = 0; i < text.length; i += columns) {
        out += text.slice(i, i + columns) + '\n';
    }
    return out;
}

/**
 * Decodes base64. The host's base64 prints nothing when the stream holds a character outside the
 * alphabet, rather than reporting an error, so this does the same.
 */
function decodeBase64(text: string): number[] {
    for (const ch of text) {
        if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t' || ch === '=') continue;
        if (BASE64_REVERSE[ch] === undefined) return [];
    }
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of text) {
        if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') continue;
        if (ch === '=') break;
        const digit = BASE64_REVERSE[ch];
        if (digit === undefined) continue;
        value = (value << 6) | digit;
        bits += 6;
        while (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return out;
}

/** Decodes base32, which is strict: a character outside the alphabet is an error. */
function decodeBase32(text: string): number[] | undefined {
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    let seen = 0;
    for (const ch of text) {
        if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') continue;
        if (ch === '=') break;
        const digit = BASE32_REVERSE[ch];
        if (digit === undefined) return undefined;
        value = (value << 5) | digit;
        bits += 5;
        seen++;
        while (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    const remainder = seen % 8;
    if (remainder === 1 || remainder === 3 || remainder === 6) return undefined;
    return out;
}

interface CodecOptions {
    decode: boolean;
    wrap: number;
    input: string | null;
}

/** Reads the options `base64` and `base32` share. `-b` is the BSD spelling of `-w`. */
function readCodecOptions(ctx: CommandContext, name: string, decodeFlags: string[]): { options: CodecOptions } | { error: CommandResult } {
    const words = ctx.args.slice();
    const options: CodecOptions = { decode: false, wrap: name === 'base32' ? 76 : 0, input: null };
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        if (decodeFlags.indexOf(word) >= 0) {
            options.decode = true;
            index++;
        } else if (word === '-w' || word === '-b') {
            const value = words[index + 1];
            const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed < 0) return { error: fail(`${name}: invalid wrap width: ${value ?? ''}`) };
            options.wrap = parsed;
            index += 2;
        } else if (word === '-i') {
            const value = words[index + 1];
            if (value === undefined) return { error: fail(`${name}: option requires an argument -- i`) };
            options.input = value;
            index += 2;
        } else if (word === '--') {
            index++;
            break;
        } else if (isOption(word)) {
            return { error: fail(`${name}: illegal option -- ${word.slice(1, 2)}\nusage: ${name} [-d] [-w columns] [-i file] [file]`) };
        } else {
            options.input = word;
            index++;
        }
    }
    return { options };
}

const base64: ShellCommand = (ctx) => {
    const read = readCodecOptions(ctx, 'base64', ['-d', '-D', '--decode']);
    if ('error' in read) return read.error;
    const { options } = read;
    const bytes = readInputBytes(ctx, options.input);
    if (bytes === undefined) return fail(`base64: ${options.input}: No such file or directory`);
    if (options.decode) {
        const decoded = decodeBase64(utf8Text(bytes));
        return ok(utf8Text(decoded));
    }
    const encoded = wrap(base64Encode(bytes), options.wrap);
    return ok(encoded.endsWith('\n') ? encoded : encoded + '\n');
};

const base32: ShellCommand = (ctx) => {
    const read = readCodecOptions(ctx, 'base32', ['-d', '-D', '--decode']);
    if ('error' in read) return read.error;
    const { options } = read;
    const bytes = readInputBytes(ctx, options.input);
    if (bytes === undefined) return fail(`base32: ${options.input}: No such file or directory`);
    if (options.decode) {
        const decoded = decodeBase32(utf8Text(bytes));
        if (decoded === undefined) return fail('base32: invalid input');
        return ok(utf8Text(decoded));
    }
    return ok(wrap(base32Encode(bytes), options.wrap));
};

/* ---------------------------------------------------------------------- xxd */

function hexDigits(text: string, from: number): number {
    let value = 0;
    for (let i = from; i < from + 2 && i < text.length; i++) {
        const digit = Number.parseInt(text[i], 16);
        if (Number.isNaN(digit)) break;
        value = value * 16 + digit;
    }
    return value;
}

function toHex(value: number, width: number): string {
    let text = value.toString(16);
    while (text.length < width) text = '0' + text;
    return text;
}

const xxd: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let reverse = false;
    let plain = false;
    let length: number | null = null;
    let skip = 0;
    let group = 2;
    let columns = 0;
    let include = false;
    const files: string[] = [];
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        const value = words[index + 1];
        if (word === '-r' || word === '-revert') { reverse = true; index++; }
        else if (word === '-p' || word === '-ps' || word === '-plain') { plain = true; index++; }
        else if (word === '-i' || word === '-include') { include = true; index++; }
        else if (word === '-l' || word === '-len') {
            const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 0);
            if (!Number.isFinite(parsed)) return fail(`xxd: invalid length: ${value ?? ''}`);
            length = parsed;
            index += 2;
        } else if (word === '-s' || word === '-seek') {
            const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 0);
            if (!Number.isFinite(parsed)) return fail(`xxd: invalid offset: ${value ?? ''}`);
            skip = parsed;
            index += 2;
        } else if (word === '-g' || word === '-group') {
            const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 0);
            if (!Number.isFinite(parsed)) return fail(`xxd: invalid group size: ${value ?? ''}`);
            group = parsed;
            index += 2;
        } else if (word === '-c' || word === '-cols') {
            const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 0);
            if (!Number.isFinite(parsed)) return fail(`xxd: invalid column count: ${value ?? ''}`);
            columns = parsed;
            index += 2;
        } else if (word === '--') { index++; }
        else if (isOption(word)) return fail(`xxd: illegal option -- ${word.slice(1, 2)}\nusage: xxd [options] [file ...]`);
        else { files.push(word); index++; }
    }
    if (group <= 0) group = 1;
    const width = columns > 0 ? columns : (plain ? 30 : 16);

    let bytes: number[];
    if (files.length === 0 || files[0] === '-') {
        bytes = utf8Bytes(ctx.input ?? '');
    } else {
        const raw = ctx.fs.readBytes(resolveAt(ctx, files[0]));
        if (raw === undefined) return fail(`xxd: ${files[0]}: No such file or directory`, 2);
        bytes = Array.from(raw);
    }

    if (reverse) {
        const text = utf8Text(bytes);
        const out: number[] = [];
        if (plain) {
            for (let i = 0; i < text.length; i += 2) {
                if (/\s/.test(text[i] ?? '')) continue;
                const digit = Number.parseInt(text.slice(i, i + 2), 16);
                if (Number.isNaN(digit)) break;
                out.push(digit);
            }
        } else {
            for (const line of text.split('\n')) {
                let body = line.replace(/^\s*[0-9a-fA-F]+:\s?/, '');
                const gap = body.search(/  \S/);
                if (gap >= 0) body = body.slice(0, gap);
                let i = 0;
                while (i < body.length) {
                    if (/\s/.test(body[i])) { i++; continue; }
                    const digit = Number.parseInt(body.slice(i, i + 2), 16);
                    if (Number.isNaN(digit)) break;
                    out.push(digit);
                    i += 2;
                }
            }
        }
        if (include) return ok('');
        return ok(utf8Text(out));
    }

    if (skip < 0) skip = Math.max(0, bytes.length + skip);
    let slice = bytes.slice(skip);
    if (length !== null && length >= 0) slice = slice.slice(0, length);

    if (include) {
        const symbol = (files[0] ?? 'stdin').split('/').pop()?.replace(/[^A-Za-z0-9]/g, '_') ?? 'stdin';
        let out = `unsigned char ${symbol}[] = {\n  `;
        out += slice.map((byte) => '0x' + toHex(byte, 2)).join(', ');
        out += `\n};\nunsigned int ${symbol}_len = ${slice.length};\n`;
        return ok(out);
    }

    let out = '';
    if (plain) {
        for (let i = 0; i < slice.length; i += width) {
            let line = '';
            for (const byte of slice.slice(i, i + width)) line += toHex(byte, 2);
            out += line + '\n';
        }
        return ok(out);
    }
    for (let offset = 0; offset < slice.length; offset += width) {
        const row = slice.slice(offset, offset + width);
        let hex = '';
        for (let i = 0; i < row.length; i += group) {
            if (i > 0) hex += ' ';
            for (const byte of row.slice(i, i + group)) hex += toHex(byte, 2);
        }
        let ascii = '';
        for (const byte of row) ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
        const hexWidth = width * 2 + Math.ceil(width / group) - 1;
        const padded = hex.padEnd(hexWidth) + '  ';
        out += toHex(offset + skip, 8) + ': ' + padded + ascii + '\n';
    }
    return ok(out);
};

/* -------------------------------------------------------------------- split */

/** The suffix of one chunk: `aa`, `ab`, ... or `00`, `01`, ... under `-d`. */
function suffixAt(index: number, length: number, numeric: boolean): string {
    if (numeric) {
        let text = String(index);
        while (text.length < length) text = '0' + text;
        return text;
    }
    let needed = length;
    while (index >= Math.pow(26, needed)) needed++;
    let value = index;
    let text = '';
    for (let at = 0; at < needed; at++) {
        text = String.fromCharCode(97 + (value % 26)) + text;
        value = Math.floor(value / 26);
    }
    return text;
}

function parseSize(text: string): number | undefined {
    const match = /^([0-9]+)([bkmgKMG]?)$/.exec(text);
    if (match === null) return undefined;
    const multipliers: Record<string, number> = { '': 1, b: 512, k: 1024, K: 1024, m: 1048576, M: 1048576, g: 1073741824, G: 1073741824 };
    return Number(match[1]) * (multipliers[match[2]] ?? 1);
}

const split: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let lines = 0;
    let bytes: number | null = null;
    let numeric = false;
    let suffixLength = 2;
    const operands: string[] = [];
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        const value = words[index + 1];
        if (word === '-l') {
            const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed < 1) return fail(`split: invalid number of lines: ${value ?? ''}`);
            lines = parsed;
            index += 2;
        } else if (word === '-b') {
            const parsed = value === undefined ? undefined : parseSize(value);
            if (parsed === undefined) return fail(`split: ${value ?? ''}: byte count is invalid`, 64);
            bytes = parsed;
            index += 2;
        } else if (word === '-a') {
            const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed < 1) return fail(`split: invalid suffix length: ${value ?? ''}`);
            suffixLength = parsed;
            index += 2;
        } else if (word === '-d') {
            numeric = true;
            index++;
        } else if (word === '--') {
            index++;
            while (index < words.length) operands.push(words[index++]);
        } else if (isOption(word)) {
            return fail(`split: illegal option -- ${word.slice(1, 2)}\nusage: split [-a suffix_length] [-b byte_count] [-l line_count] [-d] [file [prefix]]`);
        } else {
            operands.push(word);
            index++;
        }
    }
    if (operands.length > 2) {
        return fail('usage: split [-a suffix_length] [-b byte_count] [-l line_count] [-d] [file [prefix]]');
    }
    const inputName = operands.length > 0 ? operands[0] : '-';
    const prefix = operands.length > 1 ? operands[1] : 'x';
    let text: string;
    if (inputName === '-') {
        text = ctx.input ?? '';
    } else {
        const content = readFileOrNone(ctx.fs, resolveAt(ctx, inputName));
        if (content === undefined) return fail(`split: ${inputName}: No such file or directory`, 66);
        text = content;
    }
    const chunks: string[] = [];
    if (bytes !== null) {
        const data = utf8Bytes(text);
        if (data.length === 0) chunks.push('');
        for (let i = 0; i < data.length; i += bytes) chunks.push(utf8Text(data.slice(i, i + bytes)));
    } else {
        const count = lines > 0 ? lines : 1000;
        const parts = text.split('\n');
        const endsWithNewline = text.endsWith('\n');
        let current: string[] = [];
        for (let i = 0; i < parts.length; i++) {
            const isLast = i === parts.length - 1;
            if (isLast && parts[i] === '') break;
            current.push(parts[i]);
            if (current.length >= count) {
                const last = isLast && !endsWithNewline;
                chunks.push(current.join('\n') + (last ? '' : '\n'));
                current = [];
            }
        }
        if (current.length > 0) chunks.push(current.join('\n') + (endsWithNewline ? '\n' : ''));
    }
    for (let at = 0; at < chunks.length; at++) {
        const name = prefix + suffixAt(at, suffixLength, numeric);
        try {
            ctx.fs.writeFile(resolveAt(ctx, name), chunks[at]);
        } catch (error) {
            return fail(`split: ${name}: ${message(error)}`);
        }
    }
    return ok();
};

/* --------------------------------------------------------------------- stat */

/** The permission string of a mode, as `ls -l` and `%A` print it. */
function permissionString(mode: number, type: 'file' | 'dir' | 'link'): string {
    const letters = type === 'dir' ? 'd' : type === 'link' ? 'l' : '-';
    const triplets = [(mode >> 6) & 7, (mode >> 3) & 7, mode & 7];
    let out = letters;
    for (const triplet of triplets) {
        out += (triplet & 4) !== 0 ? 'r' : '-';
        out += (triplet & 2) !== 0 ? 'w' : '-';
        out += (triplet & 1) !== 0 ? 'x' : '-';
    }
    if ((mode & 0o4000) !== 0) out = out.slice(0, 3) + (out[3] === 'x' ? 's' : 'S') + out.slice(4);
    if ((mode & 0o2000) !== 0) out = out.slice(0, 6) + (out[6] === 'x' ? 's' : 'S') + out.slice(7);
    if ((mode & 0o1000) !== 0) out = out.slice(0, 9) + (out[9] === 'x' ? 't' : 'T') + out.slice(10);
    return out;
}

const TYPE_NAMES: Record<string, string> = { file: 'regular file', dir: 'directory', link: 'symbolic link' };

interface StatInfo {
    name: string;
    shown: string;
    type: 'file' | 'dir' | 'link';
    size: number;
    mode: number;
    uid: number;
    gid: number;
    inode: number;
    nlink: number;
    atimeMs: number;
    mtimeMs: number;
    ctimeMs: number;
    birthMs: number;
    blocks: number;
}

/** The name of an owner, which the container can only answer for the ids it knows. */
function nameOfId(id: number, table: Record<string, number>): string {
    for (const name of Object.keys(table)) if (table[name] === id) return name;
    return String(id);
}

/** Everything `stat` can report, invented where the file system has no such thing. */
function statInfo(ctx: CommandContext, argument: string): StatInfo | undefined {
    const path = resolveAt(ctx, argument);
    const stat = statOf(ctx.fs, path);
    if (stat === undefined) return undefined;
    const link = isSymlink(ctx.fs, path);
    const type: 'file' | 'dir' | 'link' = link ? 'link' : stat.type;
    const mode = modeOf(ctx.fs, path, stat.type === 'dir');
    const owner = ownerOf(ctx.fs, path);
    const typeBits = type === 'dir' ? 0o40000 : type === 'link' ? 0o120000 : 0o100000;
    return {
        name: argument,
        shown: argument,
        type,
        size: stat.size,
        mode: typeBits | mode,
        uid: owner.uid,
        gid: owner.gid,
        inode: inodeOf(ctx.fs, path),
        nlink: linksOf(ctx.fs, path),
        atimeMs: stat.mtimeMs,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.mtimeMs,
        birthMs: stat.mtimeMs,
        blocks: stat.type === 'dir' ? 0 : Math.ceil(stat.size / 4096) * 8
    };
}

function statTime(ms: number, format: string, utc: boolean): string {
    const date = new Date(ms);
    return formatDate(date, format, utc);
}

/** GNU `stat -c`, which the BSD host does not have. */
function formatGnu(info: StatInfo, format: string, utc: boolean): string {
    let out = '';
    for (let i = 0; i < format.length; i++) {
        if (format[i] !== '%' || i + 1 >= format.length) {
            if (format[i] === '\\') {
                const decoded = decodeEscapes(format.slice(i));
                out += decoded.text;
                i += decoded.text === format.slice(i) ? 1 : 1;
                continue;
            }
            out += format[i];
            continue;
        }
        i++;
        switch (format[i]) {
            case '%': out += '%'; break;
            case 'n': out += info.name; break;
            case 'N': out += `'${info.name}'`; break;
            case 's': out += String(info.size); break;
            case 'a': out += (info.mode & 0o7777).toString(8).padStart(3, '0'); break;
            case 'A': out += permissionString(info.mode, info.type); break;
            case 'f': out += toHex(info.mode, 4); break;
            case 'F': out += TYPE_NAMES[info.type]; break;
            case 'm': out += (info.mode & 0o7777).toString(8); break;
            case 'u': out += String(info.uid); break;
            case 'U': out += String(info.uid); break;
            case 'g': out += String(info.gid); break;
            case 'G': out += String(info.gid); break;
            case 'i': out += String(info.inode); break;
            case 'd': out += '1'; break;
            case 'D': out += '1'; break;
            case 'h': out += String(info.nlink); break;
            case 't': out += '0'; break;
            case 'T': out += '0'; break;
            case 'b': out += String(info.blocks); break;
            case 'B': out += '512'; break;
            case 'o': out += '4096'; break;
            case 'y': out += statTime(info.mtimeMs, '%Y-%m-%d %H:%M:%S', utc); break;
            case 'Y': out += String(Math.floor(info.mtimeMs / 1000)); break;
            case 'x': out += statTime(info.atimeMs, '%Y-%m-%d %H:%M:%S', utc); break;
            case 'X': out += String(Math.floor(info.atimeMs / 1000)); break;
            case 'z': out += statTime(info.ctimeMs, '%Y-%m-%d %H:%M:%S', utc); break;
            case 'Z': out += String(Math.floor(info.ctimeMs / 1000)); break;
            case 'w': out += statTime(info.birthMs, '%Y-%m-%d %H:%M:%S', utc); break;
            case 'W': out += String(Math.floor(info.birthMs / 1000)); break;
            default: out += '%' + format[i]; break;
        }
    }
    return out;
}

/** BSD `stat -f`, which is the format the host speaks. */
function formatBsd(info: StatInfo, format: string, timeFormat: string): string {
    let out = '';
    for (let i = 0; i < format.length; i++) {
        if (format[i] !== '%' || i + 1 >= format.length) {
            out += format[i];
            continue;
        }
        i++;
        const code = format[i];
        if (code === '%') {
            out += '%';
            continue;
        }
        if (code === 'S') {
            i++;
            const sub = format[i];
            if (sub === 'p') out += permissionString(info.mode, info.type);
            else if (sub === 'u') out += String(info.uid);
            else if (sub === 'g') out += String(info.gid);
            else out += '%S' + (sub ?? '');
            continue;
        }
        switch (code) {
            case 'N': out += info.name; break;
            case 'n': out += info.name; break;
            case 'z': out += String(info.size); break;
            case 'p': out += info.mode.toString(8); break;
            case 'a': out += String(Math.floor(info.atimeMs / 1000)); break;
            case 'm': out += String(Math.floor(info.mtimeMs / 1000)); break;
            case 'c': out += String(Math.floor(info.ctimeMs / 1000)); break;
            case 'B': out += String(Math.floor(info.birthMs / 1000)); break;
            case 'i': out += String(info.inode); break;
            case 'd': out += '1'; break;
            case 'u': out += String(info.uid); break;
            case 'g': out += String(info.gid); break;
            case 'l': out += String(info.nlink); break;
            case 'k': out += '4096'; break;
            case 'b': out += String(info.blocks); break;
            case 'f': out += '0'; break;
            case 't': out += String(info.mtimeMs); break;
            case 'T': out += info.type === 'dir' ? 'd' : info.type === 'link' ? 'l' : 'f'; break;
            case 'Y': out += statTime(info.mtimeMs, timeFormat, false); break;
            default: out += '%' + code; break;
        }
    }
    return out;
}

const stat: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let gnuFormat: string | null = null;
    let bsdFormat: string | null = null;
    let timeFormat = '%b %e %H:%M:%S %Y';
    let wide = false;
    let raw = false;
    let shell = false;
    let quiet = false;
    let newline = true;
    const files: string[] = [];
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        const value = words[index + 1];
        if (word === '-c' || word === '--format' || word === '--printf') {
            if (value === undefined) return fail('stat: option requires an argument -- c\nusage: stat [-FLnq] [-f format | -l | -r | -s | -x] [-t timefmt] [file ...]');
            gnuFormat = value;
            if (word === '--printf') newline = false;
            index += 2;
        } else if (word === '-f') {
            if (value === undefined) return fail('stat: option requires an argument -- f\nusage: stat [-FLnq] [-f format | -l | -r | -s | -x] [-t timefmt] [file ...]');
            bsdFormat = value;
            index += 2;
        } else if (word === '-t') {
            if (value === undefined) return fail('stat: option requires an argument -- t\nusage: stat [-FLnq] [-f format | -l | -r | -s | -x] [-t timefmt] [file ...]');
            timeFormat = value;
            index += 2;
        } else if (word === '-x') { wide = true; index++; }
        else if (word === '-r') { raw = true; index++; }
        else if (word === '-s') { shell = true; index++; }
        else if (word === '-q') { quiet = true; index++; }
        else if (word === '-n') { newline = false; index++; }
        else if (word === '-L' || word === '-F') { index++; }
        else if (word === '--') { index++; }
        else if (isOption(word)) return fail(`stat: illegal option -- ${word.slice(1, 2)}\nusage: stat [-FLnq] [-f format | -l | -r | -s | -x] [-t timefmt] [file ...]`);
        else { files.push(word); index++; }
    }
    if (files.length === 0) return fail('usage: stat [-FLnq] [-f format | -l | -r | -s | -x] [-t timefmt] [file ...]');

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    const separator = newline ? '\n' : '';
    for (const file of files) {
        const info = statInfo(ctx, file);
        if (info === undefined) {
            stderr += `stat: ${file}: stat: No such file or directory${newline ? '\n' : ''}`;
            exitCode = 1;
            continue;
        }
        if (gnuFormat !== null) {
            stdout += formatGnu(info, gnuFormat, false) + separator;
        } else if (bsdFormat !== null) {
            stdout += formatBsd(info, bsdFormat, timeFormat) + separator;
        } else if (wide) {
            stdout +=
                `  File: "${info.name}"\n` +
                `  Size: ${info.size}${' '.repeat(Math.max(1, 12 - String(info.size).length))}FileType: ${info.type === 'dir' ? 'Directory' : info.type === 'link' ? 'Symbolic Link' : 'Regular File'}\n` +
                `  Mode: (${(info.mode & 0o7777).toString(8).padStart(4, '0')}/${permissionString(info.mode, info.type)})         Uid: (${String(info.uid).padStart(5)}/${nameOfId(info.uid, USER_NAMES)})  Gid: (${String(info.gid).padStart(5)}/${nameOfId(info.gid, GROUP_NAMES)})\n` +
                `Device: 1,1   Inode: ${info.inode}    Links: ${info.nlink}\n` +
                `Access: ${statTime(info.atimeMs, '%a %b %e %H:%M:%S %Y', false)}\n` +
                `Modify: ${statTime(info.mtimeMs, '%a %b %e %H:%M:%S %Y', false)}\n` +
                `Change: ${statTime(info.ctimeMs, '%a %b %e %H:%M:%S %Y', false)}\n` +
                ` Birth: ${statTime(info.birthMs, '%a %b %e %H:%M:%S %Y', false)}\n`;
        } else if (raw) {
            stdout +=
                `${1} ${info.inode} ${info.mode.toString(8)} ${info.nlink} ${info.uid} ${info.gid} ${0} ${info.size} ` +
                `"${statTime(info.atimeMs, timeFormat, false)}" "${statTime(info.mtimeMs, timeFormat, false)}" ` +
                `"${statTime(info.ctimeMs, timeFormat, false)}" "${statTime(info.birthMs, timeFormat, false)}" ` +
                `4096 ${info.blocks} 0 ${info.name}\n`;
        } else if (shell) {
            stdout +=
                `st_dev=1 st_ino=${info.inode} st_mode=0${info.mode.toString(8)} st_nlink=${info.nlink} ` +
                `st_uid=${info.uid} st_gid=${info.gid} st_rdev=0 st_size=${info.size} ` +
                `st_atime=${Math.floor(info.atimeMs / 1000)} st_mtime=${Math.floor(info.mtimeMs / 1000)} ` +
                `st_ctime=${Math.floor(info.ctimeMs / 1000)} st_birthtime=${Math.floor(info.birthMs / 1000)} ` +
                `st_blksize=4096 st_blocks=${info.blocks} st_flags=0\n`;
        } else {
            const quoted = (text: string): string => `"${text}"`;
            stdout +=
                `${1} ${info.inode} ${permissionString(info.mode, info.type)} ${info.nlink} ${nameOfId(info.uid, USER_NAMES)} ${nameOfId(info.gid, GROUP_NAMES)} ${0} ${info.size} ` +
                `${quoted(statTime(info.atimeMs, timeFormat, false))} ${quoted(statTime(info.mtimeMs, timeFormat, false))} ` +
                `${quoted(statTime(info.ctimeMs, timeFormat, false))} ${quoted(statTime(info.birthMs, timeFormat, false))} ` +
                `4096 ${info.blocks} 0 ${info.name}\n`;
        }
    }
    return result(stdout, quiet ? '' : stderr, exitCode);
};

/* --------------------------------------------------------- install / links */

/** Parses an octal or symbolic mode. Symbolic clauses start from `base`, which is 0 for install. */
function parseMode(spec: string, base: number): number | undefined {
    if (/^[0-7]{1,4}$/.test(spec)) return Number.parseInt(spec, 8) & 0o7777;
    let mode = base;
    for (const clause of spec.split(',')) {
        if (clause === '') return undefined;
        const match = /^([ugoa]*)([+-=])([rwxXstugo]*)$/.exec(clause);
        if (match === null) return undefined;
        let who = match[1] === '' ? 'a' : match[1];
        if (who.indexOf('a') >= 0) who = 'ugo';
        const operation = match[2];
        const perms = match[3];
        let bits = 0;
        for (const letter of perms) {
            if (letter === 'r') bits |= 0o444;
            else if (letter === 'w') bits |= 0o222;
            else if (letter === 'x') bits |= 0o111;
            else if (letter === 'X') bits |= 0o111;
            else if (letter === 's') bits |= 0o6000;
            else if (letter === 't') bits |= 0o1000;
            else if (letter === 'u') bits |= (mode >> 6) & 7;
            else if (letter === 'g') bits |= (mode >> 3) & 7;
            else if (letter === 'o') bits |= mode & 7;
            else return undefined;
        }
        let mask = 0;
        if (who.indexOf('u') >= 0) mask |= bits & 0o4700;
        if (who.indexOf('g') >= 0) mask |= bits & 0o2070;
        if (who.indexOf('o') >= 0) mask |= bits & 0o1007;
        if (operation === '=') {
            let clear = 0;
            if (who.indexOf('u') >= 0) clear |= 0o4700;
            if (who.indexOf('g') >= 0) clear |= 0o2070;
            if (who.indexOf('o') >= 0) clear |= 0o1007;
            mode = (mode & ~clear) | mask;
        } else if (operation === '+') {
            mode |= mask;
        } else {
            mode &= ~mask;
        }
    }
    return mode & 0o7777;
}

const INSTALL_USAGE =
    'usage: install [-bCcpSsUv] [-f flags] [-g group] [-m mode] [-o owner]\n' +
    '               [-M log] [-D dest] [-h hash] [-T tags]\n' +
    '               [-B suffix] [-l linkflags] [-N dbdir]\n' +
    '               file1 file2\n' +
    '       install [-bCcpSsUv] [-f flags] [-g group] [-m mode] [-o owner]\n' +
    '               [-M log] [-D dest] [-h hash] [-T tags]\n' +
    '               [-B suffix] [-l linkflags] [-N dbdir]\n' +
    '               file1 ... fileN directory\n' +
    '       install -dU [-vU] [-g group] [-m mode] [-N dbdir] [-o owner]\n' +
    '               [-M log] [-D dest] [-h hash] [-T tags]\n' +
    '               directory ...\n';

const install: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let makeDirs = false;
    let mode: number | null = null;
    const operands: string[] = [];
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        const value = words[index + 1];
        if (word === '-d') { makeDirs = true; index++; }
        else if (word === '-m') {
            if (value === undefined) return fail('install: option requires an argument -- m\n' + INSTALL_USAGE);
            const parsed = parseMode(value, 0);
            if (parsed === undefined) return fail(`install: invalid file mode: ${value}`, 64);
            mode = parsed;
            index += 2;
        } else if (word === '-o' || word === '-g') {
            index += 2;
        } else if (word === '-v' || word === '-p' || word === '-c' || word === '-C' || word === '-S' || word === '-s' || word === '-b' || word === '-U') {
            index++;
        } else if (word === '--') { index++; }
        else if (isOption(word)) return fail(`install: illegal option -- ${word.slice(1, 2)}\n${INSTALL_USAGE}`);
        else { operands.push(word); index++; }
    }
    if (operands.length === 0) return fail(INSTALL_USAGE, 64);

    if (makeDirs) {
        const wanted = mode ?? 0o755;
        for (const operand of operands) {
            const path = resolveAt(ctx, operand);
            try {
                if (!isDir(ctx.fs, path)) ctx.fs.createDirectory(path);
                setMode(ctx.fs, path, wanted);
            } catch (error) {
                return fail(`install: ${operand}: ${message(error)}`);
            }
        }
        return ok();
    }
    if (operands.length < 2) return fail(INSTALL_USAGE, 64);
    const destArg = operands[operands.length - 1];
    const destPath = resolveAt(ctx, destArg);
    const intoDirectory = isDir(ctx.fs, destPath);
    if (!intoDirectory && operands.length > 2) return fail(`install: ${destArg}: not a directory`);
    const wanted = mode ?? 0o755;
    for (const source of operands.slice(0, -1)) {
        const sourcePath = resolveAt(ctx, source);
        const content = readFileOrNone(ctx.fs, sourcePath);
        if (content === undefined) return fail(`install: ${source}: No such file or directory`, 71);
        const target = intoDirectory ? joinPath(destPath, source.split('/').pop() as string) : destPath;
        try {
            ctx.fs.writeFile(target, content);
            setMode(ctx.fs, target, wanted);
        } catch (error) {
            return fail(`install: ${target}: ${message(error)}`);
        }
    }
    return ok();
};

const LN_USAGE =
    'usage: ln [-s [-F] | -L | -P] [-f | -i] [-hnv] source_file [target_file]\n' +
    '       ln [-s [-F] | -L | -P] [-f | -i] [-hnv] source_file ... target_dir\n';

const ln: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let symbolic = false;
    let force = false;
    let noDereference = false;
    const operands: string[] = [];
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        if (word[0] === '-' && word.length > 1 && word[1] !== '-') {
            for (const letter of word.slice(1)) {
                if (letter === 's') symbolic = true;
                else if (letter === 'f') force = true;
                else if (letter === 'n') noDereference = true;
                else if (letter === 'i' || letter === 'v' || letter === 'h') continue;
                else return fail(`ln: illegal option -- ${letter}\n${LN_USAGE}`);
            }
            index++;
        } else if (word === '--') {
            index++;
        } else {
            operands.push(word);
            index++;
        }
    }
    if (operands.length === 0) return fail(LN_USAGE);

    // ln target... directory
    if (operands.length > 2 || (operands.length === 2 && isDir(ctx.fs, resolveAt(ctx, operands[1])))) {
        const dirArg = operands[operands.length - 1];
        const dirPath = resolveAt(ctx, dirArg);
        if (!isDir(ctx.fs, dirPath)) return fail(`ln: ${dirArg}: Not a directory`);
        for (const source of operands.slice(0, -1)) {
            const name = source.split('/').pop() as string;
            const outcome = makeLink(ctx, source, joinPath(dirPath, name), symbolic, force, noDereference, name);
            if (outcome !== null) return outcome;
        }
        return ok();
    }
    const target = operands[0];
    const linkName = operands.length === 2 ? operands[1] : target.split('/').pop() as string;
    const outcome = makeLink(ctx, target, resolveAt(ctx, linkName), symbolic, force, noDereference, linkName);
    return outcome ?? ok();
};

function makeLink(
    ctx: CommandContext,
    target: string,
    linkPath: string,
    symbolic: boolean,
    force: boolean,
    noDereference: boolean,
    shown: string
): CommandResult | null {
    if (exists(ctx.fs, linkPath)) {
        const isLinkToDir = isSymlink(ctx.fs, linkPath) && isDir(ctx.fs, resolveAt(ctx, linkPath));
        if (!force) return fail(`ln: ${shown}: File exists`);
        if (isLinkToDir && !noDereference) return fail(`ln: ${shown}: File exists`);
        try {
            dropMeta(ctx.fs, linkPath);
            ctx.fs.removePath(linkPath, false);
        } catch (error) {
            return fail(`ln: ${shown}: ${message(error)}`);
        }
    }
    try {
        if (symbolic) {
            // the file system has no symlink inode, so the node is an empty file with a recorded target
            ctx.fs.writeFile(linkPath, '');
            metaOf(ctx.fs).links.set(clean(linkPath), target);
        } else {
            const targetPath = resolveAt(ctx, target);
            const content = readFileOrNone(ctx.fs, targetPath);
            if (content === undefined) return fail(`ln: ${target}: No such file or directory`);
            ctx.fs.writeFile(linkPath, content);
            shareInode(ctx.fs, targetPath, linkPath);
        }
    } catch (error) {
        return fail(`ln: ${shown}: ${message(error)}`);
    }
    return null;
}

const link: ShellCommand = (ctx) => {
    if (ctx.args.length !== 2) return fail('usage: link source_file target_file');
    const [source, destination] = ctx.args;
    const sourcePath = resolveAt(ctx, source);
    const destinationPath = resolveAt(ctx, destination);
    if (isDir(ctx.fs, sourcePath)) return fail(`link: ${source}: Is a directory`);
    const content = readFileOrNone(ctx.fs, sourcePath);
    if (content === undefined) return fail(`link: ${source}: No such file or directory`);
    if (exists(ctx.fs, destinationPath)) return fail(`link: ${destination}: File exists`);
    try {
        ctx.fs.writeFile(destinationPath, content);
        shareInode(ctx.fs, sourcePath, destinationPath);
    } catch (error) {
        return fail(`link: ${destination}: ${message(error)}`);
    }
    return ok();
};

/* ----------------------------------------------------------- chown / chmod */

/** The names `chown` accepts. The container has no passwd file, so this is all there is. */
const USER_NAMES: Record<string, number> = { root: 0, daemon: 1, bin: 2, sys: 3, mail: 6, news: 9, man: 10, nobody: 65534, guest: 31 };
const GROUP_NAMES: Record<string, number> = { wheel: 0, daemon: 1, bin: 2, sys: 3, staff: 20, nogroup: 65534, nobody: 65534 };

function resolveUser(spec: string): number | undefined {
    if (/^[0-9]+$/.test(spec)) return Number.parseInt(spec, 10);
    const mapped = USER_NAMES[spec];
    return mapped === undefined ? undefined : mapped;
}

function resolveGroup(spec: string): number | undefined {
    if (/^[0-9]+$/.test(spec)) return Number.parseInt(spec, 10);
    const mapped = GROUP_NAMES[spec];
    return mapped === undefined ? undefined : mapped;
}

const chown: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let recursive = false;
    let index = 0;
    while (index < words.length && isOption(words[index])) {
        const word = words[index];
        if (word === '-R' || word === '-r') { recursive = true; index++; }
        else if (word === '-h' || word === '-v' || word === '-f') index++;
        else if (word === '--') { index++; break; }
        else return fail(`chown: illegal option -- ${word.slice(1, 2)}\nusage: chown [-fhnvx] [-R [-H | -L | -P]] owner[:group] file ...\n       chown [-fhnvx] [-R [-H | -L | -P]] :group file ...`);
    }
    const operands = words.slice(index);
    if (operands.length < 2) return fail('usage: chown [-fhnvx] [-R [-H | -L | -P]] owner[:group] file ...\n       chown [-fhnvx] [-R [-H | -L | -P]] :group file ...');
    const spec = operands[0];
    const separator = spec.indexOf(':');
    const userSpec = separator < 0 ? spec : spec.slice(0, separator);
    const groupSpec = separator < 0 ? null : spec.slice(separator + 1);
    const uid = userSpec === '' ? undefined : resolveUser(userSpec);
    if (userSpec !== '' && uid === undefined) return fail(`chown: ${userSpec}: illegal user name`);
    const gid = groupSpec === null || groupSpec === '' ? undefined : resolveGroup(groupSpec);
    if (groupSpec !== null && groupSpec !== '' && gid === undefined) return fail(`chown: ${groupSpec}: illegal group name`);

    for (const file of operands.slice(1)) {
        const path = resolveAt(ctx, file);
        if (!exists(ctx.fs, path)) return fail(`chown: ${file}: No such file or directory`);
        const targets: string[] = [path];
        if (recursive && isDir(ctx.fs, path)) {
            for (const entry of walkRoot(ctx.fs, path, path, Number.MAX_SAFE_INTEGER).entries) targets.push(entry.path);
        }
        for (const target of targets) {
            const owner = ownerOf(ctx.fs, target);
            setOwner(ctx.fs, target, { uid: uid ?? owner.uid, gid: gid ?? owner.gid });
        }
    }
    return ok();
};

const CHMOD_USAGE =
    'usage:\tchmod [-fhv] [-R [-H | -L | -P]] [-a | +a | =a  [i][# [ n]]] mode|entry file ...\n' +
    '\tchmod [-fhv] [-R [-H | -L | -P]] [-E | -C | -N | -i | -I] file ...\n';

const chmod: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let recursive = false;
    let index = 0;
    while (index < words.length && isOption(words[index])) {
        const word = words[index];
        if (word === '-R' || word === '-r') { recursive = true; index++; }
        else if (word === '-v' || word === '-f' || word === '-h') index++;
        else if (word === '--') { index++; break; }
        else return fail(`chmod: illegal option -- ${word.slice(1, 2)}\n${CHMOD_USAGE}`);
    }
    const operands = words.slice(index);
    if (operands.length < 2) return fail(CHMOD_USAGE);
    const spec = operands[0];

    for (const file of operands.slice(1)) {
        const path = resolveAt(ctx, file);
        const stat = statOf(ctx.fs, path);
        if (stat === undefined) return fail(`chmod: ${file}: No such file or directory`);
        const parsed = parseMode(spec, modeOf(ctx.fs, path, stat.type === 'dir'));
        if (parsed === undefined) return fail(`chmod: Invalid file mode: ${spec}`);
        const targets: string[] = [path];
        if (recursive && stat.type === 'dir') {
            for (const entry of walkRoot(ctx.fs, path, path, Number.MAX_SAFE_INTEGER).entries) targets.push(entry.path);
        }
        for (const target of targets) setMode(ctx.fs, target, parsed);
    }
    return ok();
};

/* ------------------------------------------------------------------ du / df */

const DU_USAGE = 'usage: du [-Aclnx] [-H | -L | -P] [-g | -h | -k | -m] [-a | -s | -d depth] [-B blocksize] [-I mask] [-t threshold] [file ...]\n';

/** What a file costs on disk: whole 4 KiB clusters, which is what the host reports. */
function fileBytes(size: number): number {
    return size === 0 ? 0 : Math.ceil(size / 4096) * 4096;
}

/**
 * What `du -h` prints: 1024-based with a one letter suffix, no `i`. `df -h` on the same host prints
 * `Ki`, `Mi`, ... so the two utilities get two spellings of the same scale.
 */
function humanSize(value: number, unit: number, withI: boolean): string {
    const bytes = value * unit;
    const suffixes = ['B', 'K', 'M', 'G', 'T', 'P'];
    let scaled = bytes;
    let at = 0;
    while (scaled >= 1024 && at < suffixes.length - 1) {
        scaled /= 1024;
        at++;
    }
    const suffix = at === 0 ? 'B' : suffixes[at] + (withI ? 'i' : '');
    const text = at === 0 ? String(Math.round(scaled)) : scaled < 10 ? scaled.toFixed(1) : String(Math.round(scaled));
    return text + suffix;
}

interface DuRow {
    shown: string;
    blocks: number;
    isDir: boolean;
}

function duRows(fs: Fs, path: string, shown: string, all: boolean, depth: number, out: DuRow[]): number {
    const stat = statOf(fs, path);
    if (stat === undefined) return 0;
    if (stat.type !== 'dir') {
        if (all) out.push({ shown, blocks: fileBytes(stat.size), isDir: false });
        return fileBytes(stat.size);
    }
    let total = 0;
    for (const name of dirEntries(fs, path)) {
        total += duRows(fs, joinPath(path, name), shown === '/' ? '/' + name : shown + '/' + name, all, depth, out);
    }
    if (depth >= 0) out.push({ shown, blocks: total, isDir: true });
    return total;
}

const du: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let all = false;
    let summary = false;
    let human = false;
    let depth = -1;
    let unit = 512;
    const operands: string[] = [];
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        const value = words[index + 1];
        if (word[0] === '-' && word.length > 1 && word[1] !== '-') {
            for (let at = 1; at < word.length; at++) {
                const letter = word[at];
                if (letter === 'a') all = true;
                else if (letter === 's') summary = true;
                else if (letter === 'h') human = true;
                else if (letter === 'k') unit = 1024;
                else if (letter === 'm') unit = 1048576;
                else if (letter === 'd') {
                    const inline = word.slice(at + 1);
                    const text = inline !== '' ? inline : value;
                    const parsed = text === undefined ? Number.NaN : Number.parseInt(text, 10);
                    if (!Number.isFinite(parsed) || parsed < 0) return fail(`du: invalid depth: ${text ?? ''}\n${DU_USAGE}`, 64);
                    depth = parsed;
                    at = word.length;
                } else return fail(`du: invalid option -- ${letter}\n${DU_USAGE}`, 64);
            }
            if (word.indexOf('d') >= 0 && word[word.length - 1] === 'd') index += 2;
            else index++;
        } else if (word === '--') {
            index++;
        } else {
            operands.push(word);
            index++;
        }
    }
    if ((all ? 1 : 0) + (summary ? 1 : 0) + (depth >= 0 ? 1 : 0) > 1) {
        // BSD keeps -a, -s and -d mutually exclusive, unlike GNU
        return fail(DU_USAGE, 64);
    }
    const targets = operands.length === 0 ? ['.'] : operands;
    const rows: DuRow[] = [];
    let exitCode = 0;
    let stderr = '';
    for (const target of targets) {
        const path = resolveAt(ctx, target);
        const stat = statOf(ctx.fs, path);
        if (stat === undefined) {
            stderr += `du: ${target}: No such file or directory\n`;
            exitCode = 1;
            continue;
        }
        const shown = target.replace(/\/+$/, '') === '' ? '/' : target.replace(/\/+$/, '');
        if (stat.type !== 'dir') {
            rows.push({ shown, blocks: fileBytes(stat.size), isDir: false });
            continue;
        }
        if (summary) {
            const inner: DuRow[] = [];
            const total = duRows(ctx.fs, path, shown, false, 0, inner);
            rows.push({ shown, blocks: total, isDir: true });
            continue;
        }
        if (depth >= 0) {
            const inner: DuRow[] = [];
            duRows(ctx.fs, path, shown, false, 0, inner);
            const baseDepth = shown.split('/').filter((part) => part !== '').length;
            for (const row of inner) {
                const rowDepth = row.shown.split('/').filter((part) => part !== '').length;
                if (rowDepth - baseDepth <= depth) rows.push(row);
            }
            continue;
        }
        duRows(ctx.fs, path, shown, all, 0, rows);
    }
    let width = 4;
    const rendered: string[] = [];
    for (const row of rows) {
        // a tree is summed in bytes and divided by the chosen unit once, at print time
        const text = human ? humanSize(row.blocks, 1, false) : String(Math.ceil(row.blocks / unit));
        width = Math.max(width, text.length);
        rendered.push(text + '\t' + row.shown);
    }
    let out = '';
    for (const line of rendered) {
        const tab = line.indexOf('\t');
        const number = line.slice(0, tab);
        out += (human ? number.padStart(width) : number) + '\t' + line.slice(tab + 1) + '\n';
    }
    return result(out, stderr, exitCode);
};

/** The container has one mount and no device behind it, so `df` reports a synthetic one. */
const DF_TOTAL_BYTES = 1 << 30;
const DF_TOTAL_INODES = 1 << 20;

const df: ShellCommand = (ctx) => {
    const words = ctx.args.slice();
    let human = false;
    let unit = 512;
    let inodes = false;
    for (const word of words) {
        if (word === '--') continue;
        if (!isOption(word)) continue;
        for (let at = 1; at < word.length; at++) {
            const letter = word[at];
            if (letter === 'h') human = true;
            else if (letter === 'k') unit = 1024;
            else if (letter === 'm') unit = 1048576;
            else if (letter === 'i') inodes = true;
            else if (letter === 'P' || letter === 'a' || letter === 'l' || letter === 'T') continue;
            else return fail(`df: invalid option -- ${letter}\nusage: df [--libxo] [-b | -g | -H | -h | -k | -m | -P] [-acIilnY] [-,] [-T type] [-t type]\n          [file | filesystem ...]`, 64);
        }
    }
    let used = 0;
    let usedInodes = 0;
    try {
        for (const file of ctx.fs.listFiles('/')) {
            const stat = statOf(ctx.fs, file);
            if (stat !== undefined) {
                used += stat.size;
                usedInodes++;
            }
        }
    } catch {
        /* an empty or unlistable root reports zero */
    }
    const totalBytes = DF_TOTAL_BYTES;
    const totalInodes = Math.max(DF_TOTAL_INODES, usedInodes);
    const availBytes = Math.max(0, totalBytes - used);
    const capacity = Math.min(100, Math.round((used / totalBytes) * 100));
    const inodeCapacity = Math.min(100, Math.round((usedInodes / totalInodes) * 100));
    const size = (value: number): string => (human ? humanSize(Math.round(value / unit), unit, true) : String(Math.round(value / unit)));
    for (const argument of words) {
        if (argument === '--' || isOption(argument)) continue;
        if (!exists(ctx.fs, resolveAt(ctx, argument))) {
            return fail(`df: ${argument}: No such file or directory`);
        }
    }
    const rows: string[][] = [
        ['owc-root', size(totalBytes), size(used), size(availBytes), `${capacity}%`, String(usedInodes), String(totalInodes - usedInodes), `${inodeCapacity}%`, '/']
    ];
    const sizeHeader = human ? 'Size' : unit === 1024 ? '1024-blocks' : unit === 1048576 ? '1M-blocks' : '512-blocks';
    const headers = ['Filesystem', sizeHeader, 'Used', human ? 'Avail' : 'Available', 'Capacity', 'iused', 'ifree', '%iused', 'Mounted on'];
    let out = '';
    const widths: number[] = [];
    for (let column = 0; column < headers.length; column++) {
        let width = headers[column].length;
        for (const row of rows) width = Math.max(width, row[column].length);
        widths.push(width);
    }
    const right = [1, 2, 3, 4, 5, 6, 7];
    for (let column = 0; column < headers.length; column++) {
        const aligned = right.indexOf(column) >= 0 ? headers[column].padStart(widths[column]) : headers[column].padEnd(widths[column]);
        out += (column === 0 ? '' : ' ') + aligned;
    }
    out += '\n';
    for (const row of rows) {
        for (let column = 0; column < row.length; column++) {
            const aligned = right.indexOf(column) >= 0 ? row[column].padStart(widths[column]) : row[column].padEnd(widths[column]);
            out += (column === 0 ? '' : ' ') + aligned;
        }
        out += '\n';
    }
    return ok(out);
};

/* ----------------------------------------------------------------- the table */

export const COMMANDS: Record<string, ShellCommand> = {
    find,
    xargs,
    basename,
    dirname,
    expr,
    test,
    '[': bracket,
    printf,
    seq,
    yes,
    sleep,
    date,
    tee,
    base64,
    base32,
    xxd,
    split,
    stat,
    install,
    ln,
    link,
    chown,
    chmod,
    du,
    df
};
