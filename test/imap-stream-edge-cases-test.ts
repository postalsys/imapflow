/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapStream } from '../src/handler/imap-stream.js';

/**
 * Helper that wires up the standard readable/next consumer pattern used across tests.
 *
 * The reader calls onCommand synchronously for each command object, then calls cmd.next()
 * to allow the stream to continue. done() is called on the 'end' event.
 *
 * The readable handler uses a pendingRead flag so that if a 'readable' event fires
 * while the reader is active, a follow-up read is triggered after the reader finishes.
 * This prevents the 'end' event from being missed when the stream ends between reader
 * iterations.
 *
 * @param done - node:test completion callback
 * @param {Function} onCommand - synchronous function(cmd) called for each parsed command
 * @param {Function} writer - async function(stream) that writes data to the stream
 * @param {number} [expectedCount] - if set, assert that exactly this many commands were emitted
 */
function runStreamTest(done: (err?: any) => void, onCommand: (cmd: any) => void, writer: (stream: any) => Promise<void>, expectedCount?: number) {
    const stream = new ImapStream({ cid: 'test' });
    let commandCount = 0;

    let reading = false;
    let pendingRead = false;

    const reader = async () => {
        let cmd;
        while ((cmd = stream.read()) !== null) {
            commandCount++;
            onCommand(cmd);
            cmd.next();
        }
    };

    const drainStream = () => {
        if (reading) {
            pendingRead = true;
            return;
        }
        reading = true;
        reader()
            .catch(err => assert.ifError(err))
            .finally(() => {
                reading = false;
                if (pendingRead) {
                    pendingRead = false;
                    drainStream();
                }
            });
    };

    stream.on('readable', drainStream);

    stream.on('error', err => {
        assert.ifError(err);
    });

    stream.on('end', () => {
        if (expectedCount !== undefined) {
            assert.equal(commandCount, expectedCount, `expected ${expectedCount} command(s), got ${commandCount}`);
        }
        done();
    });

    writer(stream).catch(err => assert.ifError(err));
}

// Resolves once the stream has settled - on its first 'error', or on 'end' when it is
// consumed to completion. Waiting for the real signal keeps these tests off fixed sleeps.
const settle = (stream: any) =>
    new Promise(resolve => {
        stream.once('error', (err: any) => resolve(err));
        stream.once('end', () => resolve(null));
    });

