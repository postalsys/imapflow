import { clearTimer } from './tools.js';
import type { ImapFlowError } from './errors.js';

// Default upper bound for establishing a usable transport, including DNS and proxy negotiation.
export const CONNECT_TIMEOUT = 90 * 1000;

/**
 * One deadline for an entire connection attempt.
 *
 * DNS resolution, proxy negotiation and the transport handshake all draw from the same budget, so
 * a phase that stalls cannot extend the documented `connectionTimeout`. Every expiry - whether it
 * comes from this deadline or is normalized from a dependency - is reported with the same
 * `CONNECT_TIMEOUT` error shape, so callers do not need to know which phase was blocked.
 */
export class ConnectionDeadline {
    timeout: number;
    startedAt: number;

    /**
     * @param timeout Configured connection timeout in milliseconds. Normalized once
     *   here; 0 and any other falsy or invalid value fall back to the 90 second default.
     */
    constructor(timeout?: number | string | undefined) {
        this.timeout = Number(timeout) || CONNECT_TIMEOUT;
        this.startedAt = Date.now();
    }

    /**
     * @returns Milliseconds left in the budget, never negative.
     */
    remaining(): number {
        return Math.max(0, this.timeout - (Date.now() - this.startedAt));
    }

    /**
     * @returns The shared `CONNECT_TIMEOUT` error.
     */
    error(): ImapFlowError {
        let err: ImapFlowError = new Error('Failed to establish connection in required time');
        err.code = 'CONNECT_TIMEOUT';
        err.details = { connectionTimeout: this.timeout };
        return err;
    }

    /**
     * Maps a dependency's own expiry onto the shared `CONNECT_TIMEOUT` shape, so callers see one
     * timeout error whichever layer noticed first. The original error is kept as `_err`. Anything
     * that is not a timeout is returned unchanged.
     *
     * @param err Error raised by a dependency during a connection phase.
     * @returns Either the normalized timeout error or the original error.
     */
    normalize<T extends ImapFlowError | null | undefined>(err: T): T | ImapFlowError {
        if (!err || err.code === 'CONNECT_TIMEOUT') {
            return err;
        }

        // The `socks` client reports its own expiry as "Proxy connection timed out"
        if (err.code !== 'ETIMEDOUT' && !/timed out/i.test(err.message || '')) {
            return err;
        }

        let normalized = this.error();
        normalized._err = err;
        return normalized;
    }

    /**
     * Throws before a phase is started if the budget is already used up, so no work is begun
     * that could only ever time out.
     */
    check(): void {
        if (!this.remaining()) {
            throw this.error();
        }
    }

    /**
     * Races a phase against the remaining budget. The timer is always cleared, so a completed
     * phase never leaves a pending timer behind.
     *
     * @param promise Phase to run under the deadline.
     * @returns Resolves with the phase result, rejects with `CONNECT_TIMEOUT`.
     */
    async race<T>(promise: Promise<T>): Promise<T> {
        this.check();

        let timer: NodeJS.Timeout | null = null;
        try {
            return await Promise.race([
                promise,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(this.error()), this.remaining());
                })
            ]);
        } finally {
            clearTimer(timer);
        }
    }
}
