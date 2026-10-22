import { IFileSystem } from '../../../filesystem';
import { ProcessExecutor } from '../base';
import { ShellProcess } from './process';
import { ChildProcessPayload, Process } from '../../base';
import type { NetworkHandle } from '../../../shell/commands/types';
import { containerEnv } from '../default-env';

export class ShellProcessExecutor implements ProcessExecutor {
    constructor(private fileSystem: IFileSystem, private network?: NetworkHandle) { }

    canExecute(executable: string): boolean {
        return executable === 'sh';
    }

    async execute(payload: ChildProcessPayload, pid: number, parantPid?: number): Promise<Process> {
        /* A caller's environment -- npm run's PATH of node_modules/.bin, say -- is the shell's,
           with the container's own defaults behind it for the names the caller left out. */
        const env = containerEnv(payload.cwd, payload.env ?? {});
        return new ShellProcess(
            pid,
            payload.executable,
            payload.args,
            this.fileSystem,
            parantPid,
            payload.cwd,
            env,
            this.network
        );
    }
}
