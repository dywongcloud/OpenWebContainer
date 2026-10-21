import { SpawnPayload, WorkerMessage, WorkerRequestMessage, WorkerResponse, WorkerResponseMessage } from 'worker-code';
import { OpenWebContainer } from './container';
import { Process, ProcessEvent } from './process';

let container: OpenWebContainer;
const processOutputs = new Map<number, string[]>();
const MAX_OUTPUT_BUFFER = 1000; // Maximum lines to keep in buffer


self.onmessage = async function (e: MessageEvent<WorkerMessage>) {
    const { type, id } = e.data;

    switch (type) {
        case 'initialize':
            let { payload } = e.data;
            // Initialize container when worker starts
            container = new OpenWebContainer({ debug: payload.debug,
                onServerListen:(port)=>{
                    sendWorkerResponse({ type: 'onServerListen', id, payload:{port} });
                },
                onServerClose:(port)=>{
                    sendWorkerResponse({ type: 'onServerClose', id, payload:{port} });
                }
             });
            // Send back confirmation
            sendWorkerResponse({ type: 'initialized', id });
            break;
        case 'spawn':
            try {
                let payload: SpawnPayload = e.data.payload;

                const process = await container.spawn(payload.command, payload.args, payload.parentPid, {
                    env: payload.options.env,
                    cwd: payload.options.cwd
                });

                // Set up process event handlers
                setupProcessHandlers(process);

                sendWorkerResponse({
                    type: 'spawned',
                    id,
                    payload: { pid: process.pid }
                });
            } catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
            break;

        case 'writeInput':
            try {
                const { payload } = e.data;
                const { pid, input } = payload;
                const process = container.getProcess(pid);
                if (process) {
                    process.writeInput(input);
                    sendWorkerResponse({ type: 'inputWritten', id });
                } else {
                    throw new Error(`Process ${pid} not found`);
                }
            } catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
            break;

        case 'terminate':
            try {
                const { payload } = e.data;
                const { pid } = payload;
                const process = container.getProcess(pid);
                if (process) {
                    await process.terminate();
                    processOutputs.delete(pid);
                    sendWorkerResponse({ type: 'terminated', id, payload: { pid, exitCode: 0 } });
                }
            } catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
            break;

        case 'getStats':
            try {
                const stats = {
                    network: container.getNetworkStats(),
                    processes: container.listProcesses().map(p => ({
                        pid: p.pid,
                        type: p.type,
                        state: p.state,
                        uptime: p.uptime
                    }))
                };
                sendWorkerResponse({ type: 'stats', id, payload: stats });
            }
            catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
            break;

        case 'dispose':
            try {
                await container.dispose();
                sendWorkerResponse({ type: 'disposed', id });
            }
            catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
            break;

        case 'writeFile':
            try {
                const { path, content } = e.data.payload;
                await container.writeFile(path, content);
                sendWorkerResponse({
                    type: 'fileWritten',
                    id,
                });
            }
            catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
            break;
        case 'readFile':
            try {
                const {  path } = e.data.payload;
                const content = await container.readFile(path);
                sendWorkerResponse({
                    type: 'fileRead',
                    id,
                    payload: { content: content ||'' }
                });
            }
            catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
            break;
        case 'deleteFile':
            try {
                const { path, recursive } = e.data.payload;
                await container.deleteFile(path);
                sendWorkerResponse({
                    type: 'fileDeleted',
                    id,
                });
            }
            catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
            break;
        case 'listFiles':
            try {
                const { path } = e.data.payload;
                const files = await container.listFilesPaced(path);
                sendWorkerResponse({
                    type: 'fileList',
                    id,
                    payload: { files }
                });
            }
            catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
            break;
        case 'createDirectory':
            try {
                const {  path } = e.data.payload;
                await container.createDirectory(path);
                sendWorkerResponse({
                    type: 'directoryCreated',
                    id,
                });
            }
            catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
            break;
        case 'listDirectory':
            try {
                const {  path } = e.data.payload;
                const files = await container.listDirectory(path);
                sendWorkerResponse({
                    type: 'directoryList',
                    id,
                    payload: { directories: files }
                });
            }
            catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
            break;
        case 'deleteDirectory':
            try {
                const { path } = e.data.payload;
                await container.deleteDirectory(path);
                sendWorkerResponse({
                    type: 'directoryDeleted',
                    id,
                });
            }
            catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
            break;
        
        case 'listServers':
            try {
                const servers = container.listServers();
                sendWorkerResponse({
                    type: 'serverList',
                    id,
                    payload: {ports:servers.map(s=>s.port) }
                });
            }
            catch (error: any) {
                sendWorkerResponse({
                    type: 'error',
                    id,
                    payload: { error: error.message }
                });
            }
        break;
        case 'httpRequest':
            const { request, port } = e.data.payload;
            const { id:reqId,method, url, headers, body,path } = request;
            try {
                const response = await container.handleHttpRequest({
                    hostname:'localhost',
                    port,
                    path,
                    url,
                    method,
                    headers,
                    body,
                },port);
                sendWorkerResponse({
                    type: 'httpResponse',
                    id,
                    payload: {
                        response: {
                            id: reqId,
                            status: response.status,
                            statusText: response.statusText,
                            headers: Object.fromEntries((response.headers as any).entries()),
                            body: await response.text()
                        },
                        port
                    }
                });
            }
            catch (error: any) {
                sendWorkerResponse({
                    type: 'networkError',
                    id,
                    payload: { port, response:{
                        id: reqId, error: error.message
                    } }
                });
            }
            break;
    }
};

function sendWorkerResponse(response: WorkerResponse) {
    self.postMessage(response);
}

function setupProcessHandlers(process: Process) {
    // Initialize output buffer for this process
    processOutputs.set(process.pid, []);

    process.addEventListener(ProcessEvent.MESSAGE, (data) => {
        // Store output
        const outputs = processOutputs.get(process.pid) || [];
        if (data.stdout) outputs.push(data.stdout);
        if (data.stderr) outputs.push(data.stderr);

        // Trim buffer if too large
        if (outputs.length > MAX_OUTPUT_BUFFER) {
            outputs.splice(0, outputs.length - MAX_OUTPUT_BUFFER);
        }

        processOutputs.set(process.pid, outputs);

        if (!!data.stderr) {
            sendWorkerResponse({
                type: 'processError',
                payload: {
                    pid: process.pid,
                    error: data.stderr
                }
            });
        }
        else {
            // Send output to main thread
            sendWorkerResponse({
                type: 'processOutput',
                payload: {
                    pid: process.pid,
                    output: data.stdout || data.stderr||"",
                    isError: !!data.stderr
                }
            });
        }
    });

    process.addEventListener(ProcessEvent.EXIT, (data) => {
        sendWorkerResponse({
            type: 'processExit',
            payload: {
                pid: process.pid,
                exitCode: data.exitCode||0
            }
        });
    });
}
