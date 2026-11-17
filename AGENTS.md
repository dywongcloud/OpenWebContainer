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
  scripts. PRECISION (not a correction): `--webpack` writes the SAME Map key 1
  (:122-127), so `IS_WEBPACK_TEST=1` plus `--webpack` exits 0 with bundler 1;
  the existing "any competing bundler flag then hard-exits" claim is still TRUE
  for the six Turbopack/Rspack sources at :108-121 and :130-135, which make
  `bundlerFlags.size > 1` and hard-exit at :136-141. `--webpack` was never one of
  those competitors. Workflow wf_18245b06-757 (3 angles + 3 refuters + judge,
  VERDICT NO) found a NARROW override mechanically viable for bundler selection
  but NOT_PUBLISHABLE: it still routes to the SAME `--webpack` path that hits the
  ALS invariant below, is container-wide if published in `default-env.ts`, and
  cannot be scoped to only the Next CLI through guest `npm run`. A BOUNDED
  IN-MEMORY fs-stub simulation of a project `.env` containing `TURBOPACK=1`
  projected a silent parent/child bundler split (parent EXIT=0, child flag true,
  from which `ERR_OWC_SWC_NATIVE_UNAVAILABLE` was INFERRED, not witnessed in a
  real parent CLI). It is strictly dominated by the zero-code `--webpack` flag.
  No fix.
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
  `✓ Collecting page data using 4 workers in 52ms` with zero `TypeError`, and DID
  print a `Route (app)` table before returning to a `sh-3.2$` prompt
  (`/tmp/owc-harness/compile-mode-tty-result.json`: verdict=ROUTE_TABLE,
  routeTable=true, exitPrompt=true, staticPages=false; the log literally has
  `Route (app)`). Earlier notes saying "`Route (app)` was NOT witnessed by it" were
  WRONG. But `exitPrompt` is a shell-prompt regex, NOT a captured numeric process
  exit 0, and static generation is SKIPPED at `build/index.js:1799`, so this is NOT
  a green DEFAULT build. `build/index.js:2907-2910` calls `printTreeView`
  unconditionally, which is why compile mode prints that table.
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
  `e581bb6` PUBLISHED a narrow Node `serialization:'json'` parity fix for this
  one ERR_DATA_CLONE (one file, `child.ts`, +70/-4): guest child_process IPC now
  runs `JSON.parse(JSON.stringify(message))` and silently drops functions where
  host Node does, instead of throwing. Verified by wf_6e5a62b4-59f,
  wf_3f033e9d-983 (PUBLISH_WITH_CHANGES with C1/C2/C3) and final gate
  wf_b4f213bc-314 (SAFE_TO_PUBLISH 4/4). The two-step dist rebuild from ONE clean
  revision + Vite `--force` IS in wf_b4f213bc-314 (its bundle lane records the
  rebuild ordering and live Vite pid 97969); only the REAL-BROWSER values are
  absent from the three workflow journals (the gate lanes were forbidden from
  running a browser) and are supported by the e581bb6 commit body and the
  session transcript: `node -e "console.log(1+1)"` -> literal `2`; a fork/spawn
  IPC roundtrip returned
  `PARENT_GOT=CHILD_KEYS=n N=1 FNTYPE=undefined EXIT=0`; `npm --version` -> 11.12.1.
  A separate bounded JIT witness (`/tmp/owc-harness/cna-corrected-result.json`)
  re-ran the user's ORIGINAL `npx create-next-app@latest` on this corrected tree:
  prompt alive, `Creating a new Next.js app in /app/my-app`, `added 362 packages
  in 91s`, zero Error/ERR_ lines and no ERR_DATA_CLONE — so the IPC change did not
  regress npm/npx. That harness breaks on `added \d+ packages`, so
  `Types generated successfully` / `Success!` are NOT claimed for it.
  It is NOT a Next fix: at COMMIT TIME no `next build`/`next dev` had been run
  on the corrected tree, and the ALS workStore blocker below is untouched.
  A FIRST default `next build --webpack` on the corrected tree has SINCE been
  witnessed; see the bullet below.
  `cpEncode` still has NO cycle
  detection (an explicitly 'advanced' circular channel aborts the whole VM),
  an own `__proto__` key is still lost, and a top-level `toJSON()` returning
  undefined deliberately posts NO frame and keeps the child alive where host
  Node kills it with `SyntaxError: "undefined" is not valid JSON`. These are
  recorded residual gaps, not fixed; the cycle guard is filed as a FOLLOW-UP
  note on the SAME PRD row, not a separate row.

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

