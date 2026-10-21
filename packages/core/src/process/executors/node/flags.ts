import { printEvalSource } from './runtime/eval-source';
import { NODE_VERSION } from './runtime/guest/globals';

/**
 * A run `node` answers for the flags it was given, before any script is looked for: `--version`
 * prints the version and exits 0, and a flag node does not know is refused with the message and
 * the status the host's own node gives. Undefined when the arguments name a script, a `-e`/`-p`
 * source, a REPL or nothing at all -- the runs that do reach the guest.
 */
export interface NodeFlagAnswer {
    stdout?: string;
    stderr?: string;
    exitCode: number;
}

/** The status node exits with when it refuses its own arguments. */
const BAD_OPTION_EXIT = 9;

/** `node -e`, `--eval`, `-p` and `--print`: each takes the script to run as its next argument. */
const EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print']);

/** Those of them that insist on a script: `-p` and `--print` run an empty one instead. */
const NEEDS_ARGUMENT = new Set(['-e', '--eval']);

/**
 * What `node` answers for its own arguments, or undefined when the run is a script or a REPL.
 *
 * Node reads options from the front of the line and stops at the first argument that is not one:
 * that argument is the script, and every argument after it belongs to the script, which is why
 * `node file.js --version` prints what the file prints. A flag it does not know is refused
 * wherever it stands -- `node --version --nope` is an error and not a version -- so `--version`
 * is only reached once every option on the line is one node knows.
 */
export function nodeFlagAnswer(args: string[]): NodeFlagAnswer | undefined {
    let version = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        /* `-` is the script read from stdin and `--` ends the options: neither is an option, and
           both end the scan the way a file name does. */
        if (!arg.startsWith('-') || arg === '-' || arg === '--') break;
        if (arg === '--version' || arg === '-v') {
            version = true;
            continue;
        }
        if (EVAL_FLAGS.has(arg)) {
            if (i + 1 < args.length) {
                i++;
                continue;
            }
            if (NEEDS_ARGUMENT.has(arg)) {
                return { stderr: `node: ${arg} requires an argument\n`, exitCode: BAD_OPTION_EXIT };
            }
            break;
        }
        return { stderr: `node: bad option: ${arg}\n`, exitCode: BAD_OPTION_EXIT };
    }
    return version ? { stdout: NODE_VERSION + '\n', exitCode: 0 } : undefined;
}

/**
 * The script `node -p` or `node --print` runs. With no script behind the flag the host runs an
 * empty one, which evaluates to undefined and prints `undefined`; `-e` and `--eval` have already
 * been refused by `nodeFlagAnswer` in that case.
 */
export function printScriptArg(args: string[]): string {
    return printEvalSource(args.length < 2 ? '' : args[1]);
}
