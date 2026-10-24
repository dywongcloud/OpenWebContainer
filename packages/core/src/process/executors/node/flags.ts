import { printEvalSource } from './runtime/eval-source';
import { NODE_COMPLETION_BASH_TEXT, NODE_HELP_TEXT } from './runtime/help-text';
import { NODE_VERSION } from './runtime/guest/globals';

/**
 * A run `node` answers for the flags it was given, before any script is looked for: `--version`
 * prints the version, `--help` prints the usage block, `--check` parses a file, and a flag node
 * does not know is refused with the message and the status the host's own node gives.
 */
export interface NodeFlagAnswer {
    stdout?: string;
    stderr?: string;
    exitCode: number;
    /**
     * The file `node --check <file>` parses. Such an answer needs an engine to parse with, so it is
     * finished where there is one -- `NodeProcess` -- and not here, where there is none.
     */
    check?: string;
}

/**
 * What a `node` command line runs.
 *
 * `file` is the path the guest opens, or one of the sentinels: `[eval]` for a `-e`/`-p` source,
 * `[repl]` for a bare `node`, `[stdin]` for a `node -` that reads the program from its input,
 * `[run]` for a `node --run <script>` that runs a script out of package.json, and `[flags]` for a
 * line the flags answer on their own -- which is the only case that carries `flagAnswer`.
 */
export interface NodeCommand {
    file: string;
    /** What follows the script: `node file.js a b` puts `a b` in process.argv[1..]. */
    args: string[];
    /** The source `-e`/`-p` supplied, already wrapped to print when `-p` asked for it. */
    evalSource?: string;
    /** The source as the line wrote it, before `-p` wrapped it to print: the text node quotes back. */
    evalScript?: string;
    /**
     * `process.execArgv`: the options of the line, in the order node read them and in the words it
     * was given them, `-e` and its source included. Empty for a run of a file and for one read from
     * stdin, which is where node leaves it empty too.
     */
    execArgv: string[];
    /** `--stack-trace-limit=<n>`: the bound the line puts on the frames of a stack trace. */
    stackTraceLimit?: number;
    /** `--input-type=<type>`: how the `-e`/`-p` source is read -- `module` or `commonjs`. */
    inputType?: string;
    /** `--title=<name>`: what `process.title` reads, and what the process is named to the system. */
    title?: string;
    /** `-i`/`--interactive`: the line asked for a REPL even where stdin is not a terminal. */
    interactive?: boolean;
    /** `--test`: the line asked for the test runner, which finds the files to run when none is named. */
    test?: boolean;
    /** `--watch`: the line asked for watch mode, which runs the entry again when a file changes. */
    watch?: boolean;
    /** `--watch-path=<path>`: the paths watch mode watches, in the order the line named them. */
    watchPaths?: string[];
    /** `--env-file=<file>`: files whose lines become entries of `process.env`. */
    envFiles?: string[];
    /** `--env-file-if-exists=<file>`: the same, for a file the run goes on without. */
    envFilesIfExists?: string[];
    /** `--run <script>`: the script of the nearest package.json the line names. */
    run?: string;
    /** The answer for a run that never reaches the guest; set exactly when `file` is `[flags]`. */
    flagAnswer?: NodeFlagAnswer;
}

/** What a run carries over from the line beyond the file it was given. */
export interface NodeRunOptions {
    execArgv: string[];
    stackTraceLimit?: number;
    evalScript?: string;
    inputType?: string;
    title?: string;
    interactive?: boolean;
    test?: boolean;
    /** `--watch`: the line asked for watch mode, which runs the entry again when a file changes. */
    watch?: boolean;
    /** `--watch-path=<path>`: the paths watch mode watches, in the order the line named them. */
    watchPaths?: string[];
    /** `--env-file=<file>`: files whose lines become entries of `process.env`. */
    envFiles?: string[];
    /** `--env-file-if-exists=<file>`: the same, for a file the run goes on without. */
    envFilesIfExists?: string[];
    /** `--run <script>`: the script of the nearest package.json the line names. */
    run?: string;
}

/** The status node exits with when it refuses its own arguments. */
const BAD_OPTION_EXIT = 9;

