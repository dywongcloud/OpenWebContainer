import { CapabilityContext, CapabilityHandler } from './types';
import { base64ToBytes, bytesToBase64 } from '../../../../../utils/bytes';

/*
 * Host half of the memory a SharedArrayBuffer shares: the bytes behind one buffer, and the waiters
 * another thread's Atomics.wait left on an index of it.
 *
 * A SharedArrayBuffer that crosses to a worker keeps sharing its memory there, and the two sides are
 * container processes with heaps of their own, so the one memory they can both reach is this one.
 * Each atomic operation is a synchronous capability call, and the host runs one thread of its own,
 * so a read-modify-write cannot interleave with another: it is atomic for the same reason it is on a
 * host, where one agent runs at a time here too.
 *
 * A wait is the one call that cannot answer at once. It hands back a promise and the guest suspends
 * on it -- the wasm stack unwinds, the notifying thread runs, and the guest resumes inside the
 * statement that called, which is what lets one process wake another. The guest half is the Atomics
 * wrap in ../guest/modules/child.ts.
 *
 * Host half of the two message routes that leave a process: a BroadcastChannel name, and the link a
 * transferred MessagePort keeps. Two container processes share no heap and no descriptor, so the
 * only place they meet is here. An endpoint opens a key (busOpen), a post on that key (busPost)
 * reaches every other endpoint open on it, and the frames posted inside one turn travel together,
 * one delivery per process, so a receiving process hands them out in the order its endpoints were
 * made -- the order node hands them out in. The guest half is the bus in ../guest/modules/child.ts.
 */

interface Waiter {
    /** The element index being waited on, in the elements of the array that waits. */
    index: number;
    /** The value the waiter expects to find there, a decimal string for a 64-bit kind. */
    expected: number | string;
    kind: string;
    resolve: (answer: string) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
}

interface Slab {
    bytes: Uint8Array;
    waiters: Waiter[];
}

const slabs = new Map<number, Slab>();
let nextSlabId = 1;

/** Bytes per element, by the kind name the guest sends. */
const ELEMENT_BYTES: Record<string, number> = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, i64: 8, u64: 8 };

function slabOf(id: unknown): Slab {
    const found = slabs.get(Number(id));
    if (found === undefined) throw new Error('no such shared buffer');
    return found;
}

function elementBytesOf(kind: unknown): number {
    const size = ELEMENT_BYTES[String(kind)];
    return size === undefined ? 1 : size;
}

/** The value at one element, as a number or, for a 64-bit kind, as a decimal string. */
function readElement(slab: Slab, index: number, kind: string): number | string {
    const size = elementBytesOf(kind);
    const at = index * size;
    if (at < 0 || at + size > slab.bytes.length) return 0;
    const view = new DataView(slab.bytes.buffer, slab.bytes.byteOffset, slab.bytes.byteLength);
    switch (kind) {
        case 'i8': return view.getInt8(at);
        case 'u8': return view.getUint8(at);
        case 'i16': return view.getInt16(at, true);
        case 'u16': return view.getUint16(at, true);
        case 'i32': return view.getInt32(at, true);
        case 'u32': return view.getUint32(at, true);
        case 'i64': return view.getBigInt64(at, true).toString();
        case 'u64': return view.getBigUint64(at, true).toString();
        default: return 0;
    }
}

function sameValue(found: number | string, expected: number | string): boolean {
    if (typeof found === 'string' || typeof expected === 'string') {
        try {
            return BigInt(String(found)) === BigInt(String(expected));
        } catch {
            return false;
        }
    }
    return found === expected;
}

const createSlab: CapabilityHandler = (args) => {
    const length = Math.max(0, Number(args.n));
    const bytes = new Uint8Array(length);
    if (typeof args.bytes === 'string' && args.bytes !== '') {
        const given = base64ToBytes(args.bytes);
        bytes.set(given.subarray(0, Math.min(length, given.length)));
    }
    const id = nextSlabId++;
    slabs.set(id, { bytes, waiters: [] });
    return { id: id };
};

const readSlab: CapabilityHandler = (args) => {
    const slab = slabOf(args.id);
    const from = Math.max(0, Number(args.off) || 0);
    const length = args.len === undefined || args.len === null ? slab.bytes.length - from : Number(args.len);
    return bytesToBase64(slab.bytes.subarray(from, from + Math.max(0, length)));
};

const writeSlab: CapabilityHandler = (args) => {
    const slab = slabOf(args.id);
    const from = Math.max(0, Number(args.off) || 0);
    if (typeof args.bytes !== 'string' || args.bytes === '') return true;
    const given = base64ToBytes(args.bytes);
    const room = slab.bytes.length - from;
    slab.bytes.set(given.subarray(0, Math.min(room, given.length)), from);
    return true;
};

const releaseSlab: CapabilityHandler = (args) => {
    slabs.delete(Number(args.id));
    return true;
};

