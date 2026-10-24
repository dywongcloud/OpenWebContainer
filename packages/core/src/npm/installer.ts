import semver from 'semver';
import { IFileSystem } from '../filesystem';
import { NodeResolver, dirnameOf, joinPaths, normalizeAbsolute } from '../process/executors/node/runtime/resolver';
import { NpmRegistry, PackageVersion, Packument, selectVersion } from './registry';
import { lockKey, LockTreeNode, writeLockfile } from './lockfile';
import { PlatformFields, platformDescription, platformMismatch } from './platform';
import { INSTALL_SCRIPT_EVENTS, nodeArguments } from './lifecycle';
import { nativeExecutable } from './native';
import { extractTarGz } from './tar';
import { writeNapiPlaceholders } from '../napi/placeholders';

export interface InstallSpec {
    name: string;
    range?: string;
    /**
     * A directory on the virtual file system this spec installs from, which is what `npm install
     * ./localpkg` and `npm install file:./localpkg` name. A spec with one is a local dependency:
     * nothing is asked of the registry for it, and what package.json in that directory declares is
     * the package -- its name and version -- that lands in the tree.
     */
    localPath?: string;
}

export type SaveTarget = 'dependencies' | 'devDependencies' | 'none';

export interface InstallReport {
    added: string[];
}

/** What a lifecycle script did: the exit code npm decides the install on, and the output npm prints when it failed. */
export interface ScriptRunResult {
    exitCode: number;
    output: string;
}

/** Runs `node` with `args` in `cwd`, with extra environment variables; resolves to what the script did. */
export type ScriptRunner = (args: string[], cwd: string, env: Record<string, string>) => Promise<ScriptRunResult>;

interface Edge {
    requesterDir: string;
    name: string;
    range?: string;
    optional: boolean;
    /** Reached through a devDependencies entry: the lockfile marks the packages it leads to dev. */
    dev: boolean;
    /** A peer dependency of a top-level package: wanted only while no copy is visible from the root. */
    peer?: boolean;
    /** A directory this edge installs from instead of the registry, as `npm install ./localpkg` has it. */
    localPath?: string;
}

interface InstalledCopy {
    dir: string;
    version: string;
}

/**
 * What one edge of a wave asks for: the copy already in the tree that it adopts, or the version it
 * has to resolve. The packument, version and libc manifest are filled in for the whole wave at once,
 * which is what lets one request serve every edge that needs it.
 */
type ResolvePlan = {
    kind: 'resolve';
    edge: Edge;
    spec: { name: string; range?: string };
    isRootRequest: boolean;
    packument?: Packument;
    version?: PackageVersion;
    manifest?: Promise<PackageVersion>;
};

/** An edge the local file system answers: the package is copied out of `source`, not fetched. */
type LocalPlan = {
    kind: 'local';
    edge: Edge;
    source: string;
    manifest: Record<string, any> | undefined;
};

type Plan = ResolvePlan | LocalPlan;

/**
 * What an edge does once the wave's tarballs are placed: recording the node and enqueuing the edges
 * below it read the tree as written, so they see what npm sees when it reaches the same edge.
 */
interface Action {
    edge: Edge;
    dir: string;
    /** The version this wave placed at `dir`, absent when the edge adopted a copy already there. */
    version?: PackageVersion;
    /** The version at `dir`: what the lockfile and `npm install <spec>` record for it. */
    placed?: string;
}

/** Registry requests kept in flight at once. Measured against the registry: past about eight, more requests in flight move the same bytes slower, not faster. */
const REQUEST_CONCURRENCY = 8;

/**
 * Tarballs downloaded at once. Downloads overlap while one package is being extracted, which is the
 * part that cannot overlap; four is where that overlap is paid for, because a package in flight holds
 * its tarball, its inflated archive and every entry of it at once.
 */
const INSTALL_CONCURRENCY = 4;

/**
 * Installs package trees into a virtual `node_modules`: dependencies are hoisted to the
 * project root when the slot is free, and nested under their requester otherwise. Every
 * tarball is integrity-checked before extraction.
 */
