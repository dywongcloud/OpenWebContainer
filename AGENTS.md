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

- Next 16.4.6 defaults to **Turbopack**: `dist/lib/bundler.js parseBundlerArgs()` returns
  `Bundler.Turbopack` and sets `TURBOPACK=auto` when no bundler flag is given, so a stock
  scaffold's `npm run dev` / `npm run build` use Turbopack, not webpack. The published
  `napi/next-swc` shim has no `turbo.createProject` implementation and refuses
  `projectNew` (`ERR_OWC_SWC_NATIVE_UNAVAILABLE`). Every witness that passes an explicit
  `--webpack` covers only that route; do not claim stock dev/build works from it.

- `next build --webpack --experimental-build-mode compile` skips static generation and
  printed `✓ Compiled successfully in 59.0min` on the published RSC-fixed tree. That is a
  real green compiler witness, but NOT a green default build: no `Route (app)`, no static
  generation, no process exit 0. Default `next build` prerenders through `getRSCPayload`,
  which is the same path that dev hits below.

- The guest `async_hooks` shim (`runtime/guest/modules/pure-a.ts`) fails **closed** across
  native `await`: QuickJS attaches async continuations with intrinsic `PerformPromiseThen`,
  which never consults the patched `Promise.prototype.then`. `workAsyncStorage.getStore()`
  is therefore `undefined` inside Next 16 dev/prerender and throws
  `Invariant: Expected workStore to be initialized` (an error-payload path; the primary
  error is the same invariant on the normal `getRSCPayload` path). Measured in bare QuickJS:
  `await 1`, `await "x"`, `await {then:...}` fire ZERO JS-visible hooks; a
  `Promise.prototype.constructor` getter fires only for real promises; `globalThis.Promise`
  is not read at await time; no promise/job hook is exposed by quickjs-emscripten 0.32.0
  and `QTS_ExecutePendingJob` returns only a job count, not job identity. Three independent
  adversarial passes found NO safe pure-JS shim fix. Sticky-frame, reenter, contiguous-job
  and "exactly one active run" fallbacks all CROSS-CONTAMINATE overlapping request chains
  (one request's auth/session store read by another) — never publish them. A correct fix
  needs either an engine-level AsyncContextFrame on each QuickJS job or a loader source
  transform (`await X` -> `await __owcAwait(X)`) with a general parser; neither is
  witnessed. A source transform verified in bare QuickJS still needs a Next-seeded
  parser and touches CJS, `new Function`, ESM/TLA and `eval` compile paths.
