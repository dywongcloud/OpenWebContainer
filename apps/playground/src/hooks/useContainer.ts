import { useEffect, useRef, useState } from 'react';
import { ContainerManager } from '@open-web-container/api';

/*
 * One container for the page.
 *
 * Mounting one per mount handed the app a container the next mount had already thrown away: the
 * teardown disposed the manager this hook had just published, so the write that followed -- the
 * demo file, and every file the reload restore puts back -- went into a disposed container, was
 * rejected as an unhandled promise or swallowed by the restore's own catch, and the session came
 * back on a container none of those writes had reached. The page runs one container for as long as
 * the page lives, so no mount pass can lose it.
 */
let pageContainer: ContainerManager | null = null;

export function useContainer() {
    const containerRef = useRef<ContainerManager | null>(null);
    const [ready, setReady] = useState(false);
    const [servers, setServers] = useState<number[]>([]);

    useEffect(() => {
        if (!pageContainer) {
            /* A long host-side WebAssembly compile (Next's SWC fallback) is one uninterrupted
               stretch to the guest VM guard; ?budget=<ms> lets a heavy command finish without
               making the default runaway bound longer for everyone. */
            /* A non-finite or int32-overflowing budget would disarm the VM guard entirely or
               wrap the request timer, so clamp it to the same finite window the bridge uses. */
            const raw = Number(new URLSearchParams(window.location.search).get('budget'));
            const budget = Number.isFinite(raw) && raw > 0 && raw <= 600000 ? Math.floor(raw) : undefined;
            pageContainer = new ContainerManager({
                guestBudgetMs: budget,
                onServerListen: (port) => {
                    console.log('Server listening on port', port);
                    setServers((listening) => Array.from(new Set([...listening, port])));
                },
                onServerClose: (port) => {
                    console.log('Server closed on port', port);
                    setServers((listening) => listening.filter((s) => s !== port));
                }
            });
        }
        containerRef.current = pageContainer;
        /* A poll that the container cannot answer -- it is busy running a long command on its
           one thread -- must not surface as an unhandled rejection. */
        pageContainer.waitForReady().then(() => {
            setReady(true);
        }).catch((error) => {
            console.error('Container failed to initialize:', error);
        });
    }, []);

    useEffect(() => {
        if (!containerRef.current || !ready) return
        /* One poll in flight at a time. A 1s interval keeps issuing listServers while
           the worker's single thread is busy, so those requests queue behind the long
           command; skipping ticks until the previous one settles bounds the queue at
           exactly one. The request's own finite timeout (WorkerBridge) guarantees the
           flag is released, so the poll can never wedge. */
        let inFlight = false;
        let stopped = false;
        let lastError = '';
        let lastErrorAt = 0;
        let interval = setInterval(() => {
            const container = containerRef.current;
            if (!container || inFlight) return;
            inFlight = true;
            container.listActiveServers().then((resp)=>{
                if (!stopped) setServers(resp.ports)
            }).catch((error: unknown)=>{
                /* Handled, but not silently dropped: a genuine failure is logged, while
                   one identical error repeating is throttled so a stuck worker cannot
                   turn this poll into a console flood of its own. */
                const message = String((error as Error)?.message ?? error);
                const now = Date.now();
                if (message !== lastError || now - lastErrorAt >= 30000) {
                    lastError = message;
                    lastErrorAt = now;
                    console.error('listActiveServers poll failed:', error);
                }
            }).finally(()=>{
                inFlight = false;
            });
        }, 1000);
        return ()=>{
            stopped = true;
            clearInterval(interval)
        }
    }, [ready]);

    return {
        ready,
        container: containerRef.current,
        servers
    };
}
