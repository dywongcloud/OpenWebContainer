# git command reference (measured)

Measured inside an OpenWebContainer against host git 2.53.0. git is a shell MODULE COMMAND here:
it is dispatched to the TypeScript implementation under packages/core/src/git/ and runs entirely
over the container VFS. There is NO /usr/bin/git file in the VFS (measured: fs.existsSync of that
path is false), and the container ships neither a git binary nor a gpg binary. command -v git
resolves through the shell module-command table (builtins.ts HOST_UTILITY_PATHS), not a PATH file;
seeding a PATH file for it would be resolved before the module command and recurse.

## How a boundary is reported

Every invocation that gitBoundaryOutcome classifies as a boundary returns the project's ONE
canonical named outcome (packages/core/src/shell/commands/unsupported.ts:1839-1843, reached through
gitBoundaryOutcome in packages/core/src/git/boundaries.ts):

    git-<family>: [<CODE>] not supported on this runtime: <reason>

on stderr with a trailing newline, empty stdout and exit code 1. Nothing returns a bare 127.
The 18 git-<family> keys live in the UNSUPPORTED record (unsupported.ts:1837-1856); each carries
one code and one reason. The dispatcher may call unsupportedResult('git-<family>') directly.

Current surface (origin/main after 55b024e): all 18 declared keys are reachable from a
boundaryFamily case (an 18<->18 bijection); git-gitlink is emitted for `git submodule add` and
git-credentials for credential-store/cache/osxkeychain/libsecret invocations. An unrecognised
`git <name>` is not classified as a boundary: it still answers the generic not-a-git-command
line with exit 1, never a bare 127. bisect, fsck, fetch, push, pull, ls-remote and the remote
.git/config subcommands are implemented over the VFS; only URL-based transports are boundaries.

MEASURED DEVIATION (deliberate, kept on purpose, never normalized away): host git exits 128 on a
fatal transport error, and git ls-remote exits 2 when no refs match. The container deliberately
reports 1 for EVERY named boundary, because 1 is the exit code of the shared UNSUPPORTED contract
(unsupported.ts:38-40 and :1842). This is a measured difference from the host, not a discrepancy
in the table below.

## Boundary cases (measured)

One line per boundary. Shape: invocation -> key / CODE | stdout / exit | live refutation. Every
line was observed at two memory points (see below), twice per point, in one fresh node process per
OWC boot; stdout was empty and exit was 1 for all of them.

