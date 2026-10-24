import { gzipSync } from 'fflate';
import { IFileSystem } from '../filesystem';
import { dirnameOf, joinPaths, normalizeAbsolute } from '../process/executors/node/runtime/resolver';
import { bytesToBase64, bytesToHex } from '../utils/bytes';
import { findPackageRoot, readManifest } from './scripts';

/**
 * `npm pack` and the packing half of `npm publish`: the files a package publishes, gathered the way
 * npm-packlist gathers them, written into a gzipped ustar tarball under the `package/` prefix npm
 * writes, and reported with the `npm notice` block npm prints.
 *
 * The tarball is a real one -- the same bytes the registry would be given -- so `npm pack` leaves a
 * file another command can read, and `npm publish --dry-run` can say what it would send without
 * sending it.
 */

export interface PackResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** One file a tarball carries: its path inside the package, its bytes, and whether it is a bin. */
interface PackEntry {
    path: string;
    bytes: Uint8Array;
    bin: boolean;
}

/** npm writes every entry with this mtime, "for the benefit of zip", which a zero date confounds. */
const TARBALL_MTIME = Math.floor(new Date('1985-10-26T08:15:00.000Z').getTime() / 1000);

/** The prefix every path in a published tarball carries: npm's own, and pacote's own default. */
const TARBALL_PREFIX = 'package/';

const collator: (left: string, right: string) => number = (() => {
    try {
        return new Intl.Collator('en', { numeric: true }).compare;
    } catch {
        return (left, right) => (left < right ? -1 : left > right ? 1 : 0);
    }
})();

/** npm's `formatBytes`: `198 B` with a space before the unit, `198B` without, then one decimal. */
export function formatBytes(bytes: number, space = true): string {
    const spacer = space ? ' ' : '';
    if (bytes < 1000) return `${bytes}${spacer}B`;
    if (bytes < 999950) return `${(bytes / 1000).toFixed(1)}${spacer}kB`;
    if (bytes < 999950000) return `${(bytes / 1000000).toFixed(1)}${spacer}MB`;
    return `${(bytes / 1000000000).toFixed(1)}${spacer}GB`;
}

/** npm orders a tarball's contents with the paths beginning with a capital letter first. */
function comparePackPaths(left: string, right: string): number {
    const upper = (value: string): boolean => {
        const first = value.charAt(0);
        return first === first.toUpperCase() && first !== first.toLowerCase();
    };
    const leftUpper = upper(left);
    const rightUpper = upper(right);
    if (leftUpper !== rightUpper) return leftUpper ? -1 : 1;
    return collator(left, right);
}

/** The paths npm never publishes: an npmrc, the tree, the lockfiles and a version control directory. */
const ALWAYS_EXCLUDED = new Set([
    '.npmrc', 'node_modules', '.git', 'package-lock.json', 'yarn.lock',
    'pnpm-lock.yaml', 'bun.lockb', '.DS_Store'
]);

/** Whether a name is one npm leaves out of every tarball, whatever else the package says. */
function isExcludedName(name: string): boolean {
    return ALWAYS_EXCLUDED.has(name) || name.endsWith('.orig');
}

