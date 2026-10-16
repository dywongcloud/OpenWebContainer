import { IFileSystem } from '../filesystem';
import JSZip from 'jszip';
import { IShell, ShellCommandResult, CommandParsedResult } from './types';
import { CommandRegistry } from './commands/registry';
import { CurlCommand } from './commands/curl';
import { UnzipCommand } from './commands/unzip';
import { WgetCommand } from './commands/wget';
import { Process } from '../process';
interface ShellOptions {
    oscMode?: boolean;
    process: Process;
    env?: Map<string, string>;
    /** The directory the shell starts in: the cwd of the process it runs in. */
    cwd?: string;
}


export class Shell implements IShell {
    private fileSystem: IFileSystem;
    private currentDirectory: string;
    private env: Map<string, string>;
    private commandHistory: string[] = [];
    private historyIndex: number = -1;
    private oscMode: boolean = false;
    private buildInCommands: Map<string, (args: string[]) => Promise<ShellCommandResult>> = new Map();
    private commandRegistry: CommandRegistry;
    private process: Process;

    constructor(fileSystem: IFileSystem, options: ShellOptions) {
        this.fileSystem = fileSystem;
        this.currentDirectory = options.cwd || '/';
        this.env = options.env || new Map([
            ['PATH', '/bin:/usr/bin'],
            ['HOME', '/home'],
            ['PWD', this.currentDirectory],
        ]);
        this.process = options.process;
        this.oscMode = options.oscMode || false;
        this.commandRegistry = new CommandRegistry();
        this.registerAllBuiltInCommands()
        this.registerAllExternalCommands();
    }
    private registerBuiltInCommand(name: string, command: (args: string[]) => Promise<ShellCommandResult>) {
        this.buildInCommands.set(name, command);
    }
    private registerExternalCommand(name: string, commandClass: any) {
        this.commandRegistry.register(name, commandClass);
    }
    private registerAllBuiltInCommands() {
        this.registerBuiltInCommand('cd', this.cd.bind(this));
        this.registerBuiltInCommand('ls', this.ls.bind(this));
        this.registerBuiltInCommand('pwd', this.pwd.bind(this));
        this.registerBuiltInCommand('cat', this.cat.bind(this));
        this.registerBuiltInCommand('echo', this.echo.bind(this));
        this.registerBuiltInCommand('mkdir', this.mkdir.bind(this));
        this.registerBuiltInCommand('rm', this.rm.bind(this));
        this.registerBuiltInCommand('rmdir', this.rmdir.bind(this));
        this.registerBuiltInCommand('touch', this.touch.bind(this));
    }
    private registerAllExternalCommands() {
        this.registerExternalCommand('curl', CurlCommand);
        this.registerExternalCommand('unzip', UnzipCommand);
        this.registerExternalCommand('wget', WgetCommand);
    }

    private formatOscOutput(type: string, content: string): string {
        if (!this.oscMode) return content;

        switch (type) {
            case 'file':
                return `\x1b[34m${content}\x1b[0m`;
            case 'directory':
                return `\x1b[1;34m${content}/\x1b[0m`;
            case 'executable':
                return `\x1b[32m${content}*\x1b[0m`;
            case 'error':
                return `\x1b[31m${content}\x1b[0m`;
            case 'success':
                return `\x1b[32m${content}\x1b[0m`;
            case 'info':
                return `\x1b[90m${content}\x1b[0m`;
            case 'warning':
                return `\x1b[33m${content}\x1b[0m`;
            case 'path':
                return `\x1b[36m${content}\x1b[0m`;
            case 'command':
                return `\x1b[1;35m${content}\x1b[0m`;
            default:
                return content;
        }
    }

    private getFileType(path: string): string {
        try {
            if (this.fileSystem.isDirectory(path)) {
                return 'directory';
            }
            if (path.endsWith('.js')) {
                return 'executable';
            }
            return 'file';
        } catch {
            return 'file';
        }
    }

    private success(stdout: string = '', type: string = 'success'): ShellCommandResult {
        return {
            stdout: this.oscMode ? this.formatOscOutput(type, stdout) : stdout,
            stderr: '',
            exitCode: 0
        };
    }

    private failure(stderr: string): ShellCommandResult {
        return {
            stdout: '',
            stderr: this.oscMode ? this.formatOscOutput('error', stderr) : stderr,
            exitCode: 1
        };
    }

