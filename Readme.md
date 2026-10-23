# OpenWebContainer

A browser-based virtual container runtime that enables server-like JavaScript execution environments directly in the browser. OpenWebContainer provides a sandboxed environment with a virtual file system, process management, and shell capabilities, making it possible to run server-side JavaScript applications entirely in the browser.

[![GitHub license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

## 🗺️ Architecture Overview

![OpenWebContainer Architecture](./images/architecture.png)

The architecture consists of three main layers:
1. **UI Layer**: React-based user interface with terminal and file explorer
2. **Container Manager**: Handles communication between UI and Worker
3. **Web Worker**: Runs the actual container in an isolated thread

## ⚡ Current Progress

### ✅ Implemented Features

- **Core Container Infrastructure**
  - Web Worker integration for isolated execution
  - Container API abstraction for Worker communication
  - Event-based messaging system
  - Process lifecycle management

- **Virtual File System**
  - Full directory structure
  - Basic file operations
  - Path resolution
  - Module loading

- **Shell Environment**
  - Interactive shell with command history
  - Built-in commands:
    - `ls` - List directory contents
    - `cd` - Change directory
    - `pwd` - Print working directory
    - `mkdir` - Create directory
    - `touch` - Create file
    - `rm` - Remove file
    - `rmdir` - Remove directory
    - `cat` - Display file contents
    - `echo` - Display text
    - `cp` - Copy file
    - `mv` - Move file
  - File redirection (`>`, `>>`)

- **JavaScript Runtime**
  - QuickJS-based execution
  - CommonJS and ES Modules, with `node_modules` resolution, `package.json` `main`/`exports`/`imports`, and CJS/ESM interop
  - Node built-ins: `path`, `events`, `util`, `assert`, `fs` (sync, callback and promises, plus read and write streams and file descriptors — `openSync`, `writeSync`, `readSync`, `readvSync`, `writevSync`, `closeSync`, `fstatSync`, `ftruncateSync`, `truncateSync`, `linkSync`, `cpSync`, `statfsSync` and `openAsBlob` — over the virtual file system), `buffer`, `os`, `timers`, `url` (WHATWG URL and legacy `parse`/`resolve`/`format`), `crypto` (random values, `createHash`, `createHmac`, `pbkdf2`, `scrypt`, `hkdf`, `timingSafeEqual`, and `createCipheriv`/`createDecipheriv` over `@noble/ciphers`: AES-ECB, AES-CBC, AES-CTR, AES-CFB and AES-GCM at 128, 192 and 256 bits and ChaCha20-Poly1305, byte-identical to host Node 24.15 and with Node's `ERR_CRYPTO_INVALID_KEYLEN` and `ERR_CRYPTO_INVALID_IV` codes; all 52 `getHashes()` names, including `sha3-224/256/384/512`, `blake2b512`, `blake2s256`, `shake128`/`shake256`, `sm3`, `ripemd160`, `md5-sha1`, `sha512-224`/`sha512-256` and Node's OpenSSL aliases; `generateKeyPair`/`generateKeyPairSync` for `ed25519`, `ed448`, `x25519`, `x448` and the EC curves `prime256v1`, `secp384r1`, `secp521r1` and `secp256k1`, with `createPublicKey`/`createPrivateKey` and SPKI, PKCS#8 and SEC1 in PEM and DER plus JWK, and `createSign`/`createVerify`/`sign`/`verify`; `createDiffieHellman`, `createDiffieHellmanGroup` and `diffieHellman` over BigInt modular exponentiation and the RFC 2409 and RFC 3526 MODP groups), `process` (including `chdir`/`cwd` over the virtual file system), `console`, `module`, `stream` and `readline`, `querystring`, `string_decoder`, `punycode`, `diagnostics_channel`, `async_hooks` (AsyncLocalStorage across timers, ticks and `.then` callbacks), `perf_hooks`, `v8`, `vm`, `domain`, `inspector` and `repl` (partial), `zlib` (gzip, deflate and raw, compressed by the zlib Node bundles and decompressed by fflate; brotli and zstd, backed by WebAssembly codecs built from the same C libraries Node uses, byte-identical to host Node 24.15 — see "Codecs")
  - Express 4 apps run: responses with bodies, POST bodies, chunked responses and the 404 handler are verified against real Node
  - `child_process` (spawn, exec, execFile, fork, running as container processes), `worker_threads` and `cluster`, with message passing between processes
  - `net`, `dgram` and `dns` over the container's virtual network (loopback TCP and UDP between processes, a virtual name table), `http`, `https` and `http2`: servers and clients inside the container, and external requests through `fetch` (browser CORS applies); `tls` and `https` run TLS 1.3 inside the container (certificates are verified against the `ca` option only, with no built-in roots); `http2` is native HTTP/2 (RFC 9113 framing with RFC 7541 HPACK, flow control, trailers and the compat API), as h2c with prior knowledge and as h2 over TLS with ALPN through `http2.createSecureServer` and `https://` sessions
  - Timers, `process.nextTick`, `process.exit` and exit codes, driven by a host event loop
  - `node -e <source>`
  - Console output integration
  - `WebAssembly`: `compile`, `instantiate`, `validate`, `Module`, `Instance`, `Memory`, `Table` and `Global`, with `CompileError`, `LinkError` and `RuntimeError`. The engine has no WebAssembly of its own, so a module is compiled and run by the host and the guest gets objects that behave like the real ones; a `Memory` keeps a shadow of the bytes that is copied across the boundary in 1 MiB chunks on every call, so a guest write into `memory.buffer` is visible to the module from the next call on, and the module's writes are visible as soon as a call returns, but not in between. The copy is one per call, not per byte, so a module that makes very many calls over a very large memory pays for it

- **Previews**
  - Playground preview URLs (`/__owc/preview/<port>/...`) are answered by a service worker that forwards each request to the container's HTTP server on that port
  - A browser cannot open raw TCP or UDP sockets to the outside; the virtual network stays inside the container

- **npm and npx**
  - `npm install [<pkg>[@range]...]` and `npm install` from `package.json`, with `-D`/`--no-save`
  - Registry packuments and tarballs, semver ranges and dist-tags, sha512/sha1 integrity checks
  - Hoisted `node_modules` with nested copies for version conflicts, and `node_modules/.bin` shims
  - `npx <bin>` runs a project bin, or installs a package into a cache and runs its bin
  - `npm exec <bin> [-- <args>]` (alias `npm x`) is the same command under npm's own name
  - `npm run <script>` runs a `package.json` script with its `pre`/`post` lifecycle scripts, and `npm install` writes `package-lock.json` at lockfileVersion 3. Global installs are refused

### ⚠️ What a WebAssembly call costs, and why it is proportional to the memory

A `WebAssembly.Memory` is a host memory plus a shadow of the same size in the guest, and the two are
made equal every time control crosses between them -- an export call, and every import that calls back
into guest code. That copy is O(memory) per crossing, so a module that makes many calls over a large
memory pays calls x memory. Measured in the container, one `store` or one `load` over a memory of
M pages:

| pages | 16 | 256 | 512 | 1024 | 2048 |
| --- | --- | --- | --- | --- | --- |
| ms per call | 0.143 | 2.456 | 5.352 | 10.828 | 20.609 |

**Less than a whole memory cannot be moved while the contract holds, and the reason is not the
copying: it is that nothing on either side can report a change.** Guest JavaScript writes into
`memory.buffer` through an ordinary typed array, and QuickJS has no trap on a write into an
ArrayBuffer's bytes, so the host cannot learn that one page changed without reading them all. And
quickjs-emscripten copies an ArrayBuffer across the boundary rather than aliasing it, so the guest
cannot be handed the host's memory to write into directly. Comparing pages was measured and rejected
for the same reason: the comparison reads everything the copy would, and QuickJS is far slower per
byte than a copy is. A page map, a counter, or a hash all need the same write trap to stay honest.
So O(calls x memory) stands until the engine offers one of those two things -- a trap on a write into
an ArrayBuffer, or a host ArrayBuffer the guest can hold -- and this is recorded rather than fixed.

What is left is the constant, and that has been cut: the pull path hands the chunk the runtime copied
out of the guest straight into the host memory instead of filling a second host buffer from it, the
guest reuses one piece-sized buffer for a whole sync instead of allocating a fresh megabyte per
chunk, and a piece that is the whole memory is handed over without being copied at all. Same loop,
same machine: 0.353 to 0.143 ms per call at 16 pages, 3.389 to 2.456 at 256, 6.528 to 5.352 at 512,
13.369 to 10.828 at 1024 and 26.664 to 20.609 at 2048 -- between 1.2x and 2.5x fewer, with the
small-memory end gaining most.

### ✅ Brotli, zstd and the deflate family: what they are built from, and where they differ from Node

`zlib.brotliCompressSync`, `brotliDecompressSync`, `brotliCompress`, `brotliDecompress`,
`createBrotliCompress`/`BrotliCompress`, the six `zstd` equivalents, and the compression half of
gzip, deflate and deflate-raw -- `gzipSync`, `deflateSync`, `deflateRawSync`, their callback forms
and their streams -- are real codecs, not stubs. None has a JavaScript implementation that is the
one Node uses: a complete brotli encoder in JS is megabytes of source, zstd compression has no JS
implementation at all, and no JS deflate is zlib's. So all three are WebAssembly, and not guest
WebAssembly -- the bridge copies a whole module memory per crossing, which a bulk codec cannot pay --
but modules the host instantiates, in the same realm the bridge runs guest modules in. They are built
from the same C libraries Node's own `zlib` is:

| | upstream | version | module | source |
| --- | --- | --- | --- | --- |
| brotli | google/brotli (`c/common`, `c/enc`, `c/dec`) | v1.1.0 | 762 KB | 445 KB of base64 |
| zstd | facebook/zstd (`lib/common`, `lib/compress`, `lib/decompress`) | v1.5.7 | 447 KB | 157 KB of base64 |
| zlib | nodejs/node `deps/zlib` (Chromium's fork of madler/zlib) | v24.15.0 | 49 KB | 29 KB of base64 |

The zlib row is the one that is not an upstream release. Node 24.15 reports `zlib 1.3.1`, but the
1.3.1 on zlib.org is not the 1.3.1 it bundles: Node builds Chromium's fork, which replaces
`INSERT_STRING` with the ANZAC++ hasher in `contrib/optimizations/insert_string.h`, whose own header
says the result "is a valid DEFLATE stream, but will differ from canonical zlib output". It does
differ -- by one byte on 5000 bytes of repeated text, gzip/deflate/deflate-raw alike, and by more on
other inputs -- so a canonical zlib, and every JavaScript deflate, misses it. The fork also writes
`OS_CODE` 19 into the gzip header, where a build that is not `__APPLE__` writes 3, so the module is
compiled with `-DOS_CODE=19` to match the host it is measured against. Decompression of the deflate
family stays on fflate, which already agrees with Node on the framing and the errors.

Each is compiled with Emscripten as a standalone module (`-O3 -flto -sSTANDALONE_WASM=1
-sALLOW_MEMORY_GROWTH=1 -Wl,--no-entry`) over the entry points in
`packages/core/src/process/executors/node/runtime/capabilities/codec/csrc`, gzipped and written as
base64 into `brotli-wasm.ts`, `zstd-wasm.ts` and `zlib-wasm.ts`, inflated by fflate on first use and
then kept. They ask for two imports between them — a memory-growth notification and WASI's
`proc_exit` — and both are stubbed. To rebuild one, from a checkout of the upstream tag:

    emcc -O3 -flto -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 -Wl,--no-entry -I<upstream include> \
      -sEXPORTED_FUNCTIONS='["_owc_brotli_compress","_owc_brotli_decompress","_owc_brotli_error_string","_owc_brotli_stream_new","_owc_brotli_stream_write","_owc_brotli_stream_free","_malloc","_owc_free"]' \
      -o brotli.wasm csrc/brotli_codec.c <upstream>/c/{common,dec,enc}/*.c

and, for the deflate family, from `deps/zlib` in a nodejs/node v24.15.0 checkout -- `-DCPU_NO_SIMD`
keeps the fork's SIMD paths out, which are faster but not different, and `-DOS_CODE=19` is the gzip
header byte a macOS host Node writes:

    emcc -O3 -flto -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 -Wl,--no-entry -I<deps/zlib> \
      -DCPU_NO_SIMD -DHAVE_HIDDEN -DOS_CODE=19 \
      -sEXPORTED_FUNCTIONS='["_owc_zlib_stream_new","_owc_zlib_stream_write","_owc_zlib_stream_free","_owc_zlib_error_string","_malloc","_owc_free"]' \
      -o zlib.wasm csrc/zlib_codec.c <deps/zlib>/{adler32,crc32,deflate,trees,zutil}.c

The `*_stream_*` entry points are what the stream classes use. A compress stream cannot be a one-shot
call: Node hands each write to the library separately, a `flush()` is a call of its own, and the end
is another, and every one of them is visible in the bytes — a flush ends the meta-block or block that
is open, and a zstd flush leaves a frame the next call continues in a new one. So the stream keeps a
context in the module and the guest drives it one call at a time, over the same output buffer size
Node uses: 16 KiB, which is `Z_DEFAULT_CHUNK`, and it is not only a size — when a call fills it Node
calls the library again with the same flush flag, and zlib, having set `last_flush` to -1 on the way
out, opens the block again, so where those boundaries fall is in the bytes too. A `flush()` with no
argument is `Z_FULL_FLUSH` here as in Node, not `Z_SYNC_FLUSH`: the two leave the same empty stored
block, but only one clears the history, so the bytes that follow are not the same. Decompress streams
are the other way: they still buffer and inflate once, because what comes out is the same whatever
the split.

Node 24.15 bundles those same libraries, which is what makes the bytes match: a differential over
8 inputs (0 B to 200 KB) × 8 brotli parameter sets and 6 zstd parameter sets × 5 write shapes (one
write, three writes, a flush before / between / after the writes), in the sync, callback and stream
forms, produced byte-identical output, and the same errors — brotli's
`ERR__ERROR_FORMAT_PADDING_2` and `Z_BUF_ERROR`, zstd's `ZSTD_error_prefix_unknown` with its `errno`
and `ZSTD_getErrorString` message. The deflate family's own differential is 6 inputs (11 B to 70 KB)
× 3 formats × levels -1, 1, 6 and 9 × 3 write shapes (one write, a flush between two halves, a flush
after the write), in the sync, callback and stream forms: byte-identical too, and every compressed
form round-trips in both directions — bytes Node compressed decompress here, and bytes compressed
here decompress in Node.

One thing the differential needs to be fair: the writes must be paced, each one waiting for its own
callback before the next. Node's zlib streams give a chunk the stream's *finish* operation when the
stream has already ended and that chunk is the last one left queued, so writes still queued when
`end()` lands are compressed with a different operation — and whether a write is still queued is a
race. Left unpaced, Node's own output varies run to run; paced, it is stable and it matches here.

One place where this deliberately differs from Node 24.15, measured:

- `zstdCompressSync(buf, { level: n })` — Node **ignores** `level` for zstd: levels 1, 3, 19, 22 and
  -3 all produce its default level-3 output. A level asked for here is applied, as
  `ZSTD_c_compressionLevel`, before any `params`. Use `{ params: { 100: n } }` to see Node's own
  behaviour change.

A truncated zstd frame used to be a second one, and no longer is: this threw
`ZSTD_error_srcSize_wrong` where Node answers with what decoded and no error. Node decompresses
through a stream, so a frame cut short is input the stream has not seen yet rather than input it
cannot read -- and the bytes it hands back are real, not an empty apology: cutting the last byte off
a frame holding 1,077,781 bytes returns 1,048,576, and every one of them is a prefix of the
original. Throwing was the version that lost data. The same stream is why a bare magic number, three
bytes, one byte or nothing at all now return an empty buffer as they do on the host, while input
that is not a frame at all still raises `ZSTD_error_prefix_unknown`.

### ⚠️ Guest `zlib` divergences from the host that are recorded rather than fixed

Each of these was measured by running the same script under host Node 24.15 and in the container and
diffing stdout, stderr and the exit code. Where the two cannot agree, the reason is here.

- **`finishFlush` is range-checked but not applied.** `gunzipSync(frame.slice(0, -1), { finishFlush: Z_SYNC_FLUSH })`
  gives host Node 24.15 the 270 bytes that decoded and no error, where this container still raises
  `Z_BUF_ERROR unexpected end of file`; `inflateSync` is 25 bytes to 0 and `inflateRawSync` 24 to 0 the
  same way. The other direction too: `gzipSync(buf, { finishFlush: Z_SYNC_FLUSH })` is 65 bytes on the
  host and 68 here. Node hands the option to the codec as the operation the last chunk is written
  with, so anything below the finish means "do not wait for the end of the stream"; this container
  always finishes.
- **A decompress stream emits nothing before it errors.** `createGunzip()` fed a frame with its last
  byte removed pushes 270 bytes and then errors with `Z_BUF_ERROR` on host Node 24.15, and 0 bytes
  here; `createInflate()` is 25 to 0, `createInflateRaw()` 46 to 0 and `createBrotliDecompress()`
  43 to 0. Decompress streams buffer their input and inflate once, so there is no partial output to
  push before the error.
- **The brotli compressor accepts input after a flush that finished it.** `write(a); flush(Z_SYNC_FLUSH); write(b); end()`
  on a `createBrotliCompress()` raises `ERR_BROTLI_COMPRESSION_FAILED` on host Node 24.15 -- brotli
  refuses input after `BROTLI_OPERATION_FINISH` -- and yields 58 bytes, the flush's own output, with
  `b` dropped here. gz, deflate, deflate-raw and zstd agree on the same shape.
- **A `Transform` emits `'end'` one tick before `'finish'`, where Node emits `'finish'` first.** In the
  `end` handler of a stream written once and ended, `writableFinished` is true on host Node 24.15 and
  false here. `zlib`'s own `flush(callback)` works around it; a caller reading those flags does not.

### ⚠️ Guest network throughput, and where it stands now

One loopback transfer per cell, 64 KiB writes, measured in the container and beside it the same
script on host Node 24.15. The machine was **not** idle for any run (load average 14 and worse), so
treat every column as a floor, not a peak -- the host column moves with the machine too, which is
why one run reads 2000 MiB/s and another 615.

16 MiB in the container, in the order the measurements were taken:

| | codec as written | + codec fix | + binary channel | host Node, same run |
| --- | --- | --- | --- | --- |
| TCP upload | 0.69 MiB/s (23.2 s) | 1.42 (11.3 s) | 381 (0.042 s) | 615 (0.026 s) |
| TCP download | 0.63 (25.5 s) | 1.31 (12.2 s) | 381 (0.042 s) | 500 (0.032 s) |
| HTTP/1.1 upload | 0.50 (32.0 s) | 1.11 (14.5 s) | 203 (0.079 s) | 516 (0.031 s) |
| HTTP/1.1 download | 0.69 (23.1 s) | 1.41 (11.3 s) | 372 (0.043 s) | 516 (0.031 s) |
| HTTP/2 upload | 0.55 (28.9 s) | 1.03 (15.5 s) | 9.4 (1.697 s) | 200 (0.080 s) |
| HTTP/2 download | 0.50 (31.9 s) | 1.05 (15.3 s) | 9.5 (1.679 s) | 203 (0.079 s) |

**The first step: the cost was the guest's own base64 codec.** Throughput was flat at ~0.71 MiB/s
from 4 KiB to 1 MiB chunk sizes, so the cost was per byte and shared by every transport -- not a
per-message overhead, not a flow-control window and not a timer granularity. Profiling put 88% of it
in `process/executors/node/runtime/guest/codec.ts`, not in the hub: `decodeBase64` searched the
64-character alphabet with `indexOf` once per input character, and `encodeBase64` pushed one
character at a time into an array as long as its own output -- 22.7 ms to encode and 53.5 ms to
decode 64 KiB, 76.2 of the 87 ms one 64 KiB chunk cost. The host side was never the cost; it uses
`btoa`/`atob`. A lookup table and a table of two-character pieces cut those to 10.3 ms and 21.2 ms,
and end-to-end throughput by 1.9x to 2.2x.

**The second step: what was left was the boundary, and it turned out not to be inherent.** Capability
arguments are JSON, so bytes had to cross as text, and after the codec fix that was still 31 of the
46 ms a chunk cost. `callCapBytes` gave the bridge a binary channel and `net.write` now hands the
chunk over as bytes instead of base64, which is what took TCP and HTTP/1.1 to within about 1.5x of
host Node.

**HTTP/2 is now the outlier and is recorded rather than fixed.** At ~9.4 MiB/s it is about 20x
behind host Node and about 40x behind this container's own HTTP/1.1 over the identical bridge, so
the remaining cost is in the HTTP/2 implementation rather than in the transport. It is filed, not
fixed, here.

**The cause, measured live, and why it is not a transport bug.** 16 MiB of HTTP/2 costs this guest
about 50 ns of CPU per byte against host Node's 5-6 ns -- the same script run at 1 MiB and at 16 MiB,
two runs each, the difference attributed to the 15 MiB -- which is a ~9-10x floor, about 19 MiB/s worth
of CPU, that no change to the bridge can move: Node frames, windows and streams HTTP/2 in nghttp2, in
C++, while the guest does all three in JavaScript that QuickJS runs, and the framing on its own, with
no socket and no bridge at all, is 2-3 ns/byte here against 0.2-0.4 on host. Add the waiting the
bridge costs and the same 16 MiB takes 2.1-2.8 s in the container against 0.09-0.12 s on host, so the
~9 MiB/s is the price of a JavaScript HTTP/2 on this engine and not of the transport: the identical
bytes over this container's own HTTP/1.1, on the identical bridge, are 372 MiB/s.

**Re-measured at HEAD, and the two claims in that paragraph that do not hold.** The gap and its cause
both survive, but "no change to the bridge can move" is too strong for the wall clock, and "this
engine" is the wrong subject. Three 16 MiB runs, one process each, at machine load 23-45 (never idle,
so a floor again): HTTP/2 took 2092-3055 ms here against the host's 68-108 ms, and HTTP/1.1 took
443-715 ms against the host's 31-42 ms. Counting macrotask hops in that same process and pricing them
with a `setImmediate` chain measured there -- 1.41-1.92 ms per turn here against 0.043-0.077 ms on
host, a 20-40x penalty -- turns account for 1103 of the 2092 ms of HTTP/2 (53%) and 365 of the 443 ms
of HTTP/1.1 (82%), and that term moves with the machine: it fell from 1.92 to 1.41 ms per turn as the
load fell from 45 to 23. What is left is 59-93 ns per byte for HTTP/2 and 4.6-13 for HTTP/1.1, against
the host's 4.1-5.4 and 1.9-2.0 -- so HTTP/2 is ~15x the host's per-byte work where HTTP/1.1 is ~2.5x,
and HTTP/2 costs 6-13x this container's own HTTP/1.1 where the host's HTTP/2 costs 2.2-2.6x its own.
The outlier is still HTTP/2 and the transport is still not the cause; but the largest single term in
the wall clock is a bridge turn, and it is movable. It is not the engine's byte throughput either: the
guest copies 16 MiB in 64 KiB blocks at 0.20 ns/byte against the host's 0.046, and concats 16 MiB at
0.083 against 0.053 -- 1.6-4.5x, not the ~15x the HTTP/2 path shows.

**Re-measured on a quieter machine, and the gap TCP and HTTP/1.1 are still said to have closed.**
They have not. 16 MiB over loopback, server and client in one process, one write in flight, three
container runs beside three host runs at machine load 9-12: TCP upload is 47.6-49.1 MiB/s here
against the host's 800-1333, and HTTP/1.1 upload 40.3-46.0 against 571-1143 -- 17-21x at 64 KiB and
16-27x at 1 MiB, and flat in chunk size here where the host scales with it. The gap is not the
engine's byte work and not the 64 KiB piece size the hub delivers in -- host Node shows the same
~262 `'data'` events per 16 MiB at every chunk size -- but one macrotask turn per delivery: a
fixed count of 256 writes costs 0.215 ms per call at 1 KiB and 1.367 at 64 KiB, and the difference
is 252 extra 64 KiB deliveries, which is 1.17 ms each, the guest's own `setImmediate` turn (1.1675 ms
against the host's 0.02). The lower bound is a capability round trip with no payload, 0.145 ms here
against the host's 0.004. That turn cost is filed as its own row rather than fixed here.

**Re-measured at HEAD `9376836`, one process per side, machine load 7.9-10.2 with about 500-540 MB
free.** The turn is the whole gap and it has not moved. A 300-hop chain prices a guest macrotask at
`setImmediate` 1.267 ms/turn, `setTimeout(f, 0)` 1.315 and `setTimeout(f, 1)` 1.246, against host
Node 24.15's 0.021, 1.278 and 1.240 on the same script: `setImmediate` is 60x the host's and the two
`setTimeout`s are already the host's own 1 ms, so the guest has no cheaper phase to schedule onto.
16 MiB over loopback in that same process -- TCP upload 383 ms (41.8 MiB/s) against the host's 28 ms
(571), download 374 against 23, HTTP/1.1 upload 386 against 20, download 403 against 16, HTTP/2
upload 1551 against 57 and download 1738 against 35 -- with 256 `'data'` events per 16 MiB on both
sides at 1.496 ms per event here against the host's 0.103. The clamp is
`if (!(delay >= 1)) delay = 1` in `scheduleTimer`
(`packages/core/src/process/executors/node/runtime/guest/loader.ts:975`, the clamp on `:980`), which `setImmediateImpl`
reaches with a delay of `0` (`loader.ts:1054`); the host side adds a 0 ms timer per delivery at
`packages/core/src/network/virtual/hub.ts:530` and `:546` (both line numbers re-read at HEAD `1ff048b`; the row
cites `968`/`1043` and `525`/`541`, which is where they stood at `9376836`). Both files are outside this shard's grant,
so the site is named and not edited -- and routing every host-side 0 ms timer onto the check phase
moves TCP upload 516 -> 453 ms while leaving the per-turn cost at 1.285 ms, which is what pins it.

**Re-measured at HEAD `1ff048b`, one process per side on a quiet machine (load 6.6-10.0, ~62% memory free), and
the floor has not moved.** A 300-hop chain in one container boot prices a guest macrotask at `setImmediate`
1.329 and then 1.286 ms/turn over two runs, `setTimeout(f, 0)` 1.433 and 1.289, `setTimeout(f, 1)` 1.279 and 1.264,
against host node v24.15.0's 0.0159 and 0.0169, 1.243 and 1.253 and 1.234 and 1.242 on the identical script: `setImmediate`
-- the one the runtime's own streams use -- is 76-84x the host's, while the
two `setTimeout`s are within 1.15x of the host's own 1 ms, so the guest still has no cheaper phase to schedule onto.
16 MiB over loopback in that same process: TCP 385 and 366 ms (41.6 and 43.8 MiB/s) against the host's 36 and 41 ms
(448.6 and 393), and HTTP/1.1 402 and 405 ms (39.8 and 39.5 MiB/s) against the host's 42 and 22 ms (376.9 and 725.5) -- 256 `'data'` events per 16 MiB on the container side against
269 on the host, so the hub's fixed 64 KiB piece size is the same shape on both and only the price per piece differs.
Neither acceptance criterion is met: `setImmediate` is ~84x and not within 2x, and loopback throughput is ~10x out and
not within 2x. The fix sites stay outside this shard's grant, so the row is closed stale with these numbers rather than
fixed.

### 🚧 In Progress

- **Network Simulation hardening**
  - Virtual TCP/UDP network, HTTP and preview routing are implemented (see above)
  - Still open: HTTP/3, sandbox security review (HTTP keep-alive works)

### ⚠️ Shell divergences from the host that are recorded rather than fixed

Each of these was measured by running the same command line on the host's `/bin/sh` and in the container
and diffing stdout, stderr and the exit code. Where the two cannot agree, the reason is here.

- **`zip --version`** prints the container's own banner (`zip 0.1.0 (OpenWebContainer)`, compiled with
  fflate's deflate at level 6) and exits 0. The host's banner names Info-ZIP 3.0, Apple's compiler and a
  build date -- a program that is not the one running here, so a line that only looked like the host's
  would be a line about something else.
- **`curl --version`** and **`wget --version`**, in the shell and from `execSync`/`spawnSync`, print the
  container's own version the same way. The host's names libcurl 8.7.1, its protocol list and its
  feature list; this one prints `fetch`.
- **`execSync('curl <url>')` still refuses.** A synchronous child has no way to wait for the host work a
  request needs, so it reports that rather than a status that means nothing. A `curl` that names no URL
  has nothing to wait for and does answer: the container's own usage failure, with curl's status 2.
- **`ifconfig`** lists the virtual network hub's own state, read live through the command context: the
  loopback interface, and under it every address, listener and connection the hub holds at that moment.
  The host lists its physical interfaces (`lo0`, `en0`, `awdl0`, ...). The container has no NICs, no
  hardware address, no MTU and no packet counters, so none of those lines can exist here.
- **`lspci`, and the other hardware utilities that report a named reason, exit 1; the host has no `lspci`
  at all and its shell exits 127.** `lspci 2>/dev/null` therefore prints nothing and leaves 1, where the
  host leaves 127. The redirection itself is fixed: `/dev/null` is a sink.
- **`/dev/null` in a redirection is a sink, not a file.** What is written to it is discarded and what is
  read from it is empty. No `/dev` directory is created and nothing else in the tree learns the name.
- **`timeout` measures its deadline after the command, not during it.** The container has no signal to
  deliver to a command that is still running, so the command finishes and the wall
  clock decides: one that ran over its duration reports 124, or 128 plus the signal for `-s` or
  `--preserve-status`, but it ran to completion -- its output is the whole output, not the part it had
  written when the deadline passed. A guest that never finishes is stopped on its own budget instead,
  not by `timeout`: see [Stopping a runaway guest](#-stopping-a-runaway-guest).
- **`unexpand -t` with a list whose stops are adjacent (`-t 1,2`, `-t 2,3`) does not reproduce the host's
  own behaviour.** Lists whose stops are two or more columns apart (`-t 1,3`, `-t 4,8`) do, for every
  blank-run length measured. The host's list parser treats the degenerate case in a way this one does not.
- **`chmod -R` reports the entries of a tree in this file system's walk order, not the host's directory order.**
  `mkdir d; touch d/f d/g; chmod -R 2755 d` prints `d`, `d/f`, `d/g` here and `d`, `d/g`, `d/f` on the host.
  Every entry is reported and the count is the same; only the order differs, and the host's own order is
  neither creation nor sorted order -- on this machine `touch a b c; ls -f` printed `a c b`, so there is no
  order to reproduce.
- **`ls -ld` of the container's own directories names the user the shell runs as, where the host names `root`,
  and `ls -ln` prints `0` where the host prints the real uid.** `ls -ld /bin` is `dylanwong wheel` here and
  `root wheel` on the host; `ls -ln f` is `0 0` here and `501 0` there. The container keeps no account
  database, so nothing in it can belong to another user. A name the shell itself creates does match --
  `touch f; ls -l f` is `dylanwong wheel` on both, and `export USER=zzz` no longer moves the column, as it
  does not on a host.
- **`ls -f` lists in the order this file system made the names, where the host lists in its own directory
  order.** `touch a b c d; ls -f` prints `. .. a b c d` here and `. .. a c d b` on the host, and the host's
  order does not follow the order the names were made in -- `touch d c b a; ls -f` is still `. .. a c d b`
  -- so it is a hash of the names, not an order this file system can derive. Three names happen to agree,
  which is why `touch f; mkdir d; ln -s f l; ls -f` is `. .. f d l` on both sides.
- **`ls -ld` of a directory prints this file system's own link count and size, where the host prints the ones its
  directory really has.** `mkdir -p d; touch d/a; ls -ld d` is `drwxr-xr-x 2 ... 2 d` here and
  `drwxr-xr-x 3 ... 96 d` on the host, and an empty `d` is `2 ... 2` here and `2 ... 64` there. The container's
  file system keeps no directory size and no link count for a directory, so both columns are the same for every
  directory. (Open row `owc-shell-ls-dir-size-nlink`.)
- **`ls` ignores `-L`, `-H` and `-P`, so a link is never followed where the host follows it.** `mkdir F;
  touch F/a; ln -s F/a FL; ls -lL FL` prints the target's `-rw-r--r-- ... FL` with a status of 0 on the
  host and the link's `lrwxr-xr-x ... FL -> F/a` here; `chmod 644 F; ls -lL FL` is `ls: FL: No such file
  or directory` with a status of 1 there, and the same link line with a status of 0 here.
- **`/etc/hosts` is not in the container's file system, and `/tmp` is a directory here where this host has it as
  a symlink to `private/tmp`.** Both are facts about the two trees, not about `ls`: `ls -l /etc/hosts` fails
  here with `No such file or directory` and `ls -ld /tmp` prints `drwxrwxrwt` where the host prints
  `lrwxr-xr-x ... /tmp -> private/tmp`.
- **A trailing newline.** The container writes a command's stderr exactly as the command left it; the host
  adds one only where the text has none.
- **A redirection whose target is in a directory that is not there fails with the container's own message.**
  `echo hi >> /nodir/f` writes `Failed to redirect to /nodir/f: ENOENT: No such file or directory, '/nodir'`
  where the host writes `/bin/sh: /nodir/f: No such file or directory`. Both leave status 1 and write
  nothing. The new-file case itself is fixed: `echo hi >> newfile` creates the file and writes to it,
  as the host does.
- **`command -v` answers with the path or the bare name, as a host does** -- `/bin/ls`, `/bin/sh`, `echo`,
  `cd` -- and `command -V` and `type` keep the wording that describes (`ls is /bin/ls`, `cd is a shell
  builtin`). Every command the container runs as one of its own built-ins also has a file on `PATH`, the way
  `sh`, `ls`, `cat`, `echo`, `env`, `node`, `npm` and `npx` do. Three names have no file: `git` is not in the
  container at all, and `grep` and `sed` are reached through the shell's runner, which a file on `PATH` would
  outrank -- give them one and `command -v grep` starts answering while `grep` itself stops working, so
  `command -v grep`, `command -v sed` and `command -v git` exit 1 where a host names a file. That is three
  names because they are built-ins, not because the coverage stops there: a further **46 names a host
  resolves have no file here at all and `command -v` of them exits 1** -- `bash awk tar curl python3 head wc
  sort find uname date sleep chmod id dirname basename xargs tr uniq tail tee make cc git yarn pnpm tsc perl
  ruby less man vi sudo bun clear hostname ps ln du df stat file diff patch ssh openssl zip unzip gzip
  gunzip` -- and of those, the ones the shell runs as built-ins anyway (`head`, `tail`, `wc`, `sort`,
  `uniq`, `grep`, `sed`, `awk`, `cut`, `tr`, `xargs`, `tee`, `dirname`, `basename`, `date`, `chmod`, `sleep`)
  produce byte-identical output for a host, so `command -v` under-reports what the container can run.
  Six that do answer print the bare name where a host prints a path (`mkdir`, `rm`, `cp`, `mv`, `touch`,
  `which`), and `npx --version` exits 1 with `npx: a command or package is required` where a host prints
  `11.12.1`.
- **`owc-shell-bash32-extensions` (closed): this machine's `/bin/sh` is bash 3.2, and the guest shell
  now has the syntax that makes it one.** `arr=(x y z); echo ${arr[1]}` is `y`, `[[ abc == a* ]]` is
  `matched` (it was `sh: [[: command not found` with 127), `echo a{b,c}d` is `abd acd`,
  `true | false | true; echo ${PIPESTATUS[1]}` is `1`, `k=target; target=hit; echo ${!k}` is `hit`,
  `set -o` names the same 27 options in the same order with the same `on`/`off` behind a tab (it named
  17), `$-` is `hBc` (it was `h`), `declare -i n=1; n=n+1` is `2` (it was `n+1`), `export -n FOO` and
  `hash -d ls` both leave 0, and `IFS=: read x y` splits on the colon -- an assignment in front of a
  builtin is one the builtin sees and one the shell does not keep, which is what a host does. Brace
  expansion is the expansion a host does first, so `x=q; echo pre{a,b}$x` is `preaq prebq` and
  `echo a\{b,c\}d` stays the text `a{b,c}d`; `set +B` turns it off, as on a host. Each case was run one
  per process on both sides and three times byte-identical; the 226-line differential (the row's own
  eleven, the arrays, the conditional, the braces, `PIPESTATUS`, indirection, the options and a
  general shell regression set) leaves 14 differences and none of them is this row's: `set -n` runs
  where a host stops and `set -v` traces where a host does not, three are the container's own
  no-nested-`sh` boundary, six are the two trees (`$HOME`, `ls /`, `[[ -f /etc/hosts ]]`), and three
  are the `$0` a host prints as `/bin/sh` where this shell prints `sh`.
- **`$PPID` and `$SHLVL` name the process a shell is running in, and no value this shell can hold matches a
  host's.** `echo $PPID` is the pid of whatever started the host's `sh` -- 64646 in one run and 69271 in the
  next -- and `echo $SHLVL` is how many shells deep it was started (3 in the measured run), so this shell
  answers the pid it was given and `1`. Every other variable a host's `/bin/sh` sets does agree:
  `BASH_VERSION`, `BASH_VERSINFO` (as the array it is, so `${BASH_VERSINFO[0]}` is `3`), `UID`, `EUID`,
  `SHELLOPTS`, `MACHTYPE`, `OSTYPE`, `HOSTTYPE` and `LINENO`.
- **`[[ a -nt b ]]` and `[[ a -ot b ]]` are false for every pair of files that are there, because this file
  system keeps no modification time with a file.** A host comparing a file with itself answers false too --
  `[[ /bin/sh -nt /bin/sh ]]` is false there -- which is what the two agree on; `touch a; sleep 1; touch b;
  [[ b -nt a ]]` is true on the host and false here. `test -nt` reads a real `mtimeMs` where it has one and
  is subject to the same gap. `[[ -w ]]`, `-x` and `-r` answer from a file's *mode* against the account the
  shell runs as, as a host does: `[[ -w /bin/sh ]]` is false, that file being `-rwxr-xr-x` and owned by
  root, while `touch f; [[ -w f ]]` is true. Who owns a name is decided the way `ls -ln` decides it -- the
  directories the container was built with belong to root, and the tree the shell was started in, with
  every name the shell made in it, belongs to the account it runs as -- which is the one thing a mode is
  read against that this file system has no table of its own for.
- **A mode `chmod` sets does not outlive the `sh -c` line that set it.** The metadata side table it writes is
  keyed by the file system object a line was handed, so `chmod 700 f` in one `sh -c` and `ls -l f` in the next
  prints `-rw-r--r--`, where a host prints `-rwx------`; within one line the mode is there. Separately, a
  directory the walk has no read bit for is still descended: `chmod -R 000 d; cat d/c` is `Permission denied`
  on the host and prints the file here, though `chmod -R 000 d` itself now reports the same
  `chmod: d: Permission denied` and status 1 on both.
- **A `sh -c` line the caller's `timeout` ended closes as soon as it exits, where a host's `close` waits for
  the grandchild that outlived the shell.** `spawn('sh', ['-c', 'echo A; sleep 3; echo B'], { timeout: 400,
  killSignal: 'SIGKILL' })` exits at 405 ms here with `A\n`, as host node 24.15 exits at 406 ms, and closes
  at 406 ms here against 3015 ms there: the `sleep` the host's `sh` had started was never signalled, ran its
  3 s out and held the stdout pipe open until then. A killed child's `close` follows its `exit` at once in
  this container -- the piped streams are ended at the exit -- so there is nothing here to hold a pipe the way
  an orphaned process holds one on a host.
- **A `trap ... TERM` in a `sh -c` line never runs when the caller's `timeout` ends the line.** Host node
  24.15 hands its `killSignal` to the `sh` it spawned and lets the shell decide what a signal means:
  `spawn('sh', ['-c', 'trap "echo TRAPPED" TERM; echo A; sleep 2; echo B'], { timeout: 400, killSignal:
  'SIGTERM' })` prints `A`, `TRAPPED`, `B` and exits 0 at 2010 ms there, and prints `A` with signal SIGTERM
  and no status at 404 ms here. The caller's timer terminates the shell process rather than delivering the
  signal into it, and the exit the caller is given is the kill's, not the line's.
- **A `timeout` on a `sh -c` line ends the line's own child as well.** `spawn('sh', ['-c', 'echo shell; node
  busy.js'], { timeout: 400, killSignal: 'SIGKILL' })` closes at 408 ms here with `shell`, where host node
  24.15 closes at 5033 ms with `shell` and `BUSY-DONE`: the host kills only the `sh` it spawned, and the
  `node` that `sh` started runs its 5 s out. The bound has to travel to that child here, because a guest
  busy-looping holds the host thread and bare QuickJS 0.32 owns no timer of its own -- `typeof os`, `typeof
  setTimeout` and `typeof setInterval` are all `undefined` there, and a host timer armed for 400 ms before a
  synchronous 3 s wait inside that engine fires at 3001 ms -- and what would keep the pipe open afterwards is
  the missing orphan of the bullet above.

### ⚠️ Guest `fs` and `process` divergences from the host that are recorded rather than fixed

Each of these was measured by running the same script under host Node 24.15 and in the container and
diffing stdout, stderr and the exit code. Where the two cannot agree, the reason is here.

- **`process.stdout` is one of node's own classes, with the gaps a container leaves.** It carries `fd` 1 (2
  for `stderr`), `writable` true, `readable` false, a `writableHighWaterMark` of 65536 and a `pipe` that
  refuses with `ERR_STREAM_CANNOT_PIPE` as a host's does. Its prototype chain is the stream module's own
  `Writable > Stream > EventEmitter` under a `SyncWriteStream`, so `process.stdout instanceof
  require('stream').Stream` is true as on a host, and `write`, `end`, `cork`, `uncork`, `destroy`,
  `destroySoon`, `setDefaultEncoding` and `_write` are all there -- `end()` emits `finish` then `close`, and
  a chunk that is a `Buffer`, a `TypedArray` or a `DataView` is decoded as UTF-8 bytes, so
  `stdout.write(new TextEncoder().encode('Hi!'))` prints `Hi!` and `stdout.write(new ArrayBuffer(0))` throws
  the host's `ERR_INVALID_ARG_TYPE`. Send a host's output to a pipe instead and *that* stream is a `Socket`,
  and its `stdin` a `ReadStream` over `fd` 0 -- classes a container cannot hold -- so the shape agrees
  against a file and not against a pipe, and `process.stdout` keeps one own property a host's does not
  (`_eventsCount`).
- **`domain` measured against host node 24.15 at HEAD `4c7b424`, one fresh container per case: three
  residuals of a surface that otherwise agrees.** (1) A `setImmediate` callback reads `domain._stack`
  one shallower than the host's while the domain is still entered -- with one `d.enter()` the host
  reads 3 where this container reads 2, with two nested enters 4 against 3, inside an immediate
  nested in an immediate 3 against 2 -- while `process.nextTick` and `setTimeout` agree at `N+1` in
  every one of those, and an immediate that fires after the domain was exited agrees at 1 on both.
  Host node enters twice for an immediate and once for a tick or a timer; the site is the immediate's
  domain enter in the guest timer driver (`runtime/guest/loader.ts`). (2) Host node 24.15 writes
  `[DEP0097] DeprecationWarning: Using a domain property in MakeCallback is deprecated...` to stderr
  for a `d.bind(...)` call and for every immediate that runs while a domain is entered, and
  `PromiseRejectionHandledWarning` for a rejection handled after it was reported; this container
  writes nothing there. stdout and the exit code agree in every one of those cases, so the gap is
  stderr and nothing else, and it is the container's whole deprecation-warning surface rather than
  one route. (3) A domain's own `'error'` handler that throws ends the run differently:
  `d.on('error', () => { throw new Error('handler-threw'); })` with the domain handling a throw out of
  `d.run` prints the handler's line on both sides and then exits 7 on host node 24.15 against 1 here.
  Everything else measured in this wave now agrees, and three of those agreements are new: a fresh
  `domain.create()` is the emitter host node builds (`Object.getOwnPropertyNames(d)` is
  `_events,_eventsCount,_maxListeners,domain,members` on both, `_eventsCount` 2, `eventNames()`
  `newListener,removeListener`), `d.enter(); d.on('error', fn)` answers
  `process.hasUncaughtExceptionCaptureCallback()` `false` on both, and a nested uncaught route leaves
  the process on `process.domain` `undefined` when the innermost of two entered domains handled the
  error and `null` when only one was entered or an outer one handled it. An unhandled rejection goes
  to the domain that was active when the promise *rejected*, not the one it was built in -- a promise
  built outside every domain and rejected inside `d.run(...)` prints the domain's handler on both
  sides, and the same promise built inside `d.run(...)` and rejected after it returned prints a
  process `unhandledRejection` listener on both -- and over the eight combinations of a domain that
  listens, an `uncaughtException` listener and an `unhandledRejection` listener the two sides now
  agree on stdout, stderr and exit code in all eight.
- **`process.setuid` and the rest of the id surface are refused, not missing.** `getuid`, `geteuid`, `getgid`,
  `getegid` and `getgroups` answer, and `setuid`, `seteuid`, `setgid`, `setegid`, `setgroups` and
  `initgroups` throw the host's `EPERM` as they do for a process that is not root; `getgroups` returns the
  one group this process has, where a host on this machine returns sixteen.
- **`process.ppid` is 0 for a process the container started itself, and a child's is the pid of the
  process that spawned it.** A host's `ppid` is the pid of the shell that started it, and a host's
  child reports the pid of its parent the same way; the container reports that pid for every process
  it starts with a parent, and 0 for one it starts on its own, because there is no process behind it
  to name.
- **`process.argv[0]` is the path and `process.argv0` is the name, as on a host.** A host's `argv0`
  is `node`, because that is the word the shell invoked, while its `argv[0]` carries the resolved
  path; the container reports the same pair, so `process.title` (`'node'`) and `process.argv0` agree
  as a host's agree.
- **`os.networkInterfaces()` reports the loopback alone.** `lo` carries `127.0.0.1` and `::1` with the netmask,
  family and cidr a host's entries carry, where a host reports eleven interfaces of its own: a container's
  sockets are the host's, so it has no address of a network of its own to name, and a package that picks an
  address out of the map finds the loopback and nothing else.
- **A guest stack frame names no receiver.** Measured at HEAD: `new E().methodFrame()` gives
  `    at /app/main.js:77:56` where host Node 24.15 gives `    at E.methodFrame (/app/main.js:77:47)`,
  `new Foo()` gives `    at Foo (/app/main.js:80:33)` where the host gives `    at new Foo (...)`, and
  `Bar.sm()` gives `    at /app/main.js:83:39` where the host gives `    at Bar.sm (...)`; a getter whose
  function carries a name -- `    at get gg (/app/main.js:86:44)` -- reads the same on both sides, and so
  does a named function's `    at inner (...)`. The receiver a frame was called on is not something this
  engine writes into a frame it writes, so no guest-side reading of the text can put it there: bare
  QuickJS 0.32 with no container in the way writes `    at <anonymous> (...)` for the method and the
  static call and `    at Foo (...)` for the constructor, which is what this container is handed.
  (`owc-guest-error-stack-frame-shape`.) What a host does name is
  named now: a trace keeps no frame of this container's own -- where it ended with `at call (native)`,
  `at loadCJS (owc-bootstrap.js:...)` and `at runMain (owc-bootstrap.js:...)`, which no host trace has,
  it ends with the frames of node's own CommonJS loader -- the body of a module is `at Object.<anonymous>`
  and not `at <anonymous>`, and the anonymous function a host leaves unnamed is the bare location.
  That is true of an error the guest constructs, and of every error this container prints, including one
  the engine raised itself: an uncaught throw, `console.log(e)`, `console.error(e)` and `util.inspect(e)`
  all put node's eight loader frames behind `at Object.<anonymous> (/app/main.js:3:2)` where they used to
  name the bootstrap. What it does not reach is one property -- the `err.stack` of an error the engine
  raised itself, which is its own data property written at the throw site and still opens with a frame,
  still carries the bootstrap's frames, and whose column on line 1 of a required module is still 61 wide
  (`owc-guest-error-engine-stack-no-header` below); a trace out of an **ES module** names node's own
  ESM loader behind the module now (`owc-esm-runtime-stack-frames`). `util.inspect(new Error('boom'))`, an uncaught
  throw and an error the guest constructs all carry the `Error: boom` header.
- **`/dev` holds four devices where a host holds hundreds.** `/dev/null`, `/dev/zero`, `/dev/random` and
  `/dev/urandom` are mounted as character devices and `fs.statSync('/dev/null')` agrees with the host --
  `isFile()` false, `isCharacterDevice()` true, `mode` 8630 -- and a read of `/dev/zero` gives eight zero
  bytes and of `/dev/urandom` eight that are not; `fstatSync` of an open descriptor of one says `size` 0,
  as a host's does, and a `chmodSync` or `fchmodSync` of one is refused with the host's `EPERM` rather
  than being taken and leaving the device a regular file. A write is discarded by all four but
  `/dev/urandom`: that is the one a host refuses to be seeded through, so it is refused here too.
  `/dev` itself is `dr-xr-xr-x` and nothing can be made
  in it, as on a host: `mkdir /dev/sub` is refused. What is still recorded rather than fixed:
  - `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/fd`, `/dev/console` and `/dev/ptmx` -- and
    `/dev/tty`, below -- are not there: `echo x > /dev/stdout` is refused in the container where a host
    prints `x`, and `fs.writeFileSync('/dev/stdout', ...)`, which is a common CLI idiom, is `EPERM` here
    against `ok` on a host.
  - `stat` carries `mode`, `size` and `type` only: `rdev` is 0 where a host's is 50331650 for
    `/dev/null`, and `dev`, `ino`, `nlink` and `blksize` differ. A host's `rdev` encodes *this* macOS
    major/minor (3,2) while the container is Linux-shaped, so even a derived one would not agree here.
  - A whole-file read of a stream device is bounded here and endless on a host: `readFileSync('/dev/zero')`
    hands back 4096 bytes, where the host call never returns at all.
  - `ls /dev` lists four names; this host lists 354, and the container owns no disks or terminals to list.
  - A device cannot be moved or removed, and the code is now the host's own: `renameSync('/dev/null', x)`,
    `unlinkSync('/dev/null')`, `rmSync('/dev/null')`, `mkdir /dev/sub`, a write of `/dev/newfile` and a
    symlink in `/dev` are all `EPERM` on both. Two still differ: `rmdir /dev` is `ENOTEMPTY` here where a
    host's is `EBUSY`, and `utimesSync('/dev/null')` is accepted here where a host's is `EACCES`.
  - A trailing slash is dropped, so `/dev/null/` exists and reads 0 where a host answers `ENOTDIR`, and
    `ls -d /dev/null/` lists it where a host says "Not a directory".
  - `ls -l /dev/null` prints `-rw-rw-rw-` and a size of 0 where a host prints `crw-rw-rw-` and the device
    number in the size column.
  - Binary bytes read through the shell's text pipeline are not byte-exact: `head -c 8 /dev/urandom | wc -c`
    counted 12 where a host counts 8, and `dd if=/dev/zero bs=1 count=4` reads 0 where a host reads 4.
  `/dev/tty` is the one a guest reaches for that is not
  there: `fs.existsSync('/dev/tty')` is false and `test -e /dev/tty` leaves 1, where a host leaves 0.
- **The files on `PATH` are scripts, not binaries.** `/bin/sh`, `/bin/ls`, `/bin/cat`, `/bin/echo` and
  `/usr/bin/env` are created at boot beside `/usr/local/bin/node`, as executable files holding the script
  that runs the command, so `which ls`, `which cat`, `which env` and `command -v sh` all answer where they
  used to fail. `fs.readFileSync('/bin/ls')` hands back that script where a host hands back an executable's
  bytes: a browser container can have no binary, and the commands themselves are built into the shell and
  run without a file.
- **A hard link's hold on its bytes is the first name's.** `fs.linkSync(a, b)` gives both names an
  `st_nlink` of 2 and an `st_ino` they share, and a write through either is read back through the other,
  which is what `fs-extra`'s `ensureLinkSync` asks of one. Removing the *first* name is where the two part
  company: ext4 keeps the bytes for the names that remain, and here the copy the second name was given is
  what a read of it finds from then on.
- **`fs.statSync`'s `ino` is a number this file system made up.** It is not 0, it survives a write and it
  differs between two files, as a host's does; the number itself is a counter here, not an inode on a disk.
  `blocks` is now the host's own figure -- `Math.ceil(size / 4096) * 8`, so 8 for a 2-byte file and 16 for a
  5000-byte one -- where it used to be `size / 512` rounded up.
- **`module.paths` is as long as the file's path is deep.** `require.resolve('node:fs')` now answers
  `'node:fs'`, as the host does, and `module.paths` is the list of `node_modules` directories Node builds --
  one beside the file's own directory, then one beside each directory above it, out to `/`. Its *length*
  follows the path: 2 for `/app/main.js` where the host's `/private/tmp/.../probe/main.js` gives 6, because
  the host's file is four directories deeper.
- **`os.cpus()` and `os.machine()` report the machine under the container, and `os.version()` a release
  string of this container's own.** `os.cpus()` holds one entry per cpu that machine has -- 11 here, so
  `os.availableParallelism()` is 11 too, as they are on the host -- rather than the empty list it was; the
  `model` of an entry is this container's name for it, not the host's `Apple M3 Pro`. `os.machine()` answers
  `x86_64`, which is what Node answers for the `process.arch` this container reports (`x64`), where the
  host's `arm64` goes with its own `arch`. `process.versions.uv` is `1.51.0`, the libuv of the Node it models.
- **`process.allowedNodeEnvironmentFlags` holds 271 of the flags the host's holds 274 of.** It is the
  `Set` of flags Node 24.15 accepts in `NODE_OPTIONS`, so `has()` answers as the host's does for every flag
  measured (`--experimental-vm-modules`, `--max-old-space-size`, `--no-warnings`, and false for one that is
  not a flag). The three the host counts but does not yield are its own: this set is what its iterator gives.
- **A runtime `process.env.X = v` *is* inherited by a child the process spawns, as on the host.** A later
  `spawnSync('sh', ['-c', 'echo $X'])` and a later `node` child both see the new value. `Object.getPrototypeOf(process.env)`
  is not `Object.prototype` either, which is what the host reports for its own.
- **The default working directory is `/app`, the directory a container's project is put in.** It is what
  the host's "the directory you started me in" is here, and it is what `process.cwd()`, a shell `pwd` and
  `process.env.PWD` all answer now; they answered `/` before, so a relative path written without a `cwd`
  option landed at the root. A `cwd` passed to `spawn`/`exec` is honoured over it, and so is `cd`.
- **`process.on('exit')` handlers *do* run when the process dies on the fatal path, as on the host.** After
  an uncaught throw or an unhandled rejection the process writes what an `exit` handler writes (`exit=1`)
  after the error, and ends with status 1; a `process.on('uncaughtException')` handler is called, and the
  status it leaves is the status the process leaves (`caught:boom`, `exit=7`, status 7), which is what the
  host does with the same three scripts. A normal exit runs them as it always did.

### ⚠️ `node` with no arguments: the REPL, and where it differs from host node

`node` with no arguments starts a REPL instead of throwing. It reads `process.stdin`, writes to
`process.stdout` with the `> ` prompt and the `| ` continuation, and ends the process with status 0 when
the REPL closes — the `.exit` keyword, or the end of its input (Ctrl-D, on a terminal that delivers it).
`container.spawn('node', [])` starts the same REPL; a caller feeds it with `process.writeInput()`.

The same expressions through both, measured against this machine's `node -i` (v24.15.0):

| input | host node | container |
| --- | --- | --- |
| `typeof process` | `'object'` | `'object'` |
| `require("path").join("a","b")` | `'a/b'` | `'a/b'` |
| `1+1` | `2` | `2` |
| `}` | the line, a caret, then `Uncaught SyntaxError: Unexpected token '}'` | `Uncaught SyntaxError: expecting ')'` |
| `var y = {` then `2+2` | the offending line, a caret, then `Uncaught SyntaxError: Unexpected token '+'` | `Uncaught SyntaxError: expecting ':'` |
| `undefined` | `undefined` | `undefined` |
| `const x = 5` | `undefined` | `undefined` |
| `x` | `5` | `5` |
| `_`, the last result | `5` | `5` |

Recorded rather than fixed:

- **No welcome banner.** Host node prints `Welcome to Node.js v24.15.0.` and `Type ".help" for more
  information.` above the first prompt; this one prints the prompt only.
- **A syntax error prints its message alone.** Host node echoes the offending line and a caret under the
  token. QuickJS reports its own message, and the REPL has no source line to echo: bare QuickJS 0.31 with
  no container in the way reports the same errors with a `stack` of `    at eval.js:2` — a line number and
  nothing else — so there is no column for a caret to sit under.
- **A syntax error inside a multi-line entry is reported, at the line that closes it and not before.**
  Which entry is unfinished is decided the way host node decides it — by whether the parser only reaches
  its error after it has read end-of-input — so `var y = {` on one line and `2+2` on the next is an error
  and not an object waiting for a `}`. The two remaining shapes disagree: `return` on a line of its own
  and the partial number `2e` are unfinished here where host node reports them, and `a.` is reported here
  where host node waits for the property name.
- **No line editing.** Arrow keys, history, Backspace and tab completion do nothing: the REPL reads whole
  lines, and an editing key is dropped rather than echoed into the session.
- **Ctrl-D arrives only where the terminal sends it.** The playground's xterm pane drops every Ctrl key
  before it reaches the shell (`apps/playground/src/components/Terminal/index.tsx`), so Ctrl-D and Ctrl-C
  never reach the REPL there; `.exit` is the way out. `process.writeInput('\x04')` ends the session.
- **A spawned child's output is written twice** — once as it is produced, and once more from the result
  the shell gets back. That predates the REPL: `sh -c 'node -e "console.log(1)"'` also prints `1` twice.
- **In a class body, `get` or `set` followed by a line break is a field plus a method, where host node
  reads an accessor.** `class A { get` on one line and `foo() { return 1; }` on the next gives
  `typeof new A().foo === 'function'` here and `'number'` under host Node 24.15: QuickJS 0.32 ends the
  class element at the line break, V8 does not. Recorded rather than fixed: the engine accepts this
  source, so it reaches the engine unchanged, and no rewrite that leaves every line where it was makes
  the two agree — QuickJS also ends the element at a line terminator inside a `/* */` comment.
  It is not only that shape: `static get`, `set`, and numeric, string and computed names misparse the
  same way (`static get` on one line and `foo() {}` on the next becomes an instance method here —
  `A.foo` undefined and `A.prototype.foo` a function, where host is the reverse), and
  `class A { get` on one line and `async foo() { }` on the next — which host Node rejects outright
  with `SyntaxError: Unexpected identifier 'foo'` — is accepted and run here.
  Not only a class body, though it is only a class body: the object-literal forms `{ get` / `foo() { return 1; } }`
  and `{ set` / `foo(v) { }` agree with host Node 24.15 in all three arms -- both read an accessor -- so
  the shape is the class body's and not `get` followed by a line break, and it is not only a value that
  differs: `class A { get` on one line and `foo = 1;` on the next is a `SyntaxError` under host Node 24.15
  (`Unexpected token '='`) and compiles here (`typeof new A().foo` is `number`). Bare QuickJS 0.32 with
  (`Unexpected token '='`) and compiles here (`typeof new A().foo` is `number`).
  no container in the way parses the same source the same way (`typeof new A().foo` is `function`
  there too, against `number` under host Node 24.15), so this is the engine's own parse and not a
  rewrite of this container's. (`owc-quickjs032-get-newline`.)

Two `repl` shapes are left that no rewrite here closes, both measured against host Node 24.15: a
rejected top-level await prints no frame -- `await Promise.reject(new TypeError("bad"))` is
`> Uncaught TypeError: bad\n> ` here where the host prints `> Uncaught TypeError: bad\n    at REPL19:1:54\n> `,
the column being the offset of the throw site inside Node's own async wrapper, which is not a string
this container builds and so not one it can number; and a line that opens with a brace is
paren-wrapped by the host even when the result does not compile, so `{ await 3 }` is reported by the
host as `({ await 3 })` with `Cannot use 'await' as identifier inside an async function` and here as
the unwrapped `{ await 3 }` with the engine's `expecting ';'` -- the wrap here is tried only when
`('{' + line + '\n)')` compiles. Bare QuickJS 0.32 with no container in the way refuses
`if (1) { await 3 }` and `var a = await [1,2]` outright (`expecting ';'`, `'await' is not defined`),
so both belong to the wrapper this repl builds and not to the engine.

### ⚠️ Old toolchains that call Node internals: `npx create-react-app my-app`

`create-react-app@5.1.0` is a 2022 toolchain, and on its way to `Creating a new React app` it loads
`envinfo`, `fs-extra` and `tar-pack`, each of which reaches for a Node internal this runtime did not have.
Measured against host Node 24.15, with stdout, stderr and the exit code captured for both, the three gaps
were:

- **`process.binding('uv')`.** The `execa` bundled into `envinfo` asks for it and wants `uv.errname` plus
  the `UV_E*` constants, to turn an errno into a name. The container answered `Error: No such module: uv`
  and printed the whole stack as a warning. `process.binding` now serves `uv`: the 85 `UV_*` constants with
  the numbers Node 24.15 reports on Linux, and `errname`, which is libuv's own table -- a code's name is
  its constant without the `UV_`, so `errname(-2)` is `ENOENT` and `errname(-4094)` is `UNKNOWN`.
  `util.getSystemErrorName` shares the table and keeps Node's stricter rule: a code that is not a negative
  integer is `ERR_OUT_OF_RANGE`. One deliberate divergence is recorded here: Node's own `uv.errname`
  **aborts the process** on a code that is not negative -- `uv.errname(2)` kills host Node 24.15 with
  `Assertion failed: (err) < 0` -- and this one answers `UNKNOWN` instead, because a guest that kills its
  container is worse than one that cannot name an error.
- **`fs.realpath.native`.** `fs-extra/lib/fs/index.js:121` reads `typeof fs.realpath.native` when it loads,
  and warns `fs.realpath.native is not a function. Is fs being monkey-patched?` when it is missing.
  `fs.realpath` and `fs.realpathSync` now each carry a `.native`, as they do in Node: the same resolution,
  because here the wrapper and the binding behind it are one implementation.
- **`new Buffer(512)`.** `tar/lib/pack.js:12` is `, eof = new Buffer(512)` -- read out of the container's
  own copy of `tar@2.2.2`, not guessed. That number is a byte count, and `Buffer(arg)` handed it to
  `Buffer.from`, which has never taken a size, so it threw
  `TypeError: The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array`.
  `Buffer(size)` and `new Buffer(size)` now allocate zero-filled, the way Node does; `Buffer.from(number)`
  still throws, the way Node's does.

With those three in place `npx create-react-app my-app` installs `create-react-app` and its dependencies,
creates `/my-app`, and reaches `Installing react, react-dom, and react-scripts with cra-template...` before
npm stops the run:

```
npm error code EBADPLATFORM
npm error notsup Unsupported platform for fsevents@2.3.3: wanted {"os":["darwin"]} (current: {"os":"linux","cpu":"x64","libc":"glibc"})
```

That one is **recorded rather than fixed**. `react-scripts@5.0.1` lists `fsevents` in both `dependencies`
and `optionalDependencies` (both `^2.3.2`, read from the registry); npm treats the optional entry as the one
that decides and skips a package the platform excludes, while `src/npm/installer.ts` still enqueues the
`dependencies` edge first, with `optional: false`, and aborts on it. The change belongs to
`packages/core/src/npm/**`, in `dependenciesOf`: a name that `optionalDependencies` also lists is optional,
whatever `dependencies` says, and an optional dependency's own dependencies inherit that flag. Until it
lands, that EBADPLATFORM line is the one honest reason the run ends.

The ten-package corpus (lodash, semver, uuid, chalk, sql.js, hash-wasm, js-yaml, marked, xlsx, prettier)
is still byte-identical to host Node 24.15 after these changes.

### 📋 Upcoming Features

- Additional shell commands
- Node built-ins not yet implemented or partial: `zlib`'s `maxOutputLength` option and its `ZstdDictionary`/`BrotliCompress` native handle internals; `crypto` ciphers: `getCiphers()` now returns Node 24.15's own 130 names — DES in the `des-ede`/`des-ede3` ladders, ARIA, SM4 and Camellia are written into the capability (`@noble/ciphers` 1.3.0 carries AES alone), and `aes-128-ccm` and `aes-128-ocb` take the `authTagLength` a caller names and answer a tag of that length, so the 75 names that were missing are no longer; `bf-*`, `des-cbc`, `seed-*`, `idea-*`, `rc2-*`, `rc4`, `cast5-*` and `desx-cbc` are the ones Node's OpenSSL still names but its default provider refuses, and a caller gets its `ERR_OSSL_EVP_UNSUPPORTED` here too rather than `ERR_CRYPTO_UNKNOWN_CIPHER` — measured 2026-10-24 against host Node 24.15.0 over every mode each of them opens in. One wording gap is the engine's, not this surface's: `crypto.brotliCompressSync` and `zstdCompressSync` (and their inverses) are absent on both sides and `typeof` says `undefined` on both, but calling one is `crypto.brotliCompressSync is not a function` on the host and `not a function` here — QuickJS 0.32 names no callee in that TypeError, and it says the same bare `not a function` for `({}).nope()`, for a local `f()` and for `fs.noSuchFsMethod()`, where V8 reconstructs the source text each time, so no crypto code can close it — `getHashes()` now matches Node's 52; stream helpers: `stream/promises`' `pipeline` takes the async-generator form (`async function* (s) { for await (const x of s) yield x + '1'; }` gives `a1b1` on both sides; host Node 24.15 rejects the async-*function* form too, with `ERR_INVALID_RETURN_VALUE`) but every other function form is refused here with `ERR_INVALID_ARG_TYPE` and a message about a `body` argument where the host answers `ERR_INVALID_RETURN_VALUE` or the piped result — a plain function returning the source is `OK 'ab'` on the host and `ERR_INVALID_ARG_TYPE` here, and a sync generator is `ERR_INVALID_RETURN_VALUE` on the host and `OK 'y'` here — and `node:stream/consumers` does not resolve at all (`MODULE_NOT_FOUND`) where Node has `text` and `json`; a `Transform` stream and two `PassThrough`s do pipeline correctly, and `addAbortSignal` destroys its stream with `ABORT_ERR` as on the host; `inspector` sessions construct, `connect()` and answer `Runtime.evaluate` by evaluating the expression in the realm and returning the protocol's `RemoteObject` (measured: `1+1` gives `{"result":{"type":"number","value":2,"description":"2"}}`, byte-identical to host Node 24.15), while a method of a domain the protocol has never heard of is refused with the protocol's own error, `Inspector error -32601: 'Bogus.method' wasn't found`, as the host refuses it, and a method a real domain does not define is refused the same way (`Runtime.noSuchMethod` is `-32601` here as on a host), while `Runtime.callFunctionOn` compiles and calls the declaration in the realm (`function(){return 7}` with `returnByValue` answers `{"result":{"type":"number","value":7,"description":"7"}}` as a host's does), `Debugger.enable` answers a `debuggerId`, `Profiler.enable`, `HeapProfiler.enable`, `Network.enable` and `NodeRuntime.notifyWhenWaitingForDisconnect` answer `{}`, `Debugger.getScriptSource` answers `Inspector error -32000: No script for id: <id>` for every id, and a cyclic value under `returnByValue` is refused with `Inspector error -32000: Object reference chain is too long` rather than described; what still fails with `Inspector protocol is not available in this runtime` is every other command of a real domain this runtime cannot answer; `returnByValue` is honoured, so `Runtime.evaluate` of `({a:1})` with the flag answers `{"result":{"type":"object","value":{"a":1}}}` as the host does, and `Runtime.enable` really wires the console up: a session with `Runtime` enabled receives `Runtime.executionContextCreated` and one `Runtime.consoleAPICalled` per line the program writes; an `evaluate` without `returnByValue` now hands out an `objectId` — three dot-separated numbers, the shape a host's has — so `Runtime.getProperties` is reachable and answers the object's own entries (`[["x",1],["y",2]]` for `({x:1,y:2})`, byte-identical to host Node 24.15), `awaitPromise` settles the promise before it answers (`Promise.resolve(99)` with the flag gives `{"result":{"type":"number","value":99,"description":"99"}}`), `generatePreview` answers a `preview` of the object's own enumerable entries, `Session#post` calls back from inside the call as a host's does rather than on a timer, and the console is recorded from `connect()` and handed over when `Runtime` is enabled, so the lines a program wrote in between are the first `Runtime.consoleAPICalled` events the session sees — the whole notification stream, order and counts, is now host-identical; a thrown expression's answer now carries what a host's carries -- `exceptionId` is the host's own count, 1, 2, 3 and on for as long as the runtime lives and shared by every session rather than restarted by one, `scriptId` is one per `Runtime.evaluate`, a throw's `columnNumber` is the column of its own `throw` keyword (2 for `  throw x`, 13 for a throw inside a function the expression calls), and a rejected promise is worded `Uncaught (in promise)`, followed by ` Error: no` for an error and by nothing at all for any other value; what is left of that surface is the *number* of the two serials, which is this runtime's own as a V8 isolate's is its own and as the `objectId`'s first number already was, the column of an error the engine raises itself, which is the column in QuickJS's own stack (5 for `null.z` and 7 for `({}).a.b`, both the column host Node 24.15 answers, but 1 for `undefinedfn()` where a host answers 0), and `Runtime.getProperties`, which answers the object's own entries where a host appends the fourteen enumerable entries of `Object.prototype` and answers an id it never handed out with `Inspector error -32000: Cannot find context with specified id` (row `owc-inspector-returnbyvalue-notifications`, closed); `v8.serialize` still emits its own JSON text rather than the V8 wire format (host Node 24.15 writes `ff0f6f220161...` for `{a:1,b:'x'}`), so a buffer written here is readable here and nowhere else; `module.register` and `module.registerHooks` are exported with node's own arity and argument handling, and both record what a caller registers without ever applying it: a hooks module whose `load` returns `{ format: 'module', source: 'export const tag = "hooked";', shortCircuit: true }` for `./target.mjs` leaves a later `import('./target.mjs')` reporting `ORIGINAL` here where host Node 24.15 reports `hooked` (measured 2026-10-24, `/tmp/owc-r4/fix-me5/b-register` and `/tmp/owc-r4/fix-me5/m-reghooks`, four diff lines each). The engine is not what stops the hooks applying — `quickjs-emscripten-core` 0.32.0 declares `setModuleLoader(moduleLoader: JSModuleLoaderAsync, ...)` (`dist/index.d.ts:382`), so an async `load` hook can be awaited — but `loadModule` (`packages/core/src/process/executors/node/process.ts:3014`) and `normalizeModule` (`:3152`), wired in at `:1876`, consult no registry, and the one the two calls fill lives in the guest, which has no route into either half; `register` and `registerHooks` were two of the six names missing: `Object.getOwnPropertyNames(require('module'))` is 31 names here against host Node 24.15's 37 — the six are `register` and `registerHooks`; `stripTypeScriptTypes`, for which there is no type-stripper here (node strips types with amaro and this guest has neither that nor any TypeScript parser, so one that left the annotations in place would be worse than the gap); and `enableCompileCache`, `flushCompileCache` and `getCompileCacheDir` — while `builtinModules` is now Node 24.15's own 72 names in node's own order and `isBuiltin` answers for the same list, so `undici`, a package this container serves as if it were built in, is no longer among them, and `createRequireFromPath` is no longer exported, as Node 24 does not export it either — and 67 of those 72 are now requirable, against 51 before (measured 2026-10-24, `/tmp/owc-r4/fix-me5/h-builtins`): the five private `stream` modules, the six private `http`/`tls` ones, `assert/strict`, `trace_events`, `node:sea` and `node:test` (row `owc-module-export-table-incomplete`). Three of the six have nothing to sit on: QuickJS exposes no code cache, so `enableCompileCache`, `flushCompileCache` and `getCompileCacheDir` cannot exist here — measured with the pinned engine out of the container, `CompileCache`, `CodeCache`, `CachedData` and `WriteObject` appear in no file of `quickjs-emscripten`, of `quickjs-emscripten-core` or of the `@jitl/quickjs-singlefile-browser-release-asyncify` variant; the other three have nothing to sit on either, measured with the pinned engine out of the container: bare QuickJS 0.32 loads `./target.mjs` through the one synchronous callback `runtime.setModuleLoader` takes, with no hook registry behind it and no `hook` or `cache` method on either the runtime or the context, so `register` and `registerHooks` have no hook point to install into and no way to await an async `load` hook, and there is no type stripper in the guest for `stripTypeScriptTypes` to call (`typescript` is a devDependency of this package's build, not a module the guest can require) (row `owc-module-export-table-incomplete`, closed stale); `process.report` is present and `getReport()` returns the same 11 sections and the same 23 header keys host Node 24.15 returns (but with this container's own values — see `owc-node-report-getreport-shape`); `fs.glob` is absent, where Node 24.15 has `fs.glob` and `fs.globSync`
- Guest surfaces measured against host Node 24.15 that still diverge: `fetch` honours the `redirect` option — `manual` answers `302` with the `location`, `redirected false` and `type "basic"`, `error` rejects `TypeError: fetch failed` with cause `unexpected redirect`, `follow` answers `200` with `redirected true`, `r.url` at the last hop and `type "cors"` once a hop has left the origin, and a mode that is not one of the three is refused before anything is dialled, `null` included, which is a mode that does not exist and not a default for the absent one (row `owc-fetch-redirect-option`, closed), and a `follow` whose `Location` carries no host -- `data:`, `mailto:`, `file:` -- fails the fetch the way the host does, `TypeError: fetch failed` with cause `URL scheme must be a HTTP(S) scheme`, instead of answering the 3xx (row `owc-fetch-hostless-location-scheme-check`, closed); `crypto` answers RSA, DSA and `dh` key generation — `generateKeyPairSync('rsa', { modulusLength: 2048 })` gives `asymmetricKeyDetails` `{ modulusLength: 2048, publicExponent: 65537n }` as the host does, and its PKCS#8 and SPKI imports into host Node 24.15, whose signatures verify here and here whose verify there, at 0.1-0.6 s for RSA, 0.04-0.25 s for DSA-1024 and 0.5-5 s for DH-1024 against OpenSSL's 0.05/0.05/0.7 s, which is a speed gap and not an engine limit (row `owc-crypto-rsa-keypair`, closed) — and `getCiphers()` returns 55 names where the host returns 130, the 39 added being `aes-*-ofb`, `-cfb8`, `-cfb1`, `aes-128/256-xts` (no `aes-192-xts`: neither OpenSSL nor Node carries one), the `aes<bits>-wrap` and `-wrap-pad` families with their `id-aes*` spellings, `chacha20`, and the bare-size and OID aliases — all measured host-identical in ciphertext, in the `update()`/`final()` split (XTS answers in one shot, as OpenSSL does, and refuses a second `update()`; a wrap answers every `update()` on its own, so two of sixteen bytes are two wraps and not one of thirty-two, and a length that is not a whole number of blocks -- or is shorter than the two RFC 3394 needs -- is refused rather than wrapped as far as it goes, while RFC 5649 takes any length and an empty `update()` wraps nothing), in RFC 3394's integrity check (an alternative IV that is not the one the cipher was given is refused, not unwrapped into noise), and in the fault they name for a 32-byte key with a 16-byte IV (`ERR_CRYPTO_INVALID_KEYLEN` for `ofb`/`cfb8`/`cfb1`, `ERR_CRYPTO_INVALID_IV` for `ccm`/`ocb`/`wrap`, `ERR_OSSL_XTS_DUPLICATED_KEYS` for `xts`); what is left is `aria` (25 names), `camellia` (25), `des-ede`/`des-ede3`/`des3` (15) and `sm4` (6), each a block cipher of its own that no table here carries, so those still report `ERR_CRYPTO_UNKNOWN_CIPHER` where the host names the real fault (row `owc-crypto-cipher-coverage`). The 55 are now answered in Node's own order, which is the sorted one, and `getCipherInfo` answers for every one of them and for the spelled-out `aes-128-wrap` names `getCiphers()` does not list, with the same `mode`/`name`/`nid`/`blockSize`/`ivLength`/`keyLength` the host gives, `undefined` for a cipher not carried and for a `keyLength` or `ivLength` a caller asked for that is not the cipher's own, and a nid in place of a name; `createCipheriv`'s `authTagLength` is honoured too, 4 to 16 for GCM and chacha20-poly1305, so `getAuthTag()` after `{ authTagLength: 12 }` is the 12 bytes the host answers and not 16, a length outside that range is `ERR_CRYPTO_INVALID_AUTH_TAG` and a cipher that seals nothing ignores the option. What is left of the row is `aes-128-ccm` and `aes-128-ocb`, which are listed and refused with `ERR_CRYPTO_INVALID_AUTH_TAG` even when a caller *does* name an `authTagLength`, where the host takes one and answers ciphertext and a tag of the length asked for -- neither is a mode `@noble/ciphers` carries, so they are listed and no more; and every AEAD mode now emits from `update()` as the host does, so `createCipheriv('aes-128-gcm', ...).update(37 bytes)` answers 37 bytes here too and `final()` carries only the tag -- the keystream of an AEAD is the seal of that many zero bytes, so the bytes a call hands in come back from that call however the input is split. What is left of that surface is the short nonce: an AEAD nonce of one to seven bytes is still `ERR_CRYPTO_INVALID_IV` here where host Node 24.15 accepts one and answers a tag, and that is the engine's floor and not a choice -- measured with bare QuickJS 0.32 and no container in the way, `@noble/ciphers` 1.3.0 answers `aes/gcm: invalid nonce length` for 1, 2, 4 and 7 and accepts 8 and 12, and GCM's `J0` is derived from the nonce length, so a shorter one is a different cipher and cannot be simulated (the floor is the recorded `GCM_MIN_IV = 8` in `capabilities/crypto.ts`). `scrypt`, `hkdf`, `createDiffieHellman`, `generateKeyPairSync` for `ed25519`/`ed448`/`x25519`/`x448`/EC, `createSign`/`createVerify`/`sign`/`verify` and all 52 `getHashes()` names are now host-identical (row `owc-crypto-asymmetric-and-hashes`, closed), and the rows that stood open over them are closed on a fresh witness each: a DSA signature now honours the `dsaEncoding` it was asked for in both directions -- `crypto.sign('sha256', msg, { key: <DSA-1024>, dsaEncoding: 'ieee-p1363' })` is 56 bytes of `r||s` and not a DER SEQUENCE, a 56-byte compact signature made by host Node verifies true here and a DER one verifies false, and the two swap exactly when `dsaEncoding` is 'der' (row `owc-crypto-verify-dsaencoding-permissive`, closed); an 'rsa-pss' key is a PSS key, so a sign or a verify that names no padding runs PSS and one that names `RSA_PKCS1_PADDING` is refused with OpenSSL's own `error:1C8000A5:Provider routines::illegal or unsupported padding mode` (row `owc-crypto-rsa-keypair`, closed); `hkdfSync` takes a `SecretKeyObject` as its `ikm`, names that argument `ikm` rather than `key`, refuses an absent `info` and reads the digest as a string first (row `owc-crypto-asymmetric-and-hashes`, closed); `crypto.diffieHellman(1)` is `ERR_INVALID_ARG_TYPE` naming `"options"`, as on the host, before either key in it is looked at (row `owc-crypto-dh-degenerate-prime`, closed); a capability error keeps the constructor it was thrown with at every entry point and not only the ciphers', so `generateKeyPairSync('nope')` is a `TypeError` and `createHmac('nope', 'k')`, `pbkdf2Sync(..., 'nope')`, `createSign('nope')` and `createVerify('nope')` are `TypeError`s carrying `ERR_CRYPTO_INVALID_DIGEST` (row `owc-crypto-capability-error-class`, closed); and the `ERR_INVALID_ARG_TYPE` lists are Node's own at every entry point a caller reaches -- `KeyObject` and `CryptoKey` in a key's, no `ArrayBuffer` in the data a cipher is fed, no `Received` tail and no string in `timingSafeEqual`'s, and a `candidate` that is a BigInt or bytes in `checkPrimeSync`'s (row `owc-crypto-argtype-messages`, closed). `generateKeyPairSync` answers the JWK the host answers for `rsa`, `ec`, `ed25519`, `ed448`, `x25519` and `x448` and refuses `rsa-pss`, `dsa` and `dh` with `ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE`, `crypto.getDiffieHellman` is a function, the four raw RSA operations run and name an `oaepHash` the runtime does not carry as `ERR_OSSL_EVP_INVALID_DIGEST 'Invalid digest used'`, and a `Verify` object is uninitialised again the moment it answers, so a second `verify()` on it throws `ERR_CRYPTO_INVALID_STATE 'Not initialised'` even after a second `update()` (row `owc-crypto-guest-surface-encodings`, closed). A generated Diffie-Hellman modulus is now a safe prime `p = 2q+1`, which is what OpenSSL writes and what makes `DH_check` report 0: `createDiffieHellman(512|1024|2048).verifyError` is 0 as on a host, and `generateKeys()` is refused with `Key generation failed` for a group the check names anything about -- `createDiffieHellman(Buffer.from([23]), 3)` -- while a generator of 1 is `ERR_OSSL_DH_BAD_GENERATOR` at construction. What that costs is the search, not the arithmetic: 512 bits is 0.03-0.3 s and 1024 is 0.1-2.6 s against the host's 0.04 and 1.4, but 2048 is 15-47 s against 2.1, because a safe prime is rarer than a plain one by the square of the density and every candidate here is a BigInt Miller-Rabin. What is left of the crypto surface is `webcrypto`, which no row covers and which this runtime carries only the digest half of: `subtle` answers `constructor` alone against the host's eighteen methods, so `subtle.importKey`, `generateKey`, `encrypt`, `decrypt`, `deriveBits`, `deriveKey`, `wrapKey` and `unwrapKey` are all undefined, `subtle.digest('NOPE')` rejects with a plain `Error 'Unrecognized algorithm name: NOPE'` where the host rejects with a `DOMException` of code 9, `getRandomValues` fills 65537 bytes where the host throws `QuotaExceededError` of code 22, and `crypto.secureHeapUsed` and `crypto.getFips` are `undefined` where the host has both as functions, and `crypto.diffieHellman({ prime, privateKey, publicKey })` refuses a buffer the way Node does, with `ERR_INVALID_ARG_VALUE` naming `options.privateKey` — Node wants two KeyObjects, and a prime belongs to `createDiffieHellman` (row `owc-crypto-dh-degenerate-prime`, closed); an error a `vm` context **hands back** is now of the second realm like any other value — `vm.runInNewContext('new Error("x")') instanceof Error` is `false` here, as on the host, with `name`, `message` and `Object.prototype.toString.call` still `Error`, `x` and `[object Error]`, and a `TypeError` still named `TypeError` — and it keeps what the constructor put on it: `cause`, its own `stack` (a `stack` the context's code set itself is handed back as it was set), an `AggregateError`'s `errors` and `message`, and an `Error` subclass the name of its own class rather than `Error` — and one **thrown** out of a context does too: `try { vm.runInNewContext('throw new Error("x")') } catch (e) { e instanceof Error }` is `false` here, as on the host — the code of a context runs in the second realm, so what it throws is of that realm as it is thrown, and `vmGuarded` hands the `ERR_SCRIPT_EXECUTION_TIMEOUT` it raises itself to the one rebuild left, which host Node raises in the context's realm, and so does the `SyntaxError` of a script compiled *for* a context: `vm.runInNewContext('var y = {')` answers `false` to `e instanceof SyntaxError`, where `new vm.Script('var y = {')` — a compile no context was named for — answers `true`, and so does `new vm.Script('var y = {').runInContext(ctx)`, which throws before the context is reached; the context is resolved before the code is compiled, as on the host — and an `Error` subclass keeps the name of its own class on `constructor.name` while its `name` stays the inherited `Error`, as on the host. What is left of that row is the *words* of the errors, and they are the engine's and not the container's: the stack of a rejection that escapes a context names the container's own frames (`at <eval> (<input>:1:25)`, then `/app/main.js`) where the host prints `at evalmachine.<anonymous>:1:16` above `Script.runInContext (node:vm:149:12)`, and a `TypeError` the engine raised reads `cannot read property 'x' of null` where V8 reads `Cannot read properties of null (reading 'x')` — proved out of the container, bare QuickJS 0.32 with no container in the way answers `cannot read property 'x' of null` for `null.x` and `    at <anonymous> (eval.js:1:32)` for the stack of an error a second context made, so neither is a frame or a wording this container could choose (row `owc-vm-error-thrown-realm`); a synchronous throw inside `d.run(() => { throw ... })` now propagates out of `run()` to the caller and leaves the domain entered, exactly as host Node 24.15 does, and an error **no caller catches** reaches the domain it was thrown inside rather than the process: with a domain `error` listener and a process `uncaughtException` listener both registered, `d.run(() => { throw new Error('uncaught-in-run'); })` prints `DOMAIN.ERROR=uncaught-in-run` and exits 0 on both sides, and the domain's `error` listeners see `domain._stack` at 0 and `process.domain` undefined, as on a host (row `owc-domain-uncaught-not-routed`, closed). What is left of the domain surface is the shape of the fatal stack an error no one handles ends the process with, and that is the engine's: bare QuickJS 0.32 answers `at <anonymous> (app.js:1:43)` and `at <eval> (app.js:1:13)` and nothing else for a throw out of a callback a host function drives, so a program with no `domain` in it at all — a top-level `throw`, or one out of a `setTimeout` — prints no source line, no caret and no `Node.js v24.15.0` trailer here where host Node 24.15 prints all three, above `Timeout._onTimeout`, `listOnTimeout` and `processTimers` frames QuickJS has no counterpart for; two more of that surface are not the stack at all: `d.add(ee)` followed by a listener of `ee`'s that throws is routed to the domain's own `error` listener on host node 24.15 (`DOMAIN ee-throw`, exit 0) and is fatal here (exit 1, nothing on stdout, the whole stack on stderr), and `Domain.prototype.dispose` is a function here where host node 24.15 answers `typeof d.dispose` `undefined`, so `d.dispose()` exits 0 here and 1 there with `TypeError: d.dispose is not a function` — both in `packages/core/src/process/executors/node/runtime/guest/modules/pure-b.ts`; the `repl` reports an entry no later line can finish and still waits for the line that can (`try {`, `do {`, `function f(`, `try { } catch (` and a `try {` closed on a second line all continue, as they do on the host), but the two words it says are the engine's and not Node's: `var y = {` then `2+2` prints `> 2\n> | Uncaught SyntaxError: expecting ':'\n> ` here where the host prints `> 2\n> | 2+2\n ^\n\nUncaught SyntaxError: Unexpected token '+'\n> `, because the pinned QuickJS words that syntax error `expecting ':'` where V8 words it `Unexpected token '+'`. The offending line and the caret under it are no longer the engine's to lose: the `repl` now prints `> | 2+2\n ^\n\nUncaught SyntaxError: expecting ':'\n> ` where the host prints `> | 2+2\n ^\n\nUncaught SyntaxError: Unexpected token '+'\n> `, re-witnessed at HEAD with nine repl sessions on both sides, where six agree line for line -- a clean eval, a ReferenceError, a function defined across two evals, an `await`, a `try {` closed on a later line and the unterminated `var y = {` -- and the three that do not are the engine's wording and the two residuals this body records; the line and the caret read out of the position QuickJS does give -- `getQuickJS().newContext().evalCode('var y = {\n2+2', 'repl')` answers `SyntaxError` / `expecting ':'` / `    at repl:2:2\n` -- with the token the lexer finds there for the span V8 underlines, so `function(` gets eight carets here as there and not one. Only the two words themselves are out of reach, and only the caret's width is still an approximation: V8 underlines the whole token it names and a caret run here is that token's, not a computed one (row `owc-repl-unterminated-input-silent`); and a signal a listener was registered for no longer ends the process — `process.kill(process.pid, 'SIGUSR1')` returns `true`, leaves it running and runs that handler a turn later — but it is delivered even when nothing else is pending, where host node 24.15 unrefs the handle it reads a signal from and so exits 0 with the handler never run: with a handler and nothing else queued this container prints `handler SIGUSR1` after `after-sync` and the host prints neither, and behind an `exit` listener the host reaches that listener alone while this container runs the handler first (row `owc-process-kill-signal-fatal`). It cannot be mended by unref'ing the timer that stands in for the delivery, which is the one thing Node's own unref'ed handle suggests: this loop ends the moment the last ref is gone and an unref'ed timer is then never serviced, so `process.on('SIGUSR1', h); setTimeout(function () {}, 0); process.kill(process.pid, 'SIGUSR1')`, which is `timer` then `handler SIGUSR1` on the host, loses the handler here too; A combining mark in a required module's source is *not* dropped: `require` of a relative module and of a `node_modules` module both hand back `?⃝` (`cp=3f,20dd`) intact, and the one corpus entry that differs, `figures`, does so because the package itself writes `if (platform === 'linux') { main.questionMarkPrefix = '?'; }` — a host/guest platform difference, not a loader one; `node:module` has three limits no guest code can close: `Module._nodeModulePaths('/app')` answers `['/app/node_modules','/node_modules']` where the host's ancestor walk answers six entries, because this container's root *is* the top and there is nothing above `/app` to walk; `Module._stat` is now host-identical over 48 probes — `-20` (ENOTDIR) for `/app/main.js/inner`, for `/app/main.js/` and for `/app/main.js/inner/deeper`, `-2` for a path whose parent is merely missing, `0`/`1` for a file/a directory and `ERR_INTERNAL_ASSERTION` for one that is not a string — by walking from the leaf up to the nearest parent that exists, and, for the four answers a parent walk cannot reach, component by component: `-20` for `plain.js/.` and `plain.js/..` (a `'.'` or `'..'` is a traversal through the component in front of it, and this filesystem's `statSync` folds it away instead), `-62` (ELOOP) for a link chain that comes back on itself, `-63` (ENAMETOOLONG) for a component past `NAME_MAX`, and `0` for a file reached through a symlink to a directory; what row `owc-module-stat-enotdir-for-file-parent` still rests on is the `fs` layer under it, `packages/core/src/process/executors/node/runtime/guest/buffer-fs.ts`, whose `statSync`/`lstatSync` still report ENOENT for a path whose parent is a file (host: ENOTDIR) and still answer a file asked for with a trailing slash, and which will not follow a symlink in the middle of a path for `readFileSync`, `readdirSync` or `realpathSync` -- `Module._stat` itself is host-identical at HEAD over 18 probes (`-20` for every path under a file and for a file asked for with a trailing slash, `0` and `1` for a file and a directory reached through a symlink, `-2` for one that is merely missing), so the row no longer rests on it and is closed stale on that half, what is left of it being `fs.statSync` in another lane's file (row `owc-module-stat-enotdir-for-file-parent`, closed stale); and a `SourceMap` payload that is an object host accepts but is too thin to parse -- `{}`, `new Date()`, `/re/`, `new Error()`, a null-prototype object, `new Map()` -- fails on both sides with a bare `TypeError` carrying no code, whose text is the engine's own (proved out of the container: bare QuickJS 0.32 says `cannot read property 'length' of undefined` where V8 says `Cannot read properties of undefined (reading 'length')`, and the same split gives `object is not extensible` here against `Cannot add property 72, object is not extensible` on the host for `M.builtinModules.push('zz')` -- which throws on both sides now that the array is frozen). `events` carries `EventEmitterAsyncResource`, `addAbortListener` and `usingDomains` at HEAD, so `Object.keys(require('events'))` is host Node 24.15's own 15 names and not 12; what is left is two non-enumerable string keys a host's module object also carries, `kMaxEventTargetListeners` and `kMaxEventTargetListenersWarned`, each holding a symbol, so `Object.getOwnPropertyNames(require('events'))` is 18 against 20 at the `events` builtin in `guest/path-events.ts`, another lane's file (row `owc-events-async-resource-missing`, closed stale). `Module.globalPaths` is now filled the way node fills it -- the folders `NODE_PATH` names, then `$HOME/.node_modules` and `$HOME/.node_libraries`, then `$PREFIX/lib/node` for the directory two above the node binary -- by `Module._initPaths`, which answers `undefined` as node's own does and reads the home directory out of the environment rather than out of `os.homedir()`, so an environment with no `HOME` gets the prefix folder alone: `Module._resolveLookupPaths` is host-identical over seven probes, a parent's own `node_modules` followed by the three folders and, with no parent at all, the three alone. The three are this container's own home directory and install prefix (`/home` and `/usr/local` against a host's `/Users/...` and its node prefix), exactly as `os.homedir()` and `process.execPath` are, so what matches is the count, the order and the derivation and not the strings (row `owc-module-globalpaths-empty`, closed); `Module.createRequire(f).resolve.paths` is a function now and answers the folders a bare request is looked for in -- a parent's own `node_modules` followed by the three global folders, and `null` for a built-in -- so what is left is the `require` a CommonJS module is handed, whose `resolve.paths` is still a `TypeError: not a function` at `makeRequire` in `guest/loader.ts:303`, another lane's file, and `require('module').prototype.require.resolve`, which throws the engine's own `not a function` where V8 names the whole expression (`Module.prototype.require.resolve is not a function`) -- proved out of the container, bare QuickJS 0.32 answers `not a function` for a call of an undefined property and never names it (row `owc-module-export-table-incomplete`); `Module.prototype` is host Node 24.15's own six names (`_compile`, `constructor`, `isPreloading`, `load`, `parent`, `require`) and `new require('module')(f, null)` answers `filename` `null` with no `paths` key, as a host's does, so of the five a judge's witness carried only those two sites are left; `fs` and `buffer` now carry the shapes the host carries: `fs.statSync(p)`'s own properties are the fourteen numeric fields alone, with `atime`/`mtime`/`ctime`/`birthtime` as getters on `fs.Stats.prototype` above them and the seven `is*` tests above that, as on host Node 24.15, so `Object.getOwnPropertyNames(fs.statSync(p))` names no date and no test; a `Dirent` no longer owns a `path`, which host Node 24.15 does not answer either; `F_OK`/`R_OK`/`W_OK`/`X_OK` are readable on `fs` but not among the names `Object.keys(fs)` answers; and `lutimes`/`lutimesSync`, `futimes`/`futimesSync`, `fchown`/`fchownSync`, `lchown`/`lchownSync`, `lchmod`/`lchmodSync`, `mkdtempDisposableSync`, `_toUnixTimestamp`, `ReadStream`, `WriteStream` and their `File*` aliases are all there, with the host's own syscall in each error (`lutime`, `futime`, `fchown`, `lchown`, and `open` for `lchmod`), while `node:buffer` has `atob`, `btoa` (both `InvalidCharacterError` for a text that is not base64 or a character above U+00FF), `File`, `SlowBuffer`, `INSPECT_MAX_BYTES` and `resolveObjectURL` (row `owc-wa-stream-buffer-fs`). `stream.compose` and `Duplex.from` are host-identical over a 150-line matrix of bodies and positions: a value that is neither a node stream nor a web one is left out of the position check and refused by the body conversion instead, so `compose(5, W)` and `compose(R, 5)` answer `ERR_INVALID_ARG_TYPE` naming the `body` argument where this container once answered a bare `TypeError` and `compose(R, 5)` no code at all, `compose({}, R)` answers `streams[1]' must be writable` and not `streams[0]' must be readable`, and a function at either end of a chain is the only place Node turns one into a body, so `compose(asyncFn, W)` answers `streams[0]' must be readable` as the host does while a function in the middle must answer an `AsyncIterable` — a sync iterable, a string, a number, a promise and a bare `undefined` are each refused in the `transform[n]` function's own words. `Duplex.from` answers the class Node answers, `Duplexify`, for every body it takes — a string, an array, a generator object, a `Blob`, a web `ReadableStream`, a promise and a `{ readable, writable } ` pair, all of which came back a `Readable` or a `Duplex` or threw before — and carries a writable side even when the function it was given answered something only readable. What is left of that row is all in `packages/core/src/process/executors/node/runtime/guest/buffer-fs.ts`, outside this shard's grant and so named and not edited: `fs.glob`, `fs.globSync` and `fs.Utf8Stream` — three names of the 104 `Object.keys(fs)` answers on the host that this container still does not export — and the directory metadata under them, `statSync(dir).size` `2` here against the host's `160` for a three-entry directory (64 + 32 per entry on this APFS volume), `blocks` `8` against `0` and `nlink` `1` against `5`, plus the order `readdir`/`opendir` answer entries in, `a.txt,b.txt,sub` here against the host's `b.txt,sub,a.txt`. Three lines of the compose matrix and one of the row's own are the engine's and not the container's: `compose(R, { readable, writable })`, `compose(pair, W)` and `compose(R, T, pair)` die in the host's own web bridge with `readable.getReader is not a function` and `writable.getWriter is not a function`, and a `Blob`'s `stream()` has no `.on`, so a `consumers.text()` over it rejects `s.on is not a function` there — bare QuickJS 0.32 words every one of them `not a function`
- TLS: `tls` and `https` implement TLS 1.3 only (no TLS 1.2, session resumption or 0-RTT); peers are verified against the `ca` option only (no system or built-in roots); pfx, passphrase-protected keys, Ed25519 and P-521 keys are not supported; only the X25519 and P-256 groups, the AES-GCM and ChaCha20-Poly1305 suites and ECDSA P-256/P-384, RSA-PSS and RSA PKCS#1 signatures are implemented, and an `ecdhCurve`, `ciphers` or `sigalgs` value that names only other algorithms throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; external `https` requests still go through the browser's `fetch`. `tls.DEFAULT_MIN_VERSION` still reports `TLSv1.2`, so nothing but a handshake tells you it is wrong: a client pinned to `minVersion`/`maxVersion` `TLSv1.2` fails with `ERR_SSL_NO_PROTOCOLS_AVAILABLE` (`no protocols available`) where host Node connects and reports `TLSv1.2`
- HTTP/2: `http2` does not send server push (`pushStream` reports `ERR_HTTP2_PUSH_UNSUPPORTED`) and has no `respondWithFile`/`respondWithFD`, ALTSVC or ORIGIN frames, h2c `Upgrade` from HTTP/1.1, `allowHTTP1`, or session and stream timeouts. HTTP/3 over QUIC is not started
- Virtual net: `net` and `dgram` surfaces measured against host Node 24.15. Unix domain sockets are carried by path in the hub, as a host's are: `server.listen('/tmp/x')` and `server.listen({path:'/tmp/x'})` bind, report `listening`, and answer `server.address()` with the path itself — a plain string, as host Node does, not the address/family/port triple a TCP listener gives, and it keeps answering with it after a `close`, where a closed TCP listener answers `null` — and `net.connect('/tmp/x')` reaches them and exchanges bytes over the same hub, where the string form used to refuse with `ERR_SOCKET_BAD_PORT` (`Port should be >= 0 and < 65536. Received type string`) and the options form used to drop the option and bind a fabricated TCP wildcard, reporting a successful listen of `{"address":"::","family":"IPv6","port":49152}` for a path it never bound. A second bind of a path is `listen EADDRINUSE: address already in use /tmp/x`, one longer than this platform's 104 bytes is `listen EINVAL: invalid argument /tmp/x` (`errno -22`, and `err.port -1` as on a host, which prints no port for a path), a connect to a path nothing is bound at is `connect ENOENT /tmp/x` (`errno -2`), and `net.connect` of a path with no separator in it — `connect('x.sock')`, `connect('localhost')` — answers that same `ENOENT` rather than reading the name as an address. and a unix connection reports no address at either end — `socket.address()` is `{}` and `localAddress`, `remoteAddress`, `localPort`, `remotePort` and both families are `undefined` — every one of them as host Node 24.15 answers it (row `owc-virtual-net-listen-path`). What the hub does not do is put an inode at the path: the binding lives in the hub alone, so nothing appears there in the filesystem, `fs.stat` of it is `ENOENT`, and a bind under a directory that does not exist is not the host's `EACCES` — nor is a bind of `/`, which the host refuses `EEXIST` ('file already exists /') and the hub binds, so a connect to `/` reaches it. Two paths differing only in case are two bindings here, where a case-insensitive host filesystem (APFS) answers a connect to either spelling. A regular file already sitting at the path is `EADDRINUSE` on a host and is bound anyway here, since nothing in the hub looks at the filesystem the path names — a directory at the path is the host's `EADDRINUSE` (`errno -48`) and a path *under* a regular file is its `ENOTDIR` (`errno -20`), and both bind here; so does a path with a trailing slash, or one with a `..` segment whose parent does not exist, which a host refuses `EACCES` (`errno -13`) (row `owc-virtual-net-listen-path`). What the `path` option itself has to be is answered as host Node 24.15 answers it: a number, a Buffer, an object, `null` and the empty string are each `ERR_INVALID_ARG_VALUE` ("The argument 'options' is invalid. Received { path: 123 }", naming the whole options object) where this runtime bound or mis-refused them — `{path:123}` bound TCP `:123` and `{path:Buffer.from('/tmp/x')}` bound the path — and only when no port is named alongside, since a port wins and is bound without the path ever being read (`{path:123, port:8080}` binds `:::8080` on both sides). A unix bind that failed still answers `address()` with the path it was asked for, as a host's does for the 105-byte path it refuses `EINVAL`. A port named alongside a path wins here as there: `server.listen({path:'/tmp/x', port:8080})` binds `:::8080` and ignores the path. A path is a string holding a separator, so `server.listen('x.sock')` and `server.listen('localhost')` are still read as a port and refused with `ERR_SOCKET_BAD_PORT`, where host Node binds a socket file of that name in the working directory -- both reach `hub.listen` as an address with port 0, which is also the shape a host name arrives in, so the hub cannot tell a path from a name in that call; carrying the distinction needs a field on the `net.listen` payload (`packages/core/src/process/executors/node/runtime/capabilities/net.ts:91`). A wildcard bind keeps its family: a server on `::` accepts an IPv4 client on `::ffff:127.0.0.1`/`IPv6` at both of its ends, and one on `0.0.0.0` refuses an IPv6 client with `ECONNREFUSED` (rows `owc-virtual-net-ipv6-family` and `owc-virtual-net-wildcard-mapped`). Dialling the IPv4-mapped loopback `::ffff:127.0.0.1` now reaches a listener on `0.0.0.0`, on `::` and on the default bind, as the host does — all three used to fail `ENETUNREACH`, because `isLocal` did not recognise the mapped form and `connect` refused before a listener was ever looked for; the accepted socket reports `127.0.0.1`/`IPv4` for the v4 bind and `::ffff:127.0.0.1`/`IPv6` for `::`, and the client reports the `::ffff:127.0.0.1`/`IPv6` it dialled at both of its own ends -- `localAddress` and `remoteAddress` alike, where the hub used to answer the plain `127.0.0.1`/`IPv4` it had routed the dial to -- every field as host Node 24.15 reports it. The same address written as its last two hex groups -- `::ffff:7f00:1` -- is one address, not a name, so the hub reads it as the mapped literal it is and dials `127.0.0.1` for it, where reading only the dotted spelling refused it `ENETUNREACH` on every bind; whichever spelling was dialled, the socket reports the canonical `::ffff:127.0.0.1`/`IPv6` at both of its own ends, as a host's `getpeername` renders it. Binding the mapped loopback is possible too: `server.listen(0, '::ffff:127.0.0.1')` answers `address()` with `::ffff:127.0.0.1`/`IPv6`, takes a client dialling `127.0.0.1` (accepting it as `::ffff:127.0.0.1`/`IPv6` while the client reports `127.0.0.1`/`IPv4`) and one dialling the mapped literal (`::ffff:127.0.0.1`/`IPv6` at both of its own ends), and refuses `::1` with `ECONNREFUSED` — every field as host Node 24.15 reports it, where the mapped loopback used to be bindable by UDP alone, so a TCP bind of it was `EADDRNOTAVAIL` (row `owc-virtual-net-ipv6-family`). A zone (scope) id travels with a literal: `net.connect({host:'::1%lo0'})` connects to `::1` here as on a host — `isIPv6` reads the zone as part of the literal and the hub dials the address the zone is attached to — but `dns.lookup('::1%lo0')` is `ENOENT` here where host Node 24.15 answers `::1%lo0`/`6` (`packages/core/src/process/executors/node/runtime/guest/modules/dns.ts`, not this shard's file). An `http` request reaches a guest listener on an IPv6 host literal too -- `http.get({host:'::1'})` and `http.get({host:'::ffff:127.0.0.1'})` both answer `200`, where the first used to fail `ERR_INVALID_URL` (a trailing `:port` was stripped off `::1`, leaving `:` to bracket) and the second `ENOTFOUND` (only `127.*` was treated as this host). Node takes a host exactly as it is given, so `::1` is the loopback while `[::1]` and `localhost:0` are names `getaddrinfo` cannot answer and both come back `ENOTFOUND` on either side. Binding `0.0.0.0:P` then `::P` now binds both, where folding both wildcards to `''` made the second `EADDRINUSE`; the reverse order is `EADDRINUSE` on both sides, as it is on the host. `socket.bufferSize` counts what a write has handed the hub and the hub has not delivered to the peer yet, and no longer counts those same bytes three times over: one write of 262145 reported `786435`, and 400010 bytes written across two writes in one turn reported `1200010`, more than the socket had ever been given — the held write callback, the stream's own buffer and the hub's own count all named the same bytes. A closed socket now reports `undefined`, as Node does, not `0`. The peak matches the host's: 200x64 KiB into a reader the server paused grows it to `13107200` here, against a host figure that moves with the run (`12845056`, then `12648448`, of `13107200` written), and `write` returns `false` inside the burst on both sides. `write()`'s answer is not the same shape, and it is what decides whether a guest ever waits for `drain`: here a write's callback comes back on the turn that made it, unless that one write is larger than 262144 bytes, so 40x64 KiB returns `false` on the *first* write where a host's first `false` lands after 320/524/655 KB and moves from run to run, a single 262145-byte write is `true` here and `false` on a host, and two 100000-byte writes in one turn are `true,true` here and `false,false` there. It is the same missing piece — a host's `write` stalls on a bounded send buffer and this hub accepts every byte — and the host's own threshold moves with the run, so there is no figure to tune it to (row `owc-virtual-net-buffersize`). What still differs is what comes after: the count falls to `0` here by t60, where the host's holds `12779520` at t600, and a single 5-byte write to a peer that reads it at once counts `5` for the turn it was made, where the host reports `0`. Both are one missing piece -- this virtual network has no bounded send buffer, so the hub accepts and delivers every byte it is handed and nothing on this side outlives the turn that made it. A faithful figure would count what the peer has not consumed, which needs the peer to report its own consumption back to the hub, and no `net.*` capability carries that today (`packages/core/src/process/executors/node/runtime/capabilities/net.ts`); and no write can be acknowledged on the turn that made it, because every delivery the hub makes is a macrotask -- the engine does allow a host call into the guest while the guest is calling out (measured on bare QuickJS 0.32, the asyncify build this container runs: a function called from inside a host call runs, and the guest sees what it set before that call returned), but it will not run the guest's own pending jobs there, since a promise queued before the call is still unrun when the call comes back. Even a synchronous delivery would not give the host's figure: a host counts what a bounded send buffer holds, and this hub accepts every byte it is handed, so there is nothing for a count to stall on (row `owc-virtual-net-buffersize`). The host's own peak moves with the run (`12845056`, `12648448`, `11862016` of `13107200` written, measured on five runs), so the figure this side holds -- always exactly the bytes written -- is a number no fixed send buffer can be tuned to; and the two figures that are one number on a host are unrelated here, `bufferSize=13107200` with `writableLength=0`. The count is also wrong in three shapes the host answers the other way round: while corked it is `0` and rises to `131072` on uncork, where the host holds `131072` corked and `0` after; ten single bytes to a peer reading everything count `1,2,...,10` here and `0,0,...,0` there; and with the peer never resumed the host holds `12.58 MB` through t1500 while this side is `0` from t0. A server told to bind `localhost` binds `::1` now, as host Node 24.15 does, so a client dialling `127.0.0.1` is refused here as there and one dialling `::1` connects (row `owc-virtual-net-localhost-bind`); `dns.lookup('localhost')` still answers `127.0.0.1`/`4` where host Node 24.15 answers `::1`/`6`, so the one name the hub binds as `::1` is resolved the other way by the resolver. `dgram` keeps the `127.0.0.1` its own family asks for, and a `dgram.bind` of a string it cannot read as a port (`bind('/tmp/x.sock')`, `bind('abc')`) binds an ephemeral UDP port as the host's does instead of being refused. A `udp6` socket on `::` that sends a datagram to `::ffff:127.0.0.1` reaches the loopback as a host's does -- `sendUdp` reads the mapped form and routes the datagram to the address it embeds -- and the `rinfo` the receiver reads is written in the family the receiver is bound in: `::ffff:127.0.0.1`/`IPv6` for a udp6 socket on `::`, `127.0.0.1`/`IPv4` for one bound to `::ffff:127.0.0.1` and for every IPv4 receiver. A `udp6` socket bound to one address of its own (`::1`) has no route to a mapped destination, so its send is `EADDRNOTAVAIL`, as on a host; measured as the 60 triples of sender x receiver x destination over the loopback in both families (row `owc-virtual-net`). The two getters that go with `dgram`'s buffer-size setters are there now: `getRecvBufferSize()` and `getSendBufferSize()` report what a `setRecvBufferSize`/`setSendBufferSize` last gave them, or this platform's own default when nothing has been set (`786896` to receive, `9216` to send, the pair host Node 24.15 reads off every dgram socket it opens here), and a size is validated and refused as Node refuses it — `Buffer size must be a positive integer`, which is Node's own text, `0` included among the sizes that pass it, where this runtime named a non-negative integer and echoed the value back; an unbound socket has no descriptor to read or set one on, so it is `EBADF`, and a closed one throws the `TypeError` host Node 24.15 throws when it dereferences the handle its `close` nulled (`Cannot read properties of null (reading 'bufferSize')`) (row `owc-virtual-net`). One option is still dropped: `server.listen({port:0, host:'::', ipv6Only:true})` accepts an IPv4 client that the host refuses with `ECONNREFUSED`, because `ipv6Only` reaches no further than `netListenArgs` and the `net.listen` payload in `packages/core/src/process/executors/node/runtime/capabilities/net.ts:87` has no field to carry it to the hub (row `owc-virtual-net-ipv6only`). A second `connect()` on one socket is refused as host Node 24.15 refuses it: a connection the socket has already made is `EISCONN` (`errno -56`) and one still in flight is `EALREADY` (`errno -37`), each reported the way every connect failure is — asynchronously, and by destroying the socket, so `error` is followed by `close` and `destroyed` is `true` — while `connect()` itself still answers with the socket; the text names the destination and the local end the socket had already bound (`connect EISCONN 127.0.0.1:8080 - Local (127.0.0.1:53326)`), and a path names itself with no local end, since a unix socket has none. Two cases are not refused and both are the host's own: a connect that names no destination dials again in silence, and one on a socket already destroyed is a no-op that reports nothing — except that host Node clears its `destroyed` flag there and this runtime cannot without reopening a connection the hub has already released, so it stays `true` (row `owc-virtual-net`). Everything else the hub carries -- a server's `listening`/`address`/`close`, a round trip and its `bytesWritten`/`bytesRead`, `EADDRINUSE` on a port already bound and `ECONNREFUSED` on one that is not, UDP in both families with the `rinfo` a receiver reads, the `Socket` accessors, and a port bound in one process reached from another -- matches host Node 24.15 line for line. Three `Socket` methods the surface was missing are there now — `resetAndDestroy()` (the peer sees `ECONNRESET` and no `end`, as on a host), `getTypeOfService()` (0) and `setTypeOfService(n)` (0..255, with `ERR_OUT_OF_RANGE` and `ERR_INVALID_ARG_TYPE` as Node throws them) — but the `tls` half of that line does not hold: `tls.getCiphers()` is 3 here (`tls_aes_128_gcm_sha256,tls_aes_256_gcm_sha384,tls_chacha20_poly1305_sha256`) against 62 on host (`aes128-gcm-sha256,aes128-sha,aes128-sha256`); a server and a client both pinned to `minVersion`/`maxVersion` `TLSv1.2` fail here — the client gets `ECONNRESET` and the server reports `ERR_SSL_NO_PROTOCOLS_AVAILABLE` — where host Node 24.15 connects with protocol `TLSv1.2` and cipher `ECDHE-RSA-AES128-GCM-SHA256`, because this container's TLS is 1.3 only; `getEphemeralKeyInfo()` is inverted, `{}` on a host for a TLS 1.3 session and `{type:ECDH,name:X25519,size:253}` here; and a TLS socket's `bytesRead` counts handshake bytes here (1321/1325/1329/1356) where a host counts application bytes (6). All four are `packages/core/src/process/executors/node/runtime/guest/modules/tls.ts`, outside this shard's grant. What does match, over a real self-signed certificate: a certificate with no `ca` is refused (`DEPTH_ZERO_SELF_SIGNED_CERT`), and `rejectUnauthorized:false`, ALPN negotiation, a servername mismatch (`ERR_TLS_CERT_ALTNAME_INVALID`), `checkServerIdentity` and `requestCert` all agree with host Node 24.15. One ordering still differs, at the end of a connection both sides have ended: the peer's `end` arrives here before the socket that ended second emits its own `close` (`srv.end,cli.end,srv.close,cli.close` against the host's `srv.end,srv.close,cli.end,cli.close`, stable across repeated runs on both sides and on the host over five), because ending the writable side here waits a microtask past `end` so a listener can still reply, and `finish` and the destroy follow that microtask. Wider than that one line, and stable across repeated runs on both sides: five interleavings differ, and in every one of them the peer observes what a socket last wrote or sent before this side has closed, where the host closes first and the peer reads afterwards -- a write then `end` (`srv.finish,cli.data,srv.close` against the host's `srv.finish,srv.close,cli.data`), an `end(cb)` on both sides, a half-open server that writes after the client's `end`, a client that ends after reading the reply (`srv.end` before `cli.end`, where the host has `cli.end,cli.close` first), and a `destroy()` from one side (`cli.close,srv.close` against the host's `srv.close,cli.close`). Delaying every peer delivery until after this side's close fixes the first three and loses `finish` on the last two, so it is one scheduling model on each side, not one knob: a host's loopback closes a socket locally and lets the peer read on a later poll, while this hub delivers into a guest on the next macrotask and tears down two turns after that. What did not have to wait for any of it: a destroyed socket now names no address at either end -- `remoteAddress`, `remotePort`, `localAddress` and `localPort` are all `undefined` and `address()` is `{}`, as Node nulls them once the handle is gone, where this side used to keep the values the connection was made on.
- Guest-side `fetch` is implemented: a request goes out on the container's own `http` and `https` client, so a URL on the virtual network reaches the server listening there (measured against host Node 24.15 on the same script: a 200 over `http://127.0.0.1`, its body, and a POST with a body and headers all agree, and an unreachable host rejects as `TypeError: fetch failed` with `ENOTFOUND` on `err.cause`) and there is no host network behind it. `Headers`, `Request`, `Response` and `FormData` are globals beside it — one script covering status, `text()`, `json()`, a response header, a POST with a string body, a `FormData` body sent as `multipart/form-data`, an abort through `AbortSignal` (which rejects with the signal's own `AbortError`, not with `fetch failed`), an unreachable host, and `typeof` plus a construct-and-read round trip for all four classes is byte-identical to host Node 24.15, as is the streaming half: `Request` and `Response` expose `.body` as a real `ReadableStream` (async iteration, `getReader()`, `clone()` of a stream body through `tee()`, and `bodyUsed` flipping once the stream is pulled all agree with host Node 24.15) — what is still missing is `.formData()` on both, so a multipart body is never parsed back into a `FormData`, and the boundary this container generates is `----formdata-owc-<24 random alphanumerics>` where undici's is `----formdata-undici-<12 digits>`. A stream body still needs the `duplex` option Node asks for and is refused with `RequestInit: duplex option is required when sending a body.` The `WebSocket` global is a client over the same sockets: the handshake, a text frame, a binary frame, the negotiated subprotocol and the close handshake were measured against host Node 24.15 and agree, and the close event fires the way Node's does — when the connection ends, not when the peer's close frame arrives, so a server that sends a close frame and keeps the socket leaves the client at `readyState` 2 (CLOSING) indefinitely, and the event is a real `CloseEvent`; there is no WebSocket server and no `EventSource`. `undici`'s own module is served over the same client
- `zlib` native handle protocol: pngjs's synchronous decoder reads `zlib.Inflate` internals (`_handle`, `_processChunk`) and fails; both are `undefined` here, where Node has an object and a function. The public `zlib` APIs work
- WebAssembly packages: `hash-wasm` (sha256 and md5) and `cheerio` 1.2.0 loads and parses under `require`: `require('cheerio')` answers a `load` function and `load('<ul><li class="a">1</li><li class="b">2</li></ul>')` gives `$('li').length` 2, `$('li').text()` `'12'` and `$('li').attr('class')` `'a'`, byte-identical to host Node 24.15, and `require('parse5')` answers 12 names on both sides. What does not work is the ESM path, with a different error: `await import('cheerio')` throws `SyntaxError: Could not find export 'Tokenizer' in module '/app/node_modules/parse5/dist/tokenizer/index.js'` (measured below). `sql.js` does not run: even `new SQL.Database()` throws `ERR_WASM_TRAP: Cannot convert a BigInt value to a number` (sql.js 1.13.0 and 1.15.1, with or without `locateFile`), so the i64 values its build moves across the boundary stop it at the first call. A memory still crosses the boundary in 1 MiB chunks per call
- Native addons: a compiled binary cannot run, so `process.versions.napi`, `process.dlopen` and a `.node` require serve a JavaScript reimplementation from `src/napi`: `bcrypt` (verified: `hashSync`/`compareSync` round-trip), `sodium-native`, `better-sqlite3` (SQLite 3.47.0 transpiled to plain JS), `leveldown`, `rocksdb` and `rocksdb-native`, `node-pty`, `canvas` and `sharp`. `sodium_malloc` returns an ordinary zero-filled Buffer, and `sodium_mprotect_*` and `sodium_mlock` are no-ops: the container has no guarded heap and cannot lock memory, so libsodium's memory hardening is unavailable, though computed values are unaffected. `esbuild` ships a Go binary rather than an add-on: `npm install esbuild` fails in its postinstall with `npm error code ENOEXEC`, naming `/app/node_modules/@esbuild/linux-x64/bin/esbuild` as the binary this container cannot execute, and the installed bin then fails with `spawnSync /app/node_modules/@esbuild/linux-x64/bin/esbuild ENOENT` and exit 1
- The three add-on shims are honest about what they do not do, and each has a surface where the answer is still not libvips' or Cairo's: `sharp` refuses every operation it cannot honour, and a reduction is now libvips' own: the shim runs `vips_resize`'s arithmetic and all of it — the `gap` of 2 that hands the integer part of a shrink to `vips_shrink`'s box average (`vips_subsample` for `nearest`), then `vips_reduceh`/`vips_reducev` in that order, with the tap count of `vips_reduce_get_points`, the coefficient table libvips picks by a sub-pixel phase rounded to 1/64, coefficients truncated to 1/4096 and the sum rounded by adding half of that and shifting. Measured against host sharp 0.33.5 on 336 resizes (six kernels over nine sizes, three canvases, nine `position`s), a 16x8 input's `resize({ width: 6, kernel: 'cubic' }).raw()` begins `748493ff697155ff8d7e7dff` on both, and so do `nearest`, `linear`, `mitchell`, `lanczos2`, `lanczos3` and every `cover` crop position — 242 of 336 cases byte-identical. Reductions differ too, and with `nearest`: a 32x32 RGBA input at `fit: 'fill', kernel: 'nearest'` is 100 bytes on both at 5x5 and 36 bytes on both at 3x3, hashing 14748630 and 3166490893 on both sides — `nearest` agreeing at 16x8 to 6 was the size measured, not the kernel. An output's channel count is libvips': an 8x8x1 raw input resized to 4x4 is 48 bytes of 3 channels and an 8x8x2 one 64 bytes of 4 on both sides, one band promoted to sRGB and two to sRGB with alpha (row `owc-sharp-resize-output-channels`); the two-band pixels agree everywhere the alpha band is not 255 too, `owc-sharp-resize-alpha-premultiply` retired. Three metadata surfaces are still the container's own rather than libvips': `sharp.versions` lists 2 dependency keys where libvips reports 29 — not because the versions file is absent, since it resolves to `/app/node_modules/@img/sharp-libvips-linux-x64/versions.json`, but because this container has no `getconf` and no `ldd`, so detect-libc's `familySync()` answers `null` and `isNonGlibcLinuxSync()` answers `true`, sharp's `runtimePlatformArch()` is `linuxnull-x64`, and no `@img` package for that platform exists (row `owc-sharp-libc-getconf-versions`) — `sharp.concurrency()` is now the count of CPUs, 11 here as on the host, and `sharp.concurrency(4)` reads back as `4`; `sharp.simd()` still answers `false` and stays `false` unless a caller turns it on, because a shim with no vector unit cannot report one, so the host's `true` is the one metadata answer left unreported; `canvas` draws text with one built-in monoline font, so glyph shapes and advance widths are never the family the page asked for (`monospace` is now the exception: every glyph advances 0.60205078125 em, so `10px monospace` measures 18.0615234375 for `MMM`, `iii` and `WWW` alike), and `measureText` answers that one font's advance whatever family or weight a page asks for: `16px serif` measures `Hello World` at 82.672 here against 78.867 under cairo, `bold 16px sans-serif` measures `Hello` at 36.448 -- the regular face's own number -- against 39.117, and an emoji at `16px sans-serif` 19.200 against 16.000, so rendered ink differs with it (a 32-character `fillText` at `8px sans-serif` on a 40x10 surface covers 126 pixels here and 181 under cairo). Two of cairo's three backends are refused outright: `createCanvas(10,10,'pdf')` and `createCanvas(4,4,'svg')` throw `OWC_CANVAS_UNSUPPORTED: canvas type "pdf"` and `... "svg"` where cairo makes the surface (row `owc-napi-canvas`, closed stale; re-witnessed at HEAD two ways: the row's own 96-line probe answers 95 of 96, the one difference being the documented `pdf` refusal, and an 11-line probe of the text surface alone answers 2 of 11, `font.default` and the documented `monospace` exception, with `font.serif16` 78.867 host against 82.672 here, `font.bold16sans` 39.117 against 36.448, `font.emoji16` 16.000 against 19.200, `ink.fillTextLarge` 181 against 126, `jpeg.len` 867 against 863 and `svg` refused here as `pdf` is); `canvas` also composites in floating point where cairo composites in 8-bit premultiplied bytes, so a blend can land one count off — `lighter` over `#ff8000` with `rgba(0,128,255,0.5)` is `255,192` here and `255,191` under cairo, and `screen`, `xor`, `copy`, `source-in`, `darken`, `hard-light`, `difference`, `destination-out` and `color-dodge` are each off by one in one channel for the same reason; and every encoded length is the shim's own, because cairo writes an indexed PNG and a JPEG with its own tables: a 16x16 two-rect canvas `toBuffer('image/png')` is 1108 bytes here and 121 under cairo, and `toBuffer('image/jpeg')` 780 against 688; `node-pty` gives the child no terminal, so `node -e console.log(11+11)` prints plain `22` where the host's pty prints the yellow `\u001b[33m22\u001b[39m`, and a child a signal ended reports exit 0 with signal 0 where the add-on reports exit 0 with the signal's number, because the container's child has no `waitpid` and hands back a code of `-1` with no signal name at all. A child's output also reaches the shim in one piece: a 200-line child delivers its 1890 bytes in a single `onData` callback here where the real add-on hands them over in 15 to 101, and the same child through a plain `child_process.spawn` coalesces to one `'data'` event here against 59 on the host -- the site is the container's child stdout pipe, not this shim. Re-witnessed at HEAD against host node-pty 1.1.0 over 29 lines on both sides: 27 identical, the two that are not being exactly the two documented limits a 96-line run of this shim's own probe names -- a file that is none of sh, node or a .js file, and `pty.open`. One message is the engine's and not the shim's: `canvasMod.Path2D` is `undefined` on both sides — node-canvas 3.2.3 exports no `Path2D` — so `new canvasMod.Path2D()` throws the engine's own text, `canvasMod.Path2D is not a constructor` under V8 (host) and `not a function` under QuickJS 0.32, which is what bare QuickJS 0.32 gives for `new undefined` with no container in the way.
- Stream, repl, canvas and node-pty residuals, each re-measured against host node v24.15.0 and left rather than fitted. (i) A `pipeline` destination function's proxy stream hands the link before it one chunk at a time, so a `PassThrough` written `'a','b'` and ended reaches the function as `'a','b'` here where the host coalesces them into `'ab'`; the mirror image -- `Readable.from(['a','b'],{objectMode:false})` answering `'ab'` here against the host's `'a','b'` -- is fixed, and the two cannot both hold at once because the host's proxy both coalesces and paces where this one only coalesces. (ii) An error under concurrency stops the pump here one source pull earlier than the host: with `{concurrency:4}` and a function that throws on the first value, the host has pulled `p1,p2,p3` when it stops and this container `p1,p2`. (iii) `stream.isReadable` of a web stream that has been read -- a `Blob` stream, a `Readable.toWeb` stream and a `tee` branch -- is `true` on the host and `false` here, and after a `pipeThrough` it is `false` on the host and `true` here; `isDisturbed` after a `pipeThrough` is fixed and now answers `true` on both. (iv) Node renders an out-of-range concurrency as `Received 1e_+30` where this container writes `Received 1e+30`. (v) `canvas` beyond the text surface: for the same 4x4 `#f00` `fillRect` the host's `toBuffer('image/png')` is 96 bytes and this container's 136 (`toDataURL` 150 against 138), `toBuffer('image/jpeg',{quality:0.9})` and `{quality:0.1}` are 632 and 629 here against the host's 634 and 759 -- the quality is inert here -- a 6x6 filled ellipse's corner alpha is 10 on the host and 7 here, and `createCanvas(4,4,'gif')` is a 4x4 surface on the host and `OWC_CANVAS_UNSUPPORTED: canvas type "gif"` here, a third backend refused beyond the documented `svg` and `pdf`. (vi) `node-pty`: an interactive `sh` prompts `$ ` here against the host's `sh-3.2$ ` and does not echo the exit -- `"$ echo adv-interactive\r\nadv-interactive\r\n$ exit 7\r\n"` here against `"sh-3.2$ echo adv-interactive\r\nadv-interactive\r\nsh-3.2$ exit 7\r\nexit\r\n"` on the host. (vii) The repl: `globalThis.zz = 3` then `zz` prints `3` on the host and raises `Uncaught ReferenceError: zz is not defined` here, `globalThis === this` is `true` on the host and `false` here and a second repl session sees the first one's bindings, `const`, `let` and `class` redeclaration and a `let` after a `var` are silently allowed here where the host raises `Uncaught SyntaxError: Identifier 'c1' has already been declared`, `util.inspect(() => {})` is `[Function (anonymous)]` on the host and `[Function: (anonymous)]` here, and `require('node:repl')` writes `[DEP0040] DeprecationWarning: The ``punycode` module is deprecated" to this container's stderr only. The repl's sites are in the guest repl, `src/process/executors/node/runtime/guest/modules/pure-b.ts`, and are named and not edited. One line is the engine's and not this container's: a destination generator that calls a method on a non-object answers `c.toUpperCase is not a function` under V8 and `not a function` under QuickJS 0.32.
- `sharp` divergences still open against host 0.33.5, each measured and each left alone rather than fitted: **a decoded image's reduction used to land on a different source row than the same pixels handed in raw, and no longer does** — that divergence is gone, not merely narrowed: a 64x64 jpeg reduced to n x n with `nearest` agrees with the raw path at every even width from 8 to 64 -- 11 of the 17 widths it used to differ at, 14, 22, 26, 28, 42, 44, 46, 48, 52, 54 and 56 among them -- because a decoded image is walked in strips of 10 rows where the caller's own pixels are walked in 16; a progressive jpeg is refused outright, `unsupported JPEG: progressive coding (SOF2)`, at every entry point including `metadata()` and `png()`, which covers `progressive: true` and `optimiseScans: true` (row `owc-sharp-jpeg-decode-pixels`, closed stale on 3242831015 and 2888504620, which do hold, and so does an n x n `nearest` reduction of the same 64x64 pixels at every width from 1 to 64 -- 192 cases, from the jpeg, from its own decoded pixels handed back as raw and from a png of them -- so the 17 widths this paragraph used to name are gone as well); **`position: 'attention'` is refused** with `sharp: unsupported operation: option position=17 is not implemented`, where host runs libvips' `vips_smartcrop` and returns bytes — 40x30 to 20x10 `cover` `attention` hashes 3258133504 on host with `attentionX` 19 and `attentionY` 4. Re-witnessed at HEAD `e0ba647` in one container boot over 19 attention crops (five sources at five targets, plus a 48x32 png): every one is refused here, and host answers each with its own centre -- 19/4 at 40x30, 31/5 at 40x30 to 33x17, 19/19 and 31/31 at 64x64, 22/21 at 96x64, 25/4 at 48x32, 7/19 at 100x100 -- so it is the refusal that is left, not one crop. `'entropy'` runs, and its row's own crop is byte-identical (40x30 to 100x10, 3554635574, `cropOffsetTop` -36), but 2 of the 390 entropy crops I measured still walk to a different end, every one a wrapped gradient whose two slices tie to within an ulp — 48x32 to cover 11x40 `nearest` is `cropOffsetLeft` -7 on host and -14 here, and 40x30 to cover 10x100 `nearest` is -80 against -27. It used to be 17 of 336 before the resample was clocked to the crop, so 15 of the 17 were the clock and not the scoring. Composing a `cover` entropy resize with a `flip()`, a `flop()` or a `rotate()` is a surface of its own and still diverges -- 39 of 576, against 16 of 576 at `centre` and 18 of 576 at `top`, which the clock change does not touch. Out of reach: attention is libvips' own model — a 32x32 resize, an sRGB-to-XYZ edge map, a skin-tone vector distance and a blurred argmax — not a scoring function this shim can fit (row `owc-sharp-position-attention-entropy`, closed stale); **`sharp.versions` lists 2 dependency keys where libvips reports 29** — not because a versions file is missing, since `@img/sharp-libvips-linux-x64/versions` resolves, but because this container has no `getconf`, so detect-libc's `familySync()` answers `null` and sharp's `runtimePlatformArch()` is `linuxnull-x64`. The fix site is the guest shell, which implements no `getconf` at all, and not this shim (row `owc-sharp-libc-getconf-versions`, closed stale). Re-witnessed at HEAD `e0ba647`: `command -v getconf` and `command -v ldd` both exit 1 in a container boot and `/usr/bin` holds `env` and nothing else, so the site is the shell's command set (`packages/core/src/shell/commands/`), outside `packages/core/src/napi/sharp/`. `owc-sharp-outside-cover-nearest-row` is retired: its three criterion hashes now match, and so do `owc-sharp-cover-reduce-nearest-row`'s three, the whole 986-case sweep the two were found in being byte-identical now. Re-witnessed at HEAD `a235a3b` in a single container boot per side (`npm install --no-audit --no-fund sharp@0.33.5`, then `node /app/main.js`): the six criterion hashes, the 8x8x1 -> 4x4 output of 48 bytes of 3 channels and the 8x8x2 one of 64 bytes of 4, the two-band premultiplied resize, the alpha-0 one that comes out all zero and the alpha-255 one are each byte-identical to host sharp 0.33.5, and the boot answers 0 failures against a 68-key expectation table — `owc-sharp-resize-output-channels` and `owc-sharp-resize-alpha-premultiply`, closed resolved. `owc-napi-sharp-resample-fidelity` is closed stale at the same HEAD: every kernel it names -- `cubic`, `lanczos2`, `lanczos3`, `mitchell` -- and every `cover` position from `0` to `8` plus `top`, `bottom`, `centre`, `left`, `right`, `center`, `north`, `northeast`, `southeast`, `south`, `southwest`, `west`, `northwest` and `east` now agree byte for byte on a 16x8 -> width-6 resize and a 40x30 -> 20x10 crop (46 cases, 0 differing) -- and not the two-word corners, which host 0.33.5 refuses outright with `Expected valid position/gravity/strategy for position but received top left of type string`, and this shim refuses identically, so there are no pixels there to agree on, and so do the two shapes the row filed as refuting `nearest` (a 32x32 RGBA at 5x5 hashing 1818854581 and at 3x3 hashing 3934998412 on both sides, where the row measured 14748630 against 2661521518 and 3166490893 against 3920053022); what that row measured is gone. The two models that closed them are the shim's own: the rows a `vips_reducev` sum restarts at are the rows the operation after it asks to have refilled, which for an embed is every 16 canvas rows MINUS the embed's own top (a 48x32 -> contain 40xH nearest reduce, the same 32 -> 27 one at every H, restarts at rows 16, 13, 15, 18 and 7/23 for H of 27, 33, 30, 55 and 45, where the embed's top is 0, 3, 1, 14 and 9), and `vips_affine` builds its horizontal position from the column the crop after it will keep, not from column 0 (16x8 -> cover 40x30 nearest agrees at every column of its 60x30 enlargement and only ever differed at column 5 of the crop). What is left of the nearest divergence is one output row of one shape: a 64x64 source reduced vertically and then enlarged horizontally -- `resize({width:100,height:H,fit:'fill',kernel:'nearest'})` -- takes the source row above libvips' at H of 22, 33, 44 and 57 and one row only, and no strip model gives both those four and the other 20 heights -- over 32 heights of that shape, restarting the running sum every 1, 2, 4, 8, 10, 16, 32 or 64 rows leaves 22, 22, 19, 13, 15, 9, 4 and 4 of them wrong against 4 for the continuous sum the shim runs today, and neither of the two substitutes for it (a per-row multiply, or `d * shrink + c`) does better -- so it is recorded rather than fitted: 8 of the 993 nearest and linear resizes a 3591-case differential measures (64x64 -> fill 100xH and 200xH nearest at the same four heights, 8 of 48). It used to be two shapes and not one: the same wrong source row reached every `nearest` and some `linear` `cover` crop at `position: 'entropy'`, because the resample was clocked to where a centred crop would land instead of to where the entropy crop actually did -- 96x64 -> cover 33x17 nearest was 1683 bytes hashing 2190852216 on host and 1664326976 here with `cropOffsetLeft` 0 and `cropOffsetTop` 0 on BOTH sides, the same crop over different pixels. That one is fixed rather than recorded: the entropy crop now clocks the resample to the crop it picked, which took 336 cover-entropy resizes from 17 differing to 6 and left the 1008 gravity controls at 0, and it is left alone where a flip, a flop or a rotation sits between the two frames (576 such cases: 43 differing before, 39 after).
- `hypercore`: `random-access-memory` is a backend `hypercore` 10 accepts and 11 does not — `new Hypercore(RAM)` on 11 throws `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined` from `hypercore-storage`'s `path.join(db.path, '..')` on host Node 24.15 as well, because 11 stores in RocksDB; `hypercore` 10.38.2 on `random-access-memory` runs here and prints `OK block=hello world length=1`, byte-identical to host Node 24.15. `hypercore` 11 does not load at all: `rocksdb-native` is served by the `rocksdb` shim (`prebuilds/<platform>-<arch>/rocksdb-native.node`, resolved by `require-addon`), but `require('hypercore')` then dies at `fs-native-extensions`, which `device-file` needs for its file locks, with `Cannot load addon 'file:///node_modules/fs-native-extensions/prebuilds/linux-x64/fs-native-extensions.node'`; past that, `new RocksDB()` throws `TypeError: not a function` at `rocksdb-native/lib/column-family.js:72`, because what the shim serves is the leveldown store and has no `columnFamilyInit`, `snapshotCreate`, `iteratorInit`, `readBuffer` or `writeBuffer`, where the real add-on (measured on Node 24.15) exports all of them
- `hypercore`'s tree hash uses `sodium.crypto_generichash_batch`, which the sodium shim computes as one BLAKE2b over the batch's concatenation: measured against the real add-on, a batch of `'a'` and `'bc'` under a 32-byte key is byte-identical to `crypto_generichash` of `'abc'` and not to `'a'`
- Utilities a browser container cannot have report it instead of exiting 127: `ping`, `dig`, `traceroute`, `nc`, `netstat`, `ss`, `ip`, `ifconfig`, `nft`, `systemctl`, `cron`, `crontab`, `chroot`, `su`, `sudo`, `usermod`, `groupadd`, `groupdel`, `lspci`, `iostat`, `vmstat`, `perf`, `tmux`, `vi`, `import`, `xclip`, `open` and `write` each write `<name>: not supported on this runtime: <reason>` and exit 1 — `ping` with `ERR_NO_RAW_SOCKET` and `lspci` with `ERR_NO_PCI_BUS`; `make` (variables, pattern rules, `.PHONY`, automatic variables), `bc` (arbitrary precision, `scale`, `sqrt`, `ibase`/`obase`) and an `openssl` subset (`dgst` with md5/sha1/sha224/sha256/sha384/sha512 and `-hmac`, those digests as shorthand commands, `rand -hex/-base64`, `version`) are implemented, and `man` answers from its own short pages (`man ls` prints `NAME`/`SYNOPSIS`, `man nosuchcmd` prints `No manual entry for nosuchcmd` and exits 1). `make --version` is not one of the implemented options: it exits 2 with `make: invalid option -- '-version'` where GNU Make prints its version
- The shell now provides the POSIX utilities as JavaScript over the virtual file system: the text filters (`grep`, `sed`, `awk`, `cut`, `sort`, `tr`, `paste`, `uniq`, `wc`, `head`, `tail`, `join`, `comm`, `diff`, `fmt`, `pr`, `tabs`), the file utilities (`find`, `xargs`, `stat`, `date`, `printf`, `expr`, `test`, `seq`, `base64`, `base32`, `xxd`, `split`, `install`, `ln`, `chown`, `chmod`, `du`, `df`, `tee`, `sleep`, `yes`, `basename`, `dirname`), the archives (`gzip`, `gunzip`, `zcat`, `compress`, `uncompress`, `tar`, `cpio`; no `bzip2` or `xz` codec is available), the shell builtins (`set`, `export`, `alias`, `type`, `trap`, `read`, `pushd`/`popd`, `source`), globbing (`*`, `?` and `[...]`, with an unmatched pattern left literal as the host leaves it) and the operators `;`, `&&`, `||`, `|`, `<`, `>`, `>>`, `2>&1` and `2>/dev/null`
- **`vm` `timeout` is enforced for JavaScript loops** — measured: `ERR_SCRIPT_EXECUTION_TIMEOUT` after 52 ms against 53 ms on host Node — but not for time spent inside a native built-in, which runs to completion past the deadline, and not for a loop inside an `async` function's body, which the deadline stops without ever raising: `vm.runInNewContext('(async function(){ while(1){} })()', {}, {timeout: 60})` `THREW ERR_SCRIPT_EXECUTION_TIMEOUT in 61ms` on host Node 24.15 and `RETURNED in 60ms tag=[object Promise]` here, because an interruption this engine raises inside a suspended async function becomes a rejection of that function's promise and not an abort of the `evalCode` that started it -- bare QuickJS 0.32 with an interrupt handler of its own and no container in the way answers `ERROR InternalError: interrupted` for `(function(){ while(1){} })()` and a rejected promise for the async spelling. **`vm` contexts now have a realm of their own**: the host keeps a second QuickJS context on the same runtime and *runs the code of a context in it* -- the `with` scope the guest builds around the sandbox is handed to a wrapper compiled in that realm (`REALM_EXEC_SRC` in `capabilities/vm.ts`), and the ES globals that scope answers for are that realm's -- so a value a context makes is of another realm as it is made and is handed back as it is: `vm.runInContext('[1,2]', ctx)` answers `false` to `instanceof Array` with `Array.isArray` still `true` and `Object.prototype.toString.call` still `[object Array]`, `vm.runInContext('({a:1})', ctx)` answers `false` to `instanceof Object`, and `runInContext('Array') === Array` is `false`, as on the host. What the caller puts **into** a context is the caller's still and is handed back as it is, so `vm.runInNewContext('e instanceof Array', { e: [1] })` is `false` here and `false` on host Node 24.15 -- measured for thirteen builtins, `Array`, `Object`, `Date`, `RegExp`, `Error`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Promise`, `ArrayBuffer`, `Uint8Array` and `Function`, and for `e.constructor === Error` and `Object.getPrototypeOf(e) === Error.prototype`, while `Symbol` is `false` on both -- and `[] instanceof Array` *inside* a context is still `true`, as on the host, because the literal is built by the realm the code runs in (row `owc-vm-context-shares-caller-realm`, closed). It is running the code there, rather than rehoming what it answered, that gives a context back its **identity** too: `vm.runInContext('h.o', ctx)` twice is one object (`a === b`, and a `h.o.x = 5` between the two runs read by the first), as it is on the host. No value is copied on the way out any more, so the rebuild in `capabilities/vm.ts` now carries only the one error a context has no hand in -- the `ERR_SCRIPT_EXECUTION_TIMEOUT` a `timeout` raises, which host Node raises in the context's realm -- and the depth and value-count bounds it used to carry went with the copy (an earlier claim that the walk dropped every key after the second whose value was an object was stale and wrong: `vm.runInNewContext('({o:{x:1}, p:{y:2}})')` is `{"o":{"x":1},"p":{"y":2}}`, `vm.runInNewContext('[{q:1},{r:2}]')` is length 2, row `owc-vm-realm-rebuild-drops-keys`, closed). Every `vm` context of one process has a realm of its own rather than all of them sharing one, so `vm.runInNewContext('[]') instanceof vm.runInNewContext('Array')` is `false` here, as on host Node 24.15, whose two runs are two contexts (row `owc-vm-context-shares-caller-realm`, closed). A rejection a context leaves unhandled is still one the process reports: the second realm gets its own copy of the rejection tracker, and the cells it records are handed to the guest's `api.noteRejection`, where every other rejection of the process waits. `Map`, `Set` and `Promise` cross whole: what a caller reads out of one -- a key from `keys()`, a value from `get()`, a member of a `Set`, the value a promise resolves with, the reason it rejects with, an `Error` inside a `Map` -- is an object of the second realm and answers `false` to `instanceof` against the constructor of the caller, and a `Promise` subclass out of a context keeps the name of its own class (`P`, not `Promise`). `util.types.isPromise` answers `true` for every promise a context makes -- a promise built there, one `Promise.resolve` built, one an `async` function returned and one an executor settled -- and `util.inspect` of one prints what it settled with (`Promise { 1 }`, `Promise { <pending> }`, `Promise { <rejected> r }`), because the tag is read and not `instanceof`, and because what a promise settles with is recorded as it settles: every promise built through `Promise` goes through one subclass whose `resolve` and `reject` are wrapped, in the guest realm and in a context's (row `owc-vm-realm-map-set-promise-instanceof`, closed). A function out of a context keeps its `name` and `length` (`foo`/2), an async function and a generator answer `AsyncFunction` and `GeneratorFunction` to `constructor.name`, a `Map` and a `Set` print their entries under `util.inspect` (`Map(1) { 1 => 2 }` and `Set(1) { 1 }`), a cross-realm `Promise` answers `Promise`, a `DataView` answers `false` to `instanceof DataView`, and a class that extends a host constructor keeps its own name (`D`, not `Array`, and `D.name` is `D`) -- each the real thing now, and not a copy of it. The two identities only the realm that made a value knows are answered now: a second realm is handed the guest realm's own `Proxy`, so the record that constructor keeps names a proxy a context made and `util.types.isProxy` reads `true`, as on host Node 24.15, and `util.inspect` reads a value out of a context by its tag and not by `instanceof` -- which a cross-realm value answers `false` to on the host as well -- so an error prints `Error: boom` and not `Error {}`, and a `Date` and a `RegExp` print as they do on the host (row `owc-vm-realm-rebuild-shape`, closed). The **sandbox reaches a context's global object as it is and not as an assignment would copy it**: a property the caller declared `enumerable: false` is `enumerable: false` inside the context too (`Object.getOwnPropertyDescriptor(globalThis, 'hid').enumerable` is `false` on both, and `Object.keys(globalThis).indexOf('hid')` is `-1`), a getter the sandbox carries is an **accessor** inside the context and not the value it answers -- `Object.getOwnPropertyDescriptor(globalThis, 'g')` names `get` on both, and the getter is called once by the read that asked for it and not a second time by the copy -- and a name the *code* of the context made stays in the context when the caller drops it from the sandbox (`vm.runInContext('w = 4', ctx)` followed by `delete s.w`: `typeof w` is `number` inside and `s` carries no `w`, as on host Node 24.15) while a name the sandbox brought is taken out with it. A context's global object is untagged as Node's is: `Object.prototype.toString.call(globalThis)` inside a context is `[object Object]` here and on the host, this engine putting an own `Symbol.toStringTag` of `global` on every raw global object it makes, which `bridgeGlobals` in `capabilities/vm.ts` takes off, and `Object.getOwnPropertySymbols(globalThis)` names the sandbox's symbol and nothing else. `Object.getOwnPropertyNames(Promise.prototype)` is `catch`, `constructor`, `finally`, `then` in a context and in the guest realm alike, as it is on host Node 24.15: `Promise` is a subclass in both -- the rejection tracker's, which is what records what a promise settles with -- so the three a promise answers to were inherited and not own, and are now put on that subclass's prototype, the same functions under the same flags.
- **`vm` realm limits that are the engine's own**, each proved against bare QuickJS 0.32 with no container in the way. `vm.Script` cached data is the one that is left: `new vm.Script('1+1', { produceCachedData: true })` leaves both `cachedDataProduced` and `cachedData` `undefined` where host Node 24.15 answers `true` and a 336-byte `Buffer`, and `quickjs-emscripten` 0.32 exposes no bytecode entry point on its module or its context, so there is no cache to hand back (row `owc-vm-script-cachedata`). One promise-shaped gap is the engine's too: the promise an `async` function returns is built from the intrinsic and never from the global binding, so no wrapper of `Promise` sees what it settles with -- measured out of the container, replacing `globalThis.Promise` with a subclass under bare QuickJS 0.32 leaves `(async function () {})()` an instance of the native constructor and not of the subclass -- and `util.inspect` of such a promise prints `Promise { <pending> }` where the host prints the value it settled with -- a `then` handler attached to watch the settlement is not a lever, because it runs in a microtask and `util.inspect` answers synchronously, and the state itself is reachable from the host alone (`getPromiseState` of `quickjs-emscripten`), not from the guest realm `util.inspect` runs in. Everything else this paragraph used to name is answered now: every `vm` context has a realm of its own, a top-level `let`, `const` or `class` survives into the next run of the same context, a `Script`'s `filename` and `lineOffset` reach the frames of the error it throws, `vm.measureMemory` is a function, and `Float16Array`, `Iterator`, `SuppressedError` and `WebAssembly` -- with the statics `Array.fromAsync`, `Error.captureStackTrace`, `Error.stackTraceLimit`, `Symbol.dispose`, `Symbol.asyncDispose` and `RegExp.input` -- are what host Node 24.15 says they are inside a context. `Array.fromAsync` is built in `guest/globals.ts` because bare QuickJS 0.32 has none, and `Math.sumPrecise`, which QuickJS has and V8 does not, is taken off `Math` so `typeof Math.sumPrecise` is `undefined` here as on the host. One more is the engine's: a name a context declares with `var` is a **non-configurable** property of the realm's global object, so `delete globalThis.v` inside a context cannot remove it and the caller's sandbox keeps it -- `s.v` is still `1` and `Object.keys(s)` still names `v` where host node 24.15 removes both, and `Object.getOwnPropertyDescriptor(globalThis, 'v').configurable` is `false` here against `true` there -- proved out of the container, bare QuickJS 0.32 with no container in the way answers `configurable: false` for `var v = 1` and `true` for the plain assignment `g = 1`, which is what the specification asks a global var binding to be and not something a wrapper around the code can undo. `util.inspect` of an array too long for one line packs its entries the way host node 24.15 does now -- twelve right-aligned numbers to a line for `Array.from({length:80},(_,i)=>i)`, right-aligned because every entry is a number and left-aligned for any other kind, and `[1,2,3,4,5,6,7]` as `\n  1, 2, 3, 4,\n  5, 6, 7\n` and not `[ 1, 2, 3, 4, 5, 6, 7 ]` -- because the multiline branch of `inspectValue` in `guest/util-assert.ts` carries node's own `groupArrayElements`, ported from the `lib/internal/util/inspect.js` of the running host: as near a square of entries as a character 2.5 times as high as it is wide allows, capped by the line width, by four times `compact` and by fifteen columns, and an array of more than six entries that it packs never goes back to one line. One thing a `vm` case shows is not the engine's and is still open: a process that ran a `vm` context can end with one extra line on stderr the host never prints, `Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: ../../vendor/quickjs/quickjs.c,2036,JS_FreeRuntime)`, the assertion `quickjs-emscripten` is built with when a runtime is freed with objects still on its list -- 3 for 3 on one 22-probe case, 0 for 9 on that case's single-construct variants, so it is an accumulation over a run and not one construct's.
- A `WebAssembly.Table` holds what the host will accept: a table of function type takes WebAssembly function objects, so a JavaScript function a guest `set`s is kept on the guest side (its own `get` returns it) while the module sees an empty slot
- `FinalizationRegistry` never runs cleanup callbacks (host Node fires one after `gc()`; this engine build has no GC observation), but a `WeakRef` target that becomes unreachable *is* collected — after allocation pressure `deref()` returns `undefined` where Node 24.15 still returns the target; `MessageChannel` delivers only inside the process
- Worker messages deliver a `Uint8Array` where Node does and keep every other view's own class, as the host does: `parentPort.postMessage(Buffer.from('worker-buf'))` gives `Buffer.isBuffer(m)` `false`, `m.constructor.name` `Uint8Array` and `String(m)` `119,111,114,107,101,114,45,98,117,102`, and a `MessageChannel` port agrees, because a structured clone flattens a `Buffer` and no other view: an `Int32Array`, a `Float64Array`, a `Uint16Array`, a `Uint8ClampedArray`, a `BigInt64Array` and a `DataView` each come back the kind they were posted as, with their own `BYTES_PER_ELEMENT` and their element `length` rather than their byte length, and a view that subclasses one of them the base class it extends. `cpEncode`/`cpDecode` in `runtime/guest/modules/child.ts` now tag a view with the kind it was posted from, and a `Buffer` with the `Uint8Array` it clones into (row `owc-worker-buffer-identity`, closed; re-witnessed at HEAD, seven lines identical on both sides: `isBuffer=false`, `ctor=Uint8Array`, `instanceofUint8Array=true`, `isView=true`, `byteLength=10`, the byte list and `END=ok`). The one thing a clone still carries that this one does not is the offset: the host's clone of `new Int32Array(new ArrayBuffer(16), 4, 2)` answers `byteOffset` `4`, and of a `DataView` over the same buffer `4`, because it copies the whole backing store, where this one answers `0` for both -- the bytes of the view are right, only where they sit in the buffer is not. A `Buffer` sent over `child_process` IPC is *not* host-identical either way — the host's IPC is JSON and answers `{ type: 'Buffer', data: [...] }` — but it is a `Uint8Array` here rather than a `Buffer`, which is the closer of the two;
- **A `WebSocket` instance carries none of Node's internal slots**: `Object.getOwnPropertySymbols(ws)` is `[]` where host Node 24.15 reports `Symbol(kEvents)`, `Symbol(events.maxEventTargetListeners)`, `Symbol(events.maxEventTargetListenersWarned)` and `Symbol(kHandlers)`, and `Object.getPrototypeOf(WebSocket.prototype)` is a stand-in object that looks like `EventTarget.prototype` without being it — a socket here never runs an `EventTarget` constructor, so nothing installs those slots, and making the stand-in *be* `EventTarget.prototype` would put `addEventListener` among `WebSocket.prototype`'s own names, which host Node does not
- **A client that offers no subprotocol and is handed one anyway ends differently**: host Node 24.15 throws an uncaught `TypeError: Cannot read properties of null (reading 'includes')` out of `internal/deps/undici` and exits 1 with that stack on stderr, where the container fails the handshake cleanly with an error event, a `close` carrying 1006 and exit 0. Both refuse the connection; only the crash is missing, and it is a bug in that undici build rather than behaviour worth reproducing
- `process.kill` matches host Node 24.15 on the same script **whether or not a listener is registered for the signal**: with one, `process.kill(process.pid, s)` for each of `SIGPIPE`, `SIGWINCH`, `SIGUSR1`, `SIGUSR2`, `SIGTERM`, `SIGHUP`, `SIGINT` and `SIGQUIT` returns `true`, runs the listener a turn later and leaves the process running, byte-identical to the host on all eight. With **no** listener the two sides agree too: host Node ignores `SIGPIPE`, `SIGWINCH`, `SIGCHLD`, `SIGCONT`, `SIGURG`, `SIGXFSZ` and `SIGIO` and returns `true`, opens the debugger for `SIGUSR1` and exits 0, dies by the named signal for `SIGUSR2`, `SIGALRM`, `SIGTRAP`, `SIGSYS`, `SIGXCPU`, `SIGVTALRM`, `SIGTERM`, `SIGHUP`, `SIGINT` and `SIGQUIT`, and throws `ERR_UNKNOWN_SIGNAL` for a name it cannot parse (`'NOPE'`, `'sigusr1'`, `'9'`, `'0'`, `'SIGSTKFLT'`). This container now answers each of those the same way on stdout and in its exit code: `true` and the run goes on for every name a host ignores and for `SIGUSR1` (it has no inspector to open, so the host's `Debugger listening on ws://127.0.0.1:9229/...` on stderr is the one line it does not write), `128 + ` the signal number for the twelve that are fatal — `129` `SIGHUP`, `130` `SIGINT`, `131` `SIGQUIT`, `143` `SIGTERM`, `159` `SIGUSR2`, `142` `SIGALRM`, `133` `SIGTRAP`, `140` `SIGSYS`, `152` `SIGXCPU`, `154` `SIGVTALRM`, `134` `SIGABRT`, `137` `SIGKILL` — and the same `ERR_UNKNOWN_SIGNAL` (`TypeError`, `Unknown signal: <name>`) for all five names a host cannot parse. `process.kill(process.pid, 0)` is `true`, a pid that is not there throws `ESRCH` (`kill ESRCH`), a live child answers `0` with `true` and `SIGTERM` with `true` and then exits with `null SIGTERM`, and `process.kill(process.pid)` ends this process with status 143, which is Node's own answer. Rows `owc-process-kill-signal-fatal` and `owc-signal-self-no-listener-status` are closed by it; the fix is in `proc.kill` in `packages/core/src/process/executors/node/runtime/guest/globals.ts`, which now carries the host's own default disposition per name instead of one `128 + 15` for every name it does not deliver. Re-measured at HEAD `ee97ee07`, one fresh container per case: a listener is now handed the two arguments node hands it, the signal name and its number (`SIGTERM|arg0=SIGTERM|arg1=15|n=2`, byte-identical for all 25 names host node 24.15 accepts, where this container used to invoke it with none), and `process.kill` now validates its arguments the way node does -- `process.kill(undefined, 'SIGTERM')` is `ERR_INVALID_ARG_TYPE | The "pid" argument must be of type number. Received undefined` instead of `ESRCH`, an integer the host numbers no signal by (`-1`, `32`, `64`, `1000000`) is `EINVAL` (`errno=-22`, `syscall=kill`) instead of `ERR_UNKNOWN_SIGNAL`, and signal a caller leaves out is `SIGTERM`, and so is every other value a host reads as no signal having been named -- `''`, `null`, `false` and `NaN` all end the process at 143 on host Node 24.15 and now here -- while the number `0` (and `-0`, which is the same number) is not an absence but the null signal and answers `true`. A signal a listener was registered for and then lost does not go back to the disposition Node started with but to the host's own: measured at HEAD `4c7b424`, one fresh container per case, `process.on('SIGUSR1', h); process.removeListener('SIGUSR1', h); process.kill(process.pid, 'SIGUSR1')` ends the process at 158 on both sides (as does `removeAllListeners`), where an untouched `SIGUSR1` still opens the inspector and exits 0; `SIGPIPE` and `SIGXFSZ`, which Node ignores at startup, end it at 141 and 153 once a listener has been taken away, again on both sides; and `SIGTSTP`, `SIGTTIN` and `SIGTTOU` are ignored by host Node 24.15 whether or not a listener was ever registered for them, where this container used to end the process at 146, 149 and 150.
- Recorded rather than fixed, each measured at HEAD `e3e16ae` against host Node 24.15 with stdout, stderr and exit on both sides: `events.once(e, name, { signal })` **never settles** when `signal` aborts -- host Node rejects `AbortError: The operation was aborted`, this container leaves the promise pending for as long as the process runs, a silent hang and not a throw; `events.EventEmitterAsyncResource` is `undefined` here and a function on the host, and `Object.keys(require('events'))` is 12 names here against 15 (`EventEmitterAsyncResource`, `addAbortListener` and `usingDomains` are the three that are missing); `Response`/`Request` `.formData()` on a `multipart/form-data` body resolves an **empty** `FormData` with no error where host Node answers two entries, while `application/x-www-form-urlencoded` is host-identical; `node:stream/consumers`' `json()` on invalid JSON reports QuickJS's words, `SyntaxError: expecting property name`, against V8's `Expected property name or '}' in JSON at position 1 (line 1 column 2)` -- engine-limited, because bare QuickJS 0.32 produces this container's exact string with no container in the way, so it is recorded and not chased; and `crypto`'s `ERR_INVALID_ARG_TYPE` type lists drop `ArrayBuffer` -- `scryptSync`, `pbkdf2Sync` and `createSign().sign` say `string or an instance of Buffer, TypedArray, or DataView` where the host says `ArrayBuffer, Buffer, TypedArray, or DataView` -- `createHash().update(new ArrayBuffer(4))` is accepted here where the host refuses it, the `Received type number (1)` tail is missing from `update` and `randomFillSync` messages, `webcrypto.getRandomValues(1)` returns instead of throwing `TypeMismatchError`, and `createDiffieHellman(1)` is `ERR_OUT_OF_RANGE` here against the host's `ERR_OSSL_DH_MODULUS_TOO_SMALL`. Fix sites, none of them this shard's: the `events`, `crypto` and fetch capability and guest modules under `packages/core/src/process/executors/node/runtime/`; rows `owc-events-once-abort-hangs`, `owc-formdata-multipart-empty` and `owc-crypto-argtype-messages`, all open — and all three closed since: `events.once` rejects `AbortError: The operation was aborted` as the host does, a `multipart/form-data` body parses to its two entries, and the `crypto` type lists carry `ArrayBuffer` (a `createHash().update(new ArrayBuffer(4))` is refused, `Received type number (1)` tails are back, `webcrypto.getRandomValues(1)` throws code 17, and `createDiffieHellman(1)` is `ERR_OSSL_DH_MODULUS_TOO_SMALL`)
- QuickJS 0.31 printed `Assertion failed: list_empty(&rt->gc_obj_list)` at teardown after correct output (`mathjs`, `prettier`, `typescript`, `uglify-js`, `xlsx`, `jsdom`); the pinned 0.32 engine passes all six in the corpus. `prettier` 3.9.10 was re-measured here: its formatted output is byte-identical to host Node's
- `sass` compiles: dart-sass 1.106.0 `compileString` returns CSS byte-identical to host Node's, for a flat rule and for one that goes through `@use "sass:math"`. The hang this entry used to describe does not reproduce
- `liquidjs` 10.30.0 does not load: `require('liquidjs')` raises `stack underflow (op=110, pc=301)` where host Node 24.15 imports it and prints `OUT 1;2;`. This is a QuickJS bug and not this container's. It reduces to one line —

      function* inner(a) { for (const x of (yield a)) { } }

  — a `yield` in the iterable of a `for...of` head, which QuickJS cannot compile: the failure is at
  compile time, so no statement of the file has run when it lands, and it is not a regression the
  0.31 to 0.32 upgrade brought or undid. Measured on every variant this project can load: 0.32
  singlefile-asyncify (the one the container uses) and 0.32 wasmfile-debug both say
  `stack underflow (op=110, pc=8)`, and 0.31 singlefile-asyncify, 0.31 wasmfile-release-sync and
  0.31 asmjs all say `stack underflow (op=112, pc=8)`; the same source under bare QuickJS with no
  container in the way fails identically, so nothing here rewrites or mis-handles it. Host Node 24.15
  runs it: `inner([1, 2, 3]).next()` yields `{"value":[1,2,3],"done":false}` and the next `next()`
  finishes. There is no guest-side way past it — rewriting `yield` out of a `for...of` head is a
  source transform over every module the container loads, and QuickJS exposes no hook to fix the
  code it generates
- `AsyncLocalStorage` context is not carried across `await` (timers, ticks and `.then` callbacks do carry it): the store is present before the first `await` and `undefined` after it. Measured in the container, `await` of a promise the guest built does reach the JS-visible `then` — one instrumented `Promise.prototype.then` counts gets=1 calls=1 for `await Promise.resolve(1)` and for `await new Promise(function (r) { r(2); })`, and 0 for `await null` and for a promise the engine built itself — because every guest promise is a subclass of the intrinsic `Promise` and QuickJS 0.32 fast-paths `await` only for the intrinsic promise class. What loses the store is when that `then` runs and not whether it runs: the engine defers it to a job of its own, so it lands after the async function has suspended and `run`'s `finally` has already restored the frame — inside the `then` an `await` reaches on the first suspension of `als.run('S', ...)`, `getStore()` is already `undefined`. The 0 this entry used to quote is the bare engine's, where `globalThis.Promise` is still the intrinsic: the same instrumentation on the same engine reads 0 before a `Tracked`-style subclass is installed as `globalThis.Promise` and 1 after. With no store entered around the flow the value after `await` is `undefined`; with `als.enterWith('E')` active it is that leaked ambient frame, `E`, and still not `S`. A `.then` reaction registered before an `enterWith`, and a timer queued before it, now see no store here as they do on the host: a reaction is bound to the frame of its registration, and a callback captured with no frame runs with none. It needs the host hook V8's `SetPromiseHook` gives Node's `async_hooks` — a hook on job enqueue — and the shipped engine has none: its whole C surface is 77 `QTS_*` entry points whose only promise and job names are `QTS_NewPromiseCapability`, `QTS_PromiseState`, `QTS_PromiseResult`, `QTS_IsJobPending` and `QTS_ExecutePendingJob`, and it exports no `addFunction`, so no callback of our own can be installed either
- Shell: `;` separators and `|` pipes work — measured against this machine's `/bin/sh`, they agree on stdout, stderr and exit code — and so does globbing. What does not agree: `chmod` and `fs.chmodSync` succeed and change nothing, so `chmod 755 f; stat -c %a f` prints `644` where the host prints `755`; `touch a b c` creates only `a`, where the host creates all three; `ls -l`, `ls -a` and `ls -la` are accepted and ignored, so no long format and no dotfiles are ever printed
- `node` and `npm` run only on a line of their own: joined to another command with `;`, `&&` or `||`, or put in a pipeline, they write `<name>: cannot run here: it can only be run on a line of its own, where the shell can wait for it` (exit 127 for the command). `npm run` does work, including `pre`/`post` lifecycle scripts, `npm install` writes `package-lock.json` at lockfileVersion 3, and global installs are refused (`Global installs are not supported by this runtime`, exit 1)
- `npm install` of a package whose tree carries per-platform optional dependencies exits 1 where host npm exits 0: `typescript` reports `EBADPLATFORM` for `@typescript/typescript-aix-ppc64` and the rest, and `esbuild` reports `ENOEXEC`, and in both cases the package itself is installed
- `node --version` is resolved as a file, not a flag: it fails with `Cannot find module '/app/--version'` and exit 1, where host node prints `v24.15.0`. `npm --version` prints `10.9.0`. Every `node`/`npm` command's output is written twice, once as it is produced and once from the result the shell gets back
- Processes now match Node where this entry used to diverge: an unhandled promise rejection is reported with its error and ends the process with status 1, and a `domain` catches a rejection thrown inside a `.then` callback inside `d.run()` (`domain.promise` is the error's message in both)
- `Error.captureStackTrace` now hands a `prepareStackTrace` the frames the host hands it: with `Error.prepareStackTrace = (o, s) => s` and `Error.stackTraceLimit = 10`, `obj.stack` is an array of 10 CallSites here where it was an empty array, and `captureStackTrace(this, Sub)` stops at the constructor as the host does, so `depd`'s `getStack()` works again — `express.Router()` prints `TYPE function STACK 1` and `http-errors`' `createError(404,'nope')` prints `STATUS 404 MSG nope EXPOSE true`, byte-identical to host Node 24.15, where both used to die with `cannot read property 'getFileName' of undefined`. A `Headers` iterates `set-cookie` once per value, as the host does, and `os.uptime()` is the container's own uptime rather than a flat `0`. `process.features` reports 10 of the flags host Node 24.15 reports (`inspector`, `debug`, `uv`, `ipv6`, `tls`, `tls_alpn`, `tls_sni`, `cached_builtins`, `openssl_is_boringssl`, `require_module`); `tls_ocsp` and `typescript` are left out rather than claimed, since this tls has no OCSP stapling and a `.ts` file is not stripped of its types here
- A rejection of an `async function`'s own promise is not reported: `(async function () { throw new Error('x'); })();` goes on to the next statement and ends the process with status 0, where host Node 24.15 writes the error to stderr and exits 1 without running a later timer. Every promise the guest builds itself is tracked — one `Promise` subclass records a rejection when it happens and records a handler when one is attached — but the engine builds the result of an async function with its intrinsic `%Promise%` and not through `Promise[Symbol.species]`, so no cell exists for it; measured with `then`, `catch` and `finally` patched on that intrinsic's prototype, a discarded async function's promise is never touched at all, so nothing in the guest can see the rejection. It needs the hook QuickJS's C API names `JS_SetHostPromiseRejectionTracker`, or a hook on job enqueue, and `quickjs-emscripten` 0.32 exports neither that nor `addFunction`, so no callback can be installed — the wrapper's own hand says so: `quickjs-emscripten-core`'s `RuntimeOptions` type declares `promiseRejectionHandler?: TODO<"JSHostPromiseRejectionTracker">` and not one runtime file of the three pinned packages mentions that name (0 of 51). A rejection of a promise the guest did build, and one an `await` or a `.then` reaches, are reported and end the process with status 1, as they do on the host, and they reach whoever is waiting for them: a guest-built promise's rejection prints `DOMAIN tracked-reject` on both sides, while an async function's prints `LISTENER asyncfn-reject` with a `process.on('unhandledRejection')` listener and `DOMAIN asyncfn-domain` inside `d.run()` on host node 24.15 and prints nothing at all here. Bare QuickJS 0.32 is where the difference ends: draining the pending jobs after `Promise.reject(new Error('x'))` and after a throwing async function throws nothing and leaves `globalThis` untouched for both, so the engine itself reports no unhandled rejection of any kind and every rejection this container does report is one its own `Promise` subclass saw
- `readline` keypress events are delivered: `readline.emitKeypressEvents(stream)` makes the stream emit `keypress` with the character and Node's key record, and `createInterface({ terminal: true })` installs it on its input. Measured against host Node 24.15 over 35 sequences, the name, the `ctrl`/`meta`/`shift` flags, the `sequence` and the `code` agree for every one of them except the malformed `ESC [ 1 ; 1 0 A`, which the host splits into two keys and this one reads as one; a lone escape is not a key in either, and a sequence split across two `write`s is held until it is complete. A `Promise` reaction registered inside `d.run()` sees `domain.active` as the domain, as it does on the host
- Two words in `readline`'s own surface are the engine's and not this module's: `rl.historySize = 5` and `rl.isFlushing = true` under `'use strict'` throw `TypeError: no setter for property` here where host Node 24.15 throws `Cannot set property historySize of #<Interface> which has only a getter`, and a call to a method that is not there is `TypeError: not a function` here where the host names it (`Readable.toArray is not a function`). Proved with the pinned engine out of the container: bare QuickJS 0.32 answers `no setter for property` and `not a function` for the same two lines, and `cannot read property 'history' of null` where V8 answers `Cannot read properties of null (reading 'history')`.
- **The container's environment is its own, and none of the host's is inherited**: a process starts with `PATH=/bin:/usr/bin:/usr/local/bin`, `HOME=/home`, `PWD`, `TERM=xterm`, `COLORTERM=truecolor` and `LANG=C.UTF-8` and nothing else, so `Object.keys(process.env)` is those six where a host process on this machine carries 60-odd. It cannot be inherited: the container runs in a browser worker, which has no environment to read, and a host `HOME` or `PATH` here would tell a guest where it is running from. `TERM` is what makes `colors@1` agree with host Node 24.15 (`'x'.red` is `\e[31mx\e[39m` on both)
- **No terminal is attached, and `process.stdout.isTTY` is left undefined rather than set false**: a piped host stream carries neither `isTTY` nor `columns`, and the same library that gates colour on a TTY (`chalk` 4 and later, `supports-color`) reads the absent value as no terminal here too. One that reads the environment alone — `colors@1` does, and calls `supportsColor()` with no stream — matches the host. There is no terminal to attach: the playground's output is a stream the container writes to
- **`node` on `PATH` is a file, not a binary**: `/usr/local/bin/node` exists and is mode `0755`, so `which.sync('node')` returns it as the host returns a path, but `fs.readFileSync('/usr/local/bin/node')` hands back the shim's script text where a host hands back an executable's bytes. A browser container cannot have a binary, and a spawn of that path runs the interpreter, not the script
- **An unresolved entry is reported with node's own dump**: `node missing.js` writes the `node:internal/modules/cjs/loader:1479` preamble, the resolved path, the eight frames of node's CommonJS loader, `code: 'MODULE_NOT_FOUND'`, `requireStack: []` and `Node.js v24.15.0`, and exits 1, as host Node 24.15 does. The frames name node's own internals at lines that belong to the build `NODE_VERSION` names, so they are carried as text captured from it and not read from anything here — the same way the `--print` refusal and the usage block are. `node --check` of a file that is not there is the one still left short: it writes `Error: Cannot find module '<path>'` where host Node writes the `check_syntax` dump, with `node:internal/main/check_syntax:33:20` behind it

### 🛑 Stopping a runaway guest

A guest loop blocks the host thread, so nothing on the host can end it: the runner's own `timeoutMs`
is only read between steps of the event loop, and a `while (true) {}` never reaches one. On the host
nothing stops `node -e 'while(true){}'` either — `timeout 3 node -e 'while(true){}'` kills it from
outside at 3.010 s and it prints nothing.

The container now stops it from the inside. One QuickJS interrupt handler is armed per runtime for
the process's lifetime and carries the run's budget: guest execution that runs longer than the budget
without calling the host is interrupted, and the process ends with status 1 and the error Node's `vm`
timeout reports, over the guest's own stack:

```
$ node /loop.js          # while (true) {}
Error: Script execution timed out after 30000ms
    at <anonymous> (/loop.js:1:2)
    at call (native)
    at loadCJS (owc-bootstrap.js:670:19)
    at runMain (owc-bootstrap.js:948:12)
```

Measured, against the default 30000 ms budget: `while (true) {}` is stopped at 30155 ms. With the
budget set to 3000 ms it is stopped at 3243 ms, while a 1.2 s pure guest loop, a 4.5 s program that
writes to stdout throughout, a 6 s `setInterval` program, a 20 s pure guest busy loop, a 397 ms
`JSON.stringify`/`parse` round trip over 200 000 objects and a 54.8 s run of 5000 synchronous file
writes all finish normally with status 0 — the last two matter because both run past the wall clock
without ever running away. The budget bounds one *uninterrupted stretch*: every host call, await,
timer wait or step of the event loop starts it again, so a program that reaches the host in bursts is
never stopped by it, however long it runs. `new OpenWebContainer({ guestBudgetMs: ms })` sets it, and
`0` disarms it, which is the old behaviour.

The same handler carries the `timeout` of a `spawn`: a child that never calls the host holds the host
thread, so the timer the spawning guest armed for its own `timeout` cannot fire until the child has
gone, and the deadline is handed to the interrupt handler instead -- rearmed at every host call, so it
stays a moment in time and not a stretch of execution. `spawn('node', [busy 5 s], { timeout: 400,
killSignal: 'SIGKILL' })` closes at 416 ms with code null, signal SIGKILL and `killed` true, and
`execFile` and `spawnSync` report `ETIMEDOUT` and the same signal, as host Node 24.15 does. The
deadline owns the bound whatever its length: the runaway budget is only a stand-in for a `timeout`
the caller never named, so a spawn that asks for 40 s is given 40 s and not the guard's 30 --
measured, `spawn('node', [busy 60 s], { timeout: 40000, killSignal: 'SIGTERM' })` closes at 40016 ms
with code null and signal SIGTERM, against 40012 ms on the host -- where it used to be dropped for
being longer than the budget and the child died on the budget at 30436 ms with code 1 instead.
A kill with no moment attached to it -- `child.kill()` on a child that is busy-looping -- still cannot
land, for the reason the divergence list gives under `owc-child-kill-timeout`.

Known limits, measured rather than claimed:

- A loop inside a native built-in **is** stopped when the built-in is one of this container's own
  JavaScript reimplementations (a 120 MiB `crypto` hash is interrupted at 3183 ms) and when it is the
  engine's regexp matcher (catastrophic backtracking in `/(a+)+$/` is interrupted at 3205 ms), because
  both still run QuickJS bytecode or poll interrupts. A built-in that runs entirely in C without
  polling is not — `JSON.parse` of 200 000-deep nesting is not interrupted, it raises
  `RangeError: Maximum call stack size exceeded` at 193 ms.
- A kill (`kill <pid>`, `container` signal, `process.terminate()`) cancels the guest at its next
  interrupt check, which is the only point at which anything still runs while the guest holds the
  thread.
- `child.kill()` on a child that is busy-looping has no moment at which to run, and that is the
  engine's, not the container's: under bare QuickJS 0.32 with no container in the way
  (`@jitl/quickjs-singlefile-browser-release-asyncify`, the build this container loads), a host
  `setTimeout(..., 100)` armed before a 3 s guest loop had still not fired when the loop returned at
  3017 ms, so no host timer -- the parent's `setTimeout(600)` before its `child.kill()` included --
  can preempt guest execution; the interrupt handler is the only code that runs meanwhile (342 checks
  over a 10 s loop, which it aborted at 502 ms), and it can stop a guest but never give another one a
  turn, so the parent's callback does not run until the child has already finished (measured: it ran
  at 5433 ms, answered `false`, and the child exited 0 at 5438 ms where the host kills it at 620 ms
  with SIGTERM).
- An interrupted guest leaves objects live, so QuickJS prints
  `Assertion failed: list_empty(&rt->gc_obj_list)` when its runtime is freed. It is caught during
  teardown; the process still reports its status and output, and the container keeps working.
- An ES module entry with a fulfilled top-level await whose exports hold an object prints the same
  `Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: .../quickjs.c,2036,JS_FreeRuntime)`
  on host stderr at teardown, after correct output and exit 0. This one is the engine's and not this
  container's: measured with bare QuickJS 0.32 (the `@jitl/quickjs-singlefile-browser-release-asyncify`
  0.32.0 variant this container imports, and the sync default too), one process per source, `evalCode`
  `type: 'module'`, the job queue drained and every handle disposed before `rt.dispose()`, `const v =
  await Promise.resolve(7); export default { a: v }` aborts with no host handle outstanding at all --
  as does the same await with `export default v` and with no export, so the assertion is a property of
  a fulfilled top-level-await module in QuickJS 0.32 and not of anything this container keeps. The
  container suppresses it for the primitive and no-export shapes and not for the object one; the
  residual is recorded rather than fixed. (`owc-esm-loader-divergences-blocker-56080`.)

## 🚀 Features

- **Virtual File System**
  - Full directory structure support
  - File operations (create, read, write, delete)
  - Path resolution and normalization
  - Module loading capabilities

- **Process Management**
  - Multiple process types (Shell, JavaScript)
  - Process lifecycle management
  - Inter-process communication
  - Event-based architecture

- **Shell Environment**
  - UNIX-like shell commands
  - File redirection (`>`, `>>`)
  - Interactive shell support
  - Working directory management

- **JavaScript Runtime**
  - Isolated execution environments
  - ES Modules support
  - Resource management and cleanup
  - Based on QuickJS for reliable JavaScript execution
  - Web Streams: `ReadableStream` (default and byte streams, BYOB reader), `WritableStream`, `TransformStream`, `TextEncoderStream`, `TextDecoderStream` and `stream/web`
  - `Event`, `EventTarget`, `AbortController` and `AbortSignal`, `DOMException`, `Blob` and `File` globals
  - Synchronous child processes: `spawnSync`, `execSync` and `execFileSync`, including `node -e` and `node -p`
  - `vm` `timeout` for JavaScript loops, with Node's error codes
  - Preemption: a guest that runs away is stopped, with Node's `Script execution timed out` error

## 📦 Project Structure

```bash
.
├── apps/                      # Application packages
│   └── playground/           # Web-based playground
│       ├── src/             
│       │   ├── components/   # React components
│       │   │   ├── Editor/
│       │   │   ├── FileExplorer/
│       │   │   └── Terminal/
│       │   ├── hooks/       # React hooks
│       │   └── ...
│       └── ...
├── packages/
│   ├── api/                 # API interface package
│   │   ├── src/
│   │   │   ├── container/   # Container API
│   │   │   ├── process/     # Process-related types
│   │   │   └── worker/      # Worker bridge implementation
│   │   └── ...
│   └── core/               # Core implementation
│       ├── src/
│       │   ├── filesystem/  # Virtual filesystem implementation
│       │   ├── interfaces/  # Core interfaces
│       │   ├── network/     # Network simulation
│       │   ├── process/     # Process implementation
│       │   │   ├── base/    # Base process classes
│       │   │   ├── executors/ # Process type executors
│       │   │   └── manager/   # Process management
│       │   ├── shell/      # Shell implementation
│       │   │   ├── commands/ # Shell command implementations
│       │   │   └── ...
│       │   └── utils/      # Utility functions
│       └── ...
```

## 🛠️ Development Setup

### Prerequisites
- Node.js (v16 or higher)
- pnpm (v8 or higher)
- Git

### Installation

```bash
# Clone the repository
git clone https://github.com/thecodacus/OpenWebContainer.git
cd OpenWebContainer

# Install dependencies
pnpm install

# Start development
pnpm dev          # Start all packages
pnpm playground   # Start only the playground
```

## 📚 Usage

### Using the Core Package

```typescript
import { OpenWebContainer } from '@open-web-container/core';

async function main() {
  // Create a new container
  const container = new OpenWebContainer();

  // Create a directory and write a JavaScript file
  container.writeFile('/app/hello.js', `
    console.log('Hello from the container!');
    export const message = 'Hello World';
  `);

  // Run a shell command
  const shell = await container.spawn('sh', ['echo', 'Hello', '>', '/app/greeting.txt']);
  
  // Listen for process events
  shell.addEventListener('exit', ({ exitCode }) => {
    console.log('Shell process exited with code:', exitCode);
  });

  // Run a JavaScript file
  const jsProcess = await container.spawn('node', '/app/hello.js');
  
  // Clean up when done
  await container.dispose();
}

main().catch(console.error);
```

### API Examples

#### File System Operations

```typescript
// Directory operations
container.createDirectory('/app');
container.listDirectory('/app');
container.deleteDirectory('/app');

// File operations
container.writeFile('/app/script.js', 'console.log("Hello")');
const content = container.readFile('/app/script.js');
container.deleteFile('/app/script.js');
```

#### Process Management

```typescript
// Spawn a shell process
const shell = await container.spawn('sh', ['ls']);

// Spawn a JavaScript process
const process = await container.spawn('node', '/app/script.js');

// Process events
process.addEventListener('start', (data) => { /* ... */ });
process.addEventListener('exit', (data) => { /* ... */ });
process.addEventListener('error', (data) => { /* ... */ });
process.addEventListener('message', (data) => { /* ... */ });
```

#### Shell Commands

```typescript
// Interactive shell
const shell = await container.spawn('sh');
if (shell instanceof ShellProcess) {
  // Execute commands
  await shell.executeCommand('mkdir /app');
  await shell.executeCommand('echo "Hello" > /app/hello.txt');
  await shell.executeCommand('cat /app/hello.txt');
}
```

## 🧪 Development Commands

```bash
# Start development
pnpm dev              # Start all packages
pnpm playground       # Start only the playground
pnpm core:dev         # Start core package development

# Building
pnpm build           # Build all packages
pnpm core:build      # Build only core package

# Testing
pnpm test            # Run all tests
pnpm lint            # Run linter
pnpm format          # Format code

# Release
pnpm changeset       # Create a changeset
pnpm version-packages # Update versions
pnpm release         # Publish to npm
```

## 🛠️ Contributing

We welcome contributions! See our [Contributing Guide](CONTRIBUTING.md) for details on:
- Development workflow
- Project structure
- Testing guidelines
- Pull request process

### Areas for Contribution

- Shell command improvements
  - Additional built-in commands
  - Command argument parsing
- Process management enhancements
  - Process signals
  - Job control
  - Process groups
- Network features
  - HTTP request simulation
  - WebSocket support
  - Network isolation
- Developer tools
  - Debugging capabilities
  - Process inspection
  - Performance monitoring

## 📝 Roadmap

Current focus areas:
- [x] Network simulation implementation
- [x] NPM package manager integration
- [ ] Additional shell commands
- [ ] WebSocket support

Future plans:
- [x] URL: IPv4/IPv6 host normalisation -- `new URL('http://0x7f.1/').hostname` is `127.0.0.1`, as in host Node, and so is `[::ffff:1.2.3.4]`, `[::1]:8080` and `0x7f.1` written to `u.host` (row owc-url-host-ipv4-ipv6-normalisation)
- [x] URL percent-encoding -- `url.parse('http://h/a b').pathname` is `/a%20b` and `new URLSearchParams('a=%E9').get('a')` is the replacement character, as in host Node; `new URLSearchParams([['a',"!'()~"]]).toString()` is `a=%21%27%28%29%7E`, a lone surrogate serialises as `%EF%BF%BD` instead of throwing, and an invalid UTF-8 escape (`%C3`, `%FF`, `%C0%80`) is one U+FFFD per bad byte (row owc-url-percent-encoding)
- [x] URL forbidden host code points -- `new URL('http://a b/')` throws, and so do `http://a%00b/` and `http://a%20b/`, whose forbidden byte only appears once the escapes are decoded (row owc-url-forbidden-host-code-points)
- [x] URL file: scheme -- `new URL('file:/a').href` is `file:///a`, as in host Node, and `file://localhost/a` is `file:///a` there too (row owc-url-file-scheme-host)
- [ ] url module legacy API -- `url.Url` is the WHATWG class, so `url.parse('http://h/') instanceof url.Url` is `false` and `new url.Url()` throws, where host Node answers `true` and an empty `Url` (`url.format({ protocol: 'http:', pathname: 'a' })` is `http:a` now, as in host Node) (row owc-url-module-legacy-api)
- [ ] URL IDNA is `toLowerCase` + NFC and not UTS-46 -- `url.domainToASCII('ﬁ.de')` is `xn--jm6c.de`, where host Node maps the ligature first and gives `fi.de`; a code point UTS-46 ignores (`­`, `​`), maps (`。` for `.`) or disallows is punycoded instead (row owc-url-idn-host-not-punycoded)
- [ ] legacy `url.parse` of a relative reference -- `url.resolve('a', 'b')` is `/b` where host Node gives `b` (`url.parse('//h/x').pathname` and `url.parse('h').href` agree now) (row owc-url-legacy-parse-old-parser)
- [ ] `url.domainToUnicode` and `domainToASCII` off the ends -- `url.domainToUnicode('XN--BCHER-KVA.de')` is `BüCHER.de` where host Node case-folds and gives `bücher.de`, and `url.domainToUnicode('xn--zzz-')` is `zzz` where host gives `''` (`url.domainToASCII(123)` is `0.0.0.123` now, as in host Node) (row owc-url-domain-unicode-edges)
- [ ] `url.parse`'s third argument `slashesDenoteHost` is not implemented -- `url.parse('//a/b', false, true).host` is `null` where host Node gives `a`, and its `pathname` is `//a/b` where host gives `/b` (row owc-url-parse-slashes-denote-host)
- [ ] `url.resolveObject` and the legacy `Url` instance methods are missing -- `typeof url.resolveObject` is `undefined` where host Node gives `function`, and `url.parse('http://a/b').format()` throws where host gives `http://a/b` (row owc-url-legacy-resolveobject-and-url-prototype)
- [ ] `url.resolve` does not treat a backslash as scheme-relative and drops a trailing slash -- `url.resolve('http://a/b', '\\c')` is `http://a/\\c` where host Node gives `http://c/`, and `url.resolve('http://a/b/c', '.')` is `http://a/b` where host gives `http://a/b/` (row owc-url-resolve-backslash-and-dot-segments)
- [ ] `url.pathToFileURL` returns a duck-typed object and not a `URL` -- `url.pathToFileURL('/a') instanceof URL` is `false` where host Node answers `true`, and its prototype carries only `host`, `href`, `origin`, `toJSON` and `toString` (row owc-url-path-to-file-url-not-a-url)
- [ ] the `url` module is missing exports -- `Object.keys(url)` has no `URLPattern`, no `fileURLToPathBuffer` and no `resolveObject`, where host Node lists all three beside the eleven this container has (row owc-url-module-missing-exports)
- [ ] `url.parse` drops a `__proto__` key from a parsed query -- `url.parse('http://a/b?__proto__=1', true).query` is `{}` where host Node gives `{__proto__: '1'}` (row owc-url-parse-query-proto-key)
- [ ] Builtin module namespace surface -- far wider than `node:fs`: measured against host Node 24.15, all 25 of the builtins a script can import by name differ in `Object.keys` (`node:fs` 90 against 105, `node:process` 46 against 83, `node:crypto` 45 against 70, `node:util` 22 against 35, `node:os` 22 against 24, `node:path` 16 against 18, `node:constants` 56 against 232); `node:cluster` exposes `worker` where Node has `Worker`, `node:util` leaks `__isDeepEqual`/`isFunction`/`isNumber`/`isObject`/`isString`, `node:module` lacks `stripTypeScriptTypes`/`register`/`enableCompileCache`/`findPackageJSON` and still exports `createRequireFromPath`/`wrap`/`wrapper` that Node 24 dropped, `node:fs` carries `F_OK`/`R_OK`/`W_OK`/`X_OK` at top level, `node:os.constants` is `errno, signals` against `UV_UDP_REUSEADDR, dlopen, errno, priority, signals` with 33 signals against 31, and `node:sqlite`, `node:test`, `node:sea`, `node:wasi` and `node:stream/consumers` are `ERR_MODULE_NOT_FOUND` where the host has real namespaces (row owc-esm-builtin-namespace-surface)
- `.ts` files and the compression streams (shard esm-surface): a `.ts` dependency Node refuses to *strip* -- an `enum`, a `namespace`, a parameter property -- now hands its importer exactly the error Node hands, `SyntaxError|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|"TypeScript enum is not supported in strip-only mode"` with Node's own code frame as `err.stack`, and prints Node's report byte for byte (exit 1) when nothing catches it; a `.ts` file Node refuses to *parse* (`function f<number>(1);`) is not diagnosed here at all -- Node answers `SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]` in amaro's words because it parses TypeScript, and this container strips types as text and hands what is left to QuickJS, which says `missing formal parameter` -- and `CompressionStream`/`DecompressionStream` now work: `await writer.write()` settles where it never did (a write to a `TransformStream` here does not settle until its readable is read, and a stream whose output exists only once the writable has closed can never be read in time), so gzip of `hello world hello world` is the host's own 34 bytes, `1f8b0800000000000013cb48`, and a bad format answers Node's own `Failed to construct 'CompressionStream': 1st argument value 'bogus' is not a valid enum value of type CompressionFormat.`
- [x] Namespace mutation error text -- `ns.default = 1`, `delete ns.default`, `Object.defineProperty(ns, 'brandnew', d)` and `Object.setPrototypeOf(ns, {})` all report Node's own words -- `Cannot assign to read only property 'default' of object '[object Module]'`, `Cannot delete property 'default' of [object Module]`, `Cannot redefine property: brandnew`, `[object Module] is not extensible` -- and a `setPrototypeOf` asking for the `null` it already has is granted, as in Node; the one wording still left is the engine's own `object is not extensible` against V8's `#<Object> is not extensible` for a plain non-extensible object, which is row owc-engine-error-message-wording and not this one (row owc-esm-namespace-mutation-error-text)
- [x] A multi-byte character split across two `process.stdout.write` calls, and a lone surrogate written as text -- `write([e4,b8])` then `write([ad])` is U+4E2D as on a host, including across an intervening empty-string write, and `write('\ud83d')` then `write('\ude00')` is two U+FFFD as on a host (row owc-stdout-split-sequence-mangled)
- [x] bash 3.2 syntax this machine's `/bin/sh` has -- arrays (`a=(x y z)`, `${a[1]}`, `${#a[@]}`), the conditional command `[[ a == a* ]]`, brace expansion (`a{b,c}d`, `{1..3}`, `set +B`), `PIPESTATUS`, indirection `${!k}`, the full 27-name `set -o` list and `$-` of `hBc`, `declare -i`, `export -n`, `hash -d`, and an assignment in front of a builtin (`IFS=: read x y`) (row owc-shell-bash32-extensions)
- [x] `cmd 3>f >&3` -- a descriptor the command itself opened is visible to its own later `>&n`, and one a compound command opened to the whole construct, as on a host (row owc-shell-fd-opened-by-command-visible-to-itself)
- [x] `exec >f`, `exec 2>f` and `exec 1>&2` persist, and what the commands behind them wrote stays in the file -- `exec >f; echo a; echo b` is both lines (row owc-shell-exec-standard-fd-dropped)
- [x] `exec 3>&1`, `exec 3>&2` and `exec 3<&1` duplicate the standard descriptor a host duplicates, with no bad-descriptor diagnostic (row owc-shell-exec-duplicating-standard-fd)
- [ ] `exec 3<f; cat <&3` reads `f`, but every read starts at the beginning again where a host's descriptor keeps one offset -- `exec 3<f; head -1 <&3; head -1 <&3` is `p` and `p` for a host's `p` and `q` (row owc-shell-exec-input-fd)
- [ ] a failing `exec` does not end a non-interactive shell (row owc-shell-exec-failure-does-not-end-shell)
- [x] `echo hi >&-` reports the write error a host reports, and `echo hi >f >&-` leaves the empty `f` a host leaves behind it (row owc-shell-closed-fd-write-error)
- [ ] a redirection’s file is created even when the command fails on a bad descriptor (row owc-shell-redirect-file-created-on-failed-command)
- [ ] Add signal handling (SIGTERM, SIGKILL, etc.): `child.kill` sends one, `process.kill` does not reach a process
- [ ] Create process groups and job control
- [ ] Create development tools and debugging capabilities

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Acknowledgments

- [QuickJS](https://bellard.org/quickjs/) - The JavaScript engine used in this project
- [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) - WebAssembly build of QuickJS

## 💬 Support

- Create an issue for bug reports or feature requests


## Similar Projects
- [Nano Web IDE](https://github.com/anbraten/nano-web-ide)

## Known divergences from a host `node` (measured, not fixed)

RSA, DSA and DH key generation is a speed gap, not an engine limit: bare QuickJS 0.32 (quickjs-emscripten, no container bootstrap) does a 1024-bit BigInt `modPow` with an all-ones exponent in 22.3 ms against V8's 4.5 ms, same result `b2bffc4a`, so a Miller-Rabin search for the two 1024-bit primes a 2048-bit RSA key needs is reachable here at roughly 5x slower — seconds, not hours. `createDiffieHellman(1024)` now takes that route and answers a fresh prime of the width asked for, as host Node 24.15 does, instead of the RFC 2409 group of the same size; the standard groups are still what `createDiffieHellmanGroup` answers, and a width below OpenSSL's own 512-bit floor is `ERR_INVALID_ARG_VALUE 'Invalid DH parameters'` and one of two bits or fewer is `ERR_OSSL_DH_MODULUS_TOO_SMALL`, both as on the host.

Four `crypto` gaps were recorded here because their fix site is outside `capabilities/crypto.ts`; all four are now closed in the guest crypto surface (`runtime/guest/misc.ts`), which is where the guest half of each one sits, and the generic bridge in `operationError` (`runtime/guest/spine.ts`) is untouched: (1) a capability error still crosses into the guest as a plain `Error`, but every `crypto` capability call now rebuilds the constructor from the envelope's `owcErrorClass` the way `cipherCap` did for the ciphers, so an invalid `options.dsaEncoding`, a bad `namedCurve`, `hkdfSync('nope', ...)`, `createDiffieHellman` with a non-integer or a 2..511-bit size, and `crypto.diffieHellman` with a buffer key answer the host's `TypeError` or `RangeError` as well as its code and message; (2) `generateKeyPairSync` with a `{ format: 'jwk' }` encoding answers the JWK object -- a `jwk` encoding is the one shape that is not bytes, so it is no longer handed to `Buffer.from`; (3) `crypto.getDiffieHellman` is a function (the same standard MODP group `createDiffieHellmanGroup` answers), and `privateEncrypt`, `publicDecrypt`, `publicEncrypt` and `privateDecrypt` answer RSA raw encryption over a new `crypto.rsa.raw` capability -- PKCS#1 v1.5 block type 1 for a private encrypt and its public decrypt, and OAEP with SHA-1 and no label for a public encrypt and its private decrypt, which is the asymmetry the host's own defaults have, with `RSA_NO_PADDING` and the `oaepHash`/`oaepLabel` options besides; (4) a `DiffieHellman` reports `DH_check`'s own bits on `verifyError`: 1 for a composite modulus, 2 for a prime whose `(p-1)/2` is not one, 8 for a generator that squares to 1 or that sits outside `[2, p)`, and the 128 OpenSSL adds below its 512-bit modulus floor -- read the first time a caller asks, because deciding whether a 1024-bit modulus is prime is two Miller-Rabin searches. Two `crypto` divergences remain, neither of them in a row's text: `createSign('sha256').sign('notakey')` reports `ERR_CRYPTO_INVALID_KEYPAIR: Invalid ASN.1: truncated element` where the host's decoder says `ERR_OSSL_UNSUPPORTED`, and `crypto.sign(null, data, ecKey)` -- a signature over the raw message with no digest named -- is `ERR_OSSL_EVP_UNSUPPORTED` here where host Node 24.15 signs and verifies it.

`sh -c <line>` in the container against `sh -c <line>` on the host, node v24.15.0 on both sides,
cwd at the app directory, one case per process. Each line below is one symptom that survives a
re-run in isolation; the rows are open.

- `owc-http-fetch-external-redirect`: an external redirect is now decided by the guest's own hop logic
  (`undici.ts` follows it, refuses it and reports it), so against a **node** host all nine probes agree
  with host Node 24.15 — `manual` answers `302` with `loc="/get"` and `redirected false`, `error`
  rejects `TypeError fetch failed` / `unexpected redirect`, `follow` answers `200` with
  `redirected true` and `url` at the last hop. What is left is the **browser** host, and it is the
  host's own `fetch` and not the guest: measured in live headless Chrome 155 on
  `https://httpbin.org/redirect/1`, `redirect: 'manual'` answers `status=0 type="opaqueredirect"
  statusText="" loc=null` with an empty body, and `redirect: 'error'` rejects `TypeError: Failed to
  fetch` at fetch time — a browser never hands a 3xx to script at all — so the opaque-redirect fallback
  in `packages/core/src/process/executors/node/runtime/capabilities/http.ts` re-asks with `follow` and
  hands the guest the already-followed `200`: `manual` still never sees its `302`, and `error` comes
  back as `fetch failed` / `getaddrinfo ENOTFOUND httpbin.org` where the host says `unexpected
  redirect`. The `http.fetch` payload `guest/modules/http.ts` `_dispatch` sends carries no redirect
  mode and drops the `url` the capability answers with, so even `follow` reports `redirected false`
  and the url that was asked for, where a browser's own followed answer carries
  `url="https://httpbin.org/get" redirected=true type="cors"`. No guest code can read a 3xx out of a
  browser `fetch`, so this half is not reachable from here.
- `owc-vm-script-cachedata`: `new vm.Script('1+1', { produceCachedData: true })` leaves both
  `cachedDataProduced` and `cachedData` undefined, where host Node 24.15 answers `true` and a 336-byte
  `Buffer`. Recorded rather than fixed: that cache is V8's own bytecode, and quickjs-emscripten 0.32
  exposes no bytecode entry point on its module or on a context, so there is no cache to hand back --
  bare QuickJS 0.32 with no container in the way carries neither property.
- **`vm` realm divergences that are recorded rather than fixed**, each re-measured at `HEAD` in isolation, one container boot per case, host Node 24.15.0 against the container with stdout, stderr and exit compared together. (1) A property the sandbox *inherits* from its own prototype is invisible inside the context: with `s = Object.create({ inherited: 9 }); s.own = 1`, `vm.runInContext('inherited', vm.createContext(s))` is `9` on the host and a `ReferenceError` here, while `own` is `1` on both — host's contextified global *is* the sandbox, prototype chain and all, where this container's is the realm's own global object with the sandbox's own keys put on it; and host answers `false` to `"inherited" in globalThis` and to `hasOwnProperty` at the same time, which no object without a `has` trap does, so the pair cannot be matched by copying. (2) `vm.createContext(new Proxy(target, handler))` is read rather than delegated: reading `virt` and `p` logs `["get:virt","get:p"]` on the host and `ownKeys`/`getOwnPropertyDescriptor` alone here. Both are `syncIn` in `capabilities/vm.ts`. (3) A **compile-time** `SyntaxError` from `vm` carries no filename and no source line: `new vm.Script('var 1x = 2', { filename: 'de.js', displayErrors: true })` opens `de.js:1 | var 1x = 2 |     ^` on the host and `SyntaxError: invalid number literal` at the caller's own frame here, and the same for `runInNewContext` and `runInContext` with a `filename`. (4) The caret under the source line of a throw that happens **inside a function** of a context sits at column 0 where the host puts it under the `throw`: `b.js:1 | function inner(){ throw new Error("t") } inner() |                   ^` there, `^` at column 0 here; a top-level throw matches. (5) `vm.runInThisContext('throw new Error("rt")')` answers `evalmachine.<anonymous>:1`, the source line, the caret, then `Error: rt` and the frames `Script.runInThisContext (node:vm:137:12)` and `Object.runInThisContext (node:vm:317:38)` on the host, and `Error: rt | at <eval> (<input>:1:16) | at eval (native)` here; `vm.compileFunction('return 1', []).name` is `''` on the host and `'anonymous'` here, and `Object.keys(new vm.Script('1'))` is `["sourceMapURL","sourceURL"]` there and `[]` here. (6) A `Script` instance carries own `_owcCode`, `_owcFile` and `_owcOffset` that host Node has no name for, and `Script.prototype.createCachedData` answers a 0-byte `Buffer` where the host's `cachedData` is 336 bytes. (7) A `WeakRef` a context builds over an object that did not come from that context `deref`s to `undefined`, where the host returns the object. (3) to (6) are all one file — the `Script` constructor, `vmDress`, `runInThisContext` and `compileFunction` of `runtime/guest/modules/pure-b.ts` — which is outside the `vm-realm` shard and is named rather than edited.
- `owc-node-require-preload-dropped`: `node -r ./pre.js main.js` (and `--require ./pre.js`) reads the
  option, so `process.execArgv` and `process.argv` agree with the host, but the preload module is
  never run -- the host prints `preloaded` before `main`, the container prints `main` only.
- `owc-node-stack-trace-limit-value-message`: `node --stack-trace-limit 5 -e 1` -- the host prints
  four lines (`Error: illegal value for flag --stack-trace-limit of type int`, `Try --help for
  options`, then two more `bad option` lines), the container prints one `node: bad option:`.
- `owc-node-completion-bash-output`: `node --completion-bash` -- the host prints its ~4 KB bash
  completion function and exits 0, the container exits 0 and prints nothing.
- `owc-node-report-getreport-shape`: `process.report.getReport()` -- the host returns 11 top-level
  sections and a header of 23 keys (`javascriptHeap`, `nativeStack`, `resourceUsage`, `libuv`,
  `workers`, `componentVersions`, `cpus`, `host`, ...); the container returns 3 sections and a header
  of 14, with `reportVersion` 3 against the host's 5 and `trigger` `JS API` against `GetReport`.
  `writeReport` is byte-identical; only `getReport` is short.
- `owc-node-input-type-module-goal`: `--input-type=module -e <source>` is accepted but the source is
  still compiled as CommonJS -- `typeof import.meta` is a `SyntaxError` and `typeof require` is
  `function`, where the host has `object` and `undefined`, and `node --input-type=module -p 1` should
  fail with `ERR_EVAL_ESM_CANNOT_PRINT` rather than print `1`.
- `owc-esm-global-surface`: `Object.keys(globalThis)` is now the host's fifteen names exactly --
  `Blob`, `Buffer`, `URL`, `console`, `process`, the `TextCodec` pair, the abort pair, `File` and
  `CloseEvent` are non-enumerable here as they are there, `__owcErrname` no longer leaks, and
  `navigator` exists. `Object.keys(process)` is the host's 83 names (the three stdio streams were
  the ones a walk could not see). `Object.getOwnPropertyNames(globalThis)` is 134 against 135: the
  `Performance` family, `Crypto`/`CryptoKey`/`SubtleCrypto`, `Navigator`/`navigator`,
  `BroadcastChannel`, `CompressionStream`/`DecompressionStream`,
  `DisposableStack`/`AsyncDisposableStack` and `SuppressedError` were added and `InternalError`
  -- QuickJS's, and no V8 has one -- dropped, leaving one the host has and this container does not:
  `Atomics`, which this *engine* lacks (`typeof Atomics` is `'undefined'` under bare QuickJS 0.32
  with no container in the way, where `typeof SharedArrayBuffer` is `'function'`, so there is no
  atomic to build it over). `URLPattern` is there now, as the class `node:url` exports and
  non-enumerable as the host has it; the six `__owc_*` names of this container's own host bridge
  are not own names of `globalThis` at all -- they stand on an object behind it, so a lookup finds
  them and a walk of the global object's own names does not, and `Object.getPrototypeOf(globalThis)`
  is an object whose only own name is `constructor`, as the host's is (row owc-esm-global-surface).
  Not only the names:
  `performance`, `navigator` and `crypto` are accessors here as they are there and not writable data
  properties, `process` is one too, `Crypto.prototype` carries `getRandomValues` and `randomUUID`,
  `navigator.locks` and `performance.onresourcetimingbufferfull` exist, `performance.toJSON()`
  carries `eventLoopUtilization`, `SuppressedError.prototype` carries `message`, and
  `new DisposableStack().defer(fn); stack.dispose()` calls `fn` -- a deferred callback is a function
  and not a disposable. What is still missing is the engine's: `using x = { [Symbol.dispose]() {} }`
  is `SyntaxError: expecting ';'`, QuickJS 0.32 having no explicit resource management in its grammar

- `owc-esm-unknown-file-extension`: `import('./m.xyz')` holding `export const v = 1` -- the host
  answers `TypeError ERR_UNKNOWN_FILE_EXTENSION "Unknown file extension \".xyz\" for /app/m.xyz"`,
  the container parses it as CommonJS. The same call exposes two more: `.m` is
  `ERR_UNKNOWN_FILE_EXTENSION` on the host, and `.node` is `ERR_UNKNOWN_FILE_EXTENSION` where the
  container gives `ERR_DLOPEN_FAILED` (row owc-esm-unknown-file-extension)
- The two module formats behind that row are now there. `.wasm` is a format of its own: the bytes
  are read and compiled as WebAssembly, and bytes that are not a wasm module give the CompileError
  the host gives -- `CompileError` with `"/app/m.wasm: WebAssembly.Module(): expected magic word
  00 61 73 6d, found 65 78 70 6f @+0"`, line for line the host's own words, and a zero-byte file the
  one the host gives for it, `"WebAssembly.Module(): BufferSource argument is empty"`. Its namespace
  is the module's own exports and nothing more: `import('./add.wasm')` is `["add","mem"]` and a
  module that exports nothing is `[]`, neither carrying a `default`. One line the host prints and
  this container does not is its own `(node:<pid>) ExperimentalWarning: Importing WebAssembly module
  instances is an experimental feature`, which carries the pid of the process printing it and so
  cannot be byte-identical across the two. `.ts`, `.mts` and
  `.cts` are stripped of their types the way Node 24 strips them, on the token stream and never on
  the text, so the `:` of a ternary, of an object literal, of a `case` and of a label survives: a
  `.ts` file holding an `interface`, a `type`, an `import type`, a `private` member, a typed
  parameter, a return type, a function type, an `Array<T>` and an `as` cast is byte-identical to
  the host's own run of it; so is one holding the type arguments of a call (`f<number>(1)`,
  `new Map<string, number>()`), of an arrow (`<T,>(x: T): T => x`), an optional member or parameter
  (`r?: number`, `a?: number`), a definite assignment (`let def!: number;`), a module-level
  `declare`, an overload signature, an `abstract m(): void;`, an index signature and an
  `as unknown as { b: number }` cast. What Node refuses rather than rewrites is refused here too --
  an `enum`, a `namespace`, a parameter property -- in Node's own
  `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]`, caret span and code frame included. One thing
  is the engine's and not this container's: `using x = { [Symbol.dispose]() {} }` is
  `SyntaxError: expecting ';'` here, because QuickJS 0.32 has no explicit resource management in its
  grammar and there is no way to add a declaration keyword to it from outside (row owc-esm-wasm-and-typescript-format).
- `owc-esm-main-syntax-error-frame`: a syntax error in an **ES module main** now carries Node's whole
  report -- the file URL and line, the source line, a caret under the token, the `SyntaxError`, the
  ten loader frames (the entry's own `.../esm/loader:628:32` + `TracingChannel.tracePromise`, or a
  dependency's `ModuleJob.syncLink` + `ModuleJob.link`) and the `Node.js v24.15.0` trailer -- and a
  main that binds one name twice (`const a = 1;` after `import { a } from './x.mjs'`) is now
  byte-identical to host Node 24.15, caret column included. Where the second binding stands is
  V8's, too: a `function` and a `class` are underlined from their keyword -- a class the whole way
  to the `}` that closes it -- while a `const`, a `let` and a `var` are underlined at the binding
  that repeats, so `const [a, a] = [1, 2]` is under the second `a` and `const a = 1, a = 2` under the
  second declarator. A `function` declaration is a lexical binding at module scope as it is in Node,
  so `function a() {} var a = 2;` and `var a = 1; function a() {}` are the SyntaxError the host
  raises. The caret keeps the tab of a tab-indented line, and a `.ts` entry gets the translator's
  own `ModuleLoader.<anonymous> (node:internal/modules/esm/translators:642:10)` frame where a `.mjs`
  entry gets `TracingChannel.tracePromise`. A name bound twice is now caught in every scope and not
  only at the top of a module -- a function body, a block and a class body each bind on their own, so
  `function f() { const a = 1; const a = 2; }` is the host's own error at the host's own column, while
  shadowing, a `var` a second `var` rebinds and a `var` a `function` of the same name rebinds inside a
  function all stay legal -- and a dependency that fails to compile is printed as it stands, with no
  `Error: ` in front of a report the host wrote whole. The caret under a token V8 underlines whole is
  that token's own length now: an unterminated string spans from the quote that opened it to the end of
  its line (`const s = 'abc;` gets five carets at column 11 and `  return 'x;` three at column 10),
  where it used to be one. Still the engine's and not V8's: the words of an error this container does
  not compose -- `const;` is `SyntaxError: variable name expected` here where the host says
  `Unexpected token ';'`, and that unterminated string `unexpected end of string` where the host says
  `Invalid or unexpected token`. Both are the pinned engine's own: bare QuickJS 0.32 with no container
  in the way writes `variable name expected` for `const;` and `unexpected end of string` for that very
  string, so no rewrite of this container's reaches either. Not only an ES module main: a `.cjs` main,
  a typeless `.js` main and an `import.meta` in a `.cjs` still lose the frame
  (row owc-esm-main-syntax-error-frame)
- `owc-esm-runtime-stack-frames`: a trace out of an **ES module** names none of node's ESM loader --
  a `main.mjs` that catches what `m1.mjs` threw prints three lines here (`Error: esm`,
  `at go (/app/m1.mjs:1:39)`, `at /app/main.mjs:3:5`) where host Node 24.15 prints six, the last three
  being `at ModuleJob.run (node:internal/modules/esm/module_job:437:25)`,
  `at async node:internal/modules/esm/loader:639:26` and
  `at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)` -- and the two
  locations are `/app/m1.mjs` and `/app/main.mjs` where the host writes `file:///...` for both. The
  loader here is the synchronous `normalizeModule`/`loadModule` pair QuickJS calls through
  `runtime.setModuleLoader`, which resolves and loads in one synchronous call, so there is no job and no
  loader behind a module for a frame to name; a **syntax** error in an ES module main already carries the
  whole report, frames included (row `owc-esm-main-syntax-error-frame`), a runtime trace does not.
  **Fixed**: the host names every file it compiles as an ES module as it compiles it, so a frame in one
  is rendered with the file's URL and not with its path -- `at go (file:///app/m1.mjs:1:39)`,
  `at file:///app/main.mjs:3:5` -- and node's loader frames stand behind the module's own top-level
  frame: the job, the loader, and for a module the entry point ran, the entry point. Measured at HEAD:
  that `main.mjs` prints six lines against the host's six, and a graph two imports deep
  (`main.mjs` -> `n1.mjs` -> `n2.mjs`) puts all three behind `n2.mjs`, as the host does. A module a
  dynamic import loads gets the job and the loader and stops, which is what the host does too:
  `import('./m.mjs')` written in a CommonJS main and in an ES module main both print the host's four
  lines. A `.js` file a package's `"type": "module"` makes a module is named by its URL like any other.
  Still the engine's and not node's is the **column** of the frame: host Node names the callee
  (`at go (file:///app/m1.mjs:1:30)`) and this engine names the `(` behind it (`1:39`), and a member
  access is named at its `.` where the host names the property; bare QuickJS 0.32 with no container in
  the way writes the same 31 for the `new Error('boom')` host Node 24.15 writes as 22, so the column is
  the engine's own and not one this container computed.
- `owc-esm-cjs-dynamic-import-namespace`: `import('./m.mjs')` written in a CommonJS importer
  resolves to the engine's namespace and not to Node's view of one -- `ns.a = 99` throws
  `'a' is read-only` where the host throws `Cannot assign to read only property 'a' of object
  '[object Module]'`, and `Object.freeze(ns)`, `Object.defineProperty(ns, 'q', { value: 1 })`,
  `delete ns.a`, `String(ns)` and `ns + ''` read `module namespace properties have writable = false`,
  `object is not extensible`, `could not delete property` and `toPrimitive`. The same import written
  in an ES module importer is byte-identical to the host.
- `owc-node-missing-entry-dump`: `node <missing>` -- the host prints its loader dump (eight
  `node:internal/modules/cjs/loader` frames, `code: 'MODULE_NOT_FOUND'`), the container prints the
  single line `Error: Cannot find module '<path>'`.
- `owc-node-check-syntax-message`: `node --check bad.js` -- the host reports `SyntaxError: Function
  statements require a function name` with a caret under `function`, the container reports
  `SyntaxError: function name expected` with the caret elsewhere and no `Node.js v24.15.0` trailer.
  Also on `const x = ;`: the container's frame carries the CommonJS wrapper's column offset, so an
  eleven-character line is reported as `at /app/bad.js:1:72` where the host reports no frame at all.
- `owc-node-spawned-command-redirect`: a spawned command used with a redirection or inside a
  subshell or `if` -- `node - < main.js`, `node main.js > out.txt`, `(node --version)` -- is refused
  with `node: cannot run here: it can only be run on a line of its own` and exit 127, where the host
  runs the command. The root cause is the shell's, not node's: `splitCompoundLine` hands any line
  holding `<`, `>`, `(`, `)` or a backtick to the script engine, which cannot spawn.
- `owc-node-preload-missing-dump`: `node -r nopre.js -e 'console.log(1)'` -- the host prints its
  loader dump (`node:internal/modules/cjs/loader:1479`, `Error: Cannot find module 'nopre.js'`,
  `Require stack:` `- internal/preload`, nine frames through `loadPreloadModules`, and
  `requireStack: [ 'internal/preload' ]`); the container reports it as the eval body having thrown
  (`[eval]:1` / `console.log(1)` / `^` / `Error: Cannot find module 'nopre.js'` / `at [eval]:1:1`).
  A preload that does exist fails the same way (see owc-node-require-preload-dropped).
- `owc-node-require-missing-dump`: `node -e 'require("totally-missing-mod")'` -- the host prints its
  loader dump with `Require stack:` `- /app/[eval]`, `Module.require`, `require
  (node:internal/modules/helpers:153:16)` and `code: 'MODULE_NOT_FOUND'`; the container prints the
  five-line `-e` dump (`[eval]:1` / the source / `^` / `Error: Cannot find module ...` /
  `at [eval]:1:1`), so a `require` failure is shaped like an uncaught throw.
- `owc-node-stack-trace-limit-ignored`: `--stack-trace-limit=N` is parsed but never bounds a trace --
  with `=0` the host wraps the whole dump as `[[eval]:1 ... Error: x]` and prints no frame, with `=1`
  it prints `at f ([eval]:1:20)` only and with `=2` the two source frames only, while the container
  prints the source frames plus all seven internal ones in every case.
- `owc-node-title-not-applied`: `--title=x` is accepted but does not set the title --
  `node --title=x -e 'console.log(process.title)'` prints `x` on the host and `node` in the
  container, both exiting 0 with empty stderr.
- `owc-node-throw-nonerror-shape`: `node -e 'throw 42'` -- the host's stderr opens with a blank line
  and ends the value with ``(Use `node --trace-uncaught ...` to show where the exception was
  thrown)`` and prints no frame; the container has no leading blank line, prints a frame
  `at [eval]:1:1` that node does not print for a non-Error throw, and omits the hint.
- `owc-node-check-missing-dump`: `node --check /app/nope.js` (and `--check nope.js`) -- the host
  prints its MODULE_NOT_FOUND dump (`node:internal/modules/cjs/loader:1479` ...
  `at node:internal/main/check_syntax:33:20`, `code: 'MODULE_NOT_FOUND'`); the container prints the
  single line `Error: Cannot find module '/app/nope.js'` -- the shape owc-node-missing-entry-dump
  had before the run path was fixed, still open on the `--check` path.
- `owc-node-empty-entry-arg`: `node ''` -- the host exits 0 with empty stdout and stderr; the
  container resolves the empty argument to `/app` and exits 1 with the full MODULE_NOT_FOUND dump.
- `owc-node-report-writereport-filename`: `process.report.writeReport()` -- the host returns
  `report.20261023.003448.19534.0.001.json` (local time, pid, a `.0.` sequence and a three-digit
  trailer); the container returns `report.20261022.163657.1.1.json` -- UTC, eight hours behind local,
  and missing the sequence fields, so owc-node-report-getreport-shape's "writeReport is
  byte-identical" no longer holds.
- `owc-node-column-member-read-over-call`: a property read off a receiver that holds a call --
  `node -e 'const f = () => ({}); f().a.b'` -- is reported one column to the right: the host puts the
  caret and the frame at 28, on the dot, the container puts both at 29, on the `b`. V8 names the dot
  for `f().a.b` but the property for `o.a.b`, and the two are not told apart.
- `owc-node-column-shortcircuit-and`: `node -e '"throw" && nosuch()'` -- the host puts the caret and
  the frame at column 1, the container at 12, so both are wrong; the caret now tracks the frame (the
  scan that found a `throw` inside the string literal is fixed) and what is left is the frame column
  V8 gives an `&&` expression.

- `owc-shell-arith-command`: the arithmetic command `(( ))` is not one -- `((1)); echo $?` is host `0` and container `127` with `sh: 1: command not found`; `((1+))` is host status 1 with ``/bin/sh: ((: 1+: syntax error: operand expected (error token is "+")`` against the container's `sh: 1+: command not found` and 127. (`$(( ))` and `$((1?2:3))` do evaluate.)
- `owc-shell-dollar-bracket-arith`: the old `$[...]` form is never expanded -- `echo $[1+1]` prints `2` on a host and the literal `$[1+1]` in the container, and `$[1+]` is an operand error on a host where the container reports `$[1+]` as `command not found`.
- `owc-shell-empty-compound-body`: a body with nothing in it is accepted where a host refuses the script -- `if true; then` newline `fi` is host ``syntax error near unexpected token `fi'`` (exit 2) and container exit 0 with nothing written; `while`/`until`/`for`, `{ }` and `( )` take the same shape, and `while true; do` newline `done` never returns in the container at all instead of failing to parse.
- `owc-shell-script-not-executable`: a file with a shebang and the execute bit cannot be run -- `./execok.sh` prints `ran` on a host and fails in the container with `./execok.sh: cannot run here: it is a script, which only a child can run`, exit 127.
- `owc-shell-nested-sh`: a second shell cannot be spawned, so a script named as an argument to `sh` never runs -- with `s.sh` in the cwd, `sh s.sh` and `sh ./s.sh` print `ran-inside` on a host and answer `sh: cannot run here: it is the file /bin/sh, which only a child can run` with exit 127 in the container, and a bare `sh` with no argument refuses the same way. This one is the process model and not the parser: `/bin/sh` in this container is the shell this file describes, and nothing inside it can start another one.
- `owc-shell-diagnostic-line-position`: no diagnostic carries the position a host's does -- a host writes `/bin/sh: -c: line 1: syntax error near unexpected token `;'` and `/bin/sh: line 0: .: filename argument required`, the container the bare sentence; of 94 measured cases 37 differ on that prefix alone and nothing else.
- `owc-shell-return-not-in-function-wording`: the complaint about a `return` outside a function is quoted with straight quotes and carries no shell name -- host ``/bin/sh: line 1: return: can only `return' from a function or sourced script``, container `return: can only 'return' from a function or sourced script`.
- `owc-guest-getter-only-assignment-message`: a strict-mode write to an accessor that has a getter and no setter -- `e.type='y'` on an Event, `r.status=201` on a Response -- throws `TypeError: no setter for property` where host Node 24.15 throws `TypeError: Cannot set property type of #<Event> which has only a getter`. The text is the engine's: the same pair appears for a `class K { get a(){return 1} }` built inside the container. The descriptor, the sloppy-mode no-op and `Reflect.set` answering false all match, which is why those attributes carry no setter at all rather than a setter written only to reproduce this string. Bare QuickJS 0.32 with no container in the way says the same two words for the same class built in the same strict-mode body, so the string is the engine's and no guest-side definition of the accessor reaches it.
- `owc-guest-error-engine-stack-no-header`: an error the engine raises itself -- `null.x`, `JSON.parse('{')` -- opens with a frame where host Node 24.15 opens with the error's own name and message: container `err.stack` is `    at <anonymous> (/app/main.js:12:11)`, host `TypeError: Cannot read properties of null (reading 'x')`. An error the guest constructs does carry its header, because its constructor is wrapped; these are raised at throw sites inside the engine that no guest-side definition reaches. Re-measured at HEAD: `null.x` gives `    at <anonymous> (/app/main.js:61:66)` against the host's `TypeError: Cannot read properties of null (reading 'x')`, and `JSON.parse('{')` gives `    at <input>:1:2` against `SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)`. There is no hook to put the header there either: an engine-raised error carries `stack` and `message` as its own **data** properties, written at the throw site, `Error.prototype.stack` is absent rather than an accessor, and a `message` getter installed on `Error.prototype` is never consulted (measured: not called once). A `stack` **setter** installed the same way is not consulted either: an engine-raised error and one the guest constructs both reach their `catch` with `stack` as their own `value` property and the setter's count still 0, here and in bare QuickJS 0.32 with no container in the way (`setterCalls=0`, `own=true`), so the write is a definition and not an assignment and no guest-side definition can get between the engine and the property. What is *inside* that stack is the container's own, and the same wall keeps it: `null.x` at the top of `/app/main.js` writes `at call (native)`, `at loadCJS (owc-bootstrap.js:1425:21)`, `at runMain (owc-bootstrap.js:2032:14)` and `at <anonymous> (owc-bootstrap.js:10106:59)` behind the one real frame, where host Node 24.15 writes its eight CommonJS loader frames, and a frame on line 1 of a required module is 61 columns wider than the same code on line 5 of the same file (`at c (/app/k2.js:1:88)` against `at d (/app/k2.js:5:27)`), because the wrapper the host compiles a CommonJS body in sits in front of the module's first line. Both are put right everywhere this container renders a stack -- an uncaught throw, `console.log(e)`, `console.error(e)`, `util.inspect(e)`, and every error the guest constructs -- and both survive in the one property no rendering reaches: what a guest reads out of `err.stack` itself. The line number in the bootstrap's own frames is reproducible, not stable across commits: it is a line in this repository's own bootstrap, so it moves when the bootstrap does.
- `owc-shell-closed-fd-flush-target`: the text a closed descriptor could not hold lands where a host's buffer is flushed, not where the shell started -- `exec >d; echo hi >&-; exec >&2; echo O=[$(cat d)]` is host `O=[hi]` (and the text on the error stream) against the container's `O=[]` with `hi` on the original output; `{ echo hi >&-; } > f; echo O=[$(cat f)]` is host `O=[]` with `hi` on the original output against the container's `O=[hi]`; `exec 1>&-; echo hi 1>&1` is host stdout empty against the container's `hi`.
- `owc-net-rst-unread-threshold`: a peer destroyed with bytes it never read is reset in the container where host Node 24.15 still closes gracefully -- with the server never reading and destroying after 400 ms, the client sees `cliEnd` / `cliClose:false` / a late write as `EPIPE` on the host at 0, 4 KiB, 16 KiB and 64 KiB unread, and `ECONNRESET` / `cliClose:true` / `ERR_STREAM_DESTROYED` in the container from 4 KiB up; only at 256 KiB and 1 MiB does the host reset too. The container's `readableLength` also reports the full unread count (262144, 1048576) where the host caps it at 65536.
- `owc-http2-goaway-session-lifetime`: after its own error GOAWAY the container's server session is already destroyed where the host's is still alive -- `srvSession.goaway(2)` then a second `srvSession.goaway(0)` is `destroyed=false` and a no-op on the host and `destroyed=true` plus `ERR_HTTP2_INVALID_SESSION` in the container; and a client's own `c.goaway(0, 1, Buffer.from('clibye'))` reaches the server as `0 , 1 , dbg=clibye` in the container against the host's `0 , 0 , dbg=undefined`.
- `owc-http-agent-freesocket-reuse-order`: with `maxSockets=3` and 12 requests the container serves a clean round-robin `["5","6","7","5","6","7",...]` where the host reuses whichever socket freed first, `["5","6","5","7","6","5","7","6","5","7","6","5"]` (2/2 runs identical on each side). `agent.freeSockets` itself now matches.
- `owc-net-end-write-finish-order`: a zero-length or 1 MiB write issued right after this side's own `end()` still emits `finish` in the container before the `ERR_STREAM_WRITE_AFTER_END` error -- container `finishes=1 order=["finish","error","close"]`, host `finishes=0 order=["error","close"]`. The error code, the callback and `writableEnded` all match; only the `finish` is extra.
- `owc-shell-cat-directory`: `mkdir sd; cat sd` -- host stderr `cat: sd: Is a directory` and status 1; container stdout `{}` and status 0.
- `owc-shell-exec-not-found-wording`: `exec nosuchcmdxyz` -- host stderr `/bin/sh: line 0: exec: nosuchcmdxyz: not found`; container `sh: nosuchcmdxyz: command not found`. Same status 127; a host names `exec` and carries the `line 0`.
- `owc-shell-type-host-only-file`: `type` can only name a file the container's own virtual PATH holds or one its static table lists, never one the host's real disk holds -- `type id` is host `id is /usr/bin/id` and 0 against the container's `sh: line 0: type: id: not found` and 1, and `type -t id` is host `file` against the container's 1 and nothing written. Measured live, both sides, at load 17-23 with 2.1 GB free, three runs, one process per line: identical every pass. It is not a name `type` mis-sorts: `ls /usr/bin` in the container lists nothing at all, so no ordering of the checks in `describeName` can answer for `/usr/bin/id`, and the only fix would be to hand the container the host's directory listing, which a worker with a virtual file system does not have. A table entry per utility is not a fix either -- it is the same unbounded list, one line at a time.
- `owc-shell-dev-fd-read`: a `/dev/fd/N` above 2 can be written to but not read from -- `printf 'hi\n' > f; cat /dev/fd/3 3<f` is host `hi` and 0 against the container's `cat: /dev/fd/3: No such file or directory` and 1. The name is answered for a redirection operator, where the descriptor is what the operator stands on, and not for a command that opens the path as a file: descriptors live in the per-command plan the shell builds, and a command is handed a context with no fd table in it (`CommandContext` is `args`, `cwd`, `env`, `input`, `fs`, `network`), so `cat` has nothing to read the 3 from. `ls -l /dev/stdout` is the same wall one level up and is host-environment besides (`lr-xr-xr-x 1 root wheel 0 Jan 1 1970 /dev/stdout -> fd/1`).
- `owc-engine-stack-underflow-user-eval`: a source the engine compiles because user code called `eval` still aborts -- `eval('(function*(){ for (const x of (yield 1)) {} })')` and the indirect `(0, eval)` of the same string are `function` on host Node 24.15 and throw `InternalError: stack underflow (op=110, pc=8)` in the container, in a CommonJS module, in an ES module and under `node -e`. The rewrite that hoists the iterable now reaches every source the container itself compiles (`new Function` anywhere, the `vm` surfaces, `node -p`); `eval` it cannot reach, because a wrapper over `globalThis.eval` is not the intrinsic `%eval%` and would cost every direct eval the caller's scope that `vm`'s own with-scoped eval and a package evaluating `require('x')` rely on. Re-measured at HEAD: the container exits 1 with `InternalError: stack underflow (op=110, pc=8)` where the host exits 0 printing `function`, in a CommonJS module, in an ES module and under `node -e`. Bare QuickJS 0.32 with no container in the way aborts on all three spellings -- direct `eval`, `(0, eval)` and `new Function` -- so the abort is the engine's own compile, and the container's rewrite is exactly what makes `new Function` print `function` there where bare QuickJS does not.
- `owc-compat-rewrite-tostring-leak`: `Function.prototype.toString` prints the compatibility rewrite instead of the source -- `new Function('return function*(){ for (const x of (yield 1)) {} }')().toString()` is `function*(){ for (const x of (yield 1)) {} }` (79 characters) on the host and `function*(){ const __owcOf1 = (yield 1); for (const x of __owcOf1) {} }` (106) in the container, and a module-level generator, a class method and a `-e` body leak the same way. The hoist is what makes the shape compile at all, so the text cannot simply be dropped; the engine would have to hand back the source it was given rather than the one it compiled.
- `owc-engine-error-message-wording`: the message of an error the engine raises itself is QuickJS's wording and not Node's, and it diverges on every one of them -- `null.x` is `cannot read property 'x' of null` where host Node 24.15 says `Cannot read properties of null (reading 'x')`, `undefinedFn()` is `'undefinedFn' is not defined` where the host says `undefinedFn is not defined`, `JSON.parse('{')` is `expecting property name` where the host says `Expected property name or '}' in JSON at position 1 (line 1 column 2)`, `new Array(-1)` is `invalid array length` against `Invalid array length`, `decodeURIComponent('%')` is `expecting hex digit` against `URI malformed`, a call of a non-function is `not a function` against `f is not a function`, and a strict-mode write to a non-writable or frozen data property is `'z' is read-only` against `Cannot assign to read only property 'z' of object '#<Object>'`. The same wall as `owc-guest-error-engine-stack-no-header`, and a wider blast radius: the message is what `String(e)`, `util.inspect` and every log line print, where the stack header is one line of one property. A getter-only accessor's `no setter for property` is `owc-guest-getter-only-assignment-message`. Re-measured at HEAD, all seven, and bare QuickJS 0.32 with no container in the way prints every one of the seven strings -- `cannot read property 'x' of null`, `'undefinedFn' is not defined`, `expecting property name`, `invalid array length`, `expecting hex digit`, `not a function`, `'z' is read-only` -- so all seven are the engine's own text and none is a wording this container chose. Seven is not the width of it: of 24 further families measured at HEAD, 23 diverge --
`1n % 0n` is `BigInt division by zero` against `Division by zero`, `String.repeat(-1)` is
`invalid repeat count` against `Invalid count value: -1`, a cyclic `Object.setPrototypeOf` is
`circular prototype chain` against `Cyclic __proto__ value`, `new Uint8Array(-1)` is
`invalid array index` against `Invalid typed array length: -1`, `BigInt('x')` is `invalid bigint literal`
against `Cannot convert x to a BigInt`, `new RegExp('(')` is `expecting ')'` against
`Invalid regular expression: /(/: Unterminated group` -- and every one of the 24 reads the same under
bare QuickJS 0.32, on both builds, as it does here; `JSON.parse('')` is the one that agrees
(`Unexpected end of JSON input` in all three arms). One of them is out of reach however the string is handled: the host's `f is not a function` names the expression that was called, where QuickJS's `not a function` names nothing at all, so there is nothing to rewrite it into.
- `owc-child-kill-timeout`: what is left of a child that cannot be stopped. A spawn's `timeout` now ends a guest child on time -- `spawn('node', [busy 5 s], { timeout: 400, killSignal: 'SIGKILL' })` closes at 416 ms with code null, signal SIGKILL and killed true where host Node 24.15 closes at 416 ms with the same three, `execFile`'s `timeout` reports killed true, signal SIGTERM and `Command failed: ...` at 423 ms (host 421), and `spawnSync`'s `timeout` reports status null, signal SIGKILL and error ETIMEDOUT at 411 ms (host 407), because the bound is put on the child's interrupt handler -- the only thing that runs while guest code holds the host thread -- rather than on a host timer. What no bound can reach is a kill with no moment attached to it: `child.kill()` 600 ms into a 5 s busy child still answers false and `process.kill(child.pid, 0)` still throws ESRCH, and a `while(1){}` child still ends on the container's ~30 s runaway budget with status 1 where the host ends it with SIGTERM in 5 ms. Bare QuickJS 0.32 with no container in the way says why: a host `setTimeout(..., 100)` armed before a 3 s guest loop fires at 3012 ms and not at 100, and the interrupt handler -- 1595 checks during one `while(1){}`, ending it at 501 ms with `InternalError: interrupted` -- can only abort a guest, never resume one, so a parent's kill has no moment at which to run. A `sh` child's `timeout` is honoured the same way now that `ShellProcess` carries `armKillDeadline` too (`owc-sh-child-kill-timeout`, fixed at HEAD): `spawn('sh', ['-c', 'node busy.js'], { timeout: 400, killSignal: 'SIGKILL' })` exits and closes at 404/408/415 ms with code null, signal SIGKILL and `killed` true over three runs here, against 412/412/407 ms with the same three on host Node 24.15. What the bound cannot do is keep a grandchild's pipe open (`owc-sh-timeout-kills-grandchild`).
- `owc-stream-internal-surface`: the internal surface of `stream` and `readline` is this implementation's own and not Node's -- `readline.Interface.prototype` carries 10 own keys (`close` through `write`) where host Node 24.15 carries 41 (`_ttyWrite`, `_refreshLine`, `_insertString`, `_deleteLeft`, `_historyNext`, `_tabComplete`, `_getDisplayPos`, `_setRawMode`, `_line`, `_sawKeyPress`, ...), a terminal interface has no `historyIndex`, `historyManager`, `isCompletionEnabled` or `isFlushing` own key, `Readable.prototype` has no `_undestroy`, `readableBuffer` or `removeAllListeners`, `Writable.prototype` has no `_writev`, `writableBuffer`, `writableAborted` or `pipe`, and the own keys of `_readableState` and `_writableState` are Node's six and Node's seven (below). Nothing a program reads to move data differs: `rl.line`, `rl.cursor`, `rl.getCursorPos()`, `rl.tabSize`, `rl.escapeCodeTimeout` and `createInterface({ history: [...] })` all agree with the host. Re-measured at HEAD against host Node v24.15.0, one fresh container per case: the state itself is Node's shape now -- one `Symbol(kState)` number per state (`1052940` for a fresh readable, and `17580812` plus a `Symbol(kBufferedValue)` for a fresh writable, both byte-identical to the host), the host's own-key order and its prototype order under a `ReadableState`/`WritableState` constructor, all eight flags this paragraph used to list as missing (`constructed`, `pipesCount`, `multiAwaitDrain` on the readable side; `afterWriteTickInfo`, `allBuffers`, `allNoop`, `bufferedRequestCount`, `getBuffer` on the writable side), `_writableState.getBuffer()` answering `[]`, and `JSON.stringify` of either state identical to the host's. A stream instance now owns no `_eventsCount` either, because Node seeds `_events` with its five busiest event names before `EventEmitter.init` runs and init then takes its shape-mode path. What is still not Node's is one line of `util.inspect`, and the fix site is not `modules/stream.ts`: `runtime/guest/util-assert.ts` never calls `getOwnPropertySymbols`, so an inspected state stops at `awaitDrainWriters: null` where the host goes on to print `Symbol(kState): 1052940`, and `showHidden: true` prints none of the host's `[objectMode]: [Getter/Setter]` rows; the same file formats a function with no name as `[Function: (anonymous)]` where host Node 24.15 prints `[Function (anonymous)]`, which is why `onwrite:` differs on an inspected writable state. Measured bare, with no container in the way: `util.inspect(function () {})` is `[Function (anonymous)]` on host Node 24.15 and `[Function: (anonymous)]` here.
- `owc-stream-readline-terminal-writes`: **fixed at HEAD** -- what a terminal readline interface writes to its output is the sequence a host writes: `prompt()` is four separate `write` calls (`'\u001b[1G'`, `'\u001b[0J'`, `'> '`, `'\u001b[3G'`) exactly as on host Node 24.15 and no longer one concatenated chunk; `i.write('x\n')` writes `'x'`, then `'\r\n'`, then one empty chunk, which is what the host writes and what a line-ending used to stop short of; `i.write('a\t')` with a completer installed calls the completer zero times and leaves the line `'a\t'`, and with no completer it writes one `'a\t'` chunk and not `'a'` and `'\t'` -- Node only completes on a real tab *key*, so completion now waits for `rl.write(chunk, { name: 'tab' })` and a plain `rl.write(chunk)` inserts what it was given whole, tab included. Re-measured at HEAD, one fresh container per case, both sides exit 0.
- `owc-stream-compose-body-shapes`: two shapes of a composed body still differ -- `compose(async function (src) { return []; })` exits 1 on host Node 24.15 with an unhandled `ERR_INVALID_RETURN_VALUE` reading `Expected nully to be returned from the "body" function` (an async body must answer null or undefined, and anything else is refused) where this implementation resolves the answer and yields an empty chunk; A trait error no longer names its stream with `Received an instance of Readable`: it embeds the whole inspected value the way host Node 24.15 does and cuts it at 128 characters, so `compose(r, r2)` now prints `Received Readable {\n  _events: {\n    close: undefined,` and then `...` on both sides. Re-measured at HEAD, one fresh container per case. `Duplex.from`, a function body of either arity, a promise body and a `{ readable, writable }` pair now all match.
- `owc-guest-promise-class-name-tracked`: **fixed at HEAD** -- the class name of a promise is `Promise` again. Every guest promise is built through the rejection tracker's subclass, which is installed as `globalThis.Promise`, and that subclass used to keep its own name, so `Promise.name` and `Promise.reject(x).constructor.name` read `Tracked` and every message that names a promise named it -- `Readable.from(Promise.resolve(1))` is `ERR_INVALID_ARG_TYPE | The "iterable" argument must be an instance of Iterable. Received an instance of Promise` on host Node 24.15 and was `Received an instance of Tracked` here. The subclass now carries `Promise`'s name. Re-measured at HEAD, one fresh container: `Readable.from(Promise.resolve(1))` answers the host's line verbatim and `Promise.name` and `Promise.reject(new Error('x')).constructor.name` both read `Promise`.
- `owc-rejection-no-uncaught-fallthrough`: **fixed at HEAD** -- a rejection nothing handled reaches a process `uncaughtException` listener when there is no `unhandledRejection` one, as it does on host Node 24.15. `Promise.reject(new Error('rej'))` with only `process.on('uncaughtException')` registered prints `UNCAUGHT=rej`, is handed the reason with the origin `unhandledRejection` Node passes for a rejection (`argc=2 origin=unhandledRejection`, `isError=true`), runs a 1 ms timer queued after the rejection and exits 0; the container used to print nothing on stdout and exit 1, because the tracker went straight from the `unhandledRejection` listener count to its fatal path and never offered the reason to `uncaughtException`. What the fix does not move: with an `unhandledRejection` listener registered the rejection still reaches that one and `uncaughtException` is never asked; with neither listener it still ends the process with status 1 and its stack on stderr; a rejection a domain owns still goes to the domain's `error` first; and two rejections in one drain are each reported, as they are on the host. Re-measured at HEAD `ee97ee07`, one fresh container per case, host node v24.15.0: the fallthrough still matches, and four neighbours of the same emit site now match as well -- the callback a caller records with `process.setUncaughtExceptionCaptureCallback` is handed the rejection instead of an `uncaughtException` listener and the run goes on (`CB=cap2` / `alive`, exit 0, against exit 1 and the reason on stderr before), an `unhandledRejection` listener that throws does not end the run but raises what it threw as an uncaught exception of its own with the origin `uncaughtException` (`UR=rej` / `UC=ur-threw origin=uncaughtException` / `timer-alive`, exit 0, against exit 1 and no timer), a reason that is not an `Error` is raised as node's `UnhandledPromiseRejection` (`typeof=object`, `The promise rejected with the reason "plain-string"` for `'plain-string'`, `42` and `undefined`, against the raw primitive before), and a rejection reported unhandled and caught a turn later emits `rejectionHandled` (`UC=late | CAUGHT | RH`). Two symptoms of the same area survive: a listener that throws out of `uncaughtException` ends the run with 1 here where host node 24.15 ends it with 7 and its own `process._fatalException` stack, and a genuine synchronous throw reaches `uncaughtException` with `origin=undefined` here where the host passes `uncaughtException` -- the second is `emitUncaught` in `packages/core/src/process/executors/node/runtime/guest/loader.ts`, which is not this shard's file.
- `owc-als-across-await-engine`: an `AsyncLocalStorage` store survives every `await` on host node 24.15 and is lost across every one of them here -- `als.run('S', async () => { ... })` reads `S` after `await null`, `await 42`, `await Promise.resolve(1)`, `await` a timer promise, `await` a thenable, `await` a tick, `await` an immediate and after two awaits in a row on the host, and `undefined` after all nine in the container (and `E` rather than `undefined` after an `await` that runs while an `als.enterWith('E')` is still in force, where the host reads `S`), while `setTimeout`, `nextTick`, `setImmediate` and a promise `.then` keep `S` on both sides. Measured in the container, the `then` an `await` reaches is the JS-visible one -- one instrumented `Promise.prototype.then` counts gets=1 calls=1 for `await Promise.resolve(1)` and for `await new Promise(function (r) { r(2); })`, 0 for `await null` and 0 for a promise the engine built itself -- because a guest promise is a subclass of the intrinsic `Promise` and QuickJS 0.32 fast-paths `await` only for the intrinsic promise class; the 0 this row used to quote is the bare engine's, where `globalThis.Promise` is still the intrinsic, and the same instrumentation on the same engine reads 1 once a `Tracked`-style subclass is installed as `globalThis.Promise`. The store is lost because that `then` has been deferred to a job of the engine's: it runs after the async function has suspended and `run`'s `finally` has restored the frame, so inside the `then` the first `await` of `als.run('S', ...)` reaches, `als.getStore()` is already `undefined`, and no guest-side wrapper over `Promise.prototype.then` is ever handed the resumption. There is no host hook on job enqueue or async context to stand in for it: the shipped engine's whole C surface is 77 `QTS_*` entry points (`QTS_NewPromiseCapability`, `QTS_PromiseState`, `QTS_PromiseResult`, `QTS_IsJobPending` and `QTS_ExecutePendingJob` are the only promise and job names among them), it exports no `addFunction` with which a callback could be installed, `PromiseHook` appears in no file of `quickjs-emscripten`, of `quickjs-emscripten-core` or of the `@jitl/quickjs-singlefile-browser-release-asyncify` variant (0 of 51), and the `AsyncContext` hits in those files are all the asyncify class `QuickJSAsyncContext`. Re-judged at `affecb4`, one fresh container per case, two runs each: byte-identical to the measurement above, and `als.getStore()` is `undefined` outside the flow on both sides, so nothing leaks into a later microtask or macrotask. What did leak backwards is now fixed: a `.then` reaction registered before an `als.enterWith('E')`, and a timer queued before it, read `E` in the container where host node 24.15 reads `undefined` for both, because the container's frame is one module-level variable and a reaction registered with no frame captured inherited whatever `enterWith` later left there; both now read `undefined` on both sides, with the `await` divergence above unchanged. Re-measured at HEAD (shard `adv7b-exec-process-signals`), one fresh container: `als.before=S`, `als.then=S` and `als.timer=S` on both sides, and `als.await-null`, `als.await-42`, `als.await-pr`, `als.await-timer` and `als.await-2` all `undefined` here against `S` for all five on host node v24.15.0, with `als.outside=undefined` on both. Bare QuickJS 0.32 with no container in the way, one context, logging an `await`'s resumption against the frame a `run`'s `finally` restores: `enter:frame=S`, `after-run:frame=undefined`, `after-await-null:frame=undefined`, `after-await-pr:frame=undefined` -- the resumption is a job of the engine's and it runs after the stack that carried the frame has already unwound, so no guest-level wrapper over `Promise.prototype.then` is ever handed it. Re-measured at HEAD `ee97ee07`, one fresh container per case: the nine `await` losses are unchanged, and the store still keeps its value through `setTimeout`, `nextTick`, `setImmediate`, `queueMicrotask` and a promise `.then` on both sides (`run=A microtask=A then-micro=A immediate=A timer=A then-timer=A`, byte-identical), so the header note in `packages/core/src/process/executors/node/runtime/guest/modules/pure-a.ts` that used to claim it did not propagate through timers was stale and now says `await` only. One neighbour of the same shim is now fixed: `AsyncLocalStorage.prototype.disable()` used to rebind the current frame, which wiped the store of continuations already scheduled, so a `nextTick` and a `setTimeout` queued inside `s.run('A', ...)` with the `disable()` after the run had been left both read `undefined` here where host node 24.15 reads `A` for both; it now takes the store out of the frame that is current instead, which leaves those two at `A` and still answers `undefined` for the same `disable()` called inside the run, as the host does. Bare QuickJS 0.32 with no container in the way, one context, a counting getter installed on `Promise.prototype.then` with a subclass in place as `globalThis.Promise`: an explicit `.then` is `gets=1 calls=1`, `await Promise.resolve(7)` is `gets=1 calls=0`, and `await null` and `await` a thenable are `gets=0 calls=0` -- the `then` an `await` reaches is never one the guest gets to run
- `owc-fetch-location-trailing-space`: a 302 whose `Location` ends in a space or a tab is followed here and fails the fetch on the host -- `location: '/echo '` answers `200` from `/echo` after two requests in the container, where host Node 24.15 rejects with `TypeError: fetch failed` carrying `TypeError: Cannot create property 'hash' on string '/echo '` after one. The host's own `fetch` reads the value off its own HTTP parser, which keeps the six bytes; `fetch` here is built on the guest `node:http` client, which hands back five (`res.headers.location` is `"/echo"` and `res.rawHeaders` agrees, on both sides), so there is no trailing space left for `undici.ts` to see and no change there reaches it: the trim is the http client's header parsing in `packages/core/src/process/executors/node/runtime/guest/modules/http.ts`.
- `owc-asyncfn-rejection-unreported`: a rejection of an async function's own promise is never reported -- `(async function () { throw new Error('asyncfn-throw'); })();` with a 20 ms timer after it exits 1 with the error on stderr and never runs the timer on host node 24.15, and exits 0 printing `end` in the container. QuickJS builds an async function's result with the intrinsic `%Promise%` and not through the global binding: with `globalThis.Promise` replaced by a subclass, bare QuickJS 0.32 reports `p instanceof Tracked` false, `Object.getPrototypeOf(p) === %Promise%.prototype` true, and 0 constructor calls and 0 `Symbol.species` gets, so the rejection tracker that covers promises built through the container's own `Promise` has no cell for this one; reaching it needs `JS_SetHostPromiseRejectionTracker` or a job-enqueue hook, and quickjs-emscripten 0.32.0 exports neither. Re-witnessed at 2730967, one fresh container per case: an async function's rejection also reaches neither a `process.on('unhandledRejection')` listener nor a domain's `error` listener here (`LISTENER asyncfn-reject` and `DOMAIN asyncfn-domain` on host node 24.15, `timer-ran` only in the container), where a promise the guest built reaches the domain on both sides (`DOMAIN tracked-reject`), so the whole divergence is the one promise the engine builds itself -- with one measured exception: `Promise.resolve().then(function () { return (async function () { throw new Error('arm-d-adopted'); })(); })` rejects a promise the guest did build, the derived promise of that `.then`, and host node 24.15 reports it to a `process.on('unhandledRejection')` listener where the container reports nothing (one process, five arms: `SEEN arm-a-plain`, `SEEN arm-e-ctor`, `SEEN arm-b-awaited` and `SEEN arm-d-adopted` on the host, the first two only here, reproduced twice on each side). Bare QuickJS 0.32, with no container in the way, says why: a subclass that records rejections through the `wrapped` reject its executor is handed records 1 call for `new Promise(function (res, rej) { rej(e); })` and 1 for `Promise.reject(e)`, and 0 for `Promise.resolve(1).then(function () { return <a throwing async function>; })`, 0 for `new Promise(function (res) { res(<a throwing async function>); })` and 0 for `new Promise(function (res) { res(<a thenable that rejects>); })` -- all five end up rejected -- so settling a promise by adopting a thenable goes through the resolving functions `NewPromiseResolveThenableJob` builds for it and never through the subclass's own reject, and the promise that rejects is one the engine settles without naming it to any guest code. Bare QuickJS 0.32, with no container in the way, reports neither kind: after `Promise.reject(new Error('x'))` and after a throwing async function, `executePendingJobs` drains 2 jobs and 0 with nothing thrown and nothing added to `globalThis`. Re-measured at HEAD (shard `adv7b-exec-process-signals`), one fresh container: the throwing async function with a 20 ms and a 100 ms timer after it prints `end`, `timer-after-asyncfn` and `timer-late` and exits 0 here, against `end` on stdout, `Error: asyncfn-throw` on stderr, exit 1 and neither timer on host node v24.15.0. Bare QuickJS 0.32 again, one context, with a subclass installed as `globalThis.Promise`: an async function's result reads `instanceof` that subclass `false` and `Object.getPrototypeOf(p) === %Promise%.prototype` `true`, and draining the engine's own jobs after `Promise.reject(new Error('a'))` and after a throwing async function throws nothing and reports nothing, so the engine has no rejection tracker of its own to hook. Re-measured at HEAD `ee97ee07`, one fresh container per case, host node v24.15.0, with both an `unhandledRejection` and an `uncaughtException` listener registered: the host prints `UR#1=asyncfn-throw` and `timer-after n=1`, this container prints `timer-after n=0` and nothing else, while the two controls -- a rejection of a promise built by the global `Promise` inside an async function, and `Promise.resolve().then(function () { throw ... })` -- are reported on both sides, so the gap is exactly the async function's own promise. Bare quickjs-emscripten 0.32.0, one context, the container's own subclass installed as `globalThis.Promise` with `Symbol.species`: `Promise.reject(new Error('explicit'))` and `Promise.resolve(1)` build 2 through the subclass and answer `instanceof` it `true`, and `(async function () { throw new Error('asyncfn'); })()` builds 0 through it, answers `instanceof` it `false` and `constructor === %Promise%` `true` -- the engine builds that promise itself, so no guest-side tracker ever sees the rejection

- `owc-sh-timeout-kills-grandchild`: `spawn('sh', ['-c', 'echo shell; node /app/w/busy.js'], { timeout: 400, killSignal: 'SIGKILL' })`
  -- the `exit` agrees with host node 24.15 and the `close` does not. Both sides exit at ~410 ms with
  code null and SIGKILL and stdout `shell\n`; the host then closes at 5041 ms with `shell\nBUSY-DONE\n`
  and here it closes at 408 ms with `shell\n`. A host's `timeout` kills only the child it spawned, so
  the grandchild `node` runs its 5 s out and holds the stdout pipe open until it has; here the bound
  the shell carries travels to the child that runs its line (`killDeadlineLeft` in
  `packages/core/src/process/executors/shell/process.ts:291`, adopted at
  `packages/core/src/process/executors/node/process.ts:1228`) and ends that child as well. With a
  single command in the line -- `sh -c 'node busy.js'` -- the two sides agree, because a host's `sh`
  execs a last command without forking and there is then no grandchild to differ over. Re-measured at
  HEAD, one fresh container per case, three runs, load 13-15 with 60-600 MB free: `exit` is
  409/411/407 ms here against 409/414/406 ms on the host, both with code null, SIGKILL, `killed` true
  and stdout `shell\n`, and `close` is 409/412/407 ms here against 5057/5068/5053 ms with
  `shell\nBUSY-DONE\n`. Nothing in this design can hold that pipe open: a container child's stdout
  reaches its parent as events and `cpCloseWhenDone` (`runtime/guest/modules/child.ts:596`) ends the
  parent's stream when the child itself exits, so there is no inherited write end for a grandchild to
  keep open and no moment at which output written after the deadline could still arrive. Re-judged at HEAD, one
  fresh container per side, load 9-18 with 0.5-1.6 GB free: `exit` 408 ms and `close` 408 ms here
  with code null, SIGKILL, `killed` true and stdout `shell\n`, against `exit` 407 ms and `close`
  5033 ms with `shell\nBUSY-DONE\n` on host node 24.15 — the row's claim holds.
- `owc-sh-child-timeout-bound-shape`: **fixed at HEAD** -- the `timeout` of a `sh -c <line>` spawn now
  ends the line at the bound and runs no command after it. The engine's `sleep` is `blockFor`
  (`packages/core/src/shell/commands/fileutils.ts:2482`), an `Atomics.wait` on the host thread that no
  timer can interrupt, which is why the bound used to be missed by the whole sleep: measured before
  this fix, `exec('sleep 5; echo LATE', { timeout: 400 })` was 5008 ms and `LATE\n` here against
  403 ms and `''` on host Node 24.15. A bounded line now waits on a timer instead, and only until the
  bound runs out (`runEngineLine` in `packages/core/src/process/executors/shell/process.ts`), and a
  synchronous run cuts the wait to what is left of it (`sleepWithinDeadline` in
  `packages/core/src/process/executors/node/runtime/capabilities/child.ts`). A wait behind `exec` is
  the bound's too, which it was not: `exec` runs the utility in the shell's own place, so the engine
  took the line and no timer ever held it, and `spawn('sh', ['-c', 'exec sleep 3'], { timeout: 400,
  killSignal: 'SIGKILL' })` sat out the whole sleep -- 3016-3019 ms here against 408 ms on host
  node 24.15, whose `sh` is replaced by `sleep` and is therefore the process the bound kills.
  `sleepMsOf` now reads the `sleep` behind `exec`, and a wait that fits inside the bound is still an
  `exec`, ending the line the way a host's does -- `sh -c 'exec sleep 1; echo AFTER'` under a 4 s
  bound prints nothing, at 1016 ms on the host and 1006 ms here. Re-measured at HEAD, one
  fresh container per case, load 9-13: `exec('sleep 5; echo LATE', { timeout: 400 })` is 405 ms and
  `''` here against 402 ms and `''`, and `spawn('sh', ['-c', 'sleep 1; echo AFTER1'],
  { timeout: 400, killSignal: 'SIGKILL' })` exits and closes at 404 ms with `''` against the host's
  `exit` 404 ms and `''`. One shape of that line still differs and no bound can reach it: the host's
  `close` is 1020 ms there, because the grandchild `sleep` holds the stdout pipe open for a second
  after `sh` was killed, and this container has no grandchild to hold a pipe
  (`owc-sh-timeout-kills-grandchild`). A TERM trap is still not run by the timeout path --
  `spawn('sh', ['-c', 'trap "echo TRAPPED" TERM; echo A; sleep 2; echo B'], { timeout: 400 })` -- and
  its fix site is outside this shard: `runTrap`
  (`packages/core/src/shell/commands/builtins.ts:4113`) is not exported and is called only for EXIT,
  ERR and DEBUG, so a TERM trap is registered and never run, and `fireKillDeadline` has no way to
  hand the signal to the shell rather than only to the caller. The timeout is not what bypasses it:
  measured at HEAD `4c7b424` with no `timeout` and no host timer anywhere in the line,
  `spawn('sh', ['-c', 'trap "echo TRAPPED" TERM; kill -TERM $$; echo after'], {})` answers
  `out="TRAPPED\nafter\n" status=0 sig=null` on host node 24.15 and `out="" status=null sig=SIGTERM`
  here, while the same line with no trap agrees (both die SIGTERM) and `trap "echo BYE" EXIT` agrees
  on both (`X\nBYE\n`, status 0).
- `owc-no-bin-sleep-or-bash`: two names a host execs are not files this container's file system holds.
  `sleep` exists only as a shell utility -- `spawn('sleep', ['1'])` and `spawn('/bin/sleep', ['1'])` are
  ENOENT here where host Node 24.15 runs them for ~1 s and code 0 -- and there is no `/bin/bash`:
  `spawn('/bin/bash', ['-c', 'echo hi'])` is ENOENT, `exec('bash -c "echo hi"')` is 127 with
  `command not found`, and `exec(cmd, { shell: '/bin/bash' })` is ENOENT. A name that is neither a
  utility, a shell builtin nor a file on PATH is a failed spawn here, exactly as it is on a host; what
  is missing is the host's own `/bin`. The fix site is the executor registry and the `/bin` the
  virtual file system boots with (`packages/core/src/process/executors/registry.ts`), outside this
  shard.

- `owc-esm-loader-divergences` (residual, engine): two messages a module reaches are QuickJS 0.32's
  own words and not this container's. A module that does not parse throws
  `SyntaxError: unexpected token in expression: ';'` where host Node 24.15 says
  `SyntaxError: Unexpected token ';'` -- so `require('./bad.mjs')` over `export const a = ;` gives the
  constructor and the `ERR_REQUIRE_ESM`-free path host gives, and only the sentence differs -- and a
  call of a value that is not a function throws `TypeError: not a function` where host says
  `TypeError: o.import is not a function`. Both proved with bare QuickJS 0.32 (quickjs-emscripten, no
  container in the way): `evalCode('const a = ;')` reports `SyntaxError` /
  `unexpected token in expression: ';'` there, and `evalCode('(function(){ var o = { import: 1 }; return o.import(); })()')`
  reports `TypeError` / `not a function`, so neither is a rewrite of this container's. Both *are*
  reachable from the ESM loader, five ways over, all with the right constructor and no code on the
  error: `await import('./bad.mjs')` over a dependency that does not parse, `require` of the same
  body as a `.cjs` and as a `.mjs`, a static chain entry -> mid -> bad, and an undefined global
  inside an ESM dependency (`'totallyUndefinedGlobal' is not defined` here against
  `totallyUndefinedGlobal is not defined`) -- so "unreachable" was wrong, and what is left is the
  choice to record the sentence rather than edit around the engine. Two further residuals belong to
  this row and neither is this shard's: `new TextDecoder().decode(1)`, `decode('ok')`, `decode(true)`,
  `decode([])` and `decode({})` answer `''` or `'��'` where host Node 24.15 throws
  `TypeError [ERR_INVALID_ARG_TYPE] "The \"list\" argument must be an instance of SharedArrayBuffer,
  ArrayBuffer or ArrayBufferView."` for every one of them -- measured host-identical at HEAD, see the witness above (`decode(null)` here throws
  `cannot read property 'length' of null`), whose fix site is `TextDecoderImpl.prototype.decode` in
  `packages/core/src/process/executors/node/runtime/guest/util-assert.ts:259`; and an *uncaught*
  dynamic import of a module that will not compile prints the loader frames of a linked dependency
  (`at ModuleJob.syncLink` / `at ModuleJob.link`) where host prints those of a load it started
  (`at node:internal/modules/esm/loader:628:32` / `at TracingChannel.tracePromise`), which no signal
  at the compile site can tell apart, since a static dependency of that same dynamic import is a
  linked dependency on both sides.

`node:stream/consumers`' `json()` on invalid JSON reports the engine's words, not V8's: `SyntaxError: expecting property name` against the host's `Expected property name or '}' in JSON at position 1 (line 1 column 2)`. Engine-limited, and measured with no container in the way — bare QuickJS 0.32 (`quickjs-emscripten` 0.32.0, `JSON.parse('{a}')` in a bare context) prints this container's exact string — so it is recorded and not chased in code (`json()` on valid JSON is byte-identical, and so is `text()` unless a chunk boundary splits a character, below).
`node:stream/consumers`' `text()` only reassembles a character a chunk boundary split when the decoder carries the incomplete sequence, and this one does not: over `Buffer.from('a\u00e9\u{1F600}z')` cut at byte 4, host Node 24.15 answers `a\u00e9\u{1F600}z` and this container answers `a\u00e9\uFFFD\uFFFD\uFFFD\uFFFDz`, because `TextDecoderImpl.prototype.decode` (`packages/core/src/process/executors/node/runtime/guest/util-assert.ts:259`) takes no second argument and so drops the `{ stream: true }` carry Node's own `text()` hands it; the missing argument check on that same line is why `text()` over an object-mode stream resolves `''` here where host throws `TypeError [ERR_INVALID_ARG_TYPE]`. Not engine-limited -- bare QuickJS 0.32 has no `TextDecoder` at all (`typeof TextDecoder` is `undefined` in a bare `quickjs-emscripten` 0.32.0 context), so the whole behaviour is this container's own JavaScript -- and the fix site is `util-assert.ts`, which the stream shard does not own, so it is named and not edited. **Re-witnessed at HEAD and closed on that witness with no source change**: `TextDecoderImpl.prototype.decode` takes its options now, so 25 lines agree byte for byte -- `consumers.text()` over `Buffer.from('aé😀z')` cut at each of bytes 1 to 8 answers the whole string on both sides, `text()` over `Readable.from([{a:1}], {objectMode:true})` rejects `ERR_INVALID_ARG_TYPE` naming the `input` argument on both, and `decode(1)`, `decode('ok')`, `decode(true)`, `decode([])` and `decode({})` are each `ERR_INVALID_ARG_TYPE` naming the `list` argument, as are the `{ stream: true }` carry across a two-byte and a four-byte sequence, the split BOM and `fatal`.

Two `process.kill` details stay recorded rather than fixed: `SIGSTOP` ends it with 128 + 17 where a host process is *stopped* and hangs, which nothing outside can resume; and a name that only one platform knows is decided by the table this runtime numbers signals with, so `SIGSTKFLT` is a real signal to a Linux table and `ERR_UNKNOWN_SIGNAL` to a Darwin one.

`inspector` notifications are the shape of the protocol's, not its content: `Runtime.executionContextCreated` is emitted when `Runtime` is enabled and `Runtime.consoleAPICalled` for every line the program writes, but an event carries no `timestamp` and no `stackTrace`, and the context name carries no `uniqueId`, because the values a host puts there are its pid's and its clock's.

`createSign().sign` names the same type list the host does up to its tail: `ArrayBuffer` is in it now, but `KeyObject` and `CryptoKey` are not, so `sign(1)` says `ArrayBuffer, Buffer, TypedArray, or DataView` where host Node 24.15 says `ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey`.

`Object.setPrototypeOf` over a non-extensible receiver is named by V8 and only typed by QuickJS: at HEAD `9376836` the container answers `TypeError: object is not extensible` for `Object.preventExtensions({})`, `[]`, `function f() {}`, `Object.seal({})` and `Object.freeze({})`, where host Node 24.15 answers `#<Object> is not extensible`, `[object Array] is not extensible`, `function f() {} is not extensible`, `#<Object> is not extensible` and `#<Object> is not extensible`. It is the engine's sentence, not this container's: the same five calls under bare QuickJS 0.32 (quickjs-emscripten 0.32.0, one fresh runtime and context, no container bootstrap) answer `object is not extensible` for all five, and so do a non-extensible `Proxy` receiver (`proxy: bad prototype` here and in bare QuickJS 0.32, against V8's `#<Object> is not extensible`) and `Object.defineProperty` over one (`object is not extensible` here, against `Cannot define property a, object is not extensible` on the host). Leaving the engine's words is a choice and not an impossibility: `Object.setPrototypeOf` is writable and configurable in QuickJS 0.32, so a wrapper installed from the guest runtime renames it, and the container already ships JavaScript over the engine's builtins (row `owc-engine-error-message-wording`, closed stale). Re-measured at HEAD `1ff048b` over a fourteen-line differential -- host node v24.15.0, one container boot, one bare QuickJS 0.32 runtime, all three exits 0 with empty stderr at machine load 7-10 -- and every one of the fourteen is byte-identical between the container and bare QuickJS 0.32: six `setPrototypeOf` receivers answer `object is not extensible` and a seventh, the non-extensible `Proxy`, answers `proxy: bad prototype`, while the host names the receiver in all seven, `function f(){} is not extensible` for the function and `#<Map> is not extensible` for a `Map`. Two older claims in the row do not hold and are corrected here: the four bare calls `Object.preventExtensions([])`, `Object.preventExtensions(function f(){})`, `Object.seal({})` and `Object.freeze({})` do **not** throw on either side -- measured no-throw on host and container alike, so only a `setPrototypeOf` over them throws -- and "for every receiver" is too broad, since the `Proxy` receiver and `Object.defineProperty` carry sentences of their own. Re-measured a third time at HEAD `9354731` over a 26-line differential -- host node v24.15.0, one container boot, one bare `quickjs-emscripten` 0.32.0 runtime and context, all three exits 0 with empty stderr at machine load 13-16 with 99-159 MB free -- and the container is byte-identical to bare QuickJS 0.32 on **all 26 lines**: the thirteen engine-raised families (`cannot read property 'x' of null`, `'undefinedFn' is not defined`, `expecting property name`, `invalid array length`, `expecting hex digit`, `not a function`, `'z' is read-only`, `BigInt division by zero`, `invalid repeat count`, `invalid array index`, `invalid bigint literal`, `expecting ')'`, `circular prototype chain`), the six `setPrototypeOf` receivers, the non-extensible `Proxy` (`proxy: bad prototype`) and `Object.defineProperty` over a non-extensible target, with `Object.getOwnPropertyDescriptor(Object, 'setPrototypeOf')` reading `{"writable":true,"enumerable":false,"configurable":true}` on both. So `owc-engine-error-message-wording` closes stale for thirteen of its fourteen families on that bare-QuickJS witness: they are the engine's own strings, raised inside the engine, and no container-side wording change reaches them. The fourteenth is the one that is not engine-limited and is recorded here rather than chased: `Object.setPrototypeOf` over a non-extensible receiver is reachable, because `Object.setPrototypeOf` is writable and configurable in QuickJS 0.32 and a wrapper installed from the guest runtime renames the error -- a ten-line wrapper written inside the container at this HEAD reproduced the host's `#<Object> is not extensible` and `[object Array] is not extensible` with normal operation intact (`proto=Array` still set). Its site is the guest bootstrap (`packages/core/src/process/executors/node/runtime/guest/globals.ts`, beside the `MODULE_TRAPS.setPrototypeOf` that `loader.ts:767` already installs for module namespaces), which this shard does not own and which other lanes are editing concurrently, so it is named and not edited here.

`owc-verifier-open-gaps` is stale as a list. At HEAD `9376836` thirteen of the fourteen API gaps it names are present in the container -- `events.on`, `events.getEventListeners`, `util.parseArgs`, `timers/promises` `setInterval` and `scheduler`, `net.BlockList`, `net.SocketAddress`, `buffer.Blob`, `buffer.transcode`, `buffer.isUtf8`, `async_hooks.AsyncLocalStorage`, `vm.Script` and `http2.connect` all answer `function` -- and a live HTTP/2 server answers its `stream` event and `respond()`s `http2-ok` byte-identically to the host. "Buffer identity across worker messages" is fixed at HEAD: a `Buffer` posted from a worker arrives as a `Uint8Array` (`Buffer.isBuffer(m)` false, `m.constructor.name` `Uint8Array`, 10 bytes, `isView` true), on all six lines the host prints. `AsyncLocalStorage` across `await` is real and is already closed stale as an engine limit under `owc-als-across-await-engine`: the store survives `setTimeout`, `nextTick`, `setImmediate` and `.then` and is lost across every `await`, because QuickJS exposes no promise/async-context hook for Node's implementation to stand on. What is left is the module export table -- five names, `register`, `stripTypeScriptTypes` and the three `enableCompileCache` / `flushCompileCache` / `getCompileCacheDir` that QuickJS has no code cache for -- and that is `owc-module-export-table-incomplete`, another shard's row. Re-measured at HEAD `1ff048b`, that last item is gone too: `Object.keys(require('module'))` is 30 own keys against the host's own 30 and `builtinModules` is 72 against 72, and none of the five names is missing -- `register`, `stripTypeScriptTypes`, `enableCompileCache`, `flushCompileCache` and `getCompileCacheDir` all answer `function`. So the only finding the row names that still diverges is `AsyncLocalStorage` across `await` (`als.getStore()` is `undefined` after an `await` where host Node 24.15 answers `als-value`), and that one is already closed stale as an engine limit under `owc-als-across-await-engine`. The row is therefore stale as a list: every gap it names is closed. Re-measured at HEAD `9354731` that is still true -- `Object.keys(require('module'))` is 30 own keys against the host's own 30 with an identical key list, `builtinModules` is 72 against 72, none of `register`, `stripTypeScriptTypes`, `enableCompileCache`, `flushCompileCache`, `getCompileCacheDir` is missing (all answer `function`, as they do on the host), `stripTypeScriptTypes` output is byte-identical, and `util.parseArgs`, `net.BlockList` and `buffer.isUtf8` behave identically; `buffer.transcode` is not a gap at all, since host Node 24.15 answers `Buffer.transcode is not a function` too. Three behavioural divergences do sit inside the API set the row names, and they are recorded here as residuals rather than reopened as this row, because none is a missing API and all three live in the `node:module` implementation that row `owc-module-export-table-incomplete` owns: `module.enableCompileCache()` answers `{"status":3}` with no directory here against the host's `{"status":1,"directory":"/var/folders/.../node-compile-cache"}`, `module.getCompileCacheDir()` answers `undefined` against a real path (QuickJS 0.32 has no code cache for either to point at), and `module.register('./x.mjs')` throws `Error: Failed to resolve module specifier "./x.mjs" from "data:": Invalid relative URL or base scheme is not hierarchical.` where the host throws `TypeError:` with the identical message -- the last is a one-word class fix in `packages/core/src/process/executors/node/runtime/guest/misc.ts`, named and not edited.

Two rows about this repository's own tooling rather than about the container, each with a fix site outside it. `.gm/exec-spool/.dispatch-ledger.json` is written by the gm runner, the agentplug daemon outside this repo (`/Users/dylanwong/.agentplug`), and is not one JSON document: it is one JSON object per line -- 433,033 bytes of NDJSON at HEAD `1ff048b`, 1160 objects each of which parses on its
own, the first ending at byte 205 (it grows while a lane dispatches: the same read measured 426,810 bytes and 1140
objects minutes earlier), so a whole-file `JSON.parse` fails with `Extra data: line 2 column 1 (char 206)` -- only the
concrete bytes move, the disposition does not. Byte 0 is `{` on every read, so there is still no array in the file and
the "array frozen at N entries with an NDJSON tail appended" shape is not what the bytes show. Nothing in this
repository writes it: a repo-wide `grep -rl dispatch-ledger` excluding `node_modules`, `.gm` and `.git` matches only
this `Readme.md`, and `node_modules/.pnpm` matches nothing, so the writer stays the agentplug daemon outside the repo
(`/Users/dylanwong/.agentplug`) and a file-level repair would be a reset rather than a fix. `.gm/prd/*.yml` was tracked in git with no ignore rule, so every pull re-materialized rows that had been closed by deleting their file; that half is fixed here by a `.gm/.gitignore` rule for `prd/` and by dropping the tracked row files from the index -- re-verified at HEAD `1ff048b`, where `git check-ignore -v .gm/prd/owc-napi-canvas.yml` answers `.gm/.gitignore:3:prd/` and `git ls-tree -r origin/main -- .gm/prd` is 0 paths, so a pull can no longer re-materialize a deleted row. `owc-core-build-skips-napi-guest` was **not** fixed and the witness written for it is refuted: there are **two** guest generators in `packages/core/scripts/`, and `build` ran only one of them. At HEAD `9354731` `node scripts/build-quic-guest.mjs --check` exits 1 with `quic.ts is out of date`, and `scripts/build-quic-guest.mjs` -- the generator that writes `src/process/executors/node/runtime/guest/modules/quic.ts`, the QUIC/HTTP-3 guest bundle the container compiles and executes -- had no caller anywhere in the repository (a repo-wide grep for `build-quic-guest` over json/ts/mjs/js/yaml matches only its own comments and the generated file's own header), so no `pnpm build` ever regenerated it and an edit under `src/network/quic` could never reach the container. **Fixed here**: `build` is now `pnpm build:napi-guest && pnpm build:quic-guest && pnpm build:worker && pnpm build:main`, and `quic.ts` is regenerated (296,011 bytes of guest script from 26 modules). Re-verified at HEAD `9354731` after the change: `node scripts/build-quic-guest.mjs --check` exits 0 before a full `pnpm build` and 0 again after it (build exit 0, ESM/CJS/DTS all success), and a container boot on the regenerated bundle registers `owc:internal/quic` and `owc:internal/http3` with exactly the key sets the committed bundle registered -- `QuicConnection,QuicEndpoint,QuicStream,VERSION,connect,createServer,decodeTransportParameters,describeTransportParameters,encodeTransportParameters,DEFAULT_TRANSPORT_SETTINGS,MAX_DATAGRAM_SIZE` and `Http3Connection,Http3Server,Http3ServerRequest,Http3ServerResponse,Http3Session,Http3Stream,connect,constants,createSecureServer,createServer,errorName,qpack` -- so the 296,011 bytes are a codegen difference and not a behaviour change (the HTTP/3 request round trip of this lane's probe times out identically on the committed bundle and the regenerated one, so that is pre-existing and not this regeneration). `scripts/build-napi-guest.mjs --check` also exits 1 today, but only because another lane has uncommitted edits under `src/napi/sharp`; that is in-flight source rather than a build-script defect, so `napi-sharp.ts` was left exactly as that lane had it and is named, not regenerated. The same is still true of the rest of `.gm/**` (1306 tracked paths, two of gm's spool files among the largest entries in every working-tree diff), whose fix site is the root `.gitignore` and is outside this shard's grant. And `owc-store-witness-staleness` is a bookkeeping record rather than a container divergence: re-read at HEAD `9354731` all 347 records of `.gm/prd-log.jsonl` carry `status completed` (0 unparsed) and the newest is ts `1792761364455` (2026-10-23T13:16:04Z) against a tip committed at `1792762356` (13:32:36Z), so 0 of 347 were produced at or after the tip -- but a witness is written when its row is resolved and the commit that carries it lands afterwards, so that inequality holds at every instant while any lane is committing, and refreshing all 318 ids means re-running 304 container cases, which no single lane can do. The row is "true by construction" in exactly that sense and can therefore never be closed by re-measurement: every new commit re-arms the inequality. This lane re-measured nine of them at the same HEAD (worker `Buffer` identity, the repl, canvas 95/96, node-pty 27/29, the extensibility wording, the verifier gap list, `pnpm build`'s generated-guest check, the guest turn cost and the lean gate) and every one still matches what its record says. The three other tooling rows re-verified at the same HEAD: `git check-ignore -v .gm/prd/owc-napi-canvas.yml` answers `.gm/.gitignore:3:prd/` (exit 0) with `git ls-tree -r HEAD -- .gm/prd`, `git ls-tree -r origin/main -- .gm/prd` and `git ls-files .gm/prd` all 0 paths and `git status --short .gm/prd` 0 lines, and `.gm/.gitignore` is itself tracked (blob `3c03599`) so the rule survives a fresh clone -- 1,261 tracked `.gm` paths remain and the root `.gitignore` still carries no `.gm` entry, whose site is outside this shard's grant; the graph behind `owc-lean-net-gate` is still 146 states and 376 edges with `lean-net-negative` on exactly one edge (`G_NET -> NODELETE`) and both `G_NET -> DIFFBUDGET` and `GUARDANDGO -> NODELETE` ungated, so a gate-free breadth-first search from `G_NET` still reaches 145 of the 146 states with `NODELETE` among them (`COMPLETE` is the only one it misses); and `.gm/exec-spool/.dispatch-ledger.json` is still NDJSON -- 491,993 bytes, byte 0 `{`, first newline at 205, 1,266 non-empty lines of which 1,266 parse individually and 0 fail, whole-file `JSON.parse` failing at line 2 column 1, `is_array_start` false -- with five `dispatch-ledger.corrupt-*.json` snapshots now on disk and its writer still outside this repository.

`owc-guest-turn-latency` re-measured in isolation at HEAD `9354731` -- host node v24.15.0 against one container boot per run, two runs each, 300 iterations after 50 of warm-up, machine load 13-16 with 99-159 MB free: only `setImmediate` diverges. Per serial turn, host `setImmediate` is 0.0167-0.0185 ms and the container's is 1.177-1.310 ms (~70x), while `setTimeout(0)` is 1.131-1.166 ms on the host and 1.182-1.277 ms in the container (1.02x), `setTimeout(1)` 1.127-1.129 vs 1.170-1.175, `setTimeout(2)` 2.262-2.266 vs 2.296-2.311 and `process.nextTick` 0.0012-0.0013 vs 0.0291-0.0314. The container's `setImmediate` costs what its own `setTimeout(0)` costs to three figures, which names the mechanism and cannot be a load artefact: `setImmediateImpl` (`loader.ts:1054`) hands `0` to `scheduleTimer`, and `scheduleTimer` clamps it at `loader.ts:980` (`if (!(delay >= 1)) delay = 1`), so an immediate is a 1 ms host timer where Node's is the event loop's check phase. Batch control: 200 `setImmediate` queued at once drain in 6.18-6.24 ms (host 0.134-0.234 ms) and 200 `setTimeout(0)` in 5.80-7.19 ms (host 1.23-1.24 ms), so the cost is per serial turn and not per callback. It is **not** engine-limited -- bare QuickJS 0.32 has no `setImmediate` at all, so there is no engine behaviour to point at -- and it is therefore not closed stale on an engine limit: what blocks it is the grant and the blast radius, and both are named here. Removing the clamp alone buys nothing, since a 0 ms `setTimeout` is 1.18 ms in the container too; a real immediate needs a queue that `setImmediateImpl` drains without arming a timer, which needs a matching non-timer path through the host bridge (`host-bridge.ts:247` `define('setTimer')` into `process.ts:1902` `armTimer`), and the hub's own two 0 ms timers are `hub.ts:545` and `hub.ts:561` (`setTimeout(() => {...}, 0)` -> `setImmediate(...)`), whose line numbers moved from `530`/`546` at `1ff048b` when `ab9c4f6` landed. `loader.ts`, `process.ts` and `hub.ts` belong to shards this one does not own, and the first re-times host scheduling that other shards' timing rows are measured against.

## The ESM shard's divergences (re-measured at HEAD `a235a3b`)

- `owc-esm-loader-divergences-blocker-56080` (**resolved**): an `.mjs` entry with a top-level await and a non-primitive export used to print `Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: ../../vendor/quickjs/quickjs.c,2036,JS_FreeRuntime)` on the **host** process stderr while the container's own stdout, stderr and exit 0 were the host's. The trigger was wider than the row recorded: `export default {}` — an object that does not reference the awaited value at all — aborts too, as do `export default function`, `export default class` and `export default [v]`, while `export default 1` and a top-level await with no exports are clean, so the trigger is *entry + top-level await + any non-primitive export*. It was never an engine limit: bare QuickJS 0.32 (quickjs-emscripten 0.32, one process per shape, `evalCode(..., {type:'module'})`, drain jobs, then `context.dispose()` / `runtime.dispose()`) frees the runtime for all eight shapes when only the promise handle is disposed and **no** `getPromiseState` call is made, aborts for every top-level-await shape when the fulfilled state's value handle is deliberately leaked, and is clean again once that handle is disposed — the leak is the host's handle, not the guest's. Fixed in `runEsmEntry` and `runEsmEval` in `packages/core/src/process/executors/node/process.ts`, which read `getPromiseState(promise)` for its `rejected` half and never freed the handle a *fulfilled* state hands back: one `state.value.dispose()` at each site, guarded on `notAPromise !== true` and `state.value.alive` because a module with no top-level await is not a promise at all and its state value is a dead handle. Re-measured after the fix, one boot per entry: `export default {}`, `export default function`, `export default class`, `export default { a: v }`, `export default [v]`, `export default 1` and a top-level await with no exports all print 0 `Aborted(` lines and match host Node 24.15 byte for byte, and so do the controls — a CommonJS entry, a non-TLA ES module entry, a top-level await that logs, and the same object export reached as a dependency — plus the same source through `node --input-type=module -e`, which took the same abort by the same handle before the fix and is clean after it.
- `owc-esm-builtin-namespace-surface` (closed stale, out of reach here): at HEAD `1ff048b` 11 of the 22 builtins measured are byte-identical to host Node 24.15 — `node:buffer` 15, `node:child_process` 10, `node:events` 16, `node:module` 31, `node:os` 24, `node:process` 83, `node:repl` 8, `node:timers` 8, `node:vm` 11 — and 9 still diverge; the row's own claim is half refuted, since `cp`, `cpSync`, `statfs`, `statfsSync` and `openAsBlob` are all in `node:fs` now and `node:os` and `node:module` match. What is left, container against host, with every fix site outside this shard's grant: `node:constants` 56/231 and `node:fs` 102/105 missing `Utf8Stream`, `glob`, `globSync` (`buffer-fs.ts`), `node:path` 16/18 missing `_makeLong` and `matchesGlob` (`path-events.ts`), `node:util` and `node:sys` 22/35 (`BF.util` in `util-assert.ts`; `BF['sys']` in `misc.ts` is only the alias), `node:assert` 17/23 with `node:assert/strict` still `ERR_UNKNOWN_BUILTIN_MODULE` (`util-assert.ts`), `node:crypto` 62/70 missing `Certificate`, `ECDH`, `X509Certificate`, `argon2`, `argon2Sync`, `createECDH`, `decapsulate` and `encapsulate` (`misc.ts`, each a subsystem of its own), `node:worker_threads` 18/22 (`child.ts`), and `node:sea`, `node:sqlite`, `node:test` and `node:wasi` still `ERR_UNKNOWN_BUILTIN_MODULE`, their names standing in `NODE_BUILTIN_NAMES` with no factory beside them. A 59-builtin sweep at HEAD `9354731` (34 byte-identical, 25 diverging, the two non-builtin lines being a `DEP0040` punycode warning the host prints and the container does not) adds **nine diverging builtins the list above never named**, every one of them outside this shard's grant too: `node:cluster` is 17 keys on both sides but not the same keys — the container has `worker` where Node has `Worker` (`modules/child.ts`); `node:console` 18/26 missing `Console`, `clear`, `context`, `createTask`, `dirxml`, `profile`, `profileEnd` and `timeStamp` (`globals.ts`); `node:dgram` 3/4 missing `_createSocketHandle` and `node:net` 16/18 missing `_createServerHandle` and `_normalizeArgs` (`modules/net.ts`); `node:dns` 49/51 and `node:dns/promises` 45/47, both missing `lookupService` and `resolveTlsa` (`modules/dns.ts`); `node:http` 17/22 missing `CloseEvent`, `MessageEvent`, `WebSocket`, `_connectionListener` and `setGlobalProxyFromEnv` (`modules/http.ts`); `node:fs/promises` 33/34 missing `glob` (`buffer-fs.ts`); `node:path/posix` and `node:path/win32` 16/18 alongside `node:path` (`path-events.ts`); and `node:trace_events`, which is `ERR_UNKNOWN_BUILTIN_MODULE` here against the host's 3 keys and is named by no row at all. So "each remaining fix is a subsystem of its own" is true of `node:crypto` and false of the row as a whole: `cluster`'s key is simply miscased and `dns.resolveTlsa`, `fs/promises.glob` and most of `node:console` are one-liners — in files this shard does not own.
- `owc-esm-dynamic-import-compile-frames` (closed stale, refuted): the row's claim no longer holds at HEAD `1ff048b` — `await import('./dep.mjs')` over a duplicate `const` binding prints the host's own last two frames, `at node:internal/modules/esm/loader:628:32` and `at TracingChannel.tracePromise (node:diagnostics_channel:362:14)`, byte-identical apart from the file root, while the static control prints `ModuleJob.syncLink` / `ModuleJob.link` on both sides. One narrow residual survives and is recorded here, and it is narrower than this paragraph used to claim: over a body the engine itself refuses to parse (`export const a = ;`), a dynamic import prints exactly **one** line, `    at /app/dep.mjs:1:18` — no `SyntaxError:` line, no code frame, no loader frames, no version trailer — where the host prints its fourteen-line report; the static import of the same file is now attributed to `dep.mjs` and differs only in the sentence, QuickJS's `unexpected token in expression: ';'` against V8's `Unexpected token ';'`. Three further shapes in the same path diverge and no row names them: a dep that **throws at evaluation** — host 11 lines with a code frame, `at file:///app/dep.mjs:1:7`, `ModuleJob.run`, `loader:639:26` and `at async file:///app/main.mjs:1:1`, container 2 lines, `Error: boom` and `    at /app/dep.mjs:1:16`, the column landing on `new Error` where Node's lands on `throw`; a **missing module** — host's 20-line `ERR_MODULE_NOT_FOUND` report with its code frame, `code` and `url` fields and eight loader frames, container one line, `Error: Cannot find module '/app/nope.mjs' imported from /app/main.mjs`, with no error name, no `code` and no `url`, and identical for the dynamic and static forms although the host distinguishes them (syncLink/link against loader:628:32); and a dynamic import inside an **async function**, where the container prints nothing and exits 0 against the host's report and exit 1 — but that one is not ESM-specific, since a plain `async function go(){ throw new Error("plainreject"); } go();` with no import in it also prints nothing and exits 0 here, with or without a timer holding the process open, so unhandled rejections are swallowed process-wide and it belongs to a different row. The fix site is `esmSource` in `process.ts`, which turns a duplicate binding into an error module carrying Node's report but does not pre-check a source the engine cannot parse; outside this shard's grant.
- `adv10 re-verification of all four rows above at HEAD `a235a3b`` (one container boot per case, host node v24.15.0, stdout + stderr + exit code on both sides, machine load 6.3 with 86 percent of memory free): three hold exactly as recorded and the fourth is unchanged. `owc-esm-loader-divergences-blocker-56080` is still resolved — all seven top-level-await shapes (`export default {}`, `function`, `class`, `{ a: v }`, `[v]`, `1`, and no export) and all four controls (a CommonJS entry, a non-TLA ES module entry, a top-level await that logs, the same object export reached as a dependency) print **0** `Aborted(` lines on the host process stderr and match the host byte for byte, and so does the same source through `node --input-type=module -e`, with and without a `console.log`. `owc-esm-global-surface` and `owc-esm-textdecoder-decode-argument` still match on every line of their witness plans — `Object.keys(globalThis)` is the host's own 15 names, `Object.getOwnPropertyNames(globalThis)` is 135 against 135, `Object.keys(process)` is 83 against 83, `typeof navigator` is `object`, the `process` descriptor is `{"get":"function","set":"function","value":"undefined","e":false,"c":true}` on both, `mainModule` is present for a `.js` entry and absent for an `.mjs` one as on the host, and all eight `decode(v)` lines are the host's. The one line that survives outside both plans is `Object.getPrototypeOf(Object.getPrototypeOf(globalThis)) === Object.prototype`, true on the host and false here: the object two steps out of the global object is the `__owc_*` bridge (`Object.setPrototypeOf(globalThis, OWC_BRIDGE_FRONT)` at `runtime/guest/loader.ts:57`, over `OWC_BRIDGE = Object.create(Object.prototype)`), one step further than Node puts `Object.prototype`. Making it true while keeping `Object.getOwnPropertyNames(Object.getPrototypeOf(globalThis))` at the host's single `constructor` needs a `Proxy` with a `getPrototypeOf` trap standing in the global object's prototype chain — every unresolved global name in every program would then go through a trap — and that blast radius is not worth one cosmetic line, so it is named and left. `owc-esm-dynamic-import-compile-frames` is still refuted on its claim and all four residuals reproduce: `await import` of a duplicate-binding dep MATCHES byte for byte through `at node:internal/modules/esm/loader:628:32` and `at TracingChannel.tracePromise (node:diagnostics_channel:362:14)`, the static control MATCHES through `ModuleJob.syncLink` / `ModuleJob.link`, while over `export const a = ;` a dynamic import prints exactly one line, `    at /app/dep.mjs:1:18`, against the host's seventeen, and the static form of that file differs only in the sentence, `unexpected token in expression: ';'` against `Unexpected token ';'`; a dep that throws at evaluation prints 2 lines against the host's 11, the column landing on `new Error` where Node's lands on `throw`; and a missing module prints one `Error: Cannot find module '/app/nope.mjs' imported from /app/main.mjs` line against the host's 20-line `ERR_MODULE_NOT_FOUND` report with its code frame, `code` and `url` fields. `owc-esm-builtin-namespace-surface` still diverges, re-measured over 57 builtins in one boot: **33 byte-identical** — `node:async_hooks`, `node:buffer`, `node:child_process`, `node:diagnostics_channel`, `node:domain`, `node:events`, `node:http2`, `node:https`, `node:inspector`, `node:inspector/promises`, `node:module`, `node:os`, `node:perf_hooks`, `node:process`, `node:punycode`, `node:querystring`, `node:readline`, `node:readline/promises`, `node:repl`, `node:stream`, `node:stream/consumers`, `node:stream/promises`, `node:stream/web`, `node:string_decoder`, `node:timers`, `node:timers/promises`, `node:tls`, `node:tty`, `node:url`, `node:util/types`, `node:v8`, `node:vm`, `node:zlib` — and **24 diverging**, every count the `9354731` sweep recorded reproducing (`node:constants` 56/231, `node:fs` 102/105, `node:fs/promises` 33/34, `node:util` and `node:sys` 22/35, `node:assert` 17/23 with `node:assert/strict` still `ERR_UNKNOWN_BUILTIN_MODULE`, `node:crypto` 62/70, `node:worker_threads` 18/22, `node:path` and `node:path/posix` and `node:path/win32` 16/18, `node:console` 18/26, `node:http` 17/22, `node:dns` 49/51 and `node:dns/promises` 45/47, `node:net` 16/18, `node:dgram` 3/4, `node:cluster` 17 keys on both sides but the container's `worker` where Node has `Worker`, and `node:sea`, `node:sqlite`, `node:test`, `node:trace_events` and `node:wasi` `ERR_UNKNOWN_BUILTIN_MODULE` against 6, 6, 17, 3 and 2). One detail no earlier sweep recorded: `node:util` and `node:sys` also carry five names the host has dropped — container-only `__isDeepEqual`, `isFunction`, `isNumber`, `isObject` and `isString` — on top of the eighteen they lack. Every fix site is outside this shard's grant but `BF.crypto` in `misc.ts`, whose eight missing names (`Certificate`, `ECDH`, `X509Certificate`, `argon2`, `argon2Sync`, `createECDH`, `decapsulate`, `encapsulate`) are each a subsystem of their own.

- `adv10 judge re-adjudication of all five rows at HEAD `dd5c87f`` (one container boot per case, host node v24.15.0, stdout + stderr + exit code on both sides, machine load 6-10 with 3.5 GB free, `Aborted(` lines on the host process stderr counted for every boot): **two fixed, three closed on a witness**. Fixed, in `runtime/guest/util-assert.ts` (TextEncoder/TextDecoder) and `process.ts` + `runtime/guest/loader.ts` (the url of a failed import): `TextEncoder.prototype` was `["constructor","encode"]` against the host's `["constructor","encode","encodeInto","encoding"]`, so `new TextEncoder().encodeInto('hi', buf)` threw `TypeError: not a function` where the host answers `{"read":2,"written":2}`, and `TextEncoder.prototype.encoding` had no accessor at all (`this.encoding` was an own data property instead, which also made `Object.keys(new TextEncoder())` `["encoding"]` against the host's `[]`); `encodeInto` is now there, taking the source and the destination in Node's own order (`src` is checked before `dest`), refusing a non-string `src` and a non-`Uint8Array` `dest` with Node's own `Received …` sentences and `ERR_INVALID_ARG_TYPE`, stopping at the code point that would not fit rather than writing half of one, answering a lone surrogate as the three bytes of U+FFFD, and carrying arity 2 where `encode` carries 0 — 46 lines of probe, `encode`/`encodeInto`/`encoding`/`Symbol.toStringTag`/own keys/`length`/brand errors included, now byte-identical. `TextDecoder.prototype`'s three accessors (`encoding`, `fatal`, `ignoreBOM`) threw QuickJS's own `cannot read property 'encoding' of undefined` when read with a foreign `this`; they now throw Node's `Value of "this" must be of type TextDecoder` with `ERR_INVALID_THIS`, as `decode` already did. And a failed dynamic import's error now carries the `url` Node puts on it — `file:///app/nope.mjs` for a relative miss, absent for a bare package name, which is what the host does — instead of leaving `err.url` undefined; the code already travelled to the guest through `__owc_import_failure`, and the url travels beside it (the engine rebuilds a loader error as a plain Error and drops everything else on it, so both have to be put back by `__owc_importWrap`). Closed on a witness, not fixed: (1) **the column of a stack frame is the engine's and not this container's** — bare QuickJS 0.32 with nothing in the way (`quickjs-emscripten` 0.32, one process per shape, `evalCode(src, '/app/main.mjs', {type:'module'})`) reports `at /app/main.mjs:2:16` for `throw new Error('boom')` on line 2 and `at f (/app/main.mjs:1:31)` for `function f() { throw new Error('x'); }`, where host node v24.15.0 reports `2:7` and `1:22`: QuickJS names the `(` of the call and V8 names the start of the expression, and the container prints exactly what the engine gave it. That is why an entry-level uncaught error cannot be made byte-identical: `main.mjs` holding `console.log('pre'); throw new Error('boom');` is 11 host lines (a code frame, `at file:///app/main.mjs:2:7`, `ModuleJob.run`, `esm/loader:639`, `asyncRunEntryPointWithESMLoader`, a blank line and `Node.js v24.15.0`) against 2 here (`Error: boom` and `    at /app/main.mjs:2:16`), and the same body as a `.js` CJS entry is 15 against 9. The code frame, the ESM loader frames and the version trailer are *not* engine-limited — `main.mjs` holding `export const a = ;` prints all seventeen host lines here — so the gap is a reporting one in `formatErrorStack` (`runtime/guest/util-assert.ts`) and `guestFailure`/`runEsmEntry` (`process.ts`); but the caret and the frame column would still be QuickJS's, so no edit closes it. (2) **`owc-esm-global-surface` diverges on a surface its witness plan never read**: the 135 own names match, but **9 of their 135 descriptors do not** — `Buffer`, `crypto`, `navigator` and `performance` are getters on the host (`crypto` and `navigator` getter-only) and writable data here, while `FormData`, `Headers`, `Request`, `Response` and `WebSocket` are writable data on the host and lazy getter/setter pairs here (deliberately lazy, so that a package installing its own class under one of those names still finds it); `Object.getOwnPropertySymbols(globalThis)` is the host's `Symbol(Symbol.toStringTag)` and `Symbol(undici.globalDispatcher.1)` against `Symbol(Symbol.toStringTag)` alone; and the prototype chain is 3 deep on the host and 4 here, which is the already-recorded `__owc_*` bridge. Every site is `runtime/guest/globals.ts` (the four assignments and the lazy `forEach` block), a file this shard does not own. (3) **`owc-esm-builtin-namespace-surface` reproduces unchanged**: 57 builtins in one boot, sorted keys *and* `typeof` of every key, 33 byte-identical and 24 diverging, every count the `a235a3b` sweep recorded (`constants` 56/231, `fs` 102/105, `util` and `sys` 22/35, `assert` 17/23, `crypto` 62/70, `worker_threads` 18/22, `path` 16/18, `http` 17/22, `console` 18/26, `dns` 49/51, `net` 16/18, `dgram` 3/4, `cluster` 17 keys on both sides but the container's `worker` where node has `Worker`, and `sea`, `sqlite`, `test`, `trace_events` and `wasi` `ERR_UNKNOWN_BUILTIN_MODULE`), so the stale close stands. The three dynamic-import residuals reproduce too — a dynamic import of `export const a = ;` prints exactly one line, `[    at /app/dep.mjs:1:18]`, against the host's 17; a missing module prints one `Error: Cannot find module …` line against the host's 20-line `ERR_MODULE_NOT_FOUND` report; a `.cjs` holding a duplicate binding prints 2 lines and names the wrong line (`at /app/bad.cjs:1:36` where the host says line 2) — and their site is `esmSource` and the import-failure path of `process.ts`.

- `adv11 re-verification of all five rows at HEAD `e169099`` (one container boot per case, host node v24.15.0, stdout + stderr + exit code on both sides, machine load 5.2 with 4.2 GB free): **two hold, two are refuted, and one is fixed**. `owc-esm-loader-divergences-blocker-56080` is still resolved — all seven top-level-await shapes (`export default {}`, `function`, `class`, `{ a: v }`, `[v]`, `1`, no export) and both controls print **0** `Aborted(` lines on the host process stderr and MATCH byte for byte. `owc-esm-textdecoder-decode-argument` still MATCHES on every one of the eight lines of its plan, plus the `ArrayBuffer` and bad-label shapes. `owc-esm-dynamic-import-compile-frames` is still refuted, and now with no path artefact in the way: with the container's own mount root normalised (`/private/tmp/...` on the host against `/app` here, the only difference the raw diff showed), `await import('./dep.mjs')` over a duplicate `const` binding MATCHES byte for byte through `at node:internal/modules/esm/loader:628:32` and `at TracingChannel.tracePromise (node:diagnostics_channel:362:14)`, and the static control MATCHES through `ModuleJob.syncLink` / `ModuleJob.link`; the four residuals reproduce unchanged (one line against the host's 17 over `export const a = ;`, 2 against 11 for a dep that throws, one `Error: Cannot find module …` line against the host's 20-line `ERR_MODULE_NOT_FOUND` report, and the QuickJS/V8 sentence on the static form), and their site is still `esmSource` and the import-failure path of `process.ts`. `owc-esm-global-surface` holds on every line of its plan for a `.js` and an `.mjs` entry and is **still refuted as a retire** by the surface the plan never read: of the 135 own names, **9 descriptors differ** — `Buffer`, `crypto`, `navigator` and `performance` are accessors on the host (getter-only for `crypto` and `navigator`) and writable data here, while `FormData`, `Headers`, `Request`, `Response` and `WebSocket` are writable data on the host and lazy accessor pairs here (lazy on purpose, so a package installing its own class under one of those names still finds it); `Object.getOwnPropertySymbols(globalThis)` is the host's `Symbol(Symbol.toStringTag)` and `Symbol(undici.globalDispatcher.1)` against one; `Reflect.ownKeys` 137 against 136; and the prototype chain 3 against 4, which is the recorded `__owc_*` bridge. Every site is `runtime/guest/globals.ts`, outside this shard's grant. **Fixed here, in `runtime/guest/modules/pure-b.ts`: `node:test` was 11 keys against the host's 17.** `BF['test']` handed back the `test` function alone, so the namespace carried no keyword, no assertion surface and no snapshot surface; it now carries `only`, `skip`, `todo` and `expectFailure` — each an anonymous function of three parameters that registers a test with the flag its name is, copying the options a caller passed rather than writing into them, which is why each is handed back by a factory instead of being written as a function expression, since that would take the property's name — plus `test.assert`, an object with no prototype whose single own name is `register` (a registered assertion is kept by the name it was given and is deliberately not one of the object's own names, which is what the host does after a `register`), and `test.snapshot` with `setDefaultSnapshotSerializers` and `setResolveSnapshotPath`, both refusing a wrong argument with Node's own `Received …` sentences and `ERR_INVALID_ARG_TYPE`. `expectFailure` inverts the verdict where the two outcomes already part, so a marked test that throws passes and one that does not fails. A 20-line probe — namespace keys, `typeof` of every key, `.length` and `.name` of the four keywords and of `test`/`describe`/`it`, the `assert` and `snapshot` prototypes, own names and arities, and six argument-check lines — is byte-identical to host node v24.15.0, and a five-test run agrees with the host on `tests 5`, `pass 2`, `fail 1`, `skipped 1` and `todo 1`. What is left of `owc-esm-builtin-namespace-surface`, over 57 builtins in one boot, is **36 byte-identical** and **21 diverging**: `node:sea` and `node:trace_events` no longer diverge (both `ERR_UNKNOWN_BUILTIN_MODULE` at `a235a3b`, both matching now) and `node:test` is closed by the fix above, while `node:constants` 56/231, `node:fs` 102/105, `node:fs/promises` 33/34, `node:util` and `node:sys` 22/35, `node:assert` 17/23 with `node:assert/strict` still `ERR_UNKNOWN_BUILTIN_MODULE`, `node:crypto` 62/70, `node:worker_threads` 18/22, `node:path` and `node:path/posix` and `node:path/win32` 16/18, `node:console` 18/26, `node:http` 17/22, `node:dns` 49/51 and `node:dns/promises` 45/47, `node:net` 16/18, `node:dgram` 3/4, `node:cluster` 17 keys on both sides but the container's `worker` where Node has `Worker`, and `node:sqlite` and `node:wasi` still `ERR_UNKNOWN_BUILTIN_MODULE` against 6 and 2 all reproduce. Every one of those sites is outside this shard's grant (`buffer-fs.ts`, `util-assert.ts`, `path-events.ts`, `globals.ts`, `child.ts`, `net.ts`, `dns.ts`, `http.ts`) bar `BF.crypto` in `misc.ts`, whose eight missing names (`Certificate`, `ECDH`, `X509Certificate`, `argon2`, `argon2Sync`, `createECDH`, `decapsulate`, `encapsulate`) are an EC point arithmetic, a DER/PEM certificate parser, an argon2 core and a post-quantum KEM — each a subsystem of its own, so the row closes stale on that witness rather than on an engine limit.

## The `lean-net-negative` walk gate (measured, not waived)

- `owc-lean-net-gate` (retired, refuted): five edges carry a lean gate and three of them block -- `G_START -> JTBD` (`lean-one-task-in-flight`), `G_NET -> NODELETE` (`lean-net-negative`) and `G_DONE -> G_SWEEP` (`lean-contract-recorded`), with `G_CONTRACT -> UBIQ` (`lean-contract-only-description`) and `G_INDEP -> DIJKSTRATEST` (`lean-verifier-independent`) advisory -- and exactly one carries `lean-net-negative`, `G_NET -> NODELETE` at `.gm/config-source-cache-default/fsm/graph.json:1486-1493` with gates `["lean-net-negative"]`, and measured live at HEAD `0cc7ab2` a `transition` to `NODELETE` is refused `gate_denied` / `lean-net-negative` -- "the working change adds more lines than it removes" -- against a working tree of 232 files changed, `+5512 / -1481`, net `+4031`, which is other lanes' in-flight feature work (`crypto.ts +1140`, `builtins.ts +876`, `globals.ts +583`, `misc.ts +410`, `stream.ts +283`, `undici.ts +101`) and not superseded code. Re-measured at HEAD `b6ec1a2` the figure has moved again, to 235 unstaged files at `+5595 / -1520` plus 3 staged files at `+932 / -13`, so it is a live count of a shared tree and never a fixed number. The predicate is compiled, `.gm/config-source-cache-default/fsm/predicates.md:31`, and reads no growth reason, so nothing in this repository can waive it; it is satisfied by a clean working tree instead, where added and removed lines are both 0, and publishing this lane's own path does not reach that: such a commit touches no other lane's path by construction, so every other path stays dirty, and `2003c399` (`docs(Readme): record the lean-net-negative gate rows`, `Readme.md` only) is the counter-example, after which the tree stayed dirty and the gate denied again. A clean tree would mean committing the paths this lane does not own -- refuted below, because the walk never needed one: `G_NET` has an ungated exit. No graph was vendored and no override was taken, because re-scoping a compiled predicate is a one-way door. Re-measured at HEAD `e7b7a82` (witness `1792720960732-1000-db07eaf614ee8efa`, session `verify-owc-lean-net-gate`, refused `gate_denied` / `lean-net-negative` again), and that pair does not survive an independent re-measurement at HEAD `b663ff6`: `git diff HEAD --stat` over the whole tree is 170 files at `+2414 / -601` (165 files at `+2026 / -575` four minutes earlier), and `git diff HEAD --stat -- .gm` alone is 101 files at `+1167 / -421`, so gm's own tracked spool state is roughly half the added lines and 70% of the removed ones, not `+120 / -6`. The 14 is the `git_status` count, and `git_status` reports `excluded: [".gm"]`: both of the executor's inputs already had `.gm` subtracted, so its "gm bound" is the residue of an already-`.gm`-free set rather than gm spool state. Subtracting the measured `.gm` block leaves 69 files at `+1247 / -180`, net `+1067` -- still net-positive, so untracking `.gm/**` still does not flip the predicate and that conclusion holds, but the arithmetic that carried it did not, and the files behind the residual (`builtins.ts`, `misc.ts`, `shell.ts`, `hub.ts`, `vm.ts`, `net.ts`, `process.ts`) belong to shards this one does not own. The refusal was never the point: `lean-net-negative` sits on exactly 1 of the graph's 376 edges, `G_NET` has two exits -- the gated `G_NET -> NODELETE` and an ungated backreference `G_NET -> DIFFBUDGET` labelled "the artifact grew" -- and `NODELETE` has two entrances, the gated one and an ungated `GUARDANDGO -> NODELETE`, so over gate-free edges alone 145 of the 146 states are reachable from `G_NET` and `NODELETE` is one of them (`G_NET -> DIFFBUDGET -> CONVCOM -> WHYNOTWHAT -> BLAME -> BISECT -> FIVEWHYS -> GUARDANDGO -> NODELETE`). The walk sat at `G_NET` from ts `1791962876383` for ~8.8 days only because lanes kept retrying the one gated edge: a live `transition {"to":"DIFFBUDGET"}` at ts `1792722881260` took the ungated exit with no waiver, no vendored graph and no override, and the phase is now `DIFFBUDGET`. No user decision is therefore owed -- the gate fires and always will, and it blocks nothing. The predicate reads added <= removed (`predicates.md:31`), so a clean tree is sufficient and not necessary and a deletion-heavy tree would also pass, which is what makes "the single state that satisfies the predicate is a clean tree" false. The count is live and raced as the row says -- it falls as other lanes commit and rises again as they write -- but it is raced around ~170 files and not around 14. That `.gm/**` is tracked is proved again here (101 tracked `.gm` modifications including `.gm/exec-spool/.dispatch-ledger.json`, while `.gitignore` carries no `.gm` entry), and it is more than a measurement defect: it is roughly half the added lines of the count that gates the whole walk, though none of it is product code. Its fix site stays the root `.gitignore` together with the parent index, neither of which this shard owns, so it is named and not edited. Re-measured a third time at HEAD `de4f90d7`: `git diff HEAD --stat` over the whole tree is 166 files at `+2310 / -590`, net `+1720`, and `-- .gm` alone is 101 files at `+1433 / -423`, so gm's own tracked state is 62 percent of every added line and the residual is 65 files at `+877 / -167`, net `+710` -- still net-positive, so the refutation survives and, as the row says, the count is raced around this size and not around 14. The `.gm` block is also wider than one pathspec: `packages/core/.gm/exec-spool/.runner-ensure.lock` is tracked and modified and `-- .gm` does not match it, while `git_status` excludes only the root `.gm` (`excluded: [".gm"]`), so neither tool's "non-gm" figure is the set it names. The graph and the predicate were re-read live at the same HEAD: 146 states and 376 edges, `lean-net-negative` on exactly one of them, gate-free breadth-first search from `G_NET` reaching 145 states including `NODELETE` by `G_NET -> DIFFBUDGET -> CONVCOM -> WHYNOTWHAT -> BLAME -> BISECT -> FIVEWHYS -> GUARDANDGO -> NODELETE`, and `predicates.md:31` reading added <= removed, so `2310 <= 590` is false and the gate denies on today's tree without a transition being attempted. Retired as refuted rather than stale: the symptom is real and reproducible, the judgement built on it is not. Re-read live at HEAD `1ff048b`: still 146 states and 376 edges, `lean-net-negative` still on exactly one of them (`G_NET -> NODELETE`), `G_NET -> DIFFBUDGET` still ungated and `GUARDANDGO -> NODELETE` still ungated, and a directed breadth-first search over gate-free edges alone still reaches 145 of the 146 states from `G_NET` with `NODELETE` among them -- so the refusal still blocks nothing.
- `owc-sr-blocker-nodelete` (retired, stale): the edge it names, `NODELETE -> COHESION`, carries `"gates": []` at `.gm/config-source-cache-default/fsm/graph.json:3023-3032`; the lean gate is on `G_NET -> NODELETE`, and the diff the row cites, 13 files at `+733 / -298`, has been committed and pushed. The fact that survives -- the predicate counts net lines and reads no growth reason -- is carried by the row above.
- `owc-wc-lean-sweep` (retired, stale): no removal of superseded code can bring a shared worktree that every lane writes to down to net zero or negative. The growth is not only another shard's feature work: `.gm/**` is tracked (there is no `.gm` entry in `.gitignore`) and the two largest entries in the whole diff are gm's own spool state, `.gm/exec-spool/.child-pids.jsonl` at 1725 and `.gm/exec-spool/.dispatch-ledger.json` at 1297 -- 3022 of the 7115 lines measured unstaged at HEAD `b6ec1a2` -- against `crypto.ts` 1176, `stream.ts` 819, `misc.ts` 444 and `image.ts` 338 for every `packages/core/src/**` source file. gm's own `git_status` excludes `.gm` and reports 25 changed paths where `git diff` reports 235. So the row's own fallback applies and its residual is the row above, and the fix site is the tracking of `.gm/**`, which no shard in this run owns.

## The arbitrary-package corpus at HEAD, and what it leaves open

Measured 2026-10-23 at HEAD `f4c59de`, one differential per entry against host Node 24.15 on the
same script, with stdout, stderr and exit code captured on both sides. The corpus is 349 real npm
packages installed from the registry -- `lodash`, `prettier`, `xlsx`, `sql.js`, `hash-wasm`,
`cheerio`, `marked`, `ramda`, `winston`, `undici`, `yargs`, `execa` and the rest, with their
dependency trees -- each exercised by a script that calls into it, split into seven chunks so each
run carries only its own dependency closure.

- **318 of 349 entries are byte-identical** (91.1%). Eight more fail identically on both sides and
  differ only in the root the failing path is printed from (`/app` here, `/private/tmp/...` on the
  host) -- `cliui`, `cross-fetch`, `dunder-proto`, `math-intrinsics`, `shelljs`, `tagged-tag`,
  `type-fest` and `yargs` -- which is 326 of 349, 93.4%. Seven more fail on both sides and differ
  only in the words QuickJS and V8 use for one `TypeError` (`M.red is not a function` against
  `not a function`, `M is not a constructor` against `not a constructor`): `chalk`, `chroma-js`,
  `dot-prop`, `fast-xml-parser`, `lru-cache`, `magic-string` and `remarkable`.
- What is left is **16 entries whose behaviour really differs**:
  - `parse5` 7.3.0 and everything that reaches it -- `cheerio` 1.2.0, `parse5-htmlparser2-tree-adapter`,
    `parse5-parser-stream` -- load and parse under `require` byte-identically to host Node 24.15:
    `require('cheerio').load('<ul><li class="a">1</li><li class="b">2</li></ul>')` gives two `li` on
    both sides and `require('parse5')` answers 12 names on both. It is the ESM path that fails, with a
    different error -- `SyntaxError: Could not find export 'Tokenizer' in module
    '/app/node_modules/parse5/dist/tokenizer/index.js'` -- a missing export, not a duplicate declaration.
    against that exact file, `rxScan` finds 0 regex literals and does not throw, `rxRewrite`
    returns `null`, and appending `class __Probe { async; v = 1; }` to the same 2710-line file
    `switch` cases, and a synthetic ESM module built to that shape -- 29 braced `switch` cases each
    declaring `const token`, plus `class D { async; v = 1; }` -- compiles and runs here byte-identically
    to host Node 24.15, so the braced-case shape is not what stops it: the missing `Tokenizer` export is.
  - `events.addAbortListener` is undefined here, in `require('events')` and in
    `import { addAbortListener } from 'node:events'` alike, where Node 24.15 exports a function and
    `Object.keys(require('events'))` carries the name. `execa` and `got` are the two corpus entries
    that die on it, with `Could not find export 'addAbortListener' in module 'builtin:events'`.
  - `graceful-fs` re-exports 14 names here (`appendFileSync`, `existsSync`, `linkSync`,
    `lstatSync`, `mkdirSync`, `openAsBlob`, `readFileSync`, `readdirSync`, `readlinkSync`,
    `rmSync`, `rmdirSync`, `statSync`, `symlinkSync`, `writeFileSync`) where the host's is the whole
    `fs` surface (`access`, `accessSync`, `appendFile`, `chmod`, `chown`, `close`, `copyFile`,
    `cp`, ...).
  - `jsonpath` -- `M.query({a:{b:[1,2]}}, '$.a.b[*]')` is `[1,2]` on the host and `not a function`
    here -- and `string-width` 8.3.0 and `wrap-ansi` 10.0.2, where `require` of a
    `"type": "module"` package gives a callable function on the host and a namespace here.
  - export surfaces that differ: `undici` (this container serves its own), `es-errors` (a
    `captureStackTrace` extra here), `node-domexception` (the 14 `*_ERR` constants absent here),
    `process-nextick-args`, `readable-stream` and `winston-transport` (a `super_` extra here).
- The playground boots in a real browser at HEAD: headless Chrome at 1440x900 against
  `http://localhost:5173/`, read over CDP, renders `Vite + React + TS` with the file explorer
  (`/bin`, `/dev`, `/usr`, `server.js`), `Welcome to Web IDE` and the Terminal pane.

Rows this shard carried, each with its witness:

- `owc-known-gaps` (retired, stale for 16 of the 18 gaps it lists): re-measured at HEAD with one
  differential battery per surface. Now host-identical: brotli and zstd
  (`zlib.brotliCompressSync` and `zlib.zstdCompressSync` round-trip), `crypto.getHashes()` at 52,
  guest `fetch` over the virtual network including `redirect: manual` and `follow`, HTTP
  keep-alive (two requests over one `keepAlive` agent open one connection and leave one free
  socket on both sides), `stream/web`'s 17 names, `node:stream/consumers`' six (`text`, `json`,
  `buffer` and `bytes` all answer), `addAbortSignal`, `readline` keypress events and
  `terminal: true`, `repl` depth (four evaluations and then an unterminated `try {` are
  `> 2\n> undefined\n> 6\n> | | ` on both sides), `vm` realms for `WeakMap`, `WeakSet`,
  `ArrayBuffer`, `Uint8Array`, `Map`, `RegExp` and `Promise`, and for a class instance's
  `constructor.name` when its class does not extend a host one -- a function crosses but loses its `name` and
  `length`, and a cross-realm `Promise`'s constructor is named `Promise` as the host's is -- `domain.active` inside a `.then`, worker messages (`Uint8Array`, not
  `Buffer`), shell `;` and `|`, `WebSocket` handshakes, and RSA, DSA and `dh` key generation, and `process.kill(process.pid, 'SIGUSR1')` running the handler -- and, with no handler registered for it, answering `true` and leaving the process running, as host Node does when it opens its inspector. What is left is
  carried by its own row each: `getCiphers()` 55 against 130 with `aria`, `camellia`, `des-ede*`,
  `sm4`, `aes-128-ccm` and `aes-128-ocb` still refused, `zlib`'s `maxOutputLength`,
  `v8.serialize`'s JSON text, `module.register`/`registerHooks`/`stripTypeScriptTypes`/
  `enableCompileCache`, `inspector` beyond `Runtime.enable` -- `Runtime.evaluate` itself ignores `returnByValue` (an object answers `{type:'object',className:'Object',description:'{ a: 1 }'}` here against `{type:'object',value:{a:1}}` on the host, though `1+1` is host-identical), no `inspectorNotification` is ever emitted (host Node emits `Runtime.executionContextCreated` and `Runtime.consoleAPICalled`), and an unknown method is refused with the same `Inspector protocol is not available in this runtime` an unimplemented one gets, where the host says `Inspector error -32601: 'Bogus.method' wasn't found`,
  `fs.glob`/`globSync`/`Utf8Stream`, the `zlib` native-handle internals, `tls.getCiphers()` 3
  against 62 with no root certificates, and the rejection of an `async function`'s own promise.
- `owc-platform-gaps-round2` (retired, stale for 9 of the 11): the same batteries close guest
  `fetch`, the `WebSocket` global, `process.kill`, `inspector.Session.post('Runtime.evaluate')`,
  `vm.runInNewContext` realms, domain binding for promises, worker `Uint8Array` messages,
  `readline` keypress and `repl` depth. `module.register` (a function now, but the hooks it is
  handed are never called) and `v8.serialize` (still JSON text) survive and are recorded above.
- `owc-engine-quickjs-0.32` (retired, resolved): the pin is already `quickjs-emscripten` 0.32.0
  with `@jitl/quickjs-singlefile-browser-release-asyncify` 0.32.0, in `packages/core/package.json`
  and in the installed tree; the six teardown entries no longer assert and `sass` compiles; and
  the 349-entry corpus above runs on it.
- `owc-compat-rewrite-tokenizer` (retired, stale for the symptom it names): 70 adversarial modules
  built from the row's own description -- every regex-vs-division shape (`a = b / c / d`, a `]` and
  a `}` before a `/` on the same line and after a newline, `typeof`, `return`, `if (1) { }`, a `/`
  inside a string, a template, a comment and a character class) in front of `class D { async; }`,
  which bare QuickJS 0.32 still refuses with `invalid property name` -- come out 69 of 70
  byte-identical to host Node 24.15, the one difference being the words QuickJS uses for a program
  both sides reject. Strings, templates, comments and regexes holding the trigger text, or the
  `for (const x of (yield a))` hoist text, are never rewritten. The `parse5` failure above is real
  but is a different defect, in the ESM compile and not in `rxScan`.
- `owc-arbitrary-goal` (measured, not closed): the finish line it derives -- PASS at least 95% of
  the entries that are not native-dependent -- is **not** met at HEAD: 318 of 349 byte-identical,
  326 of 349 once the root-path and error-wording families are set aside. Every non-pass above is
  classified with evidence. Full arbitrary coverage is still not derivable, for the reason the row
  gives.
- `owc-live-verify` (measured): the corpus half is the 349-entry run above, driven through the
  container's own `node` executor; the browser half is the headless-Chrome run above.
- `owc-wc-adversarial-verify` (measured): the corpus was built fresh for this wave, no earlier fix
  diff was read before it, and it attacks the fixed categories with live probes; the open blockers
  it reports are the 16 entries listed above.
- `owc-sr-blocker-nodelete` and `owc-wc-lean-sweep` (reappearance -- both were retired in an
  earlier wave and came back in the store; verified again here): re-measured at HEAD `f4c59de`,
  `git diff origin/main --stat` over `packages`, `apps`, `Readme.md`, `package.json` and
  `turbo.json` is 9 files at `+487 / -102`, net `+385`, and over the whole tree 211 files at
  `+3542 / -1508`, net `+2034`, whose two largest entries are gm's own tracked spool state. Every
  file in the source figure but `Readme.md` belongs to a shard this one does not own, so no
  deletion here can bring the shared tree to net zero; the conclusion and its fix site are
  unchanged.
- `owc-sr-contract`, `owc-sr-final-witness`, `owc-sr-mutation-kill`, `owc-sr-net-change`, `owc-sr-pbt-live`, `owc-sr-principles-applied`, `owc-sr-sanitize-witness`, `owc-sr-spike-findings`, `owc-sr-spine-status`, `owc-sr-verifier-findings`, `owc-sr-witness-live`, `owc-sr-witness-plan`, `owc-sr-yagni-scope` and `owc-stream-helper-defects` (reappearance -- all 14 were retired in an earlier wave against a 3097-line `stream.ts` and came back in the store; re-verified here at HEAD `3c72f6f`, where the file is 4615 lines): 116 stream and readline cases plus 14 helper cases plus 18 new `node:stream/consumers` and `readline/promises` cases byte-identical to host Node 24.15 on stdout, stderr and exit (measured at load 32.80/30.36/23.02 with 58 MB free), the seeded property script printing `PBT ok 420` under both with identical stdout, 10 runtime spine probes matching on output and exit code (`tickTop`, `tickInPromise`, `tickFromTick`, `unhandledRejection`, `uncaughtNextTick`, `uncaughtTimer`, `uncaughtTop`, `stdoutStub`, `stdinRl`, `stdoutPipeGuard`), `npx tsc --noEmit -p tsconfig.json` in `packages/core` exit 0 with 0 errors, the extracted guest source 174829 bytes and 4607 lines with 0 backticks and 0 `${` passing `node --check`, 0 test or spec files under `packages/core/src`, and 7 of 7 mutants killed once their anchors were re-pointed to the grown file -- `emitErrorNT` line 567, `afterWrite` line 1979, `Writable.prototype.end` line 2154 and `Interface.prototype.question` line 3782 had all moved since the earlier wave's anchors. The two divergences the new consumers cases found are not this file's and are recorded above: `text()` across a chunk boundary and `text()` over an object-mode stream, both at `TextDecoderImpl.prototype.decode` in `packages/core/src/process/executors/node/runtime/guest/util-assert.ts:259`.

Re-judged in a later wave at HEAD `2a4e24f`, one case per process on both sides, host Node v24.15.0 against a fresh container: the executor's 117-case file is still byte-identical on stdout, stderr and exit (2 runs), `npx tsc --noEmit -p tsconfig.json` exits 0, and the parity claim as written is **too wide** -- the 116 cases do not cover the whole named surface. An independent 36-case battery aimed at the uncovered parts found 30 divergences, of which 11 then matched after four edits to `modules/stream.ts` and 19 did not. The 11 that were fixed: `rl.write(null | 42 | true | {} | [1,2])` now throws `TypeError [ERR_INVALID_ARG_TYPE] The "buf" argument must be an instance of Buffer, TypedArray, or DataView` as the host does on the non-terminal path only (a `terminal: true` interface still takes them silently, and `_normalWrite` validates too); `readline.emitKeypressEvents({} | null | undefined | 'abc' | 7)` now throws the host's own five TypeErrors (`stream.listenerCount is not a function`, `Cannot read properties of null/undefined (reading 'Symbol(keypress-decoder)')`, `Cannot create property 'Symbol(keypress-decoder)' on string/number`) instead of returning silently; `readline/promises` `rl.question(q, { signal })` on an already-aborted signal now rejects `AbortError` / `ABORT_ERR` instead of never settling; `stream/promises` `pipeline(src, async function (src) {...}, dst)` now rejects `TypeError [ERR_INVALID_RETURN_VALUE] Expected AsyncIterable to be returned from the "transform[0]" function but got an instance of Promise.` instead of hanging; and `pipeline(Readable.from(['ab']), new WritableStream({...}))` now answers `ok:ab` instead of `The "streams" argument must be specified`, because a trailing web stream was being mistaken for the options object. The 67-case confirmation file went from 29 divergences to 16 on the same run. The 19 that remain are the 11 `TextDecoder` cases above and the three web-stream symptoms below.
- `owc-sr-web-stream-gaps` (measured, not fixed; fix site outside `modules/stream.ts`): three web-stream symptoms survive an isolated re-run at HEAD `2a4e24f`. (1) `stream.isReadable(new ReadableStream({ start(c) { c.close() } }))` is `false` on host Node 24.15 and `true` here -- the host reads its own `Symbol(nodejs.stream.readable)` flag, so a closed readable is `false`, one still readable is `true` and a web *writable* is `null`, while `streamIsReadable` here answers `true` for any web readable. (2) `stream/promises` `finished()` on a web stream rejects `TypeError: not a function` here, where the host settles from the stream's own `closed` promise: resolved for an already-drained readable, never settled for one with a queued chunk nobody read or for a writable nobody closed. (3) `Duplex.toWeb(d).writable.getWriter().write(Buffer.from('hi'))` reaches the node `PassThrough`'s own `'data'` listeners on the host (`"hi"`) and nothing here (`""`), because `Readable.toWeb` here subscribes an iterator at construction and drains the chunk before a later `'data'` listener is attached, while the host's leaves the stream paused until the web side pulls; `Writable.toWeb` alone and reading back through the returned readable both agree. All three need `runtime/guest/modules/web-streams.ts`: it exposes no `closed` promise and no readable state flag -- `util.inspect` prints `state: 'closed'`, but there is no such property and `Symbol(nodejs.stream.readable)` is absent -- so a faithful fix is a change to that file and not to `stream.ts`. Not engine-limited: bare QuickJS 0.32 has no `ReadableStream` or `WritableStream` at all (`typeof` is `'undefined'` in a bare `quickjs-emscripten` 0.32.0 context), so the whole behaviour is this container's own JavaScript. Re-measured at HEAD `9376836` against host Node 24.15: (3) no longer reproduces -- `Duplex.toWeb(d).writable.getWriter().write(Buffer.from('hi'))` now reaches the `PassThrough`'s own `'data'` listeners and prints `"hi"` on both sides -- while (1) and (2) still do, and four more of the same family were measured beside them: `stream.isWritable()` answers `true` for a web `WritableStream` that has been closed, aborted or errored, where the host answers `false` for all three and `isErrored()` `true` for the aborted and the errored one; `stream.isErrored()` on a web `ReadableStream` its controller errored is `false` here against the host's `true`; `stream.isDisturbed()` on one a reader has read, and on one drained to its end, is `false` here against the host's `true` for both. Every one of the six reads the single fact this container does not expose: the stream's own `state` slot (`'readable'`, `'closed'`, `'errored'`), which lives in `web-streams.ts`' private `SLOTS` WeakMap behind `slotsOf()` and is reachable from nowhere else -- and borrowing `getReader().closed` instead would not reproduce the host either, because the host's `finished()` does not lock the stream it waits on (`rs.locked` stays `false` after `await finished(rs)`, measured). Fix site unchanged: `runtime/guest/modules/web-streams.ts`.

- `owc-esm-dynamic-import-compile-frames` (retired for the claim it names, one engine limit recorded): at HEAD `9c75c00`, one container boot per case against host Node 24.15, an entry of `await import('./dep.mjs')` over a duplicate `const` binding and over a duplicate `import` binding now prints node's own report end to end -- the file, the line, the source line, the caret, `SyntaxError: Identifier 'a' has already been declared`, and the two frames the row names, `at node:internal/modules/esm/loader:628:32` and `at TracingChannel.tracePromise (node:diagnostics_channel:362:14)` -- where it used to print `at ModuleJob.syncLink` and `at ModuleJob.link`; the two static controls match as well. What does not and cannot match is the wording of a parse error the engine itself raises: for `export const a = ;` the host prints `SyntaxError: Unexpected token ';'` and this container prints `SyntaxError: unexpected token in expression: ';'`, and the latter is bare QuickJS's own message -- a `quickjs-emscripten` 0.32.0 context with no container in the way, given that exact source as a module, answers `unexpected token in expression: ';'` -- so no guest-side code can change it. The same case also prints a two-line report under a dynamic import where the host prints fourteen lines; that half is not engine-limited and its fix site is `packages/core/src/process/executors/node/process.ts` (`esmCompileFrames`), which is outside this shard's grant.

## The `module-events` shard, re-judged at HEAD `99cae36`: what is fixed, and what is recorded

Host Node v24.15.0 against one fresh container per battery, each battery run twice and
byte-identical across the two runs, stdout/stderr/exit on both sides (machine while measuring:
load 5.7-7.9, 3.2 GB free -- never the 9-22 load / 170 MB band). Fixed here: an `inspector`
session now fires one notification on both channels, so `session.on('Runtime.consoleAPICalled', fn)`
hears what `session.on('inspectorNotification', fn)` always did; `Runtime.evaluate` answers `-32602`
for a request with no expression and `-32000` for a context it never created, instead of evaluating
both, and refuses a symbol under `returnByValue` as a host does; a `Date` by value is `{}` and not
its ISO string; `events` carries `kMaxEventTargetListeners` and `kMaxEventTargetListenersWarned`
(non-enumerable, worth symbols) so `Object.getOwnPropertyNames(require('events'))` is 22 as on a
host, and `addAbortListener`'s listener is handed an event whose `target.reason` is the abort
reason; `async_hooks.createHook({...}).enable()` hears the resources this runtime makes in
JavaScript -- `init` for an `AsyncResource`, `before`/`after` around `runInAsyncScope`, `destroy`
from `emitDestroy` on a later turn of the loop -- so `EventEmitterAsyncResource` is a real async
resource and not a shell with plausible numbers; every CommonJS `require`, not only the one
`createRequire` hands out, has a `resolve.paths`; and `Module._stat`, `_readPackage`, `wrap` and
`wrapper` are accessor pairs with node's own configurability rather than plain data properties.

Still measured and not fixed, each with its site: `Module.register` and `Module.registerHooks` accept hooks and
never call them, so a registered `load` hook changes nothing a program sees -- the engine is not what stops them, since
`quickjs-emscripten-core` 0.32.0 declares `setModuleLoader(moduleLoader: JSModuleLoaderAsync, ...)` and an async `load`
hook can be awaited, but the two halves of the loader, `loadModule`
(`packages/core/src/process/executors/node/process.ts:3014`) and `normalizeModule` (`:3152`), consult no registry, and
the one both calls fill lives in the guest (`runtime/guest/misc.ts`); five of the 72 `builtinModules` are not requirable
though `Module.isBuiltin` answers `true` for them, each because there is nothing here to put behind the name --
`_http_common` is llhttp's parser object and this runtime's `http` parses with no parser object to hand out,
`_stream_wrap` is `JSStreamSocket`, a socket node's own `net` builds over a stream, `wasi` needs an import object that
writes into a module's linear memory and the guest's `WebAssembly` runs in the host realm with one copy of that memory
per call (`runtime/guest/wasm.ts`), `node:sqlite` needs a statement API and the bundled `better-sqlite3` shim's
`Database` has no working `prepare` (measured: `new Database(':memory:').exec(...)` succeeds and `.prepare(...)` answers
`not a function`), and `node:test/reporters` documents five reporters over an internal event stream this runtime does
not emit; the inspector's remaining divergence is the wording of a stack, which is QuickJS's own, the two serials a
host's own isolate numbers, and `Debugger.scriptParsed`, of which a host emits one per compiled script -- 146 for the
measured program -- and this runtime none, having no debugger; `async_hooks` sees nothing the engine itself would
report -- the destroy of a timer, so the same battery counts 1 here against the host's 2, the site being
`runtime/guest/modules/pure-a.ts`, outside this shard's grant -- and QuickJS words a call of something that is not a
function `not a function` where V8 words it `r.asyncId is not a function`; `fs.statSync`/`lstatSync` succeed for
`plain.js/`, `plain.js/.`, `plain.js/./` and `plain.js/..` where a host answers `ENOTDIR`, and `readdirSync`,
`opendirSync`, `rmdirSync`, `rmSync`, `truncateSync`, `linkSync`, `readlinkSync` and `mkdtempSync` answer `ENOENT` where
it answers `ENOTDIR` -- the site is `runtime/guest/buffer-fs.ts`, outside this shard's grant, and it is named here
rather than edited; `AbortSignal.timeout`'s timer keeps this process alive where a host's is unref'd and lets it exit;
and no `MaxListenersExceededWarning` is ever emitted, so a host's stderr carries one for an eleventh listener and this
one's is empty.