/**
 * The program `node --test` runs when the line names no file: the runner's own search, and a
 * `require` of everything it found, in the order it found them. The search is node's own -- a file
 * whose name carries `.test`, `-test` or `_test` before its extension, one named `test.<ext>`, one
 * under a directory named `test`, and no `node_modules` anywhere in it -- and it is written as a
 * source rather than as a list so that what runs it is the guest the tests will run on, which is
 * also the only thing here that can read the container's files.
 *
 * One run of the runner reports every file it was given, which is why the files are required and
 * not run one after another: a report per file is a report node does not print.
 */
export const NODE_TEST_DISCOVERY_SOURCE = [
    'var __fs = require("fs"), __path = require("path");',
    'var __found = [];',
    'function __isTest(name) {',
    '  return /\\.test\\.[cm]?js$/.test(name) || /[-_]test\\.[cm]?js$/.test(name) ||',
    '    /^test[-_][^\\/]*\\.[cm]?js$/.test(name) || /^test\\.[cm]?js$/.test(name);',
    '}',
    'function __walk(dir, underTest) {',
    '  var names;',
    '  try { names = __fs.readdirSync(dir); } catch (e) { return; }',
    '  names.sort();',
    '  for (var i = 0; i < names.length; i++) {',
    '    var full = __path.join(dir, names[i]);',
    '    var isDir = false;',
    '    try { isDir = __fs.statSync(full).isDirectory(); } catch (e) { continue; }',
    '    if (isDir) {',
    '      if (names[i] === "node_modules") continue;',
    '      __walk(full, underTest || names[i] === "test");',
    '    } else if (__isTest(names[i]) || (underTest && /\\.[cm]?js$/.test(names[i]))) {',
    '      __found.push(full);',
    '    }',
    '  }',
    '}',
    '__walk(process.cwd(), false);',
    'if (__found.length === 0) {',
    '  console.log("\\u2139 tests 0");',
    '  console.log("\\u2139 suites 0");',
    '  console.log("\\u2139 pass 0");',
    '  console.log("\\u2139 fail 0");',
    '  console.log("\\u2139 cancelled 0");',
    '  console.log("\\u2139 skipped 0");',
    '  console.log("\\u2139 todo 0");',
    '  console.log("\\u2139 duration_ms 0");',
    '} else {',
    '  for (var __i = 0; __i < __found.length; __i++) require(__found[__i]);',
    '}'
].join('\n');

/**
 * What node writes when `--print` is asked for a source it reads as an ES module: printing the
 * completion value of a module is something node cannot do, so the run is refused before the
 * source is read, with the frames of the two internals that refuse it. Captured from the build
 * NODE_VERSION names, as the usage block is.
 */
const PRINT_WITH_ESM_INPUT =
    'node:internal/process/execution:73\n' +
    '    throw new ERR_EVAL_ESM_CANNOT_PRINT();\n' +
    '    ^\n' +
    '\n' +
    'Error [ERR_EVAL_ESM_CANNOT_PRINT]: --print cannot be used with ESM input\n' +
    '    at evalModuleEntryPoint (node:internal/process/execution:73:11)\n' +
    '    at node:internal/main/eval_string:37:3 {\n' +
    "  code: 'ERR_EVAL_ESM_CANNOT_PRINT'\n" +
    '}\n' +
    '\n' +
    `Node.js ${NODE_VERSION}\n`;

/**
 * The long options node reads, and what it wants behind each: the table node itself reads, taken
 * from the host's own `node --completion-bash` and from the answer the host's node gives each name.
 * This container has nothing to answer for any of them -- it emits no warnings to suppress, it keeps
 * no V8 heap a size could bound, and it never aborts on an uncaught exception -- so a script written
 * for node that shells out with one is accepted here too, where refusing them is what turned each of
 * `node --input-type=module`, `node --no-warnings` and the rest into a `node: bad option` and an
 * exit 9 the host's own node never gave.
 *
 * A name node does not know stays refused, as it does on the host: `node --nope` is a bad option
 * there and here, and so is a `--no-<name>` for an option that is not a boolean one.
 */
