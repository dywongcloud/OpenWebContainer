import { utf8, text, concat, abbrev } from './bytes';
import { zipSync } from 'fflate';
import type { Change } from './repo';
import type { GitRepo } from './repo';

export interface DiffOp { kind: ' ' | '+' | '-'; value: string; }

export function splitLines(value: string): string[] {
    if (value === '') return [];
    const lines = value.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/** Longest common subsequence, small-file sized: the diff of a worktree file. */
export function diffOps(before: string[], after: string[]): DiffOp[] {
    const n = before.length, m = after.length;
    const table: number[][] = [];
    for (let i = 0; i <= n; i++) table.push(new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const ops: DiffOp[] = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (before[i] === after[j]) { ops.push({ kind: ' ', value: before[i] }); i++; j++; }
        else if (table[i + 1][j] >= table[i][j + 1]) { ops.push({ kind: '-', value: before[i] }); i++; }
        else { ops.push({ kind: '+', value: after[j] }); j++; }
    }
    while (i < n) { ops.push({ kind: '-', value: before[i] }); i++; }
    while (j < m) { ops.push({ kind: '+', value: after[j] }); j++; }
    return ops;
}

interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number; ops: DiffOp[]; }

function hunksFor(ops: DiffOp[], context = 3): Hunk[] {
    const changed: number[] = [];
    for (let i = 0; i < ops.length; i++) if (ops[i].kind !== ' ') changed.push(i);
    if (changed.length === 0) return [];
    const groups: number[][] = [];
    let group: number[] = [changed[0]];
    for (let i = 1; i < changed.length; i++) {
        if (changed[i] - changed[i - 1] > context * 2) { groups.push(group); group = []; }
        group.push(changed[i]);
    }
    groups.push(group);
    const out: Hunk[] = [];
    for (const marks of groups) {
        const start = Math.max(0, marks[0] - context);
        const end = Math.min(ops.length, marks[marks.length - 1] + context + 1);
        const slice = ops.slice(start, end);
        let oldLine = 1, newLine = 1;
        for (let k = 0; k < start; k++) {
            if (ops[k].kind !== '+') oldLine++;
            if (ops[k].kind !== '-') newLine++;
        }
        let oldCount = 0, newCount = 0;
        for (const op of slice) {
            if (op.kind !== '+') oldCount++;
            if (op.kind !== '-') newCount++;
        }
        out.push({ oldStart: oldCount === 0 ? oldLine - 1 : oldLine, oldCount, newStart: newCount === 0 ? newLine - 1 : newLine, newCount, ops: slice });
    }
    return out;
}

function range(start: number, count: number): string {
    return count === 1 ? String(start) : start + ',' + count;
}

export function unifiedFor(path: string, oldOid: string | undefined, newOid: string | undefined,
    before: string, after: string, mode: number, oldMode: number = mode): string {
    const oldLines = splitLines(before), newLines = splitLines(after);
    const ops = diffOps(oldLines, newLines);
    const hunks = hunksFor(ops);
    const out: string[] = [];
    const modeText = mode === 0o100755 ? '100755' : '100644';
    const oldModeText = oldMode === 0o100755 ? '100755' : '100644';
    out.push('diff --git a/' + path + ' b/' + path);
    if (isBinaryText(before) || isBinaryText(after)) {
        /* Host never emits a hunk for a binary blob; it prints one "Binary files ... differ"
           line after the index/mode headers. */
        if (oldOid === undefined) {
            out.push('new file mode ' + modeText);
            out.push('index 0000000..' + abbrev(newOid ?? '0000000'));
            out.push('Binary files /dev/null and b/' + path + ' differ');
        } else if (newOid === undefined) {
            out.push('deleted file mode ' + modeText);
            out.push('index ' + abbrev(oldOid) + '..0000000');
            out.push('Binary files a/' + path + ' and /dev/null differ');
        } else {
            out.push('index ' + abbrev(oldOid) + '..' + abbrev(newOid) + ' ' + modeText);
            out.push('Binary files a/' + path + ' and b/' + path + ' differ');
        }
        return out.join('\n') + '\n';
    }
    if (oldOid === undefined) {
        out.push('new file mode ' + modeText);
        out.push('index 0000000..' + abbrev(newOid ?? '0000000'));
        out.push('--- /dev/null');
        out.push('+++ b/' + path);
    } else if (newOid === undefined) {
        out.push('deleted file mode ' + modeText);
        out.push('index ' + abbrev(oldOid) + '..0000000');
        out.push('--- a/' + path);
        out.push('+++ /dev/null');
    } else {
        const modeChanged = oldModeText !== modeText;
        if (modeChanged) {
            out.push('old mode ' + oldModeText);
            out.push('new mode ' + modeText);
        }
        /* A pure mode change has NO index line and NO hunks (host git 2.53.0). */
        if (oldOid === newOid) return out.join('\n') + '\n';
        out.push('index ' + abbrev(oldOid) + '..' + abbrev(newOid) + (modeChanged ? '' : ' ' + modeText));
        out.push('--- a/' + path);
        out.push('+++ b/' + path);
    }
    for (const hunk of hunks) {
        out.push('@@ -' + range(hunk.oldStart, hunk.oldCount) + ' +' + range(hunk.newStart, hunk.newCount) + ' @@');
        for (const op of hunk.ops) out.push(op.kind + op.value);
    }
    return out.join('\n') + '\n';
}

