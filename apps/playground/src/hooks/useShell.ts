import { VirtualProcess,ContainerManager, ProcessEvent} from '@open-web-container/api';
import { useState, useEffect, useCallback, useRef } from 'react';
interface UseShellOptions {
    osc?: boolean;
    initialCommands?: string[];
}

export function useShell(container: ContainerManager | null, options: UseShellOptions = {}) {
    const [ready, setReady] = useState(false);
    const [output, setOutput] = useState<string[]>([]);
    const processRef = useRef<VirtualProcess | null>(null);
    const { osc = true, initialCommands = [] } = options;

    // Initialize shell process when container is available
    useEffect(() => {
        if (!container) return;
        const promptTimers: ReturnType<typeof setTimeout>[] = [];

        async function initShell(container: ContainerManager) {
            try {
                const args = osc ? ['--osc'] : [];
                let received = false;

                const process = await container.spawn('sh', args);

                if (!(process instanceof VirtualProcess)) {
                    throw new Error('Failed to create shell process');
                }

                // Store the process reference
                processRef.current = process;

                // Set up process event listeners
                process.on(ProcessEvent.OUTPUT, (data) => {
                    received = true;
                    setOutput((prev: string[]) => [...prev, data.output || '']);
                });

                process.on(ProcessEvent.ERROR, (data) => {
                    if (data.error) setOutput(prev => [...prev, `Error: ${data.error.message}\n`]);
                });

                process.on(ProcessEvent.EXIT, () => {
                    setReady(false);
                    processRef.current = null;
                });

                setReady(true);

                /* The prompt the shell writes as it starts is written inside the container, before
                   the process this page holds exists to receive it, so it never arrives: the pane
                   opened blank -- no banner, no prompt -- and stayed blank until something was
                   typed into it. A bare newline runs nothing and asks the shell for the line it
                   is waiting on, which is what puts its own prompt on screen on load. The line is
                   worth sending more than once: written in the same moment the process is handed
                   back, it can arrive before the shell has reached the read that takes it. */
                for (const delay of [0, 400, 1500]) {
                    const timer = setTimeout(() => {
                        if (received) return;
                        try {
                            process.write('\r');
                        } catch {
                            /* the shell ended before the line reached it */
                        }
                    }, delay);
                    promptTimers.push(timer);
                }

                // Execute initial commands if any
                for (const cmd of initialCommands) {
                    process.write(cmd + '\r');
                }
            } catch (error) {
                console.error('Failed to initialize shell:', error);
                setReady(false);
            }
        }

        initShell(container);

        // Cleanup
        return () => {
            for (const timer of promptTimers) clearTimeout(timer);
            const process = processRef.current;
            if (process) {
                process.kill();
                processRef.current = null;
                setReady(false);
            }
        };
    }, [container]);

    const sendCommand = useCallback(async (input: string) => {
        if (!processRef.current || !ready) {
            throw new Error('Shell is not ready');
        }

        try {
            processRef.current.write(input);
        } catch (error) {
            console.error('Failed to send command:', error);
            throw error;
        }
    }, [ready]);

    const clearOutput = useCallback(() => {
        setOutput([]);
    }, []);

    return {
        ready,
        output,
        sendCommand,
        clearOutput,
        shell: processRef.current
    };
}
