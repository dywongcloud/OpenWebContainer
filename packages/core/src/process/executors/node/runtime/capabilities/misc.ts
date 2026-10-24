import { CapabilityHandler } from './types';

/*
 * What a guest's process.memoryUsage(), process.cpuUsage() and process.resourceUsage() are measured
 * against: the host process the container runs inside. A container process has no rss of its own to
 * report, no cpu time the kernel charges to it, and no page faults of its own -- the memory it holds
 * and the time it burns are the host process's, so those are the figures it is given.
 *
 * A host that has no process to ask -- a browser worker, where there is no `process` -- gets the
 * account that host can give: the heap this engine stands on, and the time the container has been
 * up, which is the whole of the cpu account a wall clock keeps. The guest adds its own heap figures
 * on top and keeps this only for what it cannot see for itself.
 */

interface ProcessAccount {
    memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
    cpuUsage(): { user: number; system: number };
    resourceUsage(): Record<string, number>;
}

/** The host's own process, when the container runs on one. */
const HOST_PROCESS: ProcessAccount | undefined = (() => {
    const candidate = (globalThis as { process?: unknown }).process;
    if (candidate === null || typeof candidate !== 'object') return undefined;
    const found = candidate as Partial<ProcessAccount>;
    if (typeof found.memoryUsage !== 'function' || typeof found.cpuUsage !== 'function') return undefined;
    return found as ProcessAccount;
})();

/** The resident set and external memory this engine stands on, for a host that reports neither. */
const BASE_MEMORY = { rss: 33554432, heapTotal: 8388608, heapUsed: 4194304, external: 1048576, arrayBuffers: 65536 };

/**
 * Microseconds since this module loaded, which is the cpu account a host without a process API can
 * give: the container's own uptime, all of it charged to user time.
 */
const startedAt: number = (() => {
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    return typeof perf === 'object' && perf !== null && typeof perf.now === 'function' ? perf.now() : Date.now();
})();

function wallMicros(): number {
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    const now = typeof perf === 'object' && perf !== null && typeof perf.now === 'function' ? perf.now() : Date.now();
    return Math.round((now - startedAt) * 1000);
}

/** Figures a host may answer with a NaN or an object where a count belongs, so every one is checked. */
function countOf(value: unknown, fallback: number): number {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function memoryUsage() {
    if (HOST_PROCESS === undefined) return BASE_MEMORY;
    try {
        const memory = HOST_PROCESS.memoryUsage();
        return {
            rss: countOf(memory.rss, BASE_MEMORY.rss),
            heapTotal: countOf(memory.heapTotal, BASE_MEMORY.heapTotal),
            heapUsed: countOf(memory.heapUsed, BASE_MEMORY.heapUsed),
            external: countOf(memory.external, BASE_MEMORY.external),
            arrayBuffers: countOf(memory.arrayBuffers, BASE_MEMORY.arrayBuffers)
        };
    } catch {
        return BASE_MEMORY;
    }
}

function cpuUsage() {
    if (HOST_PROCESS === undefined) return { user: wallMicros(), system: 0 };
    try {
        const cpu = HOST_PROCESS.cpuUsage();
        return { user: countOf(cpu.user, wallMicros()), system: countOf(cpu.system, 0) };
    } catch {
        return { user: wallMicros(), system: 0 };
    }
}

function resourceUsage(): Record<string, number> {
    if (HOST_PROCESS === undefined || typeof HOST_PROCESS.resourceUsage !== 'function') return {};
    try {
        const usage = HOST_PROCESS.resourceUsage();
        const out: Record<string, number> = {};
        const names = ['userCPUTime', 'systemCPUTime', 'maxRSS', 'sharedMemorySize', 'unsharedDataSize',
            'unsharedStackSize', 'minorPageFault', 'majorPageFault', 'swappedOut', 'fsRead', 'fsWrite',
            'ipcSent', 'ipcReceived', 'signalsCount', 'voluntaryContextSwitches', 'involuntaryContextSwitches'];
        for (const name of names) out[name] = countOf(usage[name], 0);
        return out;
    } catch {
        return {};
    }
}

export const MISC_CAPABILITIES: Record<string, CapabilityHandler> = {
    /**
     * The one call behind process.memoryUsage(), process.cpuUsage() and process.resourceUsage():
     * the host's own account, read once, so the three agree with each other.
     */
    'resource.usage': () => ({ memory: memoryUsage(), cpu: cpuUsage(), resource: resourceUsage() })
};
