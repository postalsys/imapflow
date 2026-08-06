/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const { ImapStream } = require('../lib/handler/imap-stream');

/**
 * Helper that wires up the standard readable/next consumer pattern used across tests.
 *
 * The reader calls onCommand synchronously for each command object, then calls cmd.next()
 * to allow the stream to continue. test.done() is called on the 'end' event.
 *
 * The readable handler uses a pendingRead flag so that if a 'readable' event fires
 * while the reader is active, a follow-up read is triggered after the reader finishes.
 * This prevents the 'end' event from being missed when the stream ends between reader
 * iterations.
 *
 * @param {Object} test - nodeunit test object
 * @param {Function} onCommand - synchronous function(cmd) called for each parsed command
 * @param {Function} writer - async function(stream) that writes data to the stream
 * @param {number} [expectedCount] - if set, assert that exactly this many commands were emitted
 */
function runStreamTest(test, onCommand, writer, expectedCount) {
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
            .catch(err => test.ifError(err))
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
        test.ifError(err);
    });

    stream.on('end', () => {
        if (expectedCount !== undefined) {
            test.equal(commandCount, expectedCount, `expected ${expectedCount} command(s), got ${commandCount}`);
        }
        test.done();
    });

    writer(stream).catch(err => test.ifError(err));
}

module.exports['Literal split across chunks'] = test => {
    runStreamTest(
        test,
        cmd => {
            test.equal(cmd.payload.toString(), 'A APPEND {5}\r\n', 'payload should include literal marker line');
            test.equal(cmd.literals.length, 1, 'should have one literal');
            test.ok(Buffer.isBuffer(cmd.literals[0]), 'literal should be a Buffer');
            test.equal(cmd.literals[0].toString(), '12345', 'literal content should be 12345');
        },
        async stream => {
            stream.write(Buffer.from('A APPEND {5}\r\n'));
            stream.end(Buffer.from('12345\r\n'));
        },
        1
    );
};

module.exports['Literal with zero size'] = test => {
    runStreamTest(
        test,
        cmd => {
            test.equal(cmd.payload.toString(), 'A APPEND {0}\r\n', 'payload should include zero-size literal marker');
            test.equal(cmd.literals.length, 1, 'should have one literal');
            test.ok(Buffer.isBuffer(cmd.literals[0]), 'literal should be a Buffer');
            test.equal(cmd.literals[0].length, 0, 'literal should be empty (length 0)');
        },
        async stream => {
            stream.end(Buffer.from('A APPEND {0}\r\n\r\n'));
        },
        1
    );
};

module.exports['Multiple commands in single chunk'] = test => {
    const expected = ['A CMD1', 'B CMD2'];
    let index = 0;

    runStreamTest(
        test,
        cmd => {
            test.equal(cmd.payload.toString(), expected[index], `command ${index} payload`);
            index++;
        },
        async stream => {
            stream.end(Buffer.from('A CMD1\r\nB CMD2\r\n'));
        },
        2
    );
};

module.exports['LiteralTooLarge error'] = test => {
    const stream = new ImapStream({ cid: 'test' });

    stream.on('error', err => {
        test.equal(err.code, 'LiteralTooLarge', 'error code should be LiteralTooLarge');
        stream.destroy();
        test.done();
    });

    stream.write(Buffer.from('A APPEND {1073741825}\r\n'));
};

module.exports['LiteralTooLarge error honors configured maxLiteralSize'] = test => {
    const cap = 1024; // 1KB cap
    const stream = new ImapStream({ cid: 'test', maxLiteralSize: cap });

    stream.on('error', err => {
        test.equal(err.code, 'LiteralTooLarge', 'error code should be LiteralTooLarge');
        test.equal(err.maxSize, cap, 'maxSize should reflect the configured cap');
        test.equal(err.literalSize, 2048, 'literalSize should be the offending value');
        stream.destroy();
        test.done();
    });

    stream.write(Buffer.from('A APPEND {2048}\r\n'));
};

