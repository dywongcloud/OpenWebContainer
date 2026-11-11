# Development

All rows in the tables below are real `scripts` keys from the four manifests on `origin/main`. Nothing here comes from `packageold.json` (an archived file, not a manifest). The owc-git8 fix removed every `test`, `test:watch` and `lint` script, so no test runner or `lint` gate appears below; the root `test` entry is a failing placeholder, and the real gates are `pnpm build` and `pnpm turbo run check-types --force`.

## Root (`package.json`)

| Script | Command |
| --- | --- |
| `dev` | `turbo run dev --parallel` |
| `build` | `turbo run build` |
| `install` | `turbo run install` |
| `playground` | `turbo run dev --filter='@open-web-container/playground'` |
| `test` | `echo "Error: no test specified" && exit 1` |

`pnpm test` at the root is a **failing placeholder**, not a test runner. There is no `engines` field in any manifest; the root pins `"packageManager": "pnpm@8.15.3"`.

The recursive workspace commands are not gates either: this repository ships no test files and no test runner, so `pnpm -r test` and `pnpm -r lint` find no `test`/`lint` scripts to run (both are no-ops that exit 0). The playground's ESLint 9 flat config throws a `TypeError` on this pinned tree, so no package exposes a working `lint` script. The real gates are `pnpm build` and `pnpm turbo run check-types --force`.

```bash
pnpm install
pnpm dev          # or: pnpm playground
pnpm build
```

## `packages/core` (`packages/core/package.json`)

| Script | Command |
| --- | --- |
| `compile` | `tsc --project tsconfig.json` |
| `build:napi-guest` | `node scripts/build-napi-guest.mjs` |
| `build:quic-guest` | `node scripts/build-quic-guest.mjs` |
| `build:worker` | `mkdir -p src/generated && BUILD_TARGET=worker tsup` |
| `build:main` | `tsup` |
| `build` | `pnpm build:napi-guest && pnpm build:quic-guest && pnpm build:worker && pnpm build:main` |
| `clean` | `rimraf dist` |
| `dev` | `tsc --project tsconfig.json --watch` |
| `check-types` | `tsc --noEmit` |
| `typecheck` | `tsc --noEmit` |
| `prepublishOnly` | `npm run clean && npm run build` |

### Build order

`build` chains four steps **in this order**:

1. `build:napi-guest` — generate the N-API guest bundles.
2. `build:quic-guest` — generate the QUIC guest bundles.
3. `build:worker` — build the worker bundle (`dist/worker-code.js`, `dist/worker-code.cjs`).
4. `build:main` — build the main entry (`dist/index.js`).

The worker entry is what `@open-web-container/api` imports as `@open-web-container/core/worker-code` and boots as a Blob Worker. Skipping the guest-bundle steps leaves a shim edit out of the container. The package exports `.` → `./dist/index.js` and `./worker-code` → `./dist/worker-code.js` (or `.cjs` for require).

`packages/core/dist` is ignored by git. Rebuild both steps together from one source revision and replace all of `dist/` at once: a bundle that joins a `LOADER_SRC` from one revision with a `BUFFER_FS_SRC` from another has no `settleIO` declaration and fails at the first async `readdir` with `ReferenceError: 'settleIO' is not defined`. The worker build `onSuccess` hook in `tsup.config.ts` checks the emitted `dist/worker.global.js` for exactly one `function settleIO(` and stops the build with a named diagnostic when the count differs. See [Troubleshooting](troubleshooting.md#npx-create-next-applatest).

## `packages/api` (`packages/api/package.json`)

| Script | Command |
| --- | --- |
| `build` | `tsc` |
| `typecheck` | `tsc --noEmit` |
| `check-types` | `tsc --noEmit` |

`@open-web-container/api` depends on `@open-web-container/core` via `workspace:*` and has React `^18.0.0` as a peer dependency. It declares no `exports` field.

## `apps/playground` (`apps/playground/package.json`)

| Script | Command |
| --- | --- |
| `dev` | `vite` |
| `build` | `tsc -b && vite build` |
| `check-types` | `tsc -b --noEmit` |
| `preview` | `vite preview` |

`pnpm playground` at the root filters turbo's `dev` task to `@open-web-container/playground`, which is `vite`. `apps/playground/vite.config.ts` sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for both `server` and `preview`, excludes `quickjs-emscripten` from dep optimisation, and includes `**/*.wasm` as assets.

## Workspace and turbo

`pnpm-workspace.yaml` includes `packages/*` and `apps/*`, and excludes `**/test/**` and `**/private/**`. (Its comment mentions a `components/` glob that is not actually defined.)

`turbo.json` (`$schema: https://turbo.build/schema.json`) declares four tasks:

| Task | Configuration |
| --- | --- |
| `install` | `dependsOn: ["^install"]` |
| `build` | `dependsOn: ["^build"]`, `outputs: ["dist/**"]` |
| `check-types` | `dependsOn: ["^check-types"]`; **all three packages** now declare this script — `core` and `api` run `tsc --noEmit`, `playground` runs `tsc -b --noEmit` — so `turbo run check-types` type-checks the whole workspace, not just the playground |
| `dev` | `persistent: true`, `cache: false` |

The `^` prefix means a package's task waits for the same task in its dependencies, so `turbo run build` builds `core` before `api` and `playground`. `turbo run check-types` reaches all three packages (core, api, playground) because each now declares a `check-types` script; before this fix only the playground did, so the workspace gate silently type-checked one package.

## Before you publish

`scripts/check-staged-secrets.mjs` scans the staged diff for credential shapes. It compares against `origin/main` when `GIT_INDEX_FILE` is set and against `HEAD` otherwise; it refuses an empty index and prints `RESULT: PASS` on a clean scan.

This repository's shared working tree is far behind `origin/main` (a measured 154 ahead / 582 behind at one point). Publish from `origin/main`'s own blobs using a temporary index, and never copy stale working-tree blobs into a commit. See [Troubleshooting](troubleshooting.md).

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the project structure, branch and PR workflow, commit guidelines and documentation conventions. See [Architecture diagrams](architecture.md#diagrams) and [State machines](reference/state-machines.md) for the maintained diagrams and lifecycle machines. See [API reference](api.md) before changing a public method, and [Compatibility](compatibility.md) for how a change is measured.
