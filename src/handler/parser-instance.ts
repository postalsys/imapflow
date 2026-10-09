/* eslint new-cap: 0 */

import imapFormalSyntax from './imap-formal-syntax.js';
import { TokenParser } from './token-parser.js';
import { boundedInput } from './limits.js';
import { createImapError } from '../errors.js';
import type { ImapAttributeList, ParserOptions } from './types.js';

/**
 * Parses a single IMAP response line into its structural components: tag, command,
 * and attributes. Handles status responses (OK, NO, BAD, PREAUTH, BYE) with their
 * human-readable text and response codes, as well as continuation responses ("+").
 */
export class ParserInstance {
    input: string;
    options: ParserOptions;
    remainder: string;
    pos: number;
    declare tag?: string | undefined;
    declare command?: string | undefined;
    declare humanReadable?: string | undefined;

    /**
     * Creates a new ParserInstance for parsing an IMAP response line.
     *
     * @param input - The raw IMAP response line to parse.
     * @param options - Parser options passed through to the TokenParser for attribute parsing.
     * @param options.literalPlus - Whether the LITERAL+ extension is in use.
     * @param options.literals - Pre-parsed literal values from the stream.
     */
    constructor(input?: Buffer | string | null | undefined, options?: ParserOptions | undefined) {
        this.input = (input || '').toString();
        this.options = options || {};
        this.remainder = this.input;
        this.pos = 0;
    }

    /**
     * The context a parse error carries: a bounded prefix of the input (and of the element that
     * failed, when there is one) with their full lengths, and the position.
     *
     * @param element - The element that failed to parse
     * @returns The context to attach to the error
     */
    errorContext(element?: string | undefined): { [key: string]: unknown } {
        let context: { [key: string]: unknown } = { ...boundedInput(this.input), pos: this.pos };
        if (element !== undefined) {
            let bounded = boundedInput(element);
            context.element = bounded.input;
            context.elementLength = bounded.inputLength;
        }
        return context;
    }

    /**
     * Extracts and returns the IMAP tag from the beginning of the response.
     * The tag is typically "*" for untagged responses, "+" for continuation requests,
     * or a client-assigned command tag like "A1".
     *
     * @returns The parsed tag string.
     * @throws {Error} If the tag contains invalid characters.
     */
    async getTag(): Promise<string> {
        if (!this.tag) {
            this.tag = await this.getElement(imapFormalSyntax.tag() + '*+');
        }
        return this.tag;
    }

