/* eslint new-cap: 0 */

'use strict';

const imapFormalSyntax = require('./imap-formal-syntax');

const { TokenParser } = require('./token-parser');

/**
 * Parses a single IMAP response line into its structural components: tag, command,
 * and attributes. Handles status responses (OK, NO, BAD, PREAUTH, BYE) with their
 * human-readable text and response codes, as well as continuation responses ("+").
 */
class ParserInstance {
    /**
     * Creates a new ParserInstance for parsing an IMAP response line.
     *
     * @param {Buffer|string} input - The raw IMAP response line to parse.
     * @param {Object} [options] - Parser options passed through to the TokenParser for attribute parsing.
     * @param {boolean} [options.literalPlus] - Whether the LITERAL+ extension is in use.
     * @param {Array<Buffer>} [options.literals] - Pre-parsed literal values from the stream.
     */
    constructor(input, options) {
        this.input = (input || '').toString();
        this.options = options || {};
        this.remainder = this.input;
        this.pos = 0;
    }

    /**
     * Extracts and returns the IMAP tag from the beginning of the response.
     * The tag is typically "*" for untagged responses, "+" for continuation requests,
     * or a client-assigned command tag like "A1".
     *
     * @returns {Promise<string>} The parsed tag string.
     * @throws {Error} If the tag contains invalid characters.
     */
    async getTag() {
        if (!this.tag) {
            this.tag = await this.getElement(imapFormalSyntax.tag() + '*+', true);
        }
        return this.tag;
    }

    /**
     * Extracts and returns the IMAP command or response name from the input.
     * For continuation responses (tag "+"), returns an empty string and stores
     * the remainder as human-readable text. For status responses (OK, NO, BAD,
     * PREAUTH, BYE), separates the optional response code from the human-readable text.
     *
     * @returns {Promise<string>} The parsed command string.
     * @throws {Error} If the command contains invalid characters or input ends unexpectedly.
     */
    async getCommand() {
        if (this.tag === '+') {
            // special case
            this.humanReadable = this.remainder.trim();
            this.remainder = '';

            return '';
        }

        if (!this.command) {
            this.command = await this.getElement(imapFormalSyntax.command());
        }

        // Status responses have the format: TAG OK/NO/BAD [response-code] human-readable text
        // Example: * OK [CAPABILITY IMAP4rev1] Server ready
        // Example: A1 NO [AUTHENTICATIONFAILED] Invalid credentials
        // We need to separate the optional [response-code] from the human-readable text.
        switch ((this.command || '').toString().toUpperCase()) {
            case 'OK':
            case 'NO':
            case 'BAD':
            case 'PREAUTH':
            case 'BYE':
                {
                    let match = this.remainder.match(/^\s+\[/);
                    if (match) {
                        let nesting = 1;
                        for (let i = match[0].length; i <= this.remainder.length; i++) {
                            let c = this.remainder[i];

                            if (c === '[') {
                                nesting++;
                            } else if (c === ']') {
                                nesting--;
                            }
                            if (!nesting) {
                                this.humanReadable = this.remainder.substring(i + 1).trim();
                                this.remainder = this.remainder.substring(0, i + 1);
                                break;
                            }
                        }
                    } else {
                        this.humanReadable = this.remainder.trim();
                        this.remainder = '';
                    }
                }
                break;
        }

        return this.command;
    }

    /**
     * Extracts the next whitespace-delimited element from the input and validates it
     * against the given syntax character set. Advances the parser position past the element.
     *
     * @param {string} syntax - A string of allowed characters for the element (as returned by imap-formal-syntax methods).
     * @returns {Promise<string>} The extracted element string.
     * @throws {Error} If the element contains characters not in the syntax set, or if input ends unexpectedly.
     */
    async getElement(syntax) {
        let match, element, errPos;

        if (this.remainder.match(/^\s/)) {
            let error = new Error(`Unexpected whitespace at position ${this.pos} [E1]`);
            error.code = 'ParserError1';
            error.parserContext = { input: this.input, pos: this.pos };
            throw error;
        }

        if ((match = this.remainder.match(/^\s*[^\s]+(?=\s|$)/))) {
            element = match[0];
            if ((errPos = imapFormalSyntax.verify(element, syntax)) >= 0) {
                if (this.tag === 'Server' && element === 'Unavailable.') {
                    // Microsoft Exchange sometimes sends a non-standard response
                    // "Server Unavailable." instead of a proper IMAP tagged/untagged response.
                    // We detect this specific pattern and convert it into a synthetic BAD response
                    // so the rest of the parser can handle it gracefully.
                    let error = new Error(`Server returned an error: ${this.input}`);
                    error.code = 'ParserErrorExchange';
                    error.parserContext = {
                        input: this.input,
                        element,
                        pos: this.pos,
                        value: {
                            tag: '*',
                            command: 'BAD',
                            attributes: [{ type: 'TEXT', value: this.input }]
                        }
                    };
                    throw error;
                }

                let error = new Error(`Unexpected char at position ${this.pos + errPos} [E2: ${JSON.stringify(element.charAt(errPos))}]`);
                error.code = 'ParserError2';
                error.parserContext = { input: this.input, element, pos: this.pos };
                throw error;
            }
        } else {
            let error = new Error(`Unexpected end of input at position ${this.pos} [E3]`);
            error.code = 'ParserError3';
            error.parserContext = { input: this.input, pos: this.pos };
            throw error;
        }

        this.pos += match[0].length;
        this.remainder = this.remainder.substr(match[0].length);

        return element;
    }

    /**
     * Consumes a single space character from the current position in the input.
     * Advances the parser position by one.
     *
     * @returns {Promise<void>}
     * @throws {Error} If the current character is not a space, or if input has ended unexpectedly.
     */
    async getSpace() {
        if (!this.remainder.length) {
            if (this.tag === '+' && this.pos === 1) {
                // special case, empty + response
                return;
            }

            let error = new Error(`Unexpected end of input at position ${this.pos} [E4]`);
            error.code = 'ParserError4';
            error.parserContext = { input: this.input, pos: this.pos };
            throw error;
        }

        if (imapFormalSyntax.verify(this.remainder.charAt(0), imapFormalSyntax.SP()) >= 0) {
            let error = new Error(`Unexpected char at position ${this.pos} [E5: ${JSON.stringify(this.remainder.charAt(0))}]`);
            error.code = 'ParserError5';
            error.parserContext = { input: this.input, element: this.remainder, pos: this.pos };
            throw error;
        }

        this.pos++;
        this.remainder = this.remainder.substr(1);
    }

    /**
     * Parses the remaining input as IMAP attributes using the TokenParser.
     * This handles complex structures including nested lists, literals, strings,
     * atoms, sections, sequences, and partial ranges.
     *
     * @returns {Promise<Array>} A promise that resolves to an array of parsed attribute objects.
     * @throws {Error} If the input contains unexpected whitespace, invalid characters, or ends unexpectedly.
     */
    async getAttributes() {
        if (!this.remainder.length) {
            let error = new Error(`Unexpected end of input at position ${this.pos} [E6]`);
            error.code = 'ParserError6';
            error.parserContext = { input: this.input, pos: this.pos };
            throw error;
        }

        if (this.remainder.match(/^\s/)) {
            let error = new Error(`Unexpected whitespace at position ${this.pos} [E7]`);
            error.code = 'ParserError7';
            error.parserContext = { input: this.input, element: this.remainder, pos: this.pos };
            throw error;
        }

        const tokenParser = new TokenParser(this, this.pos, this.remainder, this.options);

        return await tokenParser.getAttributes();
    }
}

module.exports.ParserInstance = ParserInstance;