const BOOLEAN_LONG_OPTIONS = new Set((
    /* boolean: `--no-<name>` is accepted too */
    '--abort-on-uncaught-exception --addons --allow-addons --allow-child-process ' +
    '--allow-inspector --allow-wasi --allow-worker --async-context-frame --completion-bash ' +
    '--cpu-prof --debug-arraybuffer-allocations --deprecation --disable-sigusr1 ' +
    '--disable-wasm-trap-handler --disallow-code-generation-from-strings ' +
    '--enable-etw-stack-walking --enable-network-family-autoselection --enable-source-maps ' +
    '--entry-url --experimental-addon-modules --experimental-detect-module ' +
    '--experimental-eventsource --experimental-global-navigator ' +
    '--experimental-import-meta-resolve --experimental-inspector-network-resource ' +
    '--experimental-network-inspection --experimental-print-required-tla ' +
    '--experimental-repl-await --experimental-require-module --experimental-shadow-realm ' +
    '--experimental-sqlite --experimental-strip-types --experimental-test-coverage ' +
    '--experimental-test-module-mocks --experimental-transform-types --experimental-vm-modules ' +
    '--experimental-websocket --experimental-webstorage --experimental-worker-inspection ' +
    '--expose-gc --expose-internals --extra-info-on-fatal-exception --force-async-hooks-checks ' +
    '--force-context-aware --force-node-api-uncaught-exceptions-policy --frozen-intrinsics ' +
    '--global-search-paths --harmony-shadow-realm --heap-prof --insecure-http-parser ' +
    '--interactive --interpreted-frames-native-stack --jitless --network-family-autoselection ' +
    '--node-snapshot --openssl-legacy-provider --openssl-shared-config --pending-deprecation ' +
    '--perf-basic-prof --perf-basic-prof-only-functions --perf-prof --perf-prof-unwinding-info ' +
    '--permission --preserve-symlinks --preserve-symlinks-main --prof --report-compact ' +
    '--report-exclude-env --report-exclude-network --report-on-fatalerror --report-on-signal ' +
    '--report-uncaught-exception --require-module --strip-types --test --test-force-exit --test-only ' +
    '--test-udp-no-try-send --test-update-snapshots --throw-deprecation --tls-max-v1.2 ' +
    '--tls-max-v1.3 --tls-min-v1.0 --tls-min-v1.1 --tls-min-v1.2 --tls-min-v1.3 ' +
    '--trace-deprecation --trace-env --trace-env-js-stack --trace-env-native-stack --trace-exit ' +
    '--trace-promises --trace-sigint --trace-sync-io --trace-tls --trace-uncaught ' +
    '--trace-warnings --track-heap-objects --use-bundled-ca --use-env-proxy --use-openssl-ca ' +
    '--use-system-ca --v8-options --verify-base-objects --warnings --watch --watch-preserve-output ' +
    '--zero-fill-buffers '
).split(/\s+/).filter((name) => name !== ''));

const FLAG_LONG_OPTIONS = new Set((
    /* accepted, but not negatable: node calls `--no-<name>` an invalid negation */
    '--es-module-specifier-resolution --experimental-abortcontroller --experimental-fetch ' +
    '--experimental-global-customevent --experimental-global-webcrypto ' +
    '--experimental-json-modules --experimental-modules --experimental-quic ' +
    '--experimental-report --experimental-specifier-resolution --experimental-test-snapshots ' +
    '--experimental-top-level-await --experimental-wasi-unstable-preview1 ' +
    '--experimental-wasm-modules --experimental-worker --http-parser --napi-modules ' +
    '--node-memory-debug --trace-events-enabled '
).split(/\s+/).filter((name) => name !== ''));

const VALUED_LONG_OPTIONS = new Set((
    /* valued: the value comes behind an `=`, or as the next argument */
    '--allow-fs-read --allow-fs-write --build-snapshot --build-snapshot-config --conditions ' +
    '--cpu-prof-dir --cpu-prof-interval --cpu-prof-name --debug --debug-brk --debug-port ' +
    '--diagnostic-dir --disable-proto --disable-warning --dns-result-order --enable-fips ' +
    '--env-file --env-file-if-exists --experimental-config-file ' +
    '--experimental-default-config-file --experimental-loader --experimental-sea-config ' +
    '--experimental-test-isolation --force-fips --heap-prof-dir --heap-prof-interval ' +
    '--heap-prof-name --heapsnapshot-near-heap-limit --heapsnapshot-signal --icu-data-dir ' +
    '--import --input-type --loader --localstorage-file --max-heap-size --max-http-header-size ' +
    '--max-old-space-size --max-old-space-size-percentage --max-semi-space-size ' +
    '--network-family-autoselection-attempt-timeout --openssl-config --prof-process ' +
    '--redirect-warnings --report-dir --report-directory --report-filename --report-signal ' +
    '--require --run --secure-heap --secure-heap-min --security-revert --security-reverts ' +
    '--snapshot-blob --stack-size --test-concurrency --test-coverage-branches ' +
    '--test-coverage-exclude ' +
    '--test-coverage-functions --test-coverage-include --test-coverage-lines ' +
    '--test-global-setup --test-isolation --test-name-pattern --test-reporter ' +
    '--test-reporter-destination --test-rerun-failures --test-shard --test-skip-pattern ' +
    '--test-timeout --title --tls-cipher-list --tls-keylog --trace-event-categories ' +
    '--trace-event-file-pattern --trace-require-module --unhandled-rejections --use-largepages ' +
    '--v8-pool-size --watch-kill-signal --watch-path '
).split(/\s+/).filter((name) => name !== ''));

