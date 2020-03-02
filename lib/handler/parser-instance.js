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
        let responseCode;

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
                responseCode = this.remainder.match(/^ \[(?:[^\]]*\])+/);
                if (responseCode) {
                    this.humanReadable = this.remainder.substr(responseCode[0].length).trim();
                    this.remainder = responseCode[0];
                } else {
                    this.humanReadable = this.remainder.trim();
                    this.remainder = '';
                }
                break;
        }

        return this.command;
    }

    async getElement(syntax) {
        let match, element, errPos;

        if (this.remainder.match(/^\s/)) {
            throw new Error('Unexpected whitespace at position ' + this.pos);
        }

        if ((match = this.remainder.match(/^\s*[^\s]+(?=\s|$)/))) {
            element = match[0];
            if ((errPos = imapFormalSyntax.verify(element, syntax)) >= 0) {
                throw new Error('Unexpected char at position ' + (this.pos + errPos));
            }
        } else {
            throw new Error('Unexpected end of input at position ' + this.pos);
        }

        this.pos += match[0].length;
        this.remainder = this.remainder.substr(match[0].length);

        return element;
    }

    async getSpace() {
        if (!this.remainder.length) {
            throw new Error('Unexpected end of input at position ' + this.pos);
        }

        if (imapFormalSyntax.verify(this.remainder.charAt(0), imapFormalSyntax.SP()) >= 0) {
            throw new Error('Unexpected char at position ' + this.pos);
        }

        this.pos++;
        this.remainder = this.remainder.substr(1);
    }

    async getAttributes() {
        if (!this.remainder.length) {
            throw new Error('Unexpected end of input at position ' + this.pos);
        }

        if (this.remainder.match(/^\s/)) {
            throw new Error('Unexpected whitespace at position ' + this.pos);
        }

        const tokenParser = new TokenParser(this, this.pos, this.remainder, this.options);

        return await tokenParser.getAttributes();
    }
}

module.exports.ParserInstance = ParserInstance;
