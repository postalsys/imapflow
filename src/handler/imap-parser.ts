import imapFormalSyntax from './imap-formal-syntax.js';
import { ParserInstance } from './parser-instance.js';
import { createImapError, type ImapFlowError } from '../errors.js';
import { boundedInput } from './limits.js';
import type { ImapAttributeList, ImapResponse, ParserOptions } from './types.js';

// The codes the parser raises on purpose: the numbered ParserErrorN codes, ParserErrorExchange,
// the nesting limit, the inline literal size limit and the token limit
const PARSER_ERROR_CODES = /^(?:ParserError\d+|ParserErrorExchange|MAX_IMAP_NESTING_REACHED|LiteralTooLarge|TooManyTokens)$/;

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
 * Reads the numbers of an untagged SEARCH response, the part of the line after the command
 * (" 2 5 9"), into an array. A SEARCH answer holds one number per matching message, so on a
 * large mailbox one line carries millions of them, and run through the tokenizer each would
 * become a parse tree node and an attribute object, some 30 times the size of the line in heap.
 *
 * @param str - The rest of the line after the command
 * @returns The numbers, or null when the line holds anything but a space before every number
 *   and trailing spaces (a CONDSTORE MODSEQ list, extra spaces, a number past 2^53), which is
 *   left to the tokenizer
 */
function readSearchNumbers(str: string): number[] | null {
    // trailing spaces are tolerated, as the tokenizer does, some servers end the line with one
    let end = str.length;
    while (end > 1 && str.charCodeAt(end - 1) === 0x20) {
        end--;
    }
    if (end < 2 || str.charCodeAt(0) !== 0x20) {
        return null;
    }
    const numbers: number[] = [];
    // -1 until the first digit of the current number
    let value = -1;
    for (let i = 1; i < end; i++) {
        const c = str.charCodeAt(i);
        if (c === 0x20) {
            if (value < 0) {
                return null;
            }
            numbers.push(value);
            value = -1;
        } else if (c >= 0x30 && c <= 0x39) {
            value = (value < 0 ? 0 : value * 10) + (c - 0x30);
            // past 2^53 the digits no longer add up exactly, a line with such a number is left
            // to the tokenizer
            if (value > Number.MAX_SAFE_INTEGER) {
                return null;
            }
        } else {
            return null;
        }
    }
    if (value < 0) {
        return null;
    }
    numbers.push(value);
    return numbers;
}

// The CONDSTORE list that ends a SEARCH answer to a MODSEQ query (RFC 7162 section 3.1.5)
const RE_SEARCH_MODSEQ = /^ \(MODSEQ (\d{1,19})\) *$/i;

/**
 * Reads an untagged SEARCH response without the tokenizer, see readSearchNumbers(): the numbers,
 * and the MODSEQ value of a trailing CONDSTORE list. A MODSEQ query on a large mailbox matches as
 * many messages as any other, so its answer must not fall back to the tokenizer either.
 *
 * @param str - The rest of the line after the command
 * @returns The numbers, with the MODSEQ list as the attributes the tokenizer would have made of
 *   it, or null when the line is left to the tokenizer
 */
function readSearchResponse(str: string): { numbers: number[]; attributes?: ImapAttributeList | undefined } | null {
    // the last character tells whether there is a list to look for, without scanning the line
    if (!str.trimEnd().endsWith(')')) {
        const numbers = readSearchNumbers(str);
        return numbers && { numbers };
    }
    const open = str.lastIndexOf(' (');
    const match = open < 0 ? null : RE_SEARCH_MODSEQ.exec(str.slice(open));
    if (!match) {
        return null;
    }
    const numbers = readSearchNumbers(str.slice(0, open));
    return (
        numbers && {
            numbers,
            attributes: [
                [
                    { type: 'ATOM', value: 'MODSEQ' },
                    { type: 'ATOM', value: match[1] }
                ]
            ]
        }
    );
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
 *   "FETCH"), `attributes` (parsed attributes of the response), `numbers` (the numbers of an
 *   untagged SEARCH response that holds nothing else, instead of `attributes`) and
 *   `nullBytesRemoved` (number of leading null bytes removed, if any).
 */
export default async function parser(command: Buffer | string, options?: ParserOptions | undefined): Promise<ImapResponse> {
    options = options || {};

    let nullBytesRemoved = 0;

    // Workaround for buggy IMAP servers that pad responses with leading NUL (\x00) bytes.
    // Some servers (observed in the wild) prepend null bytes to their output, which would
    // cause parsing to fail. We strip them and note how many were removed for diagnostics.
    if (Buffer.isBuffer(command) && command[0] === 0) {
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
        command = command.subarray(firstNonNull);
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

        if (response.tag === '*' && (response.command || '').toUpperCase() === 'SEARCH') {
            const search = readSearchResponse(parserInstance.remainder);
            if (search) {
                return Object.assign(response, search);
            }
        }

        if (parserInstance.remainder.trim().length) {
            await parserInstance.getSpace();
            response.attributes = await parserInstance.getAttributes();
            if (parserInstance.truncatedAttributes && parserInstance.truncatedAttributes.length) {
                response.truncatedAttributes = parserInstance.truncatedAttributes;
            }
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
