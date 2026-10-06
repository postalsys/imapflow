import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapStream } from '../src/handler/imap-stream.js';
import { parser, compiler } from '../src/handler/imap-handler.js';
import type { ImapFlowError } from '../src/errors.js';
import type { ImapResponse } from '../src/handler/types.js';
import { frameStream } from './fixtures/stream-frame.js';
import { FUZZ_ITERATIONS, FUZZ_SEED, Rng, generateResponse, mutate, split } from './fixtures/imap-fuzz.js';

// Seeded fuzzing of the server response path: ImapStream framing followed by the parser.
//
// Generated responses come with the structure the parser must find, so the suite checks the
// parse result against the model, not only that parsing succeeded. On top of that:
//   * framing does not depend on how the bytes are chunked (TCP gives no guarantees), including
//     cuts inside a literal marker, inside a literal and between CR and LF
//   * compiling a parsed response and parsing it again yields the same response
//   * corrupted input never escapes as an uncoded error (a TypeError or RangeError means the
//     parser walked off a path it does not guard), never hangs, and fails only the response it
//     is in
//
// Reproduce a failure with FUZZ_SEED=<seed> FUZZ_ITERATIONS=1, using the seed in the message.

interface Framed {
    items: Array<{ payload: Buffer; literals: Buffer[] }>;
    error: ImapFlowError | null;
}

// Frames the chunks with a fresh ImapStream. Only payload and literals are kept: the rest of an
// item (its release callback, whether more input followed) legitimately depends on the chunking
const frame = async (chunks: Buffer[], options = {}): Promise<Framed> => {
    const { items, error } = await frameStream(new ImapStream({ cid: 'fuzz', logger: false, ...options } as any), chunks);
    return { items: items.map(({ payload, literals }) => ({ payload, literals })), error };
};

const parse = (item: Framed['items'][number]): Promise<ImapResponse> => parser(item.payload, { literals: item.literals.slice() });

// An error the parser or the stream is expected to raise carries a string code. Anything else
// (TypeError, RangeError, a thrown non-Error) is a bug
const assertCodedError = (err: unknown, context: string) => {
    assert.ok(err instanceof Error, `${context}: thrown value is not an Error: ${String(err)}`);
    assert.ok(
        !(err instanceof TypeError) && !(err instanceof RangeError),
        `${context}: ${err.constructor.name} escaped the parser: ${err.message}\n${err.stack}`
    );
    assert.equal(typeof (err as ImapFlowError).code, 'string', `${context}: error without a code: ${err.message}`);
};

const show = (buf: Buffer): string => JSON.stringify(buf.toString('latin1').slice(0, 300));

