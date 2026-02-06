'use strict';

const { Transform } = require('stream');

// A Transform stream that passes through data up to a maximum byte limit,
// then silently discards all subsequent chunks. Used to enforce download
// size limits when fetching message content from the IMAP server.
class LimitedPassthrough extends Transform {
    constructor(options) {
        super();
        this.options = options || {};
        this.maxBytes = this.options.maxBytes || Infinity;
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
