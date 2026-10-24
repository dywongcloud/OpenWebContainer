import { IFileSystem } from '../filesystem';
import { didYouMean } from './didyoumean';
import { dirnameOf, joinPaths, normalizeAbsolute } from '../process/executors/node/runtime/resolver';

/**
 * What `npm run` and the lifecycle commands share: where the package is, which of its scripts a
 * command runs and in what order, and the PATH a script sees. The npm process and the synchronous
 * shell in the guest both answer a script through these, so a script behaves the same in both.
 */

/** The lifecycle commands that run one script of the package's own, and the script each names. */
export const LIFECYCLE_COMMANDS: Record<string, string> = {
    test: 'test',
    start: 'start',
    stop: 'stop',
    restart: 'restart'
};

/** The npm version this runtime answers `--version` with: the one the host's Node 24 ships. */
export const NPM_VERSION = '11.12.1';

export interface ParsedScriptArgs {
    /** The script to run: the one the lifecycle command names, or the first bare word of the line. */
    name?: string;
    ifPresent: boolean;
    /** Words after the script name, or after `--`, which npm appends to the script's command. */
    extra: string[];
}

/** Reads `npm run [name] [-- args]` and the same words behind `npm test`: flags belong to npm, `--` starts the script's. */
export function parseScriptArgs(args: string[], event?: string): ParsedScriptArgs {
    let name = event;
    let ifPresent = false;
    const extra: string[] = [];
    let passthrough = false;
    for (const arg of args) {
        if (passthrough) extra.push(arg);
        else if (arg === '--') passthrough = true;
        else if (arg === '--if-present') ifPresent = true;
        else if (arg.startsWith('-') && arg !== '-') continue;
        else if (name === undefined) name = arg;
        else extra.push(arg);
    }
    return { name, ifPresent, extra };
}

/** The nearest directory holding a package.json, at or above `startDir`: the package npm acts on. */
export function findPackageRoot(fileSystem: IFileSystem, startDir: string): string | undefined {
    let dir = normalizeAbsolute(startDir);
    while (true) {
        if (fileSystem.statPath(joinPaths(dir, 'package.json'))?.type === 'file') return dir;
        if (dir === '/') return undefined;
        dir = dirnameOf(dir);
    }
}

export function readManifest(fileSystem: IFileSystem, dir: string): Record<string, any> | undefined {
    const file = joinPaths(dir, 'package.json');
    if (fileSystem.statPath(file)?.type !== 'file') return undefined;
    try {
        return JSON.parse(fileSystem.readFile(file) ?? '');
    } catch {
        return undefined;
    }
}

/** npm puts every node_modules/.bin at or above the package in front of PATH, so a script runs the bins of its tree by name. */
export function binPathDirectories(fileSystem: IFileSystem, packageDir: string): string[] {
    const dirs: string[] = [];
    let dir = normalizeAbsolute(packageDir);
    while (true) {
        const bin = joinPaths(dir, 'node_modules', '.bin');
        if (fileSystem.statPath(bin)?.type === 'dir') dirs.push(bin);
        if (dir === '/') return dirs;
        dir = dirnameOf(dir);
    }
}

/** PATH for a script: the bins of the tree first, then what the caller already had. */
export function scriptPath(fileSystem: IFileSystem, packageDir: string, PATH: string | undefined): string {
    return [...binPathDirectories(fileSystem, packageDir), PATH ?? '/bin:/usr/bin'].join(':');
}

/** `name@version`, as npm heads each script it runs; a package with no name keeps its directory's. */
export function scriptLabel(manifest: Record<string, any>, packageDir: string): string {
    const name = typeof manifest.name === 'string' ? manifest.name : packageDir.split('/').filter(Boolean).pop() ?? 'project';
    return `${name}@${manifest.version ?? ''}`;
}

/** The scripts one command runs, in order: `pre<name>`, the script, `post<name>`. */
export function scriptEvents(name: string, scripts: Record<string, unknown>): string[] {
    /* npm restart has no script of its own to fall back on: it stops the project and starts it. */
    const events = name === 'restart' && typeof scripts.restart !== 'string'
        ? ['prestop', 'stop', 'poststop', 'prestart', 'start', 'poststart']
        : [`pre${name}`, name, `post${name}`];
    return events.filter((event) => typeof scripts[event] === 'string');
}

