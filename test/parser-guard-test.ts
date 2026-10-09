import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parser } from '../src/handler/imap-handler.js';
import { ParserInstance } from '../src/handler/parser-instance.js';
import { ERROR_CONTEXT_LENGTH } from '../src/handler/limits.js';
import { createImapError, type ImapFlowError } from '../src/errors.js';
import { createServer, listen, makeClient } from './fixtures/scripted-server.js';

// Replaces ParserInstance#getCommand so that parsing a line containing `marker` throws `thrown`
// once the tag has been read, as a parser bug past the tag would
const failCommandParsing = (t: any, marker: string, thrown: unknown) => {
    const original = ParserInstance.prototype.getCommand;
    t.mock.method(ParserInstance.prototype, 'getCommand', function (this: ParserInstance) {
        if (this.input.includes(marker)) {
            throw thrown;
        }
        return original.call(this);
    });
};

const parseError = async (input: Buffer | string): Promise<ImapFlowError> => {
    try {
        await parser(input);
    } catch (err) {
        return err as ImapFlowError;
    }
    assert.fail('the line must fail to parse');
};

describe('createImapError', () => {
    it('creates an Error with the message, code and extra properties', () => {
        const err = createImapError('Line too long', 'LineTooLarge', { lineLength: 10, maxSize: 5 });
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'Line too long');
        assert.equal(err.code, 'LineTooLarge');
        assert.equal(err.lineLength, 10);
        assert.equal(err.maxSize, 5);
    });

    it('accepts numbered parser codes and no extra properties', () => {
        const err = createImapError('Unexpected char', 'ParserError13');
        assert.equal(err.code, 'ParserError13');
        assert.deepEqual(Object.keys(err), ['code']);
    });

    it('rejects undeclared codes at compile time', () => {
        // @ts-expect-error not an ImapFlowErrorCode
        const err = createImapError('typo', 'NoConection');
        assert.equal(err.code, 'NoConection');
    });
});

describe('parser guard', () => {
    it('re-raises an unexpected TypeError as a coded parser error', async t => {
        const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
        failCommandParsing(t, 'TRIGGER', bug);

        const err = await parseError('A7 OK TRIGGER');
        assert.equal(err.code, 'ParserErrorInternal');
        assert.match(err.message, /Unexpected parser failure: Cannot read properties/);
        assert.equal(err._err, bug, 'the original exception is kept');
        assert.equal(err.parsedTag, 'A7', 'the tag read before the failure is exposed');
        assert.deepEqual(err.parserContext, { input: 'A7 OK TRIGGER', inputLength: 13 });
    });

    it('re-raises a thrown non-Error value', async t => {
        failCommandParsing(t, 'TRIGGER', 'plain string');
        const err = await parseError('A8 OK TRIGGER');
        assert.ok(err instanceof Error);
        assert.equal(err.code, 'ParserErrorInternal');
        assert.match(err.message, /plain string/);
        assert.equal(err._err, undefined);
    });

    it('re-raises a thrown null', async t => {
        failCommandParsing(t, 'TRIGGER', null);
        const err = await parseError('A9 OK TRIGGER');
        assert.equal(err.code, 'ParserErrorInternal');
        assert.equal(err.parsedTag, 'A9');
    });

    it('re-raises an error carrying a Node code', async t => {
        // A bad Buffer offset in the parser surfaces as a RangeError with a string code of its own
        const bug = Object.assign(new RangeError('The value of "offset" is out of range'), { code: 'ERR_OUT_OF_RANGE' });
        failCommandParsing(t, 'TRIGGER', bug);
        const err = await parseError('A4 OK TRIGGER');
        assert.equal(err.code, 'ParserErrorInternal');
        assert.equal(err._err, bug);
    });

    it('re-raises an Error with a non-string code', async t => {
        failCommandParsing(t, 'TRIGGER', Object.assign(new Error('numeric code'), { code: 42 }));
        const err = await parseError('A1 OK TRIGGER');
        assert.equal(err.code, 'ParserErrorInternal');
    });

    it('bounds the input carried by the error', async t => {
        failCommandParsing(t, 'TRIGGER', new RangeError('Maximum call stack size exceeded'));
        const line = Buffer.from('A2 OK TRIGGER ' + 'x'.repeat(ERROR_CONTEXT_LENGTH * 2));
        const err = await parseError(line);
        assert.equal(err.code, 'ParserErrorInternal');
        assert.equal(err.parserContext!.input.length, ERROR_CONTEXT_LENGTH);
        assert.equal(err.parserContext!.inputLength, line.length);
    });

    it('passes coded parser errors through unchanged', async () => {
        const err = await parseError('A3 OK [\x01BAD-CODE] done');
        assert.match(err.code!, /^ParserError\d+$/);
        assert.equal(err.parsedTag, 'A3');
    });

    it('fails the command whose tagged completion hit a parser bug', async t => {
        failCommandParsing(t, 'TRIGGER-PARSER-BUG', new TypeError('parser bug'));
        const server = createServer({
            handlers: {
                NOOP(ctx: any) {
                    ctx.ok('TRIGGER-PARSER-BUG');
                }
            }
        });
        const port = await listen(server);
        const client = makeClient(port);
        client.on('error', () => {});
        try {
            await client.connect();
            await assert.rejects((client as any).exec('NOOP'), (err: ImapFlowError) => {
                assert.equal(err.code, 'ParserErrorInternal');
                assert.equal(err.parserError!.code, 'ParserErrorInternal');
                return true;
            });
            // the connection is still usable
            const response = await (client as any).exec('CAPABILITY');
            response.next();
        } finally {
            client.close();
            server.close();
        }
    });
});
