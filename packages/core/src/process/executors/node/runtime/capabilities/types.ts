import { IFileSystem } from '../../../../../filesystem';
import type { QuickJSAsyncWASMModule } from 'quickjs-emscripten';
import { NodeResolver } from '../resolver';
import { RuntimeServices } from '../services';

/** Everything a capability handler may touch: the calling guest process and container services. */
export interface CapabilityContext {
    pid: number;
    cwd(): string;
    env(): Record<string, string>;
    fileSystem: IFileSystem;
    resolver: NodeResolver;
    services: RuntimeServices;
    /** Queues an event for a guest target; it runs as a macrotask, never inside the current call. */
    deliver(targetId: number, name: string, payload: unknown): void;
    /**
     * Queues an event that carries bytes. The bytes cross the guest bridge as an ArrayBuffer and
     * `meta`, when given, carries the rest of the event as JSON. Everything payload-heavy takes
     * this route: a base64 string inside JSON costs a codec round trip per byte at both ends.
     */
    deliverBytes(targetId: number, name: string, bytes: Uint8Array, meta?: unknown): void;
    /** Keep-alive accounting: a positive hold keeps the process alive until released. */
    holdRef(delta: number): void;
    /** Writes to this process's own output (for example stdio inherited from a child process). */
    output(message: { stdout?: string; stderr?: string }): void;
    /**
     * The QuickJS module this process booted on, while its guest is alive.
     *
     * A synchronous child boots on it: such a child runs to completion inside the capability call
     * that spawned it and cannot await a load of its own. It is read at the moment of the call and
     * travels no further, so nothing holds a module -- a WebAssembly instance of about 30 MB of host
     * external memory -- after the process that loaded it is gone.
     */
    quickJs(): QuickJSAsyncWASMModule | undefined;
}

/**
 * A sync capability returns its value; an async one returns a promise of it.
 *
 * `bytes` is the binary channel: a capability reached through it ({@link invokeSyncBytes}) gets the
 * caller's payload as a `Uint8Array` instead of as base64 text inside `args`, so no codec runs on
 * either side. Capabilities that have no payload never read it.
 */
export type CapabilityHandler = (args: any, context: CapabilityContext, bytes?: Uint8Array) => unknown | Promise<unknown>;

export type CapabilityEnvelope =
    | { ok: true; value: unknown }
    | { ok: false; code: string; message: string; errno?: number; syscall?: string; props?: Record<string, unknown> };
