/**
 * The git subcommands that are named boundaries, not implementations.
 *
 * The local git CLI in this directory implements the commands that work entirely over the VFS:
 * init, add, commit, log, status, branch, checkout, merge, tag, stash, config, diff, ... and a
 * clone of a LOCAL PATH, which copies HEAD/objects/refs within the VFS and needs no transport.
 * Everything that would need a remote transport, a signing binary, a spawned hook, a
 * packfile/mmap subsystem, a linked worktree, a submodule gitlink, a credential helper or a host
 * identity is a boundary.
 *
 * gitBoundaryOutcome maps such an invocation to the ONE canonical named outcome the shell already
 * uses for every utility it cannot have: unsupportedResult('git-<family>') in
 * shell/commands/unsupported.ts:1839-1843, whose shape is
 *
 *     git-<family>: [<CODE>] not supported on this runtime: <reason>
 *
 * on stderr with a trailing newline, empty stdout, and exit code 1. This module invents no second
 * output shape. It returns undefined for every subcommand the CLI implements, so the dispatcher
 * falls through to the real command; a boundary never returns a bare 127.
 */
import { unsupportedResult } from '../shell/commands/unsupported';
import type { CommandResult } from '../shell/commands/types';

/** A remote transport URL, as opposed to a local path a clone can copy within the VFS. */
function remoteScheme(arg: string): string | undefined {
    if (/^https?:\/\//.test(arg)) return 'http';
    if (/^git:\/\//.test(arg)) return 'git';
    if (/^ssh:\/\//.test(arg) || /^[^/:@\s]+@[^/:\s]+:/.test(arg)) return 'ssh';
    if (/^file:\/\//.test(arg)) return 'file';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return 'other';
    return undefined;
}

/**
 * Picks the git-<family> UNSUPPORTED key for a boundary invocation, or undefined when the CLI
 * implements it. Keys carry no spaces so isUnsupported and UNSUPPORTED_COMMANDS derive from them.
 */
function boundaryFamily(subcommand: string, args: string[], env: Record<string, string> = {}): string | undefined {
    const positionals = args.filter((a) => !a.startsWith('-'));
    const has = (...flags: string[]) =>
        args.some((a) => flags.includes(a) || flags.some((f) => f.endsWith('=') && a.startsWith(f)));
    /* Environment overrides that would repoint the repository outside the VFS cannot be honoured. */
    if (env.GIT_DIR || env.GIT_WORK_TREE || env.GIT_CEILING_DIRECTORIES || env.GIT_INDEX_FILE ||
        env.GIT_OBJECT_DIRECTORY || env.GIT_ALTERNATE_OBJECT_DIRECTORIES || env.GIT_COMMON_DIR) return 'git-worktree';
    switch (subcommand) {
        /* Network egress: hub.ts:5-8 and :279 are loopback-only (ENETUNREACH). */
        case 'clone': {
            const source = positionals.find((a) => {
                const s = remoteScheme(a);
                return s !== undefined && s !== 'file';
            });
            if (source === undefined) return undefined; // a LOCAL-PATH clone is implemented
            const scheme = remoteScheme(source);
            if (scheme === 'ssh') return 'git-ssh-transport';
            if (scheme === 'git') return 'git-git-transport';
            if (/^http:\/\//.test(source)) return 'git-smart-http';
            return 'git-clone'; // https and every other remote scheme
        }
        /* A LOCAL VFS path needs no transport: fetch/push/pull/ls-remote fall through to the
           local implementation in commands.ts. Only a URL (http/https/ssh/git/other scheme) is a
           remote transport boundary. The named outcome is never derived from a name alone. */
        case 'fetch':
        case 'upload-pack':
        case 'pull':
        case 'push':
        case 'receive-pack':
        case 'ls-remote': {
            const url = positionals.find((a) => { const s = remoteScheme(a); return s !== undefined && s !== 'file'; });
            if (url === undefined) return undefined; // implemented over the VFS for local paths
            const family: Record<string, string> = { fetch: 'git-fetch', 'upload-pack': 'git-fetch',
                pull: 'git-pull', push: 'git-push', 'receive-pack': 'git-push', 'ls-remote': 'git-ls-remote' };
            return family[subcommand];
        }
        case 'remote': {
            /* add/remove/rename/set-url/get-url/-v and the bare listing are LOCAL .git/config
               operations. show/prune/update query or mutate remote refs over a transport. */
            const verb = positionals[0];
            const local = verb === undefined || ['add', 'remove', 'rm', 'rename', 'set-url',
                'get-url', 'set-head', 'set-branches', 'get-url-all'].includes(verb);
            if (local) return undefined;
            return 'git-remote';
        }
        case 'submodule':
            return positionals[0] === 'add' ? 'git-gitlink' : 'git-submodule';
        case 'credential':
            return 'git-credential';
        case 'credential-store':
        case 'credential-cache':
        case 'credential-osxkeychain':
        case 'credential-libsecret':
            return 'git-credentials';

        /* Object-format / ref-format backends, partial clones and binary stdout need subsystems
           the VFS does not have: route them to canonical named boundaries instead of a fake
           success. All keys used here are declared in unsupported.ts (18<->18 bijection). */
        case 'init': {
            const of = args.find((a) => a.startsWith('--object-format'));
            const rf = args.find((a) => a.startsWith('--ref-format'));
            if (of !== undefined && !/=sha1$/.test(of)) return 'git-packfiles';
            if (rf !== undefined && !/=files$/.test(rf)) return 'git-packfiles';
            return undefined;
        }
        case 'archive': {
            if (args.includes('-o') || args.some((a) => a.startsWith('--output') || a.startsWith('-o'))) return undefined;
            return 'git-packfiles';
        }
        case 'backfill':
            return args.some((a) => a.startsWith('--filter') || a.startsWith('--promisor')) ? 'git-packfiles' : undefined;

        /* GPG signing: commit -S / tag -s / verify-*. */
        case 'commit':
            return has('-S', '--gpg-sign', '--gpg-sign=') ? 'git-gpg' : undefined;
        case 'tag':
            return has('-s', '--sign', '-u', '--local-user') ? 'git-gpg' : undefined;
        case 'verify-commit':
        case 'verify-tag':
            return 'git-gpg';

        /* Hooks, packfiles, worktrees, gitlinks, host identity. */
        case 'hook':
        case 'hooks':
            return 'git-hooks';
        case 'gc':
        case 'repack':
        case 'prune':
        case 'index-pack':
        case 'pack-objects':
        case 'pack-refs':
        case 'multi-pack-index':
            return 'git-packfiles';
        case 'worktree':
            return 'git-worktree';
        case 'lfs':
        case 'git-lfs':
            return 'git-host-identity';
        default:
            break;
    }
    if (subcommand.startsWith('credential-')) return 'git-credential';
    return undefined; // implemented by the local git CLI
}

/**
 * The canonical named "[CODE] not supported on this runtime" outcome for a boundary git
 * subcommand, or undefined when the local git CLI implements it. Exit code is 1 by that contract
 * (unsupported.ts:38-40, :1842) -- a measured deviation from host git's fatal 128 and
 * git ls-remote's 2 -- deliberately kept, not normalized to the host.
 */
export function gitBoundaryOutcome(subcommand: string, args: string[], env: Record<string, string> = {}): CommandResult | undefined {
    const family = boundaryFamily(subcommand, args, env);
    return family === undefined ? undefined : unsupportedResult(family);
}
