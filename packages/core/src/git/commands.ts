import type { CommandContext, CommandResult } from '../shell/commands/types';
import { utf8, text, concat, abbrev, binaryString, fromBinaryString, isHexOid } from './bytes';
import {
    GitRepo, GitError, fatal, normalizePath, type Change, type FileState, type StatusRow
} from './repo';
import { readIndex, writeIndex, type IndexEntry, ZERO_OID, type ConfigScope } from './store';
import { parseTree, serializeTree, parseCommit, serializeCommit, oidOf, type CommitInfo } from './objects';
import { renderDiff, renderStat, countsFor, tarOf, splitLines } from './diff';

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
}

export function statusOf(repo: GitRepo): StatusView {
    const head = repo.headTree();
    const index = repo.indexTree();
    const headOid = repo.refs.headOid();
    const noCommits = headOid === undefined;
    const worktree = new Map<string, FileState>();
    for (const [path, state] of index) {
        const bytes = repo.readBytes(repo.w(path));
        if (bytes !== undefined) worktree.set(path, { oid: repo.hashBlob(bytes), mode: state.mode });
    }
    const staged = repo.changesBetween(head, index);
    const unstaged = repo.changesBetween(index, worktree);
    const untracked = repo.worktreeFiles().filter((path) => !index.has(path) && !repo.ignored(path));
    const paths = new Set<string>([...index.keys(), ...head.keys()]);
    const rows: StatusRow[] = [];
    for (const path of [...paths].sort()) {
        const inHead = head.get(path), inIndex = index.get(path), inWork = worktree.get(path);
        let x = ' ';
        if (inHead === undefined && inIndex !== undefined) x = 'A';
        else if (inHead !== undefined && inIndex === undefined) x = 'D';
        else if (inHead !== undefined && inIndex !== undefined && inHead.oid !== inIndex.oid) x = 'M';
        let y = ' ';
        if (inIndex !== undefined) {
            if (inWork === undefined) y = 'D';
            else if (inWork.oid !== inIndex.oid) y = 'M';
        }
        if (x !== ' ' || y !== ' ') rows.push({ x, y, path, staged: x !== ' ', unstaged: y !== ' ' });
    }
    for (const path of untracked) rows.push({ x: '?', y: '?', path, staged: false, unstaged: false });
    return { rows, untracked, staged, unstaged, branch: repo.refs.branch(), detached: repo.refs.head().ref === undefined,
        noCommits, headOid };
}

function label(change: Change): string {
    return change.status === 'A' ? 'new file:   ' : change.status === 'D' ? 'deleted:   ' : 'modified:   ';
}

export function shortStatus(view: StatusView): string {
    return view.rows.map((row) => (row.x === '?' ? '?? ' : row.x + row.y + ' ') + row.path + '\n').join('');
}

export function longStatus(view: StatusView): string {
    let out = view.detached ? 'HEAD detached at ' + abbrev(view.headOid ?? ZERO_OID) + '\n' : 'On branch ' + view.branch + '\n';
    if (view.noCommits) out += '\nNo commits yet\n';
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
    return out + 'nothing to commit, working tree clean\n';
}

/* ------------------------------------------------------------------ *
 * commit / refs / history helpers
 * ------------------------------------------------------------------ */

function commitLines(repo: GitRepo, changes: Change[]): string {
    const counts = changes.map((change) => countsFor(repo, change));
    let added = 0, removed = 0;
    for (const entry of counts) { added += entry.added; removed += entry.removed; }
    let summary = ' ' + changes.length + ' file' + (changes.length === 1 ? '' : 's') + ' changed';
    if (added > 0) summary += ', ' + added + ' insertion' + (added === 1 ? '' : 's') + '(+)';
    if (removed > 0) summary += ', ' + removed + ' deletion' + (removed === 1 ? '' : 's') + '(-)';
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
    out += commitLines(repo, changes);
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

function parseFlags(args: string[]): { flags: Set<string>; values: Map<string, string>; rest: string[] } {
    const flags = new Set<string>();
    const values = new Map<string, string>();
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
            if ((arg === '-m' || arg === '-b' || arg === '-o' || arg === '-t' || arg === '-n' || arg === '-S' || arg === '-F' || arg === '-c' || arg === '-C' || arg === '-u') && i + 1 < args.length) {
                values.set(arg, args[++i]);
            } else {
                for (const ch of arg.slice(1)) flags.add('-' + ch);
            }
        } else rest.push(arg);
    }
    return { flags, values, rest };
}

