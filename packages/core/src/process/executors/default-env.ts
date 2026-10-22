/**
 * Where the container keeps its `node`: `process.execPath` of a guest, the file a search of `PATH`
 * finds, and the name a spawn of which runs the interpreter. The same path is written as a literal
 * in `runtime/guest/globals.ts` (`proc.execPath`, inside a string snippet) and in
 * `runtime/capabilities/child.ts`; this is the copy the host side reads.
 */
export const NODE_BINARY = '/usr/local/bin/node';

/**
 * The directory a process starts in when the caller named none: a container's working directory,
 * which is where its project is put (`/app`, as the node image that runs one has it). It is what
 * the host's "the directory you started me in" is here -- a host process started with no `cwd`
 * inherits the one it was launched from, and `/` answered nothing a relative path could land in,
 * so `process.cwd()` and a shell `pwd` both said `/` where a host names the project's directory.
 * A `cwd` option and a `cd` are honoured over it, as they are on the host.
 */
export const CONTAINER_WORKDIR = '/app';

/**
 * The environment a container process starts with, wherever it is built: a shell's and a node
 * process's are the same set, so the two cannot drift apart.
 *
 * It is what a Linux container reports, and what a package that reads the environment to decide
 * what it can do looks for. Nothing of the host's own environment is copied into it: this is a
 * container in a browser, whose worker has no environment to inherit, and a host `HOME` or `PATH`
 * here would tell a guest where it is running from. `TERM` and `COLORTERM` are the pair a colour
 * `USER` and `LOGNAME` name the one account the container has -- the `user` its `whoami` and its
 * `os.userInfo().username` answer -- because the owner column of `ls -l` reads them, and with
 * nothing there it read the host's own account and printed a guest the name of the machine it was
 * running on. The values a host carries are its own and are not reproduced. `/usr/local/bin` is
 * where the container keeps its `node`, so a search of `PATH` for one finds it.
 */
export const CONTAINER_ENV: ReadonlyArray<readonly [string, string]> = [
    ['PATH', '/bin:/usr/bin:/usr/local/bin'],
    ['HOME', '/home'],
    ['USER', 'user'],
    ['LOGNAME', 'user'],
    ['TERM', 'xterm'],
    ['COLORTERM', 'truecolor'],
    ['LANG', 'C.UTF-8'],
    ['TMPDIR', '/tmp']
];

/**
 * The environment for a process started in `cwd`, with `overrides` -- a caller's own, or the
 * environment a parent handed down -- over the container's defaults.
 */
export function containerEnv(cwd: string | undefined, overrides: Record<string, string> = {}): Map<string, string> {
    const env = new Map<string, string>(CONTAINER_ENV);
    env.set('PWD', cwd || CONTAINER_WORKDIR);
    for (const [name, value] of Object.entries(overrides)) env.set(name, value);
    return env;
}