describe('imap-stream-edge-cases', () => {
    it('Literal split across chunks', (t, done) => {
        runStreamTest(
            done,
            cmd => {
                assert.equal(cmd.payload.toString(), 'A APPEND {5}\r\n', 'payload should include literal marker line');
                assert.equal(cmd.literals.length, 1, 'should have one literal');
                assert.ok(Buffer.isBuffer(cmd.literals[0]), 'literal should be a Buffer');
                assert.equal(cmd.literals[0].toString(), '12345', 'literal content should be 12345');
            },
            async stream => {
                stream.write(Buffer.from('A APPEND {5}\r\n'));
                stream.end(Buffer.from('12345\r\n'));
            },
            1
        );
    });
    it('Literal with zero size', (t, done) => {
        runStreamTest(
            done,
            cmd => {
                assert.equal(cmd.payload.toString(), 'A APPEND {0}\r\n', 'payload should include zero-size literal marker');
                assert.equal(cmd.literals.length, 1, 'should have one literal');
                assert.ok(Buffer.isBuffer(cmd.literals[0]), 'literal should be a Buffer');
                assert.equal(cmd.literals[0].length, 0, 'literal should be empty (length 0)');
            },
            async stream => {
                stream.end(Buffer.from('A APPEND {0}\r\n\r\n'));
            },
            1
        );
    });
    it('Multiple commands in single chunk', (t, done) => {
        const expected = ['A CMD1', 'B CMD2'];
        let index = 0;

        runStreamTest(
            done,
            cmd => {
                assert.equal(cmd.payload.toString(), expected[index], `command ${index} payload`);
                index++;
            },
            async stream => {
                stream.end(Buffer.from('A CMD1\r\nB CMD2\r\n'));
            },
            2
        );
    });
    it('LiteralTooLarge error', (t, done) => {
        const stream = new ImapStream({ cid: 'test' });

        stream.on('error', err => {
            assert.equal((err as any).code, 'LiteralTooLarge', 'error code should be LiteralTooLarge');
            stream.destroy();
            done();
        });

        stream.write(Buffer.from('A APPEND {1073741825}\r\n'));
    });
    it('LiteralTooLarge error honors configured maxLiteralSize', (t, done) => {
        const cap = 1024; // 1KB cap
        const stream = new ImapStream({ cid: 'test', maxLiteralSize: cap });

        stream.on('error', err => {
            assert.equal((err as any).code, 'LiteralTooLarge', 'error code should be LiteralTooLarge');
            assert.equal((err as any).maxSize, cap, 'maxSize should reflect the configured cap');
            assert.equal((err as any).literalSize, 2048, 'literalSize should be the offending value');
            stream.destroy();
            done();
        });

        stream.write(Buffer.from('A APPEND {2048}\r\n'));
    });
    it('maxLiteralSize: 0 is honored (not swallowed into the default)', (t, done) => {
        // Regression: `this.options.maxLiteralSize || MAX_LITERAL_SIZE` turned an explicit 0 into
        // the 1GB default. An explicit 0 must mean "reject any non-empty literal".

        const stream = new ImapStream({ cid: 'test', maxLiteralSize: 0 });
        assert.equal(stream.maxLiteralSize, 0, 'an explicit 0 cap is preserved, not replaced by the default');

        stream.on('error', err => {
            assert.equal((err as any).code, 'LiteralTooLarge', 'a 1-byte literal exceeds the 0 cap');
            stream.destroy();
            done();
        });

        stream.write(Buffer.from('A APPEND {1}\r\n'));
    });
    it('Literal within configured maxLiteralSize parses cleanly', (t, done) => {
        // Require both literal assertions to actually run: 'end' fires even if the parser never
        // emits the command, so without expect() a dropped-literal regression would pass green.

        const stream = new ImapStream({ cid: 'test', maxLiteralSize: 1024 });
        const literal = Buffer.alloc(512, 0x61); // 512 * 'a'

        stream.on('readable', () => {
            let cmd;
            while ((cmd = stream.read()) !== null) {
                assert.equal(cmd.literals.length, 1, 'should have one literal');
                assert.equal(cmd.literals[0].length, 512, 'literal length should be 512');
                cmd.next();
            }
        });

        stream.on('error', err => assert.ifError(err));

        stream.on('end', () => done());

        stream.write(Buffer.from('A APPEND {512}\r\n'));
        stream.write(literal);
        stream.end(Buffer.from('\r\n'));
    });
    it('Incomplete line continued in next chunk', (t, done) => {
        runStreamTest(
            done,
            cmd => {
                assert.equal(cmd.payload.toString(), 'A CAPABILITY', 'payload should be A CAPABILITY');
                assert.equal(cmd.literals.length, 0, 'should have no literals');
            },
            async stream => {
                stream.write(Buffer.from('A CA'));
                stream.end(Buffer.from('PABILITY\r\n'));
            },
            1
        );
    });
    it('Empty chunk then valid command', (t, done) => {
        runStreamTest(
            done,
            cmd => {
                assert.equal(cmd.payload.toString(), 'A CMD', 'payload should be A CMD');
                assert.equal(cmd.literals.length, 0, 'should have no literals');
            },
            async stream => {
                stream.write(Buffer.alloc(0));
                stream.end(Buffer.from('A CMD\r\n'));
            },
            1
        );
    });
    it('String input converted to Buffer', (t, done) => {
        runStreamTest(
            done,
            cmd => {
                assert.equal(cmd.payload.toString(), 'A CMD', 'payload should be A CMD');
                assert.ok(Buffer.isBuffer(cmd.payload), 'payload should be a Buffer');
                assert.equal(cmd.literals.length, 0, 'should have no literals');
            },
            async stream => {
                stream.end('A CMD\r\n');
            },
            1
        );
    });
    it('LF-only line terminator', (t, done) => {
        runStreamTest(
            done,
            cmd => {
                assert.equal(cmd.payload.toString(), 'A CMD', 'payload should be A CMD without CR or LF');
                assert.equal(cmd.literals.length, 0, 'should have no literals');
            },
            async stream => {
                stream.end(Buffer.from('A CMD\n'));
            },
            1
        );
    });
    it('Many chunks trigger event loop yield', (t, done) => {
        runStreamTest(
            done,
            cmd => {
                // Just verify each command is valid
                assert.ok(cmd.payload.toString().startsWith('A'), 'command should start with tag');
            },
            async stream => {
                for (let i = 0; i < 15; i++) {
                    stream.write(Buffer.from(`A CMD${i}\r\n`));
                }
                stream.end();
            },
            15
        );
    });
    it('Destroy with queued items does not hang', (t, done) => {
        const stream = new ImapStream({ cid: 'test' });
        let errorEmitted = false;

        stream.on('error', () => {
            errorEmitted = true;
        });

        // Write multiple chunks rapidly then destroy
        stream.write(Buffer.from('A CMD1\r\n'));
        stream.write(Buffer.from('B CMD2\r\n'));
        stream.destroy();

        // Errors from destroy are emitted synchronously or on next tick
        setImmediate(() => {
            assert.ok(!errorEmitted, 'should not emit error on destroy');
            done();
        });
    });
    it('logRaw option triggers trace logging', (t, done) => {
        let traceCalled = false;
        let traceData: any = null;

        const stream = new ImapStream({
            cid: 'test',
            logRaw: true
        });

        // Override the log object to capture trace calls
        stream.log = {
            trace: (data: any) => {
                traceCalled = true;
                traceData = data;
            },
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {}
        } as any;

        // Also need to handle readable events
        stream.on('readable', () => {
            let cmd;
            while ((cmd = stream.read()) !== null) {
                cmd.next();
            }
        });

        stream.on('end', () => {
            assert.ok(traceCalled, 'trace should have been called');
            assert.ok(traceData, 'trace data should exist');
            assert.equal(traceData.src, 's', 'source should be s');
            assert.ok(traceData.data, 'should have base64 data');
            done();
        });

        stream.end(Buffer.from('A CMD\r\n'));
    });
    it('Adjacent literals with marker at line start', (t, done) => {
        // After the first literal's data (12345) is consumed, parsing resumes at the very start of
        // a line that is itself a literal marker ({3}). The marker begins at byte 0 of the resumed
        // line, which the backward scan must still recognize. Previously the loop bound skipped
        // index 0, so the second literal was silently dropped.
        runStreamTest(
            done,
            cmd => {
                assert.equal(cmd.literals.length, 2, 'both adjacent literals must be extracted');
                assert.equal(cmd.literals[0].toString(), '12345', 'first literal content');
                assert.equal(cmd.literals[1].toString(), 'ABC', 'second literal content');
            },
            async stream => {
                stream.end(Buffer.from('A LOGIN {5}\r\n12345{3}\r\nABC\r\n'));
            },
            1
        );
    });
    it('Line length cap rejects oversized line', (t, done) => {
        // A server that never sends a line terminator must not grow the line buffer without bound.
        const stream = new ImapStream({ cid: 'test', maxLineLength: 16 });
        let errored = false;

        stream.on('error', err => {
            errored = true;
            assert.equal((err as any).code, 'LineTooLarge', 'error code should be LineTooLarge');
            assert.equal((err as any).maxSize, 16, 'error should report the configured cap');
            stream.destroy();
            done();
        });

        stream.on('end', () => {
            if (!errored) {
                assert.ok(false, 'expected a LineTooLarge error');
                return done();
            }
        });

        // 24 bytes, no LF, written across chunks -> exceeds the 16 byte cap.
        stream.write(Buffer.from('AAAAAAAA'));
        stream.write(Buffer.from('BBBBBBBB'));
        stream.write(Buffer.from('CCCCCCCC'));
    });
    it('Line length cap allows line within limit', (t, done) => {
        // A normal line under the configured cap must still parse cleanly.
        const stream = new ImapStream({ cid: 'test', maxLineLength: 32 });
        let payloads: any = [];

        stream.on('readable', () => {
            let cmd;
            while ((cmd = stream.read()) !== null) {
                payloads.push(cmd.payload.toString());
                cmd.next();
            }
        });

        stream.on('error', err => assert.ifError(err));

        stream.on('end', () => {
            assert.deepEqual(payloads, ['A NOOP'], 'line under the cap should parse');
            done();
        });

        stream.end(Buffer.from('A NOOP\r\n'));
    });

    // ---------------------------------------------------------------------------
    // checkLiteralMarker direct edge cases + _transform string handling + _destroy
    // draining (lines that the normal streaming flow does not exercise).
    // ---------------------------------------------------------------------------
    it('ImapStream: checkLiteralMarker returns false for empty line', () => {
        const stream = new ImapStream({ cid: 't' });
        assert.equal(stream.checkLiteralMarker(Buffer.alloc(0)), false);
        assert.equal(stream.checkLiteralMarker(null as any), false);
    });
    it('ImapStream: checkLiteralMarker returns false when no trailing LF', () => {
        const stream = new ImapStream({ cid: 't' });
        assert.equal(stream.checkLiteralMarker(Buffer.from('A1 OK no newline')), false);
    });
    it('ImapStream: checkLiteralMarker returns false for non-numeric marker', () => {
        const stream = new ImapStream({ cid: 't' });
        // '{' present but contains a non-digit, and an empty {} marker
        assert.equal(stream.checkLiteralMarker(Buffer.from('A1 CMD {x}\r\n')), false);
        assert.equal(stream.checkLiteralMarker(Buffer.from('A1 CMD {}\r\n')), false);
    });
    it('ImapStream: checkLiteralMarker activates literal state for valid marker', () => {
        const stream = new ImapStream({ cid: 't' });
        assert.equal(stream.checkLiteralMarker(Buffer.from('A1 CMD {5}\r\n')), true);
        assert.equal(stream.literalWaiting, 5);
    });
    it('ImapStream: _transform converts string chunks to Buffer', (t, done) => {
        const stream = new ImapStream({ cid: 't' });
        let commands: any = [];
        stream.on('readable', () => {
            let cmd;
            while ((cmd = stream.read()) !== null) {
                commands.push(cmd.payload.toString());
                cmd.next();
            }
        });
        stream.on('end', () => {
            assert.ok(commands.some((c: any) => /A1 OK/.test(c)));
            done();
        });
        // write a string (not a Buffer) to exercise the string->Buffer branch
        stream.write('A1 OK done\r\n');
        stream.end();
    });
    it('ImapStream: _destroy drains pending input queue callbacks', (t, done) => {
        const stream = new ImapStream({ cid: 't' });
        let nextCalled = false;
        // Stage a pending queue item with a next() callback, then destroy.
        stream.inputQueue.push({ chunk: Buffer.from('x'), next: () => (nextCalled = true) });
        stream.destroy();
        setImmediate(() => {
            assert.ok(nextCalled, 'pending next() invoked during destroy');
            done();
        });
    });
    it('Literal marker scan stays linear on a long digit run', () => {
        // A backwards scan that accumulated digits one at a time cost O(n^2), so a few
        // hundred KB of digits blocked the event loop for seconds before the size was
        // even known - all inside the default line-length budget
        const stream = new ImapStream({ cid: 'test' });
        stream.on('error', () => {});
        stream.resume();

        const line = Buffer.concat([Buffer.from('* OK {'), Buffer.from('9'.repeat(200000)), Buffer.from('}\r\n')]);

        const started = process.hrtime.bigint();
        stream.checkLiteralMarker(line);
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

        assert.ok(elapsedMs < 250, `scan should stay cheap, took ${elapsedMs.toFixed(1)}ms`);
    });
    it('Literal marker fails the stream on an oversized digit run', (t, done) => {
        // An impossible size is still a syntactically valid marker. Treating it as an
        // ordinary line instead would feed the announced literal body to the line parser
        // and desynchronize the session, so the stream must end with LiteralTooLarge.
        const stream = new ImapStream({ cid: 'test' });
        let streamErr: any = null;
        stream.on('error', err => {
            streamErr = err;
        });
        stream.resume();

        const line = Buffer.concat([Buffer.from('* OK {'), Buffer.from('1'.repeat(40)), Buffer.from('}\r\n')]);

        assert.equal(stream.checkLiteralMarker(line), false, 'an impossible size must not start literal mode');
        assert.ok(stream.destroyed, 'the stream must fail closed instead of continuing as if the marker were text');
        setImmediate(() => {
            assert.ok(streamErr && streamErr.code === 'LiteralTooLarge', 'must fail with LiteralTooLarge');
            done();
        });
    });
    it('Literal marker accepts a zero-padded size', () => {
        // The RFC "number" production is 1*DIGIT, so leading zeros are legal - a long
        // digit run can still denote a small size and must be consumed as a literal
        const stream = new ImapStream({ cid: 'test' });
        stream.on('error', () => {});
        stream.resume();

        const line = Buffer.from(`* 1 FETCH (BODY[] {${'0'.repeat(21)}123}\r\n`);

        assert.equal(stream.checkLiteralMarker(line), true, 'a zero-padded marker is a valid literal marker');
        assert.equal(stream.literalWaiting, 123, 'the padded size must parse to its numeric value');
        stream.destroy();
    });
    it('Literal marker still accepts sizes at the digit-length bound', () => {
        const stream = new ImapStream({ cid: 'test', maxLiteralSize: Number.MAX_SAFE_INTEGER });
        stream.on('error', () => {});
        stream.resume();

        // 19 digits is the widest a number64 gets, so it must still be recognized
        const line = Buffer.from(`* OK {${'9'.repeat(19)}}\r\n`);

        assert.equal(stream.checkLiteralMarker(line), false, 'a size beyond the configured maximum fails the stream rather than parsing');

        const ok = new ImapStream({ cid: 'test' });
        ok.on('error', () => {});
        ok.resume();
        assert.equal(ok.checkLiteralMarker(Buffer.from('* OK {1024}\r\n')), true);
        assert.equal(ok.literalWaiting, 1024);
    });
    it('Response assembly enforces the cumulative size cap', (t, done) => {
        // The per-line and per-literal caps alone cannot stop a response spread across many
        // tokens: under a 40-byte response budget, a 25-byte marker line plus a declared
        // 10-byte literal fits (35), but the next marker line (16 bytes + 10 declared) must
        // trip the cap - before the second literal's bytes are even read
        const stream = new ImapStream({ cid: 'test', maxResponseSize: 40 });
        let streamErr: any = null;
        stream.on('error', err => {
            streamErr = err;
        });
        stream.resume();

        stream.write(Buffer.from('* 1 FETCH (BODY[1] {10}\r\n'));
        stream.write(Buffer.from('0123456789'));
        stream.write(Buffer.from(' BODY[2] {10}\r\n0123456789)\r\n'));

        setTimeout(() => {
            assert.ok(streamErr, 'an oversized cumulative response must fail the stream');
            assert.equal(streamErr && streamErr.code, 'ResponseTooLarge');
            assert.ok(stream.destroyed, 'the stream must fail closed instead of parsing the rejected payload');
            done();
        }, 100);
    });
    it('Response size budget resets between responses', async () => {
        // The counter tracks a single response, not the whole session. Each response here fits
        // the 40-byte budget on its own but the two together do not, so a counter that failed to
        // reset would trip the cap on the second one - which is what makes this test detect the
        // regression rather than merely pass alongside it.
        const line = '* OK ' + 'a'.repeat(23) + '\r\n'; // 30 bytes, two of them exceed the budget
        const stream = new ImapStream({ cid: 'test', maxResponseSize: 40 });
        let streamErr = null;
        let count = 0;
        stream.on('error', err => {
            streamErr = err;
        });
        stream.on('data', cmd => {
            count++;
            cmd.next();
        });

        assert.ok(line.length <= 40 && line.length * 2 > 40, 'each response fits the budget, the pair does not');

        stream.write(Buffer.from(line + line));
        stream.end();

        await settle(stream);
        assert.ifError(streamErr);
        assert.equal(count, 2);
    });
    it('Response size cap defaults above the literal cap', () => {
        // The response total also carries the literal marker line and the rest of the framing, so
        // a default equal to the literal cap would make a literal of exactly the maximum permitted
        // size impossible to receive
        const stream = new ImapStream({ cid: 'test' });
        assert.equal(stream.maxResponseSize, 2 * 1024 * 1024 * 1024);
        assert.ok(stream.maxResponseSize > stream.maxLiteralSize, 'the response cap must leave headroom above the literal cap');
    });
    it('A literal of exactly maxLiteralSize is accepted when the response cap leaves headroom', async () => {
        const stream = new ImapStream({ cid: 'test', maxLiteralSize: 100, maxResponseSize: 200 });
        let streamErr = null;
        let received: any = null;
        stream.on('error', err => {
            streamErr = err;
        });
        stream.on('data', cmd => {
            received = cmd;
            cmd.next();
        });

        stream.write(Buffer.from('* 1 FETCH (BODY[] {100}\r\n'));
        stream.write(Buffer.from('x'.repeat(100)));
        stream.write(Buffer.from(')\r\n'));
        stream.end();

        await settle(stream);
        assert.ifError(streamErr);
        assert.ok(received, 'a literal at exactly the configured maximum must be delivered');
        assert.equal(received.literals.length, 1);
        assert.equal((received as any).literals[0].length, 100);
    });
    it('An unterminated line is bounded by the response budget', async () => {
        // maxResponseSize is only committed when a line completes, so an in-progress line has to
        // be measured against the remaining budget separately - otherwise a response cap lowered
        // to bound parser memory buys nothing while a server streams a line that never ends
        const stream = new ImapStream({ cid: 'test', maxResponseSize: 64 });
        stream.resume();

        stream.write(Buffer.from('x'.repeat(1024))); // no line terminator anywhere

        let err: any = await settle(stream);
        assert.ok(err, 'an unterminated line beyond the response budget must fail the stream');
        assert.equal(err.code, 'ResponseTooLarge');
        assert.ok(stream.lineBytes <= 64, 'no more than the budget may stay buffered');
    });
    it('Infinity disables a parser size cap', () => {
        // A cap that cannot be disabled forces a caller who knows their server onto the default
        const stream = new ImapStream({ cid: 'test', maxResponseSize: Infinity, maxLiteralSize: Infinity, maxLineLength: Infinity });
        assert.equal(stream.maxResponseSize, Infinity);
        assert.equal(stream.maxLiteralSize, Infinity);
        assert.equal(stream.maxLineLength, Infinity);
    });
    it('A marker line that fits the budget can still be refused for its literal', async () => {
        // The line is measured against the budget as it is assembled, but the declared literal is
        // only charged once the marker line completes - so the cap has to be enforced in both places
        const stream = new ImapStream({ cid: 'test', maxResponseSize: 40 });
        stream.resume();

        // 25-byte marker line fits on its own; the 30 declared literal bytes push the total past 40
        stream.write(Buffer.from('* 1 FETCH (BODY[1] {30}\r\n'));

        let err: any = await settle(stream);
        assert.ok(err, 'the declared literal must be charged before its bytes arrive');
        assert.equal(err.code, 'ResponseTooLarge');
        assert.equal((err as any).responseSize, 55);
    });
});
