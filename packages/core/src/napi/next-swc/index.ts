/**
 * Node-API shim for Next.js's SWC native add-on.
 *
 * The real add-on is a Rust compiler and cannot run in this container. This shim ports the two
 * parts a Next project reaches before application compilation:
 *
 *  1. Binding loading. `installBindings()` from `next typegen` calls `loadBindings()`, which only
 *     reads the binding object's shape. That is why create-next-app can finish its scaffold here.
 *  2. `next.config.ts` transpilation. `transpile-config.js` calls `transform()`/`transformSync()`
 *     with `jsc.parser.syntax: 'typescript'` and `module.type: 'commonjs'`, then runs the returned
 *     `code` through Module._compile. The templates create-next-app writes use a bounded TypeScript
 *     grammar (a type-only import, a typed const, an `export default`), transpiled for real below:
 *     types are erased, type-only imports dropped, value imports become require(), and `export
 *     default` becomes `exports.default` with the `__esModule` marker Next's interopDefault() reads.
 *
 * The lockfile methods are also real: one container is one guest process, so an in-memory table of
 * held paths plus a file written through the virtual filesystem is an honest advisory lock. Next
 * reads that file back for a stale `next dev` server, so the content is written, not discarded.
 *
 * getTargetTriple() reports the platform the container presents to npm: it installs
 * @next/swc-linux-x64-gnu, and webpack uses the triple only as a `swc/target/<triple>` define.
 * No compilation is implied by it.
 *
 * Everything else outside that bounded grammar throws a named ERR_OWC_SWC_NATIVE_UNAVAILABLE. Nothing
 * here reports a success it did not produce: `next dev`/`next build` (Turbopack, JSX/TSX, SWC
 * transforms of application code) fail loudly rather than returning empty or unchanged code.
 */
const UNAVAILABLE = 'ERR_OWC_SWC_NATIVE_UNAVAILABLE';

function unavailable(name: string): never {
    const error = new Error(
        '@next/swc: ' + name + ' needs the native SWC compiler, which cannot run in this container. ' +
        'App scaffolding and type generation work; next dev / next build need the Rust compiler.'
    ) as Error & { code: string };
    error.code = UNAVAILABLE;
    throw error;
}

function refuse(name: string): (...args: unknown[]) => never {
    return function () { return unavailable(name); };
}

const ENTRY_POINTS: readonly string[] = [
    'codeFrameColumns', 'expandNextJsTemplate', 'getModuleNamedExports', 'getTargetTriple',
    'initCustomTraceSubscriber', 'isReactCompilerRequired', 'lightningCssTransform',
    'lightningCssTransformStyleAttribute', 'lightningcssFeatureNamesToMaskNapi',
    'lockfileTryAcquire', 'lockfileTryAcquireSync', 'lockfileUnlock', 'lockfileUnlockSync',
    'mdxCompile', 'mdxCompileSync', 'minify', 'minifySync', 'parse', 'parseSync',
    'teardownTraceSubscriber', 'turbopackCacheVersion', 'warnForEdgeRuntime',
    'startTurbopackTraceServerHandle', 'queryTraceSpans', 'turbopackDatabaseCompact',
    'projectNew', 'rootTaskDispose'
];

/** Reads the options Buffer SWC's wrapper passes as its third argument. */
function configGrammarOf(optionsBuffer: unknown): { syntax: string; moduleType: string } {
    let text = '';
    if (typeof optionsBuffer === 'string') text = optionsBuffer;
    else if (optionsBuffer !== undefined && optionsBuffer !== null) {
        try { text = String((optionsBuffer as { toString(enc?: string): string }).toString('utf8')); }
        catch { text = ''; }
    }
    try {
        const parsed = JSON.parse(text);
        return {
            syntax: (parsed && parsed.jsc && parsed.jsc.parser && parsed.jsc.parser.syntax) || '',
            moduleType: (parsed && parsed.module && parsed.module.type) || ''
        };
    } catch {
        return { syntax: '', moduleType: '' };
    }
}

