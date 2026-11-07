import type { IFileSystem } from '../filesystem/types';
import { utf8, text, concat, u32be, u16be, readU32be, readU16be, fromHex, toHex, sha1Raw } from './bytes';

/* ================================================================== *
 * config: system / global / local / worktree, last value wins
 * ================================================================== */

export interface ConfigLine { section: string; subsection?: string; key: string; value: string; }
export type ConfigScope = 'system' | 'global' | 'local' | 'worktree' | 'file';

function splitKey(key: string): { section: string; subsection?: string; name: string } {
    const parts = key.split('.');
    const section = (parts.shift() ?? '').toLowerCase();
    let name = (parts.pop() ?? '').toLowerCase();
    let subsection: string | undefined;
    if (parts.length > 0) { subsection = parts.join('.'); name = (key.split('.').pop() ?? '').toLowerCase(); }
    if (name === '') { name = (parts.pop() ?? '').toLowerCase(); subsection = undefined; }
    return { section, subsection, name };
}

export function parseConfig(source: string): ConfigLine[] {
    const lines: ConfigLine[] = [];
    let section = '', subsection: string | undefined;
    for (const raw of source.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
        if (line.startsWith('[') && line.endsWith(']')) {
            const inner = line.slice(1, -1).trim();
            const quoted = /^([^\s"]+)\s+"(.*)"$/.exec(inner);
            if (quoted !== null) { section = quoted[1].toLowerCase(); subsection = quoted[2]; }
            else {
                const dot = inner.indexOf('.');
                if (dot > 0) { section = inner.slice(0, dot).toLowerCase(); subsection = inner.slice(dot + 1); }
                else { section = inner.toLowerCase(); subsection = undefined; }
            }
            continue;
        }
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim().toLowerCase();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        lines.push({ section, subsection, key, value });
    }
    return lines;
}

export function formatConfig(lines: ConfigLine[]): string {
    const out: string[] = [];
    let last = '';
    for (const line of lines) {
        const head = line.subsection === undefined ? '[' + line.section + ']' : '[' + line.section + ' "' + line.subsection + '"]';
        if (head !== last) { if (out.length > 0) out.push(''); out.push(head); last = head; }
        out.push('\t' + line.key + ' = ' + line.value);
    }
    return out.length === 0 ? '' : out.join('\n') + '\n';
}

export function configKey(line: ConfigLine): string {
    return line.subsection === undefined
        ? line.section + '.' + line.key
        : line.section + '.' + line.subsection + '.' + line.key;
}

export class GitConfig {
    constructor(private fs: IFileSystem, private paths: Record<ConfigScope, string>) {}

    readScope(scope: ConfigScope): ConfigLine[] {
        const path = this.paths[scope];
        if (path === undefined || path === '' || !this.fs.fileExists(path)) return [];
        const content = this.fs.readFile(path);
        return parseConfig(content === undefined ? '' : content);
    }

    all(): ConfigLine[] {
        const scopes: ConfigScope[] = ['system', 'global', 'local', 'worktree', 'file'];
        const out: ConfigLine[] = [];
        for (const scope of scopes) out.push(...this.readScope(scope));
        return out;
    }

    get(key: string): string | undefined {
        const parts = splitKey(key);
        let found: string | undefined;
        for (const line of this.all()) {
            if (line.section === parts.section && line.key === parts.name &&
                (parts.subsection === undefined || line.subsection === parts.subsection)) found = line.value;
        }
        return found;
    }

    getAll(key: string): string[] {
        const parts = splitKey(key);
        return this.all().filter((line) => line.section === parts.section && line.key === parts.name &&
            (parts.subsection === undefined || line.subsection === parts.subsection)).map((line) => line.value);
    }

    bool(key: string, fallback = false): boolean {
        const value = this.get(key);
        if (value === undefined) return fallback;
        return !/^(false|no|off|0|)$/i.test(value);
    }

    list(): string {
        return this.all().map((line) => configKey(line) + '=' + line.value + '\n').join('');
    }

    set(scope: ConfigScope, key: string, value: string): void {
        const parts = splitKey(key);
        const path = this.paths[scope];
        const lines = this.readScope(scope);
        let changed = false;
        for (const line of lines) {
            if (line.section === parts.section && line.key === parts.name &&
                (parts.subsection === undefined || line.subsection === parts.subsection)) {
                if (!changed) { line.value = value; changed = true; }
            }
        }
        if (!changed) lines.push({ section: parts.section, subsection: parts.subsection, key: parts.name, value });
        this.fs.createDirectory(path.slice(0, path.lastIndexOf('/')));
        this.fs.writeFile(path, formatConfig(lines));
    }

    /* Host git 2.53.0: --unset refuses a multi-valued key without writing (warning, exit 5);
       --unset-all removes every value. A missing key is a silent exit 5. */
    unset(scope: ConfigScope, key: string, all = false): number {
        const parts = splitKey(key);
        const path = this.paths[scope];
        const lines = this.readScope(scope);
        let removed = 0;
        const kept = lines.filter((line) => {
            const match = line.section === parts.section && line.key === parts.name &&
                (parts.subsection === undefined || line.subsection === parts.subsection);
            if (match) { removed++; return false; }
            return true;
        });
        if (removed === 0) return 5;
        if (removed > 1 && !all) return 6;
        this.fs.writeFile(path, formatConfig(kept));
        return 0;
    }
}

/* ================================================================== *
 * index: DIRC version 2, with the trailing SHA-1 of all prior bytes
 * ================================================================== */

export interface IndexEntry {
    path: string;
    oid: string;
    mode: number;
    size: number;
    mtimeSec: number;
    mtimeNs: number;
    stage: number;
}

export function readIndex(fs: IFileSystem, gitDir: string): IndexEntry[] {
    const raw = fs.readBytes(gitDir + '/index');
    if (raw === undefined) return [];
    /* A malformed or non-v2 index must NOT be silently read as an empty index: that rewrote the
       index as v2 and reported staged deletions. Host aborts with a fatal 128. */
    const indexError = (message: string): never => {
        const e = new Error(message) as Error & { gitCode?: number };
        e.gitCode = 128;
        throw e;
    };
    if (raw.length < 32) indexError('fatal: .git/index: index file smaller than expected');
    if (text(raw.subarray(0, 4)) !== 'DIRC') indexError('fatal: .git/index: index file smaller than expected');
    const version = readU32be(raw, 4);
    if (version !== 2) indexError('fatal: .git/index: unknown index version ' + version);
    const count = readU32be(raw, 8);
    const entries: IndexEntry[] = [];
    let at = 12;
    for (let i = 0; i < count && at + 62 <= raw.length - 20; i++) {
        const start = at;
        const ctimeSec = readU32be(raw, at); const ctimeNs = readU32be(raw, at + 4);
        const mtimeSec = readU32be(raw, at + 8); const mtimeNs = readU32be(raw, at + 12);
        const dev = readU32be(raw, at + 16); const ino = readU32be(raw, at + 20);
        const mode = readU32be(raw, at + 24); const uid = readU32be(raw, at + 28);
        const gid = readU32be(raw, at + 32); const size = readU32be(raw, at + 36);
        void ctimeSec; void ctimeNs; void dev; void ino; void uid; void gid;
        const oid = toHex(raw.subarray(at + 40, at + 60));
        const flags = readU16be(raw, at + 60);
        let end = at + 62;
        while (end < raw.length && raw[end] !== 0) end++;
        const path = text(raw.subarray(at + 62, end));
        let used = end - start + 1;
        const pad = (8 - (used % 8)) % 8;
        at = end + 1 + pad;
        entries.push({ path, oid, mode, size, mtimeSec, mtimeNs, stage: (flags >>> 12) & 3 });
    }
    return entries;
}

export function writeIndex(fs: IFileSystem, gitDir: string, entries: IndexEntry[]): void {
    const sorted = entries.slice().sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.stage - b.stage);
    const parts: Uint8Array[] = [utf8('DIRC'), u32be(2), u32be(sorted.length)];
    for (const entry of sorted) {
        const name = utf8(entry.path);
        const flags = (entry.stage << 12) | Math.min(name.length, 0xfff);
        const fixed = concat([
            u32be(0), u32be(0), u32be(entry.mtimeSec), u32be(entry.mtimeNs),
            u32be(0), u32be(0), u32be(entry.mode), u32be(0), u32be(0), u32be(entry.size),
            fromHex(entry.oid), u16be(flags)
        ]);
        let used = fixed.length + name.length + 1;
        const pad = (8 - (used % 8)) % 8;
        parts.push(concat([fixed, name, new Uint8Array(1 + pad)]));
    }
    const body = concat(parts);
    const full = concat([body, sha1Raw(body)]);
    const lock = gitDir + '/index.lock';
    fs.writeBytes(lock, full);
    fs.renamePath(lock, gitDir + '/index');
}

/* ================================================================== *
 * refs: loose refs, packed-refs, HEAD symref / detached, reflogs
 * ================================================================== */

export const ZERO_OID = '0000000000000000000000000000000000000000';

export interface ReflogEntry { old: string; next: string; who: string; message: string; }

export class GitRefs {
    constructor(private fs: IFileSystem, private gitDir: string) {}

    headRaw(): string {
        try {
            const value = this.fs.readFile(this.gitDir + '/HEAD');
            return value === undefined ? 'ref: refs/heads/main\n' : value;
        } catch { return ''; }
    }
    head(): { ref?: string; oid?: string } {
        const raw = this.headRaw().trim();
        if (raw.startsWith('ref: ')) return { ref: raw.slice(5) };
        return { oid: raw };
    }
    headRef(): string { return this.head().ref ?? 'refs/heads/' + this.branch(); }
    branch(): string {
        const head = this.head();
        if (head.ref !== undefined) return head.ref.replace(/^refs\/heads\//, '');
        return '(detached)';
    }
    private loose(name: string): string | undefined {
        let value: string | undefined;
        try { value = this.fs.readFile(this.gitDir + '/' + name); } catch { return undefined; }
        if (value === undefined) return undefined;
        const oid = value.trim();
        return /^[0-9a-f]{40}$/.test(oid) ? oid : undefined;
    }
    private packed(name: string): string | undefined {
        let value: string | undefined;
        try { value = this.fs.readFile(this.gitDir + '/packed-refs'); } catch { return undefined; }
        if (value === undefined) return undefined;
        for (const line of value.split('\n')) {
            const match = /^([0-9a-f]{40}) (.+)$/.exec(line);
            if (match !== null && match[2] === name) return match[1];
        }
        return undefined;
    }
    read(name: string): string | undefined { return this.loose(name) ?? this.packed(name); }
    headOid(): string | undefined {
        const head = this.head();
        return head.oid ?? (head.ref !== undefined ? this.read(head.ref) : undefined);
    }
    writeRef(name: string, oid: string): void {
        const path = this.gitDir + '/' + name;
        const dir = path.slice(0, path.lastIndexOf('/'));
        if (!this.fs.fileExists(dir)) this.fs.createDirectory(dir);
        this.fs.writeFile(path, oid + '\n');
    }
    removeRef(name: string): void {
        const path = this.gitDir + '/' + name;
        if (this.fs.fileExists(path)) this.fs.removePath(path);
    }
    setHead(ref: string): void { this.fs.writeFile(this.gitDir + '/HEAD', 'ref: ' + ref + '\n'); }
    setDetached(oid: string): void { this.fs.writeFile(this.gitDir + '/HEAD', oid + '\n'); }
    private walk(dir: string, prefix: string, out: string[]): void {
        const names = this.fs.readdirNames(dir);
        if (names === undefined) return;
        for (const name of names) {
            const path = dir + '/' + name;
            if (this.fs.isDirectory(path)) this.walk(path, prefix + name + '/', out);
            else out.push(prefix + name);
        }
    }
    branches(): string[] {
        const out: string[] = [];
        this.walk(this.gitDir + '/refs/heads', '', out);
        let packed: string | undefined;
        try { packed = this.fs.readFile(this.gitDir + '/packed-refs'); } catch { packed = undefined; }
        if (packed !== undefined) for (const line of packed.split('\n')) {
            const match = /^[0-9a-f]{40} refs\/heads\/(.+)$/.exec(line);
            if (match !== null && !out.includes(match[1])) out.push(match[1]);
        }
        return out.sort();
    }
    tags(): string[] {
        const out: string[] = [];
        this.walk(this.gitDir + '/refs/tags', '', out);
        return out.sort();
    }
    reflog(name: string): ReflogEntry[] {
        const path = this.gitDir + '/logs/' + (name === 'HEAD' ? 'HEAD' : name);
        let value: string | undefined;
        try { value = this.fs.readFile(path); } catch { return []; }
        if (value === undefined) return [];
        const out: ReflogEntry[] = [];
        for (const line of value.split('\n')) {
            if (line === '') continue;
            const tab = line.indexOf('\t');
            const head = tab < 0 ? line : line.slice(0, tab);
            const message = tab < 0 ? '' : line.slice(tab + 1);
            const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.*) (\d+) ([+-]\d{4})$/.exec(head);
            if (match !== null) out.push({ old: match[1], next: match[2], who: match[3], message });
        }
        return out;
    }
    appendReflog(name: string, old: string, next: string, who: string, message: string, ts: number, tz: string): void {
        const path = this.gitDir + '/logs/' + (name === 'HEAD' ? 'HEAD' : name);
        const dir = path.slice(0, path.lastIndexOf('/'));
        if (!this.fs.fileExists(dir)) this.fs.createDirectory(dir);
        const line = old + ' ' + next + ' ' + who + ' ' + ts + ' ' + tz + '\t' + message + '\n';
        let previous = '';
        try { previous = this.fs.readFile(path) ?? ''; } catch { previous = ''; }
        this.fs.writeFile(path, previous + line);
    }
}
