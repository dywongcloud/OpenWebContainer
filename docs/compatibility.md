# Compatibility

Compatibility in this project is a **measurement**, not a claim of identity with Node.

## The target

- **Host Node v24.15.0.** `NODE_VERSION` in `packages/core/src/process/executors/node/runtime/guest/globals.ts` is `v24.15.0`; the differential batteries in the [compatibility notes archive](reference/compatibility-notes.md) were run against host Node 24.15 on the same machine.
- **Differential stdout / stderr / exit code.** Each case runs the same script on the host and in one fresh container process, at two memory points, and compares the three outputs. A case counts as agreeing when all three match. Many rows also record witness counts such as "14 of 14 labels agree with host node v24.15.0 at two memory points".
- **Engine baseline.** The guest engine is QuickJS via `quickjs-emscripten` `^0.32.0`, which implements the ECMAScript language specification (ECMA-262). The **Minimum Common Web API** is **ECMA-429, 1st edition, December 2025** (Ecma International), which defines the shared web-API surface expected of ECMAScript runtimes beyond the browser. Some residuals are the pinned engine's own behaviour: chained `Iterator.prototype` helpers throw in bare QuickJS 0.32, and the `Intl` shim exposes eight names where host Node 24.15 has twelve (`Intl.Locale`, `DisplayNames`, `Segmenter` and `DurationFormat` are absent).
- **URL baseline.** WPT `url/resources/urltestdata.json` — 1011 fixture entries, **896 cases, 879 run**. The WPT URL work is recorded on `origin/main` in ten `closes/wpt-url-*.txt` records and in the project's PRD ledger; the ledger's WPT rows report 97 residual divergences falling to **26 after the URL fixes: 6 host-wrong and 20 documented IDNA cases**.

## Measured conformance from the compatibility swarm

These are the compatibility swarm's measured case counts, supplied with the documentation brief. They are reported measurements, not figures derivable from a checked-in CI suite or from a file on `origin/main`:

| Surface | Cases measured |
| --- | --- |
| npm packages | 31 |
| Toolchains | 24 |
| Web globals | 47 |
| Module-resolution cases | 35 |

An additional arbitrary-package corpus of **349 real npm packages** was measured against host Node 24.15 on the same scripts with stdout, stderr and exit code captured on both sides: **318 of 349 entries (91.1%)** were byte-identical, eight more failed identically on both sides with only the printed root differing, and seven more differed only in the wording QuickJS and V8 use for one `TypeError`. Sixteen entries really diverged (the `parse5` ESM path, `events.addAbortListener`, `graceful-fs` re-exports, `jsonpath`, `string-width`/`wrap-ansi` interop, and a handful of differing export surfaces). See the corpus section of the [archive](reference/compatibility-notes.md) for the full breakdown.

Known softer edges are recorded rather than hidden: `node:util` exposes 22 of the host's 35 names in that measurement, `fs.glob`/`globSync` are absent, and the `vm` `timeout` is enforced for JavaScript loops but not for time inside a native built-in. The `owc-published-tree-typescript-errors` row in the project's PRD ledger records six `tsc --noEmit` errors on a fresh export of `packages/core` (TypeScript 5.6.3); that row is closed with the fix published on `origin/main`, so a fresh export typechecks with exit 0.

## CI is unverified

**There is no `.github/workflows` directory on `origin/main`**, so no CI job builds, tests or re-measures any of the above. Every number on this page comes from live differential measurements recorded by the compatibility swarm and in the archived notes, not from a green CI badge. Treat them as a snapshot of the tree they were measured on. The repository root's `test` script is `"echo \"Error: no test specified\" && exit 1"`.

## Reading the numbers

- A "host-identical" result means stdout, stderr and exit code agreed for that case on that tree. It is not a guarantee for other cases or a later commit.
- "Fixed at HEAD" in the archive means the fix was measured at the commit named there.
- Six host-Node deviations from WPT and 20 documented IDNA cases remain open; see [Known limitations](known-limitations.md).

## Next

- [Known limitations](known-limitations.md) for what this means for applications.
- [Architecture](architecture.md) for why the boundaries exist.
- [Development](development.md) for the scripts available locally.
