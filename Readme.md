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
  - Node built-ins: `path`, `events`, `util`, `assert`, `fs` (sync, callback and promises, plus read and write streams and file descriptors — `openSync`, `writeSync`, `readSync`, `closeSync`, `fstatSync`, `ftruncateSync` — over the virtual file system), `buffer`, `os`, `timers`, `url` (WHATWG URL and legacy `parse`/`resolve`/`format`), `crypto` (random values, `createHash`, `createHmac`, `pbkdf2`, `timingSafeEqual`, and `createCipheriv`/`createDecipheriv` over `@noble/ciphers`: AES-ECB, AES-CBC, AES-CTR, AES-CFB and AES-GCM at 128, 192 and 256 bits and ChaCha20-Poly1305, byte-identical to host Node 24.15 and with Node's `ERR_CRYPTO_INVALID_KEYLEN` and `ERR_CRYPTO_INVALID_IV` codes), `process` (including `chdir`/`cwd` over the virtual file system), `console`, `module`, `stream` and `readline`, `querystring`, `string_decoder`, `punycode`, `diagnostics_channel`, `async_hooks` (AsyncLocalStorage across timers, ticks and `.then` callbacks), `perf_hooks`, `v8`, `vm`, `domain`, `inspector` and `repl` (partial), `zlib` (gzip, deflate and raw, backed by fflate)
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
- **A trailing newline.** The container writes a command's stderr exactly as the command left it; the host
  adds one only where the text has none.

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

### 📋 Upcoming Features

- Additional shell commands
- Node built-ins not yet implemented or partial: `brotli` and `zstd` compression (both await the WebAssembly bridge — `zlib.brotliCompressSync` and `zlib.zstdCompressSync` exist and throw `ERR_NOT_SUPPORTED`); `crypto` ciphers work but the list behind them is short, so `getCiphers()` returns 16 names where Node 24.15 returns 130 and `aes-192-cfb8` is `ERR_CRYPTO_UNKNOWN_CIPHER` here although Node supports it; several stream helper edge cases; `inspector` sessions construct and `connect()`, but `post` fails with `Inspector protocol is not available in this runtime`; `repl` depth (basic evaluation works); `v8` serializer wire format (`serialize` emits JSON text); `module.register`; `process.kill` (`child.kill` with signals does work, but `process.kill(process.pid, 0)` returns `false` where Node returns `true`, and a signal sent to a process is accepted and discarded); `process.report` is `undefined`; the `WebSocket` global (the `ws` package works)
- TLS: `tls` and `https` implement TLS 1.3 only (no TLS 1.2, session resumption or 0-RTT); peers are verified against the `ca` option only (no system or built-in roots); pfx, passphrase-protected keys, Ed25519 and P-521 keys are not supported; only the X25519 and P-256 groups, the AES-GCM and ChaCha20-Poly1305 suites and ECDSA P-256/P-384, RSA-PSS and RSA PKCS#1 signatures are implemented, and an `ecdhCurve`, `ciphers` or `sigalgs` value that names only other algorithms throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; external `https` requests still go through the browser's `fetch`. `tls.DEFAULT_MIN_VERSION` still reports `TLSv1.2`, so nothing but a handshake tells you it is wrong: a client pinned to `minVersion`/`maxVersion` `TLSv1.2` fails with `ERR_SSL_NO_PROTOCOLS_AVAILABLE` (`no protocols available`) where host Node connects and reports `TLSv1.2`
- HTTP/2: `http2` does not send server push (`pushStream` reports `ERR_HTTP2_PUSH_UNSUPPORTED`) and has no `respondWithFile`/`respondWithFD`, ALTSVC or ORIGIN frames, h2c `Upgrade` from HTTP/1.1, `allowHTTP1`, or session and stream timeouts. HTTP/3 over QUIC is not started
- Guest-side `fetch` is not implemented: the global exists and every call rejects with `fetch is not supported by this runtime`. `undici` works instead: its HTTP/1 client runs because llhttp is WebAssembly, and it reaches a server inside the container (verified: a 200 over `http://127.0.0.1`)
- `zlib` native handle protocol: pngjs's synchronous decoder reads `zlib.Inflate` internals (`_handle`, `_processChunk`) and fails; both are `undefined` here, where Node has an object and a function. The public `zlib` APIs work
- WebAssembly packages: `hash-wasm` (sha256 and md5) and `cheerio` (selectors and `$.html()`) match Node 24.15 byte for byte. `sql.js` does not run: even `new SQL.Database()` throws `ERR_WASM_TRAP: Cannot convert a BigInt value to a number` (sql.js 1.13.0 and 1.15.1, with or without `locateFile`), so the i64 values its build moves across the boundary stop it at the first call. A memory still crosses the boundary in 1 MiB chunks per call
- Native addons: a compiled binary cannot run, so `process.versions.napi`, `process.dlopen` and a `.node` require serve a JavaScript reimplementation from `src/napi`: `bcrypt` (verified: `hashSync`/`compareSync` round-trip), `sodium-native`, `better-sqlite3` (SQLite 3.47.0 transpiled to plain JS), `leveldown` and `rocksdb`, `node-pty`, `canvas` and `sharp`. `sodium_malloc` returns an ordinary zero-filled Buffer, and `sodium_mprotect_*` and `sodium_mlock` are no-ops: the container has no guarded heap and cannot lock memory, so libsodium's memory hardening is unavailable, though computed values are unaffected. `esbuild` ships a Go binary rather than an add-on: `npm install esbuild` fails in its postinstall with `npm error code ENOEXEC`, naming `/app/node_modules/@esbuild/linux-x64/bin/esbuild` as the binary this container cannot execute, and the installed bin then fails with `spawnSync /app/node_modules/@esbuild/linux-x64/bin/esbuild ENOENT` and exit 1
- Utilities a browser container cannot have report it instead of exiting 127: `ping`, `dig`, `traceroute`, `nc`, `netstat`, `ss`, `ip`, `ifconfig`, `nft`, `systemctl`, `cron`, `crontab`, `chroot`, `su`, `sudo`, `usermod`, `groupadd`, `groupdel`, `lspci`, `iostat`, `vmstat`, `perf`, `tmux`, `vi`, `import`, `xclip`, `open` and `write` each write `<name>: not supported on this runtime: <reason>` and exit 1 — `ping` with `ERR_NO_RAW_SOCKET` and `lspci` with `ERR_NO_PCI_BUS`; `make` (variables, pattern rules, `.PHONY`, automatic variables), `bc` (arbitrary precision, `scale`, `sqrt`, `ibase`/`obase`) and an `openssl` subset (`dgst` with md5/sha1/sha224/sha256/sha384/sha512 and `-hmac`, those digests as shorthand commands, `rand -hex/-base64`, `version`) are implemented, and `man` answers from its own short pages (`man ls` prints `NAME`/`SYNOPSIS`, `man nosuchcmd` prints `No manual entry for nosuchcmd` and exits 1). `make --version` is not one of the implemented options: it exits 2 with `make: invalid option -- '-version'` where GNU Make prints its version
- The shell now provides the POSIX utilities as JavaScript over the virtual file system: the text filters (`grep`, `sed`, `awk`, `cut`, `sort`, `tr`, `paste`, `uniq`, `wc`, `head`, `tail`, `join`, `comm`, `diff`, `fmt`, `pr`, `tabs`), the file utilities (`find`, `xargs`, `stat`, `date`, `printf`, `expr`, `test`, `seq`, `base64`, `base32`, `xxd`, `split`, `install`, `ln`, `chown`, `chmod`, `du`, `df`, `tee`, `sleep`, `yes`, `basename`, `dirname`), the archives (`gzip`, `gunzip`, `zcat`, `compress`, `uncompress`, `tar`, `cpio`; no `bzip2` or `xz` codec is available), the shell builtins (`set`, `export`, `alias`, `type`, `trap`, `read`, `pushd`/`popd`, `source`), globbing (`*`, `?` and `[...]`, with an unmatched pattern left literal as the host leaves it) and the operators `;`, `&&`, `||`, `|`, `<`, `>`, `>>`, `2>&1` and `2>/dev/null`
- **`vm` `timeout` is enforced for JavaScript loops** — measured: `ERR_SCRIPT_EXECUTION_TIMEOUT` after 52 ms against 53 ms on host Node — but not for time spent inside a native built-in, which runs to completion past the deadline. `vm` contexts share one realm (an array made in a context is `instanceof Array` on the host, and its `constructor` is the host's `Array`; on host Node both are `false`)
- A `WebAssembly.Table` holds what the host will accept: a table of function type takes WebAssembly function objects, so a JavaScript function a guest `set`s is kept on the guest side (its own `get` returns it) while the module sees an empty slot
- `FinalizationRegistry` never runs cleanup callbacks (host Node fires one after `gc()`; this engine build has no GC observation), but a `WeakRef` target that becomes unreachable *is* collected — after allocation pressure `deref()` returns `undefined` where Node 24.15 still returns the target; `MessageChannel` delivers only inside the process
- Worker messages deliver a `Buffer` where Node delivers a `Uint8Array`
- QuickJS 0.31 printed `Assertion failed: list_empty(&rt->gc_obj_list)` at teardown after correct output (`mathjs`, `prettier`, `typescript`, `uglify-js`, `xlsx`, `jsdom`); the pinned 0.32 engine passes all six in the corpus. `prettier` 3.9.10 was re-measured here: its formatted output is byte-identical to host Node's
- `sass` compiles: dart-sass 1.106.0 `compileString` returns CSS byte-identical to host Node's, for a flat rule and for one that goes through `@use "sass:math"`. The hang this entry used to describe does not reproduce
- `AsyncLocalStorage` context is not carried across `await` (timers, ticks and `.then` callbacks do carry it): the store is present before the first `await` and `undefined` after it
- Shell: `;` separators and `|` pipes work — measured against this machine's `/bin/sh`, they agree on stdout, stderr and exit code — and so does globbing. What does not agree: `chmod` and `fs.chmodSync` succeed and change nothing, so `chmod 755 f; stat -c %a f` prints `644` where the host prints `755`; `touch a b c` creates only `a`, where the host creates all three; `ls -l`, `ls -a` and `ls -la` are accepted and ignored, so no long format and no dotfiles are ever printed
- `node` and `npm` run only on a line of their own: joined to another command with `;`, `&&` or `||`, or put in a pipeline, they write `<name>: cannot run here: it can only be run on a line of its own, where the shell can wait for it` (exit 127 for the command). `npm run` does work, including `pre`/`post` lifecycle scripts, `npm install` writes `package-lock.json` at lockfileVersion 3, and global installs are refused (`Global installs are not supported by this runtime`, exit 1)
- `npm install` of a package whose tree carries per-platform optional dependencies exits 1 where host npm exits 0: `typescript` reports `EBADPLATFORM` for `@typescript/typescript-aix-ppc64` and the rest, and `esbuild` reports `ENOEXEC`, and in both cases the package itself is installed
- `node --version` is resolved as a file, not a flag: it fails with `Cannot find module '/app/--version'` and exit 1, where host node prints `v24.15.0`. `npm --version` prints `10.9.0`. Every `node`/`npm` command's output is written twice, once as it is produced and once from the result the shell gets back
- Processes now match Node where this entry used to diverge: an unhandled promise rejection is reported with its error and ends the process with status 1, and a `domain` catches a rejection thrown inside a `.then` callback inside `d.run()` (`domain.promise` is the error's message in both)
- `readline` keypress events and terminal mode are partial: `readline.emitKeypressEvents` exists but no `keypress` event fires for a write on the stream, where Node delivers `{ ch: 'a', name: 'a' }`; `createInterface({ terminal: true })` does report `terminal === true`

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
