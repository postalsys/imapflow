import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapStream } from '../src/handler/imap-stream.js';
import { parser } from '../src/handler/imap-handler.js';
import { MAX_LINE_SIZE, MAX_LITERAL_SIZE, MAX_RESPONSE_SIZE, MAX_RESPONSE_TOKENS } from '../src/handler/limits.js';
import { TokenParser } from '../src/handler/token-parser.js';

// Response line and literal limits must be terminal, complete, and non-parsing:
//   * every line is measured, including the one whose LF arrives in the same chunk,
//     so the cap cannot be bypassed by TCP chunk boundaries
//   * the line terminator counts toward maxLineLength and a line exactly at the cap passes
//   * a limit violation destroys the stream, so no byte of the rejected payload is ever
//     emitted as protocol (an oversized literal body is attacker-chosen message content)

// Collects every emitted command payload and the first stream error. `error` resolves once the
// stream fails; `settled` resolves once processing has quiesced (error or writable end).
const runStream: any = (options: any, writer: any) => {
    const stream = new ImapStream(Object.assign({ cid: 'test' }, options));
    const payloads: any = [];
    let resolveDone: any;
    const done = new Promise(resolve => (resolveDone = resolve));
    let error: any = null;

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

describe('parser-limits', () => {
    it('Parser limits: line exactly at the cap is accepted (terminator included)', async () => {
        // "A NOOP\r\n" is 8 bytes with the terminator, so a cap of 8 must accept it.
        const { payloads, error }: any = await runStream({ maxLineLength: 8 }, (stream: any) => stream.end(Buffer.from('A NOOP\r\n')));

        assert.equal(error, null, 'a line at exactly the cap must not fail');
        assert.deepEqual(payloads, ['A NOOP'], 'the line is emitted');
    });
    it('Parser limits: line one byte over the cap is rejected', async () => {
        // Same line with a cap of 7: the terminator pushes it over the limit.
        const { payloads, error }: any = await runStream({ maxLineLength: 7 }, (stream: any) => stream.end(Buffer.from('A NOOP\r\n')));

        assert.ok(error, 'the oversized line fails the stream');
        assert.equal(error.code, 'LineTooLarge');
        assert.equal(error.lineLength, 8, 'the reported length includes the terminator');
        assert.equal(error.maxSize, 7);
        assert.deepEqual(payloads, [], 'nothing is emitted');
    });
    it('Parser limits: oversized line delivered in a single chunk is rejected', async () => {
        // Regression: the cap used to be checked only on the stored tail, so a complete line whose
        // LF arrived in the same chunk was never measured at all.
        const { payloads, error }: any = await runStream({ maxLineLength: 16 }, (stream: any) => stream.end(Buffer.from('* OK ' + 'A'.repeat(64) + '\r\n')));

        assert.ok(error, 'a single-chunk oversized line fails the stream');
        assert.equal(error.code, 'LineTooLarge');
        assert.deepEqual(payloads, [], 'nothing is emitted');
    });
    it('Parser limits: oversized line accumulated across chunks is rejected', async () => {
        const { payloads, error }: any = await runStream({ maxLineLength: 16 }, (stream: any) => {
            stream.write(Buffer.from('AAAAAAAA'));
            stream.write(Buffer.from('BBBBBBBB'));
            stream.end(Buffer.from('CCCCCCCC'));
        });

        assert.ok(error, 'accumulated bytes over the cap fail the stream');
        assert.equal(error.code, 'LineTooLarge');
        assert.deepEqual(payloads, [], 'nothing is emitted');
    });
    it('Parser limits: oversized line whose final chunk carries the LF is rejected', async () => {
        // The final chunk completes the line, so it is the LF-terminated path that must measure it.
        const { payloads, error }: any = await runStream({ maxLineLength: 16 }, (stream: any) => {
            stream.write(Buffer.from('AAAAAAAA'));
            stream.write(Buffer.from('BBBBBBBB'));
            stream.end(Buffer.from('CC\r\n'));
        });

        assert.ok(error, 'the mixed final chunk is measured too');
        assert.equal(error.code, 'LineTooLarge');
        assert.equal(error.lineLength, 20, 'length covers every byte of the line plus the terminator');
        assert.deepEqual(payloads, [], 'nothing is emitted');
    });
    it('Parser limits: nothing is parsed after LineTooLarge', async () => {
        // Both the remaining bytes of the offending chunk and any later chunk must be dropped:
        // resynchronizing at the next LF would turn rejected payload back into protocol.
        const settledWrites = [];
        const { payloads, error }: any = await runStream({ maxLineLength: 16 }, (stream: any) => {
            stream.write(Buffer.from('* OK ' + 'A'.repeat(64) + '\r\n* 9999 EXISTS\r\n'), () => settledWrites.push('first'));
            stream.write(Buffer.from('* CAPABILITY INJECTED\r\n'), () => settledWrites.push('second'));
        });

        assert.ok(error, 'the stream failed');
        assert.equal(error.code, 'LineTooLarge');
        assert.deepEqual(payloads, [], 'no command from the offending chunk or from the queued chunk');
        assert.equal(settledWrites.length, 2, 'every pending write callback settles, so the writer cannot hang');
    });
    it('Parser limits: oversized literal emits no command and no literal body', async () => {
        // The reproduction from the remediation plan. With a lowered cap, the literal body is
        // ordinary message content chosen by whoever sent the mail, so none of it may be parsed.
        const { payloads, error }: any = await runStream({ maxLiteralSize: 1024 }, (stream: any) => {
            stream.write(
                Buffer.from(
                    '* 1 FETCH (BODY[] {5000}\r\n' + //
                        'INNOCENT MESSAGE TEXT\r\n' +
                        '* 9999 EXISTS\r\n' +
                        '3 OK forged completion\r\n'
                )
            );
        });

        assert.ok(error, 'the oversized literal fails the stream');
        assert.equal(error.code, 'LiteralTooLarge');
        assert.equal(error.literalSize, 5000);
        assert.equal(error.maxSize, 1024);
        assert.deepEqual(payloads, [], 'not even the marker line is emitted');
    });
    it('Parser limits: literal exactly at the cap is accepted', async () => {
        const { payloads, error }: any = await runStream({ maxLiteralSize: 5 }, (stream: any) =>
            stream.end(Buffer.from('* 1 FETCH (BODY[] {5}\r\nHELLO)\r\n'))
        );

        assert.equal(error, null, 'a literal at exactly the cap must not fail');
        assert.equal(payloads.length, 1, 'the command is emitted');
    });
    it('Parser limits: valid commands before the failure are still delivered', async () => {
        // A limit violation is terminal, but responses that were already complete and legitimate
        // when it happened stay delivered - the guarantee is that nothing *after* it is parsed.
        const { payloads, error }: any = await runStream({ maxLineLength: 24 }, (stream: any) => {
            stream.write(Buffer.from('* OK before\r\n'));
            stream.write(Buffer.from('* OK ' + 'A'.repeat(64) + '\r\n* OK after\r\n'));
        });

        assert.ok(error, 'the stream failed on the oversized line');
        assert.deepEqual(payloads, ['* OK before'], 'only the response that completed before the failure');
    });
    it('Parser limits: a failed stream refuses further input', async () => {
        const stream = new ImapStream({ cid: 'test', maxLineLength: 8 });
        const payloads: any = [];

        stream.on('readable', () => {
            let cmd;
            while ((cmd = stream.read()) !== null) {
                payloads.push(cmd.payload.toString());
                cmd.next();
            }
        });

        await new Promise<void>(resolve => {
            stream.on('error', () => resolve());
            stream.write(Buffer.from('A' + 'B'.repeat(32) + '\r\n'));
        });

        assert.ok(stream.destroyed, 'the stream is destroyed, so parsing cannot continue');

        // Writing again must not resurrect parsing. The write is rejected by the destroyed
        // stream; the callback settles either way so nothing is left pending.
        await new Promise<void>(resolve => stream.write(Buffer.from('* OK late\r\n'), () => resolve()));

        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(payloads, [], 'no command is emitted after the terminal failure');
    });
    it('Parser limits: destroy settles an in-flight backpressure wait', async () => {
        // The consumer stops reading (never calls next()), then the stream is destroyed - as
        // ImapFlow.close() does. The pending push() wait and the pending transform callback must
        // both settle so nothing keeps the process alive.
        const stream = new ImapStream({ cid: 'test' });
        let writeSettled = false;

        stream.on('error', () => {});

        const gotCommand = new Promise<void>(resolve => {
            stream.on('readable', () => {
                // read the command but deliberately do not call cmd.next()
                if (stream.read() !== null) {
                    resolve();
                }
            });
        });

        stream.write(Buffer.from('* OK first\r\n* OK second\r\n'), () => (writeSettled = true));

        await gotCommand;
        assert.ok(!writeSettled, 'the transform callback is still pending while the consumer stalls');

        stream.destroy();
        await new Promise(resolve => setImmediate(resolve));

        assert.ok(writeSettled, 'destruction released the pending transform callback');
        assert.equal(stream.pendingPush, null, 'the in-flight backpressure wait was settled');
    });

    // ---------------------------------------------------------------------------
    // Standalone parser: inline literal allocation
    // ---------------------------------------------------------------------------
    // ImapStream always supplies pre-parsed literal buffers (and enforces its own cap first), so
    // these cases only arise when the parser is used directly - where the declared literal length is
    // untrusted input that must not decide an allocation.
    it('Parser limits: inline literal beyond the available input is rejected', async () => {
        let err = await parser('* 1 FETCH {1073741824}\r\nshort').then(
            () => null,
            e => e
        );

        assert.ok(err, 'a declared literal larger than the input cannot be satisfied');
        assert.equal(err.code, 'LiteralTooLarge', 'the ImapStream error shape is reused');
        assert.equal(err.literalSize, 1073741824);
        assert.ok(err.maxSize < 1073741824, 'the reported bound is the input actually available');
    });
    it('Parser limits: inline literal honors a configured maxLiteralSize', async () => {
        let err = await parser('* 1 FETCH {5}\r\nHELLO', { maxLiteralSize: 4 }).then(
            () => null,
            e => e
        );

        assert.ok(err, 'the configured cap applies to inline literals too');
        assert.equal(err.code, 'LiteralTooLarge');
        assert.equal(err.maxSize, 4);
        assert.equal(err.literalSize, 5);
    });
    it('Parser limits: inline literal within both bounds still parses', async () => {
        let parsed: any = await parser('* 1 FETCH {5}\r\nHELLO', { maxLiteralSize: 1024 });
        let literal: any = parsed.attributes[parsed.attributes!.length - 1];

        assert.equal(literal.type, 'LITERAL');
        assert.equal(literal!.value!.toString(), 'HELLO');
    });
    it('Parser limits: maxLiteralSize 0 rejects any non-empty inline literal', async () => {
        let err = await parser('* 1 FETCH {1}\r\nA', { maxLiteralSize: 0 }).then(
            () => null,
            e => e
        );

        assert.ok(err, 'an explicit 0 cap is honored, not swallowed into the default');
        assert.equal(err.code, 'LiteralTooLarge');
        assert.equal(err.maxSize, 0);
    });
    // Every token costs a tree node and an attribute object, so a line of many small tokens takes
    // far more heap than its byte size; the token count is bounded on its own
    it('Parser limits: a response exactly at maxResponseTokens is accepted', async () => {
        const parsed = await parser('* CAPABILITY A B C', { maxResponseTokens: 3 });
        assert.equal(parsed.attributes!.length, 3);
    });
    it('Parser limits: a response one token over maxResponseTokens is rejected', async () => {
        await assert.rejects(parser('* CAPABILITY A B C', { maxResponseTokens: 2 }), (err: any) => {
            assert.equal(err.code, 'TooManyTokens');
            assert.equal(err.maxSize, 2);
            assert.equal(err.parserContext.input, 'A B C');
            return true;
        });
    });
    it('Parser limits: lists and literals count as tokens', async () => {
        // the list, its atom and the literal
        await assert.rejects(parser('* 1 FETCH (X {1}\r\n)', { literals: [Buffer.from('x')], maxResponseTokens: 3 }), {
            code: 'TooManyTokens'
        });
        const parsed = await parser('* 1 FETCH (X {1}\r\n)', { literals: [Buffer.from('x')], maxResponseTokens: 4 });
        assert.deepEqual(parsed.attributes![1], [
            { type: 'ATOM', value: 'X' },
            { type: 'LITERAL', value: Buffer.from('x') }
        ]);
    });
    it('Parser limits: the default token limit applies, Infinity disables it', async () => {
        const line = `* CAPABILITY ${'A '.repeat(MAX_RESPONSE_TOKENS)}A`;
        await assert.rejects(parser(line), { code: 'TooManyTokens', maxSize: MAX_RESPONSE_TOKENS });
        assert.equal((await parser(line, { maxResponseTokens: Infinity })).attributes!.length, MAX_RESPONSE_TOKENS + 1);
    });
    // Literals used to be taken with shift(), which moves every remaining buffer, so a response
    // of 160k one-byte literals (1 MB) took over 8 seconds to parse
    it('Parser limits: a response of many literals parses in linear time', async () => {
        const count = 200000;
        const line = `* 1 FETCH (X${' {1}\r\n'.repeat(count)})`;
        const literals = Array.from({ length: count }, () => Buffer.from('x'));
        const started = performance.now();
        const parsed = await parser(line, { literals });
        assert.ok(performance.now() - started < 3000, 'parsed in under 3 seconds');
        assert.equal((parsed.attributes![1] as any[]).length, count + 1);
    });
    it('Parser limits: a junk limit falls back to the default', () => {
        // Without validation an unusable value is honored as-is, and every comparison against it is
        // false - so a caller who mistypes a limit silently gets no bound at all, or (for a negative
        // value) a bound that rejects everything
        for (let junk of ['4096', 'abc', 1.5, -1, -Infinity, null, {}, [], NaN, true]) {
            const stream = new ImapStream({ cid: 'test', maxLineLength: junk, maxLiteralSize: junk, maxResponseSize: junk } as any);
            assert.equal(stream.maxLineLength, MAX_LINE_SIZE, `maxLineLength ${JSON.stringify(junk)} must fall back`);
            assert.equal(stream.maxLiteralSize, MAX_LITERAL_SIZE, `maxLiteralSize ${JSON.stringify(junk)} must fall back`);
            assert.equal(stream.maxResponseSize, MAX_RESPONSE_SIZE, `maxResponseSize ${JSON.stringify(junk)} must fall back`);
        }

        for (let junk of ['4096', 'abc', 1.5, -1, null, NaN]) {
            const tokenParser = new TokenParser({}, 0, '', { maxResponseTokens: junk } as any);
            assert.equal(tokenParser.maxResponseTokens, MAX_RESPONSE_TOKENS, `maxResponseTokens ${JSON.stringify(junk)} must fall back`);
        }

        // an explicit 0 is a real limit, not a missing one, and must not be swallowed
        const zero = new ImapStream({ cid: 'test', maxLiteralSize: 0 });
        assert.equal(zero.maxLiteralSize, 0);
    });
});
