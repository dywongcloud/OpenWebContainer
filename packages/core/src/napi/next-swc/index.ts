/**
 * Node-API shim for Next.js's SWC native add-on.
 *
 * The real add-on is a Rust compiler and cannot run in this container. This shim ports the parts a
 * Next project reaches before application compilation and compiles application TypeScript/JSX with
 * Next's own bundled, pure-JavaScript Babel compiler:
 *
 *  1. Binding loading. `installBindings()` from `next typegen` calls `loadBindings()`, which only
 *     reads the binding object's shape. That is why create-next-app can finish its scaffold here.
 *  2. `next.config.ts` transpilation. `transpile-config.js` calls `transform()`/`transformSync()`
 *     with `jsc.parser.syntax: 'typescript'` and `module.type: 'commonjs'`, then runs the returned
 *     `code` through Module._compile. The templates create-next-app writes use a bounded TypeScript
 *     grammar (a type-only import, a typed const, an `export default`), transpiled for real below.
 *  3. Application transforms. The guest cannot import from a neutral-platform IIFE, so NAPI_HOST
 *     exposes a Babel capability that loads `next/dist/compiled/babel/bundle.js` through the guest
 *     loader. SWC's option buffer is mapped to Babel's `next/babel` preset here; the output code is
 *     Babel's own TypeScript/JSX transform, not an unchanged pass-through.
 *
 * The lockfile methods are also real: one container is one guest process, so an in-memory table of
 * held paths plus a file written through the virtual filesystem is an honest advisory lock. Next
 * reads that file back for a stale `next dev` server, so the content is written, not discarded.
 *
 * getTargetTriple() reports the platform the container presents to npm: it installs
 * @next/swc-linux-x64-gnu, and webpack uses the triple only as a `swc/target/<triple>` define.
 * No compilation is implied by it.
 *
 * Minification is optional: `minify`/`minifySync` are a no-op minifier that returns SWC's own
 * input as { code }. `parse`/`parseSync` remain named refusals; Next's parse-module.js catches a
 * parse failure and answers null. Everything else outside these implemented paths throws a named
 * ERR_OWC_SWC_NATIVE_UNAVAILABLE rather than reporting a success it did not produce.
 */
const UNAVAILABLE = 'ERR_OWC_SWC_NATIVE_UNAVAILABLE';

