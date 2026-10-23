import { IFileSystem } from '../../../filesystem';
import { ProcessExecutor } from '../base';
import { ShellProcess } from './process';
import { ChildProcessPayload, Process } from '../../base';
import type { NetworkHandle } from '../../../shell/commands/types';
import { containerEnv } from '../default-env';
import { isContainerShell } from '../node/runtime/capabilities/child';

export class ShellProcessExecutor implements ProcessExecutor {
    constructor(private fileSystem: IFileSystem, private network?: NetworkHandle) { }

    /**
     * `sh` is the bare name a spawn of this container's shell is given, and `/bin/sh` and the rest
     * are the paths it stands at -- the one a host's `exec` runs it through. Both name the shell,
     * and which one it was started under is what `$0` answers and what a diagnostic is prefixed
     * with, so the path is kept and recognised here rather than rewritten to the bare name.
     */
    canExecute(executable: string): boolean {
        return isContainerShell(executable);
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
