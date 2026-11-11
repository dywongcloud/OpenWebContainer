# Troubleshooting

Only problems actually observed in this repository's history are listed here. For the underlying measurements, see the [compatibility notes archive](reference/compatibility-notes.md).

## A guest that runs away

A `while (true) {}` or any long stretch of guest code with no host call blocks the worker's single thread. Nothing on the host can end it: a runner `timeout` is only read between event-loop steps. The container stops it **from the inside** with one QuickJS interrupt handler per runtime.

- Default budget: **30000 ms** (`new OpenWebContainer({ guestBudgetMs: ms })`); `0` disarms it.
- Measured: `while (true) {}` stopped at 30155 ms with `Error: Script execution timed out after 30000ms` and exit 1; with a 3000 ms budget, at 3243 ms.
- The budget bounds one **uninterrupted stretch**, not wall-clock time: every host call, await, timer wait or event-loop step restarts it. A 54.8 s run of 5000 synchronous file writes finishes normally with status 0.
- The same interrupt handler carries a `spawn`'s `timeout`, which is why `spawn('node', [busy 5 s], { timeout: 400, killSignal: 'SIGKILL' })` closes on time where a bare `child.kill()` on a busy child has no moment at which to run.
- There is no second host thread to preempt a busy worker. Bare QuickJS 0.32 armed with `setTimeout(..., 100)` before a 3 s guest loop fires at 3012 ms, not 100 ms.

If the terminal stops answering during a long install, this is the cause; see `listFilesPaced()` in the [API reference](api.md), which slices a whole-tree walk so a foreground child keeps the thread.

## `npx create-next-app@latest`

The command works when it is given a project name and `--yes`. On the live `:5173` playground, `npx create-next-app@latest my-app --yes --skip-install` prints `Success! Created my-app at /my-app` with exit 0 and empty stderr, and `npx create-next-app@latest --help` prints the full option list.

**A bare `npx create-next-app@latest` prompts at the terminal.** With no project name the CLI prints `? What is your project named?` and waits: the foreground job owns the terminal, its stdin stays open and reports `isTTY`, and typing a name plus Enter (or `y`/`n`, arrow keys, Ctrl-C) is delivered to the running CLI. The playground pane forwards xterm's `onData` byte stream, so the prompt's redraw, cursor editing and list navigation work as they do on a host terminal. On a run with no terminal -- `sh -c <line>`, a pipe, or a direct `spawn` -- stdin is closed and the CLI still exits 0 after printing only that prompt, with no directory created; host npm 11.12.1 on Node v24.15.0 with a closed stdin does the same. Name the project on the command line for those paths: `npx create-next-app@latest my-app --yes`. The interactive path was closed by PRD row `owc-next-plain-prompt-no-app`. A piped stdin does not reach a prompt in the container. Host npm with `pipe-app\n` on stdin exits 0 in 27782 ms after `added 360 packages`, `Types generated successfully`, `Initialized a git repository` and `Success! Created pipe-app`. On a cold cache the container npx shim prints a two-line `Need to install the following packages:` notice even under `--yes`; host npm with a warm cache does not. That difference is stdout-only: exit code and stderr matched in all 8 pairs of a two-memory-point differential run.

**`ReferenceError: 'settleIO' is not defined` means a mixed bundle.** The guest bootstrap is one IIFE joined from ten snippets in `packages/core/src/process/executors/node/runtime/bootstrap.ts`. If `LOADER_SRC` comes from one source revision and `BUFFER_FS_SRC` or `GLOBALS_SRC` from another, `settleIO` is undeclared while `settleRequest` still calls it; the first async `readdir` inside `@nodelib/fs.scandir` `readdirWithFileTypes` then fails with exit 1. `packages/core/dist` is ignored by git, so a stale bundle survives a source update. Rebuild both steps from one revision (`pnpm build:worker` then `pnpm build:main` in `packages/core`) and restart the dev server. Check that `dist/index.js`, `dist/index.cjs`, `dist/worker-code.js`, `dist/worker-code.cjs` and `dist/worker.global.js` each contain exactly one `function settleIO(`. The worker build `onSuccess` hook in `tsup.config.ts` now refuses the build with a named diagnostic when that count is not one, instead of emitting a broken `src/generated/worker-code.ts`.

A full install without `--skip-install` runs `next typegen` as a child after npm installs dependencies; see [A guest that runs away](#a-guest-that-runs-away) for the 30000 ms uninterrupted-execution budget that bounds a child on the single host thread.

## A shared Chrome window taken by another lane

The browser used for live measurements is one headful window per project root, leased across lanes. A `browser`/`chrome` call takes the lease and **waits for the holder**; it never kills or reuses another agent's window, and the window closes after 15 minutes with no holder or waiter. If a measurement appears stuck, it is usually waiting on that lease. Do not call `browser_reset` on someone else's window — it closes it and gives up their lease. Use a distinct session and wait.

## The shared working tree is far behind `origin/main`

The checkout is a shared tree that other lanes also write. It has been measured at **154 commits ahead / 582 behind** `origin/main`; the exact count moves as lanes publish. Never assume the working tree is the tip:

- Read ground truth from `origin/main` through `gh api repos/dywongcloud/OpenWebContainer/contents/<path>?ref=main` or the git tree API.
- Publish with a temporary index built on `origin/main`'s **own blobs**: `GIT_INDEX_FILE` pointing at a temp file, `read-tree origin/main`, `hash-object -w` for your blobs, `update-index --cacheinfo` for only your paths, `write-tree`, then `commit-tree -p origin/main`.
- Never reset local `main`, never push the diverged local lineage, and never copy stale working-tree blobs into the commit. A commit built from a moved tip has dropped whole sections of another lane's prose.
- When several lanes write the same file, re-read it immediately before **and** after the write and restore a dropped line by minimal insertion rather than rewriting the file.

`scripts/check-staged-secrets.mjs` uses `origin/main` as its diff base when `GIT_INDEX_FILE` is set, which is why the temp-index route is also the one that can certify staged bytes.

## No local compile unless builds are on

This repository's workflow does not run a local compile, build or test unless builds have explicitly been turned on; check that setting first. A change that needs a guest, runner or bundle build is pushed as **source** and built by CI, not by a local build in the shared checkout. Running a local `pnpm install` or `pnpm build` on the shared tree can also disturb other lanes. Note that `pnpm test` at the root is a failing placeholder (`echo "Error: no test specified" && exit 1`), and there is no `.github/workflows` on `origin/main`, so CI itself is unverified — see [Compatibility](compatibility.md).

## Disk filling with `/tmp` exports

Scratch exports under `/tmp` have twice filled the disk to zero bytes on this machine (`ENOSPC` then breaks the shell tooling). Keep **one scratch directory per lane**, clear old `/tmp/owc-*` exports when free space falls below a few GB, and never let an export outlive its lane. Avoid a full `pnpm install` in a scratch tree, and do not delete another lane's files.

## Still stuck?

- [Known limitations](known-limitations.md) — a boundary may be the actual explanation (no raw TCP, no CORS parity, no cross-origin isolation).
- [Getting started](getting-started.md) — verify the playground actually serves the COOP/COEP headers.
- [Development](development.md) — the real scripts and build order.
- [Architecture diagrams](architecture.md#diagrams) - nine maintained system diagrams, each with a text alternative.
- [Compatibility notes archive](reference/compatibility-notes.md) — the verbatim chronological record of every measured case (one header line precedes it).
