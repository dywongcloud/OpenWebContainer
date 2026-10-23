/**
 * In-container virtual network: loopback TCP and UDP between the processes of one container,
 * plus host-originated connections (the HTTP preview path).
 *
 * Nothing leaves the browser. A connect or send to an address that is not local to the
 * container fails (ENETUNREACH) or is dropped, as UDP is. "Local" means the loopback range
 * (127.0.0.0/8, ::1, localhost), the wildcard, and any address registered with registerHost.
 * Names resolve through that table first; the guest falls back to dns.lookup for any other name.
 *
 * Deliveries into guests are scheduled as macrotasks, so a guest is never re-entered from
 * inside its own host call.
 */
/// <reference lib="es2021.weakref" />

/** Receives events for one owner (a guest process, or the host itself). */
export interface VirtualSink {
    deliver(targetId: number, name: string, payload: unknown): void;
    /**
     * An event whose payload is bytes. The bytes reach the guest as an ArrayBuffer, with `meta` — when
     * it is not undefined — as the JSON for the rest of the event, so a chunk of a TCP stream or a
     * UDP datagram crosses the bridge without a base64 round trip at either end.
     */
    deliverBytes?(targetId: number, name: string, bytes: Uint8Array, meta?: unknown): void;
    holdRef(delta: number): void;
}

export interface VirtualNetworkDeps {
    sinkFor(pid: number): VirtualSink | undefined;
}

export type VirtualProtocol = 'tcp' | 'udp';
export type VirtualFamily = 'IPv4' | 'IPv6';

/** Owner pid for connections and sockets created by the host (preview requests). */
export const HOST_PID = 0;

const WILDCARD_ADDRESSES = new Set(['', '0.0.0.0', '::']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

interface Endpoint {
    ownerPid: number;
    address: string;
    port: number;
    targetId?: number;
    pending: Array<{ name: string; payload: unknown; bytes?: Uint8Array }>;
}

interface Listener {
    id: number;
    ownerPid: number;
    protocol: VirtualProtocol;
    family: VirtualFamily;
    address: string;
    port: number;
    targetId: number;
}

interface Connection {
    id: number;
    local: Endpoint;
    remote?: Connection;
    closed: boolean;
    /** This side has sent its end-of-stream (half-close). */
    writeEnded: boolean;
    /** Server side: the listener that accepted it. */
    listenerId?: number;
    /** Server side: its 'connection' event is not delivered yet, so its owner may still attach it. */
    offerPending?: boolean;
    /** Client side: its 'connect' event is not delivered yet, so the peer has not been established. */
    connectPending?: boolean;
    /**
     * Server side of a host-owned listener, left unattached by its 'connection' delivery: the host may
     * attach it later, for as long as it keeps that event's payload.
     */
    claimable?: boolean;
}

export interface ListenRequest {
    ownerPid: number;
    protocol: VirtualProtocol;
    address?: string;
    port: number;
    targetId: number;
    family?: VirtualFamily;
}

export interface ListenResult {
    id: number;
    address: string;
    port: number;
}

export interface ConnectRequest {
    ownerPid: number;
    address: string;
    port: number;
    targetId: number;
    localPort?: number;
}

export interface ConnectResult {
    id: number;
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
}

export class VirtualNetworkError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'Error';
    }
}

/** One end of a connection, as `ifconfig` prints it. */
function endpointText(endpoint: Endpoint): string {
    return `${displayAddress(endpoint.address)}:${endpoint.port}`;
}

/** What the hub is carrying at one instant: its bindings, its connections and its name table. */
export interface HubState {
    /** Every address a binding or a connection holds, deduplicated and sorted. */
    addresses: string[];
    /** The TCP listeners and UDP sockets the hub holds, in the order it took them. */
    listeners: { protocol: VirtualProtocol; address: string; port: number }[];
    /** The connections that are open, each as its two ends. */
    connections: { local: string; remote: string }[];
    /** The names `registerHost` gave it. */
    hosts: { name: string; address: string }[];
}

