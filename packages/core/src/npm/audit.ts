import semver from 'semver';
import { IFileSystem } from '../filesystem';
import { joinPaths, normalizeAbsolute } from '../process/executors/node/runtime/resolver';
import { Advisory, NpmRegistry } from './registry';
import { findPackageRoot, readManifest } from './scripts';

/**
 * `npm audit`: the advisories the registry has for the versions this project has installed.
 *
 * npm asks the registry's advisory endpoint for the whole tree at once and renders what comes back;
 * this asks the same endpoint with the same body -- one name against the versions of it that are
 * installed -- and reports what it is told. What it cannot do is npm's own audit-fix solving: the
 * `Will install <pkg>@<version>` line npm prints names the package a fix would have to move, which
 * is the root's dependency and not the vulnerable package, and that is a solver this runtime does
 * not carry.
 */

export interface AuditResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** npm's severity order, worst last, which is the one a package's severity is the maximum in. */
const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

/** What npm counts in its summary line, in the order it lists them. */
const COUNTED_SEVERITIES = ['critical', 'high', 'moderate', 'low'];

/** Every installed package under `dir`: one entry per directory that carries a package.json. */
function installedPackages(fileSystem: IFileSystem, packageDir: string): { name: string; version: string; location: string }[] {
    const out: { name: string; version: string; location: string }[] = [];
    const seen = new Set<string>();
    const walk = (nodeModules: string): void => {
        if (fileSystem.statPath(nodeModules)?.type !== 'dir') return;
        for (const name of fileSystem.readdirNames(nodeModules) ?? []) {
            if (name === '.bin') continue;
            const dir = joinPaths(nodeModules, name);
            if (name.startsWith('@')) {
                for (const scoped of fileSystem.readdirNames(dir) ?? []) walkScope(dir, scoped);
                continue;
            }
            record(dir);
            walk(joinPaths(dir, 'node_modules'));
        }
    };
    const walkScope = (scopeDir: string, scoped: string): void => {
        const dir = joinPaths(scopeDir, scoped);
        record(dir);
        walk(joinPaths(dir, 'node_modules'));
    };
    const record = (dir: string): void => {
        if (seen.has(dir)) return;
        seen.add(dir);
        const manifest = readManifest(fileSystem, dir);
        if (manifest === undefined) return;
        const base = packageDir.endsWith('/') ? packageDir : `${packageDir}/`;
        out.push({
            name: String(manifest.name ?? dir.split('/').filter(Boolean).pop() ?? ''),
            version: String(manifest.version ?? ''),
            location: dir.startsWith(base) ? dir.slice(base.length) : dir
        });
    };
    walk(joinPaths(packageDir, 'node_modules'));
    return out;
}

/** The highest of the severities a package's advisories carry, as npm reports one severity per package. */
function worstSeverity(advisories: Advisory[]): string {
    return advisories.reduce((worst, advisory) => {
        const severity = advisory.severity;
        return SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(worst) ? severity : worst;
    }, 'info');
}

/**
 * npm names the range a package is vulnerable across: the union of what its advisories say,
 * simplified against the versions the package has actually published, which is arborist's own
 * `Vuln.simpleRange` -- `<1.20.6 || <1.20.9` over body-parser's versions is `<=1.20.8`.
 */
function vulnerableRange(advisories: Advisory[], versions: string[] | undefined): string {
    const ranges = advisories
        .map((advisory) => advisory.vulnerable_versions)
        .filter((range): range is string => typeof range === 'string' && range !== '');
    const union = [...new Set(ranges)].join(' || ');
    if (versions === undefined || versions.length === 0) return union;
    /* `simplifyRange` is semver's own and takes `includePrerelease`, which the typings this build
       carries do not name; the call is the one arborist makes. */
    const simplify = semver.simplifyRange as unknown as (versions: string[], range: string, options?: unknown) => string;
    try {
        return simplify(versions, union, { loose: true, includePrerelease: true });
    } catch {
        return union;
    }
}

/**
 * `npm audit [--json]` for the package at `cwd`: the advisories the registry has for what is
 * installed, or `found 0 vulnerabilities` when it has none.
 */
