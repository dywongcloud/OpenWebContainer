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

- A DEFAULT `next build --webpack` reaches static generation on the fixed tree
  (`✓ Compiled successfully in 71.4min`, `✓ Finished TypeScript in 2.2min`,
  `✓ Collecting page data using 4 workers in 67s`, then `Generating static pages
  using 4 workers (0/3)`) and then FAILS with `DataCloneError [ERR_DATA_CLONE]`.
  Cause: `dist/export/index.js:530-545` passes `nextConfig` into the static
  generation worker. Host `child_process.fork().send()` defaults to
  `serialization:'json'`, which SILENTLY DROPS function properties; the guest
  `child.ts cpEncode` threw instead (`dist/lib/worker.js:181`, comment at
  `:177-180`, documents the difference). *** THE BUG IS NOT HARNESS-INDUCED:
  Next itself injects `exportPathMap: (defaultMap)=>{...}` into `nextConfig` at
  `dist/build/index.js:1814-1820,1949-1952`. `/tmp/owc-harness/nofn-build-result.json`
  removed our `webpack: function` entirely and STILL failed with
  `ERR_DATA_CLONE: (defaultMap)=>{...` — removing the harness function only
  changes WHICH function is reported first. A real app with a
  `webpack`/`rewrites`/`redirects`/`headers` function hits it too.
  `experimental.workerThreads:true` is the one config-only route PAST this
  error (Next's own `sanitizeArgs = JSON.parse(JSON.stringify(args))` drops the
  function): `wt-build-result.json` has dataClone=false.
  But it then hits the ALS invariant below, so NO `Route (app)` + exit 0 was
  witnessed on any of the three routes (wt-build FAIL, nofn-build FAIL,
  force-dynamic timeout at `Generating static pages (0/2)`).

- *** THE BUILD-PATH `workStore` INVARIANT IS NOW WITNESSED, not just static
  analysis. `/tmp/owc-harness/wt-build-last.txt` (`experimental.workerThreads:true`):
  `✓ Compiled successfully in 82.7min`, `✓ Finished TypeScript in 56s`,
  `✓ Collecting page data using 4 workers in 26.6s`, `Generating static pages
  using 4 workers (0/3)`, then `InvariantError: Invariant: Expected workStore
  to be initialized. This is a bug in Next.js.` at
  `createServerSearchParamsForServerPage (/app/.next/server/chunks/430.js:23232:31)`
  -> `createServerSearchParamsForMetadata` -> `createMetadataComponents` ->
  `su (app-page.runtime.prod.js:281:12372)`;
  `Export encountered an error on /_global-error/page: /_global-error, exiting
  the build.` / `> Build error occurred` / `Error: Call retries were exceeded
  ... type: 'WorkerError'`. This is the same ALS gap as dev; no green default
  build. `primary-error-routes.md` BUILD_PATH_ALSO_BROKEN was static analysis;
  it is now a log observation. Do not claim a green build from any of these.

- STOCK `npm run dev` (NO bundler flag) in a real `npx create-next-app@latest`
  scaffold is WITNESSED by the user's own :5173 browser session:
  `> next dev` / `▲ Next.js 16.4.6 (Turbopack)` / `- Local:
  http://localhost:3000` / `✓ Ready in 17.7s` / `✓ Running next.config.ts
  took 1522ms`, then `Error: @next/swc: projectNew needs the native SWC
  compiler, which cannot run in this container ... at createProject
  (/testtes/node_modules/next/dist/build/swc/index.js:916:49) {
  code: 'ERR_OWC_SWC_NATIVE_UNAVAILABLE' }`. The banner prints Ready BEFORE
  createProject throws. JIT control `/tmp/owc-harness/stock-route-result.json`
  is identical. `npm dev` (without `run`) is a user typo, not a container bug.
  `dist/build/swc/index.js:1035` itself says Turbopack needs native bindings
  and to use `--webpack`. Two independent reviews returned NOT_VIABLE for
  `IS_WEBPACK_TEST` container-wide (test-only flag, hard-exits on competing
  bundler flags, and routes to the same `--webpack` path that hits the ALS
  invariant). A `turbo.createProject` implementation cannot be a Babel shim;
  the project API Next consumes after createProject is 11+ methods
  (entrypointsSubscribe, updateInfoSubscribe, clientHmrEvents,
  getServerHmrUpdate, getSourceMapSync, getSourceMap, getSourceForAsset,
  traceSource, activateLazyChunk, onExit, shutdown).
  The original user symptom (the `? What is your project named?` prompt dying
  immediately) IS fixed — the scaffold completes and installs deps.
  No dev-fixed or build-fixed claim.

