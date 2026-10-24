import { DeviceFS, Errno, ErrnoError, fs, InMemoryStore, normalizePath, StoreFS, type DeviceDriver } from '@zenfs/core';
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

/**
 * The scratch directories a Linux container image carries, made at mount the way `/` itself is:
 * `os.tmpdir()` of a guest is `/tmp` whether or not anything set `TMPDIR`, and the directory it
 * named was not there, so a package that wrote a temporary file -- or any probe that redirected to
 * `/tmp` -- failed with ENOENT where a host succeeds. `/var/tmp` is the other path such a package
 * reaches for. Both are world-writable and sticky, the mode a real `/tmp` keeps.
 */
const SCRATCH_DIRS: ReadonlyArray<string> = ['/tmp', '/var/tmp'];

function createScratchDirectories(): void {
    for (const dir of SCRATCH_DIRS) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o1777 });
        if ((fs.statSync(dir).mode & 0o1777) !== 0o1777) fs.chmodSync(dir, 0o1777);
    }
}

/**
 * The directories a Linux image carries that a guest reaches for by name and that were not there,
 * the same shape of hole `/tmp` was: `os.homedir()` of a guest is `/home` and `/home` was missing,
 * `fs.writeFileSync('/etc/...', ...)` failed with ENOENT, and `PATH` lists `/bin` and `/usr/bin`
 * while neither existed.
 */
const SYSTEM_DIRS: ReadonlyArray<string> = ['/bin', '/dev', '/etc', '/home', '/opt', '/usr/bin', '/usr/lib', '/app'];

function createSystemDirectories(): void {
    for (const dir of SYSTEM_DIRS) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
}

/**
 * The device files a Linux image carries under the `/dev` the directories above make, which a guest
 * could not see at all while this file system held files and directories only: `existsSync` of
 * `/dev/null` was false, and the one way to make the name was to write it, which made an ordinary
 * file -- a read of it handed back what had been written, where a host reads end of file -- and a
 * guest that opened `/dev/urandom` for bytes of entropy got ENOENT. A host has all four as
 * character devices: `statSync('/dev/null').isCharacterDevice()` is true there, its mode is
 * `0o20666`, its size is 0, and a read of it ends at once.
 *
 * They are not files and hold no bytes of their own: `/dev/null` reads end of file and discards
 * what is written to it, `/dev/zero` reads zeroes, and `/dev/random` and `/dev/urandom` read random
 * bytes, `crypto.getRandomValues` being the source the host bridge already uses for `randomBase64`.
 * A read of a stream has no end, so a whole-file read of one -- which is what `readFileSync` asks
 * for -- hands back one chunk, the `DEVICE_CHUNK` bytes a single read of a character device yields;
 * a device that is at end of file hands back nothing.
 */
const DEVICE_DIR = '/dev';
const DEVICE_CHUNK = 4096;

interface DeviceSpec {
    /** The bytes one read of the device yields; empty for a device that is at end of file. */
    read(length: number): Uint8Array;
    major: number;
    minor: number;
    /**
     * Whether a write to the device is taken. `/dev/random` is how a host is seeded, so it takes one;
     * `/dev/urandom` is not: a write to it is refused with `EPERM` on the host, and a guest that
     * opens it for writing gets the same refusal rather than a silent 8 bytes written.
     */
    writable?: boolean;
}

function randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
}

const DEVICES: Readonly<Record<string, DeviceSpec>> = {
    '/dev/null': { major: 1, minor: 3, read: () => new Uint8Array(0) },
    '/dev/zero': { major: 1, minor: 5, read: (length) => new Uint8Array(length) },
    '/dev/random': { major: 1, minor: 8, read: randomBytes, writable: true },
    '/dev/urandom': { major: 1, minor: 9, read: randomBytes, writable: false }
};

function driverFor(name: string, spec: DeviceSpec): DeviceDriver {
    return {
        name,
        init: () => ({ major: spec.major, minor: spec.minor }),
        read: (_file, buffer, offset = 0, length = buffer.byteLength) => {
            const bytes = spec.read(length);
            new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(bytes, offset);
            return bytes.length;
        },
        /* Every one of these discards what is written; the position still advances, as on a host --
           except `/dev/urandom`, which a host refuses to be written to at all. */
        write: (file, _buffer, _offset, length) => {
            if (spec.writable === false) throw ErrnoError.With('EPERM', `${DEVICE_DIR}/${name}`, 'write');
            file.position += length;
            return length;
        }
    };
}

/**
 * The `/dev` of a host is not scratch: it is a directory the kernel owns, and a name made in it is
 * refused with `EPERM` -- `mkdir /dev/sub`, `mkdir -p /dev/a/b` and a write of `/dev/newfile` all
 * report "Operation not permitted" there, where the plain `DeviceFS` this mounts is an ordinary
 * writable store and let every one of them through, and left `/dev` looking like world-writable
 * scratch. Only the four devices belong in it, and they are made by `createDevice`, which none of
 * these calls reach.
 */