export class VirtualNetwork {
    private listeners = new Map<number, Listener>();
    private udpSockets = new Map<number, Listener>();
    private connections = new Map<number, Connection>();
    private hosts = new Map<string, string>();
    private hostSink?: VirtualSink;
    private nextId = 1;
    private nextEphemeralPort = 49152;
    /** Releases a claimable connection once the 'connection' payload the host was given is collected. */
    private readonly unclaimed = new FinalizationRegistry<number>((id) => this.release(id));

    constructor(private deps: VirtualNetworkDeps) { }

    /** Sink for host-originated owners (HOST_PID). */
    setHostSink(sink: VirtualSink): void {
        this.hostSink = sink;
    }

    registerHost(name: string, address: string): void {
        this.hosts.set(name.toLowerCase(), address);
    }

    /** Virtual name table lookup; loopback names always resolve to 127.0.0.1 (or ::1). */
    resolveHost(name: string): string | undefined {
        const key = name.toLowerCase();
        if (LOOPBACK_NAMES.has(key)) return key === '::1' ? '::1' : '127.0.0.1';
        return this.hosts.get(key);
    }

    /**
     * Binds a TCP listener or UDP socket. Port 0 allocates an ephemeral port.
     * Throws EADDRINUSE when an overlapping binding exists, EADDRNOTAVAIL for a non-local address.
     */
    listen(request: ListenRequest): ListenResult {
        const protocol = request.protocol;
        const address = this.hubAddress(request.address);
        /* A caller that names no family is binding by address, so the family follows the address:
           '::1' is an IPv6 bind. Both wildcards fold to '', so the family is read from the address
           the caller named, before the fold: a bind on '::' is dual-stack and takes an IPv4 client,
           where one on '0.0.0.0' takes none. (net.listen passes no family; dgram's does.) */
        const family = request.family ?? hubFamilyOf(request.address ?? '');
        if (!this.isLocal(address)) {
            throw new VirtualNetworkError('EADDRNOTAVAIL', `address not available ${displayAddress(address)}`);
        }
        const port = request.port || this.allocatePort(protocol, family, address);
        if (this.conflicts(protocol, family, address, port)) {
            throw new VirtualNetworkError('EADDRINUSE', `address already in use ${displayAddress(address)}:${port}`);
        }
        const id = this.nextId++;
        const table = protocol === 'tcp' ? this.listeners : this.udpSockets;
        table.set(id, { id, ownerPid: request.ownerPid, protocol, family, address, port, targetId: request.targetId });
        return { id, address: displayAddress(address), port };
    }

    /**
     * Closes a listener. The connections it accepted that are not attached yet are destroyed, so their
     * peers get end and close (Node resets a closing listener's backlog instead).
     */
    closeListener(id: number): void {
        this.listeners.delete(id);
        for (const connection of [...this.connections.values()]) {
            if (connection.listenerId === id && connection.local.targetId === undefined) this.destroy(connection.id);
        }
    }

    closeUdp(id: number): void {
        this.udpSockets.delete(id);
    }

