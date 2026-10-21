import { Process } from '../../../base';
import { VirtualNetwork, VirtualSink } from '../../../../network/virtual/hub';
import type { QuickJSAsyncWASMModule } from 'quickjs-emscripten';

/** Container-level services a guest process may use through capabilities. */
export interface StartProcessRequest {
    parentPid: number;
    executable: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    /** The pid the process must take, already reserved with reservePid (child_process reports a pid at once). */
    pid?: number;
    /** Runs before the process starts, so a caller can listen for every event. */
    beforeStart?: (process: Process) => void;
}

export interface RuntimeServices {
    network: VirtualNetwork;
    /** Starts a container process (child_process, fork, worker_threads, cluster all use this). */
    startProcess(request: StartProcessRequest): Promise<Process>;
    /** Takes the pid the next started process will have, so a caller can report a child's pid at once. */
    reservePid(): number;
    /** Delivery sink for a running guest process, if it is still alive. */
    sinkFor(pid: number): VirtualSink | undefined;
    /**
     * Milliseconds of guest execution with no host call in it before the guest is stopped as a
     * runaway; 0 leaves it unstoppable. Absent means the default.
     */
    guestBudgetMs?: number;
    /**
     * The QuickJS module the last boot loaded: a WebAssembly instance of about 30 MB of host
     * external memory plus the bytes of its binary.
     *
     * Only a synchronous child needs it. Such a child runs to completion inside the capability call
     * that spawned it, so it cannot await a load of its own and boots on the module already loaded.
     * A process that is not one of those loads its own and drops it when the process ends, which is
     * what keeps a module from being held for every process the container has ever run. The container
     * drops this one when it is disposed, so nothing holds a module past the container's own life.
     */
    quickJsModule?: QuickJSAsyncWASMModule;
}
