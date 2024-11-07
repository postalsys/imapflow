/* eslint new-cap: 0 */

'use strict';

const imapFormalSyntax = require('./imap-formal-syntax');

const { TokenParser } = require('./token-parser');

class ParserInstance {
    constructor(input, options) {
        this.input = (input || '').toString();
        this.options = options || {};
        this.remainder = this.input;
        this.pos = 0;
    }

    async getTag() {
        if (!this.tag) {
            this.tag = await this.getElement(imapFormalSyntax.tag() + '*+', true);
        }
        return this.tag;
    }

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
                    // Exchange error
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
