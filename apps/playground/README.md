# The OpenWebContainer playground

`apps/playground` is the browser front end for the container runtime. It is a React + Vite single-page IDE: an xterm terminal, a Monaco editor, a file explorer, and a preview pane for HTTP servers running inside the container. It holds one `ContainerManager` (`@open-web-container/api`) for the lifetime of the page and boots the runtime as a Web Worker.

## Start it

From the repository root:

```bash
pnpm install
pnpm playground   # turbo run dev --filter='@open-web-container/playground'
# or
pnpm dev          # all packages in parallel
```

Or from this directory: `pnpm dev` (which is `vite`), `pnpm build` (`tsc -b && vite build`), `pnpm preview`, `pnpm check-types` (`tsc -b --noEmit`, which type-checks both the app and node projects).

Open <http://localhost:5173>. `vite.config.ts` sets no `server.port`, so Vite's default 5173 is used. It does declare `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for both `server` and `preview`; verify the headers your deployment actually serves before relying on `SharedArrayBuffer` (see [Known limitations](../../docs/known-limitations.md)).

## Preview ports

A guest HTTP server listening on a container port is reached through the service worker in `public/owc-sw.js`:

```
http://localhost:5173/__owc/preview/<port>/<path>
```

`src/preview/gateway.ts` exposes `startPreviewGateway(handle)`; it hands each request to the app's `PreviewHandler`, which reaches the guest HTTP server on that port. This is HTTP ingress only — the virtual network has no outbound raw TCP or UDP.

## Documentation

- [Documentation index](../../docs/README.md)
- [Getting started](../../docs/getting-started.md) — first container, first `node`/`sh` command, preview ports
- [Architecture](../../docs/architecture.md) — worker, QuickJS, ZenFS, virtual network, gateway
- [API reference](../../docs/api.md) — real `ContainerManager` and `OpenWebContainer` methods
- [Known limitations](../../docs/known-limitations.md)
- [Compatibility](../../docs/compatibility.md)
- [Development](../../docs/development.md)
- [Troubleshooting](../../docs/troubleshooting.md)
