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

The root [Readme.md](../Readme.md) is the short, user-facing entry point. This page indexes the detail behind it.