/** The four types `--input-type` reads: anything else is refused, as it is on the host. */
const INPUT_TYPES = new Set(['module', 'commonjs', 'module-typescript', 'commonjs-typescript']);

/** The one of those with an effect here: the bound it puts on the frames of a stack trace. */
const STACK_TRACE_LIMIT = '--stack-trace-limit';

/** True for a name in node's own table, whatever it wants behind it. */
function isKnownOption(name: string): boolean {
    return BOOLEAN_LONG_OPTIONS.has(name) || FLAG_LONG_OPTIONS.has(name) || VALUED_LONG_OPTIONS.has(name);
}

/** An option of node's own table, read with the value it wants, or undefined for a name it does not know. */
interface KnownOption {
    /** The option and its value, in node's own words: what `process.execArgv` is. */
    words: string[];
    /** The index of the last argument the option read: one past it when it took the argument after. */
    at: number;
    /** What node refuses the line with when the value the option wants is not there. */
    refusal?: string;
}

/**
 * One option of node's table, as this line wrote it. A valued one carries its value behind an `=`, or
 * takes the argument after when that argument is not itself an option -- `--title foo`,
 * `--require ./pre.js` -- and is refused as incomplete when the line ends or an option follows, the
 * way the host refuses it.
 */
function knownOption(arg: string, name: string, value: string | undefined, args: string[], at: number): KnownOption | undefined {
    if (VALUED_LONG_OPTIONS.has(name)) {
        if (value !== undefined) return { words: [arg], at };
        const next = args[at + 1];
        if (next === undefined || isOption(next)) return { words: [], at, refusal: `${name} requires an argument` };
        return { words: [name, next], at: at + 1 };
    }
    if (BOOLEAN_LONG_OPTIONS.has(name) || FLAG_LONG_OPTIONS.has(name)) return { words: [arg], at };
    return undefined;
}

/** An argument node reads as one of its own options: a dash that is not the stdin `-` or the `--` that ends them. */
function isOption(arg: string | undefined): boolean {
    return arg !== undefined && arg.startsWith('-') && arg !== '-' && arg !== '--';
}

/**
 * The script `-p`/`--print` takes from the line: the next argument, when there is one and it is not
 * itself an option. `node -p` alone runs an empty script and prints `undefined`, and `node -p -e 1+1`
 * is a print of `1+1` and not a print of the string `-e`.
 */
function takeScript(args: string[], at: number): { script?: string; at: number } {
    const next = args[at + 1];
    if (next === undefined || isOption(next)) return { at };
    return { script: next, at: at + 1 };
}

/**
 * The options `NODE_OPTIONS` may not carry: the ones that say what the process itself is -- the
 * source it evaluates, the file it checks, the answer it prints, the session it opens, the script
 * it runs out of a package.json, the files it reads its environment from -- and the ones that would
 * have it start a second process of its own, which is what watch mode does. Node refuses the whole
 * line for any of them, with `is not allowed in NODE_OPTIONS`, before anything runs.
 */
const NODE_OPTIONS_REFUSED = new Set([
    '--build-snapshot', '--check', '--completion-bash', '--env-file', '--env-file-if-exists',
    '--eval', '--experimental-config-file', '--help', '--interactive', '--print', '--prof-process',
    '--run', '--security-revert', '--test', '--version', '--v8-options', '--watch', '--watch-path'
]);

/** The short spellings of those, which node refuses under the name the variable wrote. */
const NODE_OPTIONS_REFUSED_SHORT = new Set(['-c', '-e', '-h', '-i', '-p', '-v']);

