import { base64ToBytes, bytesToBase64 } from './b64';
import { DEFAULT_TRANSPORT_SETTINGS, MAX_DATAGRAM_SIZE, QuicConnection, QuicStream, describeTransportParameters } from './connection';
import type { TransportSettings } from './connection';
import { Emitter } from './emitter';
import { QuicEndpoint } from './endpoint';
import { createHttp3Api } from './h3-api';
import type { Http3Api } from './h3-api';
import type { DatagramSocket, QuicPlatform } from './platform';
import { QUIC_VERSION_1 } from './protection';
import type { TlsEngine, TlsEngineOptions, TlsSettings } from './tls-types';
import { decodeTransportParameters, encodeTransportParameters } from './transport-params';

/*
 * Guest entry of the QUIC transport. scripts/build-quic-guest.mjs bundles this file and the codecs
 * it reaches into one script, carried by QUIC_SRC (guest/modules/quic.ts), which the guest bootstrap
 * evaluates after the TLS engine. QUIC_SRC defines the bootstrap-scope function OWC_QUIC(): the first
 * call compiles and runs this bundle and returns its exports ({ API, loadHttp3 }); the internal built-in
 * 'owc:internal/quic' returns OWC_QUIC().API and 'owc:internal/http3' returns OWC_QUIC().loadHttp3()
 * (neither is a Node module; Node 24 has no QUIC or HTTP/3 module).
 *
 * It binds the connection layer to the guest: timers, the tls.random and crypto.hmac capabilities,
 * the TLS engine (OWC_TLS13 in QUIC mode), and UDP sockets from the guest's dgram module.
 *
 *   const quic = require('owc:internal/quic');
 *   const server = quic.createServer({ key, cert, alpn: ['h3'] }, (session) => { ... });
 *   server.listen(4433, '127.0.0.1');
 *   const session = quic.connect({ host: '127.0.0.1', port: 4433, servername: 'localhost', ca });
 *   session.on('handshake', (info) => { const stream = session.openStream(); stream.end('hello'); });
 */

declare const callCap: (op: string, args?: unknown) => any;
declare const OWC_TLS13: {
    createEngine(options: TlsEngineOptions & { cap: unknown }): TlsEngine;
    loadPem(input: unknown): { certs: Uint8Array[]; key: unknown };
    parsePem(input: unknown): { label: string; der: Uint8Array }[];
};
declare function requireBuiltin(name: string): any;
declare const Buffer: { from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array; isBuffer(value: unknown): boolean };

const platform: QuicPlatform = {
    now: () => Date.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    defer: (callback) => queueMicrotask(callback),
    randomBytes: (length) => base64ToBytes(callCap('tls.random', { bytes: length }).data as string),
    hmacSha256: (key, data) => base64ToBytes(callCap('crypto.hmac', { algorithm: 'sha256', key: bytesToBase64(key), data: bytesToBase64(data) }) as string),
    createTlsEngine: (options) => OWC_TLS13.createEngine({ ...options, cap: callCap }),
};

function asBuffer(bytes: Uint8Array): Uint8Array {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Node-style argument errors: `code` is the code Node reports for the same mistake, so a program
 * that catches on `error.code` behaves as it would against Node.
 */
function argError(Ctor: ErrorConstructor, code: string, message: string): Error {
    return Object.assign(new Ctor(message), { code });
}

/** Node's rendering of a received value in an error message: `type string ('a')`, `type number (5)`, `an instance of X`. */
function describe(value: unknown): string {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'object') return `an instance of ${((value as { constructor?: { name?: string } }).constructor?.name) ?? 'Object'}`;
    if (typeof value === 'string') return `type string ('${value}')`;
    return `type ${typeof value} (${String(value)})`;
}

function optionsObject(value: unknown, name: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object') {
        throw argError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type object. Received ${describe(value)}`);
    }
    return value as Record<string, unknown>;
}

/**
 * Node's validatePort (internal/validators): an integer in the port range, or a numeric string.
 * allowZero separates a port to bind (0 asks the OS for one) from a port to send to. Checked on the
 * call, because the QUIC layer would only fail when its first datagram goes out, from a timer, where
 * the throw is uncaught and takes the process down.
 */
function portOf(value: unknown, allowZero: boolean, name: string): number {
    const port = typeof value === 'string' && value !== '' ? Number(value) : value;
    const minimum = allowZero ? 0 : 1;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < minimum || port > 65535) {
        throw argError(RangeError, 'ERR_SOCKET_BAD_PORT', `Port should be ${allowZero ? '>= 0' : '> 0'} and < 65536. Received ${describe(value)}.`);
    }
    return port;
}

/** An optional string argument; null counts as absent. */
function stringOf(value: unknown, name: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
        throw argError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type string. Received ${describe(value)}`);
    }
    return value;
}

function alpnOf(value: unknown): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    const list: readonly unknown[] = Array.isArray(value) ? value : [value];
    for (const item of list) {
        if (typeof item !== 'string') {
            throw argError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "options.alpn" argument must be an array of strings. Received ${describe(item)}`);
        }
    }
    return list as string[];
}

function callbackOf(value: unknown, name: string): (() => void) | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'function') {
        throw argError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type function. Received ${describe(value)}`);
    }
    return value as () => void;
}

