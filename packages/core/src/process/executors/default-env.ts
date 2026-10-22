/**
 * Where the container keeps its `node`: `process.execPath` of a guest, the file a search of `PATH`
 * finds, and the name a spawn of which runs the interpreter. The same path is written as a literal
 * in `runtime/guest/globals.ts` (`proc.execPath`, inside a string snippet) and in
 * `runtime/capabilities/child.ts`; this is the copy the host side reads.
 */
export const NODE_BINARY = '/usr/local/bin/node';

/**
 * The environment a container process starts with, wherever it is built: a shell's and a node
 * process's are the same set, so the two cannot drift apart.
 *
 * It is what a Linux container reports, and what a package that reads the environment to decide
 * what it can do looks for. Nothing of the host's own environment is copied into it: this is a
 * container in a browser, whose worker has no environment to inherit, and a host `HOME` or `PATH`
 * here would tell a guest where it is running from. `TERM` and `COLORTERM` are the pair a colour
 * library reads -- `colors@1` turns a `TERM` of `xterm` into `\e[31mx\e[39m` for `'x'.red`, where
 * a guest with no `TERM` at all printed `x` -- and `LANG` is what a container image sets; the
 * values a host carries are its own and are not reproduced. `/usr/local/bin` is where the
 * container keeps its `node`, so a search of `PATH` for one finds it.
 */
export const CONTAINER_ENV: ReadonlyArray<readonly [string, string]> = [
    ['PATH', '/bin:/usr/bin:/usr/local/bin'],
    ['HOME', '/home'],
    ['TERM', 'xterm'],
    ['COLORTERM', 'truecolor'],
    ['LANG', 'C.UTF-8']
];

/**
 * The environment for a process started in `cwd`, with `overrides` -- a caller's own, or the
 * environment a parent handed down -- over the container's defaults.
 */
export function containerEnv(cwd: string | undefined, overrides: Record<string, string> = {}): Map<string, string> {
    const env = new Map<string, string>(CONTAINER_ENV);
    env.set('PWD', cwd || '/');
    for (const [name, value] of Object.entries(overrides)) env.set(name, value);
    return env;
}
