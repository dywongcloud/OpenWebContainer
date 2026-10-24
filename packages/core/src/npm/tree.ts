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

/** A package reached by the walk whose own dependencies have not been walked yet. */
interface Pending {
    /** The directory of the package whose dependencies are next. */
    dir: string;
    /** Levels still to draw below this package's children, as npm counts them. */
    levels: number;
    manifest: Record<string, any>;
    /** devDependencies are the root's to show; a dependency's own are never installed. */
    includeDev: boolean;
    /** The line this package's dependencies are drawn under. */
    node: TreeNode;
}

/**
 * npm orders the lines under a package with the collator on `name@version`, not on the name alone:
 * `cookie-signature@1.0.6` precedes `cookie@0.7.1` because '-' sorts before '@', where a sort on the
 * name alone would put `cookie` first.
 */
const comparePackageIds: (left: string, right: string) => number = (() => {
    try {
        return new Intl.Collator('en').compare;
    } catch {
        return (left, right) => (left < right ? -1 : left > right ? 1 : 0);
    }
})();

/** The whole `npm ls` report for the package at `packageDir`, ending with npm's own blank line. */
export function dependencyTree(fileSystem: IFileSystem, packageDir: string, options: ListOptions): string {
    const manifest = readManifest(fileSystem, packageDir);
    const lines = [manifest === undefined ? packageDir : rootLabel(manifest, packageDir)];
    const children = manifest === undefined
        ? []
        : treeChildren(fileSystem, packageDir, manifest, dependencyLevels(options.depth));
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
 * The lines under the package at `packageDir`: its dependencies, devDependencies at the root alone
 * (a dependency's own devDependencies are never installed, so npm has nothing to show for them),
 * and optionalDependencies, each in npm's alphabetical order.
 *
 * The walk is breadth first, the way npm's is, and it gives every package it reaches a home at the
 * first place it reaches it. That is what `deduped` means and why the order matters: a dependency
 * hoisted to the root belongs to a shallower level than the package asking for it, so it is drawn in
 * full under the root -- further down the output -- while the deeper package that asks for it names
 * it `deduped` above, carrying none of its dependencies. A depth-first walk would give the same
 * package to the deepest package that reaches it first and draw the two the other way round.
 *
 * A package the walk reaches twice is one physical package, so what decides it is the directory the
 * dependency resolves to and not its name: two copies of a package at two directories are two
 * packages, and each is drawn in full.
 */
function treeChildren(
    fileSystem: IFileSystem,
    packageDir: string,
    manifest: Record<string, any>,
    levels: number
): TreeNode[] {
    const root: TreeNode = { text: '', children: [] };
    /* The root's own directory is already taken, as npm's walk has it: a package that resolves to it
       is named `deduped` and not drawn again. */
    const seen = new Map<string, TreeNode>([[normalizeAbsolute(packageDir), root]]);
    const queue: Pending[] = [{ dir: packageDir, levels, manifest, includeDev: true, node: root }];
    for (let next = 0; next < queue.length; next++) {
        const pending = queue[next];
        if (pending.levels <= 0) continue;
        const optional = new Set(Object.keys((pending.manifest.optionalDependencies ?? {}) as Record<string, string>));
        const entries = dependencyEntries(pending.manifest, optional, pending.includeDev);
        /* Resolved and ordered before any of them is given a home: the order is part of which
           package the walk reaches first. */
        const prepared = entries.map((entry) => {
            const dir = findInstalledCopy(fileSystem, pending.dir, entry.name);
            const installed = dir === undefined ? undefined : readManifest(fileSystem, dir) ?? {};
            const version = installed === undefined ? undefined : String(installed.version ?? '');
            return { entry, dir, installed, version, id: `${entry.name}@${version ?? entry.range}` };
        });
        prepared.sort((left, right) => comparePackageIds(left.id, right.id));
        for (const { entry, dir, installed, version } of prepared) {
            if (dir === undefined || installed === undefined || version === undefined) {
                const kind = entry.optional ? 'OPTIONAL ' : '';
                pending.node.children.push({
                    text: `UNMET ${kind}DEPENDENCY ${entry.name}@${entry.range}`,
                    children: []
                });
                continue;
            }
            const owner = seen.get(dir);
            if (owner !== undefined) {
                pending.node.children.push({ text: `${entry.name}@${version} deduped`, children: [] });
                continue;
            }
            const node: TreeNode = { text: `${entry.name}@${version}`, children: [] };
            seen.set(dir, node);
            pending.node.children.push(node);
            queue.push({ dir, levels: pending.levels - 1, manifest: installed, includeDev: false, node });
        }
    }
    return root.children;
}

/** One dependency of a package: the name it is asked for by, the range asked for, and whether it is optional. */
interface DependencyEntry {
    name: string;
    range: string;
    optional: boolean;
}

/**
 * The dependencies of one package, in the order npm draws them: a name both a dependency and an
 * optional dependency is optional, and devDependencies are the root's alone.
 */
function dependencyEntries(manifest: Record<string, any>, optional: Set<string>, includeDev: boolean): DependencyEntry[] {
    const entries: DependencyEntry[] = [];
    const collect = (source: Record<string, unknown>, isOptional: boolean) => {
        for (const [name, range] of Object.entries(source)) {
            if (!isOptional && optional.has(name)) continue;
            entries.push({ name, range: String(range), optional: isOptional });
        }
    };
    collect((manifest.dependencies ?? {}) as Record<string, unknown>, false);
    if (includeDev) collect((manifest.devDependencies ?? {}) as Record<string, unknown>, false);
    collect((manifest.optionalDependencies ?? {}) as Record<string, unknown>, true);
    return entries;
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
