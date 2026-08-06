'use strict';

const { Transform } = require('stream');

/**
 * Normalizes a byte budget for the download pipeline. Any finite positive number is honored and
 * floored, because byte counts are integers: with a fractional bound a counter can only ever
 * reach its floor, so a stage would never report itself full and a loop polling that flag would
 * keep pulling forever. Anything else - 0, NaN, a non-numeric value - means "no limit".
 *
 * Lives here rather than in tools.js because tools.js requires jp-decoder.js, which needs this.
 *
 * @param {*} value - The configured budget.
 * @returns {Number} The normalized budget, or Infinity when unbounded.
 */
const normalizeByteLimit = value => {
    let bytes = Number(value);
    // Math.max keeps a sub-1 budget from flooring to 0, which would read back as "no limit"
    return Number.isFinite(bytes) && bytes > 0 ? Math.max(Math.floor(bytes), 1) : Infinity;
};

// A Transform stream that passes through data up to a maximum byte limit,
// then silently discards all subsequent chunks. Used to enforce download
// size limits when fetching message content from the IMAP server.
class LimitedPassthrough extends Transform {
    constructor(options) {
        super();
        this.options = options || {};
        this.maxBytes = normalizeByteLimit(this.options.maxBytes);
        this.processed = 0;
        // Once set to true, all subsequent chunks are dropped without error
        this.limited = false;
    }

    _transform(chunk, encoding, done) {
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
            chunk = chunk.slice(0, remainingBytes);
        }

        this.processed += chunk.length;
        if (this.processed >= this.maxBytes) {
            this.limited = true;
        }

        this.push(chunk);
        done();
    }
}

module.exports.LimitedPassthrough = LimitedPassthrough;
module.exports.normalizeByteLimit = normalizeByteLimit;