    private formatCommandOutput(command: string, output: string): string {
        if (!this.oscMode) return output;

        // Format specific command outputs
        switch (command) {
            case 'ls':
                return output.split('\n').map(entry => {
                    if (!entry.trim()) return entry;
                    const type = this.getFileType(this.resolvePath(entry));
                    return this.formatOscOutput(type, entry);
                }).join('\n');

            case 'pwd':
                return this.formatOscOutput('path', output);

            case 'echo':
                return this.formatOscOutput('info', output);

            case 'cat':
                // Attempt to detect and color code content
                if (output.startsWith('{') || output.startsWith('[')) {
                    try {
                        JSON.parse(output);
                        return this.formatOscOutput('info', output);
                    } catch { }
                }
                return output;

            case 'mkdir':
            case 'touch':
            case 'rm':
            case 'rmdir':
            case 'cp':
            case 'mv':
                return this.formatOscOutput('success', output);

            default:
                return output;
        }
    }

    // Add these new methods for history management
    getNextCommand(): string {
        if (this.historyIndex < this.commandHistory.length - 1) {
            this.historyIndex++;
            return this.commandHistory[this.historyIndex];
        }
        this.historyIndex = this.commandHistory.length;
        return '';
    }

    getPreviousCommand(): string {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            return this.commandHistory[this.historyIndex];
        } else if (this.historyIndex === 0) {
            return this.commandHistory[0];
        }
        return '';
    }

    getCurrentHistoryIndex(): number {
        return this.historyIndex;
    }

    getHistoryLength(): number {
        return this.commandHistory.length;
    }
    getWorkingDirectory(): string {
        return this.currentDirectory;
    }

    setWorkingDirectory(path: string): void {
        const resolvedPath = this.resolvePath(path);
        if (!this.fileSystem.isDirectory(resolvedPath)) {
            throw new Error(`Directory not found: ${path}`);
        }
        this.currentDirectory = resolvedPath;
        this.env.set('PWD', resolvedPath);
    }
    hasCommand(command: string): boolean {
        return this.buildInCommands.has(command)||this.commandRegistry.has(command);
    }

    private resolvePath(path: string): string {
        if (path.startsWith('/')) {
            return path;
        }
        return `${this.currentDirectory}/${path}`.replace(/\/+/g, '/');
    }

    private parseCommand(args: string[]): CommandParsedResult {
        const result: CommandParsedResult = {
            command: '',
            args: [],
            redirects: []
        };

        let i = 0;
        while (i < args.length) {
            const arg = args[i];

            if (arg === '>' || arg === '>>') {
                if (i + 1 >= args.length) {
                    throw new Error(`Syntax error: missing file for redirection ${arg}`);
                }
                result.redirects.push({
                    type: arg as ('>' | '>>'),
                    file: args[i + 1]
                });
                i += 2;
            } else {
                if (!result.command) {
                    result.command = arg;
                } else {
                    result.args.push(arg);
                }
                i++;
            }
        }

        return result;
    }

    private handleRedirection(output: string, redirects: CommandParsedResult['redirects']): void {
        for (const redirect of redirects) {
            const filePath = this.resolvePath(redirect.file);

            try {
                if (redirect.type === '>>') {
                    // Append to file
                    const existingContent = this.fileSystem.readFile(filePath) || '';
                    this.fileSystem.writeFile(filePath, existingContent + output);
                } else {
                    // Overwrite file
                    this.fileSystem.writeFile(filePath, output);
                }
            } catch (error: any) {
                throw new Error(`Failed to redirect to ${redirect.file}: ${error.message}`);
            }
        }
    }

    // Modified execute method to include history
    async execute(command: string, args: string[]): Promise<ShellCommandResult> {
        try {
            if (!command) {
                return this.success();
            }
            this.commandHistory.push(command);

            // Parse command and redirections
            const parsedCommand = this.parseCommand([command, ...args]);

            // Execute the actual command
            const result = await this.executeCommand(
                parsedCommand.command,
                parsedCommand.args
            );


            // Handle redirections
            if (result.exitCode === 0 && parsedCommand.redirects.length > 0) {
                try {
                    this.handleRedirection(result.stdout, parsedCommand.redirects);
                    result.stdout = '';
                } catch (error: any) {
                    let ret = {
                        stdout: '',
                        stderr: error.message,
                        exitCode: 1
                    };
                    if (this.oscMode && ret.stderr) {
                        ret.stderr = this.formatOscOutput('error', ret.stderr);
                    }
                    return ret;
                }
            }

            // Format output
            if (result.exitCode === 0 && result.stdout) {
                result.stdout = this.formatCommandOutput(command, result.stdout);
            }
            if (this.oscMode && result.stderr) {
                result.stderr = this.formatOscOutput('error', result.stderr);
            }

            return result;
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async executeBuiltin(command: string, args: string[]): Promise<ShellCommandResult> {
        switch (command) {
            case 'ls':
                return this.ls(args);
            case 'mkdir':
                return this.mkdir(args);
            case 'rm':
                return this.rm(args);
            case 'rmdir':
                return this.rmdir(args);
            case 'touch':
                return this.touch(args);
            case 'pwd':
                return this.pwd();
            case 'cd':
                return this.cd(args);
            case 'echo':
                return this.echo(args);
            case 'cat':
                return this.cat(args);
            case 'cp':
                return this.cp(args);
            case 'mv':
                return this.mv(args);
            // case 'env':
            //     return this.env_(args);
            default:
                return {
                    stdout: '',
                    stderr: `Command not found: ${command}`,
                    exitCode: 127
                };
        }
    }

    // Built-in command implementations
    private async ls(args: string[]): Promise<ShellCommandResult> {
        try {
            const path = args[0] || this.currentDirectory;
            const resolvedPath = this.resolvePath(path);
            const entries = this.fileSystem.listDirectory(resolvedPath);
            console.log(entries);

            return this.success(entries.join('\n'));
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async cat(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No file specified');
        }
        try {
            const content = this.fileSystem.readFile(this.resolvePath(args[0]));
            if (content === undefined) {
                return this.failure(`File not found: ${args[0]}`);
            }
            return this.success(content);
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async mkdir(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No directory specified');
        }
        try {
            this.fileSystem.createDirectory(this.resolvePath(args[0]));
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async rm(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No file specified');
        }
        try {
            const recursive = args.includes('-r') || args.includes('-rf');
            const files = args.filter(arg => !arg.startsWith('-'));

            for (const file of files) {
                this.fileSystem.deleteFile(this.resolvePath(file), recursive);
            }
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async rmdir(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No directory specified');
        }
        try {
            this.fileSystem.deleteDirectory(this.resolvePath(args[0]));
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async touch(args: string[]): Promise<ShellCommandResult> {
        if (args.length === 0) {
            return this.failure('No file specified');
        }
        try {
            this.fileSystem.writeFile(this.resolvePath(args[0]), '');
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async pwd(): Promise<ShellCommandResult> {
        return this.success(this.currentDirectory);
    }

    private async cd(args: string[]): Promise<ShellCommandResult> {
        try {
            const path = args[0] || '/';
            const newPath = this.resolvePath(path);
            if (!this.fileSystem.isDirectory(newPath)) {
                return this.failure(`Directory not found: ${path}`);
            }
            this.currentDirectory = newPath;
            this.env.set('PWD', newPath);
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async echo(args: string[]): Promise<ShellCommandResult> {
        return this.success(args.join(' ') + '\n');
    }

    private async cp(args: string[]): Promise<ShellCommandResult> {
        if (args.length < 2) {
            return this.failure('Source and destination required');
        }
        try {
            const [src, dest] = args;
            const content = this.fileSystem.readFile(this.resolvePath(src));
            if (content === undefined) {
                return this.failure(`Source file not found: ${src}`);
            }
            this.fileSystem.writeFile(this.resolvePath(dest), content);
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async mv(args: string[]): Promise<ShellCommandResult> {
        if (args.length < 2) {
            return this.failure('Source and destination required');
        }
        try {
            const [src, dest] = args;
            const content = this.fileSystem.readFile(this.resolvePath(src));
            if (content === undefined) {
                return this.failure(`Source file not found: ${src}`);
            }
            this.fileSystem.writeFile(this.resolvePath(dest), content);
            this.fileSystem.deleteFile(this.resolvePath(src));
            return this.success();
        } catch (error: any) {
            return this.failure(error.message);
        }
    }

    private async executeCommand(command: string, args: string[]): Promise<ShellCommandResult> {
        // // Handle node command specially
        // if (command === 'node') {
        //     if (args.length === 0) {
        //         return this.failure('No JavaScript file specified');
        //     }
        //     // return this.executeJavaScriptProcess(args[0], args.slice(1));
        // }
        // check if the command is a built-in command
        if (this.buildInCommands.has(command)) {
            return this.buildInCommands.get(command)!(args);
        }
        if (this.commandRegistry.has(command)) {
            let commandClass =this.commandRegistry.get(command)!
            let commandObject = new commandClass({ 
                cwd: this.currentDirectory, 
                fileSystem: this.fileSystem, 
                env: this.env,
                process: this.process
             });
            return commandObject.execute(args);
        }
        // // check if the command is in env PATH
        // let PATH= this.env.get('PATH');
        // if (PATH) {
        //     const paths = PATH.split(':');
        //     for (const path of paths) {
        //         const executablePath = this.fileSystem.resolvePath(command,path);
        //         if (this.fileSystem.fileExists(executablePath)) {
        //             return new Promise((resolve) => {
        //                 this.emit(ProcessEvent.SPAWN_CHILD, {
        //                     payload: {
        //                         executable: interpreterName,
        //                         args,
        //                         cwd: this.cwd
        //                     },
        //                     callback: resolve
        //                 });
        //             });
        //         }
        //     }
        // }
        // // check for shebang


        // Handle built-in commands as before
        return this.executeBuiltin(command, args);
    }
}