/** The files a package always publishes beside the ones `files` names, as npm-packlist has them. */
function alwaysIncluded(manifest: Record<string, any>): Set<string> {
    const out = new Set<string>(['package.json']);
    const add = (value: unknown): void => {
        if (typeof value === 'string' && value !== '') out.add(value.replace(/^\.\//, ''));
    };
    add(manifest.main);
    add(manifest.browser);
    const bin = manifest.bin;
    if (typeof bin === 'string') add(bin);
    else if (bin && typeof bin === 'object') for (const value of Object.values(bin)) add(value);
    return out;
}

/** The files the `files` field names: a directory carries everything under it. */
function filesField(manifest: Record<string, any>): string[] {
    const files = manifest.files;
    if (!Array.isArray(files)) return [];
    return files.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.replace(/^\.\//, ''));
}

/** Every file under `dir`, as paths relative to `packageDir`; a directory is walked, not listed. */
function walk(fileSystem: IFileSystem, packageDir: string, dir: string): string[] {
    const out: string[] = [];
    const names = fileSystem.readdirNames(dir);
    if (names === undefined) return out;
    for (const name of names) {
        const path = joinPaths(dir, name);
        const stat = fileSystem.statPath(path);
        if (stat === undefined) continue;
        if (stat.type === 'dir') {
            /* `node_modules` is a directory npm never publishes at any depth but a bundled
               dependency's own, which this runtime does not install. */
            if (name === 'node_modules') continue;
            out.push(...walk(fileSystem, packageDir, path));
            continue;
        }
        out.push(relativeTo(packageDir, path));
    }
    return out;
}

/** The path of `file` written relative to `dir`, the way npm names a file in a tarball. */
function relativeTo(dir: string, file: string): string {
    const base = dir.endsWith('/') ? dir : `${dir}/`;
    return file.startsWith(base) ? file.slice(base.length) : file;
}

/**
 * The files a package publishes: every file under it, less the ones npm always leaves out, or only
 * the ones its `files` field names when it has one, with the files npm publishes whatever it says
 * (the manifest, a readme, a licence, `main` and each bin) put back.
 */
export function packFileList(fileSystem: IFileSystem, packageDir: string, manifest: Record<string, any>): string[] {
    const named = filesField(manifest);
    const forced = alwaysIncluded(manifest);
    const selected = new Set<string>();
    if (named.length === 0) {
        for (const path of walk(fileSystem, packageDir, packageDir)) {
            if (path.split('/').some(isExcludedName)) continue;
            selected.add(path);
        }
    } else {
        for (const entry of named) {
            const path = joinPaths(packageDir, entry);
            const stat = fileSystem.statPath(path);
            if (stat === undefined) continue;
            if (stat.type === 'dir') {
                for (const inner of walk(fileSystem, packageDir, path)) {
                    if (inner.split('/').some(isExcludedName)) continue;
                    selected.add(inner);
                }
                continue;
            }
            selected.add(relativeTo(packageDir, path));
        }
    }
    /* A readme and a licence are published whatever `files` says, which is npm-packlist's own rule. */
    for (const path of walk(fileSystem, packageDir, packageDir)) {
        const name = path.split('/').pop() ?? '';
        if (/^(readme|licence|license|copying)/i.test(name)) selected.add(path);
    }
    for (const entry of forced) {
        const path = joinPaths(packageDir, entry);
        if (fileSystem.statPath(path)?.type === 'file') selected.add(relativeTo(packageDir, path));
    }
    return [...selected].sort(comparePackPaths);
}

/** The bins a package declares, as paths inside the package: npm makes every one executable. */
function binPaths(manifest: Record<string, any>): Set<string> {
    const out = new Set<string>();
    const bin = manifest.bin;
    if (typeof bin === 'string') out.add(bin.replace(/^\.\//, ''));
    else if (bin && typeof bin === 'object') {
        for (const value of Object.values(bin as Record<string, unknown>)) {
            if (typeof value === 'string') out.add(value.replace(/^\.\//, ''));
        }
    }
    return out;
}

/** A ustar header block: name, mode, the fixed mtime, the size, and the checksum npm checks. */
function tarHeader(name: string, size: number, mode: number): Uint8Array {
    const header = new Uint8Array(512);
    const write = (text: string, start: number, length: number): void => {
        for (let i = 0; i < text.length && i < length; i++) header[start + i] = text.charCodeAt(i);
    };
    const octal = (value: number, length: number): string => value.toString(8).padStart(length - 1, '0') + '\0';
    const full = `${TARBALL_PREFIX}${name}`;
    /* The prefix field carries the part of a path ustar's 100-byte name cannot, as npm's own tar
       writer splits it: `package/` and the rest when the whole does not fit. */
    const prefix = full.length > 100 ? dirnameOf(full) : '';
    const base = prefix === '' ? full : full.slice(prefix.length + 1);
    write(base, 0, 100);
    write(octal(mode, 8), 100, 8);
    write(octal(0, 8), 108, 8);
    write(octal(0, 8), 116, 8);
    write(octal(size, 12), 124, 12);
    write(octal(TARBALL_MTIME, 12), 136, 12);
    write('        ', 148, 8);
    write('0', 156, 1);
    write('ustar\0', 257, 6);
    write('00', 263, 2);
    if (prefix !== '') write(prefix, 345, 155);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    write(octal(checksum, 8), 148, 8);
    return header;
}

/** The tarball: one header and one padded block of bytes per file, then ustar's two empty blocks. */
function buildTar(entries: PackEntry[]): Uint8Array {
    const blocks: Uint8Array[] = [];
    for (const entry of entries) {
        blocks.push(tarHeader(entry.path, entry.bytes.length, entry.bin ? 0o755 : 0o644));
        const padded = new Uint8Array(Math.ceil(entry.bytes.length / 512) * 512);
        padded.set(entry.bytes);
        blocks.push(padded);
    }
    blocks.push(new Uint8Array(1024));
    const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
    let at = 0;
    for (const block of blocks) {
        out.set(block, at);
        at += block.length;
    }
    return out;
}

/** sha1 hex and `sha512-<base64>` of the tarball: the two npm prints and the registry verifies. */
async function digestPair(tarball: Uint8Array): Promise<{ shasum: string; integrity: string }> {
    const [sha1, sha512] = await Promise.all([
        crypto.subtle.digest('SHA-1', tarball),
        crypto.subtle.digest('SHA-512', tarball)
    ]);
    return {
        shasum: bytesToHex(new Uint8Array(sha1)),
        integrity: `sha512-${bytesToBase64(new Uint8Array(sha512))}`
    };
}

/** npm prints the middle of the integrity out, which is 88 base64 characters long. */
function shortenedIntegrity(integrity: string): string {
    return `${integrity.slice(0, 20)}[...]${integrity.slice(80)}`;
}

/** The `npm notice` block npm prints for a tarball: its contents, then its details. */
function tarballNotice(
    manifest: Record<string, any>,
    filename: string,
    entries: PackEntry[],
    tarball: Uint8Array,
    shasum: string,
    integrity: string
): string {
    const unpacked = entries.reduce((total, entry) => total + entry.bytes.length, 0);
    const lines = [
        '',
        `📦  ${String(manifest.name ?? '')}@${String(manifest.version ?? '')}`,
        'Tarball Contents'
    ];
    for (const entry of entries) lines.push(`${formatBytes(entry.bytes.length, false)} ${entry.path}`);
    lines.push(
        'Tarball Details',
        `name: ${String(manifest.name ?? '')}`,
        `version: ${String(manifest.version ?? '')}`,
        `filename: ${filename}`,
        `package size: ${formatBytes(tarball.length)}`,
        `unpacked size: ${formatBytes(unpacked)}`,
        `shasum: ${shasum}`,
        `integrity: ${shortenedIntegrity(integrity)}`,
        `total files: ${entries.length}`,
        ''
    );
    return lines.map((line) => `npm notice ${line}`.replace(/\s+$/, '')).join('\n') + '\n';
}

/** `@scope/name@1.0.0` becomes `scope-name-1.0.0.tgz`: npm's own rule for a tarball's name. */
export function tarballFilename(manifest: Record<string, any>): string {
    const name = String(manifest.name ?? 'package').replace('@', '').replace('/', '-');
    return `${name}-${String(manifest.version ?? '0.0.0')}.tgz`;
}

export interface PackOutcome {
    /** The tarball, and what npm says about it, before anything is done with either. */
    entries: { path: string; size: number }[];
    tarball: Uint8Array;
    filename: string;
    notice: string;
}

/** Packs the package at `packageDir`: the file list, the tarball and the notice block. */
export async function packPackage(fileSystem: IFileSystem, packageDir: string): Promise<PackOutcome | undefined> {
    const manifest = readManifest(fileSystem, packageDir);
    if (manifest === undefined) return undefined;
    const paths = packFileList(fileSystem, packageDir, manifest);
    const bins = binPaths(manifest);
    const entries: PackEntry[] = [];
    for (const path of paths) {
        const bytes = fileSystem.readBytes(joinPaths(packageDir, path));
        if (bytes === undefined) continue;
        entries.push({ path, bytes, bin: bins.has(path) });
    }
    const tarball = gzipSync(buildTar(entries), { level: 9, mtime: 0 });
    const { shasum, integrity } = await digestPair(tarball);
    const filename = tarballFilename(manifest);
    return {
        entries: entries.map((entry) => ({ path: entry.path, size: entry.bytes.length })),
        tarball,
        filename,
        notice: tarballNotice(manifest, filename, entries, tarball, shasum, integrity)
    };
}

/**
 * `npm pack [--dry-run]`: the tarball of the package here, written to the directory npm writes it
 * in and named on stdout alone. `--dry-run` says what would be written and writes nothing.
 */
export async function runPack(fileSystem: IFileSystem, cwd: string, args: string[]): Promise<PackResult> {
    const dryRun = args.includes('--dry-run');
    const packageDir = findPackageRoot(fileSystem, cwd);
    if (packageDir === undefined) {
        return {
            stdout: '',
            stderr: `npm error code ENOENT\nnpm error enoent Could not read package.json in ${normalizeAbsolute(cwd)}\n`,
            exitCode: 1
        };
    }
    const packed = await packPackage(fileSystem, packageDir);
    if (packed === undefined) {
        return {
            stdout: '',
            stderr: `npm error code ENOENT\nnpm error enoent Could not read package.json in ${packageDir}\n`,
            exitCode: 1
        };
    }
    if (!dryRun) fileSystem.writeBytes(joinPaths(normalizeAbsolute(cwd), packed.filename), packed.tarball);
    return { stdout: `${packed.filename}\n`, stderr: packed.notice, exitCode: 0 };
}

/**
 * `npm publish [--dry-run]`: the same tarball `npm pack` would write, announced the way npm
 * announces it. Only a dry run is answered -- publishing itself is a write to a registry this
 * runtime has no credentials for, and npm refuses one the same way.
 */
export async function runPublish(
    fileSystem: IFileSystem,
    cwd: string,
    args: string[],
    registry: string
): Promise<PackResult> {
    const dryRun = args.includes('--dry-run');
    if (!dryRun) {
        return {
            stdout: '',
            stderr: 'npm error code ENEEDAUTH\n' +
                'npm error need auth This command requires you to be logged in to ' + registry + '\n',
            exitCode: 1
        };
    }
    const packageDir = findPackageRoot(fileSystem, cwd);
    if (packageDir === undefined) {
        return {
            stdout: '',
            stderr: `npm error code ENOENT\nnpm error enoent Could not read package.json in ${normalizeAbsolute(cwd)}\n`,
            exitCode: 1
        };
    }
    const packed = await packPackage(fileSystem, packageDir);
    if (packed === undefined) {
        return {
            stdout: '',
            stderr: `npm error code ENOENT\nnpm error enoent Could not read package.json in ${packageDir}\n`,
            exitCode: 1
        };
    }
    const manifest = readManifest(fileSystem, packageDir) ?? {};
    const id = `${String(manifest.name ?? '')}@${String(manifest.version ?? '')}`;
    const stderr = packed.notice +
        `npm warn This command requires you to be logged in to ${registry} (dry-run)\n` +
        `npm notice Publishing to ${registry} with tag latest and default access (dry-run)\n`;
    return { stdout: `+ ${id}\n`, stderr, exitCode: 0 };
}
