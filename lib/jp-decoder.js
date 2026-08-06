'use strict';

const { Transform } = require('stream');
const encodingJapanese = require('encoding-japanese');
const { normalizeByteLimit } = require('./limited-passthrough.js');

// A Transform stream for decoding Japanese character sets (Shift_JIS, EUC-JP, ISO-2022-JP).
// Unlike iconv-lite which can decode incrementally, encoding-japanese requires the complete
// input buffer for accurate charset detection and stateful decoding (especially ISO-2022-JP
// which uses escape sequences to switch between ASCII and multi-byte modes). Therefore,
// this stream buffers all input during _transform and performs the actual decoding in _flush.
class JPDecoder extends Transform {
    constructor(charset, maxBytes) {
        super();

        this.charset = charset;
        this.chunks = [];
        this.chunklen = 0;

        // Upper bound for the buffered bytes, normalized the same way LimitedPassthrough
        // normalizes its own. The whole-input buffering defeats a downstream maxBytes limiter
        // (nothing is emitted until _flush), so without an internal bound a server could force
        // unbounded memory use through a caller that asked for a limited download. Excess input
        // is truncated, mirroring the truncation a maxBytes download applies anyway.
        this.maxBytes = normalizeByteLimit(maxBytes);

        // Also mirroring LimitedPassthrough: true once the bound is reached and every further
        // chunk is being discarded. The download loop reads this to stop pulling from the
        // server, which the limiter at the tail of the pipeline cannot tell it, because nothing
        // is emitted from here until _flush().
        this.limited = false;
    }

    // Buffer all incoming chunks (up to maxBytes); no decoding happens here because
    // Japanese charsets require the complete input for accurate conversion.
    _transform(chunk, encoding, done) {
        if (typeof chunk === 'string') {
            chunk = Buffer.from(chunk, encoding);
        }

        if (this.chunklen + chunk.length > this.maxBytes) {
            chunk = chunk.slice(0, Math.max(0, this.maxBytes - this.chunklen));
        }

        if (chunk.length) {
            this.chunks.push(chunk);
            this.chunklen += chunk.length;
        }

        if (this.chunklen >= this.maxBytes) {
            this.limited = true;
        }

        done();
    }

    // Perform the actual charset conversion once all input has been received.
    // Uses the encoding-japanese library to convert from the source charset to Unicode.
    // On failure (corrupt or unrecognizable data), passes through the raw bytes unchanged.
    _flush(done) {
        let input = Buffer.concat(this.chunks, this.chunklen);
        try {
            let output = encodingJapanese.convert(input, {
                to: 'UNICODE', // to_encoding
                from: this.charset, // from_encoding
                type: 'string'
            });
            if (typeof output === 'string') {
                output = Buffer.from(output);
            }
            this.push(output);
        } catch {
            // keep as is on errors
            this.push(input);
        }

        done();
    }

    _destroy(err, callback) {
        this.chunks = [];
        this.chunklen = 0;
        callback(err);
    }
}

module.exports.JPDecoder = JPDecoder;
