# Global npm installs (`npm install -g`)

Measured against host npm 11.12.1 / Node v24.15.0 with an isolated `--prefix`, and against one
fresh OpenWebContainer boot per case at two memory points. Durations are `<DUR>`; temp prefix
paths are `<PREFIX>`. Tree glyphs are environment-dependent (`+--`/`` `-- `` vs `├──`/`└──`) and
are normalized. The host's own `--prefix` is an isolation device: the container resolves its
prefix from its own config, `/usr/local` by default.

## Layout

- Modules live at `<PREFIX>/lib/node_modules/<name>`.
- Bin links live at `<PREFIX>/bin/<name>` and are on `PATH` (`/usr/local/bin` by default).
- `npm config get globalconfig` is `<PREFIX>/etc/npmrc`.
- `npm ls -g` is rooted at `<PREFIX>/lib`, **not** `<PREFIX>/lib/node_modules`.
- A global install writes **nothing** into the cwd's `package.json`, `package-lock.json` or
  `node_modules`. `--location=global` behaves identically and does not mutate the cwd.
- **Global modules are NOT on `require()` resolution from an unrelated cwd.** Host npm proves
  this: a global `require()` fails with `MODULE_NOT_FOUND` unless `NODE_PATH` names the prefix's
  `lib/node_modules`. A global bin is a shim that loads its own package's file by absolute path.

## Measured cases

| Case | host stdout / stderr | exit |
| --- | --- | --- |
| `npm install -g <pkg>` | `\nadded 1 package in <DUR>\n` | 0 |
| `npm install -g <pkg>` again | `up to date in <DUR>` | 0 |
| `npm install -g <scoped-pkg>` | `\nadded 1 package in <DUR>\n` | 0 |
| `npm install -g <pkg>@<version>` | `\nadded 3 packages in <DUR>\n` | 0 |
| `-D` / `--no-save` / `-P` / `--no-package-lock` with `-g` | same as the plain install | 0 |
| `--global-style` with `-g` | install + `npm warn config global-style This option has been deprecated in favor of \`--install-strategy=shallow\`` | 0 |
| `--force` with `-g` | install + `npm warn using --force Recommended protections disabled.` | 0 |
| `--location=global` | `\nadded 3 packages in <DUR>\n`; cwd unchanged | 0 |
| `npm install -g` (no name, cwd has package.json) | `\nadded 1 package in <DUR>\n` | 0 |
| `npm install -g` (no name, empty cwd) | `npm error code ENOENT` | 254 |
| `npm install -g <unknown>` | `npm error code E404` | 1 |
| `--ignore-scripts` with `-g` | install succeeds; preinstall/install/postinstall suppressed | 0 |
| failing global postinstall | `npm error command sh -c ...` | its own status |
| global lifecycle cwd | `<PREFIX>/lib/node_modules/<name>` for registry/tarball installs | — |
| global lifecycle env | `npm_config_global=true`, `npm_config_prefix`/`global_prefix`/`local_prefix=<PREFIX>`, `npm_config_globalconfig=<PREFIX>/etc/npmrc` | — |
| string `bin` | one `<PREFIX>/bin/<name>` link | — |
| `bin` map | one link per key | — |
| scoped package `bin` | short bin name | — |
| colliding bin name | `EEXIST`; first link survives | 1 |
| package with no `bin` | no `<PREFIX>/bin` entry | — |
| `<bin> <args>` from an unrelated cwd | the program runs | 0 |
| `npx <bin>` after a global install | reuses the global bin (no registry fetch) | 0 |
| `npm ls -g` | `<PREFIX>/lib` then `+-- name@version` per package | 0 |
| `npm ls -g` on an existing empty prefix | `<PREFIX>/lib\n└── (empty)\n\n` | 0 |
| `npm ls -g --depth=0` / `--all` | identical for a flat global tree | 0 |
| `npm ls -g --json` | `{"name":"lib", ...}` | 0 |
| `npm ls -g --parseable` | `<PREFIX>/lib` then one path per package | 0 |
| `npm ls -g --depth=bad` | warn on stderr, tree on stdout | 0 |
| `npm ls -g` on an absent prefix | `npm error code ENOENT`; empty stdout | 254 |
| `npm uninstall -g <pkg>` / `rm` / `un` / `remove` / `unlink` | `\nremoved 1 package in <DUR>\n` | 0 |
| `npm uninstall -g <absent>` | `up to date in <DUR>` | 0 |
| `npm uninstall -g` (no name) | `npm error code EUSAGE` + usage on stderr | 1 |
| `npm root -g` | `<PREFIX>/lib/node_modules` | 0 |
| `npm prefix -g` | `<PREFIX>` | 0 |
| `npm root` | `<cwd>/node_modules` | 0 |
| `npm prefix` | `<cwd>` | 0 |
| `npm config get prefix` | `<PREFIX>` | 0 |
| `npm config get globalconfig` | `<PREFIX>/etc/npmrc` | 0 |
| `npm config get globalconfig -g` | `<PREFIX>/etc/npmrc` | 0 |
| `npm bin -g` | `Unknown command: "bin"` on stdout | 1 |
| `npm --version` | `11.12.1` | 0 |
| `execSync('npm install -g <pkg>')` | `\nadded 3 packages in <DUR>\n` | 0 |

## Superseded archive statements

The verbatim archive `docs/reference/compatibility-notes.md` line 118 says
**"Global installs are refused"**. That line describes the tree it was measured on and is
**SUPERSEDED** by this feature: the archive is byte-for-byte verbatim and is deliberately left
unedited. Global installs now land in the VFS prefix, global bins are on PATH, and global modules
are NOT on `require()` resolution. `npm bin -g` remains an exact unknown-command match because
host npm 11.12.1 removed the `bin` command; `npm config get prefix` differs on the host only
because the host's oracle used `--prefix` on install commands and an nvm prefix otherwise.
