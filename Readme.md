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
  - Node built-ins: `path`, `events`, `util`, `assert`, `fs` (sync, callback and promises, plus read and write streams and file descriptors — `openSync`, `writeSync`, `readSync`, `readvSync`, `writevSync`, `closeSync`, `fstatSync`, `ftruncateSync`, `truncateSync`, `linkSync`, `cpSync`, `statfsSync` and `openAsBlob` — over the virtual file system), `buffer`, `os`, `timers`, `url` (WHATWG URL and legacy `parse`/`resolve`/`format`), `crypto` (random values, `createHash`, `createHmac`, `pbkdf2`, `timingSafeEqual`, and `createCipheriv`/`createDecipheriv` over `@noble/ciphers`: AES-ECB, AES-CBC, AES-CTR, AES-CFB and AES-GCM at 128, 192 and 256 bits and ChaCha20-Poly1305, byte-identical to host Node 24.15 and with Node's `ERR_CRYPTO_INVALID_KEYLEN` and `ERR_CRYPTO_INVALID_IV` codes), `process` (including `chdir`/`cwd` over the virtual file system), `console`, `module`, `stream` and `readline`, `querystring`, `string_decoder`, `punycode`, `diagnostics_channel`, `async_hooks` (AsyncLocalStorage across timers, ticks and `.then` callbacks), `perf_hooks`, `v8`, `vm`, `domain`, `inspector` and `repl` (partial), `zlib` (gzip, deflate and raw, compressed by the zlib Node bundles and decompressed by fflate; brotli and zstd, backed by WebAssembly codecs built from the same C libraries Node uses, byte-identical to host Node 24.15 — see "Codecs")
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
- **A guest stack frame names no receiver.** `E.methodFrame()` gives `    at methodFrame (/app/main.js:31:3)`
  where the host gives `    at Object.methodFrame (...)`, `new Foo()` gives `at Foo` where the host gives
  `at new Foo`, a static call `at sm` where the host gives `at Bar.sm`, and a getter `at gg` where the
  host gives `at Object.gg`: the receiver a frame was called on is not something this engine writes into
  a frame it writes, so no guest-side reading of the text can put it there. What a host does name is
  named now: a trace keeps no frame of this container's own -- where it ended with `at call (native)`,
  `at loadCJS (owc-bootstrap.js:...)` and `at runMain (owc-bootstrap.js:...)`, which no host trace has,
  it ends with the frames of node's own CommonJS loader -- the body of a module is `at Object.<anonymous>`
  and not `at <anonymous>`, and the anonymous function a host leaves unnamed is the bare location.
  `util.inspect(new Error('boom'))`, an uncaught throw and an error the guest constructs all carry
  the `Error: boom` header. An error the engine raises itself -- `null.x`, `JSON.parse('{')` --
  still opens with a frame, which is `owc-guest-error-engine-stack-no-header` below.
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
| `undefined` | `undefined` | `undefined` |
| `const x = 5` | `undefined` | `undefined` |
| `x` | `5` | `5` |
| `_`, the last result | `5` | `5` |

Recorded rather than fixed:

- **No welcome banner.** Host node prints `Welcome to Node.js v24.15.0.` and `Type ".help" for more
  information.` above the first prompt; this one prints the prompt only.
- **A syntax error prints its message alone.** Host node echoes the offending line and a caret under the
  token. QuickJS reports its own message, and the REPL has no source line to echo.
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
- Node built-ins not yet implemented or partial: `zlib`'s `maxOutputLength` option and its `ZstdDictionary`/`BrotliCompress` native handle internals; `crypto` ciphers work but the lists behind them are short: `getCiphers()` returns 16 names (`aes-128/192/256` in `-cbc`, `-cfb`, `-ctr`, `-ecb` and `-gcm`, plus `chacha20-poly1305`) where Node 24.15 returns 130 — `aes-192-cfb8` is `ERR_CRYPTO_UNKNOWN_CIPHER` here although Node supports it, and so are the `cfb1`/`cfb8`/`ofb`/`xts`/`ccm`/`ocb`/`wrap` families, `aria`, `camellia`, `des-ede3`, `sm4` and bare `chacha20` — and `getHashes()` returns 6 (`md5`, `sha1`, `sha224`, `sha256`, `sha384`, `sha512`) where Node returns 52; stream helpers: `stream/promises`' `pipeline` refuses a *function* as a transform — `pipeline(src, async function* (s) { ... }, sink)` and `pipeline(src, async function (s) { ... })` both raise `ERR_INVALID_ARG_TYPE` (the message asks for "function or an instance of Blob, ReadableStream, WritableStream, Stream, Iterable, AsyncIterable...") where host Node 24.15 accepts both — and `node:stream/consumers` does not resolve at all (`MODULE_NOT_FOUND`) where Node has `text` and `json`; a `Transform` stream and two `PassThrough`s do pipeline correctly, and `addAbortSignal` destroys its stream with `ABORT_ERR` as on the host; `inspector` sessions construct, `connect()` and answer `Runtime.evaluate` by evaluating the expression in the realm and returning the protocol's `RemoteObject` (measured: `1+1` gives `{"result":{"type":"number","value":2,"description":"2"}}`, byte-identical to host Node 24.15), while every other method still fails with `Inspector protocol is not available in this runtime`; `v8.serialize` still emits its own JSON text rather than the V8 wire format (host Node 24.15 writes `ff0f6f220161...` for `{a:1,b:'x'}`), so a buffer written here is readable here and nowhere else; `module.register` is still `undefined`, and there is no pipeline to put it in: host Node 24.15 exports it as a function whose hooks really apply (measured: a hooks module whose `load` returns `{ format: 'module', source: 'export const tag = "hooked";', shortCircuit: true }` for `./target.mjs` makes a later `import('./target.mjs')` report `tag: hooked`), while the ESM loader here is the synchronous `normalizeModule`/`loadModule` pair QuickJS calls through `runtime.setModuleLoader` in `packages/core/src/process/executors/node/process.ts`, which resolves and loads in one synchronous call with no hook point in either step and no hooks thread to await an async hook in, so a `register` that reported success without ever applying its hooks would be worse than the gap; `process.report` is present and `getReport()` returns the same 11 sections and the same 23 header keys host Node 24.15 returns (but with this container's own values — see `owc-node-report-getreport-shape`); `fs.glob` is absent, where Node 24.15 has `fs.glob` and `fs.globSync`
- TLS: `tls` and `https` implement TLS 1.3 only (no TLS 1.2, session resumption or 0-RTT); peers are verified against the `ca` option only (no system or built-in roots); pfx, passphrase-protected keys, Ed25519 and P-521 keys are not supported; only the X25519 and P-256 groups, the AES-GCM and ChaCha20-Poly1305 suites and ECDSA P-256/P-384, RSA-PSS and RSA PKCS#1 signatures are implemented, and an `ecdhCurve`, `ciphers` or `sigalgs` value that names only other algorithms throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; external `https` requests still go through the browser's `fetch`. `tls.DEFAULT_MIN_VERSION` still reports `TLSv1.2`, so nothing but a handshake tells you it is wrong: a client pinned to `minVersion`/`maxVersion` `TLSv1.2` fails with `ERR_SSL_NO_PROTOCOLS_AVAILABLE` (`no protocols available`) where host Node connects and reports `TLSv1.2`
- HTTP/2: `http2` does not send server push (`pushStream` reports `ERR_HTTP2_PUSH_UNSUPPORTED`) and has no `respondWithFile`/`respondWithFD`, ALTSVC or ORIGIN frames, h2c `Upgrade` from HTTP/1.1, `allowHTTP1`, or session and stream timeouts. HTTP/3 over QUIC is not started
- Guest-side `fetch` is implemented: a request goes out on the container's own `http` and `https` client, so a URL on the virtual network reaches the server listening there (measured against host Node 24.15 on the same script: a 200 over `http://127.0.0.1`, its body, and a POST with a body and headers all agree, and an unreachable host rejects as `TypeError: fetch failed` with `ENOTFOUND` on `err.cause`) and there is no host network behind it. `Headers`, `Request`, `Response` and `FormData` are globals beside it — one script covering status, `text()`, `json()`, a response header, a POST with a string body, a `FormData` body sent as `multipart/form-data`, an abort through `AbortSignal` (which rejects with the signal's own `AbortError`, not with `fetch failed`), an unreachable host, and `typeof` plus a construct-and-read round trip for all four classes is byte-identical to host Node 24.15, as is the streaming half: `Request` and `Response` expose `.body` as a real `ReadableStream` (async iteration, `getReader()`, `clone()` of a stream body through `tee()`, and `bodyUsed` flipping once the stream is pulled all agree with host Node 24.15) — what is still missing is `.formData()` on both, so a multipart body is never parsed back into a `FormData`, and the boundary this container generates is `----formdata-owc-<24 random alphanumerics>` where undici's is `----formdata-undici-<12 digits>`. A stream body still needs the `duplex` option Node asks for and is refused with `RequestInit: duplex option is required when sending a body.` The `WebSocket` global is a client over the same sockets: the handshake, a text frame, a binary frame, the negotiated subprotocol and the close handshake were measured against host Node 24.15 and agree, and the close event fires the way Node's does — when the connection ends, not when the peer's close frame arrives, so a server that sends a close frame and keeps the socket leaves the client at `readyState` 2 (CLOSING) indefinitely, and the event is a real `CloseEvent`; there is no WebSocket server and no `EventSource`. `undici`'s own module is served over the same client
- `zlib` native handle protocol: pngjs's synchronous decoder reads `zlib.Inflate` internals (`_handle`, `_processChunk`) and fails; both are `undefined` here, where Node has an object and a function. The public `zlib` APIs work
- WebAssembly packages: `hash-wasm` (sha256 and md5) and `cheerio` (selectors and `$.html()`) match Node 24.15 byte for byte. `sql.js` does not run: even `new SQL.Database()` throws `ERR_WASM_TRAP: Cannot convert a BigInt value to a number` (sql.js 1.13.0 and 1.15.1, with or without `locateFile`), so the i64 values its build moves across the boundary stop it at the first call. A memory still crosses the boundary in 1 MiB chunks per call
- Native addons: a compiled binary cannot run, so `process.versions.napi`, `process.dlopen` and a `.node` require serve a JavaScript reimplementation from `src/napi`: `bcrypt` (verified: `hashSync`/`compareSync` round-trip), `sodium-native`, `better-sqlite3` (SQLite 3.47.0 transpiled to plain JS), `leveldown`, `rocksdb` and `rocksdb-native`, `node-pty`, `canvas` and `sharp`. `sodium_malloc` returns an ordinary zero-filled Buffer, and `sodium_mprotect_*` and `sodium_mlock` are no-ops: the container has no guarded heap and cannot lock memory, so libsodium's memory hardening is unavailable, though computed values are unaffected. `esbuild` ships a Go binary rather than an add-on: `npm install esbuild` fails in its postinstall with `npm error code ENOEXEC`, naming `/app/node_modules/@esbuild/linux-x64/bin/esbuild` as the binary this container cannot execute, and the installed bin then fails with `spawnSync /app/node_modules/@esbuild/linux-x64/bin/esbuild ENOENT` and exit 1
- The three add-on shims are honest about what they do not do, and each has a surface where the answer is still not libvips' or Cairo's: `sharp` refuses every operation it cannot honour, but a resize with the `cubic`, `lanczos2`, `lanczos3` or `mitchell` kernel, and a `cover` crop at `position` `top`, `bottom` or `centre`, return pixels that differ from libvips' without saying so — measured on a 16x8 input, `resize({ width: 6, kernel: 'cubic' }).raw()` begins `ff0d0affff0d09ffff0f0eff` here and `ff0e0bffff0d0affee1214ff` under host sharp 0.33.5, and only `nearest` agrees — and `sharp.versions` lists 2 dependency keys where libvips reports 29, `sharp.concurrency()` is 1 (host 11) and `sharp.simd()` is `false` (host `true`); `canvas` draws text with one built-in monoline font, so glyph shapes and advance widths are never the family the page asked for; `node-pty` gives the child no terminal, so `node -e console.log(11+11)` prints plain `22` where the host's pty prints the yellow `\u001b[33m22\u001b[39m`, and `kill('SIGTERM')` reports exit 0 signal 15 where the host's `onExit` does not fire at all
- `hypercore`: `random-access-memory` is a backend `hypercore` 10 accepts and 11 does not — `new Hypercore(RAM)` on 11 throws `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined` from `hypercore-storage`'s `path.join(db.path, '..')` on host Node 24.15 as well, because 11 stores in RocksDB; `hypercore` 10.38.2 on `random-access-memory` runs here and prints `OK block=hello world length=1`, byte-identical to host Node 24.15. `hypercore` 11 does not load at all: `rocksdb-native` is served by the `rocksdb` shim (`prebuilds/<platform>-<arch>/rocksdb-native.node`, resolved by `require-addon`), but `require('hypercore')` then dies at `fs-native-extensions`, which `device-file` needs for its file locks, with `Cannot load addon 'file:///node_modules/fs-native-extensions/prebuilds/linux-x64/fs-native-extensions.node'`; past that, `new RocksDB()` throws `TypeError: not a function` at `rocksdb-native/lib/column-family.js:72`, because what the shim serves is the leveldown store and has no `columnFamilyInit`, `snapshotCreate`, `iteratorInit`, `readBuffer` or `writeBuffer`, where the real add-on (measured on Node 24.15) exports all of them
- `hypercore`'s tree hash uses `sodium.crypto_generichash_batch`, which the sodium shim computes as one BLAKE2b over the batch's concatenation: measured against the real add-on, a batch of `'a'` and `'bc'` under a 32-byte key is byte-identical to `crypto_generichash` of `'abc'` and not to `'a'`
- Utilities a browser container cannot have report it instead of exiting 127: `ping`, `dig`, `traceroute`, `nc`, `netstat`, `ss`, `ip`, `ifconfig`, `nft`, `systemctl`, `cron`, `crontab`, `chroot`, `su`, `sudo`, `usermod`, `groupadd`, `groupdel`, `lspci`, `iostat`, `vmstat`, `perf`, `tmux`, `vi`, `import`, `xclip`, `open` and `write` each write `<name>: not supported on this runtime: <reason>` and exit 1 — `ping` with `ERR_NO_RAW_SOCKET` and `lspci` with `ERR_NO_PCI_BUS`; `make` (variables, pattern rules, `.PHONY`, automatic variables), `bc` (arbitrary precision, `scale`, `sqrt`, `ibase`/`obase`) and an `openssl` subset (`dgst` with md5/sha1/sha224/sha256/sha384/sha512 and `-hmac`, those digests as shorthand commands, `rand -hex/-base64`, `version`) are implemented, and `man` answers from its own short pages (`man ls` prints `NAME`/`SYNOPSIS`, `man nosuchcmd` prints `No manual entry for nosuchcmd` and exits 1). `make --version` is not one of the implemented options: it exits 2 with `make: invalid option -- '-version'` where GNU Make prints its version
- The shell now provides the POSIX utilities as JavaScript over the virtual file system: the text filters (`grep`, `sed`, `awk`, `cut`, `sort`, `tr`, `paste`, `uniq`, `wc`, `head`, `tail`, `join`, `comm`, `diff`, `fmt`, `pr`, `tabs`), the file utilities (`find`, `xargs`, `stat`, `date`, `printf`, `expr`, `test`, `seq`, `base64`, `base32`, `xxd`, `split`, `install`, `ln`, `chown`, `chmod`, `du`, `df`, `tee`, `sleep`, `yes`, `basename`, `dirname`), the archives (`gzip`, `gunzip`, `zcat`, `compress`, `uncompress`, `tar`, `cpio`; no `bzip2` or `xz` codec is available), the shell builtins (`set`, `export`, `alias`, `type`, `trap`, `read`, `pushd`/`popd`, `source`), globbing (`*`, `?` and `[...]`, with an unmatched pattern left literal as the host leaves it) and the operators `;`, `&&`, `||`, `|`, `<`, `>`, `>>`, `2>&1` and `2>/dev/null`
- **`vm` `timeout` is enforced for JavaScript loops** — measured: `ERR_SCRIPT_EXECUTION_TIMEOUT` after 52 ms against 53 ms on host Node — but not for time spent inside a native built-in, which runs to completion past the deadline. **`vm` contexts now have a realm of their own**: the host keeps a second QuickJS context on the same runtime and rebuilds what a context hands back inside it, so `vm.runInContext('[1,2]', ctx)` answers `false` to `instanceof Array` with `Array.isArray` still `true` and `Object.prototype.toString.call` still `[object Array]`, and `vm.runInContext('({a:1})', ctx)` answers `false` to `instanceof Object` — byte-identical to host Node 24.15 across arrays, plain objects, nested values, `Date`, `RegExp` and the standard globals (`runInContext('Array') === Array` is `false`, as on the host). What a second context cannot give is identity: the value is a rebuild, so symbol-keyed and non-enumerable properties do not cross, functions cross as themselves (a body belongs to the realm it was compiled in), every `vm` context of one process shares the one second realm rather than each having its own, and a value the caller put into the sandbox is handed back unchanged — a rebuild of it would drift from the original the moment either was changed
- A `WebAssembly.Table` holds what the host will accept: a table of function type takes WebAssembly function objects, so a JavaScript function a guest `set`s is kept on the guest side (its own `get` returns it) while the module sees an empty slot
- `FinalizationRegistry` never runs cleanup callbacks (host Node fires one after `gc()`; this engine build has no GC observation), but a `WeakRef` target that becomes unreachable *is* collected — after allocation pressure `deref()` returns `undefined` where Node 24.15 still returns the target; `MessageChannel` delivers only inside the process
- Worker messages deliver a `Uint8Array` and not a `Buffer`, as Node does: `constructor.name`, `instanceof Uint8Array` and `Buffer.isBuffer` all agree with host Node 24.15 on the same worker script
- **A `WebSocket` instance carries none of Node's internal slots**: `Object.getOwnPropertySymbols(ws)` is `[]` where host Node 24.15 reports `Symbol(kEvents)`, `Symbol(events.maxEventTargetListeners)`, `Symbol(events.maxEventTargetListenersWarned)` and `Symbol(kHandlers)`, and `Object.getPrototypeOf(WebSocket.prototype)` is a stand-in object that looks like `EventTarget.prototype` without being it — a socket here never runs an `EventTarget` constructor, so nothing installs those slots, and making the stand-in *be* `EventTarget.prototype` would put `addEventListener` among `WebSocket.prototype`'s own names, which host Node does not
- **A client that offers no subprotocol and is handed one anyway ends differently**: host Node 24.15 throws an uncaught `TypeError: Cannot read properties of null (reading 'includes')` out of `internal/deps/undici` and exits 1 with that stack on stderr, where the container fails the handshake cleanly with an error event, a `close` carrying 1006 and exit 0. Both refuse the connection; only the crash is missing, and it is a bug in that undici build rather than behaviour worth reproducing
- `process.kill` matches host Node 24.15 on the same script: `process.kill(process.pid, 0)` is `true`, a pid that is not there throws `ESRCH` (`kill ESRCH`), a live child answers `0` with `true` and `SIGTERM` with `true` and then exits with `null SIGTERM`, and `process.kill(process.pid)` ends this process with status 143
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
- `AsyncLocalStorage` context is not carried across `await` (timers, ticks and `.then` callbacks do carry it): the store is present before the first `await` and `undefined` after it. An async function's suspension unwinds the JS stack before the engine calls `then`, and its resumption runs in a job enqueued after the reaction returns, so no reaction wrapper can hand the frame across; it needs the host hook V8's `SetPromiseHook` gives Node's `async_hooks` — a hook on job enqueue — and `quickjs-emscripten` 0.32 exposes none
- Shell: `;` separators and `|` pipes work — measured against this machine's `/bin/sh`, they agree on stdout, stderr and exit code — and so does globbing. What does not agree: `chmod` and `fs.chmodSync` succeed and change nothing, so `chmod 755 f; stat -c %a f` prints `644` where the host prints `755`; `touch a b c` creates only `a`, where the host creates all three; `ls -l`, `ls -a` and `ls -la` are accepted and ignored, so no long format and no dotfiles are ever printed
- `node` and `npm` run only on a line of their own: joined to another command with `;`, `&&` or `||`, or put in a pipeline, they write `<name>: cannot run here: it can only be run on a line of its own, where the shell can wait for it` (exit 127 for the command). `npm run` does work, including `pre`/`post` lifecycle scripts, `npm install` writes `package-lock.json` at lockfileVersion 3, and global installs are refused (`Global installs are not supported by this runtime`, exit 1)
- `npm install` of a package whose tree carries per-platform optional dependencies exits 1 where host npm exits 0: `typescript` reports `EBADPLATFORM` for `@typescript/typescript-aix-ppc64` and the rest, and `esbuild` reports `ENOEXEC`, and in both cases the package itself is installed
- `node --version` is resolved as a file, not a flag: it fails with `Cannot find module '/app/--version'` and exit 1, where host node prints `v24.15.0`. `npm --version` prints `10.9.0`. Every `node`/`npm` command's output is written twice, once as it is produced and once from the result the shell gets back
- Processes now match Node where this entry used to diverge: an unhandled promise rejection is reported with its error and ends the process with status 1, and a `domain` catches a rejection thrown inside a `.then` callback inside `d.run()` (`domain.promise` is the error's message in both)
- A rejection of an `async function`'s own promise is not reported: `(async function () { throw new Error('x'); })();` goes on to the next statement and ends the process with status 0, where host Node 24.15 writes the error to stderr and exits 1 without running a later timer. Every promise the guest builds itself is tracked — one `Promise` subclass records a rejection when it happens and records a handler when one is attached — but the engine builds the result of an async function with its intrinsic `%Promise%` and not through `Promise[Symbol.species]`, so no cell exists for it; measured with `then`, `catch` and `finally` patched on that intrinsic's prototype, a discarded async function's promise is never touched at all, so nothing in the guest can see the rejection. It needs the hook QuickJS's C API names `JS_SetHostPromiseRejectionTracker`, or a hook on job enqueue, and `quickjs-emscripten` 0.32 exports neither that nor `addFunction`, so no callback can be installed. A rejection of a promise the guest did build, and one an `await` or a `.then` reaches, are reported and end the process with status 1, as they do on the host
- `readline` keypress events are delivered: `readline.emitKeypressEvents(stream)` makes the stream emit `keypress` with the character and Node's key record, and `createInterface({ terminal: true })` installs it on its input. Measured against host Node 24.15 over 35 sequences, the name, the `ctrl`/`meta`/`shift` flags, the `sequence` and the `code` agree for every one of them except the malformed `ESC [ 1 ; 1 0 A`, which the host splits into two keys and this one reads as one; a lone escape is not a key in either, and a sequence split across two `write`s is held until it is complete. A `Promise` reaction registered inside `d.run()` sees `domain.active` as the domain, as it does on the host
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
- An interrupted guest leaves objects live, so QuickJS prints
  `Assertion failed: list_empty(&rt->gc_obj_list)` when its runtime is freed. It is caught during
  teardown; the process still reports its status and output, and the container keeps working.

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
- [ ] Builtin module namespace surface -- far wider than `node:fs`: measured against host Node 24.15, 19 of 34 builtins differ (`node:fs` 90 against 105, `node:process` 46 against 83, `node:crypto` 30 against 70, `node:util` 22 against 35, `node:os` 22 against 24, `node:path` 16 against 18); `node:cluster` exposes `worker` where Node has `Worker`, `node:util` leaks `__isDeepEqual`/`isFunction`/`isNumber`/`isObject`/`isString`, `node:module` still exports `createRequireFromPath`/`wrap`/`wrapper` that Node 24 dropped, and `node:fs` carries `F_OK`/`R_OK`/`W_OK`/`X_OK` at top level (row owc-esm-builtin-namespace-surface)
- [x] Namespace mutation error text -- `ns.default = 1` reports QuickJS's `'default' is read-only`, not Node's message (row owc-esm-namespace-mutation-error-text)
- [x] A multi-byte character split across two `process.stdout.write` calls, and a lone surrogate written as text -- `write([e4,b8])` then `write([ad])` is U+4E2D as on a host, including across an intervening empty-string write, and `write('\ud83d')` then `write('\ude00')` is two U+FFFD as on a host (row owc-stdout-split-sequence-mangled)
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

`sh -c <line>` in the container against `sh -c <line>` on the host, node v24.15.0 on both sides,
cwd at the app directory, one case per process. Each line below is one symptom that survives a
re-run in isolation; the rows are open.

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
- `owc-esm-global-surface`: the enumerable globals are not Node's -- `Object.keys(globalThis).length`
  is 27 here against the host's 15, and the container makes `Blob`, `Buffer`, `URL`, `URLSearchParams`,
  `console`, `process`, `TextEncoder`, `TextDecoder`, `AbortController`, `AbortSignal`, `File` and
  `CloseEvent` enumerable where the host does not, leaks `__owcErrname` as an enumerable global, and
  has no `navigator`; `Object.getOwnPropertyNames(globalThis)` is 122 against 135, missing `Atomics`,
  `Crypto`/`CryptoKey`/`SubtleCrypto`, `navigator`/`Navigator`, the `Performance` family,
  `BroadcastChannel`, `CompressionStream`/`DecompressionStream`, `URLPattern`,
  `DisposableStack`/`AsyncDisposableStack` and `SuppressedError` (row owc-esm-global-surface)
- `owc-esm-unknown-file-extension`: `import('./m.xyz')` holding `export const v = 1` -- the host
  answers `TypeError ERR_UNKNOWN_FILE_EXTENSION "Unknown file extension \".xyz\" for /app/m.xyz"`,
  the container parses it as CommonJS. The same call exposes four more: `.m` is
  `ERR_UNKNOWN_FILE_EXTENSION` on the host, `.ts` and `.mts` LOAD (Node 24 strips types) where the
  container raises `unsupported keyword: export`, `.node` is `ERR_UNKNOWN_FILE_EXTENSION` where the
  container gives `ERR_DLOPEN_FAILED`, and `.wasm` is a wasm module on the host and CommonJS here
  (row owc-esm-unknown-file-extension)
- `owc-esm-main-syntax-error-frame`: a syntax error is printed without Node's frame, and its message
  is the engine's and not V8's -- for `const = 1;` the host writes `SyntaxError: Unexpected token '='`
  under a caret with internal frames and a `Node.js v24.15.0` trailer, the container writes
  `SyntaxError: variable name expected`. Not only an ES module main: a `.cjs` main, a typeless `.js`
  main and a syntax error inside an imported dependency all lose the frame the same way, and an
  `import.meta` in a `.cjs` loses it too (row owc-esm-main-syntax-error-frame)
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
- `owc-shell-diagnostic-line-position`: no diagnostic carries the position a host's does -- a host writes `/bin/sh: -c: line 1: syntax error near unexpected token `;'` and `/bin/sh: line 0: .: filename argument required`, the container the bare sentence; of 94 measured cases 37 differ on that prefix alone and nothing else.
- `owc-shell-return-not-in-function-wording`: the complaint about a `return` outside a function is quoted with straight quotes and carries no shell name -- host ``/bin/sh: line 1: return: can only `return' from a function or sourced script``, container `return: can only 'return' from a function or sourced script`.
- `owc-guest-getter-only-assignment-message`: a strict-mode write to an accessor that has a getter and no setter -- `e.type='y'` on an Event, `r.status=201` on a Response -- throws `TypeError: no setter for property` where host Node 24.15 throws `TypeError: Cannot set property type of #<Event> which has only a getter`. The text is the engine's: the same pair appears for a `class K { get a(){return 1} }` built inside the container. The descriptor, the sloppy-mode no-op and `Reflect.set` answering false all match, which is why those attributes carry no setter at all rather than a setter written only to reproduce this string.
- `owc-guest-error-engine-stack-no-header`: an error the engine raises itself -- `null.x`, `JSON.parse('{')` -- opens with a frame where host Node 24.15 opens with the error's own name and message: container `err.stack` is `    at <anonymous> (/app/main.js:12:11)`, host `TypeError: Cannot read properties of null (reading 'x')`. An error the guest constructs does carry its header, because its constructor is wrapped; these are raised at throw sites inside the engine that no guest-side definition reaches.
- `owc-shell-closed-fd-flush-target`: the text a closed descriptor could not hold lands where a host's buffer is flushed, not where the shell started -- `exec >d; echo hi >&-; exec >&2; echo O=[$(cat d)]` is host `O=[hi]` (and the text on the error stream) against the container's `O=[]` with `hi` on the original output; `{ echo hi >&-; } > f; echo O=[$(cat f)]` is host `O=[]` with `hi` on the original output against the container's `O=[hi]`; `exec 1>&-; echo hi 1>&1` is host stdout empty against the container's `hi`.
- `owc-net-rst-unread-threshold`: a peer destroyed with bytes it never read is reset in the container where host Node 24.15 still closes gracefully -- with the server never reading and destroying after 400 ms, the client sees `cliEnd` / `cliClose:false` / a late write as `EPIPE` on the host at 0, 4 KiB, 16 KiB and 64 KiB unread, and `ECONNRESET` / `cliClose:true` / `ERR_STREAM_DESTROYED` in the container from 4 KiB up; only at 256 KiB and 1 MiB does the host reset too. The container's `readableLength` also reports the full unread count (262144, 1048576) where the host caps it at 65536.
- `owc-http2-goaway-session-lifetime`: after its own error GOAWAY the container's server session is already destroyed where the host's is still alive -- `srvSession.goaway(2)` then a second `srvSession.goaway(0)` is `destroyed=false` and a no-op on the host and `destroyed=true` plus `ERR_HTTP2_INVALID_SESSION` in the container; and a client's own `c.goaway(0, 1, Buffer.from('clibye'))` reaches the server as `0 , 1 , dbg=clibye` in the container against the host's `0 , 0 , dbg=undefined`.
- `owc-http-agent-freesocket-reuse-order`: with `maxSockets=3` and 12 requests the container serves a clean round-robin `["5","6","7","5","6","7",...]` where the host reuses whichever socket freed first, `["5","6","5","7","6","5","7","6","5","7","6","5"]` (2/2 runs identical on each side). `agent.freeSockets` itself now matches.
- `owc-net-end-write-finish-order`: a zero-length or 1 MiB write issued right after this side's own `end()` still emits `finish` in the container before the `ERR_STREAM_WRITE_AFTER_END` error -- container `finishes=1 order=["finish","error","close"]`, host `finishes=0 order=["error","close"]`. The error code, the callback and `writableEnded` all match; only the `finish` is extra.
- `owc-shell-cat-directory`: `mkdir sd; cat sd` -- host stderr `cat: sd: Is a directory` and status 1; container stdout `{}` and status 0.
- `owc-shell-exec-not-found-wording`: `exec nosuchcmdxyz` -- host stderr `/bin/sh: line 0: exec: nosuchcmdxyz: not found`; container `sh: nosuchcmdxyz: command not found`. Same status 127; a host names `exec` and carries the `line 0`.
- `owc-engine-stack-underflow-user-eval`: a source the engine compiles because user code called `eval` still aborts -- `eval('(function*(){ for (const x of (yield 1)) {} })')` and the indirect `(0, eval)` of the same string are `function` on host Node 24.15 and throw `InternalError: stack underflow (op=110, pc=8)` in the container, in a CommonJS module, in an ES module and under `node -e`. The rewrite that hoists the iterable now reaches every source the container itself compiles (`new Function` anywhere, the `vm` surfaces, `node -p`); `eval` it cannot reach, because a wrapper over `globalThis.eval` is not the intrinsic `%eval%` and would cost every direct eval the caller's scope that `vm`'s own with-scoped eval and a package evaluating `require('x')` rely on.
- `owc-compat-rewrite-tostring-leak`: `Function.prototype.toString` prints the compatibility rewrite instead of the source -- `new Function('return function*(){ for (const x of (yield 1)) {} }')().toString()` is `function*(){ for (const x of (yield 1)) {} }` (79 characters) on the host and `function*(){ const __owcOf1 = (yield 1); for (const x of __owcOf1) {} }` (106) in the container, and a module-level generator, a class method and a `-e` body leak the same way. The hoist is what makes the shape compile at all, so the text cannot simply be dropped; the engine would have to hand back the source it was given rather than the one it compiled.
- `owc-engine-error-message-wording`: the message of an error the engine raises itself is QuickJS's wording and not Node's, and it diverges on every one of them -- `null.x` is `cannot read property 'x' of null` where host Node 24.15 says `Cannot read properties of null (reading 'x')`, `undefinedFn()` is `'undefinedFn' is not defined` where the host says `undefinedFn is not defined`, `JSON.parse('{')` is `expecting property name` where the host says `Expected property name or '}' in JSON at position 1 (line 1 column 2)`, `new Array(-1)` is `invalid array length` against `Invalid array length`, `decodeURIComponent('%')` is `expecting hex digit` against `URI malformed`, a call of a non-function is `not a function` against `f is not a function`, and a strict-mode write to a non-writable or frozen data property is `'z' is read-only` against `Cannot assign to read only property 'z' of object '#<Object>'`. The same wall as `owc-guest-error-engine-stack-no-header`, and a wider blast radius: the message is what `String(e)`, `util.inspect` and every log line print, where the stack header is one line of one property. A getter-only accessor's `no setter for property` is `owc-guest-getter-only-assignment-message`.
- `owc-child-kill-timeout`: an asynchronous child cannot be killed or timed out -- `spawn('node', [busy 5 s], { timeout: 400, killSignal: 'SIGKILL' })` closes at 5415 ms with code 0 and killed false where host Node 24.15 closes at 425 ms with signal SIGKILL, `child.kill()` returns false and `process.kill(child.pid, 0)` throws ESRCH for a node child as well as a shell one, `execFile`/`exec`'s `timeout` reports no error at all, `spawnSync`'s `timeout` reports status 0 where the host reports ETIMEDOUT, and a `while(1){}` child ends only on the container's ~30 s watchdog with status 1 where the host ends it with SIGTERM in 5 ms.
- `owc-stream-internal-surface`: the internal surface of `stream` and `readline` is this implementation's own and not Node's -- `readline.Interface.prototype` carries 10 own keys (`close` through `write`) where host Node 24.15 carries 41 (`_ttyWrite`, `_refreshLine`, `_insertString`, `_deleteLeft`, `_historyNext`, `_tabComplete`, `_getDisplayPos`, `_setRawMode`, `_line`, `_sawKeyPress`, ...), a terminal interface has no `historyIndex`, `historyManager`, `isCompletionEnabled` or `isFlushing` own key, `Readable.prototype` has no `_undestroy`, `readableBuffer` or `removeAllListeners`, `Writable.prototype` has no `_writev`, `writableBuffer`, `writableAborted` or `pipe`, and the own keys of `_readableState` and `_writableState` are this implementation's field set (19 keys) rather than Node's (6). Nothing a program reads to move data differs: `rl.line`, `rl.cursor`, `rl.getCursorPos()`, `rl.tabSize`, `rl.escapeCodeTimeout`, tab completion and the escape sequences `prompt()` writes all agree with the host.