function traceOf(value: unknown): ((event: Record<string, unknown>) => void) | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'function') {
        throw argError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "options.trace" argument must be of type function. Received ${describe(value)}`);
    }
    return value as (event: Record<string, unknown>) => void;
}

function idleTimeoutOf(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw argError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "options.idleTimeout" is out of range. It must be >= 0. Received ${describe(value)}`);
    }
    return value;
}

const SUITE_CODES: Readonly<Record<string, number>> = {
    TLS_AES_128_GCM_SHA256: 0x1301,
    TLS_AES_256_GCM_SHA384: 0x1302,
    TLS_CHACHA20_POLY1305_SHA256: 0x1303,
};
const GROUP_CODES: Readonly<Record<string, number>> = { X25519: 29, 'P-256': 23, prime256v1: 23, secp256r1: 23 };

function codes(list: unknown, table: Readonly<Record<string, number>>, what: string): number[] | undefined {
    if (list === undefined || list === null) return undefined;
    const items = Array.isArray(list) ? list : String(list).split(':');
    return items.map((item) => {
        if (typeof item === 'number') return item;
        const code = table[String(item)];
        if (code === undefined) throw Object.assign(new TypeError(`unknown ${what} ${String(item)}`), { code: 'ERR_INVALID_ARG_VALUE' });
        return code;
    });
}

function certificatesOf(pem: unknown): Uint8Array[] {
    if (pem === undefined || pem === null) return [];
    const list = Array.isArray(pem) ? pem : [pem];
    const out: Uint8Array[] = [];
    for (const entry of list) {
        for (const block of OWC_TLS13.parsePem(entry)) if (/CERTIFICATE$/.test(block.label)) out.push(block.der);
    }
    return out;
}

interface CommonOptions {
    alpn?: string[];
    suites?: (string | number)[] | string;
    groups?: (string | number)[] | string;
    idleTimeout?: number;
    transport?: Partial<TransportSettings>;
    trace?: (event: Record<string, unknown>) => void;
}

interface ServerOptions extends CommonOptions {
    key: unknown;
    cert: unknown;
    ca?: unknown;
    requestCert?: boolean;
    retry?: boolean;
}

interface ClientOptions extends CommonOptions {
    host?: string;
    port: number;
    servername?: string;
    ca?: unknown;
    rejectUnauthorized?: boolean;
    localPort?: number;
    localAddress?: string;
    key?: unknown;
    cert?: unknown;
}

function transportOf(options: CommonOptions): Partial<TransportSettings> {
    const transport: Partial<TransportSettings> = { ...(options.transport ?? {}) };
    if (typeof options.idleTimeout === 'number') return { ...transport, maxIdleTimeoutMs: options.idleTimeout };
    return transport;
}

/**
 * A dgram socket as the endpoint's DatagramSocket. Received datagrams are copied into plain
 * Uint8Arrays: Buffer.prototype.slice returns a view (in the guest as in Node), and the codecs treat
 * slice() as a copy (removeHeaderProtection writes the unmasked header into packet.slice(...)), so a
 * Buffer would be unmasked in place.
 */
function adaptSocket(socket: any): DatagramSocket {
    return {
        send: (datagram, port, address) => socket.send(asBuffer(datagram), port, address),
        close: () => socket.close(),
        onMessage: (handler) => {
            socket.on('message', (message: Uint8Array, rinfo: { address: string; port: number }) => handler(new Uint8Array(message), rinfo.address, rinfo.port));
        },
        address: () => socket.address(),
    };
}

class QuicServer extends Emitter {
    private socket: any = null;
    endpoint: QuicEndpoint | null = null;

    constructor(private readonly options: ServerOptions) {
        super();
    }

    listen(port = 0, host = '127.0.0.1', callback?: () => void): this {
        if (this.socket !== null) throw Object.assign(new Error('server is already listening'), { code: 'ERR_SERVER_ALREADY_LISTEN' });
        const bindPort = portOf(port, true, 'port');
        const bindHost = stringOf(host, 'host') ?? '127.0.0.1';
        const onListening = callbackOf(callback, 'callback');
        const dgram = requireBuiltin('dgram');
        const socket = dgram.createSocket(bindHost.indexOf(':') >= 0 ? 'udp6' : 'udp4');
        this.socket = socket;
        socket.on('error', (error: unknown) => this.emit('error', error));
        socket.bind(bindPort, bindHost);
        const key = OWC_TLS13.loadPem(this.options.key).key;
        const certs = OWC_TLS13.loadPem(this.options.cert).certs;
        const tls: TlsSettings = {
            ALPNProtocols: this.options.alpn ?? ['h3'],
            contexts: [{ certificates: certs, privateKey: key }],
            suites: codes(this.options.suites, SUITE_CODES, 'cipher suite'),
            groups: codes(this.options.groups, GROUP_CODES, 'group'),
            requestCert: this.options.requestCert === true,
            anchors: certificatesOf(this.options.ca),
        };
        this.endpoint = new QuicEndpoint({
            platform,
            socket: adaptSocket(socket),
            server: { tls, retry: this.options.retry === true, transport: transportOf(this.options) },
            trace: this.options.trace,
            wrapBytes: asBuffer,
        });
        this.endpoint.on('session', (session: QuicConnection) => this.emit('session', session));
        socket.once('listening', () => {
            this.emit('listening');
            if (onListening) onListening();
        });
        return this;
    }

