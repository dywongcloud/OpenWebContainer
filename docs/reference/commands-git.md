# git command reference (measured)

Measured inside an OpenWebContainer against host git 2.53.0. git is a shell MODULE COMMAND here:
it is dispatched to the TypeScript implementation under packages/core/src/git/ and runs entirely
over the container VFS. There is NO /usr/bin/git file in the VFS (measured: fs.existsSync of that
path is false), and the container ships neither a git binary nor a gpg binary. command -v git
resolves through the shell module-command table (builtins.ts HOST_UTILITY_PATHS), not a PATH file;
seeding a PATH file for it would be resolved before the module command and recurse.

## How a boundary is reported

Every subcommand that is not implemented locally returns the project's ONE canonical named
outcome (packages/core/src/shell/commands/unsupported.ts:1839-1843, reached through
gitBoundaryOutcome in packages/core/src/git/boundaries.ts):

    git-<family>: [<CODE>] not supported on this runtime: <reason>

on stderr with a trailing newline, empty stdout and exit code 1. Nothing returns a bare 127.
The 18 git-<family> keys live in the UNSUPPORTED record (unsupported.ts:1789); each carries one
code and one reason. The dispatcher may call unsupportedResult('git-<family>') directly.

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
- git remote add (name, url) -> git-remote / ERR_GIT_NO_REMOTE_HELPER | '' / 1 | no transport or remote helper.
- git submodule update -> git-submodule / ERR_GIT_NO_SUBMODULE_TRANSPORT | '' / 1 | fetch of another repo is egress.
- git credential fill -> git-credential / ERR_GIT_NO_CREDENTIAL_HELPER | '' / 1 | no keychain or helper in the container.
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

<!-- PHASE B: one measured line per implemented subcommand, filled from drain-git-impl1's
     published command list once its first git source commit is on origin/main. Each line records
     stdout / stderr / exit code at two memory points. Left empty until that source exists. -->
_Pending Phase B: the published local git CLI command list._
