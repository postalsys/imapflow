'use strict';

const Transform = require('stream').Transform;
const logger = require('../logger');
const { MAX_LITERAL_SIZE, MAX_LINE_SIZE, normalizeLimit, createLiteralTooLargeError } = require('./limits');

const LINE = 0x01;
const LITERAL = 0x02;

const LF = 0x0a;
const CR = 0x0d;
const NUM_0 = 0x30;
const NUM_9 = 0x39;
const CURLY_OPEN = 0x7b;
const CURLY_CLOSE = 0x7d;

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
     *   the internal line buffer without bound. The line terminator counts toward the limit, and a
     *   line exactly at the limit is accepted. Exceeding it is terminal: the stream is destroyed
     *   with a `LineTooLarge` error and no further input is parsed.
     * @param {number} [options.maxLiteralSize] - Maximum allowed size (in bytes) of a single
     *   literal block. Defaults to MAX_LITERAL_SIZE (1GB). Lower it to bound peak memory
     *   allocation against a malicious or broken server announcing an oversized literal. A literal
     *   exactly at the limit is accepted. Exceeding it is terminal: the stream is destroyed with a
     *   `LiteralTooLarge` error, the marker line is not emitted, and no byte of the rejected
     *   literal body is parsed as protocol.
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
        // so a server that never sends a line terminator cannot exhaust memory.
        this.maxLineLength = normalizeLimit(this.options.maxLineLength, MAX_LINE_SIZE);

        // Maximum size of a single literal block. Bounds peak memory allocation so a server
        // announcing an oversized literal cannot exhaust memory.
        this.maxLiteralSize = normalizeLimit(this.options.maxLiteralSize, MAX_LITERAL_SIZE);

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
        this.activeInput = null; // chunk currently being processed (already shifted off inputQueue)

        // Resolver of the in-flight push() backpressure promise, so destruction can settle it
        // instead of leaving processInput() awaiting a consumer that will never read again.
        this.pendingPush = null;
    }

    /**
     * Terminally fails the stream. Used for response limit violations and for any other
     * error raised while parsing.
     *
     * The stream is destroyed instead of only emitting `error`: emitting on a Transform leaves
     * it running, so the caller would keep scanning the rejected payload and could emit it as
     * protocol (an oversized literal body contains attacker-chosen CRLF delimited lines).
     * Destroying stops all parsing, drops the offending line, and releases every queued
     * transform callback exactly once (see `_destroy()`).
     *
     * `destroyed` (set synchronously by destroy()) is the single liveness flag every other path
     * checks, so a second failure attempt is a no-op and nothing is parsed after the first.
     *
     * @param {Error} err - The error to destroy the stream with.
     * @returns {boolean} Always false, so callers can `return this.failStream(err)`.
     */
    failStream(err) {
        if (this.destroyed) {
            return false;
        }
        this.destroy(err);
        return false;
    }

    /**
     * Releases a queued input chunk's transform callback exactly once, signalling the writable
     * side that the chunk was consumed. The mirror image of ImapFlow's releaseStreamData(), which
     * releases the readable items this stream pushes downstream.
     *
     * @param {Object} item - Queue entry holding the chunk and its transform callback.
     */
    releaseInput(item) {
        if (!item || item.released) {
            return;
        }
        item.released = true;
        if (typeof item.next === 'function') {
            item.next();
        }
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
        // The format is: '{' followed by one or more ASCII digits followed by '}'.
        // Only the digit run's bounds are tracked - a single linear pass, unlike
        // collecting digits into a growing array, which would make a line of n digits
        // cost O(n^2). The run length is deliberately not capped: the RFC "number"
        // production permits leading zeros, so a long digit run can still denote a
        // small, valid size, and treating the marker as an ordinary line instead
        // would feed the announced literal body to the line parser and desynchronize
        // the session.
        let digitsEnd = pos;
        for (; pos >= 0; pos--) {
            let c = line[pos];
            if (c >= NUM_0 && c <= NUM_9) {
                continue;
            }
            if (c === CURLY_OPEN && pos < digitsEnd) {
                // Skip leading zeros so only the significant digits are converted: a
                // marker padded with megabytes of zeros must not cost a string
                // allocation and Number() parse of the whole run.
                let digitsStart = pos + 1;
                while (digitsStart < digitsEnd && line[digitsStart] === NUM_0) {
                    digitsStart++;
                }

                // More significant digits than any number64 has cannot fit any
                // permissible maxLiteralSize; fail closed without materializing them
                if (digitsEnd + 1 - digitsStart > 19) {
                    return this.failStream(createLiteralTooLargeError(Infinity, this.maxLiteralSize, 'the widest permissible literal size (19 digits)'));
                }

                const literalSize = Number(line.toString('latin1', digitsStart, digitsEnd + 1));

                if (literalSize > this.maxLiteralSize) {
                    return this.failStream(createLiteralTooLargeError(literalSize, this.maxLiteralSize));
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
     * Enforces the configured line-length cap for a projected line length. The projected length
     * covers every byte of the line, the line terminator included, whether or not the line was
     * split across input chunks. A line exactly at the limit is accepted.
     *
     * @param {number} lineLength - Total length the current line would reach.
     * @returns {boolean} True if the line is within the limit, false if the stream was failed.
     */
    checkLineLength(lineLength) {
        if (lineLength <= this.maxLineLength) {
            return true;
        }
        const err = new Error(`Line length ${lineLength} exceeds maximum allowed size of ${this.maxLineLength} bytes`);
        err.code = 'LineTooLarge';
        err.lineLength = lineLength;
        err.maxSize = this.maxLineLength;
        return this.failStream(err);
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
        if (this.destroyed || startPos >= chunk.length) {
            return;
        }

        switch (this.state) {
            case LINE: {
                let lineStart = startPos;
                for (let i = startPos, len = chunk.length; i < len; i++) {
                    if (chunk[i] === LF) {
                        // line end found. Measure the completed line (terminator included) before
                        // concatenating or emitting anything, so the cap does not depend on where
                        // TCP chunk boundaries happen to fall.
                        let segment = chunk.slice(lineStart, i + 1);
                        if (!this.checkLineLength(this.lineBytes + segment.length)) {
                            return;
                        }

                        this.lineBuffer.push(segment);
                        lineStart = i + 1;

                        let line = this.lineBuffer.length === 1 ? this.lineBuffer[0] : Buffer.concat(this.lineBuffer);

                        this.lineBuffer = [];
                        this.lineBytes = 0;

                        // try to detect if this is a literal start. An oversized literal fails the
                        // stream, so the marker line must not be buffered before the check - it
                        // would otherwise be emitted as part of the rejected command.
                        let isLiteralMarker = this.checkLiteralMarker(line);
                        if (this.destroyed) {
                            return;
                        }

                        this.inputBuffer.push(line);

                        if (isLiteralMarker) {
                            // switch into literal mode and start over
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
                                    // Tracked so destruction can settle the wait instead of leaving
                                    // this loop (and the chunk's transform callback) pending forever
                                    // when the consumer stops reading.
                                    this.pendingPush = resolve;
                                    this.push({ payload, literals, next: resolve, trailingAfterLine });
                                });
                                this.pendingPush = null;

                                if (this.destroyed) {
                                    return;
                                }
                            }
                        }
                    }
                }
                if (lineStart < chunk.length) {
                    // No line terminator was found in the remaining bytes; carry the tail over to
                    // the next chunk after measuring the line it belongs to.
                    let tail = chunk.slice(lineStart);
                    if (!this.checkLineLength(this.lineBytes + tail.length)) {
                        return;
                    }
                    this.lineBytes += tail.length;
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
        while (!this.destroyed && (data = this.inputQueue.shift())) {
            this.activeInput = data;
            await this.processInputChunk(data.chunk);
            this.activeInput = null;
            // mark chunk as processed
            this.releaseInput(data);

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

        // A terminal parser failure must not accept any more protocol input, even if the
        // transport delivers a chunk that was already in flight.
        if (this.destroyed) {
            return next();
        }

        // Queue the chunk for async processing. The 'next' callback serves as
        // backpressure: it is called only after this chunk is fully processed,
        // which signals the writable side that more data can be accepted.
        this.inputQueue.push({ chunk, next });

        if (!this.processingInput) {
            this.processingInput = true;
            this.processInput()
                .catch(err => this.failStream(err))
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
        // Destruction is the single release point for parser-owned callbacks, so a terminal
        // failure can never leave the writable side or the processing loop waiting.
        this.inputBuffer = [];
        this.lineBuffer = [];
        this.lineBytes = 0;
        this.literalBuffer = [];
        this.literals = [];

        // Settle an in-flight push() wait so processInput() can unwind
        if (typeof this.pendingPush === 'function') {
            const resolve = this.pendingPush;
            this.pendingPush = null;
            resolve();
        }

        // Release the chunk currently being processed, then everything still queued.
        // releaseInput() is idempotent, so the processing loop releasing the same chunk
        // afterwards is a no-op.
        this.releaseInput(this.activeInput);
        this.activeInput = null;
        while (this.inputQueue.length) {
            this.releaseInput(this.inputQueue.shift());
        }

        callback(err);
    }
}

module.exports.ImapStream = ImapStream;
