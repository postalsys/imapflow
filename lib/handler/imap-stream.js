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

class ImapStream extends Transform {
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

        this.state = LINE;
        this.literalWaiting = 0;
        this.inputBuffer = []; // lines
        this.lineBuffer = []; // current line
        this.literalBuffer = [];
        this.literals = [];

        this.compress = false;
        this.secureConnection = this.options.secureConnection;

        this.processingInput = false;
        this.inputQueue = []; // unprocessed input chunks
    }

    checkLiteralMarker(line) {
        if (!line || !line.length) {
            return false;
        }

        let pos = line.length - 1;

        if (line[pos] === LF) {
            pos--;
        } else {
            return false;
        }
        if (pos >= 0 && line[pos] === CR) {
            pos--;
        }
        if (pos < 0) {
            return false;
        }

        if (!pos || line[pos] !== CURLY_CLOSE) {
            return false;
        }
        pos--;

        let numBytes = [];
        for (; pos > 0; pos--) {
            let c = line[pos];
            if (c >= NUM_0 && c <= NUM_9) {
                numBytes.unshift(c);
                continue;
            }
            if (c === CURLY_OPEN && numBytes.length) {
                this.state = LITERAL;
                this.literalWaiting = Number(Buffer.from(numBytes).toString());
                return true;
            }
            return false;
        }
        return false;
    }

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
                            // remove final line terminator
                            let skipBytes = 0;
                            if (payload.length >= 1 && payload[payload.length - 1] === LF) {
                                skipBytes++;
                                if (payload.length >= 2 && payload[payload.length - 2] === CR) {
                                    skipBytes++;
                                }
                            }

                            if (skipBytes) {
                                payload = payload.slice(0, payload.length - skipBytes);
                            }

                            if (payload.length) {
                                await new Promise(resolve => {
                                    this.push({ payload, literals, next: resolve });
                                });
                            }
                        }
                    }
                }
                if (lineStart < chunk.length) {
                    this.lineBuffer.push(chunk.slice(lineStart));
                }
                break;
            }

            case LITERAL: {
                // exactly until end of chunk
                if (chunk.length === startPos + this.literalWaiting) {
                    if (!startPos) {
                        this.literalBuffer.push(chunk);
                    } else {
                        this.literalBuffer.push(chunk.slice(startPos));
                    }

                    this.literalWaiting -= chunk.length;
                    this.literals.push(Buffer.concat(this.literalBuffer));
                    this.literalBuffer = [];
                    this.state = LINE;

                    return;
                } else if (chunk.length > startPos + this.literalWaiting) {
                    let partial = chunk.slice(startPos, startPos + this.literalWaiting);
                    this.literalBuffer.push(partial);
                    startPos += partial.length;
                    this.literalWaiting -= partial.length;
                    this.literals.push(Buffer.concat(this.literalBuffer));
                    this.literalBuffer = [];
                    this.state = LINE;

                    return await this.processInputChunk(chunk, startPos);
                } else {
                    let partial = chunk.slice(startPos);
                    this.literalBuffer.push(partial);
                    startPos += partial.length;
                    this.literalWaiting -= partial.length;
                    return;
                }
            }
        }
    }

    async processInput() {
        let data;
        while ((data = this.inputQueue.shift())) {
            await this.processInputChunk(data.chunk);
            // mark chunk as processed
            data.next();
        }
    }

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

        if (chunk && chunk.length) {
            this.inputQueue.push({ chunk, next });
        }

        if (!this.processingInput) {
            this.processingInput = true;
            this.processInput()
                .catch(err => this.emit('error', err))
                .finally(() => (this.processingInput = false));
        }
    }

    _flush(next) {
        next();
    }
}

module.exports.ImapStream = ImapStream;
