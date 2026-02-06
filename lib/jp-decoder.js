'use strict';

const { Transform } = require('stream');
const encodingJapanese = require('encoding-japanese');

// A Transform stream for decoding Japanese character sets (Shift_JIS, EUC-JP, ISO-2022-JP).
// Unlike iconv-lite which can decode incrementally, encoding-japanese requires the complete
// input buffer for accurate charset detection and stateful decoding (especially ISO-2022-JP
// which uses escape sequences to switch between ASCII and multi-byte modes). Therefore,
// this stream buffers all input during _transform and performs the actual decoding in _flush.
class JPDecoder extends Transform {
    constructor(charset) {
        super();

        this.charset = charset;
        this.chunks = [];
        this.chunklen = 0;
    }

    // Buffer all incoming chunks; no decoding happens here because Japanese charsets
    // require the complete input for accurate conversion.
    _transform(chunk, encoding, done) {
        if (typeof chunk === 'string') {
            chunk = Buffer.from(chunk, encoding);
        }

        this.chunks.push(chunk);
        this.chunklen += chunk.length;
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
