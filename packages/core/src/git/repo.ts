import type { IFileSystem } from '../filesystem/types';
import type { CommandContext } from '../shell/commands/types';
import { utf8, text, concat, toHex } from './bytes';
import {
    createObjectStore, type ObjectStore, type GitObject, type TreeEntry, type CommitInfo, type Identity,
    parseTree, serializeTree, parseCommit, serializeCommit, oidOf
} from './objects';
import { GitConfig, type ConfigScope, readIndex, writeIndex, type IndexEntry, GitRefs, ZERO_OID } from './store';

export class GitError extends Error {
    constructor(public code: number, message: string) { super(message); }
}

export function fatal(message: string, code = 128): GitError { return new GitError(code, 'fatal: ' + message); }

export function normalizePath(path: string): string {
    const parts: string[] = [];
    for (const part of path.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') { if (parts.length > 0) parts.pop(); continue; }
        parts.push(part);
    }
    return '/' + parts.join('/');
}

export interface FileState { oid: string; mode: number; }
export interface StatusRow { x: string; y: string; path: string; staged: boolean; unstaged: boolean; orig?: string; }
export interface Change { path: string; status: 'A' | 'M' | 'D'; oldOid?: string; newOid?: string; mode: number; }

export const INIT_HINT = [
    "hint: Using 'master' as the name for the initial branch. This default branch name",
    'hint: is subject to change. To configure the initial branch name to use in all',
    'hint: of your new repositories, which will suppress this warning, call:',
    'hint: ',
    'hint: \tgit config --global init.defaultBranch <name>',
    'hint: ',
    "hint: Names commonly chosen instead of 'master' are 'main', 'trunk' and",
    "hint: 'development'. The just-created branch can be renamed via this command:",
    'hint: ',
    'hint: \tgit branch -m <name>'
].join('\n') + '\n';

export class GitRepo {
    readonly fs: IFileSystem;
    readonly ctx: CommandContext;
    readonly root: string;
    readonly gitDir: string;
    readonly objects: ObjectStore;
    readonly config: GitConfig;
    readonly refs: GitRefs;
    readonly env: Record<string, string>;
    readonly input: string | null;

    constructor(ctx: CommandContext, root: string, gitDir: string) {
        this.ctx = ctx; this.fs = ctx.fs; this.root = root; this.gitDir = gitDir;
        this.env = ctx.env ?? {}; this.input = ctx.input ?? null;
        this.objects = createObjectStore(ctx.fs, gitDir);
        const home = this.env.HOME ?? '/home';
        const paths: Record<ConfigScope, string> = {
            system: this.env.GIT_CONFIG_SYSTEM ?? '/etc/gitconfig',
            global: this.env.GIT_CONFIG_GLOBAL ?? (home + '/.gitconfig'),
            local: gitDir + '/config',
            worktree: gitDir + '/config.worktree',
            file: ''
        };
        this.config = new GitConfig(ctx.fs, paths);
        this.refs = new GitRefs(ctx.fs, gitDir);
    }

    static discover(ctx: CommandContext): GitRepo {
        let dir = normalizePath(ctx.cwd || '/app');
        for (let i = 0; i < 64; i++) {
            const candidate = dir + '/.git';
            if (ctx.fs.fileExists(candidate)) return new GitRepo(ctx, dir, candidate);
            if (dir === '/') break;
            const cut = dir.lastIndexOf('/');
            dir = cut <= 0 ? '/' : dir.slice(0, cut);
        }
        throw fatal('not a git repository (or any of the parent directories): .git');
    }

    static init(ctx: CommandContext, target: string, branch?: string): { repo: GitRepo; hint: string } {
        const dir = normalizePath(target.startsWith('/') ? target : (ctx.cwd || '/app') + '/' + target);
        const gitDir = dir + '/.git';
        if (!ctx.fs.fileExists(dir)) ctx.fs.createDirectory(dir);
        for (const sub of ['objects', 'objects/info', 'objects/pack', 'refs', 'refs/heads', 'refs/tags', 'info', 'hooks', 'branches', 'logs']) {
            const path = gitDir + '/' + sub;
            if (!ctx.fs.fileExists(path)) ctx.fs.createDirectory(path);
        }
        const repo = new GitRepo(ctx, dir, gitDir);
        const configured = repo.config.get('init.defaultbranch');
        const chosen = branch ?? configured ?? 'master';
        const hint = branch === undefined && configured === undefined ? INIT_HINT : '';
        ctx.fs.writeFile(gitDir + '/HEAD', 'ref: refs/heads/' + chosen + '\n');
        ctx.fs.writeFile(gitDir + '/config', [
            '[core]',
            '\trepositoryformatversion = 0',
            '\tfilemode = true',
            '\tbare = false',
            '\tlogallrefupdates = true',
            '\tignorecase = true',
            '\tprecomposeunicode = true',
            ''
        ].join('\n'));
        ctx.fs.writeFile(gitDir + '/description', 'Unnamed repository; edit this file to name the repository.\n');
        ctx.fs.writeFile(gitDir + '/info/exclude', '# git ls-files --others --exclude-from=.git/info/exclude\n*.[oa]\n*~\n');
        return { repo, hint };
    }