/** What `NODE_OPTIONS` asked for, or the one message node refuses the whole line with. */
export interface NodeOptionsRequest {
    /** The message node writes on stderr and exits 9 over; set when the line is refused. */
    refusal?: string;
    /** `--title=<name>`: what the guest's `process.title` reads. */
    title?: string;
    /** `--stack-trace-limit=<n>`: the bound put on the frames of a stack trace. */
    stackTraceLimit?: number;
    /** `-r`/`--require`: the modules to load before the entry, in the order the variable named them. */
    preloads: string[];
}

/**
 * What the `NODE_OPTIONS` of the environment asks for, read the way node reads it: the variable
 * holds a whole command line of options, split on whitespace, and every one of them is read before
 * any is answered -- so one node will not have is a refusal of the whole line, with status 9, and
 * nothing of the script is run.
 *
 * What they ask for that this container has an answer for is applied: `--title` names the process,
 * `--stack-trace-limit` bounds a trace, and `-r`/`--require` names a module to load first. The rest
 * are options this container has nothing to do for -- no V8 heap to bound, no warnings to suppress
 * -- and are accepted, as they are on the line itself.
 */
export function parseNodeOptions(text: string): NodeOptionsRequest {
    const words = text.split(/\s+/).filter((word) => word !== '');
    const request: NodeOptionsRequest = { preloads: [] };
    for (let i = 0; i < words.length; i++) {
        const arg = words[i]!;
        const eq = arg.indexOf('=');
        const name = eq < 0 ? arg : arg.slice(0, eq);
        const value = eq < 0 ? undefined : arg.slice(eq + 1);
        /* Node names a valued option in this refusal with its `=`, and one written without a value
           without it: `--env-file=.env` is refused as `--env-file=`, and `--watch` as `--watch`. */
        const asWritten = eq < 0 ? name : `${name}=`;
        const refused = `${asWritten} is not allowed in NODE_OPTIONS`;
        if (!isOption(arg) || NODE_OPTIONS_REFUSED_SHORT.has(name) || NODE_OPTIONS_REFUSED.has(name)) {
            return { refusal: refused, preloads: [] };
        }
        if (name.startsWith('--no-')) {
            const base = '--' + name.slice('--no-'.length);
            if (BOOLEAN_LONG_OPTIONS.has(base)) continue;
            if (isKnownOption(base)) {
                return { refusal: `${name} is an invalid negation because it is not a boolean option`, preloads: [] };
            }
            return { refusal: refused, preloads: [] };
        }
        if (name === STACK_TRACE_LIMIT) {
            /* Node reads the bound behind an `=` and nowhere else, and it is a count of frames. */
            if (value === undefined || !/^\d+$/.test(value)) {
                return { refusal: `${STACK_TRACE_LIMIT} requires an argument`, preloads: [] };
            }
            request.stackTraceLimit = Number(value);
            continue;
        }
        if (name === '--require' || name === '-r') {
            const spec = value ?? words[i + 1];
            if (spec === undefined || isOption(spec)) return { refusal: `${name} requires an argument`, preloads: [] };
            if (value === undefined) i++;
            request.preloads.push(spec);
            continue;
        }
        if (VALUED_LONG_OPTIONS.has(name)) {
            if (value === undefined) {
                const next = words[i + 1];
                if (next === undefined || isOption(next)) return { refusal: `${arg} requires an argument`, preloads: [] };
                i++;
                if (name === '--title') request.title = next;
                continue;
            }
            if (name === '--title') request.title = value;
            continue;
        }
        if (isKnownOption(name)) continue;
        return { refusal: refused, preloads: [] };
    }
    return request;
}

/**
 * One message node refuses a line with. A bad option is one node drops when it has something more
 * to say about the line -- `--check` together with `-e` -- where an `-e` left without its argument
 * is one it keeps.
 */
interface Refusal {
    text: string;
    badOption: boolean;
}

function refuse(errors: Refusal[]): NodeCommand {
    const stderr = errors.map((error) => `node: ${error.text}\n`).join('');
    return { file: '[flags]', args: [], execArgv: [], flagAnswer: { stderr, exitCode: BAD_OPTION_EXIT } };
}

/** A line the flags answer on their own. */
function answered(answer: NodeFlagAnswer): NodeCommand {
    return { file: '[flags]', args: [], execArgv: [], flagAnswer: answer };
}

