import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten';
import { CapabilityContext, CapabilityHandler } from './types';

/**
 * Host half of the vm `timeout` option, and of the preemption that stops a runaway guest.
 *
 * The guest hands the evaluation over as a thunk (api.vmThunk) and calls vm.run with the timeout.
 * The host arms the deadline, runs the thunk, and disarms the deadline before returning, so no guest
 * code runs between arming and the thunk. QuickJS delivers an interrupt as an uncatchable
 * InternalError: guest catch and finally blocks are skipped, so the interruption is caught here, at
 * the host call boundary, and reported as a value.
 *
 * The same handler is what makes a runaway guest stoppable at all. A guest loop blocks the host
 * thread, so no host timer -- the runner's own timeoutMs included -- can fire while it runs; the
 * only code that still runs is this handler, called by QuickJS from inside its interpreter loop.
 * It therefore carries the run's budget itself: a stretch of guest execution that neither called
 * the host nor let the host back in for longer than the budget is interrupted, the way Node's `vm`
 * timeout interrupts a script.
 */

interface VmHost {
    context: QuickJSContext;
    /** The guest bootstrap API object; vm.run reads the thunk from its `vmThunk` slot. */
    api: QuickJSHandle;
    /** Armed deadline in epoch milliseconds; 0 while nothing is armed. */
    deadline: number;
    /** Set by the interrupt handler when it interrupts; read by vm.run. */
    fired: boolean;
    /** Set by a kill path: every later interrupt check stops the guest. */
    cancelled: boolean;
    /** Milliseconds of guest execution with no host call in between; 0 leaves the budget disarmed. */
    budgetMs: number;
    /** Start of the stretch of guest execution now running, 0 when none is. */
    sliceStart: number;
    /** Time of the previous interrupt check; the gap to this one is what a yield looks like. */
    lastCheck: number;
    /** Why the handler last interrupted; cleared when the host reads it. */
    reason?: VmInterruption;
}

/** Why the guest was stopped. `vm` is an armed vm.run deadline; the other two are preemption. */
export type VmInterruption = 'vm' | 'cancel' | 'budget';

/**
 * A gap between two interrupt checks longer than this ends the stretch the budget bounds even with
 * no host call in it: the guest awaited something, idled, or the host stepped the event loop.
 */
const YIELD_MS = 250;

const hosts = new WeakMap<CapabilityContext, VmHost>();

/**
 * Installs the interrupt handler on a runtime and binds it to the owning process. Call once per
 * runtime, after the bootstrap has produced its API object. With nothing armed the handler does one
 * comparison per interrupt check.
 */
export function bindVmRuntime(owner: CapabilityContext, runtime: QuickJSRuntime, context: QuickJSContext, api: QuickJSHandle): void {
    const host: VmHost = {
        context,
        api,
        deadline: 0,
        fired: false,
        cancelled: false,
        budgetMs: 0,
        sliceStart: 0,
        lastCheck: 0
    };
    hosts.set(owner, host);
    runtime.setInterruptHandler(() => {
        const now = Date.now();
        if (host.cancelled) {
            host.reason = 'cancel';
            return true;
        }
        if (host.deadline !== 0 && now >= host.deadline) {
            host.fired = true;
            host.reason = 'vm';
            return true;
        }
        if (host.budgetMs > 0) {
            if (host.sliceStart === 0 || host.lastCheck === 0 || now - host.lastCheck > YIELD_MS) {
                host.sliceStart = now;
            }
            host.lastCheck = now;
            if (now - host.sliceStart >= host.budgetMs) {
                host.fired = true;
                host.reason = 'budget';
                return true;
            }
        }
        return false;
    });
}

/**
 * Arms the runaway guard for a process: guest execution that runs longer than `ms` without calling
 * the host is interrupted. 0 disarms it. Called once per runtime, after bindVmRuntime.
 */
export function armVmBudget(owner: CapabilityContext, ms: number): void {
    const host = hosts.get(owner);
    if (!host) return;
    host.budgetMs = ms > 0 ? ms : 0;
    host.sliceStart = 0;
    host.lastCheck = 0;
}

/** A kill path: the guest stops at its next interrupt check, whatever it is doing. */
export function cancelVmRuntime(owner: CapabilityContext): void {
    const host = hosts.get(owner);
    if (host) host.cancelled = true;
}

/**
 * The guest gave the host back control -- a host call, an await, a step of the event loop -- so the
 * stretch the budget bounds starts again. Without this a program that works in short bursts towards
 * the host would be charged for the whole run and stopped mid-way through it.
 */
export function yieldVmSlice(owner: CapabilityContext): void {
    const host = hosts.get(owner);
    if (!host) return;
    host.sliceStart = 0;
    host.lastCheck = 0;
}

/** Reads and clears why the guest was interrupted, so one interruption is reported once. */
export function takeVmInterruption(owner: CapabilityContext): VmInterruption | undefined {
    const host = hosts.get(owner);
    if (!host) return undefined;
    const reason = host.reason;
    host.reason = undefined;
    return reason;
}

function describeError(error: unknown): string {
    if (error !== null && typeof error === 'object' && 'message' in error) {
        return String((error as { message: unknown }).message);
    }
    return String(error);
}

export const VM_CAPABILITIES: Record<string, CapabilityHandler> = {
    /**
     * Runs the guest thunk (api.vmThunk) synchronously under a deadline `timeout` ms from now, never
     * later than an enclosing one. An interruption returns { interrupted: true }; { unbound: true }
     * means no runtime is bound and nothing ran.
     */
    'vm.run': (args, ctx) => {
        const host = hosts.get(ctx);
        if (!host) return { unbound: true };
        const { context } = host;
        const thunk = context.getProp(host.api, 'vmThunk');
        const outer = host.deadline;
        const limit = Date.now() + Number(args.timeout);
        host.deadline = outer === 0 ? limit : Math.min(outer, limit);
        try {
            host.fired = false;
            const result = context.callFunction(thunk, context.undefined);
            if (result.error) {
                const error = context.dump(result.error);
                result.error.dispose();
                return host.fired ? { interrupted: true } : { interrupted: false, error: describeError(error) };
            }
            result.value.dispose();
            return { interrupted: false };
        } finally {
            host.deadline = outer;
            /* the deadline owns this window: whether it or the budget stopped the guest, process.ts
               must not read the reason as its own later */
            host.reason = undefined;
            thunk.dispose();
        }
    }
};
