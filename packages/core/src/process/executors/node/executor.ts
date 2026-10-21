import { ProcessExecutor } from '../base';
import { ChildProcessPayload, Process } from '../../base';
import { NodeProcess } from './process';
import { IFileSystem } from '../../../filesystem';
import { NetworkManager } from '../../../network/manager';
import { RuntimeServices } from './runtime/services';
import { nodeFlagAnswer, printScriptArg } from './flags';

export class NodeProcessExecutor implements ProcessExecutor {
    constructor(
        private fileSystem: IFileSystem,
        private networkManager: NetworkManager,
        private services: RuntimeServices
    ) { }

    canExecute(executable: string): boolean {
        return executable === 'node' || executable.endsWith('.js');
    }

    async execute(payload: ChildProcessPayload, pid: number, parentPid?: number): Promise<Process> {
        let executablePath = payload.executable;
        let args = payload.args;
        let evalSource: string | undefined;

        const cwd = payload.cwd || '/';
        // `node <script> [args]`, `node -e <source> [args]`, `node` alone (a REPL), or a .js executable
        if (executablePath === 'node') {
            /* The flags node answers for itself, before anything is read as a file: `node --version`
               is not a request to run /--version. Everything else -- a script, `-e`, `-p`, a REPL --
               is left to the guest exactly as it was. */
            const answered = nodeFlagAnswer(args);
            if (answered !== undefined) {
                return new NodeProcess(
                    pid,
                    '[flags]',
                    [],
                    this.fileSystem,
                    this.networkManager,
                    this.services,
                    parentPid,
                    cwd,
                    payload.env ?? {},
                    undefined,
                    answered
                );
            }
            if (args.length === 0) {
                /* Node starts a REPL when it is given no file; it does not complain. The sentinel is
                   read the way `[eval]` is: no file is resolved for it. */
                executablePath = '[repl]';
            } else if (args[0] === '-e' || args[0] === '--eval') {
                if (args.length < 2) throw new Error(`${args[0]} requires an argument`);
                evalSource = args[1];
                executablePath = '[eval]';
                args = args.slice(2);
            } else if (args[0] === '-p' || args[0] === '--print') {
                evalSource = printScriptArg(args);
                executablePath = '[eval]';
                args = args.slice(2);
            } else if (args[0] === '--' && args.length > 1) {
                /* `--` ends the options: what follows is the script, even where it begins with a
                   dash, so `node -- --version` runs the file rather than printing a version. */
                executablePath = args[1];
                args = args.slice(2);
            } else {
                executablePath = args[0];
                args = args.slice(1);
            }
        }

        return new NodeProcess(
            pid,
            executablePath,
            args,
            this.fileSystem,
            this.networkManager,
            this.services,
            parentPid,
            cwd,
            payload.env ?? {},
            evalSource
        );
    }
}
