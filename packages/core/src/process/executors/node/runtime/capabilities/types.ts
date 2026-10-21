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

/** A sync capability returns its value; an async one returns a promise of it. */
export type CapabilityHandler = (args: any, context: CapabilityContext) => unknown | Promise<unknown>;

export type CapabilityEnvelope =
    | { ok: true; value: unknown }
    | { ok: false; code: string; message: string; errno?: number; syscall?: string; props?: Record<string, unknown> };