module.exports['maxLiteralSize: 0 is honored (not swallowed into the default)'] = test => {
    // Regression: `this.options.maxLiteralSize || MAX_LITERAL_SIZE` turned an explicit 0 into
    // the 1GB default. An explicit 0 must mean "reject any non-empty literal".
    test.expect(2);

    const stream = new ImapStream({ cid: 'test', maxLiteralSize: 0 });
    test.equal(stream.maxLiteralSize, 0, 'an explicit 0 cap is preserved, not replaced by the default');

    stream.on('error', err => {
        test.equal(err.code, 'LiteralTooLarge', 'a 1-byte literal exceeds the 0 cap');
        stream.destroy();
        test.done();
    });

    stream.write(Buffer.from('A APPEND {1}\r\n'));
};

module.exports['Literal within configured maxLiteralSize parses cleanly'] = test => {
    // Require both literal assertions to actually run: 'end' fires even if the parser never
    // emits the command, so without expect() a dropped-literal regression would pass green.
    test.expect(2);

    const stream = new ImapStream({ cid: 'test', maxLiteralSize: 1024 });
    const literal = Buffer.alloc(512, 0x61); // 512 * 'a'

    stream.on('readable', () => {
        let cmd;
        while ((cmd = stream.read()) !== null) {
            test.equal(cmd.literals.length, 1, 'should have one literal');
            test.equal(cmd.literals[0].length, 512, 'literal length should be 512');
            cmd.next();
        }
    });

    stream.on('error', err => test.ifError(err));

    stream.on('end', () => test.done());

    stream.write(Buffer.from('A APPEND {512}\r\n'));
    stream.write(literal);
    stream.end(Buffer.from('\r\n'));
};

module.exports['Incomplete line continued in next chunk'] = test => {
    runStreamTest(
        test,
        cmd => {
            test.equal(cmd.payload.toString(), 'A CAPABILITY', 'payload should be A CAPABILITY');
            test.equal(cmd.literals.length, 0, 'should have no literals');
        },
        async stream => {
            stream.write(Buffer.from('A CA'));
            stream.end(Buffer.from('PABILITY\r\n'));
        },
        1
    );
};

module.exports['Empty chunk then valid command'] = test => {
    runStreamTest(
        test,
        cmd => {
            test.equal(cmd.payload.toString(), 'A CMD', 'payload should be A CMD');
            test.equal(cmd.literals.length, 0, 'should have no literals');
        },
        async stream => {
            stream.write(Buffer.alloc(0));
            stream.end(Buffer.from('A CMD\r\n'));
        },
        1
    );
};

module.exports['String input converted to Buffer'] = test => {
    runStreamTest(
        test,
        cmd => {
            test.equal(cmd.payload.toString(), 'A CMD', 'payload should be A CMD');
            test.ok(Buffer.isBuffer(cmd.payload), 'payload should be a Buffer');
            test.equal(cmd.literals.length, 0, 'should have no literals');
        },
        async stream => {
            stream.end('A CMD\r\n');
        },
        1
    );
};

module.exports['LF-only line terminator'] = test => {
    runStreamTest(
        test,
        cmd => {
            test.equal(cmd.payload.toString(), 'A CMD', 'payload should be A CMD without CR or LF');
            test.equal(cmd.literals.length, 0, 'should have no literals');
        },
        async stream => {
            stream.end(Buffer.from('A CMD\n'));
        },
        1
    );
};

module.exports['Many chunks trigger event loop yield'] = test => {
    runStreamTest(
        test,
        cmd => {
            // Just verify each command is valid
            test.ok(cmd.payload.toString().startsWith('A'), 'command should start with tag');
        },
        async stream => {
            for (let i = 0; i < 15; i++) {
                stream.write(Buffer.from(`A CMD${i}\r\n`));
            }
            stream.end();
        },
        15
    );
};

module.exports['Destroy with queued items does not hang'] = test => {
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
        test.ok(!errorEmitted, 'should not emit error on destroy');
        test.done();
    });
};

module.exports['logRaw option triggers trace logging'] = test => {
    let traceCalled = false;
    let traceData = null;

    const stream = new ImapStream({
        cid: 'test',
        logRaw: true
    });

    // Override the log object to capture trace calls
    stream.log = {
        trace: data => {
            traceCalled = true;
            traceData = data;
        },
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {}
    };

    // Also need to handle readable events
    stream.on('readable', () => {
        let cmd;
        while ((cmd = stream.read()) !== null) {
            cmd.next();
        }
    });

    stream.on('end', () => {
        test.ok(traceCalled, 'trace should have been called');
        test.ok(traceData, 'trace data should exist');
        test.equal(traceData.src, 's', 'source should be s');
        test.ok(traceData.data, 'should have base64 data');
        test.done();
    });

    stream.end(Buffer.from('A CMD\r\n'));
};