export async function runAudit(
    fileSystem: IFileSystem,
    registry: NpmRegistry,
    cwd: string,
    args: string[]
): Promise<AuditResult> {
    const asJson = args.includes('--json');
    const packageDir = findPackageRoot(fileSystem, cwd) ?? normalizeAbsolute(cwd);
    const installed = installedPackages(fileSystem, packageDir);
    if (installed.length === 0) {
        return { stdout: asJson ? '{\n  "vulnerabilities": {}\n}\n' : 'found 0 vulnerabilities\n', stderr: '', exitCode: 0 };
    }
    const query: Record<string, string[]> = {};
    for (const pkg of installed) {
        const versions = query[pkg.name] ?? (query[pkg.name] = []);
        if (!versions.includes(pkg.version)) versions.push(pkg.version);
    }
    let advisories: Record<string, Advisory[]>;
    try {
        advisories = await registry.fetchAdvisories(query);
    } catch (error: any) {
        return { stdout: '', stderr: `npm error audit ${error?.message ?? 'endpoint returned an error'}\n`, exitCode: 1 };
    }
    const affected = installed
        .map((pkg) => ({ pkg, list: advisories[pkg.name] ?? [] }))
        .filter((entry) => entry.list.length > 0);
    if (affected.length === 0) {
        return { stdout: asJson ? '{\n  "vulnerabilities": {}\n}\n' : 'found 0 vulnerabilities\n', stderr: '', exitCode: 0 };
    }
    const severityOf = new Map<string, string>();
    for (const { pkg, list } of affected) severityOf.set(pkg.name, worstSeverity(list));
    if (asJson) {
        const vulnerabilities: Record<string, unknown> = {};
        for (const { pkg, list } of affected) {
            vulnerabilities[pkg.name] = {
                severity: severityOf.get(pkg.name),
                range: vulnerableRange(list, undefined),
                via: list.map((advisory) => ({ title: advisory.title, url: advisory.url })),
                nodes: affected.filter((entry) => entry.pkg.name === pkg.name).map((entry) => entry.pkg.location)
            };
        }
        return { stdout: JSON.stringify({ vulnerabilities }, null, 2) + '\n', stderr: '', exitCode: 1 };
    }
    const blocks: string[] = ['# npm audit report', ''];
    const byName = [...new Map(affected.map((entry) => [entry.pkg.name, entry])).values()]
        .sort((left, right) => left.pkg.name.localeCompare(right.pkg.name));
    for (const { pkg, list } of byName) {
        const severity = severityOf.get(pkg.name) ?? 'info';
        let versions: string[] | undefined;
        try {
            versions = Object.keys((await registry.getPackument(pkg.name)).versions);
        } catch {
            versions = undefined;
        }
        blocks.push(`${pkg.name}  ${vulnerableRange(list, versions)}`);
        /* npm prints the severity of a top-level finding for everything but `low`. */
        if (severity !== 'low') blocks.push(`Severity: ${severity}`);
        for (const advisory of list) blocks.push(`${advisory.title} - ${advisory.url}`);
        const fix = await fixLine(registry, pkg.name, list, readManifest(fileSystem, packageDir));
        if (fix !== undefined) blocks.push(fix);
        for (const node of affected.filter((entry) => entry.pkg.name === pkg.name)) {
            blocks.push(node.pkg.location);
        }
        blocks.push('');
    }
    const counts = COUNTED_SEVERITIES
        .map((severity) => ({ severity, count: [...severityOf.values()].filter((value) => value === severity).length }))
        .filter((entry) => entry.count > 0);
    const total = counts.reduce((sum, entry) => sum + entry.count, 0);
    const summary = total === 1
        ? `${total} ${counts[0].severity} severity vulnerability`
        : `${total} vulnerabilities (${counts.map((entry) => `${entry.count} ${entry.severity}`).join(', ')})`;
    blocks.push(summary, '', 'To address all issues, run:', '  npm audit fix --force');
    return { stdout: blocks.join('\n') + '\n', stderr: '', exitCode: 1 };
}

/**
 * What npm says a fix would take, for the vulnerable package itself: `npm audit fix` when a version
 * inside the range the project asked for is not vulnerable, and `npm audit fix --force` with the
 * version outside it otherwise.
 */
async function fixLine(
    registry: NpmRegistry,
    name: string,
    advisories: Advisory[],
    rootManifest: Record<string, any> | undefined
): Promise<string | undefined> {
    const range = (rootManifest?.dependencies as Record<string, string> | undefined)?.[name];
    try {
        const packument = await registry.getPackument(name);
        const safe = (version: string): boolean =>
            advisories.every((advisory) => !matchesRange(version, advisory.vulnerable_versions));
        const versions = Object.keys(packument.versions).filter(safe);
        if (versions.length === 0) return 'No fix available';
        if (range !== undefined) {
            const inRange = versions.filter((version) => matchesRange(version, range));
            if (inRange.length > 0) return 'fix available via `npm audit fix`';
        }
        const outside = versions.sort(semver.rcompare).pop();
        if (outside === undefined) return undefined;
        return `fix available via \`npm audit fix --force\`\n` +
            `Will install ${name}@${outside}, which is outside the stated dependency range`;
    } catch {
        return undefined;
    }
}

/** Whether `version` is inside `range`, which is npm's own test for an affected version. */
function matchesRange(version: string, range: string): boolean {
    try {
        return semver.satisfies(version, range, { includePrerelease: true });
    } catch {
        return false;
    }
}
