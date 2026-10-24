import { IFileSystem } from '../../../filesystem';
import { InstallSpec, NpmInstaller, localSpecTarget, parseInstallSpec, ScriptRunResult } from '../../../npm/installer';
import { NpmRegistry } from '../../../npm/registry';
import { runPkgCommand } from '../../../npm/pkg';
import { didYouMean } from '../../../npm/didyoumean';
import {
    LIFECYCLE_COMMANDS,
    NPM_VERSION,
    findPackageRoot,
    missingScriptMessage,
    parseScriptArgs,
    readManifest,
    scriptCommandLine,
    scriptEvents,
    scriptHeader,
    scriptLabel,
    scriptList,
    scriptPath
} from '../../../npm/scripts';
import { dependencyTree, parseListArgs } from '../../../npm/tree';
import { Process, ProcessType } from '../../base';
import { dirnameOf, joinPaths, normalizeAbsolute } from '../node/runtime/resolver';
import { ROOT_POST_INSTALL_SCRIPT_EVENTS, ROOT_PRE_INSTALL_SCRIPT_EVENTS } from '../../../npm/lifecycle';

const USAGE = [
    'Usage: npm <command>',
    '',
    'Commands supported by this runtime:',
    '  npm install [<pkg>[@range] ...] [-D|--save-dev] [--no-save]   aliases: i, add',
    '  npm init [-y]',
    '  npm ls [--depth=<n>] [--all]                                      aliases: list',
    '  npm run [<script> [-- <args>]] [--if-present]                 alias: run-script',
    '  npm test | npm start | npm stop | npm restart',
    '  npm exec [<pkg>[@range>] [-- <args>]] [-p|--package <pkg>]    alias: x',
    '  npm pkg get|set|delete [<key>...] | npm pkg fix',
    '',
    'npx [-y] [-p <pkg>] <command|pkg[@range]> [args...]',
    ''
].join('\n');

/** What npm writes when the package it was handed has no bin of the name it was asked to run. */
const NPX_EXECUTABLE_MESSAGE = 'npm error could not determine executable to run';

