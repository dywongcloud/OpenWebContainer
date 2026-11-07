import { utf8, text, concat, sha1Hex, fromHex, toHex, zdeflate, zinflate } from './bytes';
import type { IFileSystem } from '../filesystem/types';

export interface GitObject { type: string; content: Uint8Array; oid: string; }
export interface TreeEntry { mode: string; name: string; oid: string; }
export interface Identity { name: string; email: string; ts: number; tz: string; }
export interface CommitInfo {
    tree: string;
    parents: string[];
    author: Identity;
    committer: Identity;
    message: string;
    extra: string[];
}

/** '<type> <size>\0<content>' -- the uncompressed bytes a loose object's id is the SHA-1 of. */
export function objectRaw(type: string, content: Uint8Array): Uint8Array {
    return concat([utf8(type + ' ' + content.length + '\0'), content]);
}
export function oidOf(type: string, content: Uint8Array): string { return sha1Hex(objectRaw(type, content)); }

export interface ObjectStore {
    has(oid: string): boolean;
    read(oid: string): GitObject | undefined;
    write(type: string, content: Uint8Array): string;
}

export function createObjectStore(fs: IFileSystem, gitDir: string): ObjectStore {
    const pathOf = (oid: string): string => gitDir + '/objects/' + oid.slice(0, 2) + '/' + oid.slice(2);
    const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));
    return {
        has(oid: string): boolean { return fs.fileExists(pathOf(oid)); },
        read(oid: string): GitObject | undefined {
            if (!/^[0-9a-f]{40}$/.test(oid)) return undefined;
            const packed = fs.readBytes(pathOf(oid));
            if (packed === undefined) return undefined;
            let full: Uint8Array;
            try { full = zinflate(packed); } catch { return undefined; }
            const nul = full.indexOf(0);
            if (nul < 0) return undefined;
            const header = text(full.subarray(0, nul));
            const space = header.indexOf(' ');
            if (space < 0) return undefined;
            return { type: header.slice(0, space), content: full.subarray(nul + 1), oid };
        },
        write(type: string, content: Uint8Array): string {
            const full = objectRaw(type, content);
            const oid = sha1Hex(full);
            const path = pathOf(oid);
            if (!fs.fileExists(path)) {
                const dir = dirOf(path);
                if (!fs.fileExists(dir)) fs.createDirectory(dir);
                else if (!fs.isDirectory(dir)) fs.createDirectory(dir);
                fs.writeBytes(path, zdeflate(full));
            }
            return oid;
        }
    };
}

function sortKey(entry: TreeEntry): string { return entry.name + (entry.mode === '40000' ? '/' : ''); }

export function parseTree(content: Uint8Array): TreeEntry[] {
    const entries: TreeEntry[] = [];
    let at = 0;
    while (at < content.length) {
        const space = content.indexOf(32, at);
        if (space < 0) break;
        const nul = content.indexOf(0, space + 1);
        if (nul < 0 || nul + 21 > content.length) break;
        const mode = text(content.subarray(at, space));
        const name = text(content.subarray(space + 1, nul));
        const oid = toHex(content.subarray(nul + 1, nul + 21));
        entries.push({ mode, name, oid });
        at = nul + 21;
    }
    return entries;
}

export function serializeTree(entries: TreeEntry[]): Uint8Array {
    const sorted = entries.slice().sort((a, b) => {
        const ka = sortKey(a), kb = sortKey(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return concat(sorted.map((entry) => concat([utf8(entry.mode + ' ' + entry.name + '\0'), fromHex(entry.oid)])));
}

function identityLine(ident: Identity): string {
    return ident.name + ' <' + ident.email + '> ' + ident.ts + ' ' + ident.tz;
}
function parseIdentity(value: string): Identity {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(value);
    if (match === null) return { name: '', email: '', ts: 0, tz: '+0000' };
    return { name: match[1], email: match[2], ts: Number(match[3]), tz: match[4] };
}

export function parseCommit(content: Uint8Array): CommitInfo {
    const raw = text(content);
    const split = raw.indexOf('\n\n');
    const head = split < 0 ? raw : raw.slice(0, split);
    const message = split < 0 ? '' : raw.slice(split + 2);
    const info: CommitInfo = {
        tree: '', parents: [], author: { name: '', email: '', ts: 0, tz: '+0000' },
        committer: { name: '', email: '', ts: 0, tz: '+0000' }, message, extra: []
    };
    for (const line of head.split('\n')) {
        if (line.startsWith('tree ')) info.tree = line.slice(5);
        else if (line.startsWith('parent ')) info.parents.push(line.slice(7));
        else if (line.startsWith('author ')) info.author = parseIdentity(line.slice(7));
        else if (line.startsWith('committer ')) info.committer = parseIdentity(line.slice(10));
        else if (line !== '') info.extra.push(line);
    }
    return info;
}

export function serializeCommit(info: CommitInfo): Uint8Array {
    const lines: string[] = ['tree ' + info.tree];
    for (const parent of info.parents) lines.push('parent ' + parent);
    lines.push('author ' + identityLine(info.author));
    lines.push('committer ' + identityLine(info.committer));
    for (const extra of info.extra) lines.push(extra);
    lines.push('');
    const message = info.message.endsWith('\n') ? info.message : info.message + '\n';
    return utf8(lines.join('\n') + '\n' + message);
}

export interface TagInfo { object: string; type: string; tag: string; tagger: Identity; message: string; }
export function parseTag(content: Uint8Array): TagInfo {
    const raw = text(content);
    const split = raw.indexOf('\n\n');
    const head = split < 0 ? raw : raw.slice(0, split);
    const message = split < 0 ? '' : raw.slice(split + 2);
    const info: TagInfo = { object: '', type: '', tag: '', tagger: { name: '', email: '', ts: 0, tz: '+0000' }, message };
    for (const line of head.split('\n')) {
        if (line.startsWith('object ')) info.object = line.slice(7);
        else if (line.startsWith('type ')) info.type = line.slice(5);
        else if (line.startsWith('tag ')) info.tag = line.slice(4);
        else if (line.startsWith('tagger ')) info.tagger = parseIdentity(line.slice(7));
    }
    return info;
}
export function serializeTag(info: TagInfo): Uint8Array {
    const lines = ['object ' + info.object, 'type ' + info.type, 'tag ' + info.tag, 'tagger ' + identityLine(info.tagger), ''];
    const message = info.message.endsWith('\n') ? info.message : info.message + '\n';
    return utf8(lines.join('\n') + message);
}