/** A bounded TypeScript -> CommonJS transpiler for next.config.ts. */
function transpileConfig(source: string, optionsBuffer: unknown): string {
    const grammar = configGrammarOf(optionsBuffer);
    if (grammar.syntax !== 'typescript' || grammar.moduleType !== 'commonjs') {
        return unavailable('transform with options outside the config grammar');
    }

    let code = String(source);

    /* Type-only imports declare nothing at run time. A value import becomes a require(). */
    code = code.replace(/^[ \t]*import[ \t]+type[ \t][^\n]*;[ \t]*$/gm, '');
    code = code.replace(
        /^[ \t]*import[ \t]+([^'\";\n]+?)[ \t]+from[ \t]+(['"][^'"]+['"])[ \t]*;[ \t]*$/gm,
        function (_all: string, bindings: string, moduleName: string) {
            const names = bindings.trim();
            if (/^\{[\s\S]*\}$/.test(names)) return 'const ' + names + ' = require(' + moduleName + ');';
            if (/^\*\s+as\s+[A-Za-z_$][\w$]*$/.test(names)) {
                return 'const ' + names.slice(4).trim() + ' = require(' + moduleName + ');';
            }
            if (/^[A-Za-z_$][\w$]*$/.test(names)) {
                return 'const ' + names + ' = require(' + moduleName + ');';
            }
            return unavailable('transform of import ' + names);
        }
    );
    code = code.replace(/^[ \t]*import[ \t]+(['"][^'"]+['"])[ \t]*;[ \t]*$/gm,
        function (_all: string, moduleName: string) { return 'require(' + moduleName + ');'; });

    /* The typed const of a config: `const nextConfig: NextConfig = { ... }`. */
    code = code.replace(
        /^([ \t]*(?:const|let|var)[ \t]+[A-Za-z_$][\w$]*)[ \t]*:[ \t]*[A-Za-z_$][\w$.<>[\]|&, ]*=[ \t]*/gm,
        '$1 = '
    );
    code = code.replace(/[ \t]+satisfies[ \t]+[A-Za-z_$][\w$.<>[\]|&, ]*/g, '');
    code = code.replace(/[ \t]+as[ \t]+(?:const|[A-Za-z_$][\w$.<>[\]|&, ]*)/g, '');

    let sawDefault = false;
    code = code.replace(/^([ \t]*)export[ \t]+default[ \t]+/gm, function (_all: string, indent: string) {
        sawDefault = true;
        return indent + 'exports.default = ';
    });

    if (/^[ \t]*(?:export|import)[ \t]/m.test(code)) return unavailable('transform of a non-config export/import');
    if (/^[ \t]*(?:interface|enum|namespace|declare|type)[ \t]/m.test(code)) {
        return unavailable('transform of a type declaration');
    }
    if (!sawDefault && code.indexOf('module.exports') < 0) {
        return unavailable('transform of a config with no default export');
    }
    if (code.indexOf('exports.default') >= 0) {
        return '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n' + code;
    }
    return '"use strict";\n' + code;
}

function transformResult(source: unknown, optionsBuffer: unknown): { code: string } {
    if (typeof source !== 'string') return unavailable('transform of a non-string source');
    return { code: transpileConfig(source, optionsBuffer) };
}

/**
 * `lockfile.js` asks for a handle it later hands to lockfileUnlock*, and `readLockfileContent()`
 * reads the path directly for a stale `next dev` server. Holding the path in a table gives that
 * handle a meaning without pretending an OS-level flock exists: the container has one guest
 * process per build and no second process can race it for the same directory.
 */
interface LockHost {
    fs?: {
        write(path: string, bytes: Uint8Array): void;
        unlink(path: string): void;
    };
}

function lockfileBindings(host: LockHost | undefined) {
    const held = new Set<string>();
    function acquire(path: string, content: unknown): { path: string } | null {
        const key = String(path);
        if (held.has(key)) return null;
        held.add(key);
        if (content !== undefined && host && host.fs) {
            const bytes = typeof content === 'string'
                ? new TextEncoder().encode(content)
                : content instanceof Uint8Array ? content : undefined;
            if (bytes) {
                try { host.fs.write(key, bytes); } catch { /* best effort, as on native */ }
            }
        }
        return { path: key };
    }
    function release(lockfile: unknown): void {
        const key = lockfile && typeof (lockfile as { path?: unknown }).path === 'string'
            ? (lockfile as { path: string }).path : String(lockfile);
        held.delete(key);
        if (host && host.fs) {
            try { host.fs.unlink(key); } catch { /* best effort */ }
        }
    }
    return {
        lockfileTryAcquireSync: (path: string, content: unknown) => acquire(path, content),
        lockfileTryAcquire: async (path: string, content: unknown) => acquire(path, content),
        lockfileUnlockSync: (lockfile: unknown) => { release(lockfile); },
        lockfileUnlock: async (lockfile: unknown) => { release(lockfile); }
    };
}

export function createAddon(host?: LockHost): object {
    const addon: Record<string, unknown> = {};
    for (const name of ENTRY_POINTS) addon[name] = refuse(name);
    Object.assign(addon, lockfileBindings(host));
    addon.getTargetTriple = function () { return 'x86_64-unknown-linux-gnu'; };
    addon.turbopackCacheVersion = function () { return '0.0.0-owc'; };
    /* SWC's binding takes (source, isModule, optionsBuffer): next/dist/build/swc/index.js calls
       bindings.transform(src, isModule, toBuffer(options)) and awaits { code }. */
    addon.transform = async function (source: unknown, _isModule: unknown, optionsBuffer: unknown) {
        return transformResult(source, optionsBuffer);
    };
    addon.transformSync = function (source: unknown, _isModule: unknown, optionsBuffer: unknown) {
        return transformResult(source, optionsBuffer);
    };
    /* The trace guard calls these on some paths; they only arm/disarm a subscriber. */
    addon.initCustomTraceSubscriber = function () { return undefined; };
    addon.teardownTraceSubscriber = function () { return undefined; };
    addon.reactCompiler = {
        isReactCompilerRequired: refuse('reactCompiler.isReactCompilerRequired')
    };
    return addon;
}
