import { ChildProcessPayload, ChildProcessResult, Process, ProcessEvent, ProcessExecutor, ProcessInfo, ProcessRegistry, ProcessState, ProcessTree, SpawnChildEventData } from "./process";
import { VirtualFileSystem } from "./filesystem/virtual-fs";
import { ProcessManager } from "./process/manager";
import { NodeProcessExecutor } from "./process/executors/node";
import { ShellProcessExecutor } from "./process/executors/shell";
import { NpmProcessExecutor } from "./process/executors/npm/executor";
import { NodeProcess } from "./process/executors/node/process";
import { RuntimeServices } from "./process/executors/node/runtime/services";
import { VirtualNetwork } from "./network/virtual/hub";
import { IFileSystem } from "./filesystem";
import { ZenFSCore } from "./filesystem/zenfs-core";
import { NetworkManager } from "./network/manager";
import { ServerType, VirtualServer } from "./network/types";
import { NetworkStats } from "./network/types";
import { HostRequest } from "process/executors/node/modules/network-module";
import { setProcessHost } from "./shell/commands/procinfo";


interface ProcessEventData {
    stdout?: string;
    stderr?: string;
    error?: Error;
    pid?: number;
    exitCode?: number;
}

export interface ContainerOptions {
    debug?: boolean;
    onServerListen?: (port: number) => void;
    onServerClose?: (port: number) => void;
    /**
     * Milliseconds of guest execution with no host call in it before the guest is stopped as a
     * runaway, with the `vm` timeout error Node reports. 0 leaves a runaway loop unstoppable, which
     * is what hangs a browser tab; the default is 30000.
     */
    guestBudgetMs?: number;
}

export interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string>;
    /** The pid the process takes, already taken from the manager; the next pid when it is left out. */
    pid?: number;
    /** Runs synchronously before the process starts, so listeners see every event. */
    beforeStart?: (process: Process) => void;
}

/** How much host time one slice of a paced walk takes before the thread is handed back. */
const PACE_SLICE_MS = 4;

/**
 * Main OpenWebContainer class
 */
export class OpenWebContainer {
    private fileSystem: IFileSystem;
    private processManager: ProcessManager;
    private processRegistry: ProcessRegistry;
    private outputCallbacks: ((output: string) => void)[] = [];
    readonly networkManager: NetworkManager;
    private services: RuntimeServices;
    private debugMode: boolean;
    constructor(options: ContainerOptions = {}) {
        this.debugMode = options.debug || false;
        this.fileSystem = new ZenFSCore();
        this.processManager = new ProcessManager();
        this.processRegistry = new ProcessRegistry();
        const network = new VirtualNetwork({ sinkFor: (pid) => this.guestSink(pid) });
        this.networkManager = new NetworkManager({
            network,
            getProcess: (pid: number) => this.processManager.getProcess(pid),
            onServerListen:(port)=>{
                if (options.onServerListen) {
                    options.onServerListen(port);
                }
            },
            onServerClose:(port)=>{
                if (options.onServerClose) {
                    options.onServerClose(port);
                }
            }
        });

        this.services = {
            network,
            startProcess: (request) => this.spawn(request.executable, request.args, request.parentPid, {
                cwd: request.cwd,
                env: request.env,
                pid: request.pid,
                beforeStart: request.beforeStart
            }),
            sinkFor: (pid) => this.guestSink(pid),
            reservePid: () => this.processManager.getNextPid(),
            guestBudgetMs: options.guestBudgetMs
        };

        // Register default process executors
        this.processRegistry.registerExecutor(
            'javascript',
            new NodeProcessExecutor(this.fileSystem, this.networkManager, this.services)
        );
        this.processRegistry.registerExecutor(
            'shell',
            /* the shell's `ifconfig` and anything else that lists the network reads the hub live, at
               the moment the command runs, through this handle */
            new ShellProcessExecutor(this.fileSystem, () => network.hubState())
        );
        this.processRegistry.registerExecutor(
            'npm',
            new NpmProcessExecutor(this.fileSystem)
        );
        this.installProcessHost();
        this.debugLog('Container initialized');
    }

