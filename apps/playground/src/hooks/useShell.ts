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

        async function initShell(container: ContainerManager) {
            try {
                const args = osc ? ['--osc'] : [];
                const process = await container.spawn('sh', args);

                if (!(process instanceof VirtualProcess)) {
                    throw new Error('Failed to create shell process');
                }

                // Store the process reference
                processRef.current = process;

                // Set up process event listeners
                process.on(ProcessEvent.OUTPUT, (data) => {
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
