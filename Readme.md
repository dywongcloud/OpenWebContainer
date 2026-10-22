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

### ⚠️ Guest network throughput, and why it is bounded by the capability boundary

One loopback transfer per cell, 64 KiB writes, measured in the container and beside it the same
script on host Node 24.15. The machine was **not** idle (load average 14, other agents running), so
treat these as a floor, not a peak.

| 16 MiB, both ends in the container | before | after | host Node |
| --- | --- | --- | --- |
| TCP upload | 0.69 MiB/s (23.2 s) | 1.42 MiB/s (11.3 s) | 2000 MiB/s (0.008 s) |
| TCP download | 0.63 MiB/s (25.5 s) | 1.31 MiB/s (12.2 s) | 2000 MiB/s (0.008 s) |
| HTTP/1.1 upload | 0.50 MiB/s (32.0 s) | 1.11 MiB/s (14.5 s) | 1455 MiB/s (0.011 s) |
| HTTP/1.1 download | 0.69 MiB/s (23.1 s) | 1.41 MiB/s (11.3 s) | 1600 MiB/s (0.010 s) |
| HTTP/2 upload | 0.55 MiB/s (28.9 s) | 1.03 MiB/s (15.5 s) | 696 MiB/s (0.023 s) |
| HTTP/2 download | 0.50 MiB/s (31.9 s) | 1.05 MiB/s (15.3 s) | 762 MiB/s (0.021 s) |