    /**
     * Extracts and returns the IMAP command or response name from the input.
     * For continuation responses (tag "+"), returns an empty string and stores
     * the remainder as human-readable text. For status responses (OK, NO, BAD,
     * PREAUTH, BYE), separates the optional response code from the human-readable text.
     *
     * @returns The parsed command string.
     * @throws {Error} If the command contains invalid characters or input ends unexpectedly.
     */
    async getCommand(): Promise<string> {
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
                        // Find the ']' that closes the response code. Inner brackets are
                        // tracked because servers do put bracketed values inside a code
                        // (e.g. a "[css3-page]" keyword in a PERMANENTFLAGS list), which a
                        // first-']' scan would cut in half.
                        let nesting = 1;
                        let end = -1;
                        for (let i = match[0].length; i < this.remainder.length; i++) {
                            let c = this.remainder[i];

                            if (c === '[') {
                                nesting++;
                            } else if (c === ']') {
                                nesting--;
                            }
                            if (!nesting) {
                                end = i;
                                break;
                            }
                        }

                        // Unbalanced '[' inside the code: the RFC 9051 free-text form
                        // (`atom [SP 1*<any TEXT-CHAR except "]">]`) permits '[' but not
                        // ']', so the code really does end at the first ']' here. Without
                        // this fallback the scan finds no closing bracket at all and the
                        // human-readable text - what every error message is built from -
                        // is swallowed into the response code.
                        if (end < 0) {
                            end = this.remainder.indexOf(']', match[0].length);
                        }

                        if (end >= 0) {
                            this.humanReadable = this.remainder.substring(end + 1).trim();
                            this.remainder = this.remainder.substring(0, end + 1);
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
     * @param syntax - A string of allowed characters for the element (as returned by imap-formal-syntax methods).
     * @returns The extracted element string.
     * @throws {Error} If the element contains characters not in the syntax set, or if input ends unexpectedly.
     */
    async getElement(syntax: string): Promise<string> {
        let match: RegExpMatchArray | null, element: string, errPos: number;

        if (/^\s/.test(this.remainder)) {
            throw createImapError(`Unexpected whitespace at position ${this.pos} [E1]`, 'ParserError1', { parserContext: this.errorContext() });
        }

        if ((match = this.remainder.match(/^\s*[^\s]+(?=\s|$)/))) {
            element = match[0];
            if ((errPos = imapFormalSyntax.verify(element, syntax)) >= 0) {
                if (this.tag === 'Server' && element === 'Unavailable.') {
                    // Microsoft Exchange sometimes sends a non-standard response
                    // "Server Unavailable." instead of a proper IMAP tagged/untagged response.
                    // We detect this specific pattern and convert it into a synthetic BAD response
                    // so the rest of the parser can handle it gracefully.
                    throw createImapError(`Server returned an error: ${this.input}`, 'ParserErrorExchange', {
                        parserContext: {
                            ...this.errorContext(element),
                            value: {
                                tag: '*',
                                command: 'BAD',
                                attributes: [{ type: 'TEXT', value: this.input }]
                            }
                        }
                    });
                }

                throw createImapError(`Unexpected char at position ${this.pos + errPos} [E2: ${JSON.stringify(element.charAt(errPos))}]`, 'ParserError2', {
                    parserContext: this.errorContext(element)
                });
            }
        } else {
            throw createImapError(`Unexpected end of input at position ${this.pos} [E3]`, 'ParserError3', { parserContext: this.errorContext() });
        }

        this.pos += match[0].length;
        this.remainder = this.remainder.slice(match[0].length);

        return element;
    }

    /**
     * Consumes a single space character from the current position in the input.
     * Advances the parser position by one.
     *
     * @throws {Error} If the current character is not a space, or if input has ended unexpectedly.
     */
    async getSpace(): Promise<void> {
        if (!this.remainder.length) {
            if (this.tag === '+' && this.pos === 1) {
                // special case, empty + response
                return;
            }

            throw createImapError(`Unexpected end of input at position ${this.pos} [E4]`, 'ParserError4', { parserContext: this.errorContext() });
        }

        if (imapFormalSyntax.verify(this.remainder.charAt(0), imapFormalSyntax.SP()) >= 0) {
            throw createImapError(`Unexpected char at position ${this.pos} [E5: ${JSON.stringify(this.remainder.charAt(0))}]`, 'ParserError5', {
                parserContext: this.errorContext(this.remainder)
            });
        }

        this.pos++;
        this.remainder = this.remainder.slice(1);
    }

    /**
     * Parses the remaining input as IMAP attributes using the TokenParser.
     * This handles complex structures including nested lists, literals, strings,
     * atoms, sections, sequences, and partial ranges.
     *
     * @returns A promise that resolves to an array of parsed attribute objects.
     * @throws {Error} If the input contains unexpected whitespace, invalid characters, or ends unexpectedly.
     */
    async getAttributes(): Promise<ImapAttributeList> {
        if (!this.remainder.length) {
            throw createImapError(`Unexpected end of input at position ${this.pos} [E6]`, 'ParserError6', { parserContext: this.errorContext() });
        }

        if (/^\s/.test(this.remainder)) {
            throw createImapError(`Unexpected whitespace at position ${this.pos} [E7]`, 'ParserError7', {
                parserContext: this.errorContext(this.remainder)
            });
        }

        const tokenParser = new TokenParser(this, this.pos, this.remainder, this.options);

        return await tokenParser.getAttributes();
    }
}
