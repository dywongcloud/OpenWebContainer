import type { AckRange } from './frames';

/*
 * Loss detection and probe timeouts (RFC 9002 Sections 5, 6 and Appendix A), per packet number
 * space: RTT estimation, packet and time threshold loss detection, and the PTO timer with
 * exponential backoff. There is no congestion controller (RFC 9002 Section 7); the connection
 * only caps bytes in flight at the initial window.
 */

export type SpaceId = 'initial' | 'handshake' | 'application';
export const SPACE_IDS: readonly SpaceId[] = ['initial', 'handshake', 'application'];

/** RFC 9002 Section 6.2.2 and Appendix A.2 constants, in milliseconds. */
export const INITIAL_RTT = 333;
export const GRANULARITY = 1;
const PACKET_THRESHOLD = 3n;
const TIME_THRESHOLD = 9 / 8;

export interface SentPacket<F> {
    readonly pn: bigint;
    readonly timeSent: number;
    readonly ackEliciting: boolean;
    readonly inFlight: boolean;
    readonly size: number;
    readonly frames: F[];
    /** 1-RTT Key Phase the packet was protected with; null for long headers. */
    readonly keyPhase: 0 | 1 | null;
}

interface SpaceState<F> {
    readonly sent: Map<bigint, SentPacket<F>>;
    largestAcked: bigint | null;
    lossTime: number | null;
    timeOfLastAckEliciting: number | null;
    discarded: boolean;
}

export interface AckOutcome<F> {
    readonly acked: SentPacket<F>[];
    readonly lost: SentPacket<F>[];
    /** The packet that carried the Largest Acknowledged, when it was newly acknowledged. */
    readonly largestNewlyAcked: SentPacket<F> | null;
}

export interface TimerState {
    readonly isClient: boolean;
    readonly handshakeConfirmed: boolean;
    readonly hasHandshakeKeys: boolean;
    /** RFC 9002 A.6 PeerCompletedAddressValidation: always true at a server. */
    readonly peerAddressValidated: boolean;
    /** A server limited by the anti-amplification factor arms no PTO (RFC 9002 Section 6.2.2.1). */
    readonly amplificationBlocked: boolean;
}

export interface LossTimer {
    readonly kind: 'loss' | 'pto';
    readonly time: number;
    readonly space: SpaceId;
}

export class Recovery<F> {
    latestRtt = 0;
    smoothedRtt = INITIAL_RTT;
    rttVar = INITIAL_RTT / 2;
    minRtt = 0;
    private hasRttSample = false;
    /** The peer's max_ack_delay transport parameter, milliseconds. */
    maxAckDelay = 25;
    ptoCount = 0;
    bytesInFlight = 0;
    private readonly spaces: Record<SpaceId, SpaceState<F>> = {
        initial: Recovery.emptySpace<F>(),
        handshake: Recovery.emptySpace<F>(),
        application: Recovery.emptySpace<F>(),
    };

    private static emptySpace<T>(): SpaceState<T> {
        return { sent: new Map(), largestAcked: null, lossTime: null, timeOfLastAckEliciting: null, discarded: false };
    }

    largestAcked(space: SpaceId): bigint | null {
        return this.spaces[space].largestAcked;
    }

    isDiscarded(space: SpaceId): boolean {
        return this.spaces[space].discarded;
    }

    ackElicitingInFlight(space?: SpaceId): number {
        let count = 0;
        for (const id of space ? [space] : SPACE_IDS) {
            for (const packet of this.spaces[id].sent.values()) if (packet.ackEliciting && packet.inFlight) count++;
        }
        return count;
    }

    unacked(space: SpaceId): SentPacket<F>[] {
        return [...this.spaces[space].sent.values()];
    }

    onPacketSent(space: SpaceId, packet: SentPacket<F>): void {
        const state = this.spaces[space];
        if (state.discarded) return;
        state.sent.set(packet.pn, packet);
        if (packet.inFlight) {
            this.bytesInFlight += packet.size;
            if (packet.ackEliciting) state.timeOfLastAckEliciting = packet.timeSent;
        }
    }

    /** RFC 9002 A.7 OnAckReceived. ackDelay is in milliseconds, already scaled by the peer's exponent. */
    onAckReceived(space: SpaceId, ranges: readonly AckRange[], ackDelay: number, now: number, handshakeConfirmed: boolean): AckOutcome<F> {
        const state = this.spaces[space];
        if (state.discarded || ranges.length === 0) return { acked: [], lost: [], largestNewlyAcked: null };
        const largest = ranges[0].largest;
        if (state.largestAcked === null || largest > state.largestAcked) state.largestAcked = largest;
        const acked: SentPacket<F>[] = [];
        for (const packet of [...state.sent.values()]) {
            if (!ranges.some((range) => packet.pn >= range.smallest && packet.pn <= range.largest)) continue;
            state.sent.delete(packet.pn);
            if (packet.inFlight) this.bytesInFlight -= packet.size;
            acked.push(packet);
        }
        if (acked.length === 0) return { acked, lost: [], largestNewlyAcked: null };
        const largestNewlyAcked = acked.find((packet) => packet.pn === largest) ?? null;
        if (largestNewlyAcked !== null && acked.some((packet) => packet.ackEliciting)) {
            this.updateRtt(now - largestNewlyAcked.timeSent, space === 'application' && handshakeConfirmed ? ackDelay : 0);
        }
        const lost = this.detectLost(space, now);
        this.ptoCount = 0;
        return { acked, lost, largestNewlyAcked };
    }

