'use strict';

const imapFormalSyntax = require('./imap-formal-syntax');
const { ParserInstance } = require('./parser-instance');

/**
 * Parses a raw IMAP command or response buffer into a structured object.
 * Handles edge cases such as null-byte-padded responses from buggy servers and
 * multi-word commands like UID and AUTHENTICATE.
 *
 * @param {Buffer|string} command - The raw IMAP command or response data to parse.
 * @param {Object} [options] - Parser options passed through to the underlying ParserInstance and TokenParser.
 * @param {boolean} [options.literalPlus] - Whether the LITERAL+ extension is in use.
 * @param {Array<Buffer>} [options.literals] - Pre-parsed literal values extracted from the input stream.
 * @returns {Promise<Object>} A promise that resolves to a parsed response object.
 * @returns {string} return.tag - The IMAP tag (e.g., "*", "+", or a command tag like "A1").
 * @returns {string} return.command - The IMAP command or response name (e.g., "OK", "FETCH").
 * @returns {Array} [return.attributes] - Parsed attributes of the response.
 * @returns {number} [return.nullBytesRemoved] - Number of leading null bytes removed, if any.
 */
module.exports = async (command, options) => {
    options = options || {};

    let nullBytesRemoved = 0;

    // special case with a buggy IMAP server where responses are padded with zero bytes
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
            // All bytes are null
            return { tag: '*', command: 'BAD', attributes: [] };
        }
        command = command.slice(firstNonNull);
        nullBytesRemoved = firstNonNull;
    }

    const parser = new ParserInstance(command, options);
    const response = {};

    try {
        response.tag = await parser.getTag();

        await parser.getSpace();

        response.command = await parser.getCommand();

        if (nullBytesRemoved) {
            response.nullBytesRemoved = nullBytesRemoved;
        }

        if (['UID', 'AUTHENTICATE'].indexOf((response.command || '').toUpperCase()) >= 0) {
            await parser.getSpace();
            response.command += ' ' + (await parser.getElement(imapFormalSyntax.command()));
        }

        if (parser.remainder.trim().length) {
            await parser.getSpace();
            response.attributes = await parser.getAttributes();
        }

        if (parser.humanReadable) {
            response.attributes = (response.attributes || []).concat({
                type: 'TEXT',
                value: parser.humanReadable
            });
        }
    } catch (err) {
        if (err.code === 'ParserErrorExchange' && err.parserContext && err.parserContext.value) {
            return err.parserContext.value;
        }
        throw err;
    }

    return response;
};