/** The line one event runs: the script, with the run's extra words on the script that was named. */
export function scriptCommandLine(scripts: Record<string, unknown>, event: string, name: string, extra: string[]): string {
    return [String(scripts[event]), ...(event === name ? extra : [])].join(' ');
}

/**
 * The scripts npm draws under `Lifecycle scripts included in <pkg>:` rather than under
 * `available via \`npm run\`:`: the ones whose names are lifecycle events, so a `start` or a
 * `pretest` is a script npm runs on its own account and a `build` is one only `npm run` reaches.
 */
const LIFECYCLE_SCRIPT_NAMES = new Set([
    'prepare', 'prepublishOnly',
    'prepack', 'postpack',
    'dependencies',
    'preinstall', 'install', 'postinstall',
    'prepublish', 'publish', 'postpublish',
    'prerestart', 'restart', 'postrestart',
    'prestart', 'start', 'poststart',
    'prestop', 'stop', 'poststop',
    'pretest', 'test', 'posttest',
    'preuninstall', 'uninstall', 'postuninstall',
    'preversion', 'version', 'postversion'
]);

/** npm prefixes every line of an error with `npm error`, a blank one included. */
export function npmErrorLines(text: string): string {
    return text.split('\n').map((line) => `npm error ${line}`.replace(/\s+$/, '')).join('\n') + '\n';
}

/**
 * The path `npm ls` prints after `->` for a dependency it installed out of a directory rather than
 * the registry: the path of the `file:` spec, made relative the way npm writes it.
 */
export function localSpecLabel(range: string | undefined): string | undefined {
    if (range === undefined || !range.startsWith('file:')) return undefined;
    const path = range.slice('file:'.length);
    if (path === '') return undefined;
    return path.startsWith('/') || path.startsWith('.') ? path : `./${path}`;
}

/** `npm error` lines for a script the package does not have, as npm prints them. */
export function missingScriptMessage(name: string, manifest?: Record<string, any>): string {
    return npmErrorLines([
        `Missing script: "${name}"${didYouMean(manifest, name)}`,
        '',
        'To see a list of scripts, run:',
        '  npm run'
    ].join('\n'));
}

/**
 * What `npm run` prints when no script is named: the package's scripts split in two, the lifecycle
 * ones under a heading of their own and the rest under `available via \`npm run\`:`, each indented
 * under its name the way npm indents them. A package with no scripts gets no listing at all.
 */
export function scriptList(label: string, scripts: Record<string, unknown>): string {
    const entries = Object.entries(scripts).filter(([, command]) => typeof command === 'string');
    /* npm prints nothing for a package whose scripts there are none of. */
    if (entries.length === 0) return '';
    const lifecycle: [string, unknown][] = [];
    const runnable: [string, unknown][] = [];
    for (const entry of entries) (LIFECYCLE_SCRIPT_NAMES.has(entry[0]) ? lifecycle : runnable).push(entry);
    const lines: string[] = [];
    if (lifecycle.length > 0) {
        lines.push(`Lifecycle scripts included in ${label}:`);
        for (const [name, command] of lifecycle) lines.push(`  ${name}`, `    ${String(command)}`);
    }
    if (runnable.length > 0) {
        lines.push(lifecycle.length > 0 ? 'available via `npm run`:' : `Scripts available in ${label} via \`npm run\`:`);
        for (const [name, command] of runnable) lines.push(`  ${name}`, `    ${String(command)}`);
    }
    return lines.join('\n') + '\n';
}

/**
 * The header npm prints above each script it is about to run: a blank line before it, then the
 * `> <package> <event>` line, the command, and a blank line between the command and what it prints.
 */
export function scriptHeader(label: string, event: string, line: string): string {
    return `\n> ${label} ${event}\n> ${line}\n\n`;
}

/** The `npm error` block of a script that failed, carrying the status npm exits with. */
export function scriptFailureMessage(label: string, event: string, command: string, exitCode: number): string {
    return `npm error code ELIFECYCLE\nnpm error errno ${exitCode}\n` +
        `npm error ${label} ${event}: \`${command}\`\nnpm error Exit status ${exitCode}\n`;
}