function unavailable(name: string): never {
    const error = new Error(
        '@next/swc: ' + name + ' needs the native SWC compiler, which cannot run in this container. ' +
        'TypeScript/JSX application transforms use Next\'s bundled Babel compiler; native-only APIs fail loudly.'
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

interface SwcOptions {
    filename?: string;
    sourceFileName?: string;
    sourceMaps?: boolean | string;
    inlineSourcesContent?: boolean;
    inputSourceMap?: unknown;
    isModule?: boolean;
    isServerCompiler?: boolean;
    isDevelopment?: boolean;
    tsx?: boolean;
    jsx?: boolean;
    jsc?: {
        parser?: { syntax?: string; tsx?: boolean; jsx?: boolean };
        transform?: {
            react?: {
                runtime?: string;
                development?: boolean;
                importSource?: string;
                refresh?: boolean;
            };
        };
    };
    module?: { type?: string };
    /** SWC's `env.targets` carries Next's `supportedBrowsers` list for client builds. */
    env?: { targets?: string[] };
    [key: string]: unknown;
}

interface BabelTransformOptions {
    filename: string;
    presets: unknown[];
    configFile: false;
    babelrc: false;
    sourceType: 'module' | 'script' | 'unambiguous';
    sourceMaps: boolean | 'inline';
    sourceFileName?: string;
    inputSourceMap?: unknown;
    caller?: Record<string, unknown>;
}

interface BabelResult {
    code: string;
    map?: string;
}

interface BabelHost {
    transform(source: string, options: BabelTransformOptions): BabelResult;
    exports(path: string): string[];
    /** ESM export names of an in-memory module, including 'default' and '*'. */
    exportsOfSource?(source: string, filename: string): string[];
}

interface AddonHost extends LockHost {
    babel?: BabelHost;
}

/** Reads the options Buffer SWC's wrapper passes as its third argument. */
function optionsOf(optionsBuffer: unknown): SwcOptions {
    let text = '';
    if (typeof optionsBuffer === 'string') text = optionsBuffer;
    else if (optionsBuffer !== undefined && optionsBuffer !== null) {
        try { text = String((optionsBuffer as { toString(enc?: string): string }).toString('utf8')); }
        catch { text = ''; }
    }
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed as SwcOptions : {};
    } catch {
        return {};
    }
}

/**
 * SWC's wrapper passes some module sources as a Buffer/Uint8Array rather than a string. Decode
 * those bytes as UTF-8 with the container's own TextDecoder; no Node `require` is available in this
 * neutral-platform IIFE. Anything else is not a source and stays refused.
 */
function utf8SourceOf(source: unknown): string | undefined {
    if (typeof source === 'string') return source;
    if (source !== null && typeof source === 'object' && ArrayBuffer.isView(source)) {
        const view = source as ArrayBufferView;
        const bytes = new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
        return new TextDecoder().decode(bytes);
    }
    return undefined;
}

function configGrammarOf(optionsBuffer: unknown): { syntax: string; moduleType: string } {
    const parsed = optionsOf(optionsBuffer);
    const jsc = parsed.jsc || {};
    const parser = jsc.parser || {};
    const module = parsed.module || {};
    return {
        syntax: parser.syntax || '',
        moduleType: module.type || ''
    };
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

/** Maps the subset of SWC loader options the webpack build reads to Babel's next/babel preset. */
function babelOptionsOf(options: SwcOptions, isModule: unknown): BabelTransformOptions {
    const jsc = options.jsc || {};
    const parser = jsc.parser || {};
    const react = (jsc.transform && jsc.transform.react) || {};
    const syntax = parser.syntax || 'ecmascript';
    const tsx = parser.tsx === true || options.tsx === true;
    const jsx = parser.jsx === true || options.jsx === true || tsx;
    const moduleType = (options.module && options.module.type) || '';
    const commonjs = moduleType === 'commonjs';
    const runtime = react.runtime === 'classic' ? 'classic' : 'automatic';
    const development = react.development === true || options.isDevelopment === true;
    const importSource = react.importSource || 'react';
    const sourceFileName = typeof options.sourceFileName === 'string' && options.sourceFileName !== ''
        ? options.sourceFileName : undefined;
    const filename = typeof options.filename === 'string' && options.filename !== ''
        ? options.filename
        : sourceFileName || (tsx ? '/app/source.tsx' : syntax === 'typescript' ? '/app/source.ts'
            : jsx ? '/app/source.jsx' : '/app/source.js');
    const presetOptions: Record<string, unknown> = {
        /* `next/dist/build/babel/preset.js:132-153` recognizes only these two caller names. With
           any other name `@babel/plugin-transform-runtime` emits bare `@babel/runtime/*` imports
           that a create-next-app install has no package or webpack alias for. */
        'preset-env': {
            modules: commonjs ? 'commonjs' : false,
            /* SWC's `env.targets` (supportedBrowsers) must be forwarded, or Babel downlevels
               towards its own defaults and pulls in helpers the app cannot resolve. */
            ...(options.env && Array.isArray(options.env.targets) && options.env.targets.length > 0
                ? { targets: options.env.targets } : {})
        },
        'preset-react': { runtime, development, importSource },
        'preset-typescript': syntax === 'typescript'
            ? { allExtensions: true, isTSX: tsx, allowNamespaces: true }
            : { allowNamespaces: true }
    };
    const babelOptions: BabelTransformOptions = {
        filename,
        presets: [['next/babel', presetOptions]],
        configFile: false,
        babelrc: false,
        sourceType: isModule === true || options.isModule === true ? 'module' : 'unambiguous',
        sourceMaps: options.sourceMaps === 'inline' ? 'inline' : options.sourceMaps === true,
        sourceFileName: sourceFileName || filename,
        caller: {
            name: 'next-babel-turbo-loader',
            supportsStaticESM: !commonjs,
            isServer: options.isServerCompiler === true,
            isDev: development
        }
    };
    if (typeof options.inputSourceMap === 'string') {
        try { babelOptions.inputSourceMap = JSON.parse(options.inputSourceMap); }
        catch { /* an unreadable input map does not change the transform */ }
    } else if (options.inputSourceMap !== null && typeof options.inputSourceMap === 'object') {
        babelOptions.inputSourceMap = options.inputSourceMap;
    }
    return babelOptions;
}

/**
 * Native SWC marks a `'use client'` module compiled for `serverComponents.isReactServerLayer`
 * with a `__next_internal_client_entry_do_not_use__` block comment carrying its export refs.
 * next-flight-loader reads it via getRSCModuleInformation(source, true) and replaces the module with
 * a client-reference proxy. Without the label the loader leaves the real body in the RSC graph,
 * where `react` resolves to react.react-server.js (no React.Component) and error-boundary.js throws
 * `TypeError: parent class must be constructor`. Babel does not emit the label, so the shim emits it
 * here, on the transform output the loader sees.
 *
 * Only unambiguous shapes are labelled. An ESM boundary whose refs cannot be forwarded safely
 * (`export *`, string-named exports, a parse failure, or no refs on a javascript/esm module) emits
 * NO label, which is exactly the published baseline behaviour: next-flight-loader then keeps the
 * original module body rather than risking its `export {}` branch, which drops every export when
 * webpack marks such a module `javascript/esm`. CJS client boundaries (Next's own compiled
 * `'use client'` modules) get the empty-refs `cjs` label, which the loader turns into
 * `module.exports = createProxy(resourceKey)`. That proxy answers any named import.
 */
const USE_CLIENT_DIRECTIVE = /^(['"])use client\1[ \t]*;?[ \t]*$/;
const USE_STRICT_DIRECTIVE = /^(['"])use strict\1[ \t]*;?[ \t]*$/;
/** A plain-identifier ref, usable in next-flight-loader's `export const <ref> = ...` form. */
const CLIENT_REF_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** ESM syntax anywhere in the source. When present, an ambiguous label could make the loader emit
    `export {}` for a javascript/esm module. Only CJS-shaped sources get the empty-refs `cjs` label.
    Bounded to the same 4096-char prefix as the directive scan; a later ESM statement cannot change
    how webpack classifies the module type, but a leading `import`/`export` can. Check the whole
    source: `import` at any position means webpack may treat the module as `javascript/esm`. */
const ESM_SYNTAX = /(?:^|[\r\n])\s*(?:import|export)\s/;

/**
 * Bounded scan of the directive prologue only: an optional shebang, comments, and at most one
 * leading 'use strict' directive. A whole line that is exactly a 'use client' string expression is
 * a directive; the same text inside a comment, an assignment, a call or any later statement is not.
 * Anything ambiguous returns false (no label), so this can never mark a server module as a client
 * boundary.
 */
function hasUseClientDirective(source: string): boolean {
    const limit = Math.min(source.length, 4096);
    const space = ' \t\r\n\f\v';
    let at = 0;
    if (source.slice(0, 2) === '#!') {
        const end = source.indexOf('\n', 2);
        if (end < 0 || end >= limit) return false;
        at = end + 1;
    }
    let sawStrict = false;
    for (let lines = 0; lines < 64 && at < limit; lines++) {
        while (at < limit && space.indexOf(source.charAt(at)) >= 0) at++;
        if (at >= limit) return false;
        /* Comments are skipped wholesale: a directive-looking string inside one is not a directive. */
        if (source.slice(at, at + 2) === '//') {
            const end = source.indexOf('\n', at + 2);
            if (end < 0 || end >= limit) return false;
            at = end + 1;
            continue;
        }
        if (source.slice(at, at + 2) === '/*') {
            const end = source.indexOf('*/', at + 2);
            if (end < 0 || end + 2 >= limit) return false;
            at = end + 2;
            continue;
        }
        let end = source.indexOf('\n', at);
        if (end < 0 || end > limit) end = limit;
        const line = source.slice(at, end).trim();
        if (USE_CLIENT_DIRECTIVE.test(line)) return true;
        if (!sawStrict && USE_STRICT_DIRECTIVE.test(line)) {
            sawStrict = true;
            at = end + 1;
            continue;
        }
        /* Any other statement ends the prologue. */
        return false;
    }
    return false;
}

/**
 * Returns the client-entry label, or undefined when no label should be emitted. A label is emitted
 * only for a `'use client'` module compiled for `serverComponents.isReactServerLayer === true`.
 *
 * ESM modules with plain-identifier refs get an `auto` label, so next-flight-loader emits
 * registerClientReference() exports. CJS-shaped client boundaries (Next's own compiled
 * `'use client'` files, which have no ESM syntax) get the empty-refs `cjs` label, which makes the
 * loader emit `module.exports = createProxy(resourceKey)`; that proxy answers any named import.
 *
 * Anything ambiguous emits NO label, which is the published baseline behaviour. In particular an
 * ESM-shaped module with `export *`, a string-named export, a parse failure, or no available AST
 * walker must not get the empty-refs `cjs` label: next-flight-loader would classify a
 * `javascript/esm` module as 'module', see zero clientRefs, and return `export {}`, dropping every
 * export. Preserving the original body is strictly safer than that regression.
 */
function clientEntryLabel(source: string, options: SwcOptions, host: AddonHost | undefined): string | undefined {
    const serverComponents = options.serverComponents;
    if (!serverComponents || typeof serverComponents !== 'object'
        || (serverComponents as { isReactServerLayer?: unknown }).isReactServerLayer !== true) {
        return undefined;
    }
    if (!hasUseClientDirective(source)) return undefined;
    const filename = typeof options.filename === 'string' ? options.filename : '';
    const esm = ESM_SYNTAX.test(source);
    const babel = host && host.babel;
    let names: unknown;
    if (babel && typeof babel.exportsOfSource === 'function') {
        try { names = babel.exportsOfSource(source, filename); }
        catch { names = undefined; }
    }
    if (Array.isArray(names) && names.length > 0) {
        if (!names.every((name) => typeof name === 'string' && CLIENT_REF_NAME.test(name))) {
            /* `export *`, a string-named export, or any other ref the loader cannot forward.
               Emit NO label: baseline keeps the original body rather than risking `export {}`. */
            return undefined;
        }
        /* All refs are plain identifiers: the loader emits registerClientReference() exports, and
           no zero-refs `export {}` branch is reachable, so every webpack module type is safe. */
        return '/* __next_internal_client_entry_do_not_use__ ' + names.join(',') + ' auto */\n';
    }
    /* Zero refs: `exportsOfSource` found no ESM export names (a CJS body), or the AST walker is
       absent or failed. On an ESM-shaped module the empty-refs `cjs` label would make the loader
       return `export {}` for `javascript/esm` and drop every export. With no label the loader keeps
       the original body: baseline behaviour, no regression. CJS-shaped client boundaries have no
       ESM syntax, and there the empty-refs `cjs` label is what native SWC emits; the loader turns
       it into `module.exports = createProxy(resourceKey)`, which answers any named import. */
    if (esm) return undefined;
    return '/* __next_internal_client_entry_do_not_use__  cjs */\n';
}

interface TransformResult {
    code: string;
    map?: string;
}

function transformResult(
    source: unknown,
    optionsBuffer: unknown,
    isModule: unknown,
    host: AddonHost | undefined
): TransformResult {
    const options = optionsOf(optionsBuffer);
    let src = utf8SourceOf(source);
    /* next-swc-loader.js:212-226 `pitch()` calls `loaderTransform.call(this)` with no source, so
       Next's SWC wrapper (build/swc/index.js:1154-1162) forwards `undefined`. The native addon
       then reads `options.filename` from the filesystem itself. The shim has no Rust file reader,
       so it does the same read through the guest virtual FS. Without this, 81 of 93 transform
       calls in a real `next dev` compile were refusals (dev-page-witness.md). */
    if (src === undefined && (source === undefined || source === null)
        && typeof options.filename === 'string' && options.filename !== ''
        && host && host.fs && typeof host.fs.read === 'function') {
        const bytes = host.fs.read(options.filename);
        if (bytes !== undefined) src = new TextDecoder().decode(bytes);
    }
    if (src === undefined) return unavailable('transform of a non-string source');
    const grammar = configGrammarOf(optionsBuffer);
    if (grammar.syntax === 'typescript' && grammar.moduleType === 'commonjs') {
        return { code: transpileConfig(src, optionsBuffer) };
    }
    if (!host || !host.babel || typeof host.babel.transform !== 'function') {
        return unavailable('transform without the Babel host capability');
    }
    const output = host.babel.transform(src, babelOptionsOf(options, isModule));
    if (!output || typeof output.code !== 'string') {
        return unavailable('transform whose Babel output has no code');
    }
    let code = output.code;
    const label = clientEntryLabel(src, options, host);
    if (label !== undefined) code = label + code;
    return output.map === undefined ? { code: code } : { code: code, map: output.map };
}

/**
 * `lockfile.js` asks for a handle it later hands to lockfileUnlock*, and `readLockfileContent()`
 * reads the path directly for a stale `next dev` server. Holding the path in a table gives that
 * handle a meaning without pretending an OS-level flock exists: the container has one guest
 * process per build and no second process can race it for the same directory.
 */
interface LockHost {
    fs?: {
        /** Reads a virtual-FS file. Native SWC reads `options.filename` itself when its pitch
            loader hands it no source; the shim does the same through the guest filesystem. */
        read?(path: string): Uint8Array | undefined;
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

export function createAddon(host?: AddonHost): object {
    const addon: Record<string, unknown> = {};
    for (const name of ENTRY_POINTS) {
        addon[name] = function () { return refuse(name)(); };
    }
    Object.assign(addon, lockfileBindings(host));
    /* Minification is an optimization, not a correctness requirement. Emitting the input as the
       output is a legitimate minifier with no enabled passes, and it lets a production webpack
       build finish in a container with no native Rust compiler. It is not a silent pass-through:
       the source is read from SWC's own (source, optionsBuffer) call and returned as { code }. */
    function unminified(source: unknown, optionsBuffer: unknown): { code: string } {
        let src = '';
        if (typeof source === 'string') src = source;
        else if (source !== undefined && source !== null) {
            try { src = String((source as { toString(enc?: string): string }).toString('utf8')); }
            catch { src = ''; }
        }
        return { code: src };
    }
    addon.minify = async function (source: unknown, optionsBuffer: unknown) {
        return unminified(source, optionsBuffer);
    };
    addon.minifySync = function (source: unknown, optionsBuffer: unknown) {
        return unminified(source, optionsBuffer);
    };
    /* expandNextJsTemplate is a bounded text expansion over Next's own entrypoint templates. On
       app-page / pages / middleware / edge-app-route the output is byte-identical to the real native
       @next/swc-darwin-arm64 addon (with both a null and a path-valued incrementalCacheHandler).
       Anything this shim cannot expand faithfully is refused rather than returned as broken source:
       no unresolved markers, no undeclared identifiers, no unresolved relative specifiers. */
    function expandNextJsTemplate(
        content: unknown, templatePath: unknown, nextPackageDirPath: unknown,
        replacements: unknown, injections: unknown, imports: unknown
    ): string {
        const source = utf8SourceOf(content);
        if (source === undefined) {
            return unavailable('expandNextJsTemplate with a non-string, non-Buffer template');
        }
        const tp = String(templatePath).replace(/\\/g, '/');
        const root = String(nextPackageDirPath).replace(/\\/g, '/');
        const dir = tp.slice(0, tp.lastIndexOf('/'));
        if (!(dir === root || dir.startsWith(root + '/'))) {
            return unavailable('expandNextJsTemplate with a template outside the Next package');
        }
        const base = 'next/' + dir.slice(root.length).replace(/^\//, '');
        const hasOwn = (record: Record<string, unknown>, key: string): boolean =>
            Object.prototype.hasOwnProperty.call(record, key);
        const lookupOf = (value: unknown): Record<string, unknown> =>
            value && typeof value === 'object' ? value as Record<string, unknown> : {};
        const repl = lookupOf(replacements);
        const inject = lookupOf(injections);
        const importMap = lookupOf(imports);

        /* A quoted VAR_* marker (single or double quoted, any case) is a template variable; a VAR_
           token anywhere else in the original template is an unresolved marker. Caller-supplied
           values are inserted in one pass and never rescanned, so a replacement value containing
           VAR_ does not cause a false refusal. */
        const quotedVar = /(['"])([^'"\n]*VAR_[^'"\n]*)\1/g;
        const masked = source.replace(quotedVar, '\u0000');
        if (/VAR_[A-Za-z0-9_]+/i.test(masked)) {
            return unavailable('expandNextJsTemplate with an unquoted VAR_ marker');
        }

        function posixNormalize(input: string): string {
            const parts: string[] = [];
            for (const part of input.split('/')) {
                if (part === '' || part === '.') continue;
                if (part === '..') {
                    if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
                    else parts.push(part);
                    continue;
                }
                parts.push(part);
            }
            return parts.join('/');
        }
        function resolveRelative(spec: string): string {
            if (/["\r\n\t\\]/.test(spec)) {
                return unavailable('expandNextJsTemplate with an unrepresentable relative specifier');
            }
            const resolved = posixNormalize(base + '/' + spec);
            if (!resolved.startsWith('next/')) {
                return unavailable('expandNextJsTemplate with a relative specifier outside next/');
            }
            return resolved;
        }

        /* Native SWC rewrites exactly these single-quoted relative specifiers: `from '.…'`,
           `import '.…'` (including bare side-effect imports) and `require('.…')`. */
        let importCount = 0;
        let out = source.replace(
            /(from |import )'(\.[^']*)'|require\('(\.[^']*)'\)/g,
            (all: string, pre: string | undefined, fromSpec: string | undefined,
             requireSpec: string | undefined): string => {
                const spec = fromSpec !== undefined ? fromSpec : String(requireSpec);
                const resolved = resolveRelative(spec);
                importCount++;
                return pre !== undefined ? pre + '"' + resolved + '"' : 'require("' + resolved + '")';
            }
        );
        if (importCount === 0) {
            return unavailable('expandNextJsTemplate with no relative import to rewrite');
        }
        if (/(?:\bfrom\s+|\bimport\s*\(?\s*|require\s*\(\s*)(['"])\.[^'"]*\1/.test(out)) {
            return unavailable('expandNextJsTemplate with an unresolved relative specifier');
        }

        const usedReplacements = new Set<string>();
        out = out.replace(quotedVar, (all: string, _quote: string, key: string): string => {
            if (!hasOwn(repl, key)) {
                return unavailable('expandNextJsTemplate with unresolved variable ' + key);
            }
            usedReplacements.add(key);
            const value = repl[key];
            return value === null || value === undefined ? '""' : JSON.stringify(String(value));
        });
        for (const key of Object.keys(repl)) {
            if (!usedReplacements.has(key)) {
                return unavailable('expandNextJsTemplate with unused replacement ' + key);
            }
        }

        const usedInjections = new Set<string>();
        out = out.replace(/\/\/ INJECT:([A-Za-z0-9_$]+)/g, (all: string, key: string): string => {
            if (!hasOwn(inject, key)) return all;
            usedInjections.add(key);
            return 'const ' + key + ' = ' + String(inject[key]);
        });
        out = out.replace(/\/\/ INJECT_RAW:([A-Za-z0-9_$]+)/g, (all: string, key: string): string => {
            if (!hasOwn(inject, key)) return all;
            usedInjections.add(key);
            return String(inject[key]);
        });
        for (const key of Object.keys(inject)) {
            if (!usedInjections.has(key)) {
                return unavailable('expandNextJsTemplate with unused injection ' + key);
            }
        }

        /* The 4th argument is an imports map, not extra VAR_* replacements. Native emits
           `import <name> from "<path>"` or `const <name> = null`, with no trailing semicolon. */
        const usedImports = new Set<string>();
        out = out.replace(
            /\/\/ OPTIONAL_IMPORT:(\* as )?([A-Za-z0-9_$]+)/g,
            (all: string, star: string | undefined, key: string): string => {
                const name = (star || '') + key;
                const mapKey = hasOwn(importMap, key) ? key : hasOwn(importMap, name) ? name : '';
                if (mapKey === '') return all;
                const value = importMap[mapKey];
                usedImports.add(mapKey);
                if (value === null || value === undefined) return 'const ' + key + ' = null';
                if (typeof value !== 'string') return all;
                return 'import ' + name + ' from ' + JSON.stringify(value);
            }
        );
        for (const key of Object.keys(importMap)) {
            if (!usedImports.has(key)) {
                return unavailable('expandNextJsTemplate with unused import ' + key);
            }
        }

        if (/\/\/ (?:INJECT|INJECT_RAW|OPTIONAL_IMPORT):/.test(out)) {
            return unavailable('expandNextJsTemplate with unresolved markers');
        }
        return out.endsWith('\n') ? out : out + '\n';
    }
    addon.expandNextJsTemplate = function (
        content: unknown, templatePath: unknown, nextPackageDirPath: unknown,
        replacements: unknown, injections: unknown, imports: unknown
    ) { return expandNextJsTemplate(content, templatePath, nextPackageDirPath, replacements, injections, imports); };
    addon.getTargetTriple = function () { return 'x86_64-unknown-linux-gnu'; };
    addon.turbopackCacheVersion = function () { return '0.0.0-owc'; };
    /* SWC's binding takes (source, isModule, optionsBuffer): next/dist/build/swc/index.js calls
       bindings.transform(src, isModule, toBuffer(options)) and awaits { code }. A synchronous throw
       from this path becomes an unhandled rejection in next-swc-loader.js:233-238, where webpack's
       callback is never called. Every failure is therefore returned as a rejected Promise. */
    addon.transform = function (source: unknown, isModule: unknown, optionsBuffer: unknown) {
        try {
            return Promise.resolve(transformResult(source, optionsBuffer, isModule, host));
        } catch (e) {
            return Promise.reject(e);
        }
    };
    addon.transformSync = function (source: unknown, isModule: unknown, optionsBuffer: unknown) {
        return transformResult(source, optionsBuffer, isModule, host);
    };
    /* Next's parse-module.js catches a parse failure and answers null; a named refusal is honest. */
    addon.parse = async function () { return unavailable('parse'); };
    addon.parseSync = function () { return unavailable('parseSync'); };
    /* The webpack RSC loader asks for named exports by resource path. Babel's bundled parser reads
       the virtual file and answers the ESM export names; a missing file has no named exports. */
    addon.getModuleNamedExports = async function (resourcePath: unknown) {
        if (typeof resourcePath !== 'string') return unavailable('getModuleNamedExports without a resource path');
        if (!host || !host.babel || typeof host.babel.exports !== 'function') {
            return unavailable('getModuleNamedExports without the Babel host capability');
        }
        const names = host.babel.exports(resourcePath);
        return names;
    };
    /* The trace guard calls these on some paths; they only arm/disarm a subscriber. */
    addon.initCustomTraceSubscriber = function () { return undefined; };
    addon.teardownTraceSubscriber = function () { return undefined; };
    /* Match Next's own WASM fallback (build/swc/index.js:1055-1059): answering true keeps the
       optional Babel pass enabled. Answering false would silently skip a required React Compiler
       transform in an app that sets reactCompiler: true. */
    addon.isReactCompilerRequired = async function () { return true; };
    addon.reactCompiler = {
        isReactCompilerRequired: async function () { return true; }
    };
    return addon;
}