class ContainerDeviceFS extends DeviceFS {
    createFileSync(path: string, _flag?: string, _mode?: number): never {
        throw ErrnoError.With('EPERM', path, 'open');
    }
    mkdirSync(path: string, _mode?: number): never {
        throw ErrnoError.With('EPERM', path, 'mkdir');
    }
    writeFileSync(path: string, _data?: unknown, ..._rest: unknown[]): never {
        throw ErrnoError.With('EPERM', path, 'open');
    }
    symlinkSync(_target: string, path: string): never {
        throw ErrnoError.With('EPERM', path, 'symlink');
    }
}

let devicesMounted = false;

/**
 * Mounts the file system that holds the devices at `/dev`, the way a host has one mounted there.
 * ZenFS keeps device files in a file system of their own, and `/dev` is already a directory of the
 * root file system by the time this runs, so `readdir('/')` still lists it.
 */
function mountDeviceDirectory(): void {
    if (devicesMounted) return;
    devicesMounted = true;
    const dev = new ContainerDeviceFS();
    dev.checkRootSync();
    for (const path of Object.keys(DEVICES)) {
        dev.createDevice(path.slice(DEVICE_DIR.length), driverFor(path.slice(DEVICE_DIR.length + 1), DEVICES[path]));
    }
    try {
        fs.mount(DEVICE_DIR, dev);
    } catch {
        /* A second container in this process finds the mount already there, and it is the same one. */
    }
}

/** The device a path names, or `undefined` when it names a file or a directory. */
function deviceAt(path: string): DeviceSpec | undefined {
    try {
        return DEVICES[normalizePath(path)];
    } catch {
        return undefined;
    }
}

/**
 * The files `PATH` names for the commands a guest looks for there: `sh`, `ls`, `cat` and `echo` in
 * `/bin`, `env` in `/usr/bin`, and `node`, `npm` and `npx` in `/usr/local/bin`. `PATH` listed all
 * three directories while `node` was the only file on it, so `which sh`, `which cat` and
 * `command -v sh` all failed -- and `readdir('/bin')` was empty -- in a container that runs every
 * one of those commands: they are built into its shell and need no file to run, but a lookup is a
 * question about the file system, and the file system had no answer to give. Each is the script the
 * shell would run to reach the same command, executable for the same reason the node file is: every
 * lookup ends in `isexe`, which reads the mode bits.
 *
 * Two things keep a name off this list. A command this container cannot run gets no file: there is
 * no `git` here, and a file that named one would answer `command -v git` with a path and then fail
 * the moment a line ran it. And a command the shell reaches through its runner rather than through
 * its own built-ins -- `grep` and `sed` are two -- is left without one on purpose: a file on `PATH`
 * outranks the runner, so giving them one makes `command -v grep` answer and `grep` itself stop
 * working ("it is the file /usr/bin/grep, which only a child can run"). Being able to run them is
 * worth more than being able to name them.
 */
const PATH_COMMANDS: ReadonlyArray<readonly [string, string]> = [
    ['/bin/sh', '#!/bin/sh\n'],
    ['/bin/ls', '#!/bin/sh\nls "$@"\n'],
    ['/bin/cat', '#!/bin/sh\ncat "$@"\n'],
    ['/bin/echo', '#!/bin/sh\necho "$@"\n'],
    ['/usr/bin/env', '#!/bin/sh\nenv "$@"\n'],
    ['/usr/local/bin/npm', '#!/bin/sh\nnpm "$@"\n'],
    ['/usr/local/bin/npx', '#!/bin/sh\nnpx "$@"\n']
];

function writePathCommands(): void {
    for (const [path, script] of PATH_COMMANDS) {
        if (fs.existsSync(path)) continue;
        const dir = path.slice(0, path.lastIndexOf('/'));
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
        fs.writeFileSync(path, script, { mode: 0o755, encoding: 'utf-8' });
        if ((fs.statSync(path).mode & 0o111) === 0) fs.chmodSync(path, 0o755);
    }
}

