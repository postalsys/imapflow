'use strict';

// Response line and literal limits must be terminal, complete, and non-parsing:
//   * every line is measured, including the one whose LF arrives in the same chunk,
//     so the cap cannot be bypassed by TCP chunk boundaries
//   * the line terminator counts toward maxLineLength and a line exactly at the cap passes
//   * a limit violation destroys the stream, so no byte of the rejected payload is ever
//     emitted as protocol (an oversized literal body is attacker-chosen message content)

const { ImapStream } = require('../lib/handler/imap-stream');
const { parser } = require('../lib/handler/imap-handler');

// Collects every emitted command payload and the first stream error. `error` resolves once the
// stream fails; `settled` resolves once processing has quiesced (error or writable end).
const runStream = (options, writer) => {
    const stream = new ImapStream(Object.assign({ cid: 'test' }, options));
    const payloads = [];
    let resolveDone;
    const done = new Promise(resolve => (resolveDone = resolve));
    let error = null;

    stream.on('readable', () => {
        let cmd;
        while ((cmd = stream.read()) !== null) {
            payloads.push(cmd.payload.toString());
            cmd.next();
        }
    });

    stream.on('error', err => {
        error = err;
        resolveDone();
    });

    stream.on('end', () => resolveDone());

    writer(stream);

    // Settle one more tick after the failure so anything the stream might still emit
    // (which it must not) would be visible in `payloads`.
    return done.then(() => new Promise(resolve => setImmediate(() => resolve({ payloads, error }))));
};

module.exports['Parser limits: line exactly at the cap is accepted (terminator included)'] = async test => {
    // "A NOOP\r\n" is 8 bytes with the terminator, so a cap of 8 must accept it.
    const { payloads, error } = await runStream({ maxLineLength: 8 }, stream => stream.end(Buffer.from('A NOOP\r\n')));

    test.equal(error, null, 'a line at exactly the cap must not fail');
    test.deepEqual(payloads, ['A NOOP'], 'the line is emitted');
    test.done();
};

module.exports['Parser limits: line one byte over the cap is rejected'] = async test => {
    // Same line with a cap of 7: the terminator pushes it over the limit.
    const { payloads, error } = await runStream({ maxLineLength: 7 }, stream => stream.end(Buffer.from('A NOOP\r\n')));

    test.ok(error, 'the oversized line fails the stream');
    test.equal(error.code, 'LineTooLarge');
    test.equal(error.lineLength, 8, 'the reported length includes the terminator');
    test.equal(error.maxSize, 7);
    test.deepEqual(payloads, [], 'nothing is emitted');
    test.done();
};

module.exports['Parser limits: oversized line delivered in a single chunk is rejected'] = async test => {
    // Regression: the cap used to be checked only on the stored tail, so a complete line whose
    // LF arrived in the same chunk was never measured at all.
    const { payloads, error } = await runStream({ maxLineLength: 16 }, stream => stream.end(Buffer.from('* OK ' + 'A'.repeat(64) + '\r\n')));

    test.ok(error, 'a single-chunk oversized line fails the stream');
    test.equal(error.code, 'LineTooLarge');
    test.deepEqual(payloads, [], 'nothing is emitted');
    test.done();
};

module.exports['Parser limits: oversized line accumulated across chunks is rejected'] = async test => {
    const { payloads, error } = await runStream({ maxLineLength: 16 }, stream => {
        stream.write(Buffer.from('AAAAAAAA'));
        stream.write(Buffer.from('BBBBBBBB'));
        stream.end(Buffer.from('CCCCCCCC'));
    });

    test.ok(error, 'accumulated bytes over the cap fail the stream');
    test.equal(error.code, 'LineTooLarge');
    test.deepEqual(payloads, [], 'nothing is emitted');
    test.done();
};

