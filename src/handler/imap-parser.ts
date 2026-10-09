import imapFormalSyntax from './imap-formal-syntax.js';
import { ParserInstance } from './parser-instance.js';
import { createImapError, type ImapFlowError } from '../errors.js';
import { boundedInput } from './limits.js';
import type { ImapResponse, ParserOptions } from './types.js';

// The codes the parser raises on purpose: the numbered ParserErrorN codes, ParserErrorExchange,
// the nesting limit and the inline literal size limit
const PARSER_ERROR_CODES = /^(?:ParserError\d+|ParserErrorExchange|MAX_IMAP_NESTING_REACHED|LiteralTooLarge)$/;

/**
 * Anything the parser throws other than one of its own coded errors - a TypeError from a parser
 * bug, a RangeError from runaway recursion or a bad Buffer offset (which carries a Node code), a
 * thrown non-Error - is re-raised as a coded `ParserErrorInternal`, so callers that match on
 * codes still handle it and settle the command the line belonged to. The fuzz suite treats this
 * code as a failure, so the guard does not hide parser bugs from the tests.
 *
 * @param err - The thrown value
 * @param input - The line that was being parsed
 * @returns The error to rethrow
 */
function asParserError(err: unknown, input: Buffer | string): ImapFlowError {
    if (err instanceof Error && PARSER_ERROR_CODES.test((err as ImapFlowError).code || '')) {
        return err;
    }
    return createImapError(`Unexpected parser failure: ${err instanceof Error ? err.message : String(err)}`, 'ParserErrorInternal', {
        parserContext: boundedInput(input.toString()),
        ...(err instanceof Error ? { _err: err } : {})
    });
}

/**
 * Parses a raw IMAP command or response buffer into a structured object.
 * Handles edge cases such as null-byte-padded responses from buggy servers and
 * multi-word commands like UID and AUTHENTICATE.
 *
 * @param command - The raw IMAP command or response data to parse.
 * @param options - Parser options passed through to the underlying ParserInstance and TokenParser.
 * @param options.literalPlus - Whether the LITERAL+ extension is in use.
 * @param options.literals - Pre-parsed literal values extracted from the input stream.
 * @returns A promise that resolves to a parsed response object with `tag` (the IMAP tag, e.g. "*",
 *   "+", or a command tag like "A1"), `command` (the IMAP command or response name, e.g. "OK",
 *   "FETCH"), `attributes` (parsed attributes of the response) and `nullBytesRemoved` (number of
 *   leading null bytes removed, if any).
 */
export default async function parser(command: Buffer | string, options?: ParserOptions | undefined): Promise<ImapResponse> {
    options = options || {};

    let nullBytesRemoved = 0;

    // Workaround for buggy IMAP servers that pad responses with leading NUL (\x00) bytes.
    // Some servers (observed in the wild) prepend null bytes to their output, which would
    // cause parsing to fail. We strip them and note how many were removed for diagnostics.
    if (command[0] === 0) {
        // find the first non null byte and trim
        let firstNonNull = -1;
        for (let i = 0; i < command.length; i++) {
            if (command[i] !== 0) {
                firstNonNull = i;
                break;
            }
        }
        if (firstNonNull === -1) {
            // All bytes are null, treat as a BAD response
            return { tag: '*', command: 'BAD', attributes: [] };
        }
        command = command.slice(firstNonNull);
        nullBytesRemoved = firstNonNull;
    }

    const parserInstance = new ParserInstance(command, options);
    const response: ImapResponse = {};

    try {
        response.tag = await parserInstance.getTag();

        await parserInstance.getSpace();

        response.command = await parserInstance.getCommand();

        if (nullBytesRemoved) {
            response.nullBytesRemoved = nullBytesRemoved;
        }

        // Some IMAP commands are multi-word: "UID FETCH", "UID STORE", "UID COPY",
        // "UID MOVE", "UID SEARCH", "UID EXPUNGE", and "AUTHENTICATE PLAIN", etc.
        // For these, the first word is consumed as the command, then we read the
        // subcommand and concatenate them (e.g., "UID" + " " + "FETCH" -> "UID FETCH").
        if (['UID', 'AUTHENTICATE'].includes((response.command || '').toUpperCase())) {
            await parserInstance.getSpace();
            response.command += ' ' + (await parserInstance.getElement(imapFormalSyntax.command()));
        }

        if (parserInstance.remainder.trim().length) {
            await parserInstance.getSpace();
            response.attributes = await parserInstance.getAttributes();
        }

        if (parserInstance.humanReadable) {
            response.attributes = (response.attributes || []).concat({
                type: 'TEXT',
                value: parserInstance.humanReadable
            });
        }
    } catch (err) {
        let error = asParserError(err, command);
        if (error.code === 'ParserErrorExchange' && error.parserContext && error.parserContext.value) {
            return error.parserContext.value as ImapResponse;
        }
        if (response.tag) {
            // The tag had already been parsed when the rest of the line failed. Expose it
            // so the connection can settle the command this line was addressed to - unlike
            // re-deriving the tag from the raw bytes, this inherits the leading-NUL
            // workaround above.
            error.parsedTag = response.tag;
        }
        throw error;
    }

    return response;
}
