import { ShellCommandResult } from "../types";
import { CommandHelp, ShellCommand } from "./base";
import { curlCommand } from "./unsupported";

export class CurlCommand extends ShellCommand {
    get help(): CommandHelp {
        return {
            name: 'curl',
            description: 'Transfer data from or to a server',
            usage: 'curl [options] URL\n' +
                'Options:\n' +
                '  -X <method>  HTTP method\n' +
                '  -H <header>  Custom header\n' +
                '  -d <data>    Request body\n' +
                '  -o <file>    Output to file ("-" for stdout)\n' +
                '  -i           Include the response head\n' +
                '  -I           Head only\n' +
                '  -s -S        Silent / show errors\n' +
                '  --version    Print the version',
            examples: [
                'curl https://api.example.com',
                'curl -X POST -H "Content-Type: application/json" https://api.com',
                'curl -o output.json https://api.com/data'
            ]
        };
    }

    /**
     * The request, its options and every status it reports are `curlCommand` in ./unsupported: this
     * class is the asynchronous command the shell's registry reaches, and all it adds is the two
     * things that utility needs of the container -- a path resolved against the working directory,
     * and a file written as bytes.
     */
    async execute(args: string[]): Promise<ShellCommandResult> {
        return await curlCommand(args, {
            resolve: (path: string) => this.resolvePath(path),
            writeBytes: (path: string, bytes: Uint8Array) => this.fileSystem.writeBytes(path, bytes)
        });
    }
}
