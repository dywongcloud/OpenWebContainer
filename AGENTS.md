# Agent notes

- `:5173` loads the container worker from `packages/core/dist/worker-code.js` (the
  `@open-web-container/core/worker-code` export), not from `src/`. After editing any
  guest runtime snippet under `packages/core/src/process/executors/node/runtime/guest/`,
  rebuild both steps from one revision in `packages/core` (`BUILD_TARGET=worker tsup`,
  then `tsup`) and restart Vite with `--force`. A stale bundle keeps the old behavior
  even after the source is fixed; this made an interactive-prompt fix look ineffective
  until the bundle was rebuilt. `tsup.config.ts` refuses a mixed bundle when
  `dist/worker.global.js` has other than one `function settleIO(`.
  `packages/core/dist` is gitignored (`DIST_TRACKED_FILES: 0`), so a fresh clone of
  `origin/main` does NOT carry the served bundle; rebuild it before any browser witness.

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
  config separately; do not infer a deadlock from a short window. The gap is wider than
  those two keys: the recommended-defaults `app-tw` scaffold injects a `turbopack.rules`
  Tailwind webpack-loader entry into `next.config.ts`, drops `postcss.config.mjs`, and
  installs `@tailwindcss/turbopack` instead of `@tailwindcss/postcss`. Warranting a
  stock-config claim needs that generated config, not just removing the harness keys.

- A terminal-attached guest stdio stream (`OWC_TERMINAL=1`) must carry the four
  `tty.WriteStream.prototype` cursor helpers `clearLine`, `clearScreenDown`, `cursorTo`
  and `moveCursor`. Host Node 24 has all four; a piped host stream has none. Before
  `a4845d9` the guest set `isTTY=true` without them, so the real bundled `ora` spinner
  threw `TypeError: not a function` at `clear -> stop -> stopAndPersist`. In DEFAULT
  `next build --webpack` that throw is swallowed by `startTypeChecking`'s bare
  `.catch(() => process.exit(1))`, so the build printed only `Running TypeScript .`
  and returned to the shell with NO error text — do not diagnose that as a hang or a
  TypeScript failure. In compile mode it surfaced as `> Build error occurred`.
  `a4845d9` installs the four methods inside the existing `owcTerminalAttached` guard;
  each resolves `requireBuiltin('readline')` at CALL TIME because that builtin is
  registered by a MODULE_SRC which runs after `GLOBALS_SRC` (eager capture holds
  `undefined` forever — refuted). Piped runs must keep none of the four.

- Next 16.4.6 defaults to **Turbopack**: `dist/lib/bundler.js parseBundlerArgs()` returns
  `Bundler.Turbopack` and sets `TURBOPACK=auto` when no bundler flag is given, so a stock
  scaffold's `npm run dev` / `npm run build` use Turbopack, not webpack. The published
  `napi/next-swc` shim has no `turbo.createProject` implementation and refuses
  `projectNew` (`ERR_OWC_SWC_NATIVE_UNAVAILABLE`). Every witness that passes an explicit
  `--webpack` covers only that route; do not claim stock dev/build works from it.
  `dist/lib/bundler.js:125-126` honours `IS_WEBPACK_TEST` to force webpack for plain
  scripts, but that is a test-only flag: any competing bundler flag then hard-exits
  (`process.exit(1)`), it is container-wide if published in `default-env.ts`, and it
  only routes stock scripts to the SAME `--webpack` path that still hits the ALS
  invariant below. It is NOT a fix; two independent reviews returned NOT_VIABLE.
  Both no-flag stock routes are now WITNESSED end-to-end on the published tree
  (`/tmp/owc-harness/stock-route-result.json` and `stock-build-result.json`):
  plain `next dev` prints `▲ Next.js 16.4.6 (Turbopack)`, `✓ Ready in 26.7s`
  then `ERR_OWC_SWC_NATIVE_UNAVAILABLE` at `createProject
  (.../build/swc/index.js:916:49)`; plain `next build` prints the same banner,
  `Creating an optimized production build ...`, `> Build error occurred` and the
  same refusal. Note the dev banner prints Ready BEFORE createProject throws.
  A `turbo.createProject` implementation cannot be a Babel shim.

