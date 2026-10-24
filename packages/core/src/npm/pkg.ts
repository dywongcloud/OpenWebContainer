import { IFileSystem } from '../filesystem';
import { joinPaths, normalizeAbsolute } from '../process/executors/node/runtime/resolver';
import { findPackageRoot, npmErrorLines, readManifest } from './scripts';

/**
 * `npm pkg`: the one npm command that reads and writes `package.json` as data rather than as a
 * package to install. `get` answers with the JSON of what it found, `set` and `delete` change the
 * file and answer nothing, and a line npm cannot read as one of them is a usage error.
 */

export interface PkgResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** npm's usage error for `npm pkg` with no subcommand, or with one it has no reading for. */
const USAGE = [
    'code EUSAGE',
    '',
    'Manages your package.json',
    '',
    'Usage:',
    'npm pkg set <key>=<value> [<key>=<value> ...]',
    'npm pkg get [<key> [<key> ...]]',
    'npm pkg delete <key> [<key> ...]',
    'npm pkg set [<array>[<index>].<key>=<value> ...]',
    'npm pkg set [<array>[].<key>=<value> ...]',
    'npm pkg fix',
    '',
    'Options:',
    '[-f|--force] [--json]',
    '[-w|--workspace <workspace-name> [-w|--workspace <workspace-name> ...]]',
    '[--workspaces]',
    '',
    '  -f|--force',
    '    Removes various protections against unfortunate side effects, common',
    '',
    '  --json',
    '    Whether or not to output JSON data, rather than the normal output.',
    '',
    '  -w|--workspace',
    '    Enable running a command in the context of the configured workspaces of the',
    '',
    '  --workspaces',
    '    Set to true to run the command in the context of **all** configured',
    '',
    '',
    'Run "npm help pkg" for more info'
].join('\n');

/** One step of a dotted key: a property name, an array index, or `[]` for "at the end of it". */
type Token = string | number | typeof APPEND;
const APPEND = Symbol('append');

/** `scripts.start`, `arr[0].name` and `arr[].name` as the steps npm walks. */
function tokensOf(path: string): Token[] {
    const tokens: Token[] = [];
    const pattern = /([^.[\]]+)|\[(-?\d+)\]|\[\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(path)) !== null) {
        if (match[1] !== undefined) tokens.push(match[1]);
        else if (match[2] !== undefined) tokens.push(Number(match[2]));
        else tokens.push(APPEND);
    }
    return tokens;
}

/** What one token reads out of a value, or undefined where it reads nothing. */
function step(value: unknown, token: Token): unknown {
    if (token === APPEND) return undefined;
    if (value === null || typeof value !== 'object') return undefined;
    return (value as Record<string | number, unknown>)[token as string | number];
}

/** Whether the value has this token to give: `in` on a missing key is what npm's own query tests. */
function has(value: unknown, token: Token): boolean {
    if (token === APPEND) return Array.isArray(value);
    if (value === null || typeof value !== 'object') return false;
    return (token as string | number) in (value as Record<string | number, unknown>);
}

/** The value a dotted key names, and whether the walk found it. */
function readPath(root: unknown, tokens: Token[]): { found: boolean; value: unknown } {
    let at: unknown = root;
    for (const token of tokens) {
        if (!has(at, token)) return { found: false, value: undefined };
        at = step(at, token);
    }
    return { found: true, value: at };
}

/**
 * Writes `value` where a dotted key names, creating the objects and arrays the walk needs on the
 * way, which is what lets `npm pkg set a.b.c=1` build the whole of `a.b`.
 */