/** npm's own duration in a summary line: milliseconds under a second, whole seconds above it. */
function elapsedDuration(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`;
}

/**
 * `npm` and `npx` implemented on the host: packages are fetched from the registry and
 * installed into the container's file system; bins run as node child processes.
 */
export class NpmProcess extends Process {
    private fileSystem: IFileSystem;

    constructor(
        pid: number,
        executablePath: string,
        args: string[],
        fileSystem: IFileSystem,
        parentPid?: number,
        cwd?: string
    ) {
        super(pid, ProcessType.JAVASCRIPT, executablePath, args, parentPid, cwd);
        this.fileSystem = fileSystem;
    }

    protected async execute(): Promise<void> {
        const registry = new NpmRegistry();
        const log = (line: string) => this.emitOutput(line + '\n');
        try {
            this._exitCode = this.executablePath === 'npx'
                ? await this.runNpx(registry, log)
                : await this.runNpm(registry, log);
        } catch (error: any) {
            this.emitError(`${error.message}\n`);
            this._exitCode = typeof error.exitCode === 'number' ? error.exitCode : 1;
        }
    }

    private async runNpm(registry: NpmRegistry, log: (line: string) => void): Promise<number> {
        const [command, ...rest] = this.args;
        switch (command) {
            case 'install':
            case 'i':
            case 'add':
                return this.install(rest, registry, log);
            case 'init':
                return this.init();
            case 'ls':
            case 'list':
                return this.listDependencies(rest);
            case undefined:
            case 'help':
            case '--help':
            case '-h':
                this.emitOutput(USAGE);
                return 0;
            case '-v':
            case '--version':
                this.emitOutput(NPM_VERSION + '\n');
                return 0;
            case 'run':
            case 'run-script':
                return this.runScript(rest);
            case 'test':
            case 'start':
            case 'stop':
            case 'restart':
                return this.runScript(rest, LIFECYCLE_COMMANDS[command]);
            case 'exec':
            case 'x':
                return this.runExec(rest, registry, log);
            case 'pkg':
                return this.runPkg(rest);
            default:
                return this.unknownCommand(command);
        }
    }

    /** `npm pkg get|set|delete|fix`: the subcommand that reads and writes package.json as data. */
    private runPkg(args: string[]): number {
        const result = runPkgCommand(this.fileSystem, args, this.cwd ?? '/');
        if (result.stdout !== '') this.emitOutput(result.stdout);
        if (result.stderr !== '') this.emitError(result.stderr);
        return result.exitCode;
    }

    /**
     * A command npm does not have. npm answers it on stdout, not on stderr -- an unknown command is
     * a question about npm's own names, and it suggests the ones that were meant.
     */
    private unknownCommand(command: string): number {
        const packageDir = findPackageRoot(this.fileSystem, this.cwd ?? '/');
        const suggestions = didYouMean(packageDir === undefined ? undefined : readManifest(this.fileSystem, packageDir), command);
        this.emitOutput([
            `Unknown command: "${command}"`,
            suggestions,
            'To see a list of supported npm commands, run:',
            '  npm help'
        ].join('\n') + '\n');
        return 1;
    }

    private async install(args: string[], registry: NpmRegistry, log: (line: string) => void): Promise<number> {
        let save: 'dependencies' | 'devDependencies' | 'none' = 'dependencies';
        const specs: InstallSpec[] = [];
        for (const arg of args) {
            if (arg === '-D' || arg === '--save-dev') save = 'devDependencies';
            else if (arg === '-P' || arg === '--save-prod' || arg === '-S' || arg === '--save') save = 'dependencies';
            else if (arg === '--no-save') save = 'none';
            else if (arg === '-g' || arg === '--global') throw new Error('Global installs are not supported by this runtime');
            else if (arg.startsWith('-')) continue;
            else {
                /* A spec that names a directory -- `./localpkg`, `file:./localpkg`, an absolute
                   path -- is a package already on this file system, and is installed from there. */
                const local = localSpecTarget(arg, this.cwd ?? '/');
                specs.push(local === undefined ? parseInstallSpec(arg) : { name: '', localPath: local });
            }
        }

        const projectDir = this.cwd ?? '/';
        const packageDir = findPackageRoot(this.fileSystem, projectDir) ?? normalizeAbsolute(projectDir);
        const installer = new NpmInstaller(this.fileSystem, registry, log, (args, cwd, env) => this.runLifecycleScript(args, cwd, env));
        const started = performance.now();
        /* npm runs the root's own scripts on `npm install` with no arguments and not on
           `npm install <pkg>`, which changes a dependency rather than the root: preinstall before
           the tree is placed, then install, postinstall and prepare once it is. */
        const rootScripts = specs.length === 0;
        if (rootScripts) {
            const failed = await this.runRootScripts(packageDir, ROOT_PRE_INSTALL_SCRIPT_EVENTS);
            if (failed !== undefined) return failed;
        }
        const report = specs.length > 0
            ? await installer.addPackages(projectDir, specs, save)
            : await installer.installManifest(projectDir);
        if (rootScripts) {
            const failed = await this.runRootScripts(packageDir, ROOT_POST_INSTALL_SCRIPT_EVENTS);
            if (failed !== undefined) return failed;
        }
        const duration = elapsedDuration(performance.now() - started);
        /* npm's summary lines start on a line of their own, whichever one it is. */
        if (report.added.length === 0) {
            this.emitOutput(`\nup to date in ${duration}\n`);
        } else {
            this.emitOutput(`\nadded ${report.added.length} package${report.added.length === 1 ? '' : 's'} in ${duration}\n`);
        }
        return 0;
    }

    /**
     * `npm run <script>` and the lifecycle commands: each script runs through the shell, in the
     * package directory, with every node_modules/.bin in front of PATH, and the status of the
     * script that fails is the status npm exits with.
     */
    private async runScript(args: string[], event?: string): Promise<number> {
        const { name, ifPresent, extra } = parseScriptArgs(args, event);
        const packageDir = findPackageRoot(this.fileSystem, this.cwd ?? '/') ?? normalizeAbsolute(this.cwd ?? '/');
        const manifest = readManifest(this.fileSystem, packageDir);
        if (manifest === undefined) {
            this.emitError(`npm error code ENOENT\nnpm error enoent Could not read package.json in ${packageDir}\n`);
            return 1;
        }
        const label = scriptLabel(manifest, packageDir);
        const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;

        if (name === undefined) {
            this.emitOutput(scriptList(label, scripts));
            return 0;
        }
        if (typeof scripts[name] !== 'string') {
            if (ifPresent) return 0;
            this.emitError(missingScriptMessage(name, manifest));
            return 1;
        }

        const PATH = scriptPath(this.fileSystem, packageDir, Object.fromEntries(this.env).PATH);
        for (const step of scriptEvents(name, scripts)) {
            const line = scriptCommandLine(scripts, step, name, extra);
            this.emitOutput(scriptHeader(label, step, line));
            const result = await this.spawnChild('sh', ['-c', line], {
                ...Object.fromEntries(this.env),
                PATH,
                npm_package_name: String(manifest.name ?? ''),
                npm_package_version: String(manifest.version ?? ''),
                npm_package_json: joinPaths(packageDir, 'package.json'),
                npm_lifecycle_event: step
            }, packageDir);
            const exitCode = result.exitCode ?? 1;
            /* npm reports a failing script with its status alone: the script's own output already
               reached the terminal, and the ELIFECYCLE block npm 6 wrote is gone from npm 7+. */
            if (exitCode === 0) continue;
            return exitCode;
        }
        return 0;
    }

    /**
     * The root's own lifecycle scripts, as `npm run` runs them: the header npm prints above each one,
     * then the script through the shell in the package directory with the tree's bins in front of
     * PATH. The status of the script that fails is the status npm exits with, and the scripts after
     * it do not run. Nothing is returned when every script that is there succeeded.
     */
    private async runRootScripts(packageDir: string, events: readonly string[]): Promise<number | undefined> {
        const manifest = readManifest(this.fileSystem, packageDir);
        if (manifest === undefined) return undefined;
        const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
        const label = scriptLabel(manifest, packageDir);
        const PATH = scriptPath(this.fileSystem, packageDir, Object.fromEntries(this.env).PATH);
        for (const event of events) {
            const command = scripts[event];
            if (typeof command !== 'string') continue;
            this.emitOutput(scriptHeader(label, event, command));
            const result = await this.spawnChild('sh', ['-c', command], {
                ...Object.fromEntries(this.env),
                PATH,
                npm_package_name: String(manifest.name ?? ''),
                npm_package_version: String(manifest.version ?? ''),
                npm_package_json: joinPaths(packageDir, 'package.json'),
                npm_lifecycle_event: event
            }, packageDir);
            const exitCode = result.exitCode ?? 1;
            if (exitCode !== 0) return exitCode;
        }
        return undefined;
    }

    /** `npm ls`: the installed tree of the package here, as `npm ls` draws it. */
    private listDependencies(args: string[]): number {
        const packageDir = findPackageRoot(this.fileSystem, this.cwd ?? '/') ?? normalizeAbsolute(this.cwd ?? '/');
        this.emitOutput(dependencyTree(this.fileSystem, packageDir, parseListArgs(args)));
        return 0;
    }

    /** A lifecycle script runs as a node child in its package directory; its exit code decides whether the install fails. */
    private async runLifecycleScript(args: string[], cwd: string, env: Record<string, string>): Promise<ScriptRunResult> {
        const result = await this.spawnChild('node', args, { ...Object.fromEntries(this.env), ...env }, cwd);
        return { exitCode: result.exitCode ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    }

    private init(): number {
        const dir = normalizeAbsolute(this.cwd ?? '/');
        const file = joinPaths(dir, 'package.json');
        if (this.fileSystem.statPath(file)?.type === 'file') {
            this.emitError(`npm init: package.json already exists in ${dir}\n`);
            return 1;
        }
        const name = dir.split('/').filter(Boolean).pop() || 'project';
        const manifest = {
            name,
            version: '1.0.0',
            description: '',
            main: 'index.js',
            scripts: { test: 'echo "Error: no test specified" && exit 1' },
            author: '',
            license: 'ISC'
        };
        this.fileSystem.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
        this.emitOutput(`Wrote to ${file}\n`);
        return 0;
    }

    /**
     * `npm exec [<pkg>] [-- <args>]`, and its alias `x`: the npm spelling of npx. The command is the
     * first bare word, or the first word after `--` when every word sits behind it; the words that
     * follow it are its own. `-p`/`--package` names the package the bin comes out of, as npx has it.
     */
    private async runExec(args: string[], registry: NpmRegistry, log: (line: string) => void): Promise<number> {
        const { command, commandArgs, packageArg } = parseExecArgs(args);
        const requested = packageArg ?? command;
        if (requested === undefined) {
            this.emitError('npm error exec: a command or package is required\n');
            return 1;
        }
        const binName = parseInstallSpec(command ?? requested).name.split('/').pop()!;
        return this.runBin(binName, requested, commandArgs, this.cwd ?? '/', registry, log, packageArg !== undefined);
    }

    /**
     * The body `npx` and `npm exec` share: the bin is the tree's own when the package has one, and
     * is fetched into the npx cache and taken from there when it has not; the shim runs, so the
     * program sees the name it was invoked by in argv[1].
     */
    private async runBin(
        binName: string,
        requested: string,
        args: string[],
        cwd: string,
        registry: NpmRegistry,
        log: (line: string) => void,
        explicitPackage: boolean
    ): Promise<number> {
        let shim = explicitPackage ? undefined : findLocalBinShim(this.fileSystem, cwd, binName);

        if (shim === undefined && !explicitPackage) {
            /* The package in the directory itself declares bins, and `npm exec` runs one of them
               before it looks anywhere else: it is this project's command, not a package's. npm
               reaches it the same way, which is why `npm exec -- rootbin` never leaves the machine
               even when no install has linked one into node_modules/.bin. */
            const packageDir = findPackageRoot(this.fileSystem, cwd);
            const own = packageDir === undefined
                ? undefined
                : binFromPackage(this.fileSystem, packageDir, binName, true);
            if (own !== undefined) shim = own;
        }

        if (shim === undefined) {
            const spec = parseInstallSpec(requested);
            /* The package is taken from the tree when the tree already has it, and fetched into the
               npx cache when it does not: only the fetch is an install npm has anything to report. */
            const localDir = explicitPackage ? undefined : findLocalPackageDir(this.fileSystem, cwd, spec.name);
            const packageDir = localDir ?? joinPaths(npxCacheDir(requested), 'node_modules', spec.name);
            if (localDir === undefined && this.fileSystem.statPath(packageDir)?.type !== 'dir') {
                log(`Need to install the following packages:\n${requested}`);
                const installer = new NpmInstaller(this.fileSystem, registry, log, (args, cwd, env) => this.runLifecycleScript(args, cwd, env));
                await installer.addPackages(npxCacheDir(requested), [spec], 'none');
            }
            const file = binFromPackage(this.fileSystem, packageDir, binName);
            if (file === undefined) {
                /* A package that ships no bin of that name leaves npm nothing to run, however the
                   package was found: the tree's own copy is not reinstalled to say so. */
                throw new Error(NPX_EXECUTABLE_MESSAGE);
            }
            const linked = joinPaths(binDirectoryOf(packageDir), binName);
            /* The shim, not the target, runs when the install linked one: the program sees the name
               it was invoked by in argv[1]. */
            shim = this.fileSystem.statPath(linked)?.type === 'file' ? linked : file;
        }

        const result = await this.spawnChild('node', [shim, ...args], Object.fromEntries(this.env), cwd);
        return result.exitCode;
    }

    private async runNpx(registry: NpmRegistry, log: (line: string) => void): Promise<number> {
        const args = [...this.args];
        let packageArg: string | undefined;
        while (args.length > 0 && args[0].startsWith('-')) {
            const flag = args.shift()!;
            if (flag === '-p' || flag === '--package') packageArg = args.shift();
        }
        const command = args.shift();
        const requested = packageArg ?? command;
        if (requested === undefined) throw new Error('npx: a command or package is required');

        // the command names the bin, so a version on it (npx cowsay@1) is stripped: the bin is `cowsay`
        const binName = parseInstallSpec(command ?? requested).name.split('/').pop()!;
        return this.runBin(binName, requested, args, this.cwd ?? '/', registry, log, packageArg !== undefined);
    }
}

/**
 * `npm exec [-p <pkg>] [--] <command> [args...]`: npm's own flags first, then the command, then the
 * words that belong to the command. `--` is optional, so both `npm exec next -- typegen` and
 * `npm exec next typegen` hand `typegen` to `next`.
 */
function parseExecArgs(args: string[]): { command?: string; commandArgs: string[]; packageArg?: string } {
    let packageArg: string | undefined;
    const head: string[] = [];
    const tail: string[] = [];
    let passthrough = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (passthrough) tail.push(arg);
        else if (arg === '--') passthrough = true;
        else if (arg === '-p' || arg === '--package') packageArg = args[++i];
        else if (arg.startsWith('-') && arg !== '-') continue;
        else head.push(arg);
    }
    // `--` before the command (`npm exec -- next typegen`) makes the first word after it the command
    const command = head.length > 0 ? head[0] : tail[0];
    const commandArgs = head.length > 0 ? [...head.slice(1), ...tail] : tail.slice(1);
    return { command, commandArgs, packageArg };
}

/** The nearest node_modules/.bin/<name> shim from `startDir` upward. */
function findLocalBinShim(fileSystem: IFileSystem, startDir: string, name: string): string | undefined {
    let dir = normalizeAbsolute(startDir);
    while (true) {
        const shim = joinPaths(dir, 'node_modules', '.bin', name);
        if (fileSystem.statPath(shim)?.type === 'file') return shim;
        if (dir === '/') return undefined;
        dir = dirnameOf(dir);
    }
}

/** The nearest installed copy of `name` at or above `startDir`, as npm resolves it. */
function findLocalPackageDir(fileSystem: IFileSystem, startDir: string, name: string): string | undefined {
    let dir = normalizeAbsolute(startDir);
    while (true) {
        if (!dir.endsWith('/node_modules')) {
            const candidate = joinPaths(dir, 'node_modules', name);
            if (fileSystem.statPath(candidate)?.type === 'dir') return candidate;
        }
        if (dir === '/') return undefined;
        dir = dirnameOf(dir);
    }
}

/** The `.bin` directory beside a package: the one its owning node_modules holds, scope included. */
function binDirectoryOf(packageDir: string): string {
    const marker = '/node_modules/';
    const absolute = normalizeAbsolute(packageDir);
    const at = absolute.lastIndexOf(marker);
    if (at < 0) return joinPaths(absolute, 'node_modules', '.bin');
    return joinPaths(absolute.slice(0, at + marker.length - 1), '.bin');
}

/** Where npx keeps the copy it fetches for a spec it was asked to run. */
function npxCacheDir(requested: string): string {
    return normalizeAbsolute(`/.npm/_npx/${hashString(requested)}`);
}

/**
 * The bin file of `binName` in the package at `packageDir`. `exact` is what resolving a command
 * against the package in the directory needs: a name the package does not declare is not this
 * package's command, however few bins it has, so `npm exec -- somethingelse` is left to the
 * registry instead of being handed the one bin there is. Without it the single bin of a package
 * answers for any name, which is how `npx cowsay` finds `cowsay` in a package that ships one.
 */
function binFromPackage(fileSystem: IFileSystem, packageDir: string, binName: string, exact = false): string | undefined {
    const file = joinPaths(packageDir, 'package.json');
    if (fileSystem.statPath(file)?.type !== 'file') return undefined;
    const manifest = JSON.parse(fileSystem.readFile(file) ?? '{}');
    const bin = manifest.bin;
    if (typeof bin === 'string') {
        if (exact && String(manifest.name ?? '').split('/').pop() !== binName) return undefined;
        return normalizeAbsolute(joinPaths(packageDir, bin));
    }
    if (bin && typeof bin === 'object') {
        const entries = Object.entries(bin as Record<string, string>);
        const chosen = entries.find(([name]) => name === binName) ?? (exact ? undefined : (entries.length === 1 ? entries[0] : undefined));
        if (chosen) return normalizeAbsolute(joinPaths(packageDir, chosen[1]));
    }
    return undefined;
}

/** Stable short key for a spec, used to name the npx cache directory. */
function hashString(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
