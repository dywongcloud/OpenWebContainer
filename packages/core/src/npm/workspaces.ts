import { IFileSystem } from '../filesystem';
import { dirnameOf, joinPaths, normalizeAbsolute } from '../process/executors/node/runtime/resolver';
import { readManifest } from './scripts';

/**
 * Workspaces: the packages a root `package.json` names in its `workspaces` field, and which of them
 * a command runs in. `--workspaces` runs in all of them, `-w`/`--workspace <name>` in the ones that
 * answer to a name, a path or a pattern, and the root itself joins them only when
 * `--include-workspace-root` asks for it -- npm's own default, which is not to.
 */

/** The workspace options of a command line: which workspaces, and whether the root is one of them. */
export interface WorkspaceOptions {
    /** `--workspaces`: every workspace the root names. */
    all: boolean;
    /** `-w`/`--workspace <name>`: the names, paths or patterns given. */
    names: string[];
    /** `--include-workspace-root`: run in the root as well, and in it first. */
    includeRoot: boolean;
    /** Whether the line asked for workspaces at all. */
    requested: boolean;
}

/** No workspace options: the command runs in the package it was given and nowhere else. */
export const NO_WORKSPACES: WorkspaceOptions = { all: false, names: [], includeRoot: false, requested: false };

/**
 * Reads the workspace options out of a command line and hands back the rest of it: `-w` and
 * `--workspace` take the next word as theirs, `--workspaces` and `--include-workspace-root` take
 * nothing, and every other word belongs to the command.
 */
export function parseWorkspaceOptions(args: string[]): { options: WorkspaceOptions; rest: string[] } {
    const names: string[] = [];
    const rest: string[] = [];
    let all = false;
    let includeRoot = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--workspaces' || arg === '--ws') { all = true; continue; }
        if (arg === '--include-workspace-root') { includeRoot = true; continue; }
        if (arg === '-w' || arg === '--workspace') {
            const value = args[++i];
            if (value !== undefined) names.push(value);
            continue;
        }
        if (arg.startsWith('--workspace=')) { names.push(arg.slice('--workspace='.length)); continue; }
        rest.push(arg);
    }
    return {
        options: { all, names, includeRoot, requested: all || names.length > 0 || includeRoot },
        rest
    };
}

/** The patterns a root package.json names: `workspaces` as a list, or as `{ packages: [...] }`. */
function workspacePatterns(manifest: Record<string, any>): string[] {
    const field = manifest.workspaces;
    if (Array.isArray(field)) return field.filter((entry): entry is string => typeof entry === 'string');
    if (field !== null && typeof field === 'object') {
        const packages = (field as Record<string, unknown>).packages;
        if (Array.isArray(packages)) return packages.filter((entry): entry is string => typeof entry === 'string');
    }
    return [];
}

/** A workspace glob as a matcher: `*` within one level, `**` across them, `?` one character. */
function patternMatcher(pattern: string): RegExp {
    const normalized = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
    let source = '';
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized[i];
        if (char === '*') {
            const doubled = normalized[i + 1] === '*';
            if (doubled) i++;
            source += doubled ? '.*' : '[^/]*';
            continue;
        }
        if (char === '?') { source += '[^/]'; continue; }
        source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source}$`);
}

/** Every directory under `rootDir` that is a package: a workspace is one of these, or the root. */
function packageDirectories(fileSystem: IFileSystem, rootDir: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const name of fileSystem.readdirNames(dir) ?? []) {
            if (name === 'node_modules' || name.startsWith('.')) continue;
            const path = joinPaths(dir, name);
            if (fileSystem.statPath(path)?.type !== 'dir') continue;
            if (fileSystem.statPath(joinPaths(path, 'package.json'))?.type === 'file') out.push(path);
            walk(path);
        }
    };
    walk(rootDir);
    return out;
}

/** The path of `dir` written from `rootDir` down, which is what a workspace pattern matches. */
function relativeTo(rootDir: string, dir: string): string {
    const base = rootDir.endsWith('/') ? rootDir : `${rootDir}/`;
    return dir.startsWith(base) ? dir.slice(base.length) : dir;
}

/**
 * The workspaces a command runs in: the packages under `rootDir` that the root's `workspaces` field
 * names, narrowed to the ones `-w` asked for when it asked, in the order npm runs them -- the root
 * first when it is one of them, then the rest in the order the field names them.
 */
export function resolveWorkspaces(
    fileSystem: IFileSystem,
    rootDir: string,
    options: WorkspaceOptions
): string[] {
    if (!options.requested) return [];
    const root = normalizeAbsolute(rootDir);
    const manifest = readManifest(fileSystem, root) ?? {};
    const patterns = workspacePatterns(manifest);
    const candidates = packageDirectories(fileSystem, root);
    const selected: string[] = [];
    const add = (dir: string): void => {
        if (!selected.includes(dir)) selected.push(dir);
    };
    for (const pattern of patterns) {
        const matcher = patternMatcher(pattern);
        const matched = candidates.filter((dir) => {
            const relative = relativeTo(root, dir);
            const name = String(readManifest(fileSystem, dir)?.name ?? '');
            return matcher.test(relative) || matcher.test(name) || matcher.test(dir);
        });
        /* A pattern with no glob in it names one directory, which npm takes even when the directory
           is not there yet: it is the workspace the field declares. */
        if (matched.length === 0 && !/[*?]/.test(pattern)) {
            const direct = joinPaths(root, pattern.replace(/^\.\//, ''));
            if (fileSystem.statPath(joinPaths(direct, 'package.json'))?.type === 'file') matched.push(direct);
        }
        for (const dir of matched) add(dir);
    }
    const wanted = options.names.length === 0 ? selected : selected.filter((dir) => {
        const relative = relativeTo(root, dir);
        const name = String(readManifest(fileSystem, dir)?.name ?? '');
        return options.names.some((entry) => {
            const matcher = patternMatcher(entry);
            return entry === name || entry === relative || entry === dir || matcher.test(relative) || matcher.test(name);
        });
    });
    return options.includeRoot ? [root, ...wanted.filter((dir) => dir !== root)] : wanted;
}

/**
 * `npm ls --workspaces` and the rest of the commands that take the flag without running anything in
 * each workspace: the workspaces the root names. `npm ls --workspaces` on a root whose workspaces
 * have no dependencies of their own is `root@1.0.0 <dir>` over `└── (empty)`, because the listing
 * is the root's own tree and not the workspaces'.
 */
export function workspaceDirectories(fileSystem: IFileSystem, rootDir: string): string[] {
    return resolveWorkspaces(fileSystem, rootDir, { all: true, names: [], includeRoot: false, requested: true });
}

/** The root of the workspace tree a directory belongs to: the nearest package.json naming workspaces. */
export function findWorkspaceRoot(fileSystem: IFileSystem, startDir: string): string | undefined {
    let dir = normalizeAbsolute(startDir);
    while (true) {
        const manifest = readManifest(fileSystem, dir);
        if (manifest !== undefined && workspacePatterns(manifest).length > 0) return dir;
        if (dir === '/') return undefined;
        dir = dirnameOf(dir);
    }
}
