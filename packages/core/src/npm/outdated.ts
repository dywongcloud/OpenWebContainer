import { IFileSystem } from '../filesystem';
import { dirnameOf, joinPaths, normalizeAbsolute } from '../process/executors/node/runtime/resolver';
import { NpmRegistry, selectVersion } from './registry';
import { findPackageRoot, readManifest } from './scripts';

/**
 * `npm outdated`: for each package the project declares, the version it has, the highest that
 * satisfies the range it asked for, and the one the registry is calling `latest`. A package is a row
 * when it is not installed at all, or when either of the two versions behind it is not the one it
 * has -- so a package pinned inside its range but behind the registry is outdated too, which is what
 * makes the command worth running.
 */

export interface OutdatedResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** One row: what npm prints about a package that is behind. */
interface Row {
    name: string;
    current: string;
    wanted: string;
    latest: string;
    location: string;
    dependedBy: string;
}

/** The copy of `name` Node would resolve from `fromDir`, which is the one npm reports. */
function installedCopy(fileSystem: IFileSystem, fromDir: string, name: string): string | undefined {
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

/** The path npm prints in `Location`: where the package sits, written from the project down. */
function locationOf(packageDir: string, dir: string): string {
    const base = packageDir.endsWith('/') ? packageDir : `${packageDir}/`;
    return dir.startsWith(base) ? dir.slice(base.length) : dir;
}

/** npm's table: two spaces between columns, each padded to its widest cell. */
function drawTable(headers: string[], rows: string[][], align: string[]): string {
    const widths = headers.map((header, column) =>
        Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)));
    const cell = (text: string, column: number): string => {
        const width = widths[column];
        if (align[column] === 'r') return text.padStart(width);
        return text.padEnd(width);
    };
    const line = (cells: string[]): string =>
        cells.map((text, column) => cell(text, column)).join('  ').replace(/\s+$/, '');
    return [line(headers), ...rows.map(line)].join('\n') + '\n';
}

/**
 * `npm outdated` for the package at `cwd`. Every declared dependency is asked for at the registry,
 * so a project with no network gets an error rather than a table.
 */
export async function runOutdated(
    fileSystem: IFileSystem,
    registry: NpmRegistry,
    cwd: string,
    args: string[]
): Promise<OutdatedResult> {
    const asJson = args.includes('--json');
    const packageDir = findPackageRoot(fileSystem, cwd) ?? normalizeAbsolute(cwd);
    const manifest = readManifest(fileSystem, packageDir);
    if (manifest === undefined) {
        return {
            stdout: '',
            stderr: `npm error code ENOENT\nnpm error enoent Could not read package.json in ${packageDir}\n`,
            exitCode: 1
        };
    }
    /* dependencies, devDependencies and optionalDependencies: the fields whose ranges npm
       resolves, and so the ones a version can be behind. peerDependencies are not installed. */
    const DECLARING_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
    const declared = new Map<string, string>();
    for (const field of DECLARING_FIELDS) {
        const source = manifest[field];
        if (source === null || typeof source !== 'object') continue;
        for (const [name, range] of Object.entries(source as Record<string, unknown>)) {
            if (typeof range === 'string') declared.set(name, range);
        }
    }
    const dependedBy = String(manifest.name ?? packageDir.split('/').filter(Boolean).pop() ?? 'project');
    const rows: Row[] = [];
    for (const [name, range] of [...declared.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const dir = installedCopy(fileSystem, packageDir, name);
        const installed = dir === undefined ? undefined : readManifest(fileSystem, dir);
        const current = installed === undefined ? '' : String(installed.version ?? '');
        let wanted = current;
        let latest = current;
        try {
            const packument = await registry.getPackument(name);
            wanted = selectVersion(packument, range).version;
            latest = selectVersion(packument, 'latest').version;
        } catch {
            /* A package the registry has nothing for is one npm cannot say more about: it keeps the
               version it has and is not reported as behind on that account. */
        }
        if (current !== '' && current === wanted && wanted === latest) continue;
        rows.push({
            name,
            current: current === '' ? 'MISSING' : current,
            wanted,
            latest,
            location: dir === undefined ? '-' : locationOf(packageDir, dir),
            dependedBy
        });
    }
    if (rows.length === 0) {
        return { stdout: asJson ? '{}\n' : '', stderr: '', exitCode: 0 };
    }
    if (asJson) {
        const out: Record<string, unknown> = {};
        for (const row of rows) {
            out[row.name] = {
                current: row.current === 'MISSING' ? null : row.current,
                wanted: row.wanted,
                latest: row.latest,
                dependent: row.dependedBy,
                location: row.location
            };
        }
        return { stdout: JSON.stringify(out, null, 2) + '\n', stderr: '', exitCode: 1 };
    }
    const table = drawTable(
        ['Package', 'Current', 'Wanted', 'Latest', 'Location', 'Depended by'],
        rows.map((row) => [row.name, row.current, row.wanted, row.latest, row.location, row.dependedBy]),
        ['l', 'r', 'r', 'r', 'l', 'l']
    );
    return { stdout: table, stderr: '', exitCode: 1 };
}