module.exports['Parser limits: oversized line whose final chunk carries the LF is rejected'] = async test => {
    // The final chunk completes the line, so it is the LF-terminated path that must measure it.
    const { payloads, error } = await runStream({ maxLineLength: 16 }, stream => {
        stream.write(Buffer.from('AAAAAAAA'));
        stream.write(Buffer.from('BBBBBBBB'));
        stream.end(Buffer.from('CC\r\n'));
    });

    test.ok(error, 'the mixed final chunk is measured too');
    test.equal(error.code, 'LineTooLarge');
    test.equal(error.lineLength, 20, 'length covers every byte of the line plus the terminator');
    test.deepEqual(payloads, [], 'nothing is emitted');
    test.done();
};

module.exports['Parser limits: nothing is parsed after LineTooLarge'] = async test => {
    // Both the remaining bytes of the offending chunk and any later chunk must be dropped:
    // resynchronizing at the next LF would turn rejected payload back into protocol.
    const settledWrites = [];
    const { payloads, error } = await runStream({ maxLineLength: 16 }, stream => {
        stream.write(Buffer.from('* OK ' + 'A'.repeat(64) + '\r\n* 9999 EXISTS\r\n'), () => settledWrites.push('first'));
        stream.write(Buffer.from('* CAPABILITY INJECTED\r\n'), () => settledWrites.push('second'));
    });

    test.ok(error, 'the stream failed');
    test.equal(error.code, 'LineTooLarge');
    test.deepEqual(payloads, [], 'no command from the offending chunk or from the queued chunk');
    test.equal(settledWrites.length, 2, 'every pending write callback settles, so the writer cannot hang');
    test.done();
};

module.exports['Parser limits: oversized literal emits no command and no literal body'] = async test => {
    // The reproduction from the remediation plan. With a lowered cap, the literal body is
    // ordinary message content chosen by whoever sent the mail, so none of it may be parsed.
    const { payloads, error } = await runStream({ maxLiteralSize: 1024 }, stream => {
        stream.write(
            Buffer.from(
                '* 1 FETCH (BODY[] {5000}\r\n' + //
                    'INNOCENT MESSAGE TEXT\r\n' +
                    '* 9999 EXISTS\r\n' +
                    '3 OK forged completion\r\n'
            )
        );
    });

    test.ok(error, 'the oversized literal fails the stream');
    test.equal(error.code, 'LiteralTooLarge');
    test.equal(error.literalSize, 5000);
    test.equal(error.maxSize, 1024);
    test.deepEqual(payloads, [], 'not even the marker line is emitted');
    test.done();
};

module.exports['Parser limits: literal exactly at the cap is accepted'] = async test => {
    const { payloads, error } = await runStream({ maxLiteralSize: 5 }, stream => stream.end(Buffer.from('* 1 FETCH (BODY[] {5}\r\nHELLO)\r\n')));

    test.equal(error, null, 'a literal at exactly the cap must not fail');
    test.equal(payloads.length, 1, 'the command is emitted');
    test.done();
};

module.exports['Parser limits: valid commands before the failure are still delivered'] = async test => {
    // A limit violation is terminal, but responses that were already complete and legitimate
    // when it happened stay delivered - the guarantee is that nothing *after* it is parsed.
    const { payloads, error } = await runStream({ maxLineLength: 24 }, stream => {
        stream.write(Buffer.from('* OK before\r\n'));
        stream.write(Buffer.from('* OK ' + 'A'.repeat(64) + '\r\n* OK after\r\n'));
    });

    test.ok(error, 'the stream failed on the oversized line');
    test.deepEqual(payloads, ['* OK before'], 'only the response that completed before the failure');
    test.done();
};

