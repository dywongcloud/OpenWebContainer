import { ProcessExecutor } from '../base';
import { ChildProcessPayload, Process } from '../../base';
import { NodeProcess } from './process';
import { IFileSystem } from '../../../filesystem';
import { NetworkManager } from '../../../network/manager';
import { RuntimeServices } from './runtime/services';
import { NodeRunOptions, nodeCommand } from './flags';
import { CONTAINER_WORKDIR } from '../default-env';

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
        const cwd = payload.cwd || CONTAINER_WORKDIR;
        // `node <script> [args]`, `node -e <source> [args]`, `node` alone (a REPL), or a .js executable
        if (payload.executable === 'node') {
            /* What the line is: the flags node answers for itself, before anything is read as a file
               -- `node --version` is not a request to run /--version -- or else a script, a `-e`,
               a `-p` or a REPL, left to the guest exactly as it was. */
            const command = nodeCommand(payload.args);
            /* What the line asked for besides what it runs: the options `process.execArgv` reports,
               the bound `--stack-trace-limit` put on a trace, the title `process.title` reads, and
               the source as it was written. */
            const run: NodeRunOptions = {
                execArgv: command.execArgv,
                ...(command.stackTraceLimit === undefined ? {} : { stackTraceLimit: command.stackTraceLimit }),
                ...(command.evalScript === undefined ? {} : { evalScript: command.evalScript }),
                ...(command.inputType === undefined ? {} : { inputType: command.inputType }),
                ...(command.title === undefined ? {} : { title: command.title }),
                ...(command.interactive === undefined ? {} : { interactive: command.interactive }),
                ...(command.test === undefined ? {} : { test: command.test }),
                ...(command.watch === undefined ? {} : { watch: command.watch }),
                watchPaths: command.watchPaths ?? [],
                envFiles: command.envFiles ?? [],
                envFilesIfExists: command.envFilesIfExists ?? [],
                ...(command.run === undefined ? {} : { run: command.run })
            };
            return new NodeProcess(
                pid,
                command.file,
                command.args,
                this.fileSystem,
                this.networkManager,
                this.services,
                parentPid,
                cwd,
                payload.env ?? {},
                command.evalSource,
                command.flagAnswer,
                undefined,
                run
            );
        }

        return new NodeProcess(
            pid,
            payload.executable,
            payload.args,
            this.fileSystem,
            this.networkManager,
            this.services,
            parentPid,
            cwd,
            payload.env ?? {}
        );
    }
}