const notifyWaiters: CapabilityHandler = (args) => {
    const slab = slabOf(args.id);
    const index = Number(args.index);
    const count = args.count === undefined || args.count === null ? Infinity : Number(args.count);
    let woken = 0;
    const left: Waiter[] = [];
    for (const waiter of slab.waiters) {
        if (woken < count && waiter.index === index) {
            if (waiter.timer !== undefined) clearTimeout(waiter.timer);
            woken += 1;
            waiter.resolve('ok');
            continue;
        }
        left.push(waiter);
    }
    slab.waiters = left;
    return woken;
};

/**
 * Atomics.wait: the answer is 'not-equal' at once when the element does not hold what the caller
 * expected, and otherwise a promise, because only another thread can end the wait.
 */
const waitOnSlab: CapabilityHandler = (args) => {
    const slab = slabOf(args.id);
    const index = Number(args.index);
    const kind = String(args.kind);
    const expected = args.expected;
    const found = readElement(slab, index, kind);
    if (!sameValue(found, expected === null || expected === undefined ? 0 : expected)) return 'not-equal';
    const ms = args.timeout === undefined || args.timeout === null ? Infinity : Number(args.timeout);
    if (!(ms > 0)) return 'timed-out';
    return new Promise<string>((resolve) => {
        const waiter: Waiter = { index, expected, kind, resolve, timer: undefined };
        const finish = (answer: string) => {
            const at = slab.waiters.indexOf(waiter);
            if (at >= 0) slab.waiters.splice(at, 1);
            resolve(answer);
        };
        waiter.resolve = finish;
        if (ms !== Infinity) {
            waiter.timer = setTimeout(() => finish('timed-out'), Math.min(ms, 2147483647));
        }
        slab.waiters.push(waiter);
    });
};

/*
 * The bus: one endpoint of one BroadcastChannel or of one transferred port's link, as the pid and the
 * guest target the host reaches it on. `id` is unique across the container (the guest makes it out of
 * its own pid), so a post reaches every other endpoint on the key and never the one that posted.
 */
interface BusEntry {
    pid: number;
    target: number;
    key: string;
    id: number;
}

interface BusFrame {
    key: string;
    from: number;
    frame: unknown;
}

interface Bus {
    entries: BusEntry[];
    pending: BusFrame[];
    timer: ReturnType<typeof setTimeout> | undefined;
    nextLink: number;
}

/** One bus per container: the services object is the container's own, so no two share a channel. */
const buses = new WeakMap<object, Bus>();

function busFor(ctx: CapabilityContext): Bus {
    const key = ctx.services as unknown as object;
    let bus = buses.get(key);
    if (bus === undefined) {
        bus = { entries: [], pending: [], timer: undefined, nextLink: 1 };
        buses.set(key, bus);
    }
    return bus;
}

/**
 * The frames one turn posted, handed on: grouped by the process each is going to, so a process gets
 * one delivery for the whole turn and hands its own out in the order its endpoints were made.
 */
function flushBus(ctx: CapabilityContext, bus: Bus): void {
    bus.timer = undefined;
    const frames = bus.pending.splice(0);
    const groups = new Map<number, { target: number; items: unknown[] }>();
    for (const frame of frames) {
        for (const entry of bus.entries) {
            if (entry.key !== frame.key || entry.id === frame.from) continue;
            let group = groups.get(entry.pid);
            if (group === undefined) {
                group = { target: entry.target, items: [] };
                groups.set(entry.pid, group);
            }
            group.items.push([entry.id, frame.frame]);
        }
    }
    for (const [pid, group] of groups) {
        const payload = { items: group.items };
        /* Own process: ctx.deliver, which is the route that also works inside a synchronous run. */
        if (pid === ctx.pid) {
            ctx.deliver(group.target, 'bus', payload);
            continue;
        }
        ctx.services.sinkFor(pid)?.deliver(group.target, 'bus', payload);
    }
}

const busOpen: CapabilityHandler = (args, ctx) => {
    const bus = busFor(ctx);
    const id = Number(args.id);
    bus.entries = bus.entries.filter((entry) => entry.id !== id);
    bus.entries.push({ pid: ctx.pid, target: Number(args.target), key: String(args.key), id });
    return true;
};

const busClose: CapabilityHandler = (args, ctx) => {
    const bus = busFor(ctx);
    const id = Number(args.id);
    bus.entries = bus.entries.filter((entry) => entry.id !== id);
    return true;
};

const busPost: CapabilityHandler = (args, ctx) => {
    const bus = busFor(ctx);
    bus.pending.push({ key: String(args.key), from: Number(args.from), frame: args.frame });
    if (bus.timer === undefined) bus.timer = setTimeout(() => flushBus(ctx, bus), 0);
    return true;
};

/** The id a transferred port's link gets: one number no other link in this container has. */
const busLink: CapabilityHandler = (_args, ctx) => {
    const bus = busFor(ctx);
    return { id: bus.nextLink++ };
};

export const SHARED_CAPABILITIES: Record<string, CapabilityHandler> = {
    'shared.create': createSlab,
    'shared.read': readSlab,
    'shared.write': writeSlab,
    'shared.release': releaseSlab,
    'shared.notify': notifyWaiters,
    'shared.wait': waitOnSlab,
    'shared.busOpen': busOpen,
    'shared.busClose': busClose,
    'shared.busPost': busPost,
    'shared.busLink': busLink
};
