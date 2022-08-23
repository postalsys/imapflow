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
            throw new Error(`Unexpected whitespace at position ${this.pos} [E1]`);
        }

        if ((match = this.remainder.match(/^\s*[^\s]+(?=\s|$)/))) {
            element = match[0];
            if ((errPos = imapFormalSyntax.verify(element, syntax)) >= 0) {
                throw new Error(`Unexpected char at position ${this.pos + errPos} [E2: ${JSON.stringify(element.charAt(errPos))}]`);
            }
        } else {
            throw new Error(`Unexpected end of input at position ${this.pos} [E3]`);
        }

        this.pos += match[0].length;
        this.remainder = this.remainder.substr(match[0].length);

        return element;
    }

    async getSpace() {
        if (!this.remainder.length) {
            throw new Error(`Unexpected end of input at position ${this.pos} [E4]`);
        }

        if (imapFormalSyntax.verify(this.remainder.charAt(0), imapFormalSyntax.SP()) >= 0) {
            throw new Error(`Unexpected char at position ${this.pos} [E5: ${JSON.stringify(this.remainder.charAt(0))}]`);
        }

        this.pos++;
        this.remainder = this.remainder.substr(1);
    }

    async getAttributes() {
        if (!this.remainder.length) {
            throw new Error(`Unexpected end of input at position ${this.pos} [E6]`);
        }

        if (this.remainder.match(/^\s/)) {
            throw new Error(`Unexpected whitespace at position ${this.pos} [E7]`);
        }

        const tokenParser = new TokenParser(this, this.pos, this.remainder, this.options);

        return await tokenParser.getAttributes();
    }
}

module.exports.ParserInstance = ParserInstance;
