# Architecture

OpenWebContainer runs a Node-like environment entirely inside a browser page. There is no host Node process and no Docker daemon. The layers below are the real paths on `origin/main`.

## Browser page and Web Worker

- `apps/playground/` — the React + Vite playground: `src/App.tsx`, a Monaco editor, an xterm terminal, a file explorer, and a preview pane. `src/hooks/useContainer.ts` holds **one** `ContainerManager` for the page's lifetime.
- `packages/api/` — the browser-facing layer. `ContainerManager` (`src/container/container.ts`) owns a `WorkerBridge` (`src/worker/bridge.ts`), exposes `VirtualProcess` (`src/process/process.ts`), and previews through `IframeBridge` (`src/iframe/bridge.ts`).
- `WorkerBridge` imports `workerCode` from `@open-web-container/core/worker-code`, wraps it in a `Blob`, and starts `new Worker(URL.createObjectURL(blob))`. `packages/core/src/worker-entry.ts` holds the worker's `self.onmessage` switch and constructs `OpenWebContainer`.
- `WorkerInitOptions` carries `coep?: 'require-corp' | 'credentialless' | 'none'`; `WorkerBridge` fixes it at first boot, so it cannot be changed on a later reboot. `ContainerOptions` in `packages/api/src/container/types.ts` also carries `debug`, `maxProcesses`, `memoryLimit`, `coep`, `onServerListen` and `onServerClose` (defaults: `debug=false`, `maxProcesses=10`, `memoryLimit=512MB`, `coep='none'`).

## QuickJS and the guest runtime

- `packages/core/package.json` depends on `quickjs-emscripten` `^0.32.0` and the `@jitl/quickjs-singlefile-browser-release-*` variants. `packages/core/src/process/executors/node/process.ts` creates the runtime with `newQuickJSAsyncWASMModuleFromVariant`.
- QuickJS is built **without WebAssembly**, so guest WebAssembly is supplied by the host realm (`packages/core/src/process/executors/node/runtime/wasm-host.ts`, `WasmBridge` and `installWasmBridge`).
- `installHostBridge(context, deps)` in `packages/core/src/process/executors/node/runtime/host-bridge.ts` installs the host object inside the QuickJS context; it is called from `bootWith` in `node/process.ts`. Every capability call from guest code crosses this bridge.
- `BOOTSTRAP_SRC` in `packages/core/src/process/executors/node/runtime/bootstrap.ts` is one expression evaluated once per QuickJS context (`owc-bootstrap.js`). It receives the host bridge and returns the guest API (`runMain`, `fire`, `deliver`, `settle`, `keysOf`, `exportsOf`, `finalExitCode`, ...). It concatenates the guest sources: codec, loader, spine, path events, util/assert, buffer-fs, misc, globals, wasm and the built-in modules.
- `NODE_VERSION` in `runtime/guest/globals.ts` is `v24.15.0`, the host version the differential measurements target.

## Virtual file system

- `packages/core/src/filesystem/zenfs-core.ts` (`ZenFSCore`) imports `@zenfs/core` `^1.3.3`; `zenfs-listing.ts` and `virtual-fs.ts` complete the surface. `OpenWebContainer` constructs `new ZenFSCore()`.
- File operations are synchronous inside the worker. `writeFile(path, content: string | Uint8Array)` stores bytes for a `Uint8Array` and text for a string; `readFileBytes` reads bytes back. Writing binary decoded as UTF-8 is lossy, so use bytes for WASM and other binary files.
- A sparse-file write is recorded as parts rather than a buffer the size of the hole (`runtime/guest/buffer-fs.ts`), so a 5-byte write at a 1 GiB offset costs only the bytes written.

## Processes and shell

- `packages/core/src/process/` holds `Process`, `ProcessRegistry`, `ProcessManager`, the event emitter and `ProcessEvent` (`start`, `exit`, `error`, `message`, `spawn_child`).
- `packages/core/src/process/executors/` holds the three executors registered by `OpenWebContainer`: `node/executor.ts` (`NodeProcessExecutor`), `shell/executor.ts` (`ShellProcessExecutor`) and `npm/executor.ts` (`NpmProcessExecutor`). `packages/core/src/npm/installer.ts` (`NpmInstaller`) handles registry installs.
- `child_process` spawning, worker_threads and cluster are guest capabilities implemented over container processes.
- The runaway-guest guard is one QuickJS interrupt handler per runtime, carrying `guestBudgetMs` (default 30000; `0` disarms it). It interrupts an *uninterrupted stretch* of guest execution that made no host call; every host call, await or timer restarts the budget. There is no second host thread that can preempt a busy worker.

## Virtual network

- `packages/core/src/network/virtual/hub.ts` exports `VirtualNetwork`, a loopback TCP/UDP network between processes of one container with a virtual name table and path-carried Unix domain sockets. `network/virtual/host-http.ts` is the host HTTP bridge.
- `NetworkManager` (`packages/core/src/network/manager.ts`) registers servers and collects stats; `OpenWebContainer` exposes it as `readonly networkManager`.
- `net`, `dgram`, `dns`, `http`, `https` and `http2` are served over this network inside the guest. There is **no outbound raw TCP/UDP**; external requests go through the page's `fetch` when the browser host is involved. Guest `fetch` is the container's own `undici` module over its own `http`/`https` client, not the browser's or host Node's undici.

## Service-worker preview gateway

- `apps/playground/public/owc-sw.js` intercepts `/__owc/preview/<port>/<path>` (`PREVIEW_PATH_PREFIX = '/__owc/preview/'`) and posts each request to a window client.
- `apps/playground/src/preview/gateway.ts` (`PREVIEW_PREFIX = '/__owc/preview'`) starts `startPreviewGateway(handle)` and hands each service-worker request to the app's handler, which forwards it through the worker bridge to the guest HTTP server on that port; the response goes back over the `MessagePort` the service worker supplied. `IframeBridge` (`packages/api/src/iframe/bridge.ts`) is used by `ContainerManager.createPreview` for iframe previews.
- This is the only external ingress: **HTTP only**, no raw sockets. The diagram in `images/architecture.png` shows the page, bridge, worker and runtime layers.

## Where to go next

- [API reference](api.md) for the exact method and event signatures.
- [Compatibility](compatibility.md) and [Known limitations](known-limitations.md) for the measured boundaries.
- [Development](development.md) for the build order.