    /** null before listen() and after close(), the way net.Server.address() reports it. */
    address(): { address: string; port: number } | null {
        return this.socket === null ? null : this.socket.address();
    }

    close(callback?: () => void): void {
        if (this.endpoint !== null) this.endpoint.close();
        this.endpoint = null;
        this.socket = null;
        this.emit('close');
        if (callback) callback();
    }
}

function createServer(options: ServerOptions, onSession?: (session: QuicConnection) => void): QuicServer {
    optionsObject(options, 'options');
    const server = new QuicServer(options);
    if (onSession) server.on('session', onSession);
    return server;
}

/**
 * Connects to a QUIC server; the socket closes when the connection has fully closed. The arguments
 * are checked here, synchronously: nothing about the connection can fail before the first datagram
 * goes out, which a timer does, where a throw would be uncaught and would take the process down.
 */
function connect(options: ClientOptions): QuicConnection & { endpoint: QuicEndpoint; localPort: number } {
    const opts = optionsObject(options, 'options') as unknown as ClientOptions;
    const host = stringOf(opts.host, 'options.host') ?? '127.0.0.1';
    const port = portOf(opts.port, false, 'options.port');
    const localAddress = stringOf(opts.localAddress, 'options.localAddress');
    const localPort = opts.localPort === undefined || opts.localPort === null ? undefined : portOf(opts.localPort, true, 'options.localPort');
    const alpn = alpnOf(opts.alpn);
    const trace = traceOf(opts.trace);
    const idleTimeout = idleTimeoutOf(opts.idleTimeout);
    const dgram = requireBuiltin('dgram');
    const socket = dgram.createSocket(host.indexOf(':') >= 0 ? 'udp6' : 'udp4');
    socket.bind(localPort ?? 0, localAddress ?? (host.indexOf(':') >= 0 ? '::1' : '127.0.0.1'));
    const endpoint = new QuicEndpoint({ platform, socket: adaptSocket(socket), trace, wrapBytes: asBuffer });
    const servername = stringOf(opts.servername, 'options.servername') ?? (/^[0-9.]+$/.test(host) || host.indexOf(':') >= 0 ? undefined : host);
    const contexts = opts.key !== undefined && opts.cert !== undefined ? [{ certificates: OWC_TLS13.loadPem(opts.cert).certs, privateKey: OWC_TLS13.loadPem(opts.key).key }] : undefined;
    const tls: TlsSettings = {
        ALPNProtocols: alpn ?? ['h3'],
        serverName: servername,
        anchors: certificatesOf(opts.ca),
        hostname: servername ?? host,
        suites: codes(opts.suites, SUITE_CODES, 'cipher suite'),
        groups: codes(opts.groups, GROUP_CODES, 'group'),
        contexts,
    };
    const connection = endpoint.connect({
        address: host,
        port,
        tls,
        rejectUnauthorized: opts.rejectUnauthorized,
        transport: transportOf({ ...opts, idleTimeout }),
    }) as QuicConnection & { endpoint: QuicEndpoint; localPort: number };
    connection.endpoint = endpoint;
    Object.defineProperty(connection, 'localPort', { get: () => socket.address().port, enumerable: true });
    endpoint.on('connectionClosed', () => endpoint.close());
    /* A send that fails after the arguments are accepted (a name the socket's family cannot reach,
       for one) arrives here as a socket 'error'; listen() forwards the same event, and without a
       listener of its own it would be an uncaught exception and would take the process down. */
    socket.on('error', (error: unknown) => connection.emit('error', error));
    return connection;
}

export const API = {
    createServer,
    connect,
    QuicConnection,
    QuicStream,
    QuicEndpoint,
    describeTransportParameters,
    decodeTransportParameters,
    encodeTransportParameters,
    VERSION: QUIC_VERSION_1,
    DEFAULT_TRANSPORT_SETTINGS,
    MAX_DATAGRAM_SIZE,
};

let http3: Http3Api | null = null;

/**
 * The HTTP/3 API behind the internal built-in 'owc:internal/http3' (h3-api.ts), built on first use
 * from the guest's events, stream and buffer modules and the QUIC API above.
 */
export function loadHttp3(): Http3Api {
    if (http3 === null) {
        http3 = createHttp3Api({
            events: requireBuiltin('events'),
            stream: requireBuiltin('stream'),
            Buffer,
            quic: { createServer: createServer as never, connect: connect as never },
            setTimeout: (callback, ms) => setTimeout(callback, ms),
        });
    }
    return http3;
}
