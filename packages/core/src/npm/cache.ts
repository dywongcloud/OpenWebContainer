import { NpmRegistry } from './registry';

/**
 * `npm cache verify`: npm walks its `_cacache`, re-checks every content file an index entry still
 * points at, drops what nothing points at any more, and reports the counts.
 *
 * A container has no `_cacache` on a disk -- there is no home directory of files to walk -- so what
 * this verifies is the cache the registry client of this process is holding: the tarballs it has
 * fetched and the metadata it fetched to get them. The lines, and what each of them counts, are
 * npm's own; the numbers are this process's, and a fresh one has nothing in it yet.
 */

export interface CacheResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** npm prints the cache path with the home directory written back to `~`, as it prints it. */
function cacheLabel(): string {
    return '~/.npm/_cacache';
}

/**
 * `npm cache verify`: the counts of what was verified, what was collected and what the index holds,
 * and how long it took. `Content garbage-collected` is npm's own line and is printed only when
 * something was collected, which a cache nothing has been dropped from never is.
 */
export function runCacheVerify(registry: NpmRegistry, startedMs: number): CacheResult {
    const stats = registry.cacheStats();
    const elapsed = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedMs) / 1000;
    const lines = [
        `Cache verified and compressed (${cacheLabel()})`,
        `Content verified: ${stats.content} (${stats.bytes} bytes)`
    ];
    /* Nothing is ever dropped from a cache that holds nothing but what this process fetched, so
       npm's `Content garbage-collected` line -- which it prints only when something was -- is
       never printed here. */
    lines.push(`Index entries: ${stats.index}`);
    lines.push(`Finished in ${elapsed.toFixed(3)}s`);
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}
