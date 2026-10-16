import semver from 'semver';
import { IFileSystem } from '../filesystem';
import { NodeResolver, dirnameOf, joinPaths, normalizeAbsolute } from '../process/executors/node/runtime/resolver';
import { NpmRegistry, PackageVersion, selectVersion } from './registry';
import { PlatformFields, platformDescription, platformMismatch } from './platform';
import { INSTALL_SCRIPT_EVENTS, nodeArguments } from './lifecycle';
import { extractTarGz } from './tar';
import { writeNapiPlaceholders } from '../napi/placeholders';

export interface InstallSpec {
    name: string;
    range?: string;
}

export type SaveTarget = 'dependencies' | 'devDependencies' | 'none';

export interface InstallReport {
    added: string[];
}

/** Runs `node` with `args` in `cwd`, with extra environment variables; resolves to the exit code. */
export type ScriptRunner = (args: string[], cwd: string, env: Record<string, string>) => Promise<number>;

interface Edge {
    requesterDir: string;
    name: string;
    range?: string;
    optional: boolean;
    /** A peer dependency of a top-level package: wanted only while no copy is visible from the root. */
    peer?: boolean;
}

interface InstalledCopy {
    dir: string;
    version: string;
}

/**
 * Installs package trees into a virtual `node_modules`: dependencies are hoisted to the
 * project root when the slot is free, and nested under their requester otherwise. Every
 * tarball is integrity-checked before extraction.
 */
export class NpmInstaller {
    private resolver: NodeResolver;

    constructor(
        private fileSystem: IFileSystem,
        private registry: NpmRegistry,
        private log: (line: string) => void = () => { },
        private runScript?: ScriptRunner
    ) {
        this.resolver = new NodeResolver(fileSystem);
    }

    /** `npm install <specs...>`: installs the specs and their trees, then records them in package.json. */
    async addPackages(projectDir: string, specs: InstallSpec[], save: SaveTarget): Promise<InstallReport> {
        const root = normalizeAbsolute(projectDir);
        this.ensureManifest(root);
        const edges: Edge[] = specs.map(spec => ({ requesterDir: root, name: spec.name, range: spec.range, optional: false }));
        const { added, resolved } = await this.installTree(root, edges);
        if (save !== 'none') {
            const manifest = this.readManifest(root) ?? {};
            const field = (manifest[save] ?? {}) as Record<string, string>;
            for (const spec of specs) {
                field[spec.name] = savedRange(spec.range, resolved.get(spec.name) ?? '');
            }
            manifest[save] = field;
            this.writeManifest(root, manifest);
        }
        return { added };
    }

    /** `npm install` with no arguments: installs every dependency package.json declares. */
    async installManifest(projectDir: string): Promise<InstallReport> {
        const root = normalizeAbsolute(projectDir);
        this.ensureManifest(root);
        const manifest = this.readManifest(root) ?? {};
        const edges: Edge[] = [];
        for (const field of ['dependencies', 'devDependencies'] as const) {
            for (const [name, range] of Object.entries((manifest[field] ?? {}) as Record<string, string>)) {
                edges.push({ requesterDir: root, name, range, optional: false });
            }
        }
        for (const [name, range] of Object.entries((manifest.optionalDependencies ?? {}) as Record<string, string>)) {
            edges.push({ requesterDir: root, name, range, optional: true });
        }
        const { added } = await this.installTree(root, edges);
        return { added };
    }

    private async installTree(root: string, initial: Edge[]): Promise<{ added: string[]; resolved: Map<string, string> }> {
        const added: string[] = [];
        const resolved = new Map<string, string>();
        const installedDirs: string[] = [];
        const queue: Edge[] = [...initial];
        const seen = new Set<string>();
        const skipped = new Set<string>();

        while (queue.length > 0) {
            const edge = queue.shift()!;
            const requestKey = `${edge.requesterDir}|${edge.name}|${edge.range ?? ''}`;
            if (seen.has(requestKey)) continue;
            seen.add(requestKey);

            const spec = parseDependencySpec(edge.name, edge.range);
            if (spec === undefined) {
                this.log(`skipping ${edge.name}@${edge.range}: only registry versions are supported`);
                continue;
            }

            const visible = this.findVisibleCopy(edge.requesterDir, edge.name);
            if (edge.peer && visible !== undefined) continue;
            const isRootRequest = edge.requesterDir === root;
            const adopt = (copy: InstalledCopy) => {
                if (isRootRequest) resolved.set(edge.name, copy.version);
                this.enqueueDependencies(copy.dir, queue);
                if (isRootRequest) this.enqueuePeers(copy.dir, root, queue);
            };
            const range = spec.range;
            const reusable = visible !== undefined && (
                (range === undefined && !isRootRequest) ||
                (range !== undefined && semver.validRange(range) !== null && semver.satisfies(visible.version, range))
            );
            if (reusable) {
                adopt(visible);
                continue;
            }

            const packument = await this.registry.getPackument(spec.name);
            const version = selectVersion(packument, range);
            if (visible && visible.version === version.version) {
                adopt(visible);
                continue;
            }

            const unsupported = platformMismatch(version) ?? await this.libcMismatch(spec.name, version);
            if (unsupported !== undefined) {
                const label = `${edge.name}@${version.version}`;
                if (!edge.optional) {
                    const { wanted, current } = platformDescription(unsupported);
                    throw new Error(`npm error code EBADPLATFORM\nnpm error notsup Unsupported platform for ${label}: wanted ${wanted} (current: ${current})`);
                }
                if (!skipped.has(label)) {
                    skipped.add(label);
                    this.log(`skipped optional ${label}: unsupported platform`);
                }
                continue;
            }

            const target = this.placementFor(root, edge, isRootRequest);
            this.log(`+ ${edge.name}@${version.version}`);
            await this.installPackage(target, version);
            added.push(`${edge.name}@${version.version}`);
            installedDirs.push(target);
            if (isRootRequest) resolved.set(edge.name, version.version);
            this.enqueueDependencies(target, queue, version);
            if (isRootRequest) this.enqueuePeers(target, root, queue);
        }
        await this.runInstallScripts(installedDirs);
        return { added, resolved };
    }