export class NpmInstaller {
    private resolver: NodeResolver;
    /** package.json already read from a directory, including the reads that found none. */
    private manifestCache = new Map<string, Record<string, any> | undefined>();

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
        const edges: Edge[] = specs.map(spec => this.specEdge(root, spec, save === 'devDependencies'));
        const { added, resolved, nodes } = await this.installTree(root, edges);
        if (save !== 'none') {
            const manifest = this.readManifest(root) ?? {};
            const field = (manifest[save] ?? {}) as Record<string, string>;
            for (const [index, spec] of specs.entries()) {
                /* A local spec was handed over as a path alone, so the name it is recorded under is
                   the one the directory's own package.json declares, read into the edge above. */
                const name = edges[index].name;
                /* A local dependency is recorded as the path it was installed from, not as a
                   version: npm writes `file:localpkg`, and reads the package out of that directory
                   again on every later install. */
                field[name] = spec.localPath !== undefined
                    ? `file:${relativeSpec(root, spec.localPath)}`
                    : savedRange(spec.range, resolved.get(name) ?? '');
            }
            manifest[save] = field;
            this.writeManifest(root, manifest);
        }
        this.writeLock(root, nodes);
        return { added };
    }

    /** `npm install` with no arguments: installs every dependency package.json declares. */
    async installManifest(projectDir: string): Promise<InstallReport> {
        const root = normalizeAbsolute(projectDir);
        this.ensureManifest(root);
        const manifest = this.readManifest(root) ?? {};
        const optional = optionalNames(manifest);
        const edges: Edge[] = [];
        for (const [name, range] of Object.entries((manifest.dependencies ?? {}) as Record<string, string>)) {
            if (optional.has(name)) continue;
            edges.push({ requesterDir: root, name, range, optional: false, dev: false });
        }
        for (const [name, range] of Object.entries((manifest.devDependencies ?? {}) as Record<string, string>)) {
            edges.push({ requesterDir: root, name, range, optional: false, dev: true });
        }
        for (const [name, range] of Object.entries((manifest.optionalDependencies ?? {}) as Record<string, string>)) {
            edges.push({ requesterDir: root, name, range, optional: true, dev: false });
        }
        const { added, nodes } = await this.installTree(root, edges);
        this.writeLock(root, nodes);
        return { added };
    }

    /**
     * The edge one requested spec becomes. A local spec is read now, so that the install knows the
     * name and version the directory declares before anything is placed: they are what the tree,
     * the lockfile and the summary line name the package by.
     */
    private specEdge(root: string, spec: InstallSpec, dev: boolean): Edge {
        if (spec.localPath === undefined) {
            return { requesterDir: root, name: spec.name, range: spec.range, optional: false, dev };
        }
        const source = normalizeAbsolute(spec.localPath);
        const manifest = this.readManifest(source);
        /* npm refuses a directory with no package.json in it: there is no package there to install,
           and no name to put it in the tree under. */
        if (manifest === undefined) {
            throw new Error(`npm error code ENOLOCAL\nnpm error Could not install from "${source}" as it does not contain a package.json file`);
        }
        const name = typeof manifest.name === 'string' && manifest.name !== ''
            ? manifest.name
            : source.split('/').filter(Boolean).pop() ?? spec.name;
        return { requesterDir: root, name, range: spec.range, optional: false, dev, localPath: source };
    }

    /** `package-lock.json` for the tree just installed, in npm's lockfileVersion 3 layout. */
    private writeLock(root: string, nodes: LockTreeNode[]): void {
        writeLockfile(this.fileSystem, root, this.readManifest(root) ?? {}, nodes);
    }

    private async installTree(root: string, initial: Edge[]): Promise<{ added: string[]; resolved: Map<string, string>; nodes: LockTreeNode[] }> {
        const added: string[] = [];
        const resolved = new Map<string, string>();
        const installedDirs: string[] = [];
        const queue: Edge[] = [...initial];
        const seen = new Set<string>();
        const skipped = new Set<string>();
        /* One entry per package directory, as the lockfile records it. A package several edges
           reach is dev (or optional) only when every edge that reaches it is. */
        const nodes = new Map<string, LockTreeNode>();
        const record = (dir: string, edge: Edge, version?: PackageVersion) => {

            const key = lockKey(root, dir);
            const manifest = this.readManifest(dir) ?? {};
            const known = nodes.get(key);
            if (known === undefined) {
                nodes.set(key, {
                    key,
                    version: typeof manifest.version === 'string' ? manifest.version : version?.version ?? '',
                    resolved: version?.dist.tarball,
                    integrity: version?.dist.integrity,
                    dev: edge.dev,
                    optional: edge.optional,
                    manifest
                });
                return;
            }
            known.dev = known.dev && edge.dev;
            known.optional = known.optional && edge.optional;
        };

        while (queue.length > 0) {
            /* One wave is every edge the tree has reached so far. Their packuments are requested
               together and their tarballs downloaded together, so the wave costs its slowest
               request instead of the sum of them all. Each edge is still decided in npm's order,
               and a copy a later edge can see is one this wave is about to place, so the wave
               claims the directories it is going to write before any of them is written. */
            const wave = queue.splice(0, queue.length);
            const claimed = new Map<string, string>();
            const plans: Plan[] = [];
            const packuments = new Map<string, Promise<Packument>>();
            const wanted = new Set<string>();

            for (const edge of wave) {
                const requestKey = `${edge.requesterDir}|${edge.name}|${edge.range ?? ''}`;
                if (seen.has(requestKey)) continue;
                seen.add(requestKey);

                /* A local dependency is answered by the file system alone: it is never a name the
                   registry is asked for, so it leaves the wave's requests to the packages that are. */
                if (edge.localPath !== undefined) {
                    plans.push({ kind: 'local', edge, source: edge.localPath, manifest: this.readManifest(edge.localPath) });
                    continue;
                }

                /* Nothing about the tree is asked yet: whether this edge adopts a copy the tree
                   already has depends on what the edges before it place, and that is decided in one
                   pass below, once every packument of the wave is in. */
                const spec = parseDependencySpec(edge.name, edge.range);
                if (spec === undefined) {
                    this.log(`skipping ${edge.name}@${edge.range}: only registry versions are supported`);
                    continue;
                }
                /* One request per package name, however many edges of the wave ask for it. */
                wanted.add(spec.name);
                plans.push({ kind: 'resolve', edge, spec, isRootRequest: edge.requesterDir === root });
            }

            /* The requests are started by the limiter, not by the loop above: a wave of a few hundred
               packages asking for a few hundred packuments at once is slower than asking in batches. */
            await mapWithConcurrency([...wanted], REQUEST_CONCURRENCY, async (name) => {
                const packument = this.registry.getPackument(name);
                packuments.set(name, packument);
                await packument.then(() => undefined, () => undefined);
            });
            const resolves = plans.filter((plan): plan is ResolvePlan => plan.kind === 'resolve');
            for (const plan of resolves) {
                plan.packument = await packuments.get(plan.spec.name)!;
            }

            /* The full manifest the libc check reads: install metadata leaves libc out, and only the
               versions whose os and cpu this container matches need the extra request. */
            const manifests = new Map<string, Promise<PackageVersion>>();
            const libc: { name: string; version: string }[] = [];
            const asked = new Set<string>();
            for (const plan of resolves) {
                const version = selectVersion(plan.packument!, plan.spec.range);
                plan.version = version;
                if (platformMismatch(version) !== undefined) continue;
                if (version.libc !== undefined || (version.os === undefined && version.cpu === undefined)) continue;
                const key = `${plan.spec.name}@${version.version}`;
                if (asked.has(key)) continue;
                asked.add(key);
                libc.push({ name: plan.spec.name, version: version.version });
            }
            await mapWithConcurrency(libc, REQUEST_CONCURRENCY, async ({ name, version }) => {
                const manifest = this.registry.getVersionManifest(name, version);
                manifests.set(`${name}@${version}`, manifest);
                await manifest.then(() => undefined, () => undefined);
            });
            for (const plan of resolves) {
                plan.manifest = manifests.get(`${plan.spec.name}@${plan.version!.version}`);
            }

            /* One pass, in the order npm reaches them: what an edge sees is what the edges before it
               in this wave placed, so a package the whole wave needs is placed once, at the root. */
            const installs: { target: string; version: PackageVersion }[] = [];
            const localCopies: { target: string; source: string }[] = [];
            const actions: Action[] = [];
            for (const plan of plans) {
                const { edge } = plan;
                /* A local dependency is copied out of its directory into the place a fetched
                   package would have gone, in the same pass and under the same claim as the rest,
                   so a registry package of the same name is placed once and this one nests. */
                if (plan.kind === 'local') {
                    const version = typeof plan.manifest?.version === 'string' ? plan.manifest.version : '';
                    const target = this.placementFor(root, edge, edge.requesterDir === root, claimed);
                    claimed.set(target, version);
                    added.push(`${edge.name}@${version}`);
                    localCopies.push({ target, source: plan.source });
                    actions.push({ edge, dir: target, placed: version });
                    continue;
                }
                const isRootRequest = plan.isRootRequest;
                const visible = this.findVisibleCopy(edge.requesterDir, edge.name, claimed);
                if (edge.peer && visible !== undefined) continue;
                const range = plan.spec.range;
                const reusable = visible !== undefined && (
                    (range === undefined && !isRootRequest) ||
                    (range !== undefined && semver.validRange(range) !== null && semver.satisfies(visible.version, range))
                );
                if (reusable) {
                    actions.push({ edge, dir: visible!.dir, placed: visible!.version });
                    continue;
                }
                const version = plan.version!;
                if (visible !== undefined && visible.version === version.version) {
                    actions.push({ edge, dir: visible.dir, placed: visible.version });
                    continue;
                }

                const unsupported = platformMismatch(version) ?? await this.libcMismatch(plan.manifest);
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

                const target = this.placementFor(root, edge, plan.isRootRequest, claimed);
                claimed.set(target, version.version);
                added.push(`${edge.name}@${version.version}`);
                installedDirs.push(target);
                installs.push({ target, version });
                actions.push({ edge, dir: target, version, placed: version.version });
            }

            /* A local dependency is already on the file system, so it lands before anything is
               fetched: the packages below it read the copy, not the directory it came from. */
            for (const { target, source } of localCopies) {
                this.copyLocalPackage(source, target);
                this.forgetManifests(target);
                this.linkBinaries(target);
            }

            /* Two edges of one wave that land in the same directory replace each other, and the last
               one has to win, so a target is placed after whatever the wave already sends to it. */
            const placed = new Map<string, Promise<void>>();
            await mapWithConcurrency(installs, INSTALL_CONCURRENCY, ({ target, version }) => {
                const previous = placed.get(target) ?? Promise.resolve();
                const run = previous.then(() => this.placePackage(target, version), () => this.placePackage(target, version));
                placed.set(target, run.then(() => { }, () => { }));
                return run;
            });
            /* What a later edge reads about the tree is what this wave wrote, not what it replaced. */
            for (const { target } of installs) this.forgetManifests(target);
            for (const { target } of installs) this.linkBinaries(target);

            for (const action of actions) {
                const { edge } = action;
                const isRootRequest = edge.requesterDir === root;
                record(action.dir, edge, action.version);
                if (isRootRequest && action.placed !== undefined) resolved.set(edge.name, action.placed);
                queue.push(...this.dependenciesOf(action.dir, edge.dev, edge.optional, action.version));
                if (isRootRequest) queue.push(...this.peersOf(action.dir, root, edge.dev));
            }
        }
        await this.runInstallScripts(installedDirs);
        return { added, resolved, nodes: [...nodes.values()] };
    }

    /** Root requests replace the hoisted copy; transitive conflicts nest under the requester. */
    private placementFor(root: string, edge: Edge, isRootRequest: boolean, claimed: Map<string, string>): string {
        const hoisted = joinPaths(root, 'node_modules', edge.name);
        if (isRootRequest) return hoisted;
        if (this.readVersion(hoisted) === undefined && !claimed.has(hoisted)) return hoisted;
        return joinPaths(edge.requesterDir, 'node_modules', edge.name);
    }

    /**
     * The edges a package's own dependencies become. Everything below an optional edge is optional
     * too, so the subtree of a package npm may skip is skipped with it rather than failing on it.
     */
    private dependenciesOf(packageDir: string, dev: boolean, optional: boolean, known?: PackageVersion): Edge[] {
        const manifest = known
            ? { dependencies: known.dependencies, optionalDependencies: known.optionalDependencies }
            : this.readManifest(packageDir);
        if (!manifest) return [];
        const alsoOptional = optionalNames(manifest);
        const edges: Edge[] = [];
        for (const [name, range] of Object.entries((manifest.dependencies ?? {}) as Record<string, string>)) {
            if (alsoOptional.has(name)) continue;
            edges.push({ requesterDir: packageDir, name, range, optional, dev });
        }
        for (const [name, range] of Object.entries((manifest.optionalDependencies ?? {}) as Record<string, string>)) {
            edges.push({ requesterDir: packageDir, name, range, optional: true, dev });
        }
        return edges;
    }

    /** npm 7+ installs a top-level package's peer dependencies that the root does not provide yet. */
    private peersOf(packageDir: string, root: string, dev: boolean): Edge[] {
        const manifest = this.readManifest(packageDir);
        if (!manifest) return [];
        const meta = (manifest.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>;
        const edges: Edge[] = [];
        for (const [name, range] of Object.entries((manifest.peerDependencies ?? {}) as Record<string, string>)) {
            if (meta[name]?.optional) continue;
            edges.push({ requesterDir: root, name, range, optional: false, dev, peer: true });
        }
        return edges;
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
                const binary = nativeExecutable(this.fileSystem, dir, manifest);
                if (binary !== undefined) {
                    /* The script exists to run that binary, so running it can only fail: refuse
                       first and name the executable, which is the fact the reader needs, instead of
                       letting the failure surface as a crash inside a postinstall nobody reads. */
                    throw Object.assign(
                        new Error(`npm error code ENOEXEC\nnpm error path ${dir}\nnpm error command sh -c ${command}\nnpm error ${name}@${version} runs the native executable ${binary} in its ${event} script; this container executes JavaScript only`),
                        { exitCode: 126 }
                    );
                }
                const args = nodeArguments(command);
                if (args === undefined || this.runScript === undefined) {
                    this.log(`skipped ${event} script of ${name}@${version}: only "node <file>" and "node -e <code>" run in this runtime`);
                    continue;
                }
                const result = await this.runScript(args, dir, env);
                const exitCode = result.exitCode;
                if (exitCode !== 0) {
                    /* npm prints the failing script's own output as npm error lines, so the install
                       failure names its cause (a binary this container cannot spawn, say) instead of
                       leaving only an exit code beside a stack the reader has to go and find. */
                    const cause = scriptErrorLines(result.output);
                    throw Object.assign(
                        new Error(`npm error code ${exitCode}\nnpm error path ${dir}\nnpm error command failed\nnpm error command sh -c ${command}${cause}`),
                        { exitCode }
                    );
                }
            }
        }
    }

    /**
     * A libc mismatch, which install metadata cannot show. Only versions that name an os or cpu are looked up,
     * so the full manifest is read for platform packages alone; an unreadable manifest leaves libc unchecked.
     */
    private async libcMismatch(manifest: Promise<PackageVersion> | undefined): Promise<PlatformFields | undefined> {
        if (manifest === undefined) return undefined;
        try {
            const full = await manifest;
            return platformMismatch({ libc: full.libc });
        } catch {
            return undefined;
        }
    }

    /**
     * Downloads, verifies and unpacks one tarball into `target`. The bin shims are linked once the
     * whole wave is placed, so a shim never races another package's.
     */
    private async placePackage(target: string, version: PackageVersion): Promise<void> {
        const tarball = await this.registry.fetchTarball(version);
        if (this.fileSystem.statPath(target)) this.fileSystem.removePath(target, true);
        const made = new Set<string>(['/']);
        for (const ancestor of ancestorsOf(target)) made.add(ancestor);
        this.fileSystem.createDirectory(target);
        made.add(target);
        for (const entry of extractTarGz(tarball)) {
            const relative = entry.path.split('/').slice(1).join('/');
            if (relative === '') continue;
            const destination = joinPaths(target, relative);
            if (entry.type === 'dir') {
                this.ensureDirectory(destination, made);
            } else if (entry.type === 'file') {
                this.ensureDirectory(dirnameOf(destination), made);
                this.fileSystem.writeBytes(destination, entry.data);
            }
        }
        writeNapiPlaceholders(this.fileSystem, target, version.name);
    }

    /**
     * `npm install ./localpkg`: the directory's own files are copied into the place a fetched
     * package would have gone. npm links it instead, but a copy answers `npm ls`, `npm exec` and a
     * `require` of the package the same way, and the tree this runtime writes is one of real
     * directories throughout.
     *
     * The directory's own `node_modules` is left behind: what it declares as dependencies is
     * installed by this install, into the tree, and a tree inside a package of the tree is not
     * something npm resolves either.
     */
    private copyLocalPackage(source: string, target: string): void {
        const from = normalizeAbsolute(source);
        const to = normalizeAbsolute(target);
        if (this.fileSystem.statPath(from)?.type !== 'dir') {
            throw new Error(`npm error code ENOLOCAL\nnpm error Could not install from "${from}" as it does not contain a package.json file`);
        }
        if (this.fileSystem.statPath(to)) this.fileSystem.removePath(to, true);
        for (const ancestor of ancestorsOf(to)) {
            if (this.fileSystem.statPath(ancestor)?.type !== 'dir') this.fileSystem.createDirectory(ancestor);
        }
        this.copyTree(from, to);
    }

    private copyTree(from: string, to: string): void {
        const stat = this.fileSystem.statPath(from);
        if (stat === undefined) return;
        if (stat.type !== 'dir') {
            this.fileSystem.writeBytes(to, this.fileSystem.readBytes(from) ?? new Uint8Array());
            return;
        }
        this.fileSystem.createDirectory(to);
        for (const name of this.fileSystem.readdirNames(from) ?? []) {
            if (name === 'node_modules') continue;
            this.copyTree(joinPaths(from, name), joinPaths(to, name));
        }
    }

    /** Creates `dir` and the parents of it this extraction has not created yet. */
    private ensureDirectory(dir: string, made: Set<string>): void {
        if (made.has(dir)) return;
        for (const ancestor of ancestorsOf(dir)) {
            if (made.has(ancestor)) continue;
            made.add(ancestor);
            this.fileSystem.createDirectory(ancestor);
        }
        made.add(dir);
        this.fileSystem.createDirectory(dir);
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

    /**
     * Nearest installed copy of `name` visible from `requesterDir`, walking up like Node. A directory
     * `claimed` by an earlier edge of the same wave counts: that copy is installed by the time this
     * edge would have looked, and hoisting has to see it to place a conflicting version beside it.
     */
    private findVisibleCopy(requesterDir: string, name: string, claimed?: Map<string, string>): InstalledCopy | undefined {
        let dir = normalizeAbsolute(requesterDir);
        while (true) {
            if (!dir.endsWith('/node_modules')) {
                const candidate = joinPaths(dir, 'node_modules', name);
                /* The claim wins: by the time this edge looks, the wave has written that directory. */
                const version = claimed?.get(candidate) ?? this.readVersion(candidate);
                if (version !== undefined) return { dir: candidate, version };
            }
            if (dir === '/') return undefined;
            dir = dirnameOf(dir);
        }
    }

    private readVersion(packageDir: string): string | undefined {
        return this.readManifest(packageDir)?.version as string | undefined;
    }

    /** package.json of `dir`, read once per install: an install reads the same few again and again. */
    private readManifest(dir: string): Record<string, any> | undefined {
        if (this.manifestCache.has(dir)) return this.manifestCache.get(dir);
        const file = joinPaths(dir, 'package.json');
        let manifest: Record<string, any> | undefined;
        if (this.fileSystem.statPath(file)?.type === 'file') {
            try {
                manifest = JSON.parse(this.fileSystem.readFile(file) ?? '');
            } catch {
                manifest = undefined;
            }
        }
        this.manifestCache.set(dir, manifest);
        return manifest;
    }

    /** Forgets everything read under `dir`, which a package just placed has replaced. */
    private forgetManifests(dir: string): void {
        const prefix = dir.endsWith('/') ? dir : dir + '/';
        for (const key of [...this.manifestCache.keys()]) {
            if (key === dir || key.startsWith(prefix)) this.manifestCache.delete(key);
        }
    }

    private writeManifest(root: string, manifest: Record<string, unknown>): void {
        this.fileSystem.writeFile(joinPaths(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
        this.forgetManifests(root);
    }

    private ensureManifest(root: string): void {
        this.fileSystem.createDirectory(root);
        if (this.readManifest(root) !== undefined) return;
        const name = root.split('/').filter(Boolean).pop() || 'project';
        this.writeManifest(root, { name, version: '1.0.0' });
    }
}

/**
 * The packages a manifest names in `optionalDependencies`: npm lets that entry override the one of
 * the same name in `dependencies`, so a package listed in both is optional -- react-scripts lists
 * fsevents in both, and installing it for a platform it does not support fails the install where
 * npm skips it. The optionalDependencies entry is the one npm uses, so only it becomes an edge.
 */
function optionalNames(manifest: Record<string, any>): Set<string> {
    return new Set(Object.keys((manifest.optionalDependencies ?? {}) as Record<string, string>));
}

/** '/a/b/c' as the directories above it: '/a', '/a/b'. */
function ancestorsOf(dir: string): string[] {
    const parts = normalizeAbsolute(dir).split('/').filter(Boolean);
    const out: string[] = [];
    let at = '';
    for (let i = 0; i < parts.length - 1; i++) {
        at += '/' + parts[i];
        out.push(at);
    }
    return out;
}

/**
 * Runs `work` over `items`, at most `limit` at a time, and stops at the first failure: a wave
 * downloads its tarballs together, and a download that fails stops the ones behind it.
 */
async function mapWithConcurrency<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    let stopped = false;
    let failure: unknown;
    const runners: Promise<void>[] = [];
    for (let lane = 0; lane < Math.min(limit, items.length); lane++) {
        runners.push((async () => {
            while (!stopped && cursor < items.length) {
                try {
                    await work(items[cursor++]);
                } catch (error) {
                    stopped = true;
                    failure = error;
                    return;
                }
            }
        })());
    }
    await Promise.all(runners);
    if (failure !== undefined) throw failure;
}

/** The cause lines of a failed script's output as npm error lines: the messages, not their stack frames. */
function scriptErrorLines(output: string): string {
    const lines = output
        .replace(/\r/g, '')
        .split('\n')
        .filter((line) => line.trim() !== '' && !/^\s/.test(line));
    if (lines.length === 0) return '';
    return '\n' + lines.slice(-6).map((line) => `npm error ${line}`).join('\n');
}

/** The range npm writes to package.json for a spec: ranges as given, exact versions and tags as ^resolved. */
export function savedRange(range: string | undefined, resolvedVersion: string): string {
    if (range === undefined) return `^${resolvedVersion}`;
    if (semver.valid(range) !== null) return `^${range}`;
    if (semver.validRange(range) !== null) return range;
    return `^${resolvedVersion}`;
}

/**
 * The directory a spec names, or undefined for a spec that is a registry name's.
 *
 * npm reads `file:` and any spec that starts with a path -- `./localpkg`, `../localpkg`,
 * `/abs/localpkg` -- as a package on the file system; a bare name is a name, and so is a scoped one
 * whose slash belongs to the scope. This is the whole of the local half of a spec: everything else
 * is the registry's, which is why a directory this container already holds is installed without a
 * network it does not have.
 */
export function localSpecTarget(arg: string, cwd: string): string | undefined {
    const text = arg.startsWith('file:') ? arg.slice('file:'.length) : arg;
    if (text === '') return undefined;
    if (!arg.startsWith('file:') && !isPathSpec(text)) return undefined;
    return text.startsWith('/') ? normalizeAbsolute(text) : normalizeAbsolute(joinPaths(cwd, text));
}

/** Whether a bare word is a path npm would read as a directory: `.`, `..`, `./x`, `../x`, `/x`. */
function isPathSpec(text: string): boolean {
    return text === '.' || text === '..' ||
        text.startsWith('./') || text.startsWith('../') || text.startsWith('/') || text.startsWith('~/');
}

/** `target` as the path npm writes after `file:` in package.json: relative to the package, absolute when it is not under it. */
function relativeSpec(root: string, target: string): string {
    const from = normalizeAbsolute(root);
    const to = normalizeAbsolute(target);
    if (to === from) return '.';
    if (to.startsWith(from + '/')) return to.slice(from.length + 1);
    return to;
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
