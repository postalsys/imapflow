'use strict';

const Transform = require('stream').Transform;
const logger = require('../logger');

const LINE = 0x01;
const LITERAL = 0x02;

const LF = 0x0a;
const CR = 0x0d;
const NUM_0 = 0x30;
const NUM_9 = 0x39;
const CURLY_OPEN = 0x7b;
const CURLY_CLOSE = 0x7d;

// Maximum allowed literal size: 1GB (1073741824 bytes)
const MAX_LITERAL_SIZE = 1024 * 1024 * 1024;

// Default maximum length of a single line (a response without a literal). Matches the literal cap:
// large literal-free responses (e.g. big SEARCH/LIST results) are legitimate, so this bound exists
// only to stop a server that never sends a line terminator, not to constrain normal traffic.
const MAX_LINE_SIZE = MAX_LITERAL_SIZE;

/**
 * A Transform stream that parses raw IMAP protocol data from a socket into structured
 * command/response objects. Reads binary input, splits it into lines delimited by LF,
 * extracts literal data blocks based on IMAP literal size markers (e.g., "{123}\r\n"),
 * and emits each complete command as a readable object containing the payload Buffer
 * and any associated literal Buffers. Enforces a maximum literal size of 1GB.
 *
 * @extends Transform
 */
class ImapStream extends Transform {
    /**
     * Creates a new ImapStream instance.
     *
     * @param {Object} [options] - Stream options.
     * @param {string} [options.cid] - Connection identifier used for logging.
     * @param {Object} [options.logger] - A pino-compatible logger instance. If not provided, a default child logger is created.
     * @param {boolean} [options.logRaw] - If true, logs raw socket data at trace level.
     * @param {boolean} [options.secureConnection] - Whether the connection uses TLS.
     * @param {number} [options.maxLineLength] - Maximum allowed length (in bytes) of a single
     *   line (a response without a literal). Defaults to MAX_LITERAL_SIZE (1GB). Guards against a
     *   malicious or broken server that never sends a line terminator, which would otherwise grow
     *   the internal line buffer without bound.
     * @param {number} [options.maxLiteralSize] - Maximum allowed size (in bytes) of a single
     *   literal block. Defaults to MAX_LITERAL_SIZE (1GB). Lower it to bound peak memory
     *   allocation against a malicious or broken server announcing an oversized literal.
     */
    constructor(options) {
        super({
            //writableHighWaterMark: 3,
            readableObjectMode: true,
            writableObjectMode: false
        });

        this.options = options || {};
        this.cid = this.options.cid;

        this.log =
            this.options.logger && typeof this.options.logger === 'object'
                ? this.options.logger
                : logger.child({
                      component: 'imap-connection',
                      cid: this.cid
                  });

        this.readBytesCounter = 0;

        // Maximum length of a single line (response without a literal). Bounds the line buffer
        // so a server that never sends a line terminator cannot exhaust memory. A non-negative
        // integer is honored as-is (including 0); anything else falls back to the default, so an
        // explicit 0 is not silently swallowed into the 1GB default the way `|| MAX_LINE_SIZE` was.
        this.maxLineLength = Number.isInteger(this.options.maxLineLength) && this.options.maxLineLength >= 0 ? this.options.maxLineLength : MAX_LINE_SIZE;

        // Maximum size of a single literal block. Bounds peak memory allocation so a server
        // announcing an oversized literal cannot exhaust memory. As above, a non-negative integer
        // (including an explicit 0, meaning "reject all non-empty literals") is honored as-is.
        this.maxLiteralSize =
            Number.isInteger(this.options.maxLiteralSize) && this.options.maxLiteralSize >= 0 ? this.options.maxLiteralSize : MAX_LITERAL_SIZE;

        this.state = LINE;
        this.literalWaiting = 0;
        this.inputBuffer = []; // lines
        this.lineBuffer = []; // current line
        this.lineBytes = 0; // bytes currently buffered for the in-progress line
        this.literalBuffer = [];
        this.literals = [];

        this.compress = false;
        this.secureConnection = this.options.secureConnection;

        this.processingInput = false;
        this.inputQueue = []; // unprocessed input chunks
    }

