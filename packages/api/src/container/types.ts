export interface ContainerOptions {
    debug?: boolean;
    maxProcesses?: number;
    memoryLimit?: number;
    coep?: 'require-corp' | 'credentialless' | 'none';
    onServerListen?: (port: number) => void;
    onServerClose?: (port: number) => void;
}

export interface ContainerStats {
    network: NetworkStats;
    processes: {
        pid: number;
        type: string;
        state: string;
        uptime: number | null;
    } [];
}

export interface NetworkStats {
    servers: {
        total: number;
        active: number;
        byType: any;
    };
    connections: {
        total: number;
        active: number;
        byServer: Record<string, number>;
    };
    traffic: {
        bytesReceived: number;
        bytesSent: number;
        requestsTotal: number;
        requestsSuccess: number;
        requestsFailed: number;
        avgResponseTime: number;
    };
    requestsPerMinute: number;
}