export interface DiffCounts { path: string; added: number; removed: number; mode: number; created: boolean; deleted: boolean;
    binary: boolean; oldSize: number; newSize: number; }

export function isBinaryText(value: string): boolean { return value.includes('\u0000'); }

export function countsFor(repo: GitRepo, change: Change): DiffCounts {
    const before = repo.lineCounts(change.oldOid);
    const after = repo.lineCounts(change.newOid);
    const binary = isBinaryText(before.text) || isBinaryText(after.text);
    const ops = diffOps(splitLines(before.text), splitLines(after.text));
    let added = 0, removed = 0;
    if (!binary) for (const op of ops) { if (op.kind === '+') added++; else if (op.kind === '-') removed++; }
    return { path: change.path, added, removed, mode: change.mode,
        created: change.status === 'A', deleted: change.status === 'D', binary,
        oldSize: repo.blobSize(change.oldOid), newSize: repo.blobSize(change.newOid) };
}

export function renderDiff(repo: GitRepo, changes: Change[]): string {
    const out: string[] = [];
    for (const change of changes) {
        const before = repo.lineCounts(change.oldOid).text;
        const after = repo.lineCounts(change.newOid).text;
        const text = unifiedFor(change.path, change.oldOid, change.newOid, before, after, change.mode,
            change.oldMode ?? change.mode);
        if (text !== '') out.push(text);
    }
    return out.join('');
}

export function renderStat(repo: GitRepo, changes: Change[], width = 80, modeLines = true): string {
    if (changes.length === 0) return '';
    const counts = changes.map((change) => countsFor(repo, change));
    let added = 0, removed = 0;
    for (const entry of counts) { added += entry.added; removed += entry.removed; }
    const nameWidth = Math.max(...counts.map((entry) => entry.path.length));
    const graphWidth = Math.max(1, Math.min(50, width - nameWidth - 8));
    const total = added + removed;
    const scale = total === 0 ? 0 : Math.max(1, Math.ceil(total / graphWidth));
    const lines: string[] = [];
    for (const entry of counts) {
        if (entry.binary) {
            lines.push(' ' + entry.path.padEnd(nameWidth) + ' | Bin ' + entry.oldSize + ' -> ' + entry.newSize + ' bytes');
            continue;
        }
        const plus = Math.min(graphWidth, Math.round(entry.added / scale));
        const minus = Math.min(graphWidth - plus, Math.round(entry.removed / scale));
        const graph = '+'.repeat(plus) + '-'.repeat(minus);
        const count = entry.added + entry.removed;
        lines.push(' ' + entry.path.padEnd(nameWidth) + ' | ' + count + (graph === '' ? '' : ' ' + graph));
    }
    const files = changes.length;
    const anyBinary = counts.some((entry) => entry.binary);
    const parts: string[] = [];
    parts.push(' ' + files + ' file' + (files === 1 ? '' : 's') + ' changed');
    if (total === 0 && !anyBinary) {
        /* Host prints both zero counts for a mode-only change. */
        parts.push('0 insertions(+)');
        parts.push('0 deletions(-)');
    } else {
        if (added > 0 || anyBinary) parts.push(added + ' insertion' + (added === 1 ? '' : 's') + '(+)');
        if (removed > 0 || anyBinary) parts.push(removed + ' deletion' + (removed === 1 ? '' : 's') + '(-)');
    }
    /* Host prints the change-count summary BEFORE the create/delete mode lines. */
    lines.push(parts.join(', '));
    if (modeLines) for (const entry of counts) {
        if (entry.created) lines.push(' create mode ' + (entry.mode === 0o100755 ? '100755' : '100644') + ' ' + entry.path);
        if (entry.deleted) lines.push(' delete mode ' + (entry.mode === 0o100755 ? '100755' : '100644') + ' ' + entry.path);
    }
    return lines.join('\n') + '\n';
}