- git clone (https remote) -> git-clone / ERR_GIT_NO_UPLOAD_PACK | '' / 1 | guest net.connect(443,'140.82.114.4') -> ENETUNREACH (hub.ts:5-8,:279).
- git fetch (named remote) -> git-fetch / ERR_GIT_NO_UPLOAD_PACK | '' / 1 | same ENETUNREACH; no git-upload-pack service.
- git pull (named remote) -> git-pull / ERR_GIT_NO_UPLOAD_PACK | '' / 1 | same ENETUNREACH; pull is fetch plus merge.
- git ls-remote (url) -> git-ls-remote / ERR_GIT_NO_UPLOAD_PACK | '' / 1 | same ENETUNREACH; no info/refs endpoint.
- git push (named remote) -> git-push / ERR_GIT_NO_RECEIVE_PACK | '' / 1 | same ENETUNREACH; no git-receive-pack.
- git remote show / prune / update (url) -> git-remote / ERR_GIT_NO_REMOTE_HELPER | '' / 1 | a remote-ref query needs a transport. `git remote add/remove/rename/set-url/get-url/-v` are LOCAL .git/config operations; URL-based fetch/push/pull/ls-remote are boundaries while local VFS paths fall through to the local implementation.
- git submodule update -> git-submodule / ERR_GIT_NO_SUBMODULE_TRANSPORT | '' / 1 | fetch of another repo is egress.
- git credential fill -> git-credential / ERR_GIT_NO_CREDENTIAL_HELPER | '' / 1 | no keychain or helper in the container.
- git submodule add (gitlink 160000) -> git-gitlink / ERR_NO_GITLINK | '' / 1 | no nested checkout on the VFS.
- git credential-store / credential-cache / credential-osxkeychain / credential-libsecret -> git-credentials / ERR_NO_CREDENTIALS | '' / 1 | host keychain must not be mirrored.
- git clone (plain http remote) -> git-smart-http / ERR_GIT_NO_SMART_HTTP | '' / 1 | smart-HTTP info/refs and upload-pack unreachable.
- git clone (ssh or scp url) -> git-ssh-transport / ERR_GIT_NO_SSH_TRANSPORT | '' / 1 | no ssh binary, no SSH transport.
- git clone (git:// url) -> git-git-transport / ERR_GIT_NO_GIT_TRANSPORT | '' / 1 | no git daemon transport.
- git commit -S -> git-gpg / ERR_NO_GPG | '' / 1 | guest spawnSync('gpg') -> ENOENT.
- git tag -s -> git-gpg / ERR_NO_GPG | '' / 1 | no gpg binary to sign.
- git verify-commit / git verify-tag -> git-gpg / ERR_NO_GPG | '' / 1 | no gpg binary to verify.
- git hook run (name) -> git-hooks / ERR_NO_HOOKS | '' / 1 | spawnSync('git',['hook','run','pre-commit']) -> ENOENT; shell.ts:83 SPAWNED_COMMANDS = ['node','npm','npx'].
- git gc / repack / prune / index-pack / pack-objects / pack-refs / multi-pack-index -> git-packfiles / ERR_NO_PACKFILES | '' / 1 | guest fs.mmap and fs.openPackfile are undefined; zenfs-core.ts:8-12 one InMemoryStore of ArrayBuffers.
- git worktree -> git-worktree / ERR_NO_WORKTREE | '' / 1 | guest fs.symlinkSync('/x','/dev/boundary-probe-link') -> EPERM (zenfs-core.ts:166-167).
- git lfs -> git-host-identity / ERR_NO_HOST_IDENTITY | '' / 1 | host git-lfs filters, osxkeychain, /opt/homebrew git and nvm PATH must not be mirrored (default-env.ts:26-33).

A clone of a LOCAL PATH is NOT a boundary: the local git CLI copies HEAD/objects/refs within the
VFS and needs no transport, so gitBoundaryOutcome returns undefined for it.

## Live refutations (two memory points, twice per point)

- loopback-only egress: guest net.connect(443,'140.82.114.4') -> ENETUNREACH; hub.ts:5-8 "Nothing leaves the browser", :279 throws ENETUNREACH for a non-local destination.
- no gpg binary: zero gpg-named files under packages/core/src on origin/main; guest spawnSync('gpg') -> ENOENT.
- no spawnable hook: shell.ts:83 SPAWNED_COMMANDS = ['node','npm','npx']; guest hook spawn -> ENOENT.
- no mmap/packfile: zenfs-core.ts:8-12 ArrayBuffer / InMemoryStore / noResizableBuffers; no mmap or packfile reader in the guest fs.
- symlinkSync EPERM: zenfs-core.ts:166-167 ContainerDeviceFS.symlinkSync throws EPERM; guest symlinkSync on /dev -> EPERM.
- host identity not mirrored: default-env.ts:26-33 copies nothing of the host env; guest USER=user, HOME=/home, PATH=/bin:/usr/bin:/usr/local/bin, os.userInfo().username=user, while the host measures user.name/email, git-lfs filters, credential.helper=osxkeychain, /opt/homebrew/bin/git and nvm PATH.
- no VFS git binary: guest fs.existsSync('/usr/bin/git') -> false.

Memory points (fresh node process per OWC boot; the VFS is shared across boots in one process, so
each boot is its own process): P1 load [25.4, 28.19, 34.76], free 96 MB; P2 load [25.4, 28.19,
34.76], free 18 MB. All six refutations and every boundary probe were identical in both runs at
both points.

## Implemented cases

STAGE 1 (origin/main commit 74a2053887d84d0f51f69e2616d91c3495143b94, 'Add self-contained git object store over the VFS') published eight source files under packages/core/src/git/: boundaries.ts (the named-boundary wrapper), bytes.ts (pako deflate/inflate with RFC1950 zlib framing), objects.ts (loose object serialization), store.ts (VFS object store), repo.ts (index v2, refs, config), diff.ts, commands.ts (the runCommand switch) and cli.ts. cli.ts calls gitBoundaryOutcome FIRST and exports GIT_COMMANDS = { git: gitMain }; it also handles --version, --help, -C and -c. Local git works over the VFS; remote transports are named boundaries (see Boundary cases above). Each line below names one published STAGE 1 source case at commands.ts:228-263. These lines name source, NOT a claim that each command is complete or host-faithful.

- git --version / --help / -C / -c -> cli.ts global options (source; no /usr/bin/git VFS file).
- git init -> commands.ts:228 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git config -> commands.ts:229 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git help -> commands.ts:230 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git clone -> commands.ts:231 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3). (LOCAL-PATH only; a remote clone is a named boundary)
- git hash-object -> commands.ts:232 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git cat-file -> commands.ts:233 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git rev-parse -> commands.ts:234 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git ls-files -> commands.ts:235 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git write-tree -> commands.ts:236 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git commit-tree -> commands.ts:237 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git update-index -> commands.ts:238 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git read-tree -> commands.ts:239 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git status -> commands.ts:240 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git add -> commands.ts:241 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git rm -> commands.ts:242 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git mv -> commands.ts:243 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git clean -> commands.ts:244 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git commit -> commands.ts:245 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3). (-S is a named boundary)
- git log -> commands.ts:246 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git show -> commands.ts:247 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git diff -> commands.ts:248 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git branch -> commands.ts:249 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git checkout -> commands.ts:250 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git switch -> commands.ts:251 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git restore -> commands.ts:252 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git merge -> commands.ts:253 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git reset -> commands.ts:254 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git tag -> commands.ts:255 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3). (-s is a named boundary)
- git stash -> commands.ts:256 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git reflog -> commands.ts:257 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git grep -> commands.ts:258 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git blame -> commands.ts:259 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git archive -> commands.ts:260 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git cherry-pick -> commands.ts:261 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git rebase -> commands.ts:262 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3).
- git remote -> commands.ts:263 (STAGE 1 source-shipped; per-command two-memory-point measurement pending STAGE 2/3). (local config only; a real remote is a named boundary)

STAGE 2/3 measurements and the closes through c21651b0 have landed; five regression rows were repaired and witnessed at two memory points in 55b024e (detached checkout, annotated tags, bisect/fsck, local remotes and the seven downstream divergences). The current runCommand switch has 43 cases (36 STAGE 1 cases plus bisect, fsck, backfill, fetch, push, pull and ls-remote) and UNSUPPORTED declares 18 git-* keys, all reachable from boundaryFamily. The exit-1 deviation for named boundaries recorded above is unchanged, and an unrecognised `git <name>` still returns the generic not-a-git-command line rather than a canonical boundary.
