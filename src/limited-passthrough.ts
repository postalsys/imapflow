import { Transform, type TransformCallback } from 'node:stream';

/**
 * Normalizes a byte budget for the download pipeline. Any finite positive number is honored and
 * floored, because byte counts are integers: with a fractional bound a counter can only ever
 * reach its floor, so a stage would never report itself full and a loop polling that flag would
 * keep pulling forever. Anything else - 0, NaN, a non-numeric value - means "no limit".
 *
 * Lives here rather than in tools.ts because tools.ts imports jp-decoder.ts, which needs this.
 *
 * @param value - The configured budget.
 * @returns The normalized budget, or Infinity when unbounded.
 */
export const normalizeByteLimit = (value: unknown): number => {
    let bytes = Number(value);
    // Math.max keeps a sub-1 budget from flooring to 0, which would read back as "no limit"
    return Number.isFinite(bytes) && bytes > 0 ? Math.max(Math.floor(bytes), 1) : Infinity;
};

export interface LimitedPassthroughOptions {
    /** Maximum number of bytes to pass through. Anything else means "no limit" */
    maxBytes?: number | undefined;
}

// A Transform stream that passes through data up to a maximum byte limit,
// then silently discards all subsequent chunks. Used to enforce download
// size limits when fetching message content from the IMAP server.
export class LimitedPassthrough extends Transform {
    options: LimitedPassthroughOptions;
    maxBytes: number;
    processed: number;
    // Once set to true, all subsequent chunks are dropped without error
    limited: boolean;

    constructor(options?: LimitedPassthroughOptions | undefined) {
        super();
        this.options = options || {};
        this.maxBytes = normalizeByteLimit(this.options.maxBytes);
        this.processed = 0;
        this.limited = false;
    }

    override _transform(chunk: Buffer, encoding: BufferEncoding, done: TransformCallback): void {
        // If the limit was already reached, discard the chunk immediately
        if (this.limited) {
            return done();
        }

        const remainingBytes = this.maxBytes - this.processed;
        if (remainingBytes < 1) {
            return done();
        }

        // Slice the chunk to fit within the remaining byte budget
        if (chunk.length > remainingBytes) {
            chunk = chunk.subarray(0, remainingBytes);
        }

        this.processed += chunk.length;
        if (this.processed >= this.maxBytes) {
            this.limited = true;
        }

        this.push(chunk);
        done();
    }
}