export function commitSummary(repo: GitRepo, changes: Change[]): string {
    return renderStat(repo, changes);
}

/** USTAR: 'git archive --format=tar HEAD' is a byte stream carried as a binary string. */
export function tarOf(repo: GitRepo, tree: Map<string, { oid: string; mode: number }>): Uint8Array {
    const blocks: Uint8Array[] = [];
    const octal = (value: number, width: number): string => {
        const s = Math.max(0, value).toString(8).padStart(width - 1, '0');
        return s + '\0';
    };
    const field = (value: string, width: number): Uint8Array => {
        const bytes = utf8(value);
        const out = new Uint8Array(width);
        out.set(bytes.subarray(0, Math.min(width, bytes.length)));
        return out;
    };
    const header = (name: string, size: number, mode: number): Uint8Array => {
        const parts: Uint8Array[] = [
            field(name, 100), field(octal(mode & 0o777, 8), 8), field(octal(0, 8), 8), field(octal(0, 8), 8),
            field(octal(size, 12), 12), field(octal(Math.floor(Date.now() / 1000), 12), 12),
            utf8('        '), utf8('0'), field('', 100), utf8('ustar\0'), utf8('00'),
            field('', 32), field('', 32), field(octal(0, 8), 8), field(octal(0, 8), 8), field('', 155), new Uint8Array(12)
        ];
        const head = concat(parts);
        let sum = 0;
        for (const byte of head) sum += byte;
        const checksum = sum.toString(8).padStart(6, '0') + '\0 ';
        head.set(utf8(checksum), 148);
        return head;
    };
    for (const path of [...tree.keys()].sort()) {
        const state = tree.get(path) as { oid: string; mode: number };
        const blob = repo.readBlob(state.oid);
        if (blob === undefined) continue;
        blocks.push(header(path, blob.length, state.mode));
        blocks.push(blob);
        const pad = (512 - (blob.length % 512)) % 512;
        if (pad > 0) blocks.push(new Uint8Array(pad));
    }
    blocks.push(new Uint8Array(1024));
    return concat(blocks);
}

/** A REAL ZIP container: --format=zip must not write USTAR bytes. Directory entries are
    explicit zero-byte members with a trailing slash, as host git 2.53.0 emits. */
export function zipOf(repo: GitRepo, tree: Map<string, { oid: string; mode: number }>, prefix = ''): Uint8Array {
    const entries = new Map<string, Uint8Array>();
    for (const path of [...tree.keys()].sort()) {
        const state = tree.get(path) as { oid: string; mode: number };
        const blob = repo.readBlob(state.oid);
        if (blob === undefined) continue;
        const name = prefix + path;
        const parts = name.split('/');
        for (let i = 1; i < parts.length; i++) entries.set(parts.slice(0, i).join('/') + '/', new Uint8Array(0));
        entries.set(name, blob);
    }
    const data: Record<string, Uint8Array> = {};
    for (const name of [...entries.keys()].sort()) data[name] = entries.get(name) as Uint8Array;
    return zipSync(data, { level: 0 });
}