function writePath(root: Record<string, any>, tokens: Token[], value: unknown): void {
    if (tokens.length === 0) return;
    let at: any = root;
    for (let i = 0; i < tokens.length - 1; i++) {
        const token = tokens[i];
        const next = tokens[i + 1];
        if (token === APPEND) {
            if (!Array.isArray(at)) at[tokens[i - 1] as string] = at = [];
            at.push(next === APPEND || typeof next === 'number' ? [] : {});
            at = at[at.length - 1];
            continue;
        }
        if (!has(at, token) || step(at, token) === null || typeof step(at, token) !== 'object') {
            at[token] = typeof next === 'string' ? {} : [];
        }
        at = step(at, token);
    }
    const last = tokens[tokens.length - 1];
    if (last === APPEND) {
        if (!Array.isArray(at)) return;
        at.push(value);
        return;
    }
    at[last] = value;
}

/** Removes what a dotted key names; a key that is not there is not an error. */
function deletePath(root: Record<string, any>, tokens: Token[]): void {
    if (tokens.length === 0) return;
    let at: any = root;
    for (let i = 0; i < tokens.length - 1; i++) {
        if (!has(at, tokens[i])) return;
        at = step(at, tokens[i]);
    }
    const last = tokens[tokens.length - 1];
    if (at === null || typeof at !== 'object') return;
    if (last === APPEND) return;
    if (Array.isArray(at) && typeof last === 'number') at.splice(last, 1);
    else delete at[last as string | number];
}

/** `npm pkg get [<key>...]`: the JSON of what each key names, or of the whole file for no key. */
function get(manifest: Record<string, any>, args: string[]): PkgResult {
    let result: unknown = manifest;
    if (args.length > 0) {
        const found: Record<string, unknown> = {};
        for (const arg of args) {
            const read = readPath(manifest, tokensOf(arg));
            if (read.found) found[arg] = read.value;
        }
        /* npm unwraps a single answer to a single question, which is why `npm pkg get name` is a
           bare string and `npm pkg get name version` is an object. */
        result = Object.keys(found).length === 1 && args.length === 1 ? found[args[0]] : found;
    }
    return { stdout: JSON.stringify(result, null, 2) + '\n', stderr: '', exitCode: 0 };
}

/** `npm pkg set <key>=<value>...`: each pair is written, and npm answers with nothing. */
function set(manifest: Record<string, any>, args: string[]): PkgResult | undefined {
    if (args.length === 0) return undefined;
    for (const arg of args) {
        const at = arg.indexOf('=');
        const key = at < 0 ? '' : arg.slice(0, at);
        const value = at < 0 ? '' : arg.slice(at + 1);
        if (key === '') return undefined;
        writePath(manifest, tokensOf(key), value);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
}

/** `npm pkg delete <key>...`: each key is removed, and npm answers with nothing. */
function remove(manifest: Record<string, any>, args: string[]): PkgResult | undefined {
    if (args.length === 0) return undefined;
    for (const arg of args) {
        if (arg === '') return undefined;
        deletePath(manifest, tokensOf(arg));
    }
    return { stdout: '', stderr: '', exitCode: 0 };
}

/** `npm pkg [get|set|delete|fix] ...` in the package at `cwd`. */
export function runPkgCommand(fileSystem: IFileSystem, args: string[], cwd: string): PkgResult {
    const [command, ...rest] = args;
    const packageDir = findPackageRoot(fileSystem, cwd) ?? normalizeAbsolute(cwd);
    const manifest = readManifest(fileSystem, packageDir);
    if (manifest === undefined) {
        /* npm reads package.json before it looks at the subcommand, so a directory with none fails
           the same way whichever one was asked for. */
        return {
            stdout: '',
            stderr: `npm error code ENOENT\nnpm error enoent Could not read package.json in ${packageDir}\n`,
            exitCode: 1
        };
    }
    const file = joinPaths(packageDir, 'package.json');
    let result: PkgResult | undefined;
    if (command === 'get') result = get(manifest, rest);
    else if (command === 'set') result = set(manifest, rest);
    else if (command === 'delete') result = remove(manifest, rest);
    else if (command === 'fix') result = { stdout: '', stderr: '', exitCode: 0 };
    if (result === undefined) return { stdout: '', stderr: npmErrorLines(USAGE), exitCode: 1 };
    if (command !== 'get') fileSystem.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
    return result;
}