    /**
     * Checks whether the given line buffer ends with an IMAP literal size marker
     * (e.g., "{123}\r\n"). If a valid marker is found and the literal size is within
     * the allowed maximum, switches the stream state to LITERAL mode and records
     * the expected number of literal bytes.
     *
     * @param {Buffer} line - The line buffer to check for a trailing literal marker.
     * @returns {boolean} True if a valid literal marker was found and literal state was activated, false otherwise.
     */
    checkLiteralMarker(line) {
        if (!line || !line.length) {
            return false;
        }

        let pos = line.length - 1;

        if (line[pos] !== LF) {
            return false;
        }
        pos--;

        if (pos >= 0 && line[pos] === CR) {
            pos--;
        }

        if (pos < 0 || !pos || line[pos] !== CURLY_CLOSE) {
            return false;
        }
        pos--;

        // Scan backwards through the line to find an IMAP literal marker: {size}\r\n
        // The format is: '{' followed by one or more ASCII digits followed by '}'
        let numBytes = [];
        for (; pos >= 0; pos--) {
            let c = line[pos];
            if (c >= NUM_0 && c <= NUM_9) {
                numBytes.unshift(c);
                continue;
            }
            if (c === CURLY_OPEN && numBytes.length) {
                const literalSize = Number(Buffer.from(numBytes).toString());

                if (literalSize > this.maxLiteralSize) {
                    const err = new Error(`Literal size ${literalSize} exceeds maximum allowed size of ${this.maxLiteralSize} bytes`);
                    err.code = 'LiteralTooLarge';
                    err.literalSize = literalSize;
                    err.maxSize = this.maxLiteralSize;
                    this.emit('error', err);
                    return false;
                }

                this.state = LITERAL;
                this.literalWaiting = literalSize;
                return true;
            }
            return false;
        }
        return false;
    }

    /**
     * Processes a single input chunk of raw data. In LINE state, scans for LF-terminated
     * lines and checks for literal markers. In LITERAL state, collects the expected number
     * of literal bytes. When a complete command (with all its literals) is assembled, it is
     * pushed downstream as a readable object.
     *
     * @param {Buffer} chunk - The raw data chunk to process.
     * @param {number} [startPos=0] - The byte offset within the chunk to start processing from.
     * @returns {Promise<void>}
     */
    async processInputChunk(chunk, startPos) {
        startPos = startPos || 0;
        if (startPos >= chunk.length) {
            return;
        }

        switch (this.state) {
            case LINE: {
                let lineStart = startPos;
                for (let i = startPos, len = chunk.length; i < len; i++) {
                    if (chunk[i] === LF) {
                        // line end found
                        this.lineBuffer.push(chunk.slice(lineStart, i + 1));
                        lineStart = i + 1;

                        let line = Buffer.concat(this.lineBuffer);

                        this.inputBuffer.push(line);
                        this.lineBuffer = [];
                        this.lineBytes = 0;

                        // try to detect if this is a literal start
                        if (this.checkLiteralMarker(line)) {
                            // switch into line mode and start over
                            return await this.processInputChunk(chunk, lineStart);
                        }

                        // reached end of command input, emit it
                        let payload = this.inputBuffer.length === 1 ? this.inputBuffer[0] : Buffer.concat(this.inputBuffer);
                        let literals = this.literals;
                        this.inputBuffer = [];
                        this.literals = [];

                        if (payload.length) {
                            // remove final line terminator (\n or \r\n)
                            if (payload[payload.length - 1] === LF) {
                                let end = payload.length - 1;
                                if (end > 0 && payload[end - 1] === CR) {
                                    end--;
                                }
                                payload = payload.slice(0, end);
                            }

                            if (payload.length) {
                                // Whether more buffered input already followed this command on the
                                // wire — more bytes in this chunk or another queued chunk. Captured
                                // per emitted command (immutable on the pushed object) so a later
                                // command cannot overwrite it; consumers that care about pipelining
                                // boundaries can read it from the pushed object.
                                let trailingAfterLine = lineStart < chunk.length || this.inputQueue.length > 0;
                                await new Promise(resolve => {
                                    this.push({ payload, literals, next: resolve, trailingAfterLine });
                                });
                            }
                        }
                    }
                }
                if (lineStart < chunk.length) {
                    // No line terminator was found in the remaining bytes; carry the tail over to
                    // the next chunk. Enforce the line-length cap here, since this is the only
                    // path that grows the line buffer across chunks.
                    let tail = chunk.slice(lineStart);
                    let lineLength = this.lineBytes + tail.length;
                    if (lineLength > this.maxLineLength) {
                        const err = new Error(`Line length ${lineLength} exceeds maximum allowed size of ${this.maxLineLength} bytes`);
                        err.code = 'LineTooLarge';
                        err.lineLength = lineLength;
                        err.maxSize = this.maxLineLength;
                        this.emit('error', err);
                        return;
                    }
                    this.lineBytes = lineLength;
                    this.lineBuffer.push(tail);
                }
                break;
            }

            case LITERAL: {
                const remainingInChunk = chunk.length - startPos;
                const bytesToRead = Math.min(remainingInChunk, this.literalWaiting);
                const partial = startPos === 0 && bytesToRead === chunk.length ? chunk : chunk.slice(startPos, startPos + bytesToRead);

                this.literalBuffer.push(partial);
                this.literalWaiting -= bytesToRead;

                if (this.literalWaiting === 0) {
                    this.literals.push(Buffer.concat(this.literalBuffer));
                    this.literalBuffer = [];
                    this.state = LINE;

                    if (remainingInChunk > bytesToRead) {
                        return await this.processInputChunk(chunk, startPos + bytesToRead);
                    }
                }
                break;
            }
        }
    }

