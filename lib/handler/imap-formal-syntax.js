/* eslint object-shorthand:0, new-cap: 0, no-useless-concat: 0 */

'use strict';

/**
 * @module imap-formal-syntax
 *
 * Defines the IMAP formal syntax character classes and validation rules as specified
 * in RFC 3501 Section 9 (http://tools.ietf.org/html/rfc3501#section-9).
 *
 * Each exported method returns a string of allowed characters for a given IMAP grammar
 * production rule (e.g., ATOM-CHAR, ASTRING-CHAR, TEXT-CHAR). Results are memoized after
 * the first call by replacing the method with a function that returns the cached value.
 *
 * Also exports a {@link module:imap-formal-syntax.verify|verify} function for validating
 * strings against a set of allowed characters.
 */

/**
 * Generates a string containing all characters in the given Unicode code point range (inclusive).
 *
 * @param {number} start - The starting character code point.
 * @param {number} end - The ending character code point.
 * @returns {string} A string containing all characters from start to end.
 */
function expandRange(start, end) {
    let chars = [];
    for (let i = start; i <= end; i++) {
        chars.push(i);
    }
    return String.fromCharCode(...chars);
}

/**
 * Returns a new string with all characters from the exclude string removed from the source string.
 *
 * @param {string} source - The source string to filter.
 * @param {string} exclude - A string of characters to exclude from the source.
 * @returns {string} The source string with excluded characters removed.
 */
function excludeChars(source, exclude) {
    let sourceArr = Array.prototype.slice.call(source);
    for (let i = sourceArr.length - 1; i >= 0; i--) {
        if (exclude.indexOf(sourceArr[i]) >= 0) {
            sourceArr.splice(i, 1);
        }
    }
    return sourceArr.join('');
}

module.exports = {
    /** @returns {string} All 7-bit US-ASCII characters excluding NUL (0x01-0x7F). */
    CHAR() {
        let value = expandRange(0x01, 0x7f);
        this.CHAR = function () {
            return value;
        };
        return value;
    },

    /** @returns {string} All 8-bit characters excluding NUL (0x01-0xFF). */
    CHAR8() {
        let value = expandRange(0x01, 0xff);
        this.CHAR8 = function () {
            return value;
        };
        return value;
    },

    /** @returns {string} The space character (0x20). */
    SP() {
        return ' ';
    },

    /** @returns {string} All control characters (0x00-0x1F and 0x7F). */
    CTL() {
        let value = expandRange(0x00, 0x1f) + '\x7F';
        this.CTL = function () {
            return value;
        };
        return value;
    },

    /** @returns {string} The double-quote character. */
    DQUOTE() {
        return '"';
    },

    /** @returns {string} All uppercase and lowercase ASCII alphabetic characters (A-Z, a-z). */
    ALPHA() {
        let value = expandRange(0x41, 0x5a) + expandRange(0x61, 0x7a);
        this.ALPHA = function () {
            return value;
        };
        return value;
    },

    /** @returns {string} All ASCII digit characters (0-9). */
    DIGIT() {
        let value = expandRange(0x30, 0x39);
        this.DIGIT = function () {
            return value;
        };
        return value;
    },

    /** @returns {string} Characters allowed in an IMAP ATOM (CHAR minus atom-specials). */
    'ATOM-CHAR'() {
        let value = excludeChars(this.CHAR(), this['atom-specials']());
        this['ATOM-CHAR'] = function () {
            return value;
        };
        return value;
    },

    /** @returns {string} Characters allowed in an IMAP ASTRING (ATOM-CHAR plus resp-specials). */
    'ASTRING-CHAR'() {
        let value = this['ATOM-CHAR']() + this['resp-specials']();
        this['ASTRING-CHAR'] = function () {
            return value;
        };
        return value;
    },

    /** @returns {string} Characters allowed in IMAP text (CHAR minus CR and LF). */
    'TEXT-CHAR'() {
        let value = excludeChars(this.CHAR(), '\r\n');
        this['TEXT-CHAR'] = function () {
            return value;
        };
        return value;
    },

    /** @returns {string} Characters that are special in ATOMs and must be excluded: "(", ")", "{", SP, CTL, list-wildcards, quoted-specials, resp-specials. */
    'atom-specials'() {
        let value = '(' + ')' + '{' + this.SP() + this.CTL() + this['list-wildcards']() + this['quoted-specials']() + this['resp-specials']();
        this['atom-specials'] = function () {
            return value;
        };
        return value;
    },

    /** @returns {string} The LIST wildcard characters ("%" and "*"). */
    'list-wildcards'() {
        return '%' + '*';
    },

    /** @returns {string} Characters that are special inside quoted strings (DQUOTE and backslash). */
    'quoted-specials'() {
        let value = this.DQUOTE() + '\\';
        this['quoted-specials'] = function () {
            return value;
        };
        return value;
    },

    /** @returns {string} The response-special character ("]"). */
    'resp-specials'() {
        return ']';
    },

    /** @returns {string} Characters allowed in an IMAP tag (ASTRING-CHAR minus "+"). */
    tag() {
        let value = excludeChars(this['ASTRING-CHAR'](), '+');
        this.tag = function () {
            return value;
        };
        return value;
    },

    /** @returns {string} Characters allowed in an IMAP command name (ALPHA, DIGIT, and hyphen). */
    command() {
        let value = this.ALPHA() + this.DIGIT() + '-';
        this.command = function () {
            return value;
        };
        return value;
    },

    /**
     * Verifies that every character in the given string is within the set of allowed characters.
     *
     * @param {string} str - The string to validate.
     * @param {string} allowedChars - A string containing all allowed characters.
     * @returns {number} The index of the first disallowed character, or -1 if all characters are valid.
     */
    verify(str, allowedChars) {
        for (let i = 0, len = str.length; i < len; i++) {
            if (allowedChars.indexOf(str.charAt(i)) < 0) {
                return i;
            }
        }
        return -1;
    }
};