module.exports['Adjacent literals with marker at line start'] = test => {
    // After the first literal's data (12345) is consumed, parsing resumes at the very start of
    // a line that is itself a literal marker ({3}). The marker begins at byte 0 of the resumed
    // line, which the backward scan must still recognize. Previously the loop bound skipped
    // index 0, so the second literal was silently dropped.
    runStreamTest(
        test,
        cmd => {
            test.equal(cmd.literals.length, 2, 'both adjacent literals must be extracted');
            test.equal(cmd.literals[0].toString(), '12345', 'first literal content');
            test.equal(cmd.literals[1].toString(), 'ABC', 'second literal content');
        },
        async stream => {
            stream.end(Buffer.from('A LOGIN {5}\r\n12345{3}\r\nABC\r\n'));
        },
        1
    );
};

module.exports['Line length cap rejects oversized line'] = test => {
    // A server that never sends a line terminator must not grow the line buffer without bound.
    const stream = new ImapStream({ cid: 'test', maxLineLength: 16 });
    let errored = false;

    stream.on('error', err => {
        errored = true;
        test.equal(err.code, 'LineTooLarge', 'error code should be LineTooLarge');
        test.equal(err.maxSize, 16, 'error should report the configured cap');
        stream.destroy();
        test.done();
    });

    stream.on('end', () => {
        if (!errored) {
            test.ok(false, 'expected a LineTooLarge error');
            test.done();
        }
    });

    // 24 bytes, no LF, written across chunks -> exceeds the 16 byte cap.
    stream.write(Buffer.from('AAAAAAAA'));
    stream.write(Buffer.from('BBBBBBBB'));
    stream.write(Buffer.from('CCCCCCCC'));
};

module.exports['Line length cap allows line within limit'] = test => {
    // A normal line under the configured cap must still parse cleanly.
    const stream = new ImapStream({ cid: 'test', maxLineLength: 32 });
    let payloads = [];

    stream.on('readable', () => {
        let cmd;
        while ((cmd = stream.read()) !== null) {
            payloads.push(cmd.payload.toString());
            cmd.next();
        }
    });

    stream.on('error', err => test.ifError(err));

    stream.on('end', () => {
        test.deepEqual(payloads, ['A NOOP'], 'line under the cap should parse');
        test.done();
    });

    stream.end(Buffer.from('A NOOP\r\n'));
};

// ---------------------------------------------------------------------------
// checkLiteralMarker direct edge cases + _transform string handling + _destroy
// draining (lines that the normal streaming flow does not exercise).
// ---------------------------------------------------------------------------

module.exports['ImapStream: checkLiteralMarker returns false for empty line'] = test => {
    const stream = new ImapStream({ cid: 't' });
    test.equal(stream.checkLiteralMarker(Buffer.alloc(0)), false);
    test.equal(stream.checkLiteralMarker(null), false);
    test.done();
};

module.exports['ImapStream: checkLiteralMarker returns false when no trailing LF'] = test => {
    const stream = new ImapStream({ cid: 't' });
    test.equal(stream.checkLiteralMarker(Buffer.from('A1 OK no newline')), false);
    test.done();
};

module.exports['ImapStream: checkLiteralMarker returns false for non-numeric marker'] = test => {
    const stream = new ImapStream({ cid: 't' });
    // '{' present but contains a non-digit, and an empty {} marker
    test.equal(stream.checkLiteralMarker(Buffer.from('A1 CMD {x}\r\n')), false);
    test.equal(stream.checkLiteralMarker(Buffer.from('A1 CMD {}\r\n')), false);
    test.done();
};

module.exports['ImapStream: checkLiteralMarker activates literal state for valid marker'] = test => {
    const stream = new ImapStream({ cid: 't' });
    test.equal(stream.checkLiteralMarker(Buffer.from('A1 CMD {5}\r\n')), true);
    test.equal(stream.literalWaiting, 5);
    test.done();
};

