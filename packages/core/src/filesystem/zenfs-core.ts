import { fs, InMemoryStore, normalizePath, StoreFS } from '@zenfs/core';
import { IFileSystem, PathStat } from './types';
import { installPrototypeNameFix } from './zenfs-listing';
import { NODE_BINARY } from '../process/executors/default-env';

/**
 * Root mount for the container file system. ZenFS allocates each file as a resizable
 * ArrayBuffer reserving its maximum size; browsers exhaust that reservation after a few
 * hundred files (an npm install reaches it), so the root reports non-resizable buffers.
 */
class ContainerRootFS extends StoreFS {
    metadata() {
        return { ...super.metadata(), noResizableBuffers: true };
    }
}

let rootMounted = false;

function mountContainerRoot(): void {
    if (rootMounted) return;
    rootMounted = true;
    const root = new ContainerRootFS(new InMemoryStore('owc-root'));
    root.checkRootSync();
    fs.umount('/');
    fs.mount('/', root);
}

/**
 * Writes the file the container's `node` is, the one `{@link NODE_BINARY}` names.
 *
 * `process.execPath` of a guest names that path, and a spawn of it is answered by the node
 * executor, but it was no file: a package that looks for a binary on `PATH` -- `which` is one --
 * found nothing in a container that can run node, where a host answers a path. The file is
 * executable, because every such lookup ends in `isexe`, which reads the mode bits, and it is a
 * script the node executor runs rather than a binary, which no browser container can have.
 */
function writeNodeBinary(): void {
    if (fs.existsSync(NODE_BINARY)) return;
    fs.mkdirSync('/usr/local/bin', { recursive: true });
    fs.writeFileSync(
        NODE_BINARY,
        '#!' + NODE_BINARY + '\n' +
        '/* The container\'s node. A host keeps a binary here; this is the file a search of PATH finds.\n' +
        '   Spawning it runs the interpreter, not this script: see NODE_BINARY in container.ts. */\n',
        { mode: 0o755, encoding: 'utf-8' }
    );
    /* `writeFileSync` creates a file at 0o644 whatever its `mode` option says, and the executable
       bit is the whole of what `isexe` -- which every `which`-style lookup ends in -- reads. */
    if ((fs.statSync(NODE_BINARY).mode & 0o111) === 0) fs.chmodSync(NODE_BINARY, 0o755);
}

export class ZenFSCore implements IFileSystem {
    private fs: typeof fs;

    constructor() {
        installPrototypeNameFix();
        mountContainerRoot();
        writeNodeBinary();
        this.fs = fs;
    }
    readBuffer(path: string): Buffer | undefined {
        return this.fs.readFileSync(path);
    }
    writeBuffer(path: string, buffer: Buffer): void {
        return this.fs.writeFileSync(path, buffer);
    }
    normalizePath(path: string): string {
        return normalizePath(path);
    }

    writeFile(path: string, content: string): void {
        this.fs.writeFileSync(path, content,{encoding:'utf-8'});
    }

    readFile(path: string): string | undefined {
        return this.fs.readFileSync(path, 'utf-8');
    }

    deleteFile(path: string, recursive = false): void {
        this.fs.rmSync(path, {
            recursive
        });
    }

    listFiles(basePath:string="/"): string[] {
        const files = [];
        const items = fs.readdirSync(basePath, { withFileTypes: true });
        if (basePath.endsWith('/')) basePath = basePath.slice(0, -1);
        for (const item of items) {
            if (item.isDirectory()) {
                files.push(...this.listFiles(`${basePath}/${item.name}`));
            } else {
                files.push(`${basePath}/${item.name}`);
            }
        }

        return files;
    }

    resolvePath(path: string, basePath: string = ''): string {
        const normalizedPath = normalizePath(path);
        const normalizedBasePath = normalizePath(basePath);
        if (normalizedPath.startsWith('/')) {
            return normalizedPath;
        }
        return normalizedBasePath + '/' + normalizedPath;
    }

    fileExists(path: string): boolean {
        return this.fs.existsSync(path);
    }

    resolveModulePath(specifier: string, basePath: string = ''): string {
        const normalizedBasePath = normalizePath(basePath);

        let resolvedPath: string;

        if (specifier.startsWith('./') || specifier.startsWith('../')) {
            const baseDir = normalizedBasePath.endsWith('/') ?
                normalizedBasePath :
                normalizedBasePath + '/';

            // Split paths into segments and handle .. navigation
            const baseSegments = baseDir.split('/').filter(Boolean);
            const specSegments = specifier.split('/').filter(Boolean);

            const resultSegments = [...baseSegments];

            for (const segment of specSegments) {
                if (segment === '..') {
                    if (resultSegments.length === 0) {
                        throw new Error(`Invalid path: ${specifier} goes beyond root from ${basePath}`);
                    }
                    resultSegments.pop();
                } else if (segment !== '.') {
                    resultSegments.push(segment);
                }
            }

            resolvedPath = '/' + resultSegments.join('/');
        } else {
            resolvedPath = normalizePath(specifier);
        }

        // Check for file existence
        if (this.fs.existsSync(resolvedPath)) {
            let stat=this.fs.lstatSync(resolvedPath)
            if(stat.isFile()) return resolvedPath;
            else if (stat.isDirectory()){
                let indexPath=normalizePath(`${resolvedPath}/index`)
                let exts=['.js', '.mjs']
                exts.forEach(ext=>{
                    let withExt = `${indexPath}${ext}`;
                    if (this.fileExists(withExt)) {
                        return withExt;
                    }
                })
                
            }
        }

        for (const ext of ['.js', '.mjs']) {
            const withExt = `${resolvedPath}${ext}`;
            if (this.fileExists(withExt)) {
                return withExt;
            }
        }

        throw new Error(`Module not found: ${specifier} (resolved to ${resolvedPath})`);
    }

    createDirectory(path: string): void {
        this.fs.mkdirSync(path,{recursive:true});
    }

    deleteDirectory(path: string): void {
        this.fs.rmdirSync(path);
    }

    listDirectory(path: string): string[] {
        return this.fs.readdirSync(path);
    }

    isDirectory(path: string): boolean {
        return this.fs.lstatSync(path).isDirectory();
    }

    /* `mode` is carried through: a guest's `fs.statSync` reports it, and the executable bit is
       what a search for a binary reads. */
    statPath(path: string): PathStat | undefined {
        if (!this.fs.existsSync(path)) return undefined;
        const stat = this.fs.statSync(path);
        return {
            type: stat.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            mode: stat.mode
        };
    }

    readdirNames(path: string): string[] | undefined {
        if (!this.fs.existsSync(path) || !this.fs.statSync(path).isDirectory()) return undefined;
        return this.fs.readdirSync(path);
    }

    readBytes(path: string): Uint8Array | undefined {
        if (!this.fs.existsSync(path) || this.fs.statSync(path).isDirectory()) return undefined;
        return new Uint8Array(this.fs.readFileSync(path));
    }

    writeBytes(path: string, data: Uint8Array): void {
        this.fs.writeFileSync(path, data);
    }

    removePath(path: string, recursive = false): void {
        this.fs.rmSync(path, { recursive, force: false });
    }

    renamePath(from: string, to: string): void {
        this.fs.renameSync(from, to);
    }

    utimes(path: string, mtimeMs: number): void {
        const at = new Date(mtimeMs);
        this.fs.utimesSync(path, at, at);
    }
}
