---
name: npm fetch failed is transient, not an install-path flake
description: Measured at origin/main 5dcb540a95a77d763543be33b3ed8fecd37d7071 -- 0/144 container npm installs failed at serial/2-way/4-way over two memory points twice per point; a controlled 'fetch failed' injection exits 1 and clears on one retry, so corpus gates need a bounded retry rule before blaming a code change.
metadata:
  type: unknown
---

# npm 'fetch failed' is a transient host-fetch error, not a deterministic install-path flake

Question: 11 'fetch failed' failures in one contiguous alphabetical window (json5..marked) in the
bindings-fix trees vs 0 failures for the same corpus in a concurrent run. Contention on the
registry proxy, or a genuine install-path flake? Do corpus gates need a retry rule?

Measurement (fresh tarball export of tip 5dcb540a95a77d763543be33b3ed8fecd37d7071; node_modules
symlinked; generated worker-code.ts copied; packages/core/dist/index.js rebuilt with esbuild ONLY in
scratch; one fresh node process and one OpenWebContainer boot per case): 12 real specs from
json5..marked, 16 cases = 2 memory points (P1 free, P2 holding a 256 MB Buffer) x 2 repetitions x
(serial, 2-way, 4-way) plus 4 controlled-injection cases. 144 installs, 0 natural failures,
0 'fetch failed' strings, 0 retries needed, all own exits 0. Normalized stdout/stderr/own exit
identical at all four point/repetition pairs (one stdout sha, one empty stderr sha, exits 0,0,0,0).
Direct registry probes: 72 packument fetches at c=1/2/4 under free and loaded memory, all HTTP 200,
0 429, 0 5xx, 0 ECONNRESET; 12 tarball fetches at 4-way all 200. Network was available; no stub
was used for the natural cases.

Controlled replay of the captured failure (global fetch rejects once for /json5 with TypeError
'fetch failed', cause ECONNRESET): first install exit 1, exact stderr 'fetch failed' plus the npm
log line; one bounded retry of the SAME spec in the SAME cwd after 250 ms exits 0 in 4/4 cases at
both memory points. A deterministic 404 ('Package ... not found in the registry') fails identically
on all 3 attempts and is classified fatal, not retryable. packages/core/src/npm/registry.ts makes
one host fetch per packument/tarball with no internal retry; the failed packument promise is deleted
from its cache, so a fresh npm process for the same spec re-fetches successfully.

Verdict: no genuine install-path flake and no proxy contention reproduced through 4-way concurrency
at either memory point. The 11 failures are transient host-fetch/network/proxy errors, not
package-specific or memory-dependent install bugs. Corpus gates DO need a bounded retry rule.

Retry rule: max 3 attempts (1 initial + 2 retries) of the SAME spec, backoff 250/500/1000 ms, in a
fresh npm process. Retryable strings: 'fetch failed', ECONNRESET, ETIMEDOUT, EAI_AGAIN,
'socket hang up', HTTP 429, HTTP 5xx, 'network'. Fatal (no retry, attribute immediately): 'not
found in the registry', 'Integrity check failed', 'Invalid version or range', 'No matching version
found', EBADPLATFORM, 'Global installs are not supported', ENOENT. Attribute a failure to a code
change only when all 3 attempts fail with the same retryable string, or any attempt fails with a
fatal string. A failure that clears on retry is never a divergence.