- The guest `async_hooks` shim (`runtime/guest/modules/pure-a.ts`) fails **closed** across
  native `await`: QuickJS attaches async continuations with intrinsic `PerformPromiseThen`,
  which never consults the patched `Promise.prototype.then`. `workAsyncStorage.getStore()`
  is therefore `undefined` inside Next 16 dev/prerender and throws
  `Invariant: Expected workStore to be initialized` (an error-payload path; the primary
  error is the same invariant on the normal `getRSCPayload` path). Measured in bare QuickJS:
  `await 1`, `await "x"`, `await {then:...}` fire ZERO JS-visible hooks; a
  `Promise.prototype.constructor` getter fires only for real promises; `globalThis.Promise`
  is not read at await time; no promise/job hook is exposed by quickjs-emscripten 0.32.0
  and `QTS_ExecutePendingJob` returns only a job count, not job identity. EIGHT independent
  adversarial investigations found NO safe pure-JS shim fix. Sticky-frame, reenter,
  contiguous-job and "exactly one active run" fallbacks all CROSS-CONTAMINATE overlapping
  request chains (one request's auth/session store read by another) — never publish them.
  The last untried mechanism was a PER-PROMISE WeakMap frame queue instead of the refuted
  one-global-FIFO (`wf_df7ea81f-069`, 2 lanes x 42/21 cases, 126+ fresh QuickJS contexts):
  it does fix the one global-FIFO desync (a `.then` on a DIFFERENT promise), but only
  MOVES it. Measured leaks in BOTH lanes and BOTH the charitable CLEAN and real LITERAL
  modes: `aAfter:"B"` (request A reads B's store), `bJobFrame:"A"`, `B.start:"A"`,
  `outsideAfter:"ENTERED"`; leak sites are a `.then` on the SAME promise, a guest
  `Promise.resolve(shared)` on a shared promise, and any reused promise. Primitive awaits
  still fire ZERO hooks. NOT_SAFE; do not publish.
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
  regression witness that does not exist. A newer variant does NOT remove that:
  all four npm packages (`quickjs-emscripten`, `@jitl/quickjs-ng-wasmfile-release-
  asyncify`, `@jitl/quickjs-wasmfile-release-asyncify`, `@jitl/quickjs-singlefile-
  browser-release-asyncify`) are latest `0.32.0` with `next` dist-tag the OLDER
  `0.26.1-rc.0`. A quickjs-ng family EXISTS but is also only 0.32.0, and its
  `ffi.d.ts`/`ffi.d.mts` are byte-identical to the installed original FFI; its WASM
  has 108 exports and no hook. Upstream quickjs-ng v0.12.1 DOES define
  `JS_SetPromiseHook` / `JSPromiseHook` in C (header :1117/:1128/:1131) and NO
  `AsyncContextFrame`, but the published quickjs-emscripten `c/interface.c` wrapper
  does not surface it. Pure-JS async-context polyfills (`@b9g/async-context`,
  `als-unhooked`) are built on host `AsyncLocalStorage` and still need a job
  identity the guest FFI lacks. No polyfill or prebuilt swap is a fix.
  Research workflow wf_9054c518-2eb returned NOT_JUSTIFIED; no code was published
  from it. Even a C patch needs tokens on `JSPromiseReactionData` (quickjs.c
  :52321-52325) as well as `JSJobEntry`, because reactions are enqueued from the
  RESOLVER's context at `fulfill_or_reject_promise` :52435, and host-invoked
  nextTick/timer/IO callbacks enter through `QTS_Call`, never
  `JS_ExecutePendingJob`. Requests serialized in a separate VM is NOT a workaround:
  even a SINGLE request fails closed (`als-host-hook-challenge.md:190-230`).