module.exports['Parser limits: a failed stream refuses further input'] = async test => {
    const stream = new ImapStream({ cid: 'test', maxLineLength: 8 });
    const payloads = [];

    stream.on('readable', () => {
        let cmd;
        while ((cmd = stream.read()) !== null) {
            payloads.push(cmd.payload.toString());
            cmd.next();
        }
    });

    await new Promise(resolve => {
        stream.on('error', () => resolve());
        stream.write(Buffer.from('A' + 'B'.repeat(32) + '\r\n'));
    });

    test.ok(stream.destroyed, 'the stream is destroyed, so parsing cannot continue');

    // Writing again must not resurrect parsing. The write is rejected by the destroyed
    // stream; the callback settles either way so nothing is left pending.
    await new Promise(resolve => stream.write(Buffer.from('* OK late\r\n'), () => resolve()));

    await new Promise(resolve => setImmediate(resolve));
    test.deepEqual(payloads, [], 'no command is emitted after the terminal failure');
    test.done();
};

module.exports['Parser limits: destroy settles an in-flight backpressure wait'] = async test => {
    // The consumer stops reading (never calls next()), then the stream is destroyed - as
    // ImapFlow.close() does. The pending push() wait and the pending transform callback must
    // both settle so nothing keeps the process alive.
    const stream = new ImapStream({ cid: 'test' });
    let writeSettled = false;

    stream.on('error', () => {});

    const gotCommand = new Promise(resolve => {
        stream.on('readable', () => {
            // read the command but deliberately do not call cmd.next()
            if (stream.read() !== null) {
                resolve();
            }
        });
    });

    stream.write(Buffer.from('* OK first\r\n* OK second\r\n'), () => (writeSettled = true));

    await gotCommand;
    test.ok(!writeSettled, 'the transform callback is still pending while the consumer stalls');

    stream.destroy();
    await new Promise(resolve => setImmediate(resolve));

    test.ok(writeSettled, 'destruction released the pending transform callback');
    test.equal(stream.pendingPush, null, 'the in-flight backpressure wait was settled');
    test.done();
};

// ---------------------------------------------------------------------------
// Standalone parser: inline literal allocation
// ---------------------------------------------------------------------------
// ImapStream always supplies pre-parsed literal buffers (and enforces its own cap first), so
// these cases only arise when the parser is used directly - where the declared literal length is
// untrusted input that must not decide an allocation.

module.exports['Parser limits: inline literal beyond the available input is rejected'] = async test => {
    let err = await parser('* 1 FETCH {1073741824}\r\nshort').then(
        () => null,
        e => e
    );

    test.ok(err, 'a declared literal larger than the input cannot be satisfied');
    test.equal(err.code, 'LiteralTooLarge', 'the ImapStream error shape is reused');
    test.equal(err.literalSize, 1073741824);
    test.ok(err.maxSize < 1073741824, 'the reported bound is the input actually available');
    test.done();
};

module.exports['Parser limits: inline literal honors a configured maxLiteralSize'] = async test => {
    let err = await parser('* 1 FETCH {5}\r\nHELLO', { maxLiteralSize: 4 }).then(
        () => null,
        e => e
    );

    test.ok(err, 'the configured cap applies to inline literals too');
    test.equal(err.code, 'LiteralTooLarge');
    test.equal(err.maxSize, 4);
    test.equal(err.literalSize, 5);
    test.done();
};

module.exports['Parser limits: inline literal within both bounds still parses'] = async test => {
    let parsed = await parser('* 1 FETCH {5}\r\nHELLO', { maxLiteralSize: 1024 });
    let literal = parsed.attributes[parsed.attributes.length - 1];

    test.equal(literal.type, 'LITERAL');
    test.equal(literal.value.toString(), 'HELLO');
    test.done();
};

module.exports['Parser limits: maxLiteralSize 0 rejects any non-empty inline literal'] = async test => {
    let err = await parser('* 1 FETCH {1}\r\nA', { maxLiteralSize: 0 }).then(
        () => null,
        e => e
    );

    test.ok(err, 'an explicit 0 cap is honored, not swallowed into the default');
    test.equal(err.code, 'LiteralTooLarge');
    test.equal(err.maxSize, 0);
    test.done();
};