- `next build --webpack --experimental-build-mode compile` skips static generation and
  printed `✓ Compiled successfully in 59.0min` on the published RSC-fixed tree. That is a
  real green compiler witness, but NOT a green default build: no `Route (app)`, no static
  generation, no process exit 0. A longer bound on that same tree then reached
  `✓ Compiled successfully in 64.9min`, `Collecting page data using 4 workers` and
  `> Build error occurred / TypeError: not a function` at the `ora` spinner (the TTY
  gotcha above). `a4845d9` removed that throw: the compile-mode witness on that tree
  reached `✓ Compiled successfully in 64.5min` and
  `✓ Collecting page data using 4 workers in 52ms` with zero `TypeError`. `Route (app)`
  and process exit 0 were still NOT witnessed by it. `build/index.js:2907-2910` calls
  `printTreeView` unconditionally, so compile mode CAN print a route table; that would
  still not be a green DEFAULT build (static generation is skipped at `:1799`).
  Default `next build` prerenders through `getRSCPayload`, which is the same path that
  dev hits below.

- One bounded Pages Router dev witness (`dev-page-pagesfull-result.json`) returned a
  genuine 1184-byte Next HTML document with `<h1>hello</h1>` and `__NEXT_DATA__`,
  but its raw `statusLines` contain 13 `TIMEOUT` and 13 `ECONNRESET` before the
  single `STATUS=200`. Quote those, not just the successful response. The raw log
  shows why they are NOT random flakiness: `✓ Ready in 11.4s`, `○ Compiling / ...`,
  then A1..A13 each timing out at the client's 50s bound, with NO `✓ Compiled`
  line; A14 (after ~1030s total) is the first 200. It is a SLOW-COMPILE artifact
  (see the first bullet), not a 1/14 success rate — but no request succeeded for
  ~17 minutes, and only Pages Router was witnessed. The unfixed control artifact
  is `dev-page-pages-raw.log` (16 `TypeError: not a function` lines); there is no
  `dev-page-pages-result.json` — do not cite it.

- The guest `async_hooks` shim (`runtime/guest/modules/pure-a.ts`) fails **closed** across
  native `await`: QuickJS attaches async continuations with intrinsic `PerformPromiseThen`,
  which never consults the patched `Promise.prototype.then`. `workAsyncStorage.getStore()`
  is therefore `undefined` inside Next 16 dev/prerender and throws
  `Invariant: Expected workStore to be initialized` (an error-payload path; the primary
  error is the same invariant on the normal `getRSCPayload` path). Measured in bare QuickJS:
  `await 1`, `await "x"`, `await {then:...}` fire ZERO JS-visible hooks; a
  `Promise.prototype.constructor` getter fires only for real promises; `globalThis.Promise`
  is not read at await time; no promise/job hook is exposed by quickjs-emscripten 0.32.0
  and `QTS_ExecutePendingJob` returns only a job count, not job identity. FIVE independent
  adversarial investigations found NO safe pure-JS shim fix. Sticky-frame, reenter,
  contiguous-job and "exactly one active run" fallbacks all CROSS-CONTAMINATE overlapping
  request chains (one request's auth/session store read by another) — never publish them.
  A correct fix needs either an engine-level AsyncContextFrame on each QuickJS job or a
  loader source transform (`await X` -> `await __owcAwait(X)`) with a general parser;
  neither is witnessed. A source transform verified in bare QuickJS still needs a
  Next-seeded parser and touches CJS, `new Function`, ESM/TLA and `eval` compile paths;
  TWO more reviews REFUTED it: `for await` is a `ForOfStatement` with ZERO
  `AwaitExpression` nodes (11 dev / 9 prod loops stay untransformed). Do NOT "fix" the
  invariant by defaulting `getStore()` to a benign object: Next 16.4.6 checks BOTH
  `workAsyncStorage` and `workUnitAsyncStorage` (18 dist files carry the invariant),
  and the real store holds per-request `route`, `requestId`, `incrementalCache` and
  dynamic-bailout state. A fresh object fabricates request identity and is faking
  success. Two independent reviews returned NOT_VIABLE. The engine-level route named
  below is also NOT_FEASIBLE in this repo: there is NO vendored QuickJS C source
  (find for quickjs.c / quickjs.h / interface.c is empty), NO Makefile / CMakeLists
  / Dockerfile, and NO in-repo C build step; `process.ts:7` pins the prebuilt
  `@jitl/quickjs-singlefile-browser-release-asyncify` npm binary, whose release
  WASM exports 110 minified names with ZERO promise/job hooks. Host emcc 5.0.6
  works, but rebuilding would require vendoring the whole upstream
  quickjs-emscripten C tree + generator, a new checked-in .wasm, a pnpm-lock
  override, an FFI export and JS glue, plus a mandatory >=2-overlapping-request
  regression witness that does not exist. Research workflow wf_9054c518-2eb
  returned NOT_JUSTIFIED; no code was published from it. Requests serialized in
  a separate VM is NOT a workaround: even a SINGLE request fails closed
  (`als-host-hook-challenge.md:190-230`).