    /**
     * Drains the input queue by processing each queued chunk sequentially.
     * Yields to the event loop every 10 chunks to prevent CPU blocking on
     * large bursts of incoming data.
     *
     * @returns {Promise<void>}
     */
    async processInput() {
        let data;
        let processedCount = 0;
        while ((data = this.inputQueue.shift())) {
            await this.processInputChunk(data.chunk);
            // mark chunk as processed
            data.next();

            // Yield to event loop every 10 chunks to prevent CPU blocking
            processedCount++;
            if (processedCount % 10 === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
    }

    /**
     * Transform stream implementation. Receives raw data chunks from the writable side,
     * converts strings to Buffers, tracks total bytes read, optionally logs raw data,
     * and queues the chunk for asynchronous processing.
     *
     * @param {Buffer|string} chunk - The incoming data chunk.
     * @param {string} encoding - The encoding if chunk is a string.
     * @param {Function} next - Callback to signal that this chunk has been consumed.
     */
    _transform(chunk, encoding, next) {
        if (typeof chunk === 'string') {
            chunk = Buffer.from(chunk, encoding);
        }

        if (!chunk || !chunk.length) {
            return next();
        }

        this.readBytesCounter += chunk.length;

        if (this.options.logRaw) {
            this.log.trace({
                src: 's',
                msg: 'read from socket',
                data: chunk.toString('base64'),
                compress: !!this.compress,
                secure: !!this.secureConnection,
                cid: this.cid
            });
        }

        // Queue the chunk for async processing. The 'next' callback serves as
        // backpressure: it is called only after this chunk is fully processed,
        // which signals the writable side that more data can be accepted.
        this.inputQueue.push({ chunk, next });

        if (!this.processingInput) {
            this.processingInput = true;
            this.processInput()
                .catch(err => this.emit('error', err))
                .finally(() => (this.processingInput = false));
        }
    }

    /**
     * Flush implementation called when the writable side ends. Signals completion immediately.
     *
     * @param {Function} next - Callback to signal flush completion.
     */
    _flush(next) {
        next();
    }

    /**
     * Destroy implementation for cleanup. Clears all internal buffers, drains the input queue
     * by invoking pending callbacks, and forwards the error (if any) to the callback.
     *
     * @param {Error|null} err - The error that caused destruction, or null.
     * @param {Function} callback - Callback to signal destruction completion.
     */
    _destroy(err, callback) {
        this.inputBuffer = [];
        this.lineBuffer = [];
        this.lineBytes = 0;
        this.literalBuffer = [];
        this.literals = [];
        // Clear inputQueue and call any pending callbacks
        while (this.inputQueue.length) {
            const item = this.inputQueue.shift();
            if (typeof item.next === 'function') {
                item.next();
            }
        }
        callback(err);
    }
}

module.exports.ImapStream = ImapStream;
