/**
 * Result of stat-ing a path in the virtual file system
 */
export interface PathStat {
    type: 'file' | 'dir';
    size: number;
    mtimeMs: number;
    /**
     * The permission bits, which a guest's `fs.statSync` reports as `mode` and every search for an
     * executable (`isexe`, and `which` behind it) reads. A file system with no modes of its own
     * leaves it out, and the guest falls back to `0o644` for a file and `0o755` for a directory.
     */
    mode?: number;
}

/**
 * export interface for file system operations
 */
export interface IFileSystem {
    writeFile(path: string, content: string): void;
    writeBuffer(path: string, buffer: Buffer): void;
    readFile(path: string): string | undefined;
    readBuffer(path: string): Buffer | undefined;
    deleteFile(path: string, recursive?: boolean): void;
    listFiles(basePath?: string): string[];
    resolvePath(path: string, basePath?: string): string;
    fileExists(path: string): boolean;
    resolveModulePath(specifier: string, basePath?: string): string;
    createDirectory(path: string): void;
    deleteDirectory(path: string): void;
    listDirectory(path: string): string[];
    isDirectory(path: string): boolean;
    normalizePath(path: string): string;
    statPath(path: string): PathStat | undefined;
    readdirNames(path: string): string[] | undefined;
    readBytes(path: string): Uint8Array | undefined;
    writeBytes(path: string, data: Uint8Array): void;
    removePath(path: string, recursive?: boolean): void;
    renamePath(from: string, to: string): void;
    /**
     * Moves a path's modification time, which is what `touch` and `tar -x` need. A file system
     * without timestamps leaves it out and keeps the time the write left behind.
     */
    utimes?(path: string, mtimeMs: number): void;
}