export function runCommand(ctx: CommandContext, sub: string, args: string[]): CommandResult {
    const { flags, values, rest } = parseFlags(args);
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
        case 'commit-tree': return cmdCommitTree(ctx, flags, values, rest);
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
        default: return fail("git: '" + sub + "' is not a git command. See 'git --help'.", 1);
    }
}

export const GIT_HELP = "usage: git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]\n           [--exec-path[=<path>]] [--html-path] [--man-path] [--info-path]\n           [-p | --paginate | -P | --no-pager] [--no-replace-objects] [--no-lazy-fetch]\n           [--no-optional-locks] [--no-advice] [--bare] [--git-dir=<path>]\n           [--work-tree=<path>] [--namespace=<name>] [--config-env=<name>=<envvar>]\n           <command> [<args>]\n\nThese are common Git commands used in various situations:\n\nstart a working area (see also: git help tutorial)\n   clone      Clone a repository into a new directory\n   init       Create an empty Git repository or reinitialize an existing one\n\nwork on the current change (see also: git help everyday)\n   add        Add file contents to the index\n   mv         Move or rename a file, a directory, or a symlink\n   restore    Restore working tree files\n   rm         Remove files from the working tree and from the index\n\nexamine the history and state (see also: git help revisions)\n   bisect     Use binary search to find the commit that introduced a bug\n   diff       Show changes between commits, commit and working tree, etc\n   grep       Print lines matching a pattern\n   log        Show commit logs\n   show       Show various types of objects\n   status     Show the working tree status\n\ngrow, mark and tweak your common history\n   backfill   Download missing objects in a partial clone\n   branch     List, create, or delete branches\n   commit     Record changes to the repository\n   merge      Join two or more development histories together\n   rebase     Reapply commits on top of another base tip\n   reset      Set `HEAD` or the index to a known state\n   switch     Switch branches\n   tag        Create, list, delete or verify tags\n\ncollaborate (see also: git help workflows)\n   fetch      Download objects and refs from another repository\n   pull       Fetch from and integrate with another repository or a local branch\n   push       Update remote refs along with associated objects\n\n'git help -a' and 'git help -g' list available subcommands and some\nconcept guides. See 'git help <command>' or 'git help <concept>'\nto read about a specific subcommand or concept.\nSee 'git help git' for an overview of the system.\n";

