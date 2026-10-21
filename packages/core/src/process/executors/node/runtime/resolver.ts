import { IFileSystem } from '../../../../filesystem';

export type ResolveMode = 'require' | 'import';

/**
 * Why a specifier resolved to nothing. A subpath no "exports" map defines is one failure Node
 * reports as ERR_PACKAGE_PATH_NOT_EXPORTED rather than as a missing module; a specifier that names
 * no file is the other, and `target` says whether the package directory itself was absent -- Node
 * names that one 'Cannot find package' -- or only the file inside it was.
 */
export type ResolveFailure =
    | { kind: 'not-exported'; packageDir: string; subpath: string }
    | { kind: 'missing'; target: 'package' | 'module'; name?: string; file?: string };

export type ResolveResult = { kind: 'file'; file: string } | ResolveFailure;

const FILE_EXTENSIONS = ['.js', '.json', '.cjs', '.mjs'];
const INDEX_FILES = ['index.js', 'index.json', 'index.cjs', 'index.mjs'];

/** A `/` begins a regular expression only where no expression can end just before it. */
const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%~^<>';
const REGEX_KEYWORDS = /(?:^|[\s(])(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;

function regexCanFollow(preceding: string): boolean {
    const prev = preceding.replace(/\s+$/, '');
    if (prev === '') return true;
    if (REGEX_PRECEDERS.includes(prev.slice(-1))) return true;
    return REGEX_KEYWORDS.test(prev);
}

/**
 * The source with comments, string literals, template literals and regular expressions blanked
 * (newlines kept), so text that only *looks* like module syntax does not read as module syntax:
 * prose in a comment, and -- the case that matters -- the `import` lines of a generated ES module
 * carried inside a template literal, which is how next's dist/build/utils.js holds one.
 */
function withoutLiterals(source: string): string {
    const out: string[] = [];
    /** Brace depth outside each `${ }` of a template literal we are inside of. */
    const interpolations: number[] = [];
    let depth = 0;
    let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex' = 'code';
    let preceding = '';
    let i = 0;
    const blank = (ch: string): string => (ch === '\n' ? ch : ' ');
    while (i < source.length) {
        const ch = source[i];
        const next = source[i + 1];
        if (state === 'code') {
            if (ch === '/' && next === '/') { state = 'line'; out.push(' ', ' '); i += 2; continue; }
            if (ch === '/' && next === '*') { state = 'block'; out.push(' ', ' '); i += 2; continue; }
            if (ch === "'" || ch === '"' || ch === '`') {
                state = ch === "'" ? 'single' : ch === '"' ? 'double' : 'template';
                out.push(' ');
                i += 1;
                continue;
            }
            if (ch === '/' && regexCanFollow(preceding)) { state = 'regex'; out.push(' '); i += 1; continue; }
            if (ch === '{') depth += 1;
            else if (ch === '}' && interpolations.length > 0 && depth === 0) {
                depth = interpolations.pop() ?? 0;
                state = 'template';
                out.push(' ');
                i += 1;
                continue;
            } else if (ch === '}') depth = Math.max(0, depth - 1);
            out.push(ch);
            preceding = (preceding + ch).slice(-24);
            i += 1;
            continue;
        }
        if (state === 'line') {
            if (ch === '\n') { state = 'code'; preceding = ''; out.push(ch); }
            else out.push(' ');
            i += 1;
            continue;
        }
        if (state === 'block') {
            if (ch === '*' && next === '/') { state = 'code'; out.push(' ', ' '); i += 2; continue; }
            out.push(blank(ch));
            i += 1;
            continue;
        }
        if (state === 'template') {
            if (ch === '\\') { out.push(' ', next === undefined ? '' : ' '); i += 2; continue; }
            if (ch === '`') { state = 'code'; out.push(' '); i += 1; continue; }
            if (ch === '$' && next === '{') {
                interpolations.push(depth);
                depth = 0;
                state = 'code';
                out.push(' ', ' ');
                i += 2;
                continue;
            }
            out.push(blank(ch));
            i += 1;
            continue;
        }
        // single, double and regex: a backslash escapes the next character; the closer ends it
        if (ch === '\\') { out.push(' ', next === undefined ? '' : ' '); i += 2; continue; }
        const closer = state === 'single' ? "'" : state === 'double' ? '"' : '/';
        if (ch === closer || (state === 'regex' && ch === '\n')) {
            state = 'code';
            out.push(' ');
            i += 1;
            continue;
        }
        out.push(blank(ch));
        i += 1;
    }
    return out.join('');
}

/**
 * Node-style module resolution over the virtual file system. Used by both the
 * CommonJS loader inside the guest (through the host bridge) and the ES module
 * loader of the QuickJS runtime, so both follow the same algorithm.
 */
export class NodeResolver {
    constructor(private fileSystem: IFileSystem) { }

    /* Why the last resolve() that found nothing found nothing, for the caller that has to name the
       reason: a package whose "exports" map defines no such subpath is ERR_PACKAGE_PATH_NOT_EXPORTED
       in Node, not a missing module, and a specifier whose package is absent is 'Cannot find
       package', not 'Cannot find module'. Only resolveDetailed() reads it, and every call is
       synchronous, so a failure never outlives the resolution that set it. */
    private lastFailure: ResolveFailure | undefined;

    resolve(specifier: string, fromDir: string, mode: ResolveMode): string | undefined {
        const spec = specifierToResolve(specifier, mode);
        // a trailing slash names a directory, which an ES module specifier may not import
        if (mode === 'import' && spec.endsWith('/')) return undefined;
        if (spec.startsWith('/')) {
            return this.resolveAsPath(normalizeAbsolute(spec), mode, mode === 'import');
        }
        if (isRelativeSpecifier(spec)) {
            return this.resolveAsPath(normalizeAbsolute(joinPaths(fromDir, spec)), mode, mode === 'import');
        }
        if (spec.startsWith('#')) {
            return this.resolveImportsField(spec, fromDir, mode);
        }
        return this.resolvePackage(spec, fromDir, mode);
    }

    /**
     * resolve() together with the reason it failed. Two failures Node reports under different codes
     * both come back as undefined from resolve(), so the caller that builds the error needs this:
     * a subpath no "exports" map defines, and a bare specifier whose package directory is absent.
     */
    resolveDetailed(specifier: string, fromDir: string, mode: ResolveMode): ResolveResult {
        this.lastFailure = undefined;
        const file = this.resolve(specifier, fromDir, mode);
        if (file !== undefined) return { kind: 'file', file };
        return this.lastFailure ?? { kind: 'missing', target: 'module' };
    }

    /** `#name` specifiers resolve through the "imports" map of the nearest package.json. */
    private resolveImportsField(specifier: string, fromDir: string, mode: ResolveMode): string | undefined {
        let dir = normalizeAbsolute(fromDir);
        while (true) {
            const pkg = this.readPackageJson(dir);
            if (pkg) {
                const target = resolveImportsTarget(pkg.imports, specifier, mode);
                if (target === undefined) return undefined;
                const resolved = normalizeAbsolute(joinPaths(dir, target));
                return this.fileSystem.statPath(resolved)?.type === 'file' ? resolved : this.resolveAsPath(resolved, mode);
            }
            if (dir === '/') return undefined;
            dir = dirnameOf(dir);
        }
    }

    isESM(file: string): boolean {
        if (file.endsWith('.mjs')) return true;
        if (file.endsWith('.cjs') || file.endsWith('.json')) return false;
        if (!file.endsWith('.js')) return false;
        const packageType = this.nearestPackageType(dirnameOf(file));
        if (packageType === 'module') return true;
        if (packageType === 'commonjs') return false;
        const code = withoutLiterals(this.fileSystem.readFile(file) ?? '');
        return /^\s*(?:import\s+[\w{*'"]|export\s+[\w{*])/m.test(code)
            || /^(?:await\s|(?:const|let|var)\s+[^=\n]+=\s*await\s)/m.test(code);
    }

    /**
     * Resolves a path as a file. `exactOnly` is the ESM rule for a relative or absolute specifier:
     * the path names the file itself, so no extension is added, no directory index is read and no
     * "main" is consulted -- the same specifier that Node would fail to find fails here too.
     */
    private resolveAsPath(target: string, mode: ResolveMode, exactOnly = false): string | undefined {
        const direct = this.fileSystem.statPath(target);
        if (direct?.type === 'file') return target;
        if (exactOnly) return undefined;
        for (const ext of FILE_EXTENSIONS) {
            if (this.fileSystem.statPath(target + ext)?.type === 'file') return target + ext;
        }
        if (direct?.type === 'dir') {
            const pkg = this.readPackageJson(target);
            if (typeof pkg?.main === 'string') {
                const fromMain = this.resolveMain(target, pkg.main, mode);
                if (fromMain) return fromMain;
            }
            for (const index of INDEX_FILES) {
                const candidate = joinPaths(target, index);
                if (this.fileSystem.statPath(candidate)?.type === 'file') return candidate;
            }
        }
        return undefined;
    }

    private resolveMain(dir: string, main: string, mode: ResolveMode): string | undefined {
        const target = normalizeAbsolute(joinPaths(dir, main));
        const found = this.resolveAsPath(target, mode);
        if (found) return found;
        return undefined;
    }

    private resolvePackage(specifier: string, fromDir: string, mode: ResolveMode): string | undefined {
        const { name, subpath } = splitPackageSpecifier(specifier);
        let dir = normalizeAbsolute(fromDir);
        while (true) {
            if (!dir.endsWith('/node_modules')) {
                const packageDir = joinPaths(dir, 'node_modules', name);
                if (this.fileSystem.statPath(packageDir)?.type === 'dir') {
                    return this.resolvePackageDirectory(packageDir, subpath, mode);
                }
            }
            if (dir === '/') {
                this.lastFailure = { kind: 'missing', target: 'package', name };
                return undefined;
            }
            dir = dirnameOf(dir);
        }
    }

    private resolvePackageDirectory(packageDir: string, subpath: string, mode: ResolveMode): string | undefined {
        const pkg = this.readPackageJson(packageDir);
        if (pkg && pkg.exports !== undefined) {
            const target = resolveExportsTarget(pkg.exports, subpath, mode);
            if (target === undefined) {
                this.lastFailure = { kind: 'not-exported', packageDir, subpath };
                return undefined;
            }
            const resolved = normalizeAbsolute(joinPaths(packageDir, target));
            if (this.fileSystem.statPath(resolved)?.type === 'file') return resolved;
            /* The exports map names a file that is not there: Node reports the path the map named,
               not the specifier the caller wrote, so the caller can say the same. */
            const found = this.resolveAsPath(resolved, mode);
            if (found === undefined) this.lastFailure = { kind: 'missing', target: 'module', file: resolved };
            return found;
        }
        if (subpath === '.') return this.resolveAsPath(packageDir, mode);
        return this.resolveAsPath(normalizeAbsolute(joinPaths(packageDir, subpath)), mode);
    }

    private readPackageJson(dir: string): Record<string, any> | undefined {
        const file = joinPaths(dir, 'package.json');
        if (this.fileSystem.statPath(file)?.type !== 'file') return undefined;
        try {
            return JSON.parse(this.fileSystem.readFile(file) ?? '');
        } catch {
            return undefined;
        }
    }

    private nearestPackageType(dir: string): string | undefined {
        let current = normalizeAbsolute(dir);
        while (true) {
            const pkg = this.readPackageJson(current);
            if (pkg) return typeof pkg.type === 'string' ? pkg.type : undefined;
            if (current === '/') return undefined;
            current = dirnameOf(current);
        }
    }
}

function isRelativeSpecifier(specifier: string): boolean {
    return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/** The specifier with its URL fragment and query dropped, both of which name no file: `./m.mjs?x=1#f` is `./m.mjs`. */
export function withoutUrlSuffix(specifier: string): string {
    const hash = specifier.indexOf('#');
    const withoutFragment = hash < 0 ? specifier : specifier.slice(0, hash);
    const query = withoutFragment.indexOf('?');
    return query < 0 ? withoutFragment : withoutFragment.slice(0, query);
}

/**
 * The specifier an ES module loader resolves. Node drops a query and a fragment from a relative or
 * absolute specifier before it looks for the file, so './m.mjs?x=1', './m.mjs#frag' and
 * './m.mjs?x=1#frag' all load ./m.mjs, and percent-decodes what is left: './q%3F1.mjs' is the file
 * 'q?1.mjs'. A bare specifier keeps them: 'pkg/sub?x=1' is a subpath no "exports" map defines and
 * 'pkg?x=1' a package that does not exist, which is how Node reads both. require() strips nothing
 * at all, so its specifier names the file with the query still on it.
 */
function specifierToResolve(specifier: string, mode: ResolveMode): string {
    if (mode !== 'import') return specifier;
    const bare = withoutUrlSuffix(specifier);
    if (bare.startsWith('/') || isRelativeSpecifier(bare)) return decodePathOf(bare);
    return specifier;
}

/** The path a URL pathname names. Node's ESM loader decodes it, and a stray `%` it cannot decode is left as it is. */
function decodePathOf(path: string): string {
    if (path.indexOf('%') < 0) return path;
    try {
        return decodeURIComponent(path);
    } catch {
        return path;
    }
}

/**
 * The query and fragment a specifier carries into the identity of the module it names -- '' when it
 * carries none: './m.mjs?x=1#f' is '?x=1#f'. Node keeps both in the module's URL and in its
 * identity, so './m.mjs?x=1' and './m.mjs' are two modules. A bare specifier carries none: its
 * query is part of a subpath, which is why 'pkg/sub?x=1' is a subpath no "exports" map defines.
 */
export function urlSuffixOf(specifier: string): string {
    const bare = withoutUrlSuffix(specifier);
    if (bare === specifier) return '';
    if (!bare.startsWith('/') && !isRelativeSpecifier(bare)) return '';
    return specifier.slice(bare.length);
}

/** Whether the specifier names a file or directory by path rather than by package name. */
export function isPathSpecifier(specifier: string): boolean {
    return specifier.startsWith('/') || isRelativeSpecifier(specifier);
}

export function splitPackageSpecifier(specifier: string): { name: string; subpath: string } {
    const parts = specifier.split('/');
    const nameParts = specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
    const rest = parts.slice(nameParts.length);
    return {
        name: nameParts.join('/'),
        subpath: rest.length ? './' + rest.join('/') : '.'
    };
}

/**
 * Picks the export target for a subpath following package.json "exports":
 * conditions are matched in object order against require/import, node and default.
 */
export function resolveExportsTarget(exportsField: unknown, subpath: string, mode: ResolveMode): string | undefined {
    const conditions = mode === 'require' ? ['require', 'node', 'default'] : ['import', 'node', 'default'];
    const isSubpathMap = isPlainObject(exportsField) && Object.keys(exportsField).some(key => key.startsWith('.'));
    if (!isSubpathMap) {
        return subpath === '.' ? pickCondition(exportsField, conditions) : undefined;
    }
    const map = exportsField as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(map, subpath)) {
        return pickCondition(map[subpath], conditions);
    }
    for (const key of Object.keys(map)) {
        const star = key.indexOf('*');
        if (star < 0) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (subpath.length >= key.length - 1 && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
            const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
            const target = pickCondition(map[key], conditions);
            if (target !== undefined) return target.split('*').join(matched);
        }
    }
    return undefined;
}

/** Resolves a `#name` specifier against package.json "imports" (exact keys and `*` patterns). */
export function resolveImportsTarget(importsField: unknown, specifier: string, mode: ResolveMode): string | undefined {
    if (!isPlainObject(importsField)) return undefined;
    const conditions = mode === 'require' ? ['require', 'node', 'default'] : ['import', 'node', 'default'];
    const map = importsField;
    if (Object.prototype.hasOwnProperty.call(map, specifier)) {
        return pickCondition(map[specifier], conditions);
    }
    for (const key of Object.keys(map)) {
        const star = key.indexOf('*');
        if (star < 0) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (specifier.length >= key.length - 1 && specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
            const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
            const target = pickCondition(map[key], conditions);
            if (target !== undefined) return target.split('*').join(matched);
        }
    }
    return undefined;
}

function pickCondition(target: unknown, conditions: string[]): string | undefined {
    if (typeof target === 'string') return target.startsWith('./') ? target : undefined;
    if (Array.isArray(target)) {
        for (const entry of target) {
            const found = pickCondition(entry, conditions);
            if (found !== undefined) return found;
        }
        return undefined;
    }
    if (isPlainObject(target)) {
        for (const key of Object.keys(target)) {
            if (!conditions.includes(key)) continue;
            const found = pickCondition(target[key], conditions);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function dirnameOf(path: string): string {
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
}

export function joinPaths(...parts: string[]): string {
    return parts.filter(part => part.length > 0).join('/').replace(/\/+/g, '/');
}

export function normalizeAbsolute(path: string): string {
    const segments: string[] = [];
    for (const segment of path.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            segments.pop();
        } else {
            segments.push(segment);
        }
    }
    return '/' + segments.join('/');
}
