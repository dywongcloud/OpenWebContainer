# Documentation index

Every page here describes the code on `origin/main`, not the diverged local working tree.

| Page | One-line summary |
| --- | --- |
| [getting-started.md](getting-started.md) | Prerequisites, install, launch the playground, first container, first `node`/`sh` command, preview ports. |
| [architecture.md](architecture.md) | Web Worker + QuickJS, host bridge, guest bootstrap, ZenFS, process executors, virtual network hub, service-worker preview gateway, React UI. |
| [architecture.md#diagrams](architecture.md#diagrams) | Nine maintained Mermaid system diagrams: layers, boot sequence, package graph, capability bridge, VFS and npm install, virtual network, multi-tab preview gateway, WASM bridge, git dispatch. |
| [reference/state-machines.md](reference/state-machines.md) | Ten `stateDiagram-v2` machines with prose alternatives and transition tables: container, process, COEP lock, guest budget, preview routing, npm corpus retry gate, git dispatch, gateway registration, differential verdict, PRD row. |
| [api.md](api.md) | The real `OpenWebContainer` (core) and `ContainerManager` (api) methods, events and signatures. |
| [compatibility.md](compatibility.md) | The host Node target, differential method, spec baselines, WPT and swarm conformance numbers, and CI status. |
| [known-limitations.md](known-limitations.md) | User-facing compatibility boundaries, each with its measured basis. |
| [known-limitations.md#interactive-prompts-need-a-terminal-or-piped-input](known-limitations.md#interactive-prompts-need-a-terminal-or-piped-input) | Interactive CLI prompts need a project name or piped stdin; guest `process.stdin` has no `isTTY`. |
| [development.md](development.md) | Real scripts from every manifest, core build order, turbo tasks, contributing link. |
| [troubleshooting.md](troubleshooting.md) | Problems actually encountered in this repository's history. |
| [troubleshooting.md#npx-create-next-applatest](troubleshooting.md#npx-create-next-applatest) | `npx create-next-app@latest`: working invocations, the closed-stdin prompt boundary, and the mixed-bundle `settleIO` failure with its rebuild. |
| [reference/compatibility-notes.md](reference/compatibility-notes.md) | The entire former chronological `Readme.md`, byte-for-byte below a one-line header note. |
| [reference/isolation-boundaries.md](reference/isolation-boundaries.md) | The four measured host-isolation boundaries: COOP/COEP, `coep`, direct-TCP databases, guest undici parity. |
| [reference/commands.md](reference/commands.md) | Shell command reference and four per-family pages: [builtins](reference/commands-builtins.md), [builtins residual](reference/commands-builtins-residual.md), [text utilities](reference/commands-textutils.md), [system utilities](reference/commands-system.md). |
| [npm-global.md](reference/npm-global.md) | Measured global `npm install -g` cases against host npm 11.12.1: VFS prefix, bin links on `PATH`, the `require()` boundary and the superseded archive refusal. |
| [vfs-isolation.md](reference/vfs-isolation.md) | Measured VFS isolation is realm-scoped (one module-level mount), not per-container, so a fresh node process per boot is the clean-isolation path. |
| [reference/commands-git.md](reference/commands-git.md) | Local git runs as a shell module command over the VFS (object store, index, refs); remote transports against a real remote are named boundaries reporting the project [CODE] not supported on this runtime outcome with exit 1; archive :505/:508/:511 are SUPERSEDED, while the verbatim archive stays unchanged. |

The root [Readme.md](../Readme.md) is the short, user-facing entry point. This page indexes the detail behind it.

Current git surface (origin/main after 55b024e): 43 runCommand cases including bisect, fsck, backfill and local-path fetch/push/pull/ls-remote, and 18 declared UNSUPPORTED git-* keys, all reachable from boundaryFamily. Remote .git/config subcommands and local-path transport are local VFS operations; URL transports remain canonical [ERR_*] boundaries. An unrecognised `git <name>` returns a generic not-a-git-command line, never a bare 127.

## Diagram conventions

The maintained diagrams are fenced Mermaid blocks in `../Readme.md`, `architecture.md`, `api.md`, `getting-started.md` and `reference/state-machines.md`. GitHub renders them as SVG and selects the Mermaid theme from the reader's light or dark colour mode. No block assigns `classDef`, `style` or a custom palette: there is no categorical colour series, so no state or node is conveyed by colour alone. Shapes, arrow labels and the surrounding prose carry the meaning.

Every block is followed by a **Text alternative** that restates the same information in prose; every state machine also has a state/event/next-state table. Diagrams are ASCII-only text, so they survive a terminal reader, a diff and a forced-colours browser. Every product diagram names the pinned repository path and line numbers it was read from; the workflow machines name the repository artifacts and served rules they describe. A citation names a source, not a claim that the named command is complete or host-faithful. The older `images/architecture.png` raster is kept as the original overview, not treated as the maintained source.

| Page | Diagrams | Type |
| --- | --- | --- |
| [Readme.md](../Readme.md) | System architecture at a glance, container lifecycle | flowchart, stateDiagram-v2 |
| [architecture.md](architecture.md) | Layered architecture, boot sequence, package graph, capability bridge, VFS and npm install, virtual network, preview gateway, WASM bridge, git dispatch | flowchart, sequenceDiagram |
| [api.md](api.md) | Boot/spawn/preview sequence, exported surfaces, VirtualProcess events | sequenceDiagram, classDiagram, stateDiagram-v2 |
| [getting-started.md](getting-started.md) | First-run flow | flowchart |
| [reference/state-machines.md](reference/state-machines.md) | Container, process, COEP lock, guest budget, preview routing, npm retry gate, git dispatch, gateway registration, differential verdict, PRD row | stateDiagram-v2 |

### Verification witness

All 25 blocks were parsed and rendered to SVG with Mermaid **11.4.1** (`https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js`) in headful Chrome through the `gm.browser` CDP verb. Procedure: read every fenced Mermaid block from the five diagram-bearing files, call `mermaid.parse` and then `mermaid.render` once with `theme: default` and once with `theme: dark`, and require each result to contain an SVG element. Measured result: 50 records, 50 parses PASS, 50 renders PASS, 50 SVG, 0 errors, 0 console events. Witness dispatch `1794297750994-3730-85a4fdfe49a94f91`, which rendered the 25 blocks as they stand at this tip. The witness covers the fenced blocks, which prose edits to this page never change. The harness files live outside the repository; the version, the procedure and the counts are pinned here so the check is reproducible from any checkout.

Note: the verbatim former chronological `Readme.md` archive keeps its links byte-for-byte, and they are root-relative, so the links on lines 6 (LICENSE), 7 (CONTRIBUTING.md), 41 (./images/architecture.png), 1392 (CONTRIBUTING.md) and 1476 (LICENSE) do not resolve from `docs/reference/`; the real targets are the root [LICENSE](../LICENSE), [CONTRIBUTING.md](../CONTRIBUTING.md) and [images/architecture.png](../images/architecture.png).