    /**
     * The shell's process commands (`ps`, `top`, `kill`, `killall`, `pkill`, `watch`, `time`) read
     * the container's one live process table through this host; it is installed once per container
     * and nothing else uses it. `run` is left off: the host has no way to run a command line and
     * wait for it synchronously, so `nice`, `nohup`, `time` and `watch` report that themselves.
     */
    private installProcessHost(): void {
        setProcessHost({
            list: () =>
                this.listProcesses().map((process) => {
                    const info = this.getProcessInfo(process);
                    return {
                        pid: info.pid,
                        ppid: info.ppid ?? 0,
                        command: [info.executablePath, ...info.args].join(' '),
                        state: info.state
                    };
                }),
            signal: (pid, name) => {
                const process = this.getProcess(pid);
                if (!process) return false;
                // There is no job control in the container: every signal this shell can deliver ends
                // the process, and the ones that only stop or continue it have nothing to act on.
                if (!/^(TERM|KILL|INT|HUP|QUIT|USR1|USR2|ALRM|15|9|2|1|3|10|12|14)$/.test(name)) return false;
                void process.terminate();
                return true;
            },
            now: () => Date.now()
        });
    }
    private debugLog(...args: any[]): void {
        if (this.debugMode) {
            console.log('[Container]', ...args);
        }
    }

    /**
     * Network Operations
     */
    async handleHttpRequest(request: HostRequest, port: number): Promise<Response> {
        this.debugLog(`HTTP Request: ${request.method} ${request.url} (Port: ${port})`);
        try {
            const response = await this.networkManager.handleRequest(request, port);
            this.debugLog(`HTTP Response: ${response.status} ${response.statusText}`);
            return response;
        } catch (error) {
            this.debugLog(`HTTP Error:`, error);
            return new Response(
                error instanceof Error ? error.message : 'Internal Server Error',
                { status: 500 }
            );
        }
    }

    registerServer(pid: number, port: number, type: ServerType, options: VirtualServer['options'] = {}): string {
        this.debugLog(`Registering ${type} server on port ${port} for process ${pid}`);
        return this.networkManager.registerServer(pid, port, type, options);
    }

    unregisterServer(port: number, type: ServerType): void {
        this.debugLog(`Unregistering server ${type}:${port}`);
        this.networkManager.unregisterServer(port, type);
    }

    getNetworkStats(): NetworkStats {
        return this.networkManager.getNetworkStats();
    }

    listServers(): VirtualServer[] {
        return this.networkManager.listServers();
    }
    


    /**
     * File system operations
     */
    /**
     * Writes a file. A string is stored as UTF-8 text, the way this always stored it; a Uint8Array
     * (a Buffer is one) is stored as its bytes. The text form is lossy on anything that is not
     * text: binary decoded as UTF-8 comes back with U+FFFD wherever a byte was not valid UTF-8, and
     * encoding it again makes it larger -- a 684897-byte sql-wasm.wasm written this way is read
     * back 765555 bytes long, which WebAssembly rejects because its Type section now runs past the
     * end of the module.
     */
    writeFile(path: string, content: string | Uint8Array): void {
        if (typeof content === 'string') {
            this.fileSystem.writeFile(path, content);
            return;
        }
        this.fileSystem.writeBytes(path, content);
    }

    readFile(path: string): string | undefined {
        return this.fileSystem.readFile(path);
    }

    /** Reads a file back as bytes, which is what a file written as bytes has to be checked against. */
    readFileBytes(path: string): Uint8Array | undefined {
        return this.fileSystem.readBytes(path);
    }

    deleteFile(path: string): void {
        this.fileSystem.deleteFile(path);
    }

    listFiles(basePath: string = '/'): string[] {
        return this.fileSystem.listFiles(basePath);
    }