module.exports['ImapStream: _transform converts string chunks to Buffer'] = test => {
    const stream = new ImapStream({ cid: 't' });
    let commands = [];
    stream.on('readable', () => {
        let cmd;
        while ((cmd = stream.read()) !== null) {
            commands.push(cmd.payload.toString());
            cmd.next();
        }
    });
    stream.on('end', () => {
        test.ok(commands.some(c => /A1 OK/.test(c)));
        test.done();
    });
    // write a string (not a Buffer) to exercise the string->Buffer branch
    stream.write('A1 OK done\r\n');
    stream.end();
};

module.exports['ImapStream: _destroy drains pending input queue callbacks'] = test => {
    const stream = new ImapStream({ cid: 't' });
    let nextCalled = false;
    // Stage a pending queue item with a next() callback, then destroy.
    stream.inputQueue.push({ chunk: Buffer.from('x'), next: () => (nextCalled = true) });
    stream.destroy();
    setImmediate(() => {
        test.ok(nextCalled, 'pending next() invoked during destroy');
        test.done();
    });
};

module.exports['Literal marker scan stays linear on a long digit run'] = test => {
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

    test.ok(elapsedMs < 250, `scan should stay cheap, took ${elapsedMs.toFixed(1)}ms`);
    test.done();
};

module.exports['Literal marker fails the stream on an oversized digit run'] = test => {
    // An impossible size is still a syntactically valid marker. Treating it as an
    // ordinary line instead would feed the announced literal body to the line parser
    // and desynchronize the session, so the stream must end with LiteralTooLarge.
    const stream = new ImapStream({ cid: 'test' });
    let streamErr = null;
    stream.on('error', err => {
        streamErr = err;
    });
    stream.resume();

    const line = Buffer.concat([Buffer.from('* OK {'), Buffer.from('1'.repeat(40)), Buffer.from('}\r\n')]);

    test.equal(stream.checkLiteralMarker(line), false, 'an impossible size must not start literal mode');
    test.ok(stream.destroyed, 'the stream must fail closed instead of continuing as if the marker were text');
    setImmediate(() => {
        test.ok(streamErr && streamErr.code === 'LiteralTooLarge', 'must fail with LiteralTooLarge');
        test.done();
    });
};

module.exports['Literal marker accepts a zero-padded size'] = test => {
    // The RFC "number" production is 1*DIGIT, so leading zeros are legal - a long
    // digit run can still denote a small size and must be consumed as a literal
    const stream = new ImapStream({ cid: 'test' });
    stream.on('error', () => {});
    stream.resume();

    const line = Buffer.from(`* 1 FETCH (BODY[] {${'0'.repeat(21)}123}\r\n`);

    test.equal(stream.checkLiteralMarker(line), true, 'a zero-padded marker is a valid literal marker');
    test.equal(stream.literalWaiting, 123, 'the padded size must parse to its numeric value');
    stream.destroy();
    test.done();
};

module.exports['Literal marker still accepts sizes at the digit-length bound'] = test => {
    const stream = new ImapStream({ cid: 'test', maxLiteralSize: Number.MAX_SAFE_INTEGER });
    stream.on('error', () => {});
    stream.resume();

    // 19 digits is the widest a number64 gets, so it must still be recognized
    const line = Buffer.from(`* OK {${'9'.repeat(19)}}\r\n`);

    test.equal(stream.checkLiteralMarker(line), false, 'a size beyond the configured maximum fails the stream rather than parsing');

    const ok = new ImapStream({ cid: 'test' });
    ok.on('error', () => {});
    ok.resume();
    test.equal(ok.checkLiteralMarker(Buffer.from('* OK {1024}\r\n')), true);
    test.equal(ok.literalWaiting, 1024);
    test.done();
};