    /** Opens a loopback TCP connection to a listener; both ends receive their events asynchronously. */
    connect(request: ConnectRequest): ConnectResult {
        const destination = this.hubDestination(request.address);
        if (!this.isLocal(destination)) {
            throw new VirtualNetworkError('ENETUNREACH', `connect ENETUNREACH ${destination}:${request.port}`);
        }
        /* The family of a connection is the family it was dialled in: a client that reaches '::1' is an
           IPv6 socket with '::1' as its own address, and the peer it lands on sees '::1' too. */
        const family = hubFamilyOf(destination);
        const localAddress = family === 'IPv6' ? '::1' : '127.0.0.1';
        const listener = this.findEndpoint('tcp', family, destination, request.port);
        /* Port 0 is not a destination, so a connect to it never reaches a listener: the kernel
           refuses it against the address alone (EADDRNOTAVAIL) rather than reporting a peer that
           declined (ECONNREFUSED), which is what Node on a dual-stack host shows for it. */
        if (!listener) {
            throw new VirtualNetworkError(request.port === 0 ? 'EADDRNOTAVAIL' : 'ECONNREFUSED',
                `connect ${request.port === 0 ? 'EADDRNOTAVAIL' : 'ECONNREFUSED'} ${destination}:${request.port}`);
        }
        const localPort = request.localPort || this.allocatePort('tcp', family, localAddress);
        const client: Connection = {
            id: this.nextId++,
            local: { ownerPid: request.ownerPid, address: localAddress, port: localPort, targetId: request.targetId, pending: [] },
            closed: false,
            writeEnded: false,
            connectPending: true,
        };
        const server: Connection = {
            id: this.nextId++,
            local: { ownerPid: listener.ownerPid, address: listener.address, port: listener.port, pending: [] },
            closed: false,
            writeEnded: false,
            listenerId: listener.id,
            offerPending: true,
        };
        client.remote = server;
        server.remote = client;
        this.connections.set(client.id, client);
        this.connections.set(server.id, server);
        // The client's 'connect' is delivered before the server's 'connection', the order Node shows on loopback.
        this.schedule(request.ownerPid, request.targetId, 'connect', { connectionId: client.id }, undefined, () => {
            /* Only a client still there to receive it was ever connected: one destroyed before this
               abandoned the attempt, and its listener must not hear of it. */
            if (this.connections.get(client.id) === client) client.connectPending = false;
        });
        /* A wildcard listener accepts on the address the client dialled, so an IPv6 client is accepted
           on '::1' where an IPv4 one is accepted on 127.0.0.1, as a dual-stack host reports it. The
           IPv6 wildcard '::' is dual-stack, so its IPv4 client is accepted on the v4-mapped
           '::ffff:127.0.0.1' -- that is the address the host's accepted socket reports for the
           connection, on both of its ends. */
        const acceptedAddress = listener.address === ''
            ? (listener.family === 'IPv6' && family === 'IPv4' ? '::ffff:' + localAddress : localAddress)
            : listener.address;
        this.offer(server, listener, {
            connectionId: server.id,
            localAddress: displayAddress(acceptedAddress),
            localPort: listener.port,
            remoteAddress: displayAddress(acceptedAddress),
            remotePort: localPort,
        });
        return {
            id: client.id,
            localAddress,
            localPort,
            remoteAddress: displayAddress(destination),
            remotePort: request.port,
        };
    }

    /**
     * Binds a server-side connection to the guest target that will receive its events.
     *
     * Returns false when there is no such connection. That is the host's case: a host that kept only
     * the id of its 'connection' payload lets the connection be released, and one closed since then is
     * removed with whatever its peer had queued for it, so the data a late attach would have delivered
     * is gone. Reporting it is the difference between that and losing the bytes without a word.
     */
    attach(connectionId: number, targetId: number): boolean {
        const connection = this.connections.get(connectionId);
        if (!connection) return false;
        connection.local.targetId = targetId;
        const queued = connection.local.pending.splice(0);
        for (const event of queued) {
            this.schedule(connection.local.ownerPid, targetId, event.name, event.payload, undefined, undefined, event.bytes);
        }
        // A side closed before it was attached was kept only to deliver its queued end and close.
        if (connection.closed) this.connections.delete(connection.id);
        return true;
    }

    /**
     * Writes bytes to the peer of a connection. The bytes are held, not copied: the caller must not
     * reuse the buffer. False once the connection is gone or this side ended it.
     */
    write(connectionId: number, data: Uint8Array): boolean {
        const connection = this.connections.get(connectionId);
        if (!connection || connection.closed || connection.writeEnded || !connection.remote) return false;
        this.emitToPeer(connection, 'data', undefined, data);
        return true;
    }