    /** Root requests replace the hoisted copy; transitive conflicts nest under the requester. */
    private placementFor(root: string, edge: Edge, isRootRequest: boolean): string {
        const hoisted = joinPaths(root, 'node_modules', edge.name);
        if (isRootRequest || this.readVersion(hoisted) === undefined) return hoisted;
        return joinPaths(edge.requesterDir, 'node_modules', edge.name);
    }

    private enqueueDependencies(packageDir: string, queue: Edge[], known?: PackageVersion): void {
        const manifest = known
            ? { dependencies: known.dependencies, optionalDependencies: known.optionalDependencies }
            : this.readManifest(packageDir);
        if (!manifest) return;
        for (const [name, range] of Object.entries((manifest.dependencies ?? {}) as Record<string, string>)) {
            queue.push({ requesterDir: packageDir, name, range, optional: false });
        }
        for (const [name, range] of Object.entries((manifest.optionalDependencies ?? {}) as Record<string, string>)) {
            queue.push({ requesterDir: packageDir, name, range, optional: true });
        }
    }

    /** npm 7+ installs a top-level package's peer dependencies that the root does not provide yet. */
    private enqueuePeers(packageDir: string, root: string, queue: Edge[]): void {
        const manifest = this.readManifest(packageDir);
        if (!manifest) return;
        const meta = (manifest.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>;
        for (const [name, range] of Object.entries((manifest.peerDependencies ?? {}) as Record<string, string>)) {
            if (meta[name]?.optional) continue;
            queue.push({ requesterDir: root, name, range, optional: false, peer: true });
        }
    }

    /** npm runs install scripts once the tree is placed, with dependencies before the packages that need them. */
    private async runInstallScripts(packageDirs: string[]): Promise<void> {
        for (const dir of [...new Set(packageDirs)].reverse()) {
            const manifest = this.readManifest(dir) ?? {};
            const name = String(manifest.name ?? '');
            const version = String(manifest.version ?? '');
            const env = { npm_package_name: name, npm_package_version: version };
            const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
            for (const event of INSTALL_SCRIPT_EVENTS) {
                const command = scripts[event];
                if (typeof command !== 'string' || command.trim() === '') continue;
                const args = nodeArguments(command);
                if (args === undefined || this.runScript === undefined) {
                    this.log(`skipped ${event} script of ${name}@${version}: only "node <file>" and "node -e <code>" run in this runtime`);
                    continue;
                }
                const exitCode = await this.runScript(args, dir, env);
                if (exitCode !== 0) {
                    throw Object.assign(new Error(`npm error code ${exitCode}\nnpm error path ${dir}\nnpm error command failed\nnpm error command sh -c ${command}`), { exitCode });
                }
            }
        }
    }

    /**
     * A libc mismatch, which install metadata cannot show. Only versions that name an os or cpu are looked up,
     * so the full manifest is read for platform packages alone; an unreadable manifest leaves libc unchecked.
     */
    private async libcMismatch(name: string, version: PackageVersion): Promise<PlatformFields | undefined> {
        if (version.libc !== undefined || (version.os === undefined && version.cpu === undefined)) return undefined;
        try {
            const manifest = await this.registry.getVersionManifest(name, version.version);
            return platformMismatch({ libc: manifest.libc });
        } catch {
            return undefined;
        }
    }

    private async installPackage(target: string, version: PackageVersion): Promise<void> {
        const tarball = await this.registry.fetchTarball(version);
        if (this.fileSystem.statPath(target)) this.fileSystem.removePath(target, true);
        this.fileSystem.createDirectory(target);
        for (const entry of extractTarGz(tarball)) {
            const relative = entry.path.split('/').slice(1).join('/');
            if (relative === '') continue;
            const destination = joinPaths(target, relative);
            if (entry.type === 'dir') {
                this.fileSystem.createDirectory(destination);
            } else if (entry.type === 'file') {
                this.fileSystem.createDirectory(dirnameOf(destination));
                this.fileSystem.writeBytes(destination, entry.data);
            }
        }
        writeNapiPlaceholders(this.fileSystem, target, version.name);
        this.linkBinaries(target);
    }

    /** Writes node_modules/.bin shims that point at each package's bin files. */
    private linkBinaries(packageDir: string): void {
        const manifest = this.readManifest(packageDir);
        if (!manifest?.bin) return;
        const bins: Record<string, string> = typeof manifest.bin === 'string'
            ? { [String(manifest.name ?? '').split('/').pop() || 'bin']: manifest.bin }
            : manifest.bin;
        // the owning node_modules is the last such segment, which also holds for scoped packages
        const marker = '/node_modules/';
        const nodeModules = normalizeAbsolute(packageDir).slice(0, normalizeAbsolute(packageDir).lastIndexOf(marker) + marker.length - 1);
        const binDir = joinPaths(nodeModules, '.bin');
        this.fileSystem.createDirectory(binDir);
        for (const [binName, relativeFile] of Object.entries(bins)) {
            const file = normalizeAbsolute(joinPaths(packageDir, relativeFile));
            if (this.fileSystem.statPath(file)?.type !== 'file') continue;
            const statement = this.resolver.isESM(file)
                ? `import(${JSON.stringify(file)});`
                : `require(${JSON.stringify(file)});`;
            this.fileSystem.writeFile(joinPaths(binDir, binName), `#!/usr/bin/env node\n${statement}\n`);
        }
    }

    /** Nearest installed copy of `name` visible from `requesterDir`, walking up like Node. */
    private findVisibleCopy(requesterDir: string, name: string): InstalledCopy | undefined {
        let dir = normalizeAbsolute(requesterDir);
        while (true) {
            if (!dir.endsWith('/node_modules')) {
                const candidate = joinPaths(dir, 'node_modules', name);
                const version = this.readVersion(candidate);
                if (version !== undefined) return { dir: candidate, version };
            }
            if (dir === '/') return undefined;
            dir = dirnameOf(dir);
        }
    }

    private readVersion(packageDir: string): string | undefined {
        return this.readManifest(packageDir)?.version as string | undefined;
    }

    private readManifest(dir: string): Record<string, any> | undefined {
        const file = joinPaths(dir, 'package.json');
        if (this.fileSystem.statPath(file)?.type !== 'file') return undefined;
        try {
            return JSON.parse(this.fileSystem.readFile(file) ?? '');
        } catch {
            return undefined;
        }
    }

    private writeManifest(root: string, manifest: Record<string, unknown>): void {
        this.fileSystem.writeFile(joinPaths(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    }

    private ensureManifest(root: string): void {
        this.fileSystem.createDirectory(root);
        if (this.readManifest(root) !== undefined) return;
        const name = root.split('/').filter(Boolean).pop() || 'project';
        this.writeManifest(root, { name, version: '1.0.0' });
    }
}

/** The range npm writes to package.json for a spec: ranges as given, exact versions and tags as ^resolved. */
export function savedRange(range: string | undefined, resolvedVersion: string): string {
    if (range === undefined) return `^${resolvedVersion}`;
    if (semver.valid(range) !== null) return `^${range}`;
    if (semver.validRange(range) !== null) return range;
    return `^${resolvedVersion}`;
}

/** Splits a command-line spec such as `lodash@^4`, `@scope/pkg` or `@scope/pkg@1.2.0`. */
export function parseInstallSpec(arg: string): InstallSpec {
    const at = arg.startsWith('@') ? arg.indexOf('@', 1) : arg.indexOf('@');
    if (at <= 0) return { name: arg };
    return { name: arg.slice(0, at), range: arg.slice(at + 1) || undefined };
}

/**
 * Resolves the spec a dependency entry asks for. `npm:` aliases are followed; git, file and
 * URL specs are not supported and yield undefined.
 */
export function parseDependencySpec(name: string, range: string | undefined): { name: string; range?: string } | undefined {
    if (range === undefined) return { name, range: undefined };
    if (range.startsWith('npm:')) {
        const body = range.slice('npm:'.length);
        const at = body.lastIndexOf('@');
        if (at > 0) return { name: body.slice(0, at), range: body.slice(at + 1) };
        return { name: body, range: undefined };
    }
    if (semver.validRange(range) !== null || /^[A-Za-z][A-Za-z0-9_.-]*$/.test(range)) {
        return { name, range };
    }
    return undefined;
}