describe('parser fuzzing', () => {
    it('parses generated responses into the generated structure', async () => {
        const rng = new Rng(FUZZ_SEED);
        for (let n = 0; n < FUZZ_ITERATIONS; n++) {
            const { wire, expected } = generateResponse(rng);
            const context = `seed ${FUZZ_SEED} case ${n} ${show(wire)}`;
            const framed = await frame([Buffer.concat([wire, Buffer.from('\r\n')])]);
            assert.equal(framed.error, null, `${context}: ${framed.error?.message}`);
            assert.equal(framed.items.length, 1, context);
            let parsed: ImapResponse;
            try {
                parsed = await parse(framed.items[0]!);
            } catch (err) {
                assert.fail(`${context}: ${(err as Error).message}`);
            }
            assert.deepEqual(parsed, expected, context);
        }
    });

    it('frames the same responses however the input is chunked', async () => {
        const rng = new Rng(FUZZ_SEED + 1);
        for (let n = 0; n < FUZZ_ITERATIONS; n++) {
            const count = rng.int(1, 6);
            const wire = Buffer.concat(Array.from({ length: count }, () => Buffer.concat([generateResponse(rng).wire, Buffer.from('\r\n')])));
            const context = `seed ${FUZZ_SEED + 1} case ${n} ${show(wire)}`;

            const whole = await frame([wire]);
            assert.equal(whole.error, null, context);
            assert.equal(whole.items.length, count, context);

            const chunked = await frame(split(rng, wire));
            assert.equal(chunked.error, null, context);
            assert.deepEqual(chunked.items, whole.items, context);
        }
    });

    it('parses a compiled response back into the same response', async () => {
        const rng = new Rng(FUZZ_SEED + 2);
        for (let n = 0; n < FUZZ_ITERATIONS; n++) {
            const { wire, expected } = generateResponse(rng);
            const context = `seed ${FUZZ_SEED + 2} case ${n} ${show(wire)}`;
            // status text is free-form and is compiled as-is, so only data responses round-trip
            if (expected.attributes?.some(attr => attr && !Array.isArray(attr) && attr.type === 'TEXT')) {
                continue;
            }
            const compiled = await compiler(expected);
            const compiledContext = `${context} compiled ${show(compiled)}`;
            const framed = await frame([Buffer.concat([compiled, Buffer.from('\r\n')])]);
            assert.equal(framed.error, null, compiledContext);
            assert.equal(framed.items.length, 1, compiledContext);
            assert.deepEqual(await parse(framed.items[0]!), expected, compiledContext);
        }
    });

    it('rejects corrupted responses with coded errors only', async () => {
        const rng = new Rng(FUZZ_SEED + 3);
        // small limits so corrupted literal markers and lines hit the limit paths too
        const limits = { maxLiteralSize: 4096, maxLineLength: 16384, maxResponseSize: 65536 };
        for (let n = 0; n < FUZZ_ITERATIONS; n++) {
            const responses = Array.from({ length: rng.int(1, 4) }, () => generateResponse(rng).wire);
            const wire = mutate(rng, Buffer.concat(responses.flatMap(r => [r, Buffer.from('\r\n')])));
            const context = `seed ${FUZZ_SEED + 3} case ${n} ${show(wire)}`;

            const framed = await frame(split(rng, wire), limits);
            if (framed.error) {
                assertCodedError(framed.error, context);
            }
            for (const item of framed.items) {
                try {
                    await parse(item);
                } catch (err) {
                    assertCodedError(err, `${context} payload ${show(item.payload)}`);
                }
            }
        }
    });

    it('never lets a compiled command value break out of its command', async () => {
        // Command values often come from the caller (mailbox names, search terms, flags). Whatever
        // they contain, the compiler either refuses them with a coded error or writes a command
        // that frames as exactly one command whose values read back unchanged
        const rng = new Rng(FUZZ_SEED + 5);
        const hostile = '\r\n\0 "\\(){}[]<>*%~+:,aZ09\u00e9\u4e2d';
        const value = () => (rng.chance(0.5) ? rng.string(hostile, rng.int(0, 12)) : rng.bytes(rng.int(0, 12)).toString('latin1'));
        const allowedCodes = new Set(['InvalidStringValue', 'InvalidTokenValue', 'InvalidSequenceSet']);
        const kinds = [
            () => value(),
            () => ({ type: 'STRING', value: value() }),
            () => ({ type: 'ATOM', value: value() }),
            () => ({ type: 'SEQUENCE', value: value() }),
            () => ({ type: 'LITERAL', value: Buffer.from(value(), 'latin1') })
        ];

        for (let n = 0; n < FUZZ_ITERATIONS; n++) {
            const attributes: any[] = [];
            const count = rng.int(1, 5);
            for (let i = 0; i < count; i++) {
                attributes.push(rng.pick(kinds)());
            }
            const command = { tag: 'A' + n, command: 'X-FUZZ', attributes };
            const context = `seed ${FUZZ_SEED + 5} case ${n} ${JSON.stringify(attributes)}`;

            let compiled: Buffer;
            try {
                compiled = await compiler(command);
            } catch (err) {
                assertCodedError(err, context);
                assert.ok(allowedCodes.has((err as ImapFlowError).code!), `${context}: unexpected code ${(err as ImapFlowError).code}`);
                continue;
            }

            const compiledContext = `${context} compiled ${show(compiled)}`;
            // a server frames commands the way ImapStream frames responses: lines and {n} literals
            const framed = await frame([Buffer.concat([compiled, Buffer.from('\r\n')])]);
            assert.equal(framed.error, null, compiledContext);
            assert.equal(framed.items.length, 1, `${context}: command split into ${framed.items.length} ${show(compiled)}`);
            let parsed: ImapResponse;
            try {
                parsed = await parse(framed.items[0]!);
            } catch (err) {
                // The response parser reads a digit-led token with ":" or "," as a sequence set and
                // holds it to the sequence grammar (E29-E34), so an atom like "1:a", valid on the
                // wire, does not read back. Any other parse failure is a compiler bug
                assertCodedError(err, context);
                assert.match((err as ImapFlowError).code!, /^ParserError(29|3[0-4])$/, compiledContext);
                assert.ok(
                    attributes.some(attr => attr && attr.type === 'ATOM' && /^\d+[:,]/.test(attr.value)),
                    compiledContext
                );
                continue;
            }
            assert.equal(parsed.tag, command.tag, context);
            assert.equal(parsed.command, command.command, context);
            assert.equal((parsed.attributes || []).length, attributes.length, compiledContext);
        }
    });

    it('rejects corrupted lines passed straight to the parser with coded errors only', async () => {
        const rng = new Rng(FUZZ_SEED + 4);
        for (let n = 0; n < FUZZ_ITERATIONS; n++) {
            const line = mutate(rng, generateResponse(rng).wire);
            const context = `seed ${FUZZ_SEED + 4} case ${n} ${show(line)}`;
            // no literals supplied: the parser reads any literal inline from the line itself
            for (const options of [{}, { literals: [] as Buffer[] }, { literalPlus: true, maxLiteralSize: 1024 }]) {
                try {
                    await parser(line, options);
                } catch (err) {
                    assertCodedError(err, `${context} options ${JSON.stringify(options)}`);
                }
            }
        }
    });
});