- *** FIRST DEFAULT `next build --webpack` ON THE CORRECTED TREE (e581bb6) IS
  WITNESSED ***. `/tmp/owc-harness/corrected-default-build-result.json`
  (2624s, JIT source import from the clean e581bb6 archive, NON-STOCK harness
  config cache=false + webpackBuildWorker=false, synthetic App Router app NOT
  app-tw, deliberately KEEPS the `webpack: function`): `✓ Compiled successfully`,
  `✓ Collecting page data using 4 workers in 36.5s`, `Generating static pages
  using 4 workers (0/3)`, dataClone=false, ERR_DATA_CLONE_gone=true. So e581bb6
  REMOVED the error that killed the prior STANDARD-config default builds on the
  UNFIXED tree (`default-build-tty` and `nofn-build`, both ERR_DATA_CLONE). It did
  NOT kill every prior route: `wt-build` (`experimental.workerThreads:true`) had
  dataClone=false already, and `force-dynamic` timed out with zero ERR_DATA_CLONE
  lines. This one corrected-tree run proves only its own dataClone=false.
  But verdict=FAIL: six `InvariantError: Expected workStore to be initialized`
  at createServerSearchParamsForServerPage -> createServerSearchParamsForMetadata
  -> createMetadataComponents, for `/`, `/_global-error` and `/_not-found`;
  no `Route (app)`, no process exit 0, no return-to-shell prompt (the artifact's
  `exitPrompt:false` is defined as `/sh-3\.2\$/.test(full.slice(-500))`; the log's
  opening `sh-3.2$` lines are the command echo. The QuickJS ALS gap is
  now the SINGLE witnessed remaining blocker on the default-build path. NOTE the
  `green` field in these harness result.json files means only
  `/Compiled successfully/` matched (see the .mts), NOT a green build. No green
  dev/build, no build-fixed claim.

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
  invariant). A third workflow (wf_18245b06-757) returned NOT_PUBLISHABLE for the
  narrow variant and VERDICT NO for any bounded route; wf_3f033e9d-983 did not
  re-litigate the flag. Do NOT claim three independent NOT_VIABLE reviews.
  Fresh route-hunt wf_18245b06-757 also ruled
  out the official WASM fallback (`wasm.js` exports exactly 10 names —
  codeFrameColumns, expandNextJsTemplate, mdxCompile, mdxCompileSync, minify,
  minifySync, parse, parseSync, transform, transformSync — and ZERO `projectNew`;
  `dist/build/swc/index.js:1034-1035` and
  `dev/hot-reloader-turbopack.js:310-312` refuse Turbopack when `bindings.isWasm`),
  third-party `next-swc-wasm@16.4.6-build.1` (contains a `projectNew` BYTE STRING
  but no such NAPI export; fails the ELF
  header check in `globals.ts`, needs shared memory64 + 242 imports + a 159-name
  private ABI host, and `INSTANTIATE_FAIL napi_register_wasm_v1 is not a function`),
  and `__INTERNAL_CUSTOM_TURBOPACK_BINDINGS` (needs 25 raw binding functions,
  19 Project + 3 Endpoint methods and real re-requireable `WrittenEndpoint` chunks,
  and still faces the workStore invariant). A `turbo.createProject` implementation
  cannot be a Babel shim;
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
  error is the same invariant on the normal `getRSCPayload` path). `getRSCPayload`
  has EIGHT call sites in `app-render.js`: four foreground/dynamic-render ones —
  :2108 (DEV `cacheComponents` validation branch, gated by `cacheComponents` at
  :2098-2100), :2223 (production `cacheComponents && cachedNavigations` staged
  branch), :2262 (node streams) and :2282 (web streams) — plus four
  prerender/static-generation ones at :5070, :5422, :5639 and :6013. The call
  sites THEMSELVES are gated by config, but whichever branch runs, `:1178`
  unconditionally calls `createMetadataComponents`, which always calls
  `createServerSearchParamsForMetadata` — at
  `dist/lib/metadata/metadata.js:60-62` normally, or at
  `metadata-parallel.js:59-61` when `__NEXT_PARALLEL_ROUTE_METADATA` is set (the
  impl is chosen in `metadata/index.js:11-16`). That call reaches
  `dist/server/request/search-params.js:85-89`, which throws `InvariantError:
  Expected workStore to be initialized` whenever `workAsyncStorage.getStore()` is
  undefined. Angle B of wf_18245b06-757 was READ-ONLY (no dev server or build
  started): it STATICALLY checked `cacheComponents:false`, `parallelRouteMetadata`,
  `testProxy` and `experimental.workerThreads:true` and found none removes that
  read; `workerThreads` does not move the foreground dev render. Do NOT claim those
  flags were witnessed failing. `experimental.ppr` is a separate, EARLIER failure:
  `dist/server/config.js:462-463` throws `HardDeprecatedConfigError` at config
  validation, before any render path.
  Measured in bare QuickJS:
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
