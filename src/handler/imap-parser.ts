import imapFormalSyntax from './imap-formal-syntax.js';
import { ParserInstance } from './parser-instance.js';
import type { ImapFlowError } from '../errors.js';
import type { ImapResponse, ParserOptions } from './types.js';

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
        let error = err as ImapFlowError;
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
