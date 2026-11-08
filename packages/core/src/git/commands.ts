import type { CommandContext, CommandResult } from '../shell/commands/types';
import { unsupportedResult } from '../shell/commands/unsupported';
import { utf8, text, concat, abbrev, binaryString, fromBinaryString, isHexOid, zinflate, sha1Hex } from './bytes';
import {
    GitRepo, GitError, fatal, normalizePath, type Change, type FileState, type StatusRow
} from './repo';
import { readIndex, writeIndex, type IndexEntry, ZERO_OID, type ConfigScope, formatConfig, type ConfigLine } from './store';
import { parseTree, serializeTree, parseCommit, serializeCommit, serializeTag, parseTag, oidOf, type CommitInfo } from './objects';
import { renderDiff, renderStat, countsFor, tarOf, zipOf, splitLines } from './diff';

export function ok(stdout = '', stderr = '', exitCode = 0): CommandResult { return { stdout, stderr, exitCode }; }
export function fail(stderr: string, exitCode = 1): CommandResult {
    return { stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', exitCode };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function pad(value: number): string { return value < 10 ? '0' + value : String(value); }
function mediumDate(ts: number, tz: string): string {
    const d = new Date(ts * 1000);
    return WEEKDAYS[d.getUTCDay()] + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ' ' +
        pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' ' +
        d.getUTCFullYear() + ' ' + tz;
}
function isoDate(ts: number, tz: string): string {
    const d = new Date(ts * 1000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
        pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' ' + tz;
}

/* ------------------------------------------------------------------ *
 * status
 * ------------------------------------------------------------------ */

export interface StatusView {
    rows: StatusRow[];
    untracked: string[];
    staged: Change[];
    unstaged: Change[];
    branch: string;
    detached: boolean;
    noCommits: boolean;
    headOid?: string;
    /** Host labels a detached HEAD with the tag/ref it was checked out from, else the abbrev oid. */
    detachedLabel?: string;
    /** Paths with index stage 1/2/3 entries written by a conflicting merge. */
    unmerged: string[];
    /** Per-path object ids/modes captured for porcelain v2 records. */
    v2?: Map<string, { h?: FileState; i?: FileState; w?: FileState }>;
    /** Stage 1/2/3 index states plus the worktree state for each unmerged path. */
    unmergedStages?: Map<string, { s1?: FileState; s2?: FileState; s3?: FileState; w?: FileState }>;
}

export function statusOf(repo: GitRepo): StatusView {
    const head = repo.headTree();
    const index = repo.indexTree();
    const headOid = repo.refs.headOid();
    const noCommits = headOid === undefined;
    const worktree = new Map<string, FileState>();
    for (const [path, state] of index) {
        const bytes = repo.readBytes(repo.w(path));
        if (bytes !== undefined) worktree.set(path, { oid: repo.hashBlob(bytes), mode: repo.worktreeMode(path) });
    }
    const staged = repo.changesBetween(head, index);
    const unstaged = repo.changesBetween(index, worktree);
    const untracked = repo.worktreeFiles().filter((path) => !index.has(path) && !repo.ignored(path));
    const paths = new Set<string>([...index.keys(), ...head.keys()]);
    const v2 = new Map<string, { h?: FileState; i?: FileState; w?: FileState }>();
    for (const path of paths) v2.set(path, { h: head.get(path), i: index.get(path), w: worktree.get(path) });
    const rows: StatusRow[] = [];
    for (const path of [...paths].sort()) {
        const inHead = head.get(path), inIndex = index.get(path), inWork = worktree.get(path);
        let x = ' ';
        if (inHead === undefined && inIndex !== undefined) x = 'A';
        else if (inHead !== undefined && inIndex === undefined) x = 'D';
        else if (inHead !== undefined && inIndex !== undefined &&
            (inHead.oid !== inIndex.oid || inHead.mode !== inIndex.mode)) x = 'M';
        let y = ' ';
        if (inIndex !== undefined) {
            if (inWork === undefined) y = 'D';
            else if (inWork.oid !== inIndex.oid || inWork.mode !== inIndex.mode) y = 'M';
        }
        if (x !== ' ' || y !== ' ') rows.push({ x, y, path, staged: x !== ' ', unstaged: y !== ' ' });
    }
    for (const path of untracked) rows.push({ x: '?', y: '?', path, staged: false, unstaged: false });
    const label = repo.readText(repo.g('OWC_DETACH_LABEL'))?.trim();
    const unmergedStages = new Map<string, { s1?: FileState; s2?: FileState; s3?: FileState; w?: FileState }>();
    for (const entry of repo.indexEntries()) {
        if (entry.stage === 0) continue;
        const group = unmergedStages.get(entry.path) ?? {};
        const state: FileState = { oid: entry.oid, mode: entry.mode };
        if (entry.stage === 1) group.s1 = state;
        else if (entry.stage === 2) group.s2 = state;
        else if (entry.stage === 3) group.s3 = state;
        unmergedStages.set(entry.path, group);
    }
    for (const [path, group] of unmergedStages) group.w = worktree.get(path);
    const unmerged = [...unmergedStages.keys()].sort();
    return { rows, untracked, staged, unstaged, branch: repo.refs.branch(), detached: repo.refs.head().ref === undefined,
        noCommits, headOid, detachedLabel: label !== undefined && label !== '' ? label : undefined, unmerged, v2, unmergedStages };
}

function label(change: Change): string {
    return change.status === 'A' ? 'new file:   ' : change.status === 'D' ? 'deleted:   ' : 'modified:   ';
}

export function shortStatus(view: StatusView, branch = false, nul = false): string {
    const eol = nul ? String.fromCharCode(0) : '\n';
    const lines: string[] = [];
    if (branch) lines.push(branchHeader(view) + eol);
    for (const row of view.rows) if (row.x !== '?') lines.push(row.x + row.y + ' ' + row.path + eol);
    /* Host porcelain v1 collapses untracked files under a directory to "?? dir/". */
    const untracked = new Set<string>();
    for (const path of view.untracked) {
        const slash = path.indexOf('/');
        untracked.add(slash < 0 ? path : path.slice(0, slash) + '/');
    }
    for (const path of [...untracked].sort()) lines.push('?? ' + path + eol);
    return lines.join('');
}

function branchHeader(view: StatusView): string {
    if (view.detached) return '## HEAD (no branch)';
    if (view.noCommits) return '## No commits yet on ' + view.branch;
    return '## ' + view.branch;
}

export function porcelainV2(view: StatusView, branch = false, opts: { ignored?: string[]; showIgnored?: boolean; matching?: boolean } = {}): string {
    let out = '';
    if (branch) {
        out += '# branch.oid ' + (view.headOid ?? '(initial)') + '\n';
        out += '# branch.head ' + (view.detached ? '(detached)' : view.branch) + '\n';
    }
    const mode = (state?: { mode: number }) => state ? state.mode.toString(8).padStart(6, '0') : '000000';
    const oid = (state?: { oid: string }) => state ? state.oid : ZERO_OID;
    const ignoredSet = new Set(opts.ignored ?? []);
    const tracked = view.rows.filter((row) => row.x !== '?' && !ignoredSet.has(row.path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const untracked = view.rows.filter((row) => row.x === '?' && !ignoredSet.has(row.path)).map((row) => row.path).sort();
    const unmerged = new Set(view.unmerged);
    // Host reports a staged rename as one '2 R.' record, not a '1 D.' + '1 A.' pair.
    // 'git mv' keeps the blob oid, so a deleted path whose HEAD blob matches an added
    // path's index blob is a 100%-similar rename (score R100).
    const consumed = new Set<string>();
    const renames = new Map<string, string>();
    const deletions = tracked.filter((r) => r.x === 'D');
    const additions = tracked.filter((r) => r.x === 'A');
    for (const del of deletions) {
        const head = view.v2?.get(del.path)?.h;
        if (!head) continue;
        const add = additions.find((r) => !consumed.has(r.path) && view.v2?.get(r.path)?.i?.oid === head.oid);
        if (!add) continue;
        renames.set(add.path, del.path);
        consumed.add(del.path); consumed.add(add.path);
    }
    for (const row of tracked) {
        if (unmerged.has(row.path)) {
            const st = view.unmergedStages?.get(row.path);
            const s1 = st?.s1, s2 = st?.s2, s3 = st?.s3, w = st?.w;
            const h1 = !!s1, h2 = !!s2, h3 = !!s3;
            let xy = 'DD';
            if (h1 && h2 && h3) xy = 'UU';
            else if (!h1 && h2 && h3) xy = 'AA';
            else if (h1 && h2 && !h3) xy = 'UD';
            else if (h1 && !h2 && h3) xy = 'DU';
            else if (!h1 && h2 && !h3) xy = 'AU';
            else if (!h1 && !h2 && h3) xy = 'UA';
            out += 'u ' + xy + ' N... ' + mode(s1) + ' ' + mode(s2) + ' ' + mode(s3) + ' ' + mode(w) +
                ' ' + oid(s1) + ' ' + oid(s2) + ' ' + oid(s3) + ' ' + row.path + '\n';
            continue;
        }
        const orig = renames.get(row.path);
        if (orig !== undefined) {
            const head = view.v2?.get(orig)?.h;
            const index = view.v2?.get(row.path)?.i;
            const work = view.v2?.get(row.path)?.w;
            const xy = 'R' + (row.y === ' ' ? '.' : row.y);
            out += '2 ' + xy + ' N... ' + mode(head) + ' ' + mode(index) + ' ' + mode(work) +
                ' ' + oid(head) + ' ' + oid(index) + ' R100 ' + row.path + '\t' + orig + '\n';
            continue;
        }
        if (consumed.has(row.path)) continue;
        const state = view.v2?.get(row.path);
        const xy = (row.x === ' ' ? '.' : row.x) + (row.y === ' ' ? '.' : row.y);
        out += '1 ' + xy + ' N... ' + mode(state?.h) + ' ' + mode(state?.i) + ' ' + mode(state?.w) +
            ' ' + oid(state?.h) + ' ' + oid(state?.i) + ' ' + row.path + '\n';
    }
    for (const path of untracked) out += '? ' + path + '\n';
    if (opts.showIgnored) out += ignoredRows(opts.ignored ?? [], '!', opts.matching === true);
    return out;
}

/** Host 'git status --short --ignored' folds ignored paths under a directory to "!! dir/". */
export function ignoredRows(paths: string[], mark = '!!', matching = false, nul = false): string {
    const folded = new Set<string>();
    for (const path of paths) {
        if (matching) { folded.add(path); continue; }
        const slash = path.indexOf('/');
        folded.add(slash < 0 ? path : path.slice(0, slash) + '/');
    }
    return [...folded].sort().map((path) => mark + ' ' + path + (nul ? String.fromCharCode(0) : '\n')).join('');
}

/* Root .gitignore globs ('*.log') are not covered by GitRepo.ignored at this tip; keep the
   parity commands.ts-side so the repo.ts owner can extend ignored() independently. */
function isIgnored(repo: GitRepo, path: string): boolean {
    if (repo.ignored(path)) return true;
    const rules = repo.readText(repo.w('.gitignore'));
    if (rules === undefined) return false;
    const name = path.slice(path.lastIndexOf('/') + 1);
    for (const raw of rules.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
        if (line.startsWith('*') && name.endsWith(line.slice(1))) return true;
        if (line.endsWith('*') && name.startsWith(line.slice(0, -1))) return true;
    }
    return false;
}

export function longStatus(view: StatusView, commit = false): string {
    let out = view.detached ? 'HEAD detached at ' + (view.detachedLabel ?? abbrev(view.headOid ?? ZERO_OID)) + '\n' : 'On branch ' + view.branch + '\n';
    if (view.noCommits) out += '\n' + (commit ? 'Initial commit' : 'No commits yet') + '\n';
    if (view.unmerged.length > 0) {
        out += 'You have unmerged paths.\n';
        out += '  (fix conflicts and run "git commit")\n';
        out += '  (use "git merge --abort" to abort the merge)\n\n';
        out += 'Unmerged paths:\n';
        out += '  (use "git add <file>..." to mark resolution)\n';
        for (const path of view.unmerged) out += '\tboth modified:   ' + path + '\n';
        out += '\nno changes added to commit (use "git add" and/or "git commit -a")\n';
        return out;
    }
    const sections: string[] = [];
    if (view.staged.length > 0) {
        let section = 'Changes to be committed:\n';
        section += view.noCommits
            ? '  (use "git rm --cached <file>..." to unstage)\n'
            : '  (use "git restore --staged <file>..." to unstage)\n';
        for (const change of view.staged) section += '\t' + label(change) + change.path + '\n';
        sections.push(section);
    }
    if (view.unstaged.length > 0) {
        let section = 'Changes not staged for commit:\n';
        section += '  (use "git add <file>..." to update what will be committed)\n';
        section += '  (use "git restore <file>..." to discard changes in working directory)\n';
        for (const change of view.unstaged) section += '\t' + label(change) + change.path + '\n';
        sections.push(section);
    }
    if (view.untracked.length > 0) {
        let section = 'Untracked files:\n';
        section += '  (use "git add <file>..." to include in what will be committed)\n';
        for (const path of view.untracked) section += '\t' + path + '\n';
        sections.push(section);
    }
    if (sections.length > 0) {
        if (view.noCommits) out += '\n';
        out += sections.join('\n');
        out += sections[sections.length - 1].endsWith('\n') ? '' : '\n';
        out += '\n';
    }
    if (view.staged.length > 0) return out;
    if (view.untracked.length > 0 && view.unstaged.length === 0) {
        return out + 'nothing added to commit but untracked files present (use "git add" to track)\n';
    }
    if (view.unstaged.length > 0) return out + 'no changes added to commit (use "git add" and/or "git commit -a")\n';
    if (view.noCommits) return out + '\nnothing to commit (create/copy files and use "git add" to track)\n';
    return out + 'nothing to commit, working tree clean\n';
}

/* ------------------------------------------------------------------ *
 * commit / refs / history helpers
 * ------------------------------------------------------------------ */

function commitLines(repo: GitRepo, changes: Change[]): string {
    const counts = changes.map((change) => countsFor(repo, change));
    let added = 0, removed = 0;
    for (const entry of counts) { added += entry.added; removed += entry.removed; }
    const anyBinary = counts.some((entry) => entry.binary);
    let summary = ' ' + changes.length + ' file' + (changes.length === 1 ? '' : 's') + ' changed';
    if (added > 0 || anyBinary) summary += ', ' + added + ' insertion' + (added === 1 ? '' : 's') + '(+)';
    if (removed > 0 || anyBinary) summary += ', ' + removed + ' deletion' + (removed === 1 ? '' : 's') + '(-)';
    let out = summary + '\n';
    for (const change of changes) {
        if (change.status === 'A') out += ' create mode ' + (change.mode === 0o100755 ? '100755' : '100644') + ' ' + change.path + '\n';
    }
    for (const change of changes) {
        if (change.status === 'D') out += ' delete mode ' + (change.mode === 0o100755 ? '100755' : '100644') + ' ' + change.path + '\n';
    }
    return out;
}

function updateHead(repo: GitRepo, oid: string, message: string, old: string | undefined): void {
    const head = repo.refs.head();
    const before = old ?? ZERO_OID;
    if (head.ref !== undefined) {
        repo.refs.writeRef(head.ref, oid);
        repo.refs.appendReflog(head.ref, before, oid, repo.who(), message, repo.identity().ts, repo.identity().tz);
    } else repo.refs.setDetached(oid);
    repo.refs.appendReflog('HEAD', before, oid, repo.who(), message, repo.identity().ts, repo.identity().tz);
}

export function makeCommit(repo: GitRepo, message: string, opts: { amend?: boolean; parents?: string[]; tree?: string } = {}): { oid: string; changes: Change[]; dateLine: string } {
    const treeOid = opts.tree ?? repo.buildTree(repo.indexTree());
    const headOid = repo.refs.headOid();
    const previous = opts.amend ? repo.readCommit(headOid ?? '') : undefined;
    const parents = opts.parents ?? (previous !== undefined ? previous.parents : (headOid !== undefined ? [headOid] : []));
    const author = previous !== undefined ? previous.author : repo.identity();
    const committer = repo.identity();
    const info: CommitInfo = {
        tree: treeOid, parents, author, committer,
        message: message.endsWith('\n') ? message : message + '\n', extra: []
    };
    const oid = repo.objects.write('commit', serializeCommit(info));
    const subject = message.trim().split('\n')[0];
    updateHead(repo, oid, (headOid === undefined && !opts.amend ? 'commit (initial): ' : 'commit: ') + subject, headOid);
    const baseTree = parents.length > 0 ? (repo.readCommit(parents[0])?.tree ?? '') : '';
    const changes = baseTree === '' ? repo.changesBetween(new Map(), repo.flatTree(treeOid))
        : repo.changesBetween(repo.flatTree(baseTree), repo.flatTree(treeOid));
    const dateLine = opts.amend ? ' Date: ' + mediumDate(author.ts, author.tz) + '\n' : '';
    return { oid, changes, dateLine };
}

function commitHeader(repo: GitRepo, changes: Change[], message: string, oid: string, root: boolean, amend: boolean, author: CommitInfo['author']): string {
    const branch = repo.refs.branch();
    const prefix = root ? '[' + branch + ' (root-commit) ' + abbrev(oid) + ']' : '[' + branch + ' ' + abbrev(oid) + ']';
    let out = prefix + ' ' + message.trim().split('\n')[0] + '\n';
    if (amend) out += ' Date: ' + mediumDate(author.ts, author.tz) + '\n';
    if (changes.length > 0) out += commitLines(repo, changes);
    return out;
}

function mediumLog(repo: GitRepo, oid: string, info: CommitInfo): string {
    const out: string[] = [];
    out.push('commit ' + oid);
    out.push('Author: ' + info.author.name + ' <' + info.author.email + '>');
    out.push('Date:   ' + mediumDate(info.author.ts, info.author.tz));
    out.push('');
    for (const line of info.message.replace(/\n$/, '').split('\n')) out.push('    ' + line);
    return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * command dispatch
 * ------------------------------------------------------------------ */

function parseFlags(args: string[], repeatParents = false): { flags: Set<string>; values: Map<string, string>; multi: Map<string, string[]>; rest: string[] } {
    const flags = new Set<string>();
    const values = new Map<string, string>();
    const multi = new Map<string, string[]>();
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') { rest.push(...args.slice(i + 1)); break; }
        if (arg.startsWith('--') && arg.includes('=')) {
            const eq = arg.indexOf('='); values.set(arg.slice(0, eq), arg.slice(eq + 1));
        } else if (arg.startsWith('--')) {
            if (['-m', '--message'].includes(arg)) { values.set(arg, args[++i] ?? ''); }
            else flags.add(arg);
        } else if (arg.startsWith('-') && arg.length > 1) {
            if (repeatParents && arg === '-p' && i + 1 < args.length) {
                const value = args[++i];
                const list = multi.get('-p') ?? []; list.push(value); multi.set('-p', list);
                values.set('-p', value);
            } else if ((arg === '-m' || arg === '-b' || arg === '-o' || arg === '-t' || arg === '-n' || arg === '-S' || arg === '-F' || arg === '-c' || arg === '-C' || arg === '-u') && i + 1 < args.length && !args[i + 1].startsWith('-')) {
                values.set(arg, args[++i]);
            } else {
                for (const ch of arg.slice(1)) flags.add('-' + ch);
            }
        } else rest.push(arg);
    }
    return { flags, values, multi, rest };
}

export function runCommand(ctx: CommandContext, sub: string, args: string[]): CommandResult {
    const { flags, values, multi, rest } = parseFlags(args, sub === 'commit-tree');
    const short = flags.has('-s') || flags.has('--short') || flags.has('--porcelain') || values.has('--porcelain');

    switch (sub) {
        case 'init': return cmdInit(ctx, flags, values, rest);
        case 'config': return cmdConfig(ctx, flags, values, rest);
        case 'help': return ok(GIT_HELP);
        case 'clone': return cmdClone(ctx, flags, values, rest);
        case 'hash-object': return cmdHashObject(ctx, flags, values, rest);
        case 'cat-file': return cmdCatFile(ctx, args);
        case 'rev-parse': return cmdRevParse(ctx, flags, values, rest);
        case 'ls-files': return cmdLsFiles(ctx, flags, values, rest);
        case 'write-tree': return cmdWriteTree(ctx);
        case 'commit-tree': return cmdCommitTree(ctx, flags, values, rest, multi);
        case 'update-index': return cmdUpdateIndex(ctx, flags, values, rest);
        case 'read-tree': return cmdReadTree(ctx, flags, values, rest);
        case 'status': return cmdStatus(ctx, flags, values, rest, short);
        case 'add': return cmdAdd(ctx, flags, values, rest);
        case 'rm': return cmdRm(ctx, flags, values, rest);
        case 'mv': return cmdMv(ctx, rest);
        case 'clean': return cmdClean(ctx, flags, values, rest);
        case 'commit': return cmdCommit(ctx, flags, values, rest);
        case 'log': return cmdLog(ctx, flags, values, rest);
        case 'show': return cmdShow(ctx, flags, values, rest);
        case 'diff': return cmdDiff(ctx, flags, values, rest);
        case 'branch': return cmdBranch(ctx, flags, values, rest);
        case 'checkout': return cmdCheckout(ctx, flags, values, rest);
        case 'switch': return cmdSwitch(ctx, flags, values, rest);
        case 'restore': return cmdRestore(ctx, flags, values, rest);
        case 'merge': return cmdMerge(ctx, flags, values, rest);
        case 'reset': return cmdReset(ctx, flags, values, rest);
        case 'tag': return cmdTag(ctx, flags, values, rest);
        case 'stash': return cmdStash(ctx, flags, values, rest);
        case 'reflog': return cmdReflog(ctx, rest);
        case 'grep': return cmdGrep(ctx, flags, values, rest);
        case 'blame': return cmdBlame(ctx, flags, values, rest);
        case 'archive': return cmdArchive(ctx, flags, values, rest);
        case 'cherry-pick': return cmdCherryPick(ctx, flags, values, rest);
        case 'rebase': return cmdRebase(ctx, flags, values, rest);
        case 'remote': return cmdRemote(ctx, flags, values, rest);
        case 'bisect': return cmdBisect(ctx, args);
        case 'fsck': return cmdFsck(ctx, args);
        case 'fetch': return cmdFetch(ctx, args);
        case 'push': return cmdPush(ctx, args);
        case 'pull': return cmdPull(ctx, args);
        case 'ls-remote': return cmdLsRemote(ctx, args);
        case 'backfill': return cmdBackfill(ctx, flags, values, rest);
        default: return fail("git: '" + sub + "' is not a git command. See 'git --help'.", 1);
    }
}

export const GIT_HELP = "usage: git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]\n           [--exec-path[=<path>]] [--html-path] [--man-path] [--info-path]\n           [-p | --paginate | -P | --no-pager] [--no-replace-objects] [--no-lazy-fetch]\n           [--no-optional-locks] [--no-advice] [--bare] [--git-dir=<path>]\n           [--work-tree=<path>] [--namespace=<name>] [--config-env=<name>=<envvar>]\n           <command> [<args>]\n\nThese are common Git commands used in various situations:\n\nstart a working area (see also: git help tutorial)\n   clone      Clone a repository into a new directory\n   init       Create an empty Git repository or reinitialize an existing one\n\nwork on the current change (see also: git help everyday)\n   add        Add file contents to the index\n   mv         Move or rename a file, a directory, or a symlink\n   restore    Restore working tree files\n   rm         Remove files from the working tree and from the index\n\nexamine the history and state (see also: git help revisions)\n   bisect     Use binary search to find the commit that introduced a bug\n   diff       Show changes between commits, commit and working tree, etc\n   grep       Print lines matching a pattern\n   log        Show commit logs\n   show       Show various types of objects\n   status     Show the working tree status\n\ngrow, mark and tweak your common history\n   backfill   Download missing objects in a partial clone\n   branch     List, create, or delete branches\n   commit     Record changes to the repository\n   merge      Join two or more development histories together\n   rebase     Reapply commits on top of another base tip\n   reset      Set `HEAD` or the index to a known state\n   switch     Switch branches\n   tag        Create, list, delete or verify tags\n\ncollaborate (see also: git help workflows)\n   fetch      Download objects and refs from another repository\n   pull       Fetch from and integrate with another repository or a local branch\n   push       Update remote refs along with associated objects\n\n'git help -a' and 'git help -g' list available subcommands and some\nconcept guides. See 'git help <command>' or 'git help <concept>'\nto read about a specific subcommand or concept.\nSee 'git help git' for an overview of the system.\n";

/* ---- init ---- */
function cmdInit(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    const branch = values.get('-b') ?? values.get('--initial-branch') ?? undefined;
    const target = rest[0] ?? (ctx.cwd || '/app');
    const bare = flags.has('--bare');
    const absolute = normalizePath(target.startsWith('/') ? target : (ctx.cwd || '/app') + '/' + target);
    const gitDir = bare ? absolute : absolute + '/.git';
    const reinit = ctx.fs.fileExists(gitDir + '/HEAD');
    const created = GitRepo.init(ctx, target, branch, bare);
    const location = bare ? absolute + '/' : absolute + '/.git/';
    const line = reinit
        ? 'Reinitialized existing Git repository in ' + location + '\n'
        : 'Initialized empty Git repository in ' + location + '\n';
    /* Host git 2.53.0 warns and ignores -b/--initial-branch on a re-init. */
    const reinitWarning = reinit && branch !== undefined
        ? 'warning: re-init: ignored --initial-branch=' + branch + '\n' : '';
    return ok(line, reinit ? reinitWarning : created.hint);
}

/* ---- config ---- */
function cmdConfig(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    let scope: ConfigScope = 'local';
    if (flags.has('--global')) scope = 'global';
    if (flags.has('--system')) scope = 'system';
    if (flags.has('--worktree')) scope = 'worktree';
    const file = values.get('--file');
    if (file !== undefined) scope = 'file';
    let repo: GitRepo;
    try { repo = GitRepo.discover(ctx); } catch {
        const home = ctx.env?.HOME ?? '/home';
        const paths: Record<ConfigScope, string> = { system: ctx.env?.GIT_CONFIG_SYSTEM ?? '/etc/gitconfig',
            global: ctx.env?.GIT_CONFIG_GLOBAL ?? home + '/.gitconfig', local: '', worktree: '', file: file ?? '' };
        repo = new GitRepo(ctx, ctx.cwd || '/app', ctx.cwd + '/__no_repo__');
        (repo.config as unknown as { paths: Record<ConfigScope, string> }).paths = paths;
    }
    if (file !== undefined) (repo.config as unknown as { paths: Record<ConfigScope, string> }).paths.file = file;
    /* Host git 2.53.0: --show-origin prefixes every emitted line with the
       owning config file and a TAB. Global/system/file keep their absolute
       paths; local/worktree are the worktree-relative .git/config. */
    const showOrigin = flags.has('--show-origin');
    const cfgPaths = (repo.config as unknown as { paths: Record<ConfigScope, string> }).paths;
    const scopes: ConfigScope[] = ['system', 'global', 'local', 'worktree', 'file'];
    const keyOfLine = (line: { section: string; subsection?: string; key: string }): string =>
        line.section + (line.subsection === undefined ? '' : '.' + line.subsection) + '.' + line.key;
    const configLine = (line: { section: string; subsection?: string; key: string; value: string }): string =>
        keyOfLine(line) + '=' + line.value + '\n';
    const originFor = (scope: ConfigScope): string =>
        (scope === 'local' || scope === 'worktree' ? 'file:.git/config' : 'file:' + (cfgPaths[scope] ?? '')) + '\t';
    const scopeOfKey = (key: string): ConfigScope => {
        let found: ConfigScope = 'local';
        for (const scope of scopes) {
            for (const line of repo.config.readScope(scope)) {
                if (keyOfLine(line) === key.toLowerCase()) found = scope;
            }
        }
        return found;
    };
    const wantsList = flags.has('--list') || flags.has('-l');
    const wantsUnset = flags.has('--unset') || flags.has('--unset-all');
    const wantsGetAll = flags.has('--get-all');
    const key = rest[0];
    if (flags.has('--get-regexp')) {
        const pattern = key ?? '';
        let re: RegExp;
        try { re = new RegExp(pattern); }
        catch { return fail('error: invalid key pattern: ' + pattern, 6); }
        const hits = repo.config.list().split('\n').filter((line) => line !== '' && re.test(line.slice(0, line.indexOf('='))));
        if (hits.length === 0) return ok('', '', 1);
        return ok(hits.map((line) => { const eq = line.indexOf('='); const k = line.slice(0, eq);
            return (showOrigin ? originFor(scopeOfKey(k)) : '') + k + ' ' + line.slice(eq + 1) + '\n'; }).join(''));
    }
    if (wantsList) {
        const scoped = flags.has('--global') || flags.has('--system') || flags.has('--local') || flags.has('--worktree') || file !== undefined;
        if (scoped) {
            const pre = showOrigin ? originFor(scope) : '';
            return ok(repo.config.readScope(scope).map((line) => pre + configLine(line)).join(''));
        }
        let out = '';
        for (const s of scopes) {
            const pre = showOrigin ? originFor(s) : '';
            for (const line of repo.config.readScope(s)) out += pre + configLine(line);
        }
        return ok(out);
    }
    if (key === undefined || key === '') return fail('usage: git config [<options>]', 129);
    if (!key.includes('.')) return fail('error: key does not contain a section: ' + key, 2);
    if (key.includes(' ')) return fail('error: invalid key: ' + key, 1);
    if (wantsUnset) {
        const code = repo.config.unset(scope, key, flags.has('--unset-all'));
        if (code === 5) return ok('', '', 5);
        if (code === 6) return fail('warning: ' + key + ' has multiple values', 5);
        return ok('');
    }
    if (wantsGetAll) {
        const vals = repo.config.getAll(key);
        if (vals.length === 0) return ok('', '', 1);
        const pre = showOrigin ? originFor(scopeOfKey(key)) : '';
        return ok(vals.map((v) => pre + v + '\n').join(''));
    }
    if (rest.length === 1 || flags.has('--get')) {
        const value = repo.config.get(key);
        if (value === undefined) return fail('', 1);
        return ok((showOrigin ? originFor(scopeOfKey(key)) : '') + value + '\n');
    }
    if (flags.has('--add')) {
        const path = (repo.config as unknown as { paths: Record<ConfigScope, string> }).paths[scope];
        const lines = repo.config.readScope(scope);
        const parts = key.split('.');
        lines.push({ section: parts[0].toLowerCase(), subsection: parts.length > 2 ? parts.slice(1, -1).join('.') : undefined,
            key: parts[parts.length - 1].toLowerCase(), value: rest.slice(1).join(' ') });
        ctx.fs.writeFile(path, formatLines(lines));
        return ok('');
    }
    const code = repo.config.set(scope, key, rest.slice(1).join(' '), flags.has('--replace-all'));
    if (code === 5) return fail('warning: ' + key + ' has multiple values\n' +
        'error: cannot overwrite multiple values with a single value\n' +
        '       Use a regexp, --add or --replace-all to change ' + key + '.', 5);
    return ok('');
}

function formatLines(lines: { section: string; subsection?: string; key: string; value: string }[]): string {
    const out: string[] = [];
    let last = '';
    for (const line of lines) {
        const head = line.subsection === undefined ? '[' + line.section + ']' : '[' + line.section + ' "' + line.subsection + '"]';
        if (head !== last) { if (out.length > 0) out.push(''); out.push(head); last = head; }
        out.push('\t' + line.key + ' = ' + line.value);
    }
    return out.length === 0 ? '' : out.join('\n') + '\n';
}

/* ---- plumbing: objects ---- */
function cmdHashObject(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    const type = values.get('-t') ?? 'blob';
    const write = flags.has('-w');
    let repo: GitRepo | undefined;
    if (write) { try { repo = GitRepo.discover(ctx); } catch { return fail('fatal: not a git repository (or any of the parent directories): .git', 128); } }
    const inputs: Uint8Array[] = [];
    if (flags.has('--stdin')) inputs.push(utf8(ctx.input ?? ''));
    for (const file of rest) {
        const bytes = ctx.fs.readBytes(file.startsWith('/') ? file : (ctx.cwd || '/app') + '/' + file);
        if (bytes === undefined) return fail('fatal: could not open ' + file + ' for reading: No such file or directory', 128);
        inputs.push(bytes);
    }
    if (inputs.length === 0) return fail('usage: git hash-object [-t <type>] [-w] [--stdin] <file>...', 129);
    let out = '';
    for (const bytes of inputs) {
        const oid = repo !== undefined ? repo.objects.write(type, bytes) : oidOf(type, bytes);
        out += oid + '\n';
    }
    return ok(out);
}
function cmdCatFile(ctx: CommandContext, raw: string[]): CommandResult {
    let repo: GitRepo;
    try { repo = GitRepo.discover(ctx); } catch (error) { return fatalResult(error); }
    /* Host git 2.53.0: --batch/--batch-check read object names from stdin, emit
       "<oid> <type> <size>" (and the object body for --batch) and exit 0 on EOF. */
    const batchCheck = raw.includes('--batch-check');
    const batch = raw.includes('--batch') || batchCheck;
    if (batch) {
        const input = ctx.input ?? '';
        let out = '';
        for (const name of input.split('\n')) {
            if (name === '') continue;
            const oid = repo.resolve(name);
            const obj = oid !== undefined ? repo.object(oid) : undefined;
            if (oid === undefined || obj === undefined) { out += name + ' missing\n'; continue; }
            out += oid + ' ' + obj.type + ' ' + obj.content.length + '\n';
            if (!batchCheck) out += text(obj.content) + '\n';
        }
        return ok(out);
    }
    const mode = raw.includes('-t') ? 't' : raw.includes('-s') ? 's' : raw.includes('-e') ? 'e' : 'p';
    const rev = raw.filter((entry) => !entry.startsWith('-'))[0] ?? '';
    if (rev === '') return fail('fatal: Not a valid object name \n', 128);
    const oid = repo.resolve(rev);
    if (oid === undefined) return fail('fatal: Not a valid object name ' + rev, 128);
    const obj = repo.object(oid);
    if (obj === undefined) {
        /* Host git 2.53.0: '-e' on a missing but well-formed object name is SILENT exit 1.
           '-t'/'-s' report "could not get object info"; '-p' reports the object name. */
        /* ok() does not append a newline: host '-e' on a missing oid is SILENT on both streams. */
        if (mode === 'e') return ok('', '', 1);
        if (mode === 't' || mode === 's') return fail('fatal: git cat-file: could not get object info\n', 128);
        return fail('fatal: Not a valid object name ' + rev, 128);
    }
    if (mode === 'e') return ok('');
    if (mode === 't') return ok(obj.type + '\n');
    if (mode === 's') return ok(String(obj.content.length) + '\n');
    if (obj.type === 'tree') {
        let out = '';
        for (const entry of parseTree(obj.content)) {
            const kind = entry.mode === '40000' ? 'tree' : 'blob';
            out += entry.mode.padStart(6, '0') + ' ' + kind + ' ' + entry.oid + '\t' + entry.name + '\n';
        }
        return ok(out);
    }
    return ok(text(obj.content));
}

function fatalResult(error: unknown): CommandResult {
    if (error instanceof GitError) return fail(error.message, error.code);
    return fail(error instanceof Error ? error.message : String(error), 128);
}

function cmdRevParse(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    let repo: GitRepo;
    try { repo = GitRepo.discover(ctx); } catch (error) { return fatalResult(error); }
    const targets = rest.filter((entry) => !entry.startsWith('-'));
    if (flags.has('--abbrev-ref')) {
        const ref = targets[0] ?? 'HEAD';
        return ok((ref === 'HEAD' ? repo.refs.branch() : ref) + '\n');
    }
    if (flags.has('--git-dir')) return ok(repo.gitDir + '\n');
    if (flags.has('--show-toplevel')) return ok(repo.root + '\n');
    if (flags.has('--is-inside-work-tree')) return ok('true\n');
    if (targets.length === 0) return ok((repo.refs.headOid() ?? '') + '\n');
    const verify = flags.has('--verify');
    let out = '';
    let bad: string | undefined;
    for (const target of targets) {
        const oid = repo.resolve(target);
        if (oid === undefined) {
            if (verify) return fail('fatal: Needed a single revision', 128);
            /* Host git 2.53.0 still echoes the literal on stdout, but dies 128 on the
               first ambiguous argument on stderr and stops before later targets. */
            out += target + '\n';
            bad = target;
            break;
        } else out += oid + '\n';
    }
    if (bad !== undefined) {
        return ok(out, "fatal: ambiguous argument '" + bad + "': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'\n", 128);
    }
    return ok(out);
}

function cmdLsFiles(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    let repo: GitRepo;
    try { repo = GitRepo.discover(ctx); } catch (error) { return fatalResult(error); }
    const entries = repo.indexEntries();
    if (flags.has('--stage') || flags.has('-s')) {
        return ok(entries.map((entry) => entry.mode.toString(8).padStart(6, '0') + ' ' + entry.oid + ' ' + entry.stage + '\t' + entry.path + '\n').join(''));
    }
    const filter = rest.filter((entry) => !entry.startsWith('-'));
    const chosen = filter.length > 0 ? entries.filter((entry) => filter.includes(entry.path)) : entries;
    return ok(chosen.map((entry) => entry.path + '\n').join(''));
}

function cmdWriteTree(ctx: CommandContext): CommandResult {
    let repo: GitRepo;
    try { repo = GitRepo.discover(ctx); } catch (error) { return fatalResult(error); }
    return ok(repo.buildTree(repo.indexTree()) + '\n');
}

function cmdCommitTree(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[],
    multi: Map<string, string[]>): CommandResult {
    let repo: GitRepo;
    try { repo = GitRepo.discover(ctx); } catch (error) { return fatalResult(error); }
    const tree = rest[0] ?? '';
    /* '-p' is repeatable and takes an oid value: resolve every parent to a full oid before
       serializing, so a merge commit really carries its parents (host git 2.53.0). */
    const parents = (multi.get('-p') ?? []).map((p) => repo.resolve(p) ?? p);
    const message = values.get('-m') ?? values.get('-F') ?? ctx.input ?? '';
    const info: CommitInfo = { tree, parents, author: repo.identity(), committer: repo.identity(),
        message: message.endsWith('\n') ? message : message + '\n', extra: [] };
    return ok(repo.objects.write('commit', serializeCommit(info)) + '\n');
}

function cmdUpdateIndex(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    let repo: GitRepo;
    try { repo = GitRepo.discover(ctx); } catch (error) { return fatalResult(error); }
    let entries = repo.indexEntries();
    const chmod = values.get('--chmod');
    if (chmod === '+x' || chmod === '-x') {
        const wanted = chmod === '+x' ? 0o100755 : 0o100644;
        for (const raw of rest) {
            entries = entries.filter((entry) => entry.path !== raw);
            entries.push({ ...repo.entryFor(raw), mode: wanted });
        }
        repo.writeIndexEntries(entries);
        return ok('');
    }
    const remove = flags.has('--remove');
    const add = flags.has('--add') || !remove;
    for (const raw of rest) {
        const comma = raw.split(',');
        if (comma.length === 3) {
            entries = entries.filter((entry) => entry.path !== comma[2]);
            entries.push({ path: comma[2], oid: comma[1], mode: parseInt(comma[0], 8) || 0o100644,
                size: 0, mtimeSec: 0, mtimeNs: 0, stage: 0 });
            continue;
        }
        if (remove) entries = entries.filter((entry) => entry.path !== raw);
        else if (add) {
            entries = entries.filter((entry) => entry.path !== raw);
            const entry = repo.entryFor(raw);
            if (entry.oid !== ZERO_OID) entries.push(entry);
        }
    }
    repo.writeIndexEntries(entries);
    return ok('');
}

function cmdReadTree(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    let repo: GitRepo;
    try { repo = GitRepo.discover(ctx); } catch (error) { return fatalResult(error); }
    const rev = rest[0] ?? 'HEAD';
    const oid = repo.resolve(rev);
    const commit = oid === undefined ? undefined : repo.readCommit(oid);
    const treeOid = commit !== undefined ? commit.tree : (repo.object(oid ?? '')?.type === 'tree' ? oid : undefined);
    if (treeOid === undefined) return fail('fatal: Not a valid object name ' + rev, 128);
    const flat = repo.flatTree(treeOid);
    const entries: IndexEntry[] = [];
    for (const [path, state] of flat) entries.push({ path, oid: state.oid, mode: state.mode,
        size: 0, mtimeSec: 0, mtimeNs: 0, stage: 0 });
    repo.writeIndexEntries(entries);
    if (flags.has('-u') || flags.has('--reset')) repo.checkoutTree(treeOid);
    return ok('');
}
/* ------------------------------------------------------------------ *
 * porcelain
 * ------------------------------------------------------------------ */

function discover(ctx: CommandContext): GitRepo | CommandResult {
    try { return GitRepo.discover(ctx); }
    catch (error) { return fatalResult(error); }
}
function asRepo(value: GitRepo | CommandResult): GitRepo | undefined { return value instanceof GitRepo ? value : undefined; }
function failed(value: GitRepo | CommandResult): CommandResult | undefined { return value instanceof GitRepo ? undefined : value; }
function worktreeState(repo: GitRepo, writeBlobs: boolean): Map<string, FileState> {
    const out = new Map<string, FileState>();
    for (const entry of repo.indexEntries()) {
        const bytes = repo.readBytes(repo.w(entry.path));
        if (bytes !== undefined) {
            const oid = writeBlobs ? repo.objects.write('blob', bytes) : repo.hashBlob(bytes);
            out.set(entry.path, { oid, mode: repo.worktreeMode(entry.path) });
        }
    }
    return out;
}
function expandPaths(repo: GitRepo, args: string[], all = false): string[] {
    const files = repo.worktreeFiles();
    if (all || args.length === 0 || args.includes('.') || args.includes('-A')) return files.filter((path) => !repo.ignored(path));
    const out = new Set<string>();
    for (const arg of args) { for (const file of files) if (file === arg || file.startsWith(arg + '/')) out.add(file); }
    return [...out].sort();
}

function cmdStatus(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[], short: boolean): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const view = statusOf(repo);
    const withBranch = flags.has('-b') || flags.has('--branch');
    // --ignored arrives as a bare flag or as --ignored=<mode>; parseFlags puts the
    // "=" form into values (not flags), so honour both spellings here.
    const ignoredMode = values.get('--ignored');
    const showIgnored = (flags.has('--ignored') || ignoredMode !== undefined) && ignoredMode !== 'no';
    const matching = ignoredMode === 'matching';
    const index = repo.indexTree();
    const ignored = repo.worktreeFiles().filter((path) => !index.has(path) && isIgnored(repo, path));
    const opts = { ignored, showIgnored, matching };
    if (values.get('--porcelain') === 'v2') return ok(porcelainV2(view, withBranch, opts));
    if (short) {
        const nul = flags.has('-z');
        const ignoredSet = new Set(ignored);
        const left = { ...view, untracked: view.untracked.filter((path) => !ignoredSet.has(path)) };
        const base = shortStatus(left, withBranch, nul);
        if (!showIgnored) return ok(base);
        return ok(base + ignoredRows(ignored, '!!', matching, nul));
    }
    return ok(longStatus(view));
}

function cmdAdd(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const all = flags.has('--all') || flags.has('-A');
    const update = flags.has('-u') || flags.has('--update');
    let paths: string[];
    if (update) paths = repo.indexEntries().map((entry) => entry.path).filter((path) => repo.exists(repo.w(path)));
    else paths = expandPaths(repo, rest.filter((r) => !r.startsWith('-')), all);
    if (paths.length === 0 && rest.length > 0 && !all && !update) return fail("fatal: pathspec '" + rest[0] + "' did not match any files", 128);
    let entries = repo.indexEntries();
    for (const path of paths) {
        entries = entries.filter((entry) => entry.path !== path);
        if (repo.exists(repo.w(path))) entries.push(repo.entryFor(path));
    }
    repo.writeIndexEntries(entries);
    return ok('');
}

function cmdRm(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const paths = rest.filter((r) => !r.startsWith('-'));
    let out = '';
    let entries = repo.indexEntries();
    for (const path of paths) {
        entries = entries.filter((entry) => entry.path !== path);
        if (!flags.has('--cached')) repo.remove(repo.w(path));
        out += "rm '" + path + "'\n";
    }
    repo.writeIndexEntries(entries);
    return ok(out);
}

function cmdMv(ctx: CommandContext, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    if (rest.length < 2) return fail('fatal: no source or destination specified', 128);
    const source = rest[0], target = rest[1];
    const entries = repo.indexEntries().map((entry) => entry.path === source ? { ...entry, path: target } : entry);
    const bytes = repo.readBytes(repo.w(source));
    if (bytes !== undefined) { repo.writeBytes(repo.w(target), bytes); repo.remove(repo.w(source)); }
    repo.writeIndexEntries(entries);
    return ok('');
}

function cmdClean(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const dry = flags.has('-n') || flags.has('--dry-run');
    const force = flags.has('-f') || flags.has('--force');
    const interactive = flags.has('-i');
    /* Host requires -f (or -n/-i) as a safety gate; never delete a file the host would keep. */
    if (!dry && !force && !interactive) return fail('fatal: clean.requireForce is true and -f not given: refusing to clean\n', 128);
    const dirs = flags.has('-d');
    const all = flags.has('-x');
    /* Host git 2.53.0: clean never lists TRACKED files. Without -x ignored
       paths are excluded; -x adds them back but never adds index entries. */
    const index = repo.indexTree();
    const ignoredPaths = new Set(repo.worktreeFiles()
        .filter((path) => !index.has(path) && isIgnored(repo, path)));
    const candidates = repo.worktreeFiles()
        .filter((path) => !index.has(path) && (all || !ignoredPaths.has(path)));
    const targets: string[] = [];
    const seenDirs = new Set<string>();
    for (const path of candidates) {
        const slash = path.indexOf('/');
        if (slash < 0) targets.push(path);
        else if (dirs) { const dir = path.slice(0, slash); if (!seenDirs.has(dir)) { seenDirs.add(dir); targets.push(dir + '/'); } }
    }
    let out = '';
    for (const target of targets) {
        if (dry) out += 'Would remove ' + target + '\n';
        else { repo.remove(repo.w(target.replace(/\/$/, ''))); out += 'Removing ' + target + '\n'; }
    }
    return ok(out);
}

function cmdCommit(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const amend = flags.has('--amend');
    const allowEmpty = flags.has('--allow-empty');
    const all = flags.has('-a') || flags.has('--all');
    if (all) {
        let entries = repo.indexEntries();
        for (const path of repo.indexEntries().map((entry) => entry.path)) {
            entries = entries.filter((entry) => entry.path !== path);
            if (repo.exists(repo.w(path))) entries.push(repo.entryFor(path));
        }
        repo.writeIndexEntries(entries);
    }
    const view = statusOf(repo);
    if (view.staged.length === 0 && !amend && !allowEmpty) return ok(longStatus(view, true), '', 1);
    let message = values.get('-m') ?? values.get('--message');
    if (message === undefined && values.has('-F')) message = repo.readText(repo.w(values.get('-F') as string)) ?? '';
    if (message === undefined) message = amend ? repo.subjectOf(repo.refs.headOid() ?? '') : '';
    if (message.trim() === '' && !amend) return fail('Aborting commit due to empty commit message.', 1);
    const root = repo.refs.headOid() === undefined;
    const oldAuthor = amend ? repo.readCommit(repo.refs.headOid() ?? '')?.author : undefined;
    const made = makeCommit(repo, message, { amend });
    return ok(commitHeader(repo, made.changes, message, made.oid, root && !amend, amend, oldAuthor ?? repo.identity()));
}

function cmdLog(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const rev = rest.find((entry) => !entry.startsWith('-'));
    const start = rev === undefined ? repo.refs.headOid() : repo.resolve(rev);
    if (start === undefined) return fail("fatal: your current branch '" + repo.refs.branch() + "' does not have any commits yet", 128);
    /* Host git 2.53.0: -1/-3 shorthands are max-count, as are -n and --max-count. */
    const shortMax = [...flags].find((flag) => /^-\d+$/.test(flag));
    const max = parseInt(values.get('-n') ?? values.get('--max-count') ?? (shortMax !== undefined ? shortMax.slice(1) : '100'), 10) || 100;
    let entries: { oid: string; info: CommitInfo }[];
    if (flags.has('--all')) {
        /* --all walks every ref tip; host orders by date, breaking ties by ref traversal. */
        const tips: string[] = [];
        for (const name of repo.refs.branches()) { const oid = repo.refs.read('refs/heads/' + name); if (oid !== undefined) tips.push(oid); }
        for (const name of repo.refs.tags()) { const oid = repo.refs.read('refs/tags/' + name); if (oid !== undefined) tips.push(oid); }
        const head = repo.refs.headOid(); if (head !== undefined) tips.push(head);
        const seen = new Set<string>(); entries = [];
        for (const tip of tips) for (const entry of repo.logEntries(tip, 1000)) {
            if (seen.has(entry.oid)) continue;
            seen.add(entry.oid); entries.push(entry);
        }
        entries = entries.slice(0, max);
    } else {
        entries = repo.logEntries(start, max);
    }
    const graph = flags.has('--graph');
    const stat = flags.has('--stat');
    const patch = flags.has('-p') || flags.has('--patch');
    const changesFor = (entry: { oid: string; info: CommitInfo }) => {
        const parent = entry.info.parents[0];
        const parentTree = parent === undefined ? '' : (repo.readCommit(parent)?.tree ?? '');
        return parentTree === '' ? repo.changesBetween(new Map(), repo.flatTree(entry.info.tree))
            : repo.changesBetween(repo.flatTree(parentTree), repo.flatTree(entry.info.tree));
    };
    if (flags.has('--oneline')) {
        return ok(entries.map((entry) => (graph ? '* ' : '') + abbrev(entry.oid) + ' ' + entry.info.message.trim().split('\n')[0] + '\n').join(''));
    }
    if (graph && !stat && !patch) {
        /* Host draws a linear chain: '* ' first line, '| ' continuation, two spaces at root. */
        const blocks = entries.map((entry, index) => {
            const lines = mediumLog(repo, entry.oid, entry.info).split('\n');
            const last = index === entries.length - 1;
            const body = last ? lines.slice(0, -1) : lines;
            return body.map((line, i) => (i === 0 ? '* ' : (last ? '  ' : '| ')) + line).join('\n');
        });
        return ok(blocks.join('\n') + '\n');
    }
    return ok(entries.map((entry, index) => {
        let block = (index === 0 ? '' : '\n') + mediumLog(repo, entry.oid, entry.info);
        if (stat && patch) block += '---\n' + renderStat(repo, changesFor(entry), 80, false) + '\n' + renderDiff(repo, changesFor(entry));
        else if (stat) block += '\n' + renderStat(repo, changesFor(entry), 80, false);
        else if (patch) block += '\n' + renderDiff(repo, changesFor(entry));
        return block;
    }).join(''));
}

function cmdShow(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const rev = rest[0] ?? 'HEAD';
    const colonAt = rev.indexOf(':');
    if (colonAt > 0) {
        const blob = repo.blobAt(rev.slice(0, colonAt), rev.slice(colonAt + 1));
        if (blob === undefined) return fail("fatal: path '" + rev.slice(colonAt + 1) + "' does not exist in '" + rev.slice(0, colonAt) + "'", 128);
        return ok(text(blob));
    }
    let oid = repo.resolve(rev);
    if (oid === undefined) return fail('fatal: bad revision ' + rev, 128);
    let tagHeader = '';
    const tagged = repo.object(oid);
    if (tagged !== undefined && tagged.type === 'tag') {
        const tag = parseTag(tagged.content);
        tagHeader = 'tag ' + tag.tag + '\nTagger: ' + tag.tagger.name + ' <' + tag.tagger.email + '>\n' +
            'Date:   ' + mediumDate(tag.tagger.ts, tag.tagger.tz) + '\n\n' +
            tag.message.replace(/\n$/, '') + '\n\n';
        oid = tag.object;
    }
    const blob = repo.readBlob(oid);
    if (blob !== undefined) return ok(binaryString(blob));
    const info = repo.readCommit(oid);
    if (info === undefined) return fail('fatal: bad object ' + rev, 128);
    const parentTree = info.parents.length > 0 ? (repo.readCommit(info.parents[0])?.tree ?? '') : '';
    const changes = parentTree === '' ? repo.changesBetween(new Map(), repo.flatTree(info.tree))
        : repo.changesBetween(repo.flatTree(parentTree), repo.flatTree(info.tree));
    /* Host git 2.53.0: --stat renders the diffstat (no patch, no create-mode lines);
       --oneline replaces the commit header with "<abbrev> <subject>". */
    if (flags.has('--stat') || flags.has('--oneline')) {
        const header = flags.has('--oneline')
            ? abbrev(oid) + ' ' + info.message.trim().split('\n')[0] + '\n'
            : mediumLog(repo, oid, info) + '\n';
        const body = flags.has('--stat') ? renderStat(repo, changes, 80, false) : renderDiff(repo, changes);
        return ok(tagHeader + header + body);
    }
    return ok(tagHeader + mediumLog(repo, oid, info) + '\n' + renderDiff(repo, changes));
}

function cmdDiff(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const cached = flags.has('--cached') || flags.has('--staged');
    const rev = rest.filter((r) => !r.startsWith('-'))[0];
    const base = new Map<string, FileState>();
    let next = new Map<string, FileState>();
    if (cached) {
        for (const [path, state] of repo.headTree()) base.set(path, state);
        for (const [path, state] of repo.indexTree()) next.set(path, state);
    } else if (rev !== undefined) {
        const oid = repo.resolve(rev);
        const commit = oid === undefined ? undefined : repo.readCommit(oid);
        const tree = commit !== undefined ? commit.tree : undefined;
        if (tree !== undefined) for (const [path, state] of repo.flatTree(tree)) base.set(path, state);
        next = worktreeState(repo, true);
    } else {
        for (const [path, state] of repo.indexTree()) base.set(path, state);
        next = worktreeState(repo, true);
    }
    const changes = repo.changesBetween(base, next);
    if (flags.has('--name-only')) return ok(changes.map((c) => c.path + '\n').join(''));
    if (flags.has('--stat')) {
        /* Host 'git diff --stat' never prints create/delete mode lines (git merge's fast-forward
           summary does), so suppress them for this call only. */
        const stat = renderStat(repo, changes, 80, false);
        return ok(stat, '', flags.has('--exit-code') && changes.length > 0 ? 1 : 0);
    }
    const diff = renderDiff(repo, changes);
    return ok(diff, '', flags.has('--exit-code') && diff !== '' ? 1 : 0);
}

function cmdBranch(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const names = rest.filter((r) => !r.startsWith('-'));
    const moveValue = values.get('-m');
    const wantsMove = moveValue !== undefined || flags.has('-m') || flags.has('--move');
    if (wantsMove && !flags.has('-d') && !flags.has('-D') && !flags.has('--delete')) {
        const args = moveValue !== undefined ? [moveValue, ...names] : names;
        const from = args.length > 1 ? args[0] : repo.refs.branch();
        const to = args.length > 1 ? args[1] : args[0];
        if (to !== undefined) {
            const oid = repo.refs.read('refs/heads/' + from);
            if (oid !== undefined) repo.refs.writeRef('refs/heads/' + to, oid);
            repo.refs.removeRef('refs/heads/' + from);
            if (repo.refs.headRef() === 'refs/heads/' + from) repo.refs.setHead('refs/heads/' + to);
        }
        return ok('');
    }
    if (flags.has('-d') || flags.has('-D') || flags.has('--delete')) {
        const force = flags.has('-D');
        let out = '';
        for (const name of names) {
            const oid = repo.refs.read('refs/heads/' + name);
            const head = repo.refs.headOid();
            if (!force && oid !== undefined && head !== undefined &&
                repo.commonAncestor(head, oid) !== oid) {
                return fail("error: the branch '" + name + "' is not fully merged\n" +
                    "hint: If you are sure you want to delete it, run 'git branch -D " + name + "'\n" +
                    'hint: Disable this message with "git config set advice.forceDeleteBranch false"', 1);
            }
            repo.refs.removeRef('refs/heads/' + name);
            out += 'Deleted branch ' + name + ' (was ' + abbrev(oid ?? ZERO_OID) + ').\n';
        }
        return ok(out);
    }
    if (flags.has('-m') || flags.has('--move')) {
        const from = names[0] ?? repo.refs.branch(), to = names[1] ?? '';
        const oid = repo.refs.read('refs/heads/' + from);
        if (oid !== undefined) repo.refs.writeRef('refs/heads/' + to, oid);
        repo.refs.removeRef('refs/heads/' + from);
        if (repo.refs.headRef() === 'refs/heads/' + from) repo.refs.setHead('refs/heads/' + to);
        return ok('');
    }
    if (names.length > 0) {
        const oid = repo.refs.headOid();
        if (oid === undefined) return fail('fatal: Not a valid object name: ' + "'" + names[0] + "'.", 128);
        repo.refs.writeRef('refs/heads/' + names[0], oid);
        return ok('');
    }
    const current = repo.refs.branch();
    return ok(repo.refs.branches().map((name) => (name === current ? '* ' : '  ') + name + '\n').join(''));
}

function switchBranch(repo: GitRepo, name: string, create: boolean): CommandResult {
    const oid = repo.refs.headOid();
    if (create) {
        if (oid !== undefined) repo.refs.writeRef('refs/heads/' + name, oid);
        repo.refs.setHead('refs/heads/' + name);
        return ok('', "Switched to a new branch '" + name + "'\n");
    }
    const target = repo.refs.read('refs/heads/' + name);
    if (target === undefined) return fail('fatal: invalid reference: ' + name, 128);
    const from = repo.refs.branch();
    repo.remove(repo.g('OWC_DETACH_LABEL'));
    repo.refs.setHead('refs/heads/' + name);
    repo.checkoutTree(target);
    repo.refs.appendReflog('HEAD', target, target, repo.who(), 'checkout: moving from ' + from + ' to ' + name, repo.identity().ts, repo.identity().tz);
    return ok('', "Switched to branch '" + name + "'\n");
}

function cmdCheckout(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const create = flags.has('-b') || flags.has('-B') || flags.has('--branch') || values.has('-b') || values.has('-B') || values.has('--branch');
    let name = create ? (values.get('-b') ?? values.get('-B') ?? values.get('--branch')) : rest[0];
    if (create && name !== undefined) return switchBranch(repo, name, true);
    if (flags.has('--')) {
        for (const path of rest.filter((r) => r !== '--')) {
            const state = repo.indexTree().get(path);
            if (state !== undefined) { const blob = repo.readBlob(state.oid); if (blob !== undefined) repo.writeBytes(repo.w(path), blob); }
        }
        return ok('');
    }
    if (name === undefined) return fail('fatal: you are on a branch yet to be born', 128);
    /* Host git 2.53.0: the - and @{-N} forms name the previous
       checkout target recorded in .git/logs/HEAD. Resolve it to that commit's
       full oid so the Note line and the detach path use the
       same name the host prints. */
    if (name === '-' || (name.startsWith('@{-') && name.endsWith('}'))) {
        const hops = name === '-' ? 1 : Number(name.slice(3, -1));
        const moves = repo.refs.reflog('HEAD')
            .filter((entry) => entry.message.startsWith('checkout: moving from '));
        const from = moves[moves.length - hops];
        /* Host git 2.53.0: - / @{-N} name the previous checkout SOURCE. When
           that source is a live branch, switching back stays attached; a
           detached oid keeps the detach path and its 609 B advice block. */
        const prior = from === undefined ? undefined
            : /^checkout: moving from (\S+) to /.exec(from.message)?.[1];
        if (prior !== undefined && repo.refs.branches().includes(prior)) name = prior;
        else if (from !== undefined && repo.resolve(from.old) !== undefined) name = from.old;
    }
    if (repo.refs.branches().includes(name)) return switchBranch(repo, name, false);
    let oid = repo.resolve(name);
    if (oid === undefined) return fail("error: pathspec '" + name + "' did not match any file(s) known to git", 1);
    const resolved = repo.object(oid);
    if (resolved !== undefined && resolved.type === 'tag') oid = parseTag(resolved.content).object;
    const wasAttached = repo.refs.head().ref !== undefined;
    const prevOid = repo.refs.headOid();
    /* Host git 2.53.0: a checkout that carries local modifications across
       prints one short-status line per modified path on stdout. */
    const dirtyNotice = statusOf(repo).rows.filter((row) => row.unstaged)
        .map((row) => row.y + String.fromCharCode(9) + row.path + String.fromCharCode(10)).join('');
    /* Host git 2.53.0: a symbolic checkout of HEAD that resolves to the
       current commit is a silent no-op: an attached HEAD stays attached and
       nothing is printed. An explicit oid/tag at the same commit keeps its
       HEAD line, and --detach forces the HEAD line. */
    if ((name === 'HEAD' || name === '@') && !flags.has('--detach') &&
        prevOid !== undefined && prevOid === oid) {
        return ok(dirtyNotice, '');
    }
    repo.refs.setDetached(oid);
    /* git describe uses the checked-out tag name for the detached label; a raw oid or HEAD uses
       the abbreviated oid. */
    if (repo.refs.tags().includes(name)) repo.writeText(repo.g('OWC_DETACH_LABEL'), name);
    else repo.remove(repo.g('OWC_DETACH_LABEL'));
    repo.checkoutTree(oid);
    /* Host git 2.53.0: -q/--quiet suppresses every checkout status/advice
       line on stderr; the local-change notice on stdout is unaffected. */
    if (flags.has('-q') || flags.has('--quiet')) return ok(dirtyNotice, '');
    const headLine = 'HEAD is now at ' + abbrev(oid) + ' ' + repo.subjectOf(oid) + '\n';
    /* Host git 2.53.0: any checkout that detaches HEAD from an attached branch
       prints a "Note: switching to" line plus the detached-HEAD advice block on
       stderr before "HEAD is now at ...", whether the argument is a named tag,
       a short ref, a full commit oid or HEAD~1. Only --detach, an already
       detached HEAD, or advice.detachedHead=false (config or -c) suppress it. */
    if (!flags.has('--detach') && wasAttached) {
        const advice = repo.configOverrides().get('advice.detachedhead') ?? repo.config.get('advice.detachedhead');
        if (advice === undefined || !/^(false|no|off|0)$/i.test(advice)) {
            return ok(dirtyNotice, "Note: switching to '" + name + "'.\n\n" +
                "You are in 'detached HEAD' state. You can look around, make experimental\n" +
                "changes and commit them, and you can discard any commits you make in this\n" +
                "state without impacting any branches by switching back to a branch.\n\n" +
                "If you want to create a new branch to retain commits you create, you may\n" +
                "do so (now or later) by using -c with the switch command. Example:\n\n" +
                "  git switch -c <new-branch-name>\n\n" +
                "Or undo this operation with:\n\n" +
                "  git switch -\n\n" +
                "Turn off this advice by setting config variable advice.detachedHead to false\n\n" + headLine);
        }
    }
    /* Host git 2.53.0: moving from an already-detached HEAD to a DIFFERENT
       commit prints the previous position on stderr before the HEAD line.
       The detached-HEAD advice block stays ABSENT on this path; a same-oid
       no-op, a branch switch and the --detach-from-attached suppression all
       print only the HEAD line. */
    if (!wasAttached && prevOid !== undefined && prevOid !== oid) {
        return ok(dirtyNotice, 'Previous HEAD position was ' + abbrev(prevOid) + ' ' +
            repo.subjectOf(prevOid) + '\n' + headLine);
    }
    /* Host git 2.53.0: `checkout HEAD` on an already-detached HEAD is a
       symbolic no-op that prints nothing, while an explicit oid or a tag
       resolving to that same commit still prints the HEAD line; `--detach`
       forces the HEAD line even for the symbolic name. */
    if (name === 'HEAD' && !flags.has('--detach') && !wasAttached &&
        prevOid !== undefined && prevOid === oid) {
        return ok(dirtyNotice, '');
    }
    return ok(dirtyNotice, headLine);
}

function cmdSwitch(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const create = flags.has('-c') || flags.has('-C') || flags.has('--create') || values.has('-c') || values.has('-C') || values.has('--create');
    let name = create ? (values.get('-c') ?? values.get('-C') ?? values.get('--create')) : rest[0];
    if (name === undefined) return fail('fatal: missing branch or commit argument', 128);
    /* Host git 2.53.0: 'switch -' / @{-N} return to the previous checkout
       source in .git/logs/HEAD, exactly like 'checkout -'. */
    if (name === '-' || (name.startsWith('@{-') && name.endsWith('}'))) {
        const hops = name === '-' ? 1 : Number(name.slice(3, -1));
        const moves = repo.refs.reflog('HEAD')
            .filter((entry) => entry.message.startsWith('checkout: moving from '));
        const from = moves[moves.length - hops];
        const prior = from === undefined ? undefined
            : /^checkout: moving from (\S+) to /.exec(from.message)?.[1];
        if (prior !== undefined && repo.refs.branches().includes(prior)) name = prior;
        else if (from !== undefined && repo.resolve(from.old) !== undefined) name = from.old;
        else name = name === '-' ? '@{-1}' : name;
    }
    return switchBranch(repo, name, create);
}

function cmdRestore(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const paths = rest.filter((r) => !r.startsWith('-'));
    const staged = flags.has('--staged');
    const worktree = flags.has('--worktree') || !staged;
    const source = values.get('--source') ?? 'HEAD';
    const sourceOid = repo.resolve(source);
    const sourceTree = sourceOid === undefined ? undefined : repo.readCommit(sourceOid)?.tree;
    const sourceFlat = sourceTree !== undefined ? repo.flatTree(sourceTree) : repo.indexTree();
    let entries = repo.indexEntries();
    for (const path of paths) {
        if (staged) {
            const state = sourceFlat.get(path);
            entries = entries.filter((entry) => entry.path !== path);
            if (state !== undefined) entries.push({ path, oid: state.oid, mode: state.mode, size: 0, mtimeSec: 0, mtimeNs: 0, stage: 0 });
        }
        if (worktree) {
            const state = repo.indexTree().get(path);
            if (state !== undefined) { const blob = repo.readBlob(state.oid); if (blob !== undefined) repo.writeBytes(repo.w(path), blob); }
            else repo.remove(repo.w(path));
        }
    }
    if (staged) repo.writeIndexEntries(entries);
    return ok('');
}

function cmdMerge(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    /* Host git 2.53.0: merge --abort with no MERGE_HEAD is a fatal 128; with one it
       restores the pre-merge index/worktree silently. */
    if (flags.has('--abort')) {
        const mergeHead = repo.readText(repo.g('MERGE_HEAD'));
        if (mergeHead === undefined || mergeHead.trim() === '') return fail('fatal: There is no merge to abort (MERGE_HEAD missing).', 128);
        const abortHead = repo.refs.headOid();
        if (abortHead !== undefined) {
            const commit = repo.readCommit(abortHead);
            if (commit !== undefined) {
                const tree = repo.flatTree(commit.tree);
                const entries: IndexEntry[] = [];
                for (const [path, state] of tree) entries.push({ path, oid: state.oid, mode: state.mode, size: 0, mtimeSec: 0, mtimeNs: 0, stage: 0 });
                repo.writeIndexEntries(entries);
                repo.checkoutTree(commit.tree);
            }
        }
        repo.remove(repo.g('MERGE_HEAD'));
        return ok('');
    }
    const name = rest[0] ?? '';
    const other = repo.resolve(name);
    const head = repo.refs.headOid();
    if (other === undefined || head === undefined) return fail('fatal: ' + name + ' - not something we can merge', 128);
    const headCommit = repo.readCommit(head), otherCommit = repo.readCommit(other);
    if (headCommit === undefined || otherCommit === undefined) return fail('fatal: bad object', 128);
    const base = repo.commonAncestor(head, other);
    if (base === head && !flags.has('--no-ff')) {
        updateHead(repo, other, 'merge ' + name + ': Fast-forward', head);
        repo.checkoutTree(otherCommit.tree);
        const changes = repo.changesBetween(repo.flatTree(headCommit.tree), repo.flatTree(otherCommit.tree));
        return ok('Updating ' + abbrev(head) + '..' + abbrev(other) + '\nFast-forward\n' + renderStat(repo, changes));
    }
    const baseTree = base === undefined ? new Map<string, FileState>() : repo.flatTree(repo.readCommit(base)?.tree ?? '');
    const ours = repo.flatTree(headCommit.tree), theirs = repo.flatTree(otherCommit.tree);
    const merged = new Map<string, FileState>(baseTree);
    const conflicts: string[] = [];
    const paths = new Set([...baseTree.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
        const b = baseTree.get(path), o = ours.get(path), t = theirs.get(path);
        if (o !== undefined && t !== undefined && o.oid === t.oid) { merged.set(path, o); continue; }
        if (o !== undefined && (t === undefined || (b !== undefined && t.oid === b.oid))) { merged.set(path, o); continue; }
        if (t !== undefined && (o === undefined || (b !== undefined && o.oid === b.oid))) { merged.set(path, t); continue; }
        if (o === undefined && t === undefined) { merged.delete(path); continue; }
        conflicts.push(path);
    }
    if (conflicts.length > 0) {
        repo.writeText(repo.g('MERGE_HEAD'), other + '\n');
        let entries = repo.indexEntries().filter((entry) => !conflicts.includes(entry.path));
        for (const path of conflicts) {
            const b = baseTree.get(path), o = ours.get(path), t = theirs.get(path);
            for (const [stage, state] of [[1, b], [2, o], [3, t]] as [number, FileState | undefined][]) {
                if (state !== undefined) entries.push({ path, oid: state.oid, mode: state.mode,
                    size: 0, mtimeSec: 0, mtimeNs: 0, stage });
            }
            const oursText = o === undefined ? '' : text(repo.readBlob(o.oid) ?? new Uint8Array());
            const theirsText = t === undefined ? '' : text(repo.readBlob(t.oid) ?? new Uint8Array());
            repo.writeBytes(repo.w(path), utf8('<<<<<<< HEAD\n' + oursText + '=======\n' + theirsText + '>>>>>>> ' + name + '\n'));
        }
        repo.writeIndexEntries(entries);
        return ok('Auto-merging ' + conflicts.join(', ') + '\nCONFLICT (content): Merge conflict in ' + conflicts[0] +
            '\nAutomatic merge failed; fix conflicts and then commit the result.\n', '', 1);
    }
    const treeOid = repo.buildTree(merged);
    makeCommit(repo, 'Merge branch ' + "'" + name + "'", { parents: [head, other], tree: treeOid });
    repo.checkoutTree(treeOid, false);
    const changes = repo.changesBetween(ours, merged);
    return ok("Merge made by the 'ort' strategy.\n" + renderStat(repo, changes));
}

function cmdReset(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const mode = flags.has('--soft') ? 'soft' : flags.has('--hard') ? 'hard' : 'mixed';
    const rev = rest[0] ?? 'HEAD';
    const oid = repo.resolve(rev);
    if (oid === undefined) return fail("fatal: ambiguous argument '" + rev + "': unknown revision or path not in the working tree.", 128);
    const commit = repo.readCommit(oid);
    if (commit === undefined) return fail('fatal: bad object ' + rev, 128);
    const old = repo.refs.headOid();
    updateHead(repo, oid, 'reset: moving to ' + rev, old);
    if (mode === 'soft') return ok('');
    const tree = repo.flatTree(commit.tree);
    const entries: IndexEntry[] = [];
    for (const [path, state] of tree) entries.push({ path, oid: state.oid, mode: state.mode, size: 0, mtimeSec: 0, mtimeNs: 0, stage: 0 });
    if (mode === 'hard') {
        repo.checkoutTree(commit.tree);
        return ok('HEAD is now at ' + abbrev(oid) + ' ' + repo.subjectOf(oid) + '\n');
    }
    repo.writeIndexEntries(entries);
    const view = statusOf(repo);
    let out = '';
    if (view.unstaged.length > 0) {
        out += 'Unstaged changes after reset:\n';
        for (const change of view.unstaged) out += (change.status === 'D' ? 'D' : 'M') + '\t' + change.path + '\n';
    }
    return ok(out);
}

/* Host git 2.53.0: 'tag -l' filters tag names with fnmatch-style globs. */
function tagGlob(pattern: string): RegExp {
    let out = '^';
    for (const ch of pattern) {
        if (ch === '*') out += '.*';
        else if (ch === '?') out += '.';
        else if (/[A-Za-z0-9]/.test(ch)) out += ch;
        else out += String.fromCharCode(92) + ch;
    }
    return new RegExp(out + '$');
}

function cmdTag(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const names = rest.filter((r) => !r.startsWith('-'));
    if (flags.has('-d') || flags.has('--delete')) {
        let deleted = '';
        for (const name of names) {
            const oid = repo.refs.read('refs/tags/' + name);
            if (oid === undefined) return fail("error: tag '" + name + "' not found.", 1);
            repo.refs.removeRef('refs/tags/' + name);
            deleted += "Deleted tag '" + name + "' (was " + abbrev(oid) + ")\n";
        }
        return ok(deleted);
    }
    if (names.length === 0 || flags.has('-l') || flags.has('--list')) {
        const listed = (flags.has('-l') || flags.has('--list')) && names.length > 0
            ? names.map(tagGlob) : [];
        return ok(repo.refs.tags()
            .filter((tag) => listed.length === 0 || listed.some((re) => re.test(tag)))
            .map((name) => name + '\n').join(''));
    }
    const head = repo.refs.headOid();
    if (head === undefined) return fail('fatal: Failed to resolve HEAD as a valid ref.', 128);
    const name = names[0];
    if (flags.has('-a') || flags.has('--annotate')) {
        const message = values.get('-m') ?? '';
        const oid = repo.objects.write('tag', serializeTag({ object: head, type: 'commit', tag: name, tagger: repo.identity(), message: message.endsWith('\n') ? message : message + '\n' }));
        repo.refs.writeRef('refs/tags/' + name, oid);
    } else repo.refs.writeRef('refs/tags/' + name, head);
    return ok('');
}

function stashDrop(repo: GitRepo): void {
    repo.refs.removeRef('refs/stash');
    repo.remove(repo.g('logs/refs/stash'));
}
function stashChanges(repo: GitRepo, oid: string): { parent: string | undefined; changes: Change[] } | undefined {
    const stash = repo.readCommit(oid);
    if (stash === undefined) return undefined;
    const parent = stash.parents[0];
    const parentCommit = parent === undefined ? undefined : repo.readCommit(parent);
    const changes = parentCommit !== undefined ? repo.changesBetween(repo.flatTree(parentCommit.tree), repo.flatTree(stash.tree))
        : repo.changesBetween(new Map(), repo.flatTree(stash.tree));
    return { parent, changes };
}
function applyStashToWorktree(repo: GitRepo, changes: Change[]): void {
    for (const change of changes) {
        if (change.newOid !== undefined) { const blob = repo.readBlob(change.newOid); if (blob !== undefined) repo.writeBytes(repo.w(change.path), blob); }
        else repo.remove(repo.w(change.path));
    }
}
function cmdStash(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const action = rest[0] ?? 'push';
    if (action === 'list') {
        return ok(repo.refs.reflog('refs/stash').map((entry, index) => 'stash@{' + index + '}: ' + entry.message + '\n').join(''));
    }
    const stashOid = repo.refs.read('refs/stash');
    if (action === 'clear') { stashDrop(repo); return ok(''); }
    if (action === 'drop') {
        if (stashOid === undefined) return fail('No stash entries found.', 1);
        stashDrop(repo);
        return ok('Dropped refs/stash@{0} (' + stashOid + ')\n');
    }
    if (action === 'show') {
        if (stashOid === undefined) return fail('No stash entries found.', 1);
        const info = stashChanges(repo, stashOid);
        if (info === undefined) return fail('No stash entries found.', 1);
        if (flags.has('-p') || flags.has('--patch')) return ok(renderDiff(repo, info.changes));
        return ok(renderStat(repo, info.changes));
    }
    if (action === 'pop' || action === 'apply' || action === 'branch') {
        if (stashOid === undefined) return fail('No stash entries found.', 1);
        const info = stashChanges(repo, stashOid);
        if (info === undefined) return fail('No stash entries found.', 1);
        let branchStderr = '';
        if (action === 'branch') {
            const name = rest[1] ?? '';
            if (name === '') return fail('fatal: No branch name specified', 128);
            if (info.parent !== undefined) {
                repo.refs.writeRef('refs/heads/' + name, info.parent);
                repo.refs.setHead('refs/heads/' + name);
                const parentCommit = repo.readCommit(info.parent);
                if (parentCommit !== undefined) repo.checkoutTree(parentCommit.tree);
            }
            branchStderr = "Switched to a new branch '" + name + "'\n";
        }
        /* git stash pop/branch restores the WORKTREE only: the index stays at HEAD, so the
           changes are unstaged (host prints "Changes not staged for commit"). */
        applyStashToWorktree(repo, info.changes);
        if (action === 'pop' || action === 'branch') stashDrop(repo);
        return ok(longStatus(statusOf(repo)) + 'Dropped refs/stash@{0} (' + stashOid + ')\n', branchStderr);
    }
    const view = statusOf(repo);
    const includeUntracked = flags.has('-u') || flags.has('--include-untracked');
    const untracked = includeUntracked ? view.untracked : [];
    if (view.unstaged.length === 0 && view.staged.length === 0 && untracked.length === 0) return ok('No local changes to save\n');
    const head = repo.refs.headOid();
    if (head === undefined) return fail('fatal: You do not have the initial commit yet', 128);
    const state = worktreeState(repo, true);
    /* Host git 2.53.0: -u saves untracked files in the stash tree and removes them from
       the worktree; -m/--message replaces the WIP subject with "On <branch>: <msg>". */
    for (const path of untracked) {
        const bytes = repo.readBytes(repo.w(path));
        if (bytes !== undefined) state.set(path, { oid: repo.objects.write('blob', bytes), mode: repo.worktreeMode(path) });
    }
    const treeOid = repo.buildTree(state);
    const custom = values.get('-m') ?? values.get('--message');
    const message = custom !== undefined
        ? 'On ' + repo.refs.branch() + ': ' + custom
        : 'WIP on ' + repo.refs.branch() + ': ' + abbrev(head) + ' ' + repo.subjectOf(head);
    const info: CommitInfo = { tree: treeOid, parents: [head], author: repo.identity(), committer: repo.identity(), message: message + '\n', extra: [] };
    const oid = repo.objects.write('commit', serializeCommit(info));
    const previous = repo.refs.read('refs/stash') ?? ZERO_OID;
    repo.refs.writeRef('refs/stash', oid);
    repo.refs.appendReflog('refs/stash', previous, oid, repo.who(), message, repo.identity().ts, repo.identity().tz);
    const headCommit = repo.readCommit(head);
    if (headCommit !== undefined) repo.checkoutTree(headCommit.tree);
    for (const path of untracked) repo.remove(repo.w(path));
    return ok('Saved working directory and index state ' + message + '\n');
}

function cmdReflog(ctx: CommandContext, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    /* git reflog show <ref>[@{n}]: honour the ref, its label and the @{n} start
       (host git 2.53.0). A bare reflog show / HEAD keeps the HEAD reflog. */
    const words = rest.filter((entry) => !entry.startsWith('-'));
    const spec = words[0] === 'show' ? words[1] : words[0];
    const at = spec !== undefined ? /^(.*)@\{(\d+)\}$/.exec(spec) : null;
    const base = at !== null ? at[1] : (spec ?? '');
    const from = at !== null ? Number(at[2]) : 0;
    const ambiguous = () => fail("fatal: ambiguous argument '" + spec + "': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'", 128);
    let label = base, logName: string | undefined;
    if (base === '' || base === '@' || base === 'HEAD') { label = 'HEAD'; logName = 'HEAD'; }
    else if (base.startsWith('refs/')) { label = base; logName = base; }
    else logName = ['refs/heads/' + base, 'refs/tags/' + base, 'refs/remotes/' + base, base]
        .find((name) => repo.refs.reflog(name).length > 0);
    if (logName === undefined) return ambiguous();
    const entries = repo.refs.reflog(logName).slice().reverse();
    if (at !== null && from >= entries.length) return fail("fatal: log for '" + label + "' only has " + entries.length + " entries", 128);
    let out = '';
    for (let i = from; i < entries.length; i++) out += abbrev(entries[i].next) + ' ' + label + '@{' + i + '}: ' + entries[i].message + '\n';
    return ok(out);
}

function cmdGrep(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const pattern = rest[0] ?? '';
    const insensitive = flags.has('-i') || flags.has('--ignore-case');
    const numbered = flags.has('-n') || flags.has('--line-number');
    const regex = new RegExp(pattern, insensitive ? 'i' : '');
    let out = ''; let matches = 0;
    for (const entry of repo.indexEntries()) {
        const bytes = repo.readBytes(repo.w(entry.path));
        if (bytes === undefined) continue;
        splitLines(text(bytes)).forEach((line, index) => {
            if (regex.test(line)) { matches++; out += entry.path + (numbered ? ':' + (index + 1) : '') + ':' + line + '\n'; }
        });
    }
    return ok(out, '', matches === 0 ? 1 : 0);
}

function cmdBlame(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    /* Host git 2.53.0: -L <range> consumes the range as its own operand; the path
       follows it. parseFlags leaves both in rest and records -L as a flag. */
    let from = 1, to = Number.MAX_SAFE_INTEGER;
    let path = rest[0] ?? '';
    if (flags.has('-L')) {
        const spec = rest[0] ?? '';
        path = rest[1] ?? '';
        const m = /^(\d+)(?:,(\d+)|,\+(\d+))?$/.exec(spec);
        if (m !== null) {
            from = parseInt(m[1], 10) || 1;
            if (m[2] !== undefined) to = parseInt(m[2], 10);
            else if (m[3] !== undefined) to = from + parseInt(m[3], 10) - 1;
            else to = from;
        }
    }
    const bytes = repo.readBytes(repo.w(path));
    if (bytes === undefined) return fail('fatal: no such path ' + path + ' in HEAD', 128);
    const head = repo.refs.headOid();
    const history = head === undefined ? [] : repo.logEntries(head, 100);
    let out = '';
    splitLines(text(bytes)).forEach((line, index) => {
        if (index + 1 < from || index + 1 > to) return;
        /* Follow the file back through renames: the oldest commit whose tree contains a blob with
           this line is the origin, and host prints the ORIGINAL path after the abbrev oid. */
        let owner = history[0];
        let originPath = path;
        let boundary = false;
        for (let k = history.length - 1; k >= 0; k--) {
            const entry = history[k];
            const commit = repo.readCommit(entry.oid);
            if (commit === undefined) continue;
            let found = false;
            for (const [candidate, state] of repo.flatTree(commit.tree)) {
                const blob = repo.readBlob(state.oid);
                if (blob !== undefined && splitLines(text(blob)).includes(line)) { originPath = candidate; found = true; break; }
            }
            if (found) { owner = entry; boundary = entry.info.parents.length === 0; break; }
        }
        const oid = owner?.oid ?? ZERO_OID;
        const author = owner?.info.author ?? repo.identity();
        const renamed = originPath !== path ? ' ' + originPath : '';
        const shortOid = boundary ? '^' + abbrev(oid, 7) : abbrev(oid, 8);
        out += shortOid + renamed + ' (' + author.name + ' ' +
            isoDate(author.ts, author.tz) + ' ' + (index + 1) + ') ' + line + '\n';
    });
    return ok(out);
}

function cmdArchive(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    let format = values.get('--format');
    let revAt = 0;
    if (format === undefined && flags.has('--format')) { format = rest[0]; revAt = 1; }
    format = format ?? 'tar';
    const rev = rest[revAt] ?? 'HEAD';
    const oid = repo.resolve(rev);
    const commit = oid === undefined ? undefined : repo.readCommit(oid);
    if (commit === undefined) return fail('fatal: Not a valid object name: ' + rev, 128);
    const tree = repo.flatTree(commit.tree);
    const bytes = format === 'zip' ? zipOf(repo, tree, values.get('--prefix') ?? '') : tarOf(repo, tree);
    const output = values.get('-o') ?? values.get('--output');
    if (output !== undefined) { repo.writeBytes(output.startsWith('/') ? output : repo.w(output), bytes); return ok(''); }
    return ok(binaryString(bytes));
}

function cmdCherryPick(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const rev = rest[0] ?? '';
    const oid = repo.resolve(rev);
    const info = oid === undefined ? undefined : repo.readCommit(oid);
    if (info === undefined) return fail('fatal: bad revision ' + rev, 128);
    const parent = info.parents[0];
    const parentInfo = parent === undefined ? undefined : repo.readCommit(parent);
    const changes = parentInfo !== undefined ? repo.changesBetween(repo.flatTree(parentInfo.tree), repo.flatTree(info.tree))
        : repo.changesBetween(new Map(), repo.flatTree(info.tree));
    for (const change of changes) {
        if (change.newOid !== undefined) { const blob = repo.readBlob(change.newOid); if (blob !== undefined) repo.writeBytes(repo.w(change.path), blob); }
        else repo.remove(repo.w(change.path));
    }
    let entries = repo.indexEntries();
    for (const change of changes) {
        entries = entries.filter((entry) => entry.path !== change.path);
        if (change.newOid !== undefined && repo.exists(repo.w(change.path))) entries.push(repo.entryFor(change.path));
    }
    repo.writeIndexEntries(entries);
    const made = makeCommit(repo, info.message);
    return ok('[' + repo.refs.branch() + ' ' + abbrev(made.oid) + '] ' + info.message.trim().split('\n')[0] +
        '\n Date: ' + mediumDate(info.author.ts, info.author.tz) + '\n' + commitLines(repo, made.changes));
}

function cmdRebase(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const onto = repo.resolve(rest[0] ?? 'HEAD');
    const head = repo.refs.headOid();
    if (onto === undefined || head === undefined) return fail('fatal: invalid upstream', 128);
    const branch = repo.refs.branch();
    if (onto === head || repo.commonAncestor(onto, head) === onto) return ok('Current branch ' + branch + ' is up to date.\n');
    /* Replay every commit from the merge-base exclusive up to HEAD onto the upstream tree. */
    const base = repo.commonAncestor(head, onto);
    const chain: { oid: string; info: CommitInfo }[] = [];
    let cur: string | undefined = head;
    while (cur !== undefined && cur !== base) {
        const info: CommitInfo | undefined = repo.readCommit(cur);
        if (info === undefined) break;
        chain.push({ oid: cur, info });
        cur = info.parents[0];
    }
    chain.reverse();
    const ontoCommit = repo.readCommit(onto);
    if (ontoCommit === undefined) return fail('fatal: invalid upstream', 128);
    let treeMap = new Map<string, FileState>(repo.flatTree(ontoCommit.tree));
    let parent = onto;
    const progress: string[] = [];
    for (let i = 0; i < chain.length; i++) {
        progress.push('Rebasing (' + (i + 1) + '/' + chain.length + ')\r');
        const info = chain[i].info;
        const parentTree = info.parents.length > 0 ? (repo.readCommit(info.parents[0])?.tree ?? '') : '';
        const before = parentTree === '' ? new Map<string, FileState>() : repo.flatTree(parentTree);
        for (const change of repo.changesBetween(before, repo.flatTree(info.tree))) {
            if (change.newOid === undefined) treeMap.delete(change.path);
            else treeMap.set(change.path, { oid: change.newOid, mode: change.mode });
        }
        const treeOid = repo.buildTree(treeMap);
        const made: CommitInfo = { tree: treeOid, parents: [parent], author: info.author,
            committer: repo.identity(), message: info.message, extra: [] };
        parent = repo.objects.write('commit', serializeCommit(made));
    }
    repo.refs.writeRef('refs/heads/' + branch, parent);
    repo.refs.appendReflog('HEAD', head, parent, repo.who(), 'rebase: onto ' + (rest[0] ?? 'HEAD'), repo.identity().ts, repo.identity().tz);
    repo.checkoutTree(parent);
    return ok('', progress.join('') + 'Successfully rebased and updated refs/heads/' + branch + '.\n');
}

function cmdRemote(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const names = rest.filter((r) => !r.startsWith('-'));
    const lines = (): ConfigLine[] => repo.config.readScope('local');
    const save = (ls: ConfigLine[]): void => { ctx.fs.writeFile(repo.gitDir + '/config', formatConfig(ls)); };
    const remotesOf = (ls: ConfigLine[]): string[] => [...new Set(ls
        .filter((l) => l.section === 'remote' && l.subsection !== undefined)
        .map((l) => l.subsection as string))].sort();
    const urlOf = (name: string): string | undefined => repo.config.get('remote.' + name + '.url');
    const verbose = flags.has('-v') || flags.has('--verbose');
    if (verbose || names.length === 0) {
        if (!verbose) return ok(remotesOf(lines()).map((n) => n + '\n').join(''));
        let out = '';
        for (const n of remotesOf(lines())) {
            const url = urlOf(n) ?? '';
            out += n + '\t' + url + ' (fetch)\n' + n + '\t' + url + ' (push)\n';
        }
        return ok(out);
    }
    const sub = names[0];
    if (sub === 'add' && names.length >= 3) {
        const ls = lines();
        ls.push({ section: 'remote', subsection: names[1], key: 'url', value: names[2] });
        ls.push({ section: 'remote', subsection: names[1], key: 'fetch', value: '+refs/heads/*:refs/remotes/' + names[1] + '/*' });
        save(ls); return ok('');
    }
    if (sub === 'get-url' && names.length >= 2) {
        const url = urlOf(names[1]);
        if (url === undefined) return fail("fatal: No such remote '" + names[1] + "'", 128);
        return ok(url + '\n');
    }
    if (sub === 'set-url' && names.length >= 3) {
        const ls = lines(); let hit = false;
        for (const l of ls) if (l.section === 'remote' && l.subsection === names[1] && l.key === 'url') { l.value = names[2]; hit = true; }
        if (!hit) return fail("fatal: No such remote '" + names[1] + "'", 128);
        save(ls); return ok('');
    }
    if ((sub === 'remove' || sub === 'rm') && names.length >= 2) {
        save(lines().filter((l) => !(l.section === 'remote' && l.subsection === names[1]))); return ok('');
    }
    if (sub === 'rename' && names.length >= 3) {
        const ls = lines();
        for (const l of ls) if (l.section === 'remote' && l.subsection === names[1]) l.subsection = names[2];
        save(ls); return ok('');
    }
    return ok('');
}

/* A local-path clone copies HEAD, refs and loose objects inside the VFS; it needs no transport. */
function cmdClone(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const source = rest[0];
    if (source === undefined) return fail('fatal: You must specify a repository to clone.', 128);
    const target = rest[1] ?? (source.replace(/\/$/, '').split('/').pop() as string);
    const baseDir = ctx.cwd || '/app';
    const sourceGit = normalizePath(source.startsWith('/') ? source + '/.git' : baseDir + '/' + source + '/.git');
    if (!ctx.fs.fileExists(sourceGit)) return fail('fatal: repository ' + source + ' does not exist', 128);
    const dest = normalizePath(target.startsWith('/') ? target : baseDir + '/' + target);
    const bare = flags.has('--bare');
    const destGit = bare ? dest : dest + '/.git';
    const copyDir = (from: string, to: string): void => {
        if (!ctx.fs.fileExists(to)) ctx.fs.createDirectory(to);
        for (const name of ctx.fs.readdirNames(from) ?? []) {
            const child = from + '/' + name, into = to + '/' + name;
            if (ctx.fs.isDirectory(child)) copyDir(child, into);
            else { const bytes = ctx.fs.readBytes(child); if (bytes !== undefined) { ctx.fs.createDirectory(to); ctx.fs.writeBytes(into, bytes); } }
        }
    };
    copyDir(sourceGit, destGit);
    const clonedCtx: CommandContext = { ...ctx, cwd: dest };
    const repo = new GitRepo(clonedCtx, dest, destGit);
    if (bare) {
        repo.config.set('local', 'core.bare', 'true', true);
        return ok('', "Cloning into bare repository '" + target + "'...\ndone.\n");
    }
    const oid = repo.refs.headOid();
    const commit = oid === undefined ? undefined : repo.readCommit(oid);
    if (commit !== undefined) repo.checkoutTree(commit.tree, false);
    return ok('', "Cloning into '" + target + "'...\ndone.\n");
}

/* ------------------------------------------------------------------ *
 * bisect: .git/BISECT_* state over the VFS
 * ------------------------------------------------------------------ */
const BISECT_USAGE = [
    'usage: git bisect start [--term-(bad|new)=<term-new> --term-(good|old)=<term-old>]',
    '                        [--no-checkout] [--first-parent] [<bad> [<good>...]] [--] [<pathspec>...]',
    '   or: git bisect (bad|new|<term-new>) [<rev>]',
    '   or: git bisect (good|old|<term-old>) [<rev>...]',
    '   or: git bisect terms [--term-(good|old) | --term-(bad|new)]',
    '   or: git bisect skip [(<rev>|<range>)...]',
    '   or: git bisect next',
    '   or: git bisect reset [<commit>]',
    '   or: git bisect (visualize|view)',
    '   or: git bisect replay <logfile>',
    '   or: git bisect log',
    '   or: git bisect run <cmd> [<arg>...]',
    '   or: git bisect help',
    '', ''
].join('\n');

function bisectState(repo: GitRepo) {
    return {
        log: repo.readText(repo.g('BISECT_LOG')) ?? '',
        bad: repo.readText(repo.g('BISECT_BAD'))?.trim(),
        good: repo.readText(repo.g('BISECT_GOOD'))?.trim(),
        status: repo.readText(repo.g('BISECT_STATUS'))?.trim() ?? 'waiting for both good and bad commits'
    };
}
function bisectClear(repo: GitRepo): void {
    for (const n of ['BISECT_START', 'BISECT_LOG', 'BISECT_BAD', 'BISECT_GOOD', 'BISECT_STATUS', 'BISECT_EXPECTED_REV', 'BISECT_HEAD_MOVED'])
        repo.remove(repo.g(n));
}
function bisectChain(repo: GitRepo, from: string, to: string): string[] {
    const out: string[] = [];
    let cur: string | undefined = from;
    const seen = new Set<string>();
    while (cur !== undefined && cur !== to && !seen.has(cur)) {
        seen.add(cur);
        const info = repo.readCommit(cur);
        if (info === undefined) break;
        out.push(cur);
        cur = info.parents[0];
    }
    return out;
}
function cmdBisect(ctx: CommandContext, raw: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const rest = raw.filter((a) => !a.startsWith('-'));
    const action = rest[0];
    if (action === undefined) return fail('fatal: need a command\n\n' + BISECT_USAGE, 129);
    if (action === 'start') {
        bisectClear(repo);
        repo.writeText(repo.g('BISECT_START'), repo.refs.headOid() ?? '');
        repo.writeText(repo.g('BISECT_LOG'), 'git bisect start\n');
        repo.writeText(repo.g('BISECT_STATUS'), 'waiting for both good and bad commits');
        return ok('status: waiting for both good and bad commits\n');
    }
    if (action === 'reset') {
        /* Host prints "Already on '<branch>'" when bisect never moved HEAD; only a checked-out
           midpoint produces the "Previous HEAD position was ..." pair. */
        const moved = repo.exists(repo.g('BISECT_HEAD_MOVED'));
        const head = repo.refs.headOid();
        bisectClear(repo);
        if (!moved) return ok('', "Already on '" + repo.refs.branch() + "'\n");
        return ok('', 'Previous HEAD position was ' + abbrev(head ?? ZERO_OID) + ' ' +
            repo.subjectOf(head ?? '') + "\nSwitched to branch '" + repo.refs.branch() + "'\n");
    }
    if (action === 'log') return ok(bisectState(repo).log);
    if (action === 'bad' || action === 'good') {
        const state = bisectState(repo);
        const rev = rest[1] ?? 'HEAD';
        const oid = repo.resolve(rev);
        if (oid === undefined) return fail('fatal: bad revision ' + rev, 128);
        const subject = repo.subjectOf(oid);
        let log = state.log + '# status: ' + state.status + '\n# ' + action + ': [' + oid + '] ' + subject + '\n' +
            'git bisect ' + action + ' ' + oid + '\n';
        let status = state.status;
        if (action === 'bad') {
            repo.writeText(repo.g('BISECT_BAD'), oid);
            status = repo.exists(repo.g('BISECT_GOOD')) ? 'waiting for bad commit, good commit known' : 'waiting for good commit(s), bad commit known';
        } else {
            if (state.bad === oid) { repo.writeText(repo.g('BISECT_LOG'), log); return ok(oid + ' was both good and bad\n', '', 1); }
            repo.writeText(repo.g('BISECT_GOOD'), oid);
            const bad = state.bad ?? repo.refs.headOid();
            if (bad !== undefined && oid !== bad) {
                const chain = bisectChain(repo, bad, oid);
                if (chain.length > 1) {
                    const mid = chain[Math.floor((chain.length - 1) / 2)];
                    const midInfo = repo.readCommit(mid);
                    repo.refs.setDetached(mid);
                    repo.checkoutTree(mid);
                    repo.writeText(repo.g('BISECT_HEAD_MOVED'), mid);
                    status = 'Bisecting: ' + (chain.length - 2) + ' revisions left to test after this (roughly ' +
                        Math.round(Math.log2(Math.max(1, chain.length - 1))) + ' steps)';
                    repo.writeText(repo.g('BISECT_LOG'), log);
                    repo.writeText(repo.g('BISECT_STATUS'), status);
                    return ok('Bisecting: ' + (chain.length - 2) + ' revisions left to test after this (roughly ' +
                        Math.round(Math.log2(Math.max(1, chain.length - 1))) + ' steps)\n[' + mid + '] ' +
                        (midInfo === undefined ? '' : midInfo.message.trim().split('\n')[0]) + '\n');
                }
            }
            status = 'waiting for both good and bad commits';
        }
        repo.writeText(repo.g('BISECT_LOG'), log);
        repo.writeText(repo.g('BISECT_STATUS'), status);
        return ok('status: ' + status + '\n');
    }
    return fail("fatal: unknown command: '" + action + "'\n\n" + BISECT_USAGE, 129);
}

/* ------------------------------------------------------------------ *
 * fsck: loose-object sha1 walk + connectivity from refs and reflogs
 * ------------------------------------------------------------------ */
function cmdFsck(ctx: CommandContext, raw: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const all: { oid: string; type: string }[] = [];
    const errors: string[] = [];
    for (const dir of repo.names(repo.g('objects'))) {
        if (!/^[0-9a-f]{2}$/.test(dir)) continue;
        for (const name of repo.names(repo.g('objects/' + dir))) {
            const oid = dir + name;
            if (!/^[0-9a-f]{40}$/.test(oid)) continue;
            const rel = '.git/objects/' + dir + '/' + name;
            const packed = repo.readBytes(repo.g('objects/' + dir + '/' + name));
            if (packed === undefined) { errors.push('error: ' + oid + ': object corrupt or missing: ' + rel + '\n'); continue; }
            let full: Uint8Array;
            try { full = zinflate(packed); } catch {
                errors.push('error: inflate: data stream error (incorrect header check)\n' +
                    'error: unable to unpack header of ' + rel + '\n' +
                    'error: ' + oid + ': object corrupt or missing: ' + rel + '\n');
                continue;
            }
            if (sha1Hex(full) !== oid) errors.push('error: ' + oid + ': object corrupt or missing: ' + rel + '\n');
            const nul = full.indexOf(0);
            const type = nul < 0 ? '' : text(full.subarray(0, nul)).split(' ')[0];
            all.push({ oid, type });
        }
    }
    const reachable = new Set<string>();
    const queue: string[] = [];
    const head = repo.refs.headOid();
    if (head !== undefined) queue.push(head);
    for (const b of repo.refs.branches()) { const o = repo.refs.read('refs/heads/' + b); if (o !== undefined) queue.push(o); }
    for (const t of repo.refs.tags()) { const o = repo.refs.read('refs/tags/' + t); if (o !== undefined) queue.push(o); }
    for (const e of repo.refs.reflog('HEAD')) queue.push(e.old, e.next);
    for (const e of repo.refs.reflog('refs/stash')) queue.push(e.old, e.next);
    while (queue.length > 0) {
        const oid = queue.shift() as string;
        if (!/^[0-9a-f]{40}$/.test(oid) || reachable.has(oid)) continue;
        reachable.add(oid);
        const obj = repo.object(oid);
        if (obj === undefined) continue;
        if (obj.type === 'commit') { const info = parseCommit(obj.content); queue.push(info.tree, ...info.parents); }
        else if (obj.type === 'tree') { for (const e of parseTree(obj.content)) queue.push(e.oid); }
        else if (obj.type === 'tag') { queue.push(parseTag(obj.content).object); }
    }
    let out = '';
    for (const obj of all) if (!reachable.has(obj.oid)) out += 'dangling ' + obj.type + ' ' + obj.oid + '\n';
    return ok(out, errors.join(''), errors.length > 0 ? 1 : 0);
}

/* ------------------------------------------------------------------ *
 * local-path transport: fetch / push / pull / ls-remote over the VFS
 * ------------------------------------------------------------------ */
function localRepo(ctx: CommandContext, source: string): GitRepo | undefined {
    if (/^https?:\/\//.test(source) || /^ssh:\/\//.test(source) || /^git:\/\//.test(source) ||
        /^file:\/\//.test(source) || /^[^/:@\s]+@[^/:\s]+:/.test(source)) return undefined;
    const base = ctx.cwd || '/app';
    const abs = normalizePath(source.startsWith('/') ? source : base + '/' + source);
    for (const gd of [abs + '/.git', abs]) {
        if (ctx.fs.fileExists(gd + '/objects')) return new GitRepo({ ...ctx, cwd: abs }, abs, gd);
    }
    return undefined;
}
function remoteTarget(repo: GitRepo, target: string): string {
    return repo.config.get('remote.' + target + '.url') ?? target;
}
function copyObjects(from: GitRepo, to: GitRepo): void {
    for (const dir of from.names(from.g('objects'))) {
        if (!/^[0-9a-f]{2}$/.test(dir)) continue;
        for (const name of from.names(from.g('objects/' + dir))) {
            const bytes = from.readBytes(from.g('objects/' + dir + '/' + name));
            if (bytes === undefined) continue;
            const dst = to.g('objects/' + dir + '/' + name);
            if (!to.exists(dst)) { to.mkdirp(dst.slice(0, dst.lastIndexOf('/'))); to.writeBytes(dst, bytes); }
        }
    }
}
function displayUrl(url: string): string { return url.replace(/\.git$/, ''); }
function cmdPush(ctx: CommandContext, raw: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const rest = raw.filter((a) => !a.startsWith('-'));
    const target = rest[0] ?? 'origin';
    const url = remoteTarget(repo, target);
    const src = localRepo(ctx, url);
    if (src === undefined) return fail("fatal: '" + target + "' does not appear to be a git repository", 128);
    const head = repo.refs.headOid();
    if (head === undefined) return fail('fatal: no commits yet', 128);
    const branch = rest[1] ?? repo.refs.branch();
    copyObjects(repo, src);
    src.refs.writeRef('refs/heads/' + branch, head);
    if (!src.exists(src.g('HEAD'))) src.refs.setHead('refs/heads/' + branch);
    return ok('', 'To ' + url + '\n * [new branch]      ' + branch + ' -> ' + branch + '\n');
}
function cmdFetch(ctx: CommandContext, raw: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const rest = raw.filter((a) => !a.startsWith('-'));
    const target = rest[0] ?? 'origin';
    const url = remoteTarget(repo, target);
    const src = localRepo(ctx, url);
    if (src === undefined) return fail("fatal: '" + target + "' does not appear to be a git repository", 128);
    copyObjects(src, repo);
    const oid = src.refs.headOid() ?? '';
    repo.writeText(repo.g('FETCH_HEAD'), oid + '\n');
    return ok('', 'From ' + displayUrl(url) + '\n * branch            HEAD       -> FETCH_HEAD\n');
}
function cmdPull(ctx: CommandContext, raw: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const rest = raw.filter((a) => !a.startsWith('-'));
    const target = rest[0] ?? 'origin';
    const url = remoteTarget(repo, target);
    const src = localRepo(ctx, url);
    if (src === undefined) return fail("fatal: '" + target + "' does not appear to be a git repository", 128);
    const branch = rest[1] ?? repo.refs.branch();
    copyObjects(src, repo);
    const oid = src.refs.headOid();
    const head = repo.refs.headOid();
    if (oid !== undefined && oid !== head) {
        const commit = repo.readCommit(oid);
        if (commit !== undefined) {
            if (repo.refs.head().ref !== undefined) repo.refs.writeRef(repo.refs.head().ref as string, oid);
            else repo.refs.setDetached(oid);
            repo.checkoutTree(oid);
        }
    }
    repo.writeText(repo.g('FETCH_HEAD'), (oid ?? '') + '\n');
    return ok('Already up to date.\n', 'From ' + displayUrl(url) + '\n * branch            ' + branch + '       -> FETCH_HEAD\n');
}
function cmdLsRemote(ctx: CommandContext, raw: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const rest = raw.filter((a) => !a.startsWith('-'));
    const target = rest[0] ?? 'origin';
    const url = remoteTarget(repo, target);
    const src = localRepo(ctx, url);
    if (src === undefined) return fail("fatal: '" + target + "' does not appear to be a git repository", 128);
    const headsOnly = raw.includes('--heads');
    const tagsOnly = raw.includes('--tags');
    const filtered = headsOnly || tagsOnly;
    let out = '';
    const head = src.refs.headOid();
    if (!filtered && head !== undefined) out += head + '\tHEAD\n';
    if (!tagsOnly) for (const b of src.refs.branches()) { const o = src.refs.read('refs/heads/' + b); if (o !== undefined) out += o + '\trefs/heads/' + b + '\n'; }
    if (!headsOnly) for (const t of src.refs.tags()) { const o = src.refs.read('refs/tags/' + t); if (o !== undefined) out += o + '\trefs/tags/' + t + '\n'; }
    return ok(out);
}

/* git backfill on a repo with no promisor remote has nothing to fetch and succeeds silently;
   a promisor remote needs a packfile transport the VFS does not have. */
function cmdBackfill(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const partial = repo.config.get('extensions.partialclone');
    const promisor = repo.config.readScope('local').some((line) => line.section === 'remote' && line.key === 'promisor');
    if (partial !== undefined || promisor) return unsupportedResult('git-packfiles');
    return ok('');
}