    /** Half-close: the peer receives 'end'. The connection is removed when either side destroys it. */
    end(connectionId: number): void {
        const connection = this.connections.get(connectionId);
        if (!connection || connection.closed || connection.writeEnded) return;
        connection.writeEnded = true;
        this.emitToPeer(connection, 'end', undefined);
    }

    /**
     * Closes both ends. The peer gets EOF first (unless it already has it), then 'close', unless this
     * side still holds unread data: that is the reset Node sends, so the peer gets 'reset' (an
     * ECONNRESET error) and 'close' with no EOF at all. A peer that may still be attached (its
     * 'connection' event is not delivered yet, or it is claimable) keeps its record, with those events
     * queued, for that attach; its owner can still destroy it, which only removes it.
     */
    destroy(connectionId: number, options?: { unread?: boolean }): void {
        const connection = this.connections.get(connectionId);
        if (!connection) return;
        this.connections.delete(connection.id);
        if (connection.closed) return;
        connection.closed = true;
        const peer = connection.remote;
        if (peer && !peer.closed) {
            peer.closed = true;
            if (options?.unread) {
                this.emitToPeer(connection, 'reset', { code: 'ECONNRESET' });
            } else if (!connection.writeEnded) {
                this.emitToPeer(connection, 'end', undefined);
            }
            if (peer.local.targetId !== undefined || !(peer.offerPending || peer.claimable)) this.connections.delete(peer.id);
            this.schedule(peer.local.ownerPid, peer.local.targetId, 'close', undefined, peer.local);
        }
        this.schedule(connection.local.ownerPid, connection.local.targetId, 'close', undefined, connection.local);
    }

    /** Binds a UDP socket to an address and port (port 0 allocates an ephemeral port). */
    bindUdp(request: ListenRequest): ListenResult {
        return this.listen({ ...request, protocol: 'udp' });
    }

    /**
     * Sends a datagram to a bound UDP socket of the same family. Undeliverable datagrams are
     * dropped, as UDP does; the return value says whether a receiver existed.
     */
    sendUdp(options: { socketId: number; address: string; port: number; data: Uint8Array }): boolean {
        const socket = this.udpSockets.get(options.socketId);
        if (!socket) return false;
        const destination = this.hubDestination(options.address);
        if (!this.isLocal(destination)) return false;
        const receiver = this.findEndpoint('udp', socket.family, destination, options.port);
        if (!receiver) return false;
        this.schedule(receiver.ownerPid, receiver.targetId, 'message', {
            address: socket.family === 'IPv6' ? '::1' : '127.0.0.1',
            port: socket.port,
        }, undefined, undefined, options.data);
        return true;
    }

    /** Owner pid of a listener, UDP socket or connection; undefined once it is gone. */
    ownerOfListener(id: number): number | undefined {
        return this.listeners.get(id)?.ownerPid;
    }

    ownerOfUdp(id: number): number | undefined {
        return this.udpSockets.get(id)?.ownerPid;
    }

    ownerOfConnection(id: number): number | undefined {
        return this.connections.get(id)?.local.ownerPid;
    }

    /** Tears down everything a process owns (call when it exits): listeners, UDP sockets and connections. */
    releaseOwner(pid: number): void {
        for (const listener of [...this.listeners.values()]) {
            if (listener.ownerPid === pid) this.listeners.delete(listener.id);
        }
        for (const socket of [...this.udpSockets.values()]) {
            if (socket.ownerPid === pid) this.udpSockets.delete(socket.id);
        }
        for (const connection of [...this.connections.values()]) {
            if (connection.local.ownerPid === pid) this.destroy(connection.id);
        }
    }