module.exports['Response assembly enforces the cumulative size cap'] = test => {
    // The per-line and per-literal caps alone cannot stop a response spread across many
    // tokens: under a 40-byte response budget, a 25-byte marker line plus a declared
    // 10-byte literal fits (35), but the next marker line (16 bytes + 10 declared) must
    // trip the cap - before the second literal's bytes are even read
    const stream = new ImapStream({ cid: 'test', maxResponseSize: 40 });
    let streamErr = null;
    stream.on('error', err => {
        streamErr = err;
    });
    stream.resume();

    stream.write(Buffer.from('* 1 FETCH (BODY[1] {10}\r\n'));
    stream.write(Buffer.from('0123456789'));
    stream.write(Buffer.from(' BODY[2] {10}\r\n0123456789)\r\n'));

    setTimeout(() => {
        test.ok(streamErr, 'an oversized cumulative response must fail the stream');
        test.equal(streamErr && streamErr.code, 'ResponseTooLarge');
        test.ok(stream.destroyed, 'the stream must fail closed instead of parsing the rejected payload');
        test.done();
    }, 100);
};

// Resolves once the stream has settled - on its first 'error', or on 'end' when it is
// consumed to completion. Waiting for the real signal keeps these tests off fixed sleeps.
const settle = stream =>
    new Promise(resolve => {
        stream.once('error', err => resolve(err));
        stream.once('end', () => resolve(null));
    });

module.exports['Response size budget resets between responses'] = async test => {
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

    test.ok(line.length <= 40 && line.length * 2 > 40, 'each response fits the budget, the pair does not');

    stream.write(Buffer.from(line + line));
    stream.end();

    await settle(stream);
    test.ifError(streamErr);
    test.equal(count, 2);
    test.done();
};

module.exports['Response size cap defaults above the literal cap'] = test => {
    // The response total also carries the literal marker line and the rest of the framing, so
    // a default equal to the literal cap would make a literal of exactly the maximum permitted
    // size impossible to receive
    const stream = new ImapStream({ cid: 'test' });
    test.equal(stream.maxResponseSize, 2 * 1024 * 1024 * 1024);
    test.ok(stream.maxResponseSize > stream.maxLiteralSize, 'the response cap must leave headroom above the literal cap');
    test.done();
};

module.exports['A literal of exactly maxLiteralSize is accepted when the response cap leaves headroom'] = async test => {
    const stream = new ImapStream({ cid: 'test', maxLiteralSize: 100, maxResponseSize: 200 });
    let streamErr = null;
    let received = null;
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
    test.ifError(streamErr);
    test.ok(received, 'a literal at exactly the configured maximum must be delivered');
    test.equal(received.literals.length, 1);
    test.equal(received.literals[0].length, 100);
    test.done();
};

module.exports['An unterminated line is bounded by the response budget'] = async test => {
    // maxResponseSize is only committed when a line completes, so an in-progress line has to
    // be measured against the remaining budget separately - otherwise a response cap lowered
    // to bound parser memory buys nothing while a server streams a line that never ends
    const stream = new ImapStream({ cid: 'test', maxResponseSize: 64 });
    stream.resume();

    stream.write(Buffer.from('x'.repeat(1024))); // no line terminator anywhere

    let err = await settle(stream);
    test.ok(err, 'an unterminated line beyond the response budget must fail the stream');
    test.equal(err.code, 'ResponseTooLarge');
    test.ok(stream.lineBytes <= 64, 'no more than the budget may stay buffered');
    test.done();
};

module.exports['Infinity disables a parser size cap'] = test => {
    // A cap that cannot be disabled forces a caller who knows their server onto the default
    const stream = new ImapStream({ cid: 'test', maxResponseSize: Infinity, maxLiteralSize: Infinity, maxLineLength: Infinity });
    test.equal(stream.maxResponseSize, Infinity);
    test.equal(stream.maxLiteralSize, Infinity);
    test.equal(stream.maxLineLength, Infinity);
    test.done();
};

module.exports['A marker line that fits the budget can still be refused for its literal'] = async test => {
    // The line is measured against the budget as it is assembled, but the declared literal is
    // only charged once the marker line completes - so the cap has to be enforced in both places
    const stream = new ImapStream({ cid: 'test', maxResponseSize: 40 });
    stream.resume();

    // 25-byte marker line fits on its own; the 30 declared literal bytes push the total past 40
    stream.write(Buffer.from('* 1 FETCH (BODY[1] {30}\r\n'));

    let err = await settle(stream);
    test.ok(err, 'the declared literal must be charged before its bytes arrive');
    test.equal(err.code, 'ResponseTooLarge');
    test.equal(err.responseSize, 55);
    test.done();
};
