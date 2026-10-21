import { CAPABILITIES } from './index';
import { CapabilityContext, CapabilityEnvelope } from './types';

/**
 * Turns any thrown value into the envelope the guest turns back into an Error. Extra own
 * enumerable properties (for example hostname or address) travel as JSON in `props`.
 */
export function errorEnvelope(error: unknown): CapabilityEnvelope {
    const err = error as { code?: unknown; message?: unknown; errno?: unknown; syscall?: unknown } | undefined;
    const standard = new Set(['code', 'message', 'errno', 'syscall', 'stack', 'name']);
    let props: Record<string, unknown> | undefined;
    if (typeof error === 'object' && error !== null) {
        const extra: Record<string, unknown> = {};
        for (const key of Object.keys(error)) {
            if (standard.has(key)) continue;
            const value = (error as Record<string, unknown>)[key];
            if (value === undefined || typeof value === 'function') continue;
            try {
                extra[key] = JSON.parse(JSON.stringify(value));
            } catch {
                // values that cannot be serialized are dropped, as the envelope is JSON
            }
        }
        if (Object.keys(extra).length > 0) props = extra;
    }
    return {
        ok: false,
        code: typeof err?.code === 'string' ? err.code : 'ERR_CAPABILITY',
        message: typeof err?.message === 'string' ? err.message : String(error),
        errno: typeof err?.errno === 'number' ? err.errno : undefined,
        syscall: typeof err?.syscall === 'string' ? err.syscall : undefined,
        props
    };
}

/**
 * A value that is a promise only when the work it stands for could not be answered now: a
 * synchronous capability that has to wait on the host returns one, so the guest can suspend
 * instead of refusing.
 */
export type MaybeAsync<T> = T | Promise<T>;

function handlerFor(op: string) {
    const handler = CAPABILITIES[op];
    if (!handler) {
        return undefined;
    }
    return handler;
}

/** Runs a synchronous capability. Returns an envelope; never throws into the guest. */
export function invokeSync(op: string, argsJson: string, context: CapabilityContext): CapabilityEnvelope {
    return invokeWith(op, argsJson, context, undefined);
}

/**
 * Runs a synchronous capability reached through the binary channel: `bytes` is the caller's payload,
 * handed over as a Uint8Array instead of as base64 text inside the arguments.
 */
export function invokeSyncBytes(op: string, argsJson: string, bytes: Uint8Array, context: CapabilityContext): CapabilityEnvelope {
    return invokeWith(op, argsJson, context, bytes);
}

function invokeWith(op: string, argsJson: string, context: CapabilityContext, bytes: Uint8Array | undefined): CapabilityEnvelope {
    const handler = handlerFor(op);
    if (!handler) return errorEnvelope(Object.assign(new Error(`unknown capability ${op}`), { code: 'ERR_UNKNOWN_CAPABILITY' }));
    try {
        const value = handler(JSON.parse(argsJson), context, bytes);
        if (value instanceof Promise) {
            value.catch(() => undefined);
            return errorEnvelope(Object.assign(new Error(`${op} is asynchronous`), { code: 'ERR_ASYNC_CAPABILITY' }));
        }
        return { ok: true, value: value === undefined ? null : value };
    } catch (error) {
        return errorEnvelope(error);
    }
}

/**
 * Runs a synchronous capability that is allowed to suspend.
 *
 * A handler that returns a promise has work only the host can finish -- `npm install` reaching the
 * registry -- and no way to finish it inside this call. The promise is passed back to the caller
 * unchanged instead of being turned into an error: the guest's synchronous call unwinds on it (see
 * `callFunctionMaybe` in process.ts) and resumes, still inside the same statement, when it settles.
 * Where the caller cannot unwind, `invokeSync` is the route, and the promise stays the refusal it
 * has always been.
 */
export function invokeSyncMaybe(op: string, argsJson: string, context: CapabilityContext): MaybeAsync<CapabilityEnvelope> {
    const handler = CAPABILITIES[op];
    if (!handler) return errorEnvelope(Object.assign(new Error(`unknown capability ${op}`), { code: 'ERR_UNKNOWN_CAPABILITY' }));
    let value: unknown;
    try {
        value = handler(JSON.parse(argsJson), context);
    } catch (error) {
        return errorEnvelope(error);
    }
    if (value instanceof Promise) {
        return value.then(
            (settled) => ({ ok: true, value: settled === undefined ? null : settled }),
            (error) => errorEnvelope(error)
        );
    }
    return { ok: true, value: value === undefined ? null : value };
}

/**
 * Runs an asynchronous capability; `settle` receives exactly one envelope, always on a later
 * macrotask so the guest has registered its pending operation before it can settle.
 */
export function invokeAsync(
    op: string,
    argsJson: string,
    context: CapabilityContext,
    settle: (envelope: CapabilityEnvelope) => void
): void {
    const finish = (envelope: CapabilityEnvelope) => setTimeout(() => settle(envelope), 0);
    const handler = handlerFor(op);
    if (!handler) {
        finish(errorEnvelope(Object.assign(new Error(`unknown capability ${op}`), { code: 'ERR_UNKNOWN_CAPABILITY' })));
        return;
    }
    let outcome: unknown;
    try {
        outcome = handler(JSON.parse(argsJson), context);
    } catch (error) {
        finish(errorEnvelope(error));
        return;
    }
    Promise.resolve(outcome).then(
        (value) => finish({ ok: true, value: value === undefined ? null : value }),
        (error) => finish(errorEnvelope(error))
    );
}