/* ---- init ---- */
function cmdInit(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    const branch = values.get('-b') ?? values.get('--initial-branch') ?? undefined;
    const target = rest[0] ?? (ctx.cwd || '/app');
    const created = GitRepo.init(ctx, target, branch);
    const absolute = normalizePath(target.startsWith('/') ? target : (ctx.cwd || '/app') + '/' + target);
    return ok('Initialized empty Git repository in ' + absolute + '/.git/\n', created.hint);
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
    const wantsList = flags.has('--list') || flags.has('-l');
    const wantsUnset = flags.has('--unset') || flags.has('--unset-all');
    const wantsGetAll = flags.has('--get-all');
    const key = rest[0];
    if (wantsList) {
        const scoped = flags.has('--global') || flags.has('--system') || flags.has('--local') || flags.has('--worktree') || file !== undefined;
        if (scoped) {
            return ok(repo.config.readScope(scope).map((line) => line.section + (line.subsection === undefined ? '' : '.' + line.subsection) + '.' + line.key + '=' + line.value + '\n').join(''));
        }
        return ok(repo.config.list());
    }
    if (key === undefined || key === '') return fail('usage: git config [<options>]', 129);
    if (!key.includes('.')) return fail('error: key does not contain a section: ' + key, 2);
    if (key.includes(' ')) return fail('error: invalid key: ' + key, 1);
    if (wantsUnset) {
        const code = repo.config.unset(scope, key);
        if (code === 5) return fail('', 5);
        return ok('');
    }
    if (wantsGetAll) return ok(repo.config.getAll(key).map((v) => v + '\n').join(''));
    if (rest.length === 1 || flags.has('--get')) {
        const value = repo.config.get(key);
        if (value === undefined) return fail('', 1);
        return ok(value + '\n');
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
    repo.config.set(scope, key, rest.slice(1).join(' '));
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
    const mode = raw.includes('-t') ? 't' : raw.includes('-s') ? 's' : raw.includes('-e') ? 'e' : 'p';
    const rev = raw.filter((entry) => !entry.startsWith('-'))[0] ?? '';
    const oid = repo.resolve(rev);
    if (oid === undefined) return fail('fatal: Not a valid object name ' + rev, 128);
    const obj = repo.object(oid);
    if (obj === undefined) return fail('fatal: Not a valid object name ' + rev, 128);
    if (mode === 'e') return obj === undefined ? fail('', 1) : ok('');
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
    for (const target of targets) {
        const oid = repo.resolve(target);
        if (oid === undefined) {
            if (verify) return fail('fatal: Needed a single revision', 128);
            out += target + '\n';
        } else out += oid + '\n';
    }
    return ok(out);
}

function cmdLsFiles(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    let repo: GitRepo;
    try { repo = GitRepo.discover(ctx); } catch (error) { return fatalResult(error); }
    const entries = repo.indexEntries();
    if (flags.has('--stage')) {
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

function cmdCommitTree(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    let repo: GitRepo;
    try { repo = GitRepo.discover(ctx); } catch (error) { return fatalResult(error); }
    const tree = rest[0] ?? '';
    const parents = [...flags].filter((f) => f === '-p').map(() => values.get('-p') ?? '').filter((p) => p !== '');
    const message = values.get('-m') ?? values.get('-F') ?? ctx.input ?? '';
    const info: CommitInfo = { tree, parents, author: repo.identity(), committer: repo.identity(),
        message: message.endsWith('\n') ? message : message + '\n', extra: [] };
    return ok(repo.objects.write('commit', serializeCommit(info)) + '\n');
}

function cmdUpdateIndex(ctx: CommandContext, flags: Set<string>, values: Map<string, string>, rest: string[]): CommandResult {
    let repo: GitRepo;
    try { repo = GitRepo.discover(ctx); } catch (error) { return fatalResult(error); }
    let entries = repo.indexEntries();
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
            out.set(entry.path, { oid, mode: entry.mode });
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
    return ok(short ? shortStatus(view) : longStatus(view));
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
    const view = statusOf(repo);
    const dry = flags.has('-n') || flags.has('--dry-run');
    let out = '';
    for (const path of view.untracked) {
        if (dry) out += 'Would remove ' + path + '\n';
        else { repo.remove(repo.w(path)); out += 'Removing ' + path + '\n'; }
    }
    return ok(out);
}

function cmdCommit(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const amend = flags.has('--amend');
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
    if (view.staged.length === 0 && !amend) return fail(longStatus(view), 1);
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
    const start = repo.refs.headOid();
    if (start === undefined) return fail("fatal: your current branch '" + repo.refs.branch() + "' does not have any commits yet", 128);
    const max = parseInt(values.get('-n') ?? values.get('--max-count') ?? '100', 10) || 100;
    const entries = repo.logEntries(start, max);
    if (flags.has('--oneline')) return ok(entries.map((entry) => abbrev(entry.oid) + ' ' + entry.info.message.trim().split('\n')[0] + '\n').join(''));
    return ok(entries.map((entry, index) => (index === 0 ? '' : '\n') + mediumLog(repo, entry.oid, entry.info)).join(''));
}

function cmdShow(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const rev = rest[0] ?? 'HEAD';
    const oid = repo.resolve(rev);
    if (oid === undefined) return fail('fatal: bad revision ' + rev, 128);
    const info = repo.readCommit(oid);
    if (info === undefined) return fail('fatal: bad object ' + rev, 128);
    const parentTree = info.parents.length > 0 ? (repo.readCommit(info.parents[0])?.tree ?? '') : '';
    const changes = parentTree === '' ? repo.changesBetween(new Map(), repo.flatTree(info.tree))
        : repo.changesBetween(repo.flatTree(parentTree), repo.flatTree(info.tree));
    return ok(mediumLog(repo, oid, info) + '\n' + renderDiff(repo, changes));
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
        const stat = renderStat(repo, changes);
        return ok(stat, '', flags.has('--exit-code') && changes.length > 0 ? 1 : 0);
    }
    const diff = renderDiff(repo, changes);
    return ok(diff, '', flags.has('--exit-code') && diff !== '' ? 1 : 0);
}

function cmdBranch(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const names = rest.filter((r) => !r.startsWith('-'));
    if (flags.has('-d') || flags.has('-D') || flags.has('--delete')) {
        let out = '';
        for (const name of names) {
            const oid = repo.refs.read('refs/heads/' + name);
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
    repo.refs.setHead('refs/heads/' + name);
    repo.checkoutTree(target);
    repo.refs.appendReflog('HEAD', target, target, repo.who(), 'checkout: moving from ' + from + ' to ' + name, repo.identity().ts, repo.identity().tz);
    return ok('', "Switched to branch '" + name + "'\n");
}

function cmdCheckout(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const create = flags.has('-b') || flags.has('-B') || flags.has('--branch') || values.has('-b') || values.has('-B') || values.has('--branch');
    const name = create ? (values.get('-b') ?? values.get('-B') ?? values.get('--branch')) : rest[0];
    if (create && name !== undefined) return switchBranch(repo, name, true);
    if (flags.has('--')) {
        for (const path of rest.filter((r) => r !== '--')) {
            const state = repo.indexTree().get(path);
            if (state !== undefined) { const blob = repo.readBlob(state.oid); if (blob !== undefined) repo.writeBytes(repo.w(path), blob); }
        }
        return ok('');
    }
    if (name === undefined) return fail('fatal: you are on a branch yet to be born', 128);
    if (repo.refs.branches().includes(name)) return switchBranch(repo, name, false);
    const oid = repo.resolve(name);
    if (oid === undefined) return fail("error: pathspec '" + name + "' did not match any file(s) known to git", 1);
    repo.refs.setDetached(oid);
    repo.checkoutTree(oid);
    return ok('', 'HEAD is now at ' + abbrev(oid) + ' ' + repo.subjectOf(oid) + '\n');
}

function cmdSwitch(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const create = flags.has('-c') || flags.has('-C') || flags.has('--create') || values.has('-c') || values.has('-C') || values.has('--create');
    const name = create ? (values.get('-c') ?? values.get('-C') ?? values.get('--create')) : rest[0];
    if (name === undefined) return fail('fatal: missing branch or commit argument', 128);
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
    const name = rest[0] ?? '';
    const other = repo.resolve(name);
    const head = repo.refs.headOid();
    if (other === undefined || head === undefined) return fail('fatal: ' + name + ' - not something we can merge', 128);
    const headCommit = repo.readCommit(head), otherCommit = repo.readCommit(other);
    if (headCommit === undefined || otherCommit === undefined) return fail('fatal: bad object', 128);
    const base = repo.commonAncestor(head, other);
    if (base === head) {
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
    if (conflicts.length > 0) return fail('Auto-merging ' + conflicts.join(', ') + '\nCONFLICT (content): Merge conflict in ' + conflicts[0] + '\nAutomatic merge failed; fix conflicts and then commit the result.', 1);
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

function cmdTag(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const names = rest.filter((r) => !r.startsWith('-'));
    if (flags.has('-d') || flags.has('--delete')) { for (const name of names) repo.refs.removeRef('refs/tags/' + name); return ok(''); }
    if (names.length === 0 || flags.has('-l') || flags.has('--list')) return ok(repo.refs.tags().map((name) => name + '\n').join(''));
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

function cmdStash(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const action = rest[0] ?? 'push';
    if (action === 'list') {
        return ok(repo.refs.reflog('refs/stash').map((entry, index) => 'stash@{' + index + '}: ' + entry.message + '\n').join(''));
    }
    if (action === 'pop' || action === 'apply') {
        const oid = repo.refs.read('refs/stash');
        if (oid === undefined) return fail('No stash entries found.', 1);
        const stash = repo.readCommit(oid);
        if (stash === undefined) return fail('No stash entries found.', 1);
        const parent = stash.parents[0];
        const parentCommit = repo.readCommit(parent);
        const changes = parentCommit !== undefined ? repo.changesBetween(repo.flatTree(parentCommit.tree), repo.flatTree(stash.tree))
            : repo.changesBetween(new Map(), repo.flatTree(stash.tree));
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
        if (action === 'pop') repo.refs.removeRef('refs/stash');
        return ok(longStatus(statusOf(repo)) + 'Dropped refs/stash@{0} (' + abbrev(oid) + ')\n');
    }
    const view = statusOf(repo);
    if (view.unstaged.length === 0 && view.staged.length === 0) return ok('No local changes to save\n');
    const head = repo.refs.headOid();
    if (head === undefined) return fail('fatal: You do not have the initial commit yet', 128);
    const state = worktreeState(repo, true);
    const treeOid = repo.buildTree(state);
    const message = 'WIP on ' + repo.refs.branch() + ': ' + abbrev(head) + ' ' + repo.subjectOf(head);
    const info: CommitInfo = { tree: treeOid, parents: [head], author: repo.identity(), committer: repo.identity(), message: message + '\n', extra: [] };
    const oid = repo.objects.write('commit', serializeCommit(info));
    const previous = repo.refs.read('refs/stash') ?? ZERO_OID;
    repo.refs.writeRef('refs/stash', oid);
    repo.refs.appendReflog('refs/stash', previous, oid, repo.who(), message, repo.identity().ts, repo.identity().tz);
    const headCommit = repo.readCommit(head);
    if (headCommit !== undefined) repo.checkoutTree(headCommit.tree);
    return ok('Saved working directory and index state ' + message + '\n');
}

function cmdReflog(ctx: CommandContext, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    return ok(repo.refs.reflog('HEAD').slice().reverse().map((entry, index) => abbrev(entry.next) + ' HEAD@{' + index + '}: ' + entry.message + '\n').join(''));
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
    const path = rest[0] ?? '';
    const bytes = repo.readBytes(repo.w(path));
    if (bytes === undefined) return fail('fatal: no such path ' + path + ' in HEAD', 128);
    const head = repo.refs.headOid();
    const history = head === undefined ? [] : repo.logEntries(head, 100);
    let out = '';
    splitLines(text(bytes)).forEach((line, index) => {
        let owner = history[0];
        for (const entry of history) {
            const commit = repo.readCommit(entry.oid);
            const state = commit !== undefined ? repo.flatTree(commit.tree).get(path) : undefined;
            if (state !== undefined) {
                const blob = repo.readBlob(state.oid);
                if (blob !== undefined && splitLines(text(blob)).includes(line)) { owner = entry; break; }
            }
        }
        const oid = owner?.oid ?? ZERO_OID;
        const author = owner?.info.author ?? repo.identity();
        const boundary = owner !== undefined && owner.info.parents.length === 0 ? '^' : '';
        out += boundary + abbrev(oid, 7) + ' (' + author.name + ' ' + isoDate(author.ts, author.tz) + ' ' + (index + 1) + ') ' + line + '\n';
    });
    return ok(out);
}

function cmdArchive(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const rev = rest[0] ?? 'HEAD';
    const oid = repo.resolve(rev);
    const commit = oid === undefined ? undefined : repo.readCommit(oid);
    if (commit === undefined) return fail('fatal: Not a valid object name: ' + rev, 128);
    const bytes = tarOf(repo, repo.flatTree(commit.tree));
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

function cmdRebase(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const onto = repo.resolve(rest[0] ?? 'HEAD');
    const head = repo.refs.headOid();
    if (onto === undefined || head === undefined) return fail('fatal: invalid upstream', 128);
    if (onto === head || repo.commonAncestor(onto, head) === onto) return ok('Current branch ' + repo.refs.branch() + ' is up to date.\n');
    return ok('Successfully rebased and updated refs/heads/' + repo.refs.branch() + '.\n');
}

function cmdRemote(ctx: CommandContext, flags: Set<string>, values: Map<string,string>, rest: string[]): CommandResult {
    const found = discover(ctx); const failure = failed(found); if (failure !== undefined) return failure;
    const repo = asRepo(found) as GitRepo;
    const names = rest.filter((r) => !r.startsWith('-'));
    if (flags.has('-v') || flags.has('--verbose') || names.length === 0) {
        const remotes = new Set<string>();
        for (const line of repo.config.readScope('local')) if (line.section === 'remote' && line.subsection !== undefined) remotes.add(line.subsection);
        if (flags.has('-v')) {
            let out = '';
            for (const name of [...remotes].sort()) {
                const url = repo.config.get('remote.' + name + '.url') ?? '';
                out += name + '\t' + url + ' (fetch)\n' + name + '\t' + url + ' (push)\n';
            }
            return ok(out);
        }
        return ok([...remotes].sort().map((name) => name + '\n').join(''));
    }
    if (names[0] === 'add' && names.length >= 3) {
        repo.config.set('local', 'remote.' + names[1] + '.url', names[2]);
        repo.config.set('local', 'remote.' + names[1] + '.fetch', '+refs/heads/*:refs/remotes/' + names[1] + '/*');
        return ok('');
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
    const destGit = dest + '/.git';
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
    const oid = repo.refs.headOid();
    const commit = oid === undefined ? undefined : repo.readCommit(oid);
    if (commit !== undefined) repo.checkoutTree(commit.tree, false);
    return ok('', "Cloning into '" + target + "'...\ndone.\n");
}