/**
 * What `node` runs for a line of arguments, read the way node reads one.
 *
 * Node reads options from the front of the line and stops at the first argument that is not one:
 * that argument is the script, and every argument after it belongs to the script, which is why
 * `node file.js --version` prints what the file prints. Every option on the line is read before any
 * of them is answered, and a line node cannot honour is refused -- `node --version --nope` is an
 * error and not a version, and `node --nope --nope2` is refused twice over.
 *
 * A long option may carry its value behind an `=`: `--eval=<source>` runs that source, `--version=x`
 * prints the version, and one node does not know is still refused as a whole, `=` and all.
 * `-pe` is the one bundle node reads: print, then the `-e` that takes the next argument. `-pv`,
 * `-ep` and every other bundle are refused.
 */
export function nodeCommand(args: string[]): NodeCommand {
    let version = false;
    let help = false;
    let check = false;
    let completionBash = false;
    let print = false;
    let script: string | undefined;
    /** `-e`/`--eval` was given, whether or not the source behind it was. */
    let evalSeen = false;
    /** `--input-type=<type>`: how the source behind `-e`/`-p` is read. */
    let inputType: string | undefined;
    /** `-i`/`--interactive`: the line asked for a REPL even where stdin is not a terminal. */
    let interactive = false;
    /** `--test`: the line asked for the test runner, which finds the files to run when none is named. */
    let test = false;
    /** `--watch`: the line asked for watch mode, which runs the entry again when a file changes. */
    let watch = false;
    /** `--watch-path=<path>`: the paths watch mode watches, in the order the line named them. */
    const watchPaths: string[] = [];
    /** `--env-file=<file>`: the files whose lines become entries of `process.env`. */
    const envFiles: string[] = [];
    /** `--env-file-if-exists=<file>`: the same, for a file the run goes on without. */
    const envFilesIfExists: string[] = [];
    /** `--run <script>`: the script of the nearest package.json the line names. */
    let run: string | undefined;
    /** `--title=<name>`: what `process.title` reads once the guest is up. */
    let title: string | undefined;
    /** The options of the line, in node's own words: what `process.execArgv` is. */
    const execArgv: string[] = [];
    let stackTraceLimit: number | undefined;
    const errors: Refusal[] = [];
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (!isOption(arg)) break;
        if (arg.startsWith('--')) {
            const eq = arg.indexOf('=');
            const name = eq < 0 ? arg : arg.slice(0, eq);
            const value = eq < 0 ? undefined : arg.slice(eq + 1);
            if (name === '--version') { version = true; execArgv.push(arg); continue; }
            if (name === '--help') { help = true; execArgv.push(arg); continue; }
            if (name === '--check') { check = true; execArgv.push(arg); continue; }
            if (name === '--completion-bash') { completionBash = true; execArgv.push(arg); continue; }
            if (name === '--interactive') { interactive = true; execArgv.push(arg); continue; }
            if (name === '--no-interactive') { interactive = false; execArgv.push(arg); continue; }
            if (name === '--test') {
                /* `--test` is the one option of node's table that reads a value behind an `=` and
                   never takes the argument after it: `node --test t.js` runs the file, where a valued
                   option would have taken the name as its own value and left no file to run at all. */
                test = true;
                execArgv.push(arg);
                continue;
            }
            if (name === '--watch' || name === '--no-watch') {
                /* `--watch` is watch mode, and it is one of node's boolean options: it takes no
                   value of its own, so `node --watch p.mjs` runs p.mjs and watches it. `--watch-path`
                   is the one behind which a path does stand. */
                watch = name === '--watch' && value !== 'false';
                execArgv.push(arg);
                continue;
            }
            if (name === '--input-type') {
                /* One of the valued options, and the one a run of a source reads: node takes the
                   value behind an `=` or as the next argument, and refuses a line with neither. */
                const known = knownOption(arg, name, value, args, i);
                if (known !== undefined) {
                    if (known.refusal !== undefined) {
                        errors.push({ text: known.refusal, badOption: false });
                        break;
                    }
                    inputType = value ?? known.words[1];
                    /* Node reads four types and refuses a fifth, however the value was written. */
                    if (!INPUT_TYPES.has(inputType)) {
                        errors.push({ text: `${name} must be "module","commonjs", "module-typescript" or "commonjs-typescript"`, badOption: false });
                        break;
                    }
                    execArgv.push(...known.words);
                    i = known.at;
                    continue;
                }
            }
            const known = knownOption(arg, name, value, args, i);
            if (known !== undefined) {
                if (known.refusal !== undefined) {
                    errors.push({ text: known.refusal, badOption: false });
                    break;
                }
                execArgv.push(...known.words);
                /* `--title` is the one option of node's table a script can read back: node changes
                   `process.title` for it, and the OS name of the process with it. */
                if (name === '--title') title = value ?? known.words[1];
                /* The four options a run does something with, rather than only carrying: the paths
                   watch mode watches, the files `process.env` is filled from, and the script of a
                   package.json `node --run` names. All four may be given more than once. */
                if (name === '--watch-path') {
                    /* A `--watch-path` is watch mode on its own: node watches the paths it names
                       whether or not `--watch` was said, and the tree the entry stands in is what
                       `--watch` adds to them. */
                    watch = true;
                    watchPaths.push(value ?? known.words[1]!);
                }
                if (name === '--env-file') envFiles.push(value ?? known.words[1]!);
                if (name === '--env-file-if-exists') envFilesIfExists.push(value ?? known.words[1]!);
                if (name === '--run') run = value ?? known.words[1]!;
                i = known.at;
                continue;
            }
            if (name.startsWith('--no-')) {
                /* `--no-<name>` is the false of a boolean option, and only of one: node answers an
                   option that is not boolean with the negation it refuses, not with `bad option`. */
                const base = '--' + name.slice('--no-'.length);
                if (BOOLEAN_LONG_OPTIONS.has(base)) { execArgv.push(arg); continue; }
                if (isKnownOption(base)) {
                    errors.push({ text: `${name} is an invalid negation because it is not a boolean option`, badOption: true });
                    continue;
                }
                errors.push({ text: `bad option: ${arg}`, badOption: true });
                continue;
            }
            if (name === STACK_TRACE_LIMIT) {
                /* Node reads the bound behind an `=` and nowhere else, and it is a count of frames:
                   anything that is not one is a bad option, as it is on the host. */
                if (value !== undefined && /^\d+$/.test(value)) {
                    stackTraceLimit = Number(value);
                    execArgv.push(arg);
                    continue;
                }
                errors.push({ text: `bad option: ${arg}`, badOption: true });
                continue;
            }
            if (name === '--print') {
                execArgv.push(arg);
                print = true;
                /* `--print=<source>` prints `undefined`: node runs an empty script and ignores the
                   value, unlike `--eval=<source>`, which runs it. */
                const taken = takeScript(args, i);
                if (value === undefined && taken.script !== undefined) script = taken.script;
                i = taken.at;
                continue;
            }
            if (name === '--eval') {
                evalSeen = true;
                if (value !== undefined) { script = value; execArgv.push(arg); continue; }
                const taken = takeScript(args, i);
                if (taken.script === undefined) {
                    /* Nothing more is read after this: `--nope` behind a source that never came is
                       not an option node goes on to refuse. */
                    errors.push({ text: `${name} requires an argument`, badOption: false });
                    break;
                }
                script = taken.script;
                execArgv.push(arg, taken.script);
                i = taken.at;
                continue;
            }
            errors.push({ text: `bad option: ${arg}`, badOption: true });
            continue;
        }
        if (arg === '-v') { version = true; execArgv.push(arg); continue; }
        if (arg === '-h') { help = true; execArgv.push(arg); continue; }
        if (arg === '-c') { check = true; execArgv.push(arg); continue; }
        if (arg === '-i') {
            /* `-i` is node's `--interactive`: a REPL whether or not stdin looks like a terminal. */
            interactive = true;
            execArgv.push(arg);
            continue;
        }
        if (arg === '-r') {
            /* `-r` is node's `--require`: a module to load before the entry. This container loads
               nothing for it, as it loads nothing for any other option of node's, but the line is
               read as node reads one -- the module is its value, and a line without one is refused. */
            const taken = takeScript(args, i);
            if (taken.script === undefined) {
                errors.push({ text: `${arg} requires an argument`, badOption: false });
                break;
            }
            execArgv.push(arg, taken.script);
            i = taken.at;
            continue;
        }
        if (arg === '-p' || arg === '-pe') {
            print = true;
            execArgv.push(arg);
            if (arg === '-pe') {
                /* The bundle is read as `--print --eval`, and it is the long name node prints when
                   the script the `--eval` needs is missing. */
                evalSeen = true;
                const taken = takeScript(args, i);
                if (taken.script === undefined) {
                    errors.push({ text: '--eval requires an argument', badOption: false });
                    break;
                }
                script = taken.script;
                execArgv.push(taken.script);
                i = taken.at;
            } else {
                const taken = takeScript(args, i);
                if (taken.script !== undefined) { script = taken.script; execArgv.push(taken.script); }
                i = taken.at;
            }
            continue;
        }
        if (arg === '-e') {
            evalSeen = true;
            const taken = takeScript(args, i);
            if (taken.script === undefined) {
                errors.push({ text: `${arg} requires an argument`, badOption: false });
                break;
            }
            script = taken.script;
            execArgv.push(arg, taken.script);
            i = taken.at;
            continue;
        }
        errors.push({ text: `bad option: ${arg}`, badOption: true });
    }
    /* `--check` and `-e` are two ways of saying what to do with a source, and node refuses the line
       that asks for both -- ahead of a version, a help and any bad option it had already recorded. */
    if (check && (evalSeen || script !== undefined)) {
        const kept = errors.filter((error) => !error.badOption);
        kept.push({ text: 'either --check or --eval can be used, not both', badOption: false });
        return refuse(kept);
    }
    if (errors.length > 0) return refuse(errors);
    /* A version outranks a help and a help outranks a check, and a completion-bash outranks a help
       but not a version: `node --help --version` is a version, `node --check --help` is a help, and
       `node --help --completion-bash` is the completion script. */
    if (version) return answered({ stdout: NODE_VERSION + '\n', exitCode: 0 });
    if (completionBash) return answered({ stdout: NODE_COMPLETION_BASH_TEXT, exitCode: 0 });
    if (help) return answered({ stdout: NODE_HELP_TEXT, exitCode: 0 });

    const trailing = args.slice(i);
    /* What every run carries from the line, whatever it runs: the options node read, and the bound
       one of them put on a stack trace. */
    const carry = {
        execArgv,
        watchPaths,
        envFiles,
        envFilesIfExists,
        ...(stackTraceLimit === undefined ? {} : { stackTraceLimit }),
        ...(inputType === undefined ? {} : { inputType }),
        ...(title === undefined ? {} : { title }),
        ...(interactive ? { interactive } : {}),
        ...(test ? { test } : {}),
        ...(watch ? { watch } : {}),
        ...(run === undefined ? {} : { run })
    };
    /* `node --run <script>` runs no file of the line: what runs is the script the nearest
       package.json keeps under that name, handed to a shell the way npm hands one. */
    if (run !== undefined) return { file: '[run]', args: [], ...carry };
    /* `--` ends the options: what follows is the script, even where it begins with a dash, so
       `node -- --version` runs the file rather than printing a version. */
    let file: string | undefined;
    let rest = trailing;
    if (rest[0] === '--') {
        file = rest[1];
        rest = rest.slice(2);
    } else if (rest.length > 0) {
        file = rest[0];
        rest = rest.slice(1);
    }
    /* An empty script argument names no script at all, the way node reads one: `node ''` reads its
       program from stdin and leaves with status 0 once the input ends, and `node --check ''` checks
       nothing and reports nothing. Only a real name reaches the loader. */
    if (file === '') file = undefined;
    /* `node --check` with no script checks nothing and reports nothing, as node does. It outranks a
       `-p` that was left without its source: `node -c -p` is a check of nothing, not a print. */
    if (check) {
        return answered({ exitCode: 0, ...(file === undefined ? {} : { check: file }) });
    }
    if (print || script !== undefined) {
        /* A print of a source read as an ES module is refused before the source is read: node has
           no completion value to print for one. */
        if (print && inputType === 'module') return answered({ stderr: PRINT_WITH_ESM_INPUT, exitCode: 1 });
        /* No file follows a source, so `--` here is the one that ends the options: what follows is
           the first argument, which is how a caller hands a script its data. */
        return {
            file: '[eval]',
            args: trailing[0] === '--' ? trailing.slice(1) : trailing,
            evalSource: print ? printEvalSource(script ?? '') : script ?? '',
            ...(script === undefined ? {} : { evalScript: script }),
            ...carry
        };
    }
    /* `node -` reads the program from stdin, as the host does: what is piped in is the script, and
       the `-` stays the first argument the script sees, which is where node leaves it too. */
    if (file === '-') return { file: '[stdin]', args: trailing, ...carry };
    if (file !== undefined) return { file, args: rest, ...carry };
    /* Node starts a REPL when it is given no file; it does not complain. The sentinel is read the
       way `[eval]` is: no file is resolved for it. */
    return { file: '[repl]', args: [], ...carry };
}
