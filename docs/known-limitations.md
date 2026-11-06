# Known limitations

These are the boundaries an application author needs before choosing OpenWebContainer. Each one has a measured basis in the [verbatim notes archive](reference/compatibility-notes.md) or in the source on `origin/main`. They are not speculations.

## No outbound raw TCP or UDP

The virtual network (`packages/core/src/network/virtual/hub.ts`) is a loopback between processes of **one** container, with a virtual name table and path-carried Unix sockets. `net`, `dgram`, `dns`, `http`, `https` and `http2` work inside it; non-local connects fail or are dropped. A browser cannot open a raw socket to the outside. Previews are **HTTP ingress only** through the service worker at `/__owc/preview/<port>/...`.

**Direct-TCP database drivers cannot connect.** MongoDB, Mongoose, PostgreSQL and MySQL drivers open raw TCP sockets, which a browser-hosted container does not have. Use an HTTP/API-accessible provider instead (for example Neon serverless Postgres); only the container's virtual TCP and page-level `fetch` exist. This is recorded at lines 97 and 99 of the former `Readme.md` (lines 98 and 100 of the archive, which adds one header line).

## Guest `fetch` is not browser or host undici parity

Node's `fetch` is built on undici, an HTTP/1.1 client written for Node. This container serves **its own undici module over its own `http`/`https` client** (`packages/core/src/process/executors/node/runtime/guest/modules/undici.ts`), so a program cannot assume host-Node or browser `fetch`, connection or stream behaviour. The host-undici parity surface that the container does **not** promise is the upstream undici spec-compliance list: no CORS check or preflight by default, forbidden-header constraints removed, `redirect: 'manual'` returning the real 3xx rather than an `opaqueredirect`, a five-layer `Content-Encoding` cap, and Node-only stream extensions such as `request.duplex`. On `origin/main` the measured differences are:

- The host `fetch` capability is a different surface: `runtime/capabilities/http.ts` declares `TRANSPORT_HEADERS` (`:5`), skips those names (`:60`), drops any value the browser refuses (`:66`) and reports browser CORS, name-resolution and TLS failures together as `ENOTFOUND` (`:95-100`).
- `redirect: 'manual'` on a **browser host** cannot see the 3xx at all: live headless Chrome 155 answered `status=0 type="opaqueredirect" loc=null` on `https://httpbin.org/redirect/1`, and the capability re-asks with `follow`, so `manual` is handed the already-followed `200`. Against a **Node host** the guest's own hop logic answers a real `302` with `location`, `redirected false` and `type "basic"` (old Readme lines 1525-1540, 1042).
- The guest's own undici implements the Node-only `duplex: 'half'` requirement for a `ReadableStream` body; a request without it is refused with `RequestInit: duplex option is required when sending a body.` (`undici.ts:259-276`, old Readme line 2638). `redirect` is decided inside the guest, never handed to the host `http` module (`undici.ts:62-63`).

Treat guest `fetch` as "an HTTP client that happens to have the Fetch API shape", not as the browser's or host undici's.

## Cross-origin isolation is the host's job

A WebContainer-compatible host must serve `Cross-Origin-Opener-Policy: same-origin` plus `Cross-Origin-Embedder-Policy: require-corp` or `credentialless`. **The container does not provision isolation for the page.** See also [Isolation boundaries](reference/isolation-boundaries.md), the separate lane's record of the four measured host boundaries. A headful Chrome 157 measurement of the `:5173` playground document recorded `self.crossOriginIsolated=false`, `typeof SharedArrayBuffer=undefined` and `isSecureContext=true` while the Web IDE still booted (old Readme line 101). `apps/playground/vite.config.ts` on `origin/main` now declares both headers for `server` and `preview`, and `ContainerOptions.coep` / `WorkerInitOptions.coep` accept `'require-corp' | 'credentialless' | 'none'` with the value fixed at first boot — but the document in that measurement carried neither header, so **verify the response headers your own deployment serves** before relying on `SharedArrayBuffer`. Old Readme line 100 ("no WebContainer.boot-style coep option here") is a record of the tree as it was measured, not of the current code.

