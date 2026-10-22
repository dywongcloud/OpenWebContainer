import { printEvalSource } from './runtime/eval-source';
import { NODE_HELP_TEXT } from './runtime/help-text';
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
 * `[repl]` for a bare `node`, `[stdin]` for a `node -` that reads the program from its input, and
 * `[flags]` for a line the flags answer on their own -- which is the only case that carries
 * `flagAnswer`.
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
    /** The answer for a run that never reaches the guest; set exactly when `file` is `[flags]`. */
    flagAnswer?: NodeFlagAnswer;
}

/** What a run carries over from the line beyond the file it was given. */
export interface NodeRunOptions {
    execArgv: string[];
    stackTraceLimit?: number;
    evalScript?: string;
}

/** The status node exits with when it refuses its own arguments. */
const BAD_OPTION_EXIT = 9;

/**
 * The long options node reads and this container has nothing to answer for: it emits no warnings to
 * suppress, it keeps no V8 heap a size could bound, it never aborts on an uncaught exception, and a
 * `-e` source is compiled in the goal the source itself asks for. Node accepts every one of them, so
 * a script written for node that shells out with one is accepted here too -- refusing them is what
 * turned each of `node --input-type=module`, `node --no-warnings` and the rest into a
 * `node: bad option` and an exit 9 where the host's own node ran the line.
 *
 * Node reads a value behind an `=` and never in the argument after, so `--input-type module` is a
 * bad option on the host too; what is accepted here is the form node accepts.
 */
const IGNORED_LONG_OPTIONS = new Set([
    '--abort-on-uncaught-exception',
    '--conditions',
    '--experimental-default-type',
    '--input-type',
    '--max-old-space-size',
    '--max-semi-space-size',
    '--no-deprecation',
    '--no-warnings',
    '--stack-size',
    '--title',
    '--trace-uncaught',
    '--trace-warnings'
]);

/** The one of those with an effect here: the bound it puts on the frames of a stack trace. */
const STACK_TRACE_LIMIT = '--stack-trace-limit';

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
    let print = false;
    let script: string | undefined;
    /** `-e`/`--eval` was given, whether or not the source behind it was. */
    let evalSeen = false;
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
            if (IGNORED_LONG_OPTIONS.has(name)) { execArgv.push(arg); continue; }
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
    /* A version outranks a help and a help outranks a check: `node --help --version` is a version,
       and `node --check --help` is a help. */
    if (version) return answered({ stdout: NODE_VERSION + '\n', exitCode: 0 });
    if (help) return answered({ stdout: NODE_HELP_TEXT, exitCode: 0 });

    const trailing = args.slice(i);
    /* What every run carries from the line, whatever it runs: the options node read, and the bound
       one of them put on a stack trace. */
    const carry = { execArgv, stackTraceLimit };
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
    /* `node --check` with no script checks nothing and reports nothing, as node does. It outranks a
       `-p` that was left without its source: `node -c -p` is a check of nothing, not a print. */
    if (check) {
        return answered({ exitCode: 0, ...(file === undefined ? {} : { check: file }) });
    }
    if (print || script !== undefined) {
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
