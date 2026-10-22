import { ShellCommandResult } from "../types";
import { CommandHelp, ShellCommand } from "./base";
import { wgetCommand } from "./unsupported";

export class WgetCommand extends ShellCommand {
    get help(): CommandHelp {
        return {
            name: 'wget',
            description: 'Download files from the web',
            usage: 'wget [options] URL\n' +
                'Options:\n' +
                '  -O <file>  Save to a specific file ("-" for stdout)\n' +
                '  -q         Quiet mode\n' +
                '  --version  Print the version',
            examples: [
                'wget https://example.com/file.txt',
                'wget -O custom.txt https://example.com/file.txt',
                'wget -q -O - https://api.com/data'
            ]
        };
    }

    /**
     * `wgetCommand` in ./unsupported makes the request and writes the bytes; this class is the
     * asynchronous command the shell's registry reaches, and adds only the path resolution and the
     * file write. An earlier version fell back to public CORS proxies, which relayed the request --
     * and whatever it carried -- to a third party the caller never named; nothing here does that.
     */
    async execute(args: string[]): Promise<ShellCommandResult> {
        return await wgetCommand(args, {
            resolve: (path: string) => this.resolvePath(path),
            writeBytes: (path: string, bytes: Uint8Array) => this.fileSystem.writeBytes(path, bytes)
        });
    }
}