    g(rel: string): string { return this.gitDir + '/' + rel; }
    w(rel: string): string { return this.root + '/' + rel; }
    exists(path: string): boolean { try { return this.fs.fileExists(path); } catch { return false; } }
    isDir(path: string): boolean { try { return this.fs.isDirectory(path); } catch { return false; } }
    readText(path: string): string | undefined { try { return this.fs.readFile(path); } catch { return undefined; } }
    writeText(path: string, value: string): void { this.mkdirp(path.slice(0, path.lastIndexOf('/'))); this.fs.writeFile(path, value); }
    readBytes(path: string): Uint8Array | undefined { try { return this.fs.readBytes(path); } catch { return undefined; } }
    writeBytes(path: string, value: Uint8Array): void { this.mkdirp(path.slice(0, path.lastIndexOf('/'))); this.fs.writeBytes(path, value); }
    mkdirp(path: string): void { if (path !== '' && !this.exists(path)) this.fs.createDirectory(path); }
    names(path: string): string[] { try { return this.fs.readdirNames(path) ?? []; } catch { return []; } }
    remove(path: string): void { if (this.exists(path)) { try { this.fs.removePath(path, true); } catch { /* absent */ } } }

    now(): { ts: number; tz: string } {
        const raw = this.env.GIT_AUTHOR_DATE ?? this.env.GIT_COMMITTER_DATE;
        if (raw !== undefined) {
            const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})$/.exec(raw);
            if (match !== null) return { ts: Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) / 1000), tz: match[7] };
        }
        return { ts: Math.floor(Date.now() / 1000), tz: '+0000' };
    }
    identity(): Identity {
        const name = this.config.get('user.name') ?? 'OWC Oracle';
        const email = this.config.get('user.email') ?? 'oracle@owc.invalid';
        const stamp = this.now();
        return { name, email, ts: stamp.ts, tz: stamp.tz };
    }
    who(): string { const id = this.identity(); return id.name + ' <' + id.email + '>'; }

    resolve(rev: string): string | undefined {
        if (rev === undefined || rev === '') return this.refs.headOid();
        if (/^[0-9a-f]{40}$/.test(rev)) return rev;
        if (/^[0-9a-f]{4,39}$/.test(rev)) {
            for (const prefix of ['', 'objects/']) void prefix;
            const candidates: string[] = [];
            for (const dir of this.names(this.g('objects'))) {
                if (dir.length === 2 && dir.startsWith(rev.slice(0, 2))) {
                    for (const name of this.names(this.g('objects/' + dir))) {
                        const oid = dir + name;
                        if (oid.startsWith(rev)) candidates.push(oid);
                    }
                }
            }
            if (candidates.length === 1) return candidates[0];
        }
        const aliases: Record<string, string> = { HEAD: 'HEAD', '@': 'HEAD' };
        const key = aliases[rev] ?? rev;
        if (key === 'HEAD') return this.refs.headOid();
        const tryNames = [key, 'refs/' + key, 'refs/heads/' + key, 'refs/tags/' + key, 'refs/remotes/' + key, 'refs/remotes/' + key + '/HEAD'];
        for (const name of tryNames) {
            const oid = this.refs.read(name);
            if (oid !== undefined) return oid;
        }
        const caret = /^(.+)([\^~])([0-9]*)$/.exec(rev);
        if (caret !== null) {
            let oid = this.resolve(caret[1]);
            const count = caret[3] === '' ? 1 : Number(caret[3]);
            for (let i = 0; i < count && oid !== undefined; i++) {
                const commit = this.readCommit(oid);
                oid = commit?.parents[0];
            }
            return oid;
        }
        return undefined;
    }

    object(oid: string): GitObject | undefined { return this.objects.read(oid); }
    readCommit(oid: string): CommitInfo | undefined {
        const obj = this.object(oid);
        if (obj === undefined || obj.type !== 'commit') return undefined;
        return parseCommit(obj.content);
    }

    hashBlob(bytes: Uint8Array): string { return oidOf('blob', bytes); }
    readBlob(oid: string): Uint8Array | undefined {
        const obj = this.object(oid);
        return obj !== undefined && obj.type === 'blob' ? obj.content : undefined;
    }

    flatTree(oid: string, prefix = '', out: Map<string, FileState> = new Map()): Map<string, FileState> {
        const obj = this.object(oid);
        if (obj === undefined || obj.type !== 'tree') return out;
        for (const entry of parseTree(obj.content)) {
            const path = prefix + entry.name;
            if (entry.mode === '40000' || entry.mode === '040000') this.flatTree(entry.oid, path + '/', out);
            else out.set(path, { oid: entry.oid, mode: parseInt(entry.mode, 8) });
        }
        return out;
    }

    buildTree(files: Map<string, FileState>): string {
        interface Node { dirs: Map<string, Node>; files: TreeEntry[]; }
        const root: Node = { dirs: new Map(), files: [] };
        for (const [path, state] of files) {
            const parts = path.split('/');
            let node = root;
            for (let i = 0; i < parts.length - 1; i++) {
                let next = node.dirs.get(parts[i]);
                if (next === undefined) { next = { dirs: new Map(), files: [] }; node.dirs.set(parts[i], next); }
                node = next;
            }
            const mode = state.mode === 0o100755 ? '100755' : (state.mode === 0o120000 ? '120000' : '100644');
            node.files.push({ mode, name: parts[parts.length - 1], oid: state.oid });
        }
        const build = (node: Node): string => {
            const entries = node.files.slice();
            for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
            return this.objects.write('tree', serializeTree(entries));
        };
        return build(root);
    }

    indexEntries(): IndexEntry[] { return readIndex(this.fs, this.gitDir); }
    writeIndexEntries(entries: IndexEntry[]): void { writeIndex(this.fs, this.gitDir, entries); }

    headTree(): Map<string, FileState> {
        const oid = this.refs.headOid();
        if (oid === undefined) return new Map();
        const commit = this.readCommit(oid);
        if (commit === undefined) return new Map();
        return this.flatTree(commit.tree);
    }

    indexTree(): Map<string, FileState> {
        const out = new Map<string, FileState>();
        for (const entry of this.indexEntries()) out.set(entry.path, { oid: entry.oid, mode: entry.mode });
        return out;
    }

    /* Every status read re-hashes the worktree file: the stat cache is never trusted. */
    worktreeFiles(): string[] {
        const out: string[] = [];
        const walk = (dir: string, prefix: string): void => {
            for (const name of this.names(dir)) {
                if (name === '.git') continue;
                const path = dir + '/' + name;
                const rel = prefix + name;
                if (this.isDir(path)) walk(path, rel + '/');
                else out.push(rel);
            }
        };
        walk(this.root, '');
        return out.sort();
    }

    ignored(rel: string): boolean {
        /* Root .gitignore, .git/info/exclude and every nested .gitignore, in precedence order:
           a pattern in a deeper directory applies to the remainder of the path below it. */
        const parts = rel.split('/');
        const sources: string[] = [this.g('info/exclude')];
        for (let i = 0; i < parts.length; i++) {
            const dir = parts.slice(0, i).join('/');
            sources.push(this.w(dir === '' ? '.gitignore' : dir + '/.gitignore'));
        }
        let ignored = false;
        for (let s = 0; s < sources.length; s++) {
            const content = this.readText(sources[s]);
            if (content === undefined) continue;
            const sub = s === 0 ? rel : parts.slice(s - 1).join('/');
            for (const raw of content.split('\n')) {
                const line = raw.trim();
                if (line === '' || line.startsWith('#')) continue;
                const negated = line.startsWith('!');
                const pattern = negated ? line.slice(1) : line;
                const match = pattern.endsWith('/')
                    ? (sub === pattern.slice(0, -1) || sub.startsWith(pattern))
                    : (sub === pattern || sub.endsWith('/' + pattern) || sub.split('/').includes(pattern));
                if (match) ignored = !negated;
            }
        }
        return ignored;
    }

    worktreeOid(rel: string): string | undefined {
        const bytes = this.readBytes(this.w(rel));
        if (bytes === undefined) return undefined;
        return this.hashBlob(bytes);
    }

    changesBetween(base: Map<string, FileState>, next: Map<string, FileState>): Change[] {
        const out: Change[] = [];
        const paths = new Set([...base.keys(), ...next.keys()]);
        for (const path of [...paths].sort()) {
            const before = base.get(path), after = next.get(path);
            if (before === undefined && after !== undefined) out.push({ path, status: 'A', newOid: after.oid, mode: after.mode });
            else if (before !== undefined && after === undefined) out.push({ path, status: 'D', oldOid: before.oid, mode: before.mode });
            else if (before !== undefined && after !== undefined && (before.oid !== after.oid || before.mode !== after.mode)) {
                out.push({ path, status: 'M', oldOid: before.oid, newOid: after.oid, mode: after.mode });
            }
        }
        return out;
    }

    /** Raw byte size of a blob: the "Bin N -> M bytes" stat must not decode UTF-8 first. */
    blobSize(oid: string | undefined): number {
        if (oid === undefined) return 0;
        const obj = this.object(oid);
        return obj === undefined || obj.type !== 'blob' ? 0 : obj.content.length;
    }

    lineCounts(oid: string | undefined): { lines: number; text: string } {
        if (oid === undefined) return { lines: 0, text: '' };
        const blob = this.readBlob(oid);
        if (blob === undefined) return { lines: 0, text: '' };
        const value = text(blob);
        const lines = value.length === 0 ? 0 : value.split('\n').length - (value.endsWith('\n') ? 1 : 0);
        return { lines, text: value };
    }

    checkoutTree(oid: string, prune = true): void {
        /* Callers pass either a tree oid (reset --hard, merge, stash, clone, read-tree) or a
           COMMIT oid (checkout --detach, switchBranch). flatTree only walks tree objects, so a
           commit oid produced an empty tree: it deleted every tracked worktree file and wrote an
           empty index, which made a following 'git status' report staged deletions. */
        let treeOid = oid;
        const obj = this.object(oid);
        if (obj !== undefined && obj.type === 'commit') {
            const commit = this.readCommit(oid);
            if (commit !== undefined) treeOid = commit.tree;
        }
        const tree = this.flatTree(treeOid);
        const tracked = this.indexTree();
        if (prune) for (const path of tracked.keys()) {
            if (!tree.has(path)) this.remove(this.w(path));
        }
        for (const [path, state] of tree) {
            const blob = this.readBlob(state.oid);
            if (blob === undefined) continue;
            this.writeBytes(this.w(path), blob);
        }
        const entries: IndexEntry[] = [];
        for (const [path, state] of tree) {
            const stat = this.statOf(this.w(path));
            entries.push({ path, oid: state.oid, mode: state.mode, size: stat.size,
                mtimeSec: Math.floor(stat.mtimeMs / 1000), mtimeNs: 0, stage: 0 });
        }
        this.writeIndexEntries(entries);
    }

    statOf(path: string): { size: number; mtimeMs: number; mode: number } {
        let stat;
        try { stat = this.fs.statPath(path); } catch { stat = undefined; }
        return { size: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? Date.now(), mode: stat?.mode ?? 0o100644 };
    }

    entryFor(path: string): IndexEntry {
        const bytes = this.readBytes(this.w(path));
        const stat = this.statOf(this.w(path));
        const mode = stat.mode & 0o100 ? 0o100755 : 0o100644;
        return {
            path, oid: bytes === undefined ? ZERO_OID : this.objects.write('blob', bytes), mode,
            size: stat.size, mtimeSec: Math.floor(stat.mtimeMs / 1000), mtimeNs: 0, stage: 0
        };
    }

    logEntries(oid: string | undefined, limit = 100): { oid: string; info: CommitInfo }[] {
        const out: { oid: string; info: CommitInfo }[] = [];
        const seen = new Set<string>();
        const queue: string[] = oid === undefined ? [] : [oid];
        while (queue.length > 0 && out.length < limit) {
            const current = queue.shift() as string;
            if (seen.has(current)) continue;
            seen.add(current);
            const info = this.readCommit(current);
            if (info === undefined) continue;
            out.push({ oid: current, info });
            for (const parent of info.parents) queue.push(parent);
        }
        return out;
    }

    subjectOf(oid: string): string {
        const info = this.readCommit(oid);
        return info === undefined ? '' : info.message.trim().split('\n')[0];
    }

    commonAncestor(a: string, b: string): string | undefined {
        const parents = (oid: string): string[] => {
            const info = this.readCommit(oid);
            return info === undefined ? [] : info.parents;
        };
        const chain = new Set<string>();
        const queue = [a];
        while (queue.length > 0) {
            const current = queue.shift() as string;
            if (chain.has(current)) continue;
            chain.add(current);
            for (const p of parents(current)) queue.push(p);
        }
        const queue2 = [b];
        const seen = new Set<string>();
        while (queue2.length > 0) {
            const current = queue2.shift() as string;
            if (seen.has(current)) continue;
            seen.add(current);
            if (chain.has(current)) return current;
            for (const p of parents(current)) queue2.push(p);
        }
        return undefined;
    }
}