Every transport moved together, and throughput was flat at ~0.71 MiB/s from 4 KiB to 1 MiB chunk
sizes, so the cost is per byte and shared by all of them: not a per-message overhead, not a
flow-control window (HTTP/2's window would show up as a chunk-size effect) and not a timer
granularity. Profiling put 88% of it in the guest's own base64 codec
(`process/executors/node/runtime/guest/codec.ts`), not in the hub: `decodeBase64` searched the
64-character alphabet with `indexOf` once per input character, and `encodeBase64` pushed one
character at a time into an array as long as its own output. That measured 22.7 ms to encode and
53.5 ms to decode 64 KiB -- 76.2 of the 87 ms one 64 KiB chunk cost end to end. The host side was
never the cost: it uses `btoa`/`atob`. A lookup table for the alphabet and a table of two-character
pieces for the encoder cut those to 10.3 ms and 21.2 ms, and end-to-end throughput by 1.9x to 2.2x.

**What is left is inherent to the boundary and is recorded rather than fixed.** Capability arguments
are JSON, so bytes have to cross as text: writing 64 KiB still means encoding it in QuickJS, handing
87 KB of JSON to the host and decoding it again in the guest, and after the fix that is still 31 of
the 46 ms a chunk costs. JSON marshalling was measured and is not it (0.52 ms per 87 KB); the
remaining ~0.21 ms per KiB is spread across the guest's buffer handling and the delivery macrotask
and was not attributed further. Getting closer to host speed means a binary channel across the
capability boundary, which the guest/host bridge does not offer, so guest throughput stands at about
1 MiB/s and is reported as measured.

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
- **`ls -f` lists in sorted order, where the host lists in its directory order.** `touch f; mkdir d; ln -s f l;
  ls -f` prints `. .. d f l` here and `. .. f d l` on the host. No entry or marker differs, only the order,
  and the host's own order is not one this file system can derive.
- **`touch -t nonsense f` exits 0 on this host and 1 in the container.** This host's `/usr/bin/touch` reads that
  one string of letters as a date and leaves the file's mtime in 2084; every other non-numeric stamp measured
  (`abc`, `zz`, `sense`, `xyz`, `12345`, `99`) is refused on both sides. One accepted string is a quirk of the
  host's binary, not a shape worth reproducing. (Open row `owc-shell-touch-t-garbage-accepted`.)
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
  builtin`). What is still absent is a file for a utility this shell has no builtin of its own: `command -v npm`,
  `command -v git`, `command -v grep` and `command -v sed` exit 1 where a host names a file.

### ⚠️ Guest `fs` and `process` divergences from the host that are recorded rather than fixed

Each of these was measured by running the same script under host Node 24.15 and in the container and
diffing stdout, stderr and the exit code. Where the two cannot agree, the reason is here.

- **`process.stdout` is an `EventEmitter` with a `write`, not a `Writable`.** `isTTY` and `columns` are now
  left off a stream with no terminal behind it, as a piped host leaves them off, so a package that
  sizes its output from `columns || 80` falls back here as it does there; but the rest of the stream is
  not there -- `writableHighWaterMark` undefined where the host's is 65536, and `fd`, `writable`,
  `writableEnded`, `errored` and `pipe` undefined too, so `typeof process.stdout.pipe` is `'undefined'`
  and anything that pipes into stdout, or tests a stream by its `pipe`, takes the other branch.
- **`process.getuid` (and `process.geteuid`) do not exist** where the host's return 501, so
  `typeof process.getuid === 'function'` is false and a guard on it takes the other branch. The number is
  not the obstacle: `os.userInfo()` in the same container reports `uid` 1000.
- **`process.argv0` is undefined** where the host's is the path node was invoked by.
- **`os.networkInterfaces()` is `{}`** where a host's holds eleven entries, one per interface, so a package
  that picks an address out of it finds nothing.
- **A guest stack frame names no receiver and carries the container's own engine frames.**
  `E.methodFrame()` gives `    at methodFrame (/app/main.js:31:3)` where the host gives
  `    at Object.methodFrame (...)`, a top-level frame is `at <anonymous>` where the host's is
  `at Object.<anonymous>`, and every guest trace ends with `at call (native)`,
  `at loadCJS (owc-bootstrap.js:...)` and `at runMain (owc-bootstrap.js:...)`, which no host trace has.
  `util.inspect(new Error('boom'))` and an uncaught throw do carry the `Error: boom` header -- the
  formatter that writes them prepends it -- and only `err.stack` itself does not.
- **`/dev` holds four devices where a host holds hundreds.** `/dev/null`, `/dev/zero`, `/dev/random` and
  `/dev/urandom` are mounted as character devices and `fs.statSync('/dev/null')` agrees with the host --
  `isFile()` false, `isCharacterDevice()` true, `mode` 8630 -- and a read of `/dev/zero` gives eight zero
  bytes and of `/dev/urandom` eight that are not. `/dev/tty` is the one a guest reaches for that is not
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
- Node built-ins not yet implemented or partial: `zlib`'s `maxOutputLength` option and its `ZstdDictionary`/`BrotliCompress` native handle internals; `crypto` ciphers work but the list behind them is short, so `getCiphers()` returns 16 names where Node 24.15 returns 130 and `aes-192-cfb8` is `ERR_CRYPTO_UNKNOWN_CIPHER` here although Node supports it; several stream helper edge cases; `inspector` sessions construct, `connect()` and answer `Runtime.evaluate` by evaluating the expression in the realm and returning the protocol's `RemoteObject` (measured: `1+1` gives `{"result":{"type":"number","value":2,"description":"2"}}`, byte-identical to host Node 24.15), while every other method still fails with `Inspector protocol is not available in this runtime`; `v8.serialize` still emits its own JSON text rather than the V8 wire format (host Node 24.15 writes `ff0f6f220161...` for `{a:1,b:'x'}`), so a buffer written here is readable here and nowhere else; `module.register` is still `undefined`, and there is no pipeline to put it in: host Node 24.15 exports it as a function whose hooks really apply (measured: a hooks module whose `load` returns `{ format: 'module', source: 'export const tag = "hooked";', shortCircuit: true }` for `./target.mjs` makes a later `import('./target.mjs')` report `tag: hooked`), while the ESM loader here is the synchronous `normalizeModule`/`loadModule` pair QuickJS calls through `runtime.setModuleLoader` in `packages/core/src/process/executors/node/process.ts`, which resolves and loads in one synchronous call with no hook point in either step and no hooks thread to await an async hook in, so a `register` that reported success without ever applying its hooks would be worse than the gap; `process.report` is `undefined`; `fs.glob` is absent, where Node 24.15 has `fs.glob` and `fs.globSync`
- TLS: `tls` and `https` implement TLS 1.3 only (no TLS 1.2, session resumption or 0-RTT); peers are verified against the `ca` option only (no system or built-in roots); pfx, passphrase-protected keys, Ed25519 and P-521 keys are not supported; only the X25519 and P-256 groups, the AES-GCM and ChaCha20-Poly1305 suites and ECDSA P-256/P-384, RSA-PSS and RSA PKCS#1 signatures are implemented, and an `ecdhCurve`, `ciphers` or `sigalgs` value that names only other algorithms throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; external `https` requests still go through the browser's `fetch`. `tls.DEFAULT_MIN_VERSION` still reports `TLSv1.2`, so nothing but a handshake tells you it is wrong: a client pinned to `minVersion`/`maxVersion` `TLSv1.2` fails with `ERR_SSL_NO_PROTOCOLS_AVAILABLE` (`no protocols available`) where host Node connects and reports `TLSv1.2`
- HTTP/2: `http2` does not send server push (`pushStream` reports `ERR_HTTP2_PUSH_UNSUPPORTED`) and has no `respondWithFile`/`respondWithFD`, ALTSVC or ORIGIN frames, h2c `Upgrade` from HTTP/1.1, `allowHTTP1`, or session and stream timeouts. HTTP/3 over QUIC is not started
- Guest-side `fetch` is implemented: a request goes out on the container's own `http` and `https` client, so a URL on the virtual network reaches the server listening there (measured against host Node 24.15 on the same script: a 200 over `http://127.0.0.1`, its body, and a POST with a body and headers all agree, and an unreachable host rejects as `TypeError: fetch failed` with `ENOTFOUND` on `err.cause`) and there is no host network behind it. `Headers`, `Request`, `Response` and `FormData` are globals beside it — one script covering status, `text()`, `json()`, a response header, a POST with a string body, a `FormData` body sent as `multipart/form-data`, an abort through `AbortSignal` (which rejects with the signal's own `AbortError`, not with `fetch failed`), an unreachable host, and `typeof` plus a construct-and-read round trip for all four classes is byte-identical to host Node 24.15, as is the streaming half: `Request` and `Response` expose `.body` as a real `ReadableStream` (async iteration, `getReader()`, `clone()` of a stream body through `tee()`, and `bodyUsed` flipping once the stream is pulled all agree with host Node 24.15) — what is still missing is `.formData()` on both, so a multipart body is never parsed back into a `FormData`, and the boundary this container generates is `----formdata-owc-<24 random alphanumerics>` where undici's is `----formdata-undici-<12 digits>`. A stream body still needs the `duplex` option Node asks for and is refused with `RequestInit: duplex option is required when sending a body.` The `WebSocket` global is a client over the same sockets: the handshake, a text frame, a binary frame, the negotiated subprotocol and the close handshake were measured against host Node 24.15 and agree, and the close event fires the way Node's does — when the connection ends, not when the peer's close frame arrives, so a server that sends a close frame and keeps the socket leaves the client at `readyState` 2 (CLOSING) indefinitely, and the event is a real `CloseEvent`; there is no WebSocket server and no `EventSource`. `undici`'s own module is served over the same client
- `zlib` native handle protocol: pngjs's synchronous decoder reads `zlib.Inflate` internals (`_handle`, `_processChunk`) and fails; both are `undefined` here, where Node has an object and a function. The public `zlib` APIs work
- WebAssembly packages: `hash-wasm` (sha256 and md5) and `cheerio` (selectors and `$.html()`) match Node 24.15 byte for byte. `sql.js` does not run: even `new SQL.Database()` throws `ERR_WASM_TRAP: Cannot convert a BigInt value to a number` (sql.js 1.13.0 and 1.15.1, with or without `locateFile`), so the i64 values its build moves across the boundary stop it at the first call. A memory still crosses the boundary in 1 MiB chunks per call
- Native addons: a compiled binary cannot run, so `process.versions.napi`, `process.dlopen` and a `.node` require serve a JavaScript reimplementation from `src/napi`: `bcrypt` (verified: `hashSync`/`compareSync` round-trip), `sodium-native`, `better-sqlite3` (SQLite 3.47.0 transpiled to plain JS), `leveldown`, `rocksdb` and `rocksdb-native`, `node-pty`, `canvas` and `sharp`. `sodium_malloc` returns an ordinary zero-filled Buffer, and `sodium_mprotect_*` and `sodium_mlock` are no-ops: the container has no guarded heap and cannot lock memory, so libsodium's memory hardening is unavailable, though computed values are unaffected. `esbuild` ships a Go binary rather than an add-on: `npm install esbuild` fails in its postinstall with `npm error code ENOEXEC`, naming `/app/node_modules/@esbuild/linux-x64/bin/esbuild` as the binary this container cannot execute, and the installed bin then fails with `spawnSync /app/node_modules/@esbuild/linux-x64/bin/esbuild ENOENT` and exit 1
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
- [ ] URL: IPv4/IPv6 host normalisation -- `new URL('http://0x7f.1/').hostname` is `0x7f.1`, host Node gives `127.0.0.1` (row owc-url-host-ipv4-ipv6-normalisation)
- [ ] URL percent-encoding -- `u.hash = '#a b'` leaves a raw space and `new URL('http://h/ü').href` keeps `ü` (row owc-url-percent-encoding)
- [ ] URL forbidden host code points -- `new URL('http://a b/')` is accepted where host Node throws (row owc-url-forbidden-host-code-points)
- [ ] URL file: scheme -- `new URL('file:/a').href` is `file://a/` where host Node gives `file:///a` (row owc-url-file-scheme-host)
- [ ] url module legacy API -- `require('url').domainToASCII` is absent and `url.parse(...).href` writes a stray `=` before the fragment (row owc-url-module-legacy-api)
- [ ] Builtin module namespace surface -- far wider than `node:fs`: against host Node the namespaces of 20 of 26 builtins are short (`node:constants` 56 against 231, `node:process` 36 against 83, `node:crypto` 30 against 70, `node:util` 22 against 35), `node:util` adds 5 names host Node lacks, and `node:stream/consumers` and `node:assert/strict` do not resolve at all (row owc-esm-builtin-namespace-surface)
- [x] Namespace mutation error text -- `ns.default = 1` reports QuickJS's `'default' is read-only`, not Node's message (row owc-esm-namespace-mutation-error-text)
- [ ] `cmd 3>f >&3` -- a descriptor the command itself opened is not visible to its own later `>&n` (row owc-shell-fd-opened-by-command-visible-to-itself)
- [ ] `exec >f`, `exec 2>f` and `exec 1>&2` are dropped, so they do not persist (row owc-shell-exec-standard-fd-dropped)
- [ ] `exec 3>&1` and `exec 3>&2` are "Bad file descriptor" where a host duplicates the standard one (row owc-shell-exec-duplicating-standard-fd)
- [ ] `exec 3<f; cat <&3` reads nothing -- input descriptors above 2 are not implemented (row owc-shell-exec-input-fd)
- [ ] a failing `exec` does not end a non-interactive shell (row owc-shell-exec-failure-does-not-end-shell)
- [ ] `echo hi >&-` writes and succeeds where a host reports a write error (row owc-shell-closed-fd-write-error)
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
- `owc-esm-require-tla-context-lines`: `require('./tla.mjs')` on a graph with top-level await -- the
  host prints two context lines above the require stack (`  From <app>/main.js` and
  `  Requiring <app>/tla.mjs`), the container prints the `- <app>/main.js` stack line only.
- `owc-node-missing-entry-dump`: `node <missing>` -- the host prints its loader dump (eight
  `node:internal/modules/cjs/loader` frames, `code: 'MODULE_NOT_FOUND'`), the container prints the
  single line `Error: Cannot find module '<path>'`.
- `owc-node-check-syntax-message`: `node --check bad.js` -- the host reports `SyntaxError: Function
  statements require a function name` with a caret under `function`, the container reports
  `SyntaxError: function name expected` with the caret elsewhere and no `Node.js v24.15.0` trailer.
- `owc-node-spawned-command-redirect`: a spawned command used with a redirection or inside a
  subshell or `if` -- `node - < main.js`, `node main.js > out.txt`, `(node --version)` -- is refused
  with `node: cannot run here: it can only be run on a line of its own` and exit 127, where the host
  runs the command. The root cause is the shell's, not node's: `splitCompoundLine` hands any line
  holding `<`, `>`, `(`, `)` or a backtick to the script engine, which cannot spawn.