function joinPath(dir: string, name: string): string {
    return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/*
 * The two bounds a kernel refuses before it looks at anything else: a component past NAME_MAX of 255
 * bytes, and a whole path past PATH_MAX of 4096. ZenFS keeps neither -- it writes and reads a
 * 1024-byte name -- so a guest's fs.writeFileSync of 'b'.repeat(256) landed where host node 24.15
 * answers ENAMETOOLONG, and a 4200-byte path answered ENOENT here, its parent looking missing,
 * where the host refuses the whole path before it looks at any parent. The bound is read where a
 * path is resolved rather than at the one call a probe made, so it holds for every write, every
 * stat and every directory this file system makes.
 */
const NAME_MAX = 255;
const PATH_MAX = 4096;

function requirePathWithinLimits(path: string): void {
    if (new TextEncoder().encode(path).length > PATH_MAX) throw new ErrnoError(Errno.ENAMETOOLONG, path);
    for (const part of path.split('/')) {
        if (new TextEncoder().encode(part).length > NAME_MAX) throw new ErrnoError(Errno.ENAMETOOLONG, path);
    }
}

export class ZenFSCore implements IFileSystem {
    private fs: typeof fs;

    constructor() {
        installPrototypeNameFix();
        mountContainerRoot();
        writeNodeBinary();
        writePathCommands();
        createScratchDirectories();
        createSystemDirectories();
        mountDeviceDirectory();
        this.fs = fs;
    }
    readBuffer(path: string): Buffer | undefined {
        return this.fs.readFileSync(path);
    }
    writeBuffer(path: string, buffer: Buffer): void {
        requirePathWithinLimits(path);
        return this.fs.writeFileSync(path, buffer);
    }
    normalizePath(path: string): string {
        return normalizePath(path);
    }

    writeFile(path: string, content: string): void {
        requirePathWithinLimits(path);
        this.fs.writeFileSync(path, content,{encoding:'utf-8'});
    }

    readFile(path: string): string | undefined {
        /* A device reports a size of 0, and `readFileSync` reads exactly that many bytes, so `cat`
           and `head` of one -- which is what the shell reads a file with -- got nothing at all:
           `head -c 4 /dev/zero | wc -c` printed 0 where a host prints 4. One read of the device is
           what a read of the path can be, the same bound `readBytes` already keeps. */
        const device = deviceAt(path);
        if (device) return new TextDecoder().decode(device.read(DEVICE_CHUNK));
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

    /*
     * A directory made with no mode asked for gets the one `mkdir` gives it: 0o777 masked with the
     * umask, so 0o755, and not the bare 0o777 ZenFS leaves -- which made every directory in the
     * container world writable, and `ls -ld` of one read `drwxrwxrwx` where a host reads
     * `drwxr-xr-x`.
     */
    createDirectory(path: string, mode?: number): void {
        requirePathWithinLimits(path);
        this.fs.mkdirSync(path, { recursive: true, mode: (mode === undefined ? 0o777 : mode & 0o7777) & ~0o022 });
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
        requirePathWithinLimits(path);
        if (!this.fs.existsSync(path)) return undefined;
        const stat = this.fs.statSync(path);
        /* A host's `/dev` is `dr-xr-xr-x`, the kernel's directory rather than the user's, so that is
           the mode it is given. The root a `DeviceFS` makes for itself is 0o777 and `chmod` of it
           fails in this ZenFS build -- "Size mismatch: buffer length 2, stats size 4096" -- so the
           mode is set where it is read instead of where it is kept. */
        const mode = normalizePath(path) === DEVICE_DIR ? 0o40555 : stat.mode;
        /* A character device is `file` here, the only other kind `PathStat` names; what makes it a
           device is the `S_IFCHR` its mode carries, which is what a host's own stat of one reports. */
        return {
            type: stat.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            mode
        };
    }

    readdirNames(path: string): string[] | undefined {
        if (!this.fs.existsSync(path) || !this.fs.statSync(path).isDirectory()) return undefined;
        return this.fs.readdirSync(path);
    }

    readBytes(path: string): Uint8Array | undefined {
        if (!this.fs.existsSync(path) || this.fs.statSync(path).isDirectory()) return undefined;
        const device = deviceAt(path);
        /* A device has no bytes of its own: one read of it is all a read of the path can be. */
        if (device) return device.read(DEVICE_CHUNK);
        return new Uint8Array(this.fs.readFileSync(path));
    }

    writeBytes(path: string, data: Uint8Array, mode?: number): void {
        requirePathWithinLimits(path);
        this.fs.writeFileSync(path, data, mode === undefined ? undefined : { mode: mode & 0o7777 });
    }

    /* An append is a write at the end of what is already there. `writeBytes` hands the file system
       a second copy of every byte, so the cost of one append grew with the file -- a 2 MiB log
       written 5 KiB at a time took minutes where a host takes milliseconds -- and the bytes the
       file already had were written again on every call. The size is read once and the new bytes
       are written at it, which leaves the ones already there untouched. */
    appendBytes(path: string, data: Uint8Array, mode?: number): void {
        requirePathWithinLimits(path);
        /* 'a+' is the flag an append is: it opens the name, seeks to the end of what is already
           there and writes, so a name that is not there yet is made the way `writeBytes` makes it. */
        this.fs.appendFileSync(path, data, mode === undefined ? undefined : { mode: mode & 0o7777 });
    }

    removePath(path: string, recursive = false): void {
        this.fs.rmSync(path, { recursive, force: false });
    }

    renamePath(from: string, to: string): void {
        /* ZenFS renames a file and refuses a directory, so a directory is moved one entry at a
           time: the tree a host moves with a single rename(2). */
        if (this.fs.statSync(from)?.isDirectory()) {
            this.moveDirectory(from, to);
            return;
        }
        this.fs.renameSync(from, to);
    }

    private moveDirectory(from: string, to: string): void {
        const stat = this.fs.statSync(from);
        this.fs.mkdirSync(to, { recursive: true, mode: stat.mode & 0o7777 });
        for (const name of this.fs.readdirSync(from)) {
            this.renamePath(joinPath(from, name), joinPath(to, name));
        }
        this.fs.rmdirSync(from);
    }

    utimes(path: string, mtimeMs: number): void {
        const at = new Date(mtimeMs);
        this.fs.utimesSync(path, at, at);
    }
}