    /** Resolves an endpoint's pid to its sink (or the host sink for HOST_PID). */
    /**
     * The hub as `ifconfig` reads it: the bindings, the connections and the names it holds at this
     * instant, in the order it took them. Nothing here is counted, averaged or remembered -- these
     * are the tables themselves, so a number read from this is a number the hub really holds.
     */
    hubState(): HubState {
        const addresses = new Set<string>();
        const bindings = [...this.listeners.values(), ...this.udpSockets.values()].sort((a, b) => a.id - b.id);
        const listeners = bindings.map((entry) => {
            const address = displayAddress(entry.address);
            addresses.add(address);
            return { protocol: entry.protocol, address, port: entry.port };
        });
        const connections = [...this.connections.values()]
            .filter((connection) => connection.remote !== undefined && !connection.closed)
            .sort((a, b) => a.id - b.id)
            .map((connection) => {
                const peer = connection.remote as Connection;
                addresses.add(displayAddress(connection.local.address));
                addresses.add(displayAddress(peer.local.address));
                return { local: endpointText(connection.local), remote: endpointText(peer.local) };
            });
        const hosts = [...this.hosts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, address]) => ({ name, address }));
        return { addresses: [...addresses].sort(), listeners, connections, hosts };
    }

    private sinkOf(pid: number): VirtualSink | undefined {
        return pid === HOST_PID ? this.hostSink : this.deps.sinkFor(pid);
    }

    private emitToPeer(connection: Connection, name: string, payload: unknown, bytes?: Uint8Array): void {
        const peer = connection.remote;
        if (!peer) return;
        if (peer.local.targetId === undefined) {
            peer.local.pending.push({ name, payload, bytes });
            return;
        }
        this.schedule(peer.local.ownerPid, peer.local.targetId, name, payload, undefined, undefined, bytes);
    }

    private schedule(pid: number, targetId: number | undefined, name: string, payload: unknown, endpoint?: Endpoint, onDelivered?: () => void, bytes?: Uint8Array): void {
        if (targetId === undefined) {
            if (endpoint) endpoint.pending.push({ name, payload, bytes });
            return;
        }
        setTimeout(() => {
            onDelivered?.();
            const sink = this.sinkOf(pid);
            if (bytes !== undefined && sink?.deliverBytes) sink.deliverBytes(targetId, name, bytes, payload);
            else sink?.deliver(targetId, name, payload);
        }, 0);
    }

    /**
     * Delivers 'connection' for a server-side connection. One removed before then (its listener closed,
     * its owner exited) is not announced. A guest attaches during that delivery or not at all, so a
     * guest-owned one still unattached and already closed afterwards is removed. The host may attach
     * later, as a Node server may resume a paused socket: a host-owned one stays claimable, its events
     * queued, until the host drops the event's payload.
     */
    private offer(server: Connection, listener: Listener, payload: object): void {
        setTimeout(() => {
            if (this.connections.get(server.id) !== server) return;
            /* A client that destroyed the connection before its 'connect' was delivered never
               completed it, so Node's listener does not see a socket: drop it unannounced. */
            if (server.closed && server.remote?.connectPending !== false) {
                this.connections.delete(server.id);
                return;
            }
            this.sinkOf(listener.ownerPid)?.deliver(listener.targetId, 'connection', payload);
            server.offerPending = false;
            if (server.local.targetId !== undefined) return;
            if (listener.ownerPid === HOST_PID) {
                server.claimable = true;
                this.unclaimed.register(payload, server.id);
            } else if (server.closed) {
                this.connections.delete(server.id);
            }
        }, 0);
    }

    /**
     * The host no longer holds the 'connection' payload of a claimable connection, so it cannot attach
     * it any more. A closed one is removed with its queued events; an open one stays until either side
     * closes it, like a socket nobody reads.
     */
    private release(id: number): void {
        const connection = this.connections.get(id);
        if (connection === undefined || connection.local.targetId !== undefined) return;
        connection.claimable = false;
        if (connection.closed) this.connections.delete(id);
    }

    /** The bound endpoint that receives traffic for (address, port): exact address first, then wildcard. */
    private findEndpoint(protocol: VirtualProtocol, family: VirtualFamily, address: string, port: number): Listener | undefined {
        const table = protocol === 'tcp' ? this.listeners : this.udpSockets;
        let wildcard: Listener | undefined;
        for (const candidate of table.values()) {
            if (candidate.port !== port) continue;
            if (protocol === 'udp') {
                if (candidate.family !== family) continue;
            } else if (candidate.address === '' && !wildcardTakes(candidate, family)) {
                continue;
            }
            if (candidate.address === address) return candidate;
            if (candidate.address === '') wildcard = candidate;
        }
        return wildcard;
    }

    /** True when a new binding on (address, port) overlaps an existing one; a wildcard overlaps everything. */
    private conflicts(protocol: VirtualProtocol, family: VirtualFamily, address: string, port: number): boolean {
        const table = protocol === 'tcp' ? this.listeners : this.udpSockets;
        for (const other of table.values()) {
            if (other.port !== port) continue;
            if (protocol === 'udp') {
                if (other.family !== family) continue;
                if (other.address === address || other.address === '' || address === '') return true;
            } else if (other.address === address) {
                // TCP: an exact duplicate conflicts; a wildcard and a specific address coexist (macOS, verified against Node 24).
                return true;
            }
        }
        return false;
    }

    private allocatePort(protocol: VirtualProtocol, family: VirtualFamily, address: string): number {
        for (let attempt = 0; attempt < 16384; attempt++) {
            const port = this.nextEphemeralPort++;
            if (this.nextEphemeralPort > 65535) this.nextEphemeralPort = 49152;
            if (!this.conflicts(protocol, family, address, port)) return port;
        }
        throw new VirtualNetworkError('EADDRINUSE', 'no free ephemeral ports');
    }

    /** True for the wildcard, loopback (both families), and any address registered in the name table. */
    private isLocal(address: string): boolean {
        if (address === '' || address === '127.0.0.1' || address === '::1' || address.startsWith('127.')) return true;
        for (const registered of this.hosts.values()) {
            if (this.hubAddress(registered) === address) return true;
        }
        return false;
    }

    /** Normalises a bind address: names go through the name table, wildcards become '', and each
        loopback keeps its own family -- '::1' stays '::1', the rest of the loopback folds to 127.0.0.1. */
    private hubAddress(address: string | undefined): string {
        if (address === undefined) return '';
        const key = address.toLowerCase();
        if (WILDCARD_ADDRESSES.has(key)) return '';
        const mapped = (this.hosts.get(key) ?? address).toLowerCase();
        if (WILDCARD_ADDRESSES.has(mapped)) return '';
        /* 'localhost' is the loopback of this host's own choosing and stays IPv4, as Node's own
           lookup reports it here; '::1' names the IPv6 loopback and must survive as one. */
        if (mapped !== '::1' && LOOPBACK_NAMES.has(mapped)) return '127.0.0.1';
        return mapped;
    }

    /** Destination for connect and send: the wildcard means the local host. */
    private hubDestination(address: string | undefined): string {
        const resolved = this.hubAddress(address);
        return resolved === '' ? '127.0.0.1' : resolved;
    }
}

function displayAddress(address: string): string {
    return address === '' ? '0.0.0.0' : address;
}

/**
 * True when a TCP wildcard binding takes a connection of this family: '::' is dual-stack and takes an
 * IPv4 client as well as an IPv6 one, where '0.0.0.0' takes no IPv6 client -- a host binds the IPv6
 * wildcard without IPV6_V6ONLY, and the IPv4 wildcard has no IPv6 address to answer on.
 */
function wildcardTakes(candidate: Listener, family: VirtualFamily): boolean {
    return candidate.family === family || (candidate.family === 'IPv6' && family === 'IPv4');
}

/** The family an address belongs to. The wildcard is IPv4 (it is the address displayed as 0.0.0.0);
    every other IPv6 text, the loopback '::1' included, is IPv6. */
function hubFamilyOf(address: string): VirtualFamily {
    return address.includes(':') ? 'IPv6' : 'IPv4';
}
