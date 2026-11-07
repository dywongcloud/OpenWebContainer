# Documentation index

Every page here describes the code on `origin/main`, not the diverged local working tree.

| Page | One-line summary |
| --- | --- |
| [getting-started.md](getting-started.md) | Prerequisites, install, launch the playground, first container, first `node`/`sh` command, preview ports. |
| [architecture.md](architecture.md) | Web Worker + QuickJS, host bridge, guest bootstrap, ZenFS, process executors, virtual network hub, service-worker preview gateway, React UI. |
| [api.md](api.md) | The real `OpenWebContainer` (core) and `ContainerManager` (api) methods, events and signatures. |
| [compatibility.md](compatibility.md) | The host Node target, differential method, spec baselines, WPT and swarm conformance numbers, and CI status. |
| [known-limitations.md](known-limitations.md) | User-facing compatibility boundaries, each with its measured basis. |
| [development.md](development.md) | Real scripts from every manifest, core build order, turbo tasks, contributing link. |
| [troubleshooting.md](troubleshooting.md) | Problems actually encountered in this repository's history. |
| [reference/compatibility-notes.md](reference/compatibility-notes.md) | The entire former chronological `Readme.md`, byte-for-byte below a one-line header note. |
| [reference/isolation-boundaries.md](reference/isolation-boundaries.md) | The four measured host-isolation boundaries: COOP/COEP, `coep`, direct-TCP databases, guest undici parity. |
| [reference/commands.md](reference/commands.md) | Shell command reference and four per-family pages: [builtins](reference/commands-builtins.md), [builtins residual](reference/commands-builtins-residual.md), [text utilities](reference/commands-textutils.md), [system utilities](reference/commands-system.md). |
| [npm-global.md](reference/npm-global.md) | Measured global `npm install -g` cases against host npm 11.12.1: VFS prefix, bin links on `PATH`, the `require()` boundary and the superseded archive refusal. |
| [vfs-isolation.md](reference/vfs-isolation.md) | Measured VFS isolation is realm-scoped (one module-level mount), not per-container, so a fresh node process per boot is the clean-isolation path. |

The root [Readme.md](../Readme.md) is the short, user-facing entry point. This page indexes the detail behind it.

Note: the verbatim former chronological `Readme.md` archive keeps its links byte-for-byte, and they are root-relative, so the links on lines 6 (LICENSE), 7 (CONTRIBUTING.md), 41 (./images/architecture.png), 1392 (CONTRIBUTING.md) and 1476 (LICENSE) do not resolve from `docs/reference/`; the real targets are the root [LICENSE](../LICENSE), [CONTRIBUTING.md](../CONTRIBUTING.md) and [images/architecture.png](../images/architecture.png).