    /**
     * Every file under `basePath`, walked in slices that hand the thread back between them.
     *
     * This container runs on one thread -- a worker's, in a browser -- and that same thread is
     * the one a foreground child is using while it runs. A whole-tree walk of an installed
     * node_modules costs seconds of host time, and taking them in one synchronous pass leaves
     * the child nothing: it is what stopped `npx create-next-app` typed in the playground
     * terminal from ever reaching its prompt, because the file explorer asks for the whole tree
     * every second, so from the moment the install had written a few thousand files the walks
     * never stopped and the install got no thread time at all. Slicing the walk lets the child
     * run in the gaps, however large the tree is.
     */
    async listFilesPaced(basePath: string = '/'): Promise<string[]> {
        const root = basePath === '/' ? '/' : basePath.replace(/\/+$/, '') || '/';
        const files: string[] = [];
        const directories: string[] = [root];
        let entries: string[] = [];
        let directory = root;
        for (;;) {
            const sliceEnds = Date.now() + PACE_SLICE_MS;
            do {
                if (entries.length === 0) {
                    if (directories.length === 0) return files;
                    directory = directories.pop() as string;
                    try {
                        entries = this.fileSystem.listDirectory(directory);
                    } catch {
                        entries = [];
                    }
                    continue;
                }
                const name = entries.pop() as string;
                const path = directory === '/' ? `/${name}` : `${directory}/${name}`;
                if (this.fileSystem.isDirectory(path)) directories.push(path);
                else files.push(path);
            } while (Date.now() < sliceEnds);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
    }

    createDirectory(path: string): void {
        this.fileSystem.createDirectory(path);
    }

    deleteDirectory(path: string): void {
        this.fileSystem.deleteDirectory(path);
    }

    listDirectory(path: string): string[] {
        return this.fileSystem.listDirectory(path);
    }

    /**
     * Process operations
     */
    /**
     * How a file with no executor of its own runs: through the interpreter its shebang names, with the
     * file as that interpreter's first argument -- `#!/usr/bin/env node` runs `node <file> <args>`, the
     * way the kernel runs it. A `node_modules/.bin` shim is such a file: a node script with no .js
     * name, so no executor claims it and a spawn of it reported ENOENT. Undefined when the name has an
     * executor already, is not a file, or names an interpreter the container cannot run.
     */
    private shebangInvocation(executable: string, args: string[], cwd: string): { executable: string; args: string[] } | undefined {
        if (this.processRegistry.findExecutor(executable) !== undefined) return undefined;
        const path = executable.startsWith('/')
            ? this.fileSystem.normalizePath(executable)
            : this.fileSystem.normalizePath(`${cwd.replace(/\/+$/, '')}/${executable}`);
        let content: string | undefined;
        try {
            content = this.fileSystem.readFile(path);
        } catch {
            return undefined;
        }
        if (content === undefined) return undefined;
        const match = /^#!([^\n]*)/.exec(content);
        if (match === null) return undefined;
        const tokens = match[1].trim().split(/\s+/).filter((token) => token !== '');
        if (tokens.length === 0) return undefined;
        const interpreter = tokens[0] === 'env' || tokens[0].endsWith('/env')
            ? tokens.slice(1).find((token) => !token.startsWith('-'))
            : tokens[0].split('/').pop();
        if (interpreter === undefined || interpreter === '') return undefined;
        if (this.processRegistry.findExecutor(interpreter) === undefined) return undefined;
        return { executable: interpreter, args: [path, ...args] };
    }

    async spawn(executablePath: string, args: string[] = [], parentPid?: number,options: SpawnOptions = {}): Promise<Process> {
        const cwd = options.cwd || '/';
        /* A file with no executor of its own -- a node_modules/.bin shim is one, a `node` script with
           no .js name -- runs through the interpreter its shebang names, the way the kernel runs it. */
        const shebang = this.shebangInvocation(executablePath, args, cwd);
        const executable = shebang?.executable ?? executablePath;
        const argv = shebang?.args ?? args;
        const executor = this.processRegistry.findExecutor(executable);
        if (!executor) {
            throw new Error(`No executor found for: ${executablePath}`);
        }

        const pid = options.pid ?? this.processManager.getNextPid();
        const process = await executor.execute({
            executable,
            args: argv,
            cwd,
            env: options.env || {}
        }, pid, parentPid);

        // Set up general process handlers
        this.setupProcessEventHandlers(process);

        // Set up child process spawning for all processes
        this.setupChildProcessSpawning(process);

        // Add process to manager and start it
        this.processManager.addProcess(process);
        options.beforeStart?.(process);
        process.start().catch(console.error);
        
        return process;
    }
    
    private setupProcessEventHandlers(process: Process): void {
        // A child's output and errors are forwarded to its parent, which reports them; only root processes notify
        process.addEventListener(ProcessEvent.MESSAGE, (data: ProcessEventData) => {
            if (process.parentPid !== undefined) return;
            if (data.stdout) {
                this.notifyOutput(data.stdout);
            }
            if (data.stderr) {
                this.notifyOutput(data.stderr);
            }
        });

        process.addEventListener(ProcessEvent.ERROR, (data: ProcessEventData) => {
            if (process.parentPid !== undefined) return;
            if (data.error) {
                this.notifyOutput(`Error: ${data.error.message}\n`);
            }
        });

        process.addEventListener(ProcessEvent.EXIT, (data) => {
            if (process.parentPid !== undefined) return;
            if (data.exitCode) {
                this.notifyOutput(`Process exited with code: ${data.exitCode}\n`);
            }
        });
        
    }
    /** The running guest process behind a pid, as a delivery sink for the virtual network. */
    private guestSink(pid: number): NodeProcess | undefined {
        const process = this.processManager.getProcess(pid);
        return process instanceof NodeProcess ? process : undefined;
    }

    registerProcessExecutor(type: string, executor: ProcessExecutor): void {
        this.processRegistry.registerExecutor(type, executor);
    }
    
    /**
     * Register an output callback
     */
    onOutput(callback: (output: string) => void): () => void {
        this.outputCallbacks.push(callback);
        return () => {
            this.outputCallbacks = this.outputCallbacks.filter(cb => cb !== callback);
        };
    }

    private notifyOutput(output: string): void {
        this.outputCallbacks.forEach(callback => callback(output));
    }

    getProcess(pid: number): Process | undefined {
        return this.processManager.getProcess(pid);
    }

    listProcesses(): Process[] {
        return this.processManager.listProcesses();
    }

    /**
     * Get information about a process
     */
    getProcessInfo(process: Process): ProcessInfo {
        const stats = process.getStats();
        return {
            pid: stats.pid,
            ppid: stats.ppid,
            type: stats.type,
            state: stats.state,
            executablePath: stats.executablePath,
            args: stats.args,
            startTime: stats.startTime,
            endTime: stats.endTime,
            uptime: process.uptime ?? undefined
        };
    }
    // Add method to get child processes
    getChildProcesses(parentPid: number): Process[] {
        return this.processManager.listProcesses()
            .filter(process => process.parentPid === parentPid);
    }

    /**
     * Get process tree for a given process
     */
    getProcessTree(pid: number): ProcessTree {
        const process = this.processManager.getProcess(pid);
        if (!process) {
            throw new Error(`Process ${pid} not found`);
        }

        return {
            info: this.getProcessInfo(process),
            children: this.getChildProcesses(pid)
                .map(child => this.getProcessTree(child.pid))
        };
    }

    /**
     * Get full process tree starting from init process
     */
    getFullProcessTree(): ProcessTree[] {
        // Get all top-level processes (those without parent)
        const topLevelProcesses = this.processManager.listProcesses()
            .filter(process => !process.parentPid);

        return topLevelProcesses.map(process => this.getProcessTree(process.pid));
    }

    /**
     * Print process tree (useful for debugging)
     */
    printProcessTree(tree: ProcessTree, indent: string = ''): string {
        const { info } = tree;
        let output = `${indent}${info.pid} ${info.executablePath} (${info.state})`;

        if (info.uptime !== undefined) {
            output += ` - uptime: ${info.uptime}ms`;
        }
        output += '\n';

        for (const child of tree.children) {
            output += this.printProcessTree(child, indent + '  ');
        }

        return output;
    }
    /**
     * Terminate a process and all its children
     */
    async terminateProcessTree(pid: number): Promise<void> {
        const children = this.getChildProcesses(pid);

        // First terminate all children
        await Promise.all(
            children.map(child => this.terminateProcessTree(child.pid))
        );

        // Then terminate the process itself
        const process = this.processManager.getProcess(pid);
        if (process) {
            await process.terminate();
            this.processManager.removeProcess(pid);
        }
    }

    private setupChildProcessSpawning(process: Process): void {
        process.addEventListener(ProcessEvent.SPAWN_CHILD, (data: SpawnChildEventData) => {
            this.spawnChildProcess(process.pid, data.payload, data.callback);
        });
    }
    
    private async spawnChildProcess(
        parentPid: number,
        payload: ChildProcessPayload,
        callback: (result: ChildProcessResult) => void
    ): Promise<void> {

        let childPid:number|null=null
        try {
            const parentProcess = this.processManager.getProcess(parentPid);
            if (!parentProcess) {
                throw new Error(`Parent process ${parentPid} not found`);
            }

           

            let stdout = '';
            let stderr = '';
            /* A parent that runs the child in a pipe of its own takes the output out of the result, so
               writing it to the parent's terminal as well would print it twice: once where the pipe
               puts it and once where the child wrote it. */
            const silent = payload.silent === true;
            const stdin = payload.stdin;

            // Spawn the child process
            const childProcess = await this.spawn(
                payload.executable,
                payload.args,
                parentPid,  // Pass parent PID
                {
                    cwd: payload.cwd,
                    env: payload.env,
                    /* A child can finish its whole line -- a shell running one script -- inside the
                       call that starts it, so its listeners are installed before it starts and not
                       after the await above returns, which would drop everything it wrote. */
                    beforeStart: (child) => {
                        /* What the parent piped in: written once the child can take it, which is after
                           it is running, and followed by end of file, as it is in a shell. */
                        if (stdin !== undefined && stdin !== '') {
                            const pipeStdin = () => {
                                try {
                                    child.writeInput(stdin);
                                    child.endStdin();
                                } catch {
                                    /* a process that reads no input is exactly as it was */
                                }
                            };
                            if (child.state === ProcessState.RUNNING) pipeStdin();
                            else child.addEventListener(ProcessEvent.START, pipeStdin);
                        }

                        // Set up event handlers for the child process
                        child.addEventListener(ProcessEvent.MESSAGE, (data: ProcessEventData) => {
                            if (!silent) parentProcess.emit(ProcessEvent.MESSAGE, { ...data });
                            /* the parent sees the child's output as it arrives; the caller of spawnChild also
                               gets it in the result, so a lifecycle script's failure can be reported with its cause */
                            if (data.stdout) stdout += data.stdout;
                            if (data.stderr) stderr += data.stderr;
                        });

                        child.addEventListener(ProcessEvent.ERROR, (data: ProcessEventData) => {
                            if (data.error) {
                                if (!silent) parentProcess.emit(ProcessEvent.MESSAGE, { stderr: data.error.message + '\n' });
                                stderr += data.error.message + '\n';
                            }
                        });

                        child.addEventListener(ProcessEvent.EXIT, (data) => {
                            callback({
                                stdout,
                                stderr,
                                exitCode: data.exitCode ?? 1
                            });

                            // Clean up the process
                            this.processManager.removeProcess(child.pid);
                        });
                    }
                }
            );
            childPid=childProcess.pid

        } catch (error: any) {
            if (childPid){
                this.processManager.removeProcess(childPid);
            }
            callback({
                stdout: '',
                stderr: error.message,
                exitCode: 1
            });
        }
    }


    /**
     * Container Lifecycle
     */
    async dispose(): Promise<void> {
        this.debugLog('Disposing container');

        // Stop all network servers
        for (const server of this.listServers()) {
            this.networkManager.unregisterServer(server.port, server.type);
        }

        // Kill all processes
        await this.processManager.killAll();

        // Clear output callbacks
        this.outputCallbacks = [];

        // Dispose network manager
        this.networkManager.dispose();

        this.debugLog('Container disposed');
    }
}
