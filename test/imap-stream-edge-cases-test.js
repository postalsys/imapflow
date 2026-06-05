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