## One host thread, pinned to QuickJS

A guest loop blocks the host thread; no second thread can preempt it. The only thing that runs while guest code holds the thread is a QuickJS interrupt handler, which can **abort** a guest but never resume one. Consequences measured in the archive:

- `new OpenWebContainer({ guestBudgetMs: ms })` sets a default **30000 ms** uninterrupted-execution budget; `0` disarms it. `while (true) {}` is stopped at ~30155 ms with `Error: Script execution timed out after 30000ms` and exit 1. The budget bounds one *uninterrupted stretch*: every host call, await or timer wait restarts it (old Readme lines 1103-1140).
- `child.kill()` on a busy child has no moment at which to run: it still answers `false`, and `worker.terminate()` on a busy worker is not prompt (old Readme lines 1772, 2089). A `spawn`'s `timeout` works because the deadline is put on the interrupt handler instead of a host timer.
- QuickJS 0.32 has no WebAssembly of its own; guest WASM is supplied by the host realm (`runtime/wasm-host.ts`). Bare QuickJS 0.32 reproduces the chained `Iterator.prototype` helper `TypeError`, and `Intl` is a guest shim with eight of host Node's twelve names: `Intl.Locale`, `DisplayNames`, `Segmenter` and `DurationFormat` are `undefined` (old Readme lines 1035-1037).
- Some native add-ons are JavaScript reimplementations (`bcrypt`, `better-sqlite3`, `canvas`, `sharp`, `leveldown`, `rocksdb`, `node-pty`, `sodium-native`); `esbuild`'s Go binary cannot execute, so `npm install esbuild` fails `ENOEXEC` in postinstall. `sql.js` does not run.

## Sparse files and the guest-to-host channel

A write past the end of a file leaves the gap unwritten: measured with a 5-byte write at a 1 GiB offset, the file is 1073741829 bytes but costs only the 10 bytes written, `blocks` reads 40 as the host reads it, and the gap reads as zeroes. Earlier the container grew one buffer to the size of the hole and died of `InternalError: out of memory` (old Readme line 18; `runtime/guest/buffer-fs.ts` now records sparse parts). Text writes are lossy on binary: a 684897-byte `.wasm` written as text came back 765555 bytes and WebAssembly rejected it. Use `writeFile(path, Uint8Array)` for binary and `readFileBytes` to read it back.

## Partial Node surfaces

- `fs.glob` / `globSync` and `Utf8Stream` are absent; `node:util` exposes 22 of host Node's 35 names in the namespace measurement (old Readme lines 1449, 2018).
- `zlib`'s `maxOutputLength` and its `ZstdDictionary`/`BrotliCompress` native-handle internals are partial; `tls`/`https` implement TLS 1.3 only, verify against the `ca` option only (no built-in roots), and `http2` has no server push, `respondWithFile`, ALTSVC/ORIGIN frames or h2c upgrade (old Readme lines 1041, 1045-1046).
- `vm` `timeout` is enforced for JavaScript loops but not for time inside a native built-in (old Readme line 1060).
- Six `tsc --noEmit` errors on a fresh `origin/main` export of `packages/core` were recorded in the `owc-published-tree-typescript-errors` PRD row and fixed there, so a fresh export typechecks with `tsc --noEmit` exit 0; five further errors reported from the diverged local working tree do not appear in a fresh export.

## Residual conformance gaps

Six host-Node deviations from the WPT `urltestdata.json` fixture and 20 documented IDNA cases remain. The URL IDNA mapping is `toLowerCase` + NFC, not UTS-46; `url.Url` is still the WHATWG class and `url.resolveObject` is missing. There is **no `.github/workflows`** on `origin/main`, so CI is unverified — see [Compatibility](compatibility.md).

## Where the evidence lives

Every chronological measurement, including the documentation lines of every closed PRD row, is preserved byte-for-byte, below a single header line, in [docs/reference/compatibility-notes.md](reference/compatibility-notes.md). If a number here conflicts with the archive, the archive is the primary record of what was measured.

Cross-origin isolation and host-header details are covered in [Isolation boundaries](reference/isolation-boundaries.md).