    /** RFC 9002 Section 5.3. */
    private updateRtt(latest: number, ackDelay: number): void {
        this.latestRtt = Math.max(latest, 0);
        if (!this.hasRttSample) {
            this.hasRttSample = true;
            this.minRtt = this.latestRtt;
            this.smoothedRtt = this.latestRtt;
            this.rttVar = this.latestRtt / 2;
            return;
        }
        this.minRtt = Math.min(this.minRtt, this.latestRtt);
        const delay = Math.min(ackDelay, this.maxAckDelay);
        const adjusted = this.latestRtt >= this.minRtt + delay ? this.latestRtt - delay : this.latestRtt;
        this.rttVar = 0.75 * this.rttVar + 0.25 * Math.abs(this.smoothedRtt - adjusted);
        this.smoothedRtt = 0.875 * this.smoothedRtt + 0.125 * adjusted;
    }

    /** RFC 9002 A.10 DetectAndRemoveLostPackets. */
    detectLost(space: SpaceId, now: number): SentPacket<F>[] {
        const state = this.spaces[space];
        state.lossTime = null;
        if (state.largestAcked === null) return [];
        const lossDelay = Math.max(TIME_THRESHOLD * Math.max(this.latestRtt, this.smoothedRtt), GRANULARITY);
        const lostSendTime = now - lossDelay;
        const lost: SentPacket<F>[] = [];
        for (const packet of [...state.sent.values()]) {
            if (packet.pn > state.largestAcked) continue;
            if (packet.timeSent <= lostSendTime || state.largestAcked >= packet.pn + PACKET_THRESHOLD) {
                state.sent.delete(packet.pn);
                if (packet.inFlight) this.bytesInFlight -= packet.size;
                lost.push(packet);
            } else {
                const when = packet.timeSent + lossDelay;
                state.lossTime = state.lossTime === null ? when : Math.min(state.lossTime, when);
            }
        }
        return lost;
    }

    /** The PTO period without backoff (RFC 9002 Section 6.2.1); max_ack_delay applies to Application Data only. */
    ptoPeriod(space: SpaceId): number {
        return this.smoothedRtt + Math.max(4 * this.rttVar, GRANULARITY) + (space === 'application' ? this.maxAckDelay : 0);
    }

    /** RFC 9002 A.8 SetLossDetectionTimer: the earliest loss time, else the PTO deadline. */
    nextTimer(now: number, s: TimerState): LossTimer | null {
        let loss: LossTimer | null = null;
        for (const space of SPACE_IDS) {
            const state = this.spaces[space];
            if (state.discarded || state.lossTime === null) continue;
            if (loss === null || state.lossTime < loss.time) loss = { kind: 'loss', time: state.lossTime, space };
        }
        if (loss !== null) return loss;
        if (s.amplificationBlocked) return null;
        const backoff = 2 ** this.ptoCount;
        if (this.ackElicitingInFlight() === 0) {
            if (s.peerAddressValidated) return null;
            // Client anti-deadlock (RFC 9002 Section 6.2.2.1): probe even with nothing in flight.
            const space: SpaceId = s.hasHandshakeKeys ? 'handshake' : 'initial';
            return { kind: 'pto', time: now + this.ptoPeriod(space) * backoff, space };
        }
        let best: LossTimer | null = null;
        for (const space of SPACE_IDS) {
            const state = this.spaces[space];
            if (state.discarded || state.timeOfLastAckEliciting === null || this.ackElicitingInFlight(space) === 0) continue;
            if (space === 'application' && !s.handshakeConfirmed) continue;
            const time = state.timeOfLastAckEliciting + this.ptoPeriod(space) * backoff;
            if (best === null || time < best.time) best = { kind: 'pto', time, space };
        }
        return best;
    }

    /** Forgets a packet number space whose keys were discarded (RFC 9002 Section 6.4). */
    discardSpace(space: SpaceId): void {
        const state = this.spaces[space];
        for (const packet of state.sent.values()) if (packet.inFlight) this.bytesInFlight -= packet.size;
        state.sent.clear();
        state.lossTime = null;
        state.timeOfLastAckEliciting = null;
        state.discarded = true;
        this.ptoCount = 0;
    }

    /** Removes every in-flight packet of a space without discarding it, returning them (Retry: resend from scratch). */
    takeAll(space: SpaceId): SentPacket<F>[] {
        const state = this.spaces[space];
        const packets = [...state.sent.values()];
        for (const packet of packets) if (packet.inFlight) this.bytesInFlight -= packet.size;
        state.sent.clear();
        state.lossTime = null;
        state.timeOfLastAckEliciting = null;
        return packets;
    }
}
