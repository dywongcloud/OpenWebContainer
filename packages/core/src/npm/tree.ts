import { IFileSystem } from '../filesystem';
import { dirnameOf, joinPaths, normalizeAbsolute } from '../process/executors/node/runtime/resolver';
import { readManifest } from './scripts';

/**
 * `npm ls`: the dependency tree of the package at a directory, drawn with npm's own branch
 * characters. The tree is the one the file system holds -- a dependency is the copy Node would
 * resolve from the package that asks for it, and one the tree does not have is marked the way npm
 * marks a dependency it could not place.
 */

export interface ListOptions {
    /** Levels below the root to print, as npm counts them: `npm ls` alone shows the direct dependencies. */
    depth: number;
}

/** `npm ls [--depth=<n>] [--all]`: the depth counts levels under the root, so 0 is the direct dependencies. */
export function parseListArgs(args: string[]): ListOptions {
    let depth = 0;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--all' || arg === '-a') depth = Infinity;
        else if (arg === '--depth') depth = depthValue(args[++i]);
        else if (arg.startsWith('--depth=')) depth = depthValue(arg.slice('--depth='.length));
    }
    return { depth };
}

function depthValue(value: string | undefined): number {
    if (value === 'Infinity') return Infinity;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** One line of the tree: what npm writes for it, and the lines beneath it. */
interface TreeNode {
    text: string;
    children: TreeNode[];
}

/** The whole `npm ls` report for the package at `packageDir`, ending with npm's own blank line. */
export function dependencyTree(fileSystem: IFileSystem, packageDir: string, options: ListOptions): string {
    const manifest = readManifest(fileSystem, packageDir);
    const lines = [manifest === undefined ? packageDir : rootLabel(manifest, packageDir)];
    const children = manifest === undefined
        ? []
        : childrenOf(fileSystem, packageDir, manifest, dependencyLevels(options.depth), true);
    if (children.length === 0) lines.push('└── (empty)');
    else drawChildren(children, '', lines);
    return lines.join('\n') + '\n\n';
}

/** `<name>@<version> <dir>`: npm names the package it is listing and where it found it. */
function rootLabel(manifest: Record<string, any>, packageDir: string): string {
    const name = typeof manifest.name === 'string' ? manifest.name : packageDir.split('/').filter(Boolean).pop() ?? 'project';
    return `${name}@${manifest.version ?? ''} ${packageDir}`;
}

/** npm counts depth in levels under the root, so depth 0 still prints the direct dependencies. */
function dependencyLevels(depth: number): number {
    return depth === Infinity ? Infinity : depth + 1;
}

/**
 * The lines under one package: its dependencies, devDependencies at the root alone (a dependency's
 * own devDependencies are never installed, so npm has nothing to show for them), and
 * optionalDependencies, each in npm's alphabetical order.
 */
function childrenOf(
    fileSystem: IFileSystem,
    packageDir: string,
    manifest: Record<string, any>,
    levels: number,
    includeDev: boolean
): TreeNode[] {
    if (levels <= 0) return [];
    const optional = new Set(Object.keys((manifest.optionalDependencies ?? {}) as Record<string, string>));
    const entries: { name: string; range: string; optional: boolean }[] = [];
    const collect = (source: Record<string, unknown>, isOptional: boolean) => {
        for (const [name, range] of Object.entries(source)) {
            if (!isOptional && optional.has(name)) continue;
            entries.push({ name, range: String(range), optional: isOptional });
        }
    };
    collect((manifest.dependencies ?? {}) as Record<string, unknown>, false);
    if (includeDev) collect((manifest.devDependencies ?? {}) as Record<string, unknown>, false);
    collect((manifest.optionalDependencies ?? {}) as Record<string, unknown>, true);
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    const nodes: TreeNode[] = [];
    for (const entry of entries) {
        const dir = findInstalledCopy(fileSystem, packageDir, entry.name);
        if (dir === undefined) {
            const kind = entry.optional ? 'OPTIONAL ' : '';
            nodes.push({ text: `UNMET ${kind}DEPENDENCY ${entry.name}@${entry.range}`, children: [] });
            continue;
        }
        const installed = readManifest(fileSystem, dir) ?? {};
        nodes.push({
            text: `${entry.name}@${installed.version ?? ''}`,
            children: levels > 1 ? childrenOf(fileSystem, dir, installed, levels - 1, false) : []
        });
    }
    return nodes;
}

/** The copy of `name` Node would resolve from `fromDir`, which is where npm prints it from. */
function findInstalledCopy(fileSystem: IFileSystem, fromDir: string, name: string): string | undefined {
    let dir = normalizeAbsolute(fromDir);
    while (true) {
        if (!dir.endsWith('/node_modules')) {
            const candidate = joinPaths(dir, 'node_modules', name);
            if (fileSystem.statPath(joinPaths(candidate, 'package.json'))?.type === 'file') return candidate;
        }
        if (dir === '/') return undefined;
        dir = dirnameOf(dir);
    }
}

/** npm's branch characters: `├─┬`/`└─┬` where the tree continues, `├──`/`└──` at a leaf. */
function drawChildren(children: TreeNode[], prefix: string, lines: string[]): void {
    children.forEach((child, index) => {
        const last = index === children.length - 1;
        const branch = child.children.length > 0
            ? (last ? '└─┬ ' : '├─┬ ')
            : (last ? '└── ' : '├── ');
        lines.push(prefix + branch + child.text);
        if (child.children.length > 0) drawChildren(child.children, prefix + (last ? '  ' : '│ '), lines);
    });
}
