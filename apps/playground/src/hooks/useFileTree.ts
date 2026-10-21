import { ContainerManager } from '@open-web-container/api';
import { useEffect, useMemo, useRef, useState } from 'react';

interface FileSystemNode {
    name: string;
    type: 'file' | 'directory';
    path: string;
    children?: FileSystemNode[];
}

/**
 * How long to wait before asking for the tree again, for a tree of `count` paths.
 *
 * A whole-tree listing walks every file the container holds, and it does it on the worker's one
 * thread -- the same thread a command typed in the terminal is running on. Asking once a second
 * is free while the tree is small, but an `npx create-next-app` writes tens of thousands of
 * files: a listing then costs seconds, and one starting every second left the install no thread
 * at all, so it stopped after its first few packages and the prompt never came back. Waiting in
 * proportion to what the tree holds keeps the explorer up to date and gives the command the
 * thread: the biggest tree costs one listing a minute.
 */
function refreshDelayMs(count: number): number {
    return Math.min(60000, Math.max(1000, count));
}

export function useFileTree(containerReady: boolean, container: ContainerManager | null) {
    const [paths, setPaths] = useState<string[]>([]);
    const pathsRef = useRef<string[]>([]);

    useEffect(() => {
        if (!container) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let failures = 0;

        /* One listing at a time: a slow one must not have a second queued behind it, or the
           container never gets a gap to run the command the terminal is waiting on. */
        const refresh = async () => {
            if (stopped || !container) return;
            try {
                const listed = await container.listFiles();
                if (stopped) return;
                failures = 0;
                setPaths(listed || []);
                pathsRef.current = listed || [];
            } catch {
                /* The container could not answer in time -- it is busy running something -- and
                   the tree it would have named is only growing, so ask again later still. */
                failures++;
            }
            if (stopped) return;
            timer = setTimeout(refresh, failures > 0
                ? Math.min(60000, 15000 * failures)
                : refreshDelayMs(pathsRef.current.length));
        };

        if (containerReady) {
            pathsRef.current = [];
            void refresh();
        }
        return () => {
            stopped = true;
            if (timer !== undefined) clearTimeout(timer);
        };
    }, [containerReady, container]);

    return useMemo(() => {
        const root: FileSystemNode = {
            name: '/',
            type: 'directory',
            path: '/',
            children: []
        };

        /* A node is found by its path, not by scanning the children for one: a tree of tens of
           thousands of files has directories with hundreds of entries, and looking each up by
           scanning made building the tree quadratic in the size of the install. */
        const byPath = new Map<string, FileSystemNode>([['/', root]]);
        const ensureDirectory = (path: string): FileSystemNode => {
            const existing = byPath.get(path);
            if (existing !== undefined) return existing;
            const parent = ensureDirectory(path.slice(0, path.lastIndexOf('/')) || '/');
            const node: FileSystemNode = {
                name: path.slice(path.lastIndexOf('/') + 1),
                type: 'directory',
                path,
                children: []
            };
            parent.children!.push(node);
            byPath.set(path, node);
            return node;
        };

        for (const path of paths) {
            if (path === '/') continue;
            const cut = path.lastIndexOf('/');
            const parent = cut <= 0 ? root : ensureDirectory(path.slice(0, cut));
            parent.children!.push({
                name: path.slice(cut + 1),
                type: 'file',
                path
            });
        }

        const sortChildren = (node: FileSystemNode) => {
            if (node.children) {
                node.children.sort((a, b) => {
                    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
                node.children.forEach(sortChildren);
            }
        };
        sortChildren(root);

        return [root];
    }, [paths]);
}
