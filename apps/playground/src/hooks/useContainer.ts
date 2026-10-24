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
            pageContainer = new ContainerManager({
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
        });
    }, []);

    useEffect(() => {
        if (!containerRef.current || !ready) return
        let interval = setInterval(() => {
            containerRef.current?.listActiveServers().then((resp)=>{
                let {ports}=resp
                setServers(ports)
            }).catch(() => {});
        }, 1000);
        return ()=>{
            clearInterval(interval)
        }
    }, [ready]);

    return {
        ready,
        container: containerRef.current,
        servers
    };
}
