# Agent notes

- `:5173` loads the container worker from `packages/core/dist/worker-code.js` (the
  `@open-web-container/core/worker-code` export), not from `src/`. After editing any
  guest runtime snippet under `packages/core/src/process/executors/node/runtime/guest/`,
  rebuild both steps from one revision in `packages/core` (`BUILD_TARGET=worker tsup`,
  then `tsup`) and restart Vite with `--force`. A stale bundle keeps the old behavior
  even after the source is fixed; this made an interactive-prompt fix look ineffective
  until the bundle was rebuilt. `tsup.config.ts` refuses a mixed bundle when
  `dist/worker.global.js` has other than one `function settleIO(`.

- The playground resolves `@open-web-container/api` from `packages/api/dist/*.js`, not from
  `packages/api/src`. After editing an API source file, run `tsc` in `packages/api` and restart
  Vite with `--force`; otherwise the edit is invisible at runtime.

- The shared checkout can be a mixed source revision: a JIT run that imports
  `packages/core/src/index.ts` directly once failed with
  `ReferenceError: 'settleIO' is not defined` while the built worker was fine. When a
  source-level JIT witness must be trusted, export a clean tree from `origin/main`
  (`gh api .../git/trees/main?recursive=1` + blobs) and witness against that.

- A webpack `next build --webpack` inside the QuickJS guest is SLOW, not deadlocked. A
  witness that logged only `buildModule`/`succeedModule` for the first 5 modules and then
  every 200th made 150+ modules of steady progress look like a frozen build (`chars=744`
  constant); log every module, or every 25th, before diagnosing a hang. Absolute timings
  are unusable when the host is loaded: at load average 58-207 the harness's own 1-second
  timers took 37-130 s of wall time, and guest time ran ~0.5x wall time. Judge only
  within-run ratios.

- JIT build/dev harnesses under `/tmp/owc-harness/` write their own `/app/next.config.js`
  with `config.cache = false` and `experimental.webpackBuildWorker = false`. A stock
  `npx create-next-app@latest` app has neither, so a build or a rendered dev page from
  such a harness does not prove the stock app behaves the same. Witness the stock
  config separately; do not infer a deadlock from a short window.
