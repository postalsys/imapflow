/* eslint new-cap: 0, no-useless-concat: 0 */

/**
 * Defines the IMAP formal syntax character classes and validation rules as specified
 * in RFC 3501 Section 9 (http://tools.ietf.org/html/rfc3501#section-9).
 *
 * Each exported method returns a string of allowed characters for a given IMAP grammar
 * production rule (e.g., ATOM-CHAR, ASTRING-CHAR, TEXT-CHAR). Results are computed once,
 * on first use, and cached at module level.
 *
 * Also exports a `verify` function for validating strings against a set of allowed characters.
 */

/**
 * Generates a string containing all characters in the given Unicode code point range (inclusive).
 *
 * @param start - The starting character code point.
 * @param end - The ending character code point.
 * @returns A string containing all characters from start to end.
 */
function expandRange(start: number, end: number): string {
    let chars: number[] = [];
    for (let i = start; i <= end; i++) {
        chars.push(i);
    }
    return String.fromCharCode(...chars);
}

/**
 * Returns a new string with all characters from the exclude string removed from the source string.
 *
 * @param source - The source string to filter.
 * @param exclude - A string of characters to exclude from the source.
 * @returns The source string with excluded characters removed.
 */
function excludeChars(source: string, exclude: string): string {
    return Array.prototype.filter.call(source, (ch: string) => exclude.indexOf(ch) < 0).join('');
}

/**
 * Wraps a computation so that it runs once, on first call, and the result is reused afterwards.
 *
 * @param compute - Produces the character set.
 * @returns A zero-argument function returning the cached character set.
 */
function memo(compute: () => string): () => string {
    let value: string | null = null;
    return () => {
        if (value === null) {
            value = compute();
        }
        return value;
    };
}

/** All 7-bit US-ASCII characters excluding NUL (0x01-0x7F). */
const CHAR = memo(() => expandRange(0x01, 0x7f));

/** All 8-bit characters excluding NUL (0x01-0xFF). */
const CHAR8 = memo(() => expandRange(0x01, 0xff));

/** The space character (0x20). */
const SP = (): string => ' ';

/** All control characters (0x00-0x1F and 0x7F). */
const CTL = memo(() => expandRange(0x00, 0x1f) + '\x7F');

/** The double-quote character. */
const DQUOTE = (): string => '"';

/** All uppercase and lowercase ASCII alphabetic characters (A-Z, a-z). */
const ALPHA = memo(() => expandRange(0x41, 0x5a) + expandRange(0x61, 0x7a));

/** All ASCII digit characters (0-9). */
const DIGIT = memo(() => expandRange(0x30, 0x39));

/** The LIST wildcard characters ("%" and "*"). */
const listWildcards = (): string => '%' + '*';

/** Characters that are special inside quoted strings (DQUOTE and backslash). */
const quotedSpecials = memo(() => DQUOTE() + '\\');

/** The response-special character ("]"). */
const respSpecials = (): string => ']';

/** Characters that are special in ATOMs and must be excluded: "(", ")", "{", SP, CTL, list-wildcards, quoted-specials, resp-specials. */
const atomSpecials = memo(() => '(' + ')' + '{' + SP() + CTL() + listWildcards() + quotedSpecials() + respSpecials());

/** Characters allowed in an IMAP ATOM (CHAR minus atom-specials). */
const atomChar = memo(() => excludeChars(CHAR(), atomSpecials()));

/** Characters allowed in an IMAP ASTRING (ATOM-CHAR plus resp-specials). */
const astringChar = memo(() => atomChar() + respSpecials());

/** Characters allowed in IMAP text (CHAR minus CR and LF). */
const textChar = memo(() => excludeChars(CHAR(), '\r\n'));

/** Characters allowed in an IMAP tag (ASTRING-CHAR minus "+"). */
const tag = memo(() => excludeChars(astringChar(), '+'));

/** Characters allowed in an IMAP command name (ALPHA, DIGIT, and hyphen). */
const command = memo(() => ALPHA() + DIGIT() + '-');

/**
 * Verifies that every character in the given string is within the set of allowed characters.
 *
 * @param str - The string to validate.
 * @param allowedChars - A string containing all allowed characters.
 * @returns The index of the first disallowed character, or -1 if all characters are valid.
 */
function verify(str: string, allowedChars: string): number {
    for (let i = 0, len = str.length; i < len; i++) {
        if (allowedChars.indexOf(str.charAt(i)) < 0) {
            return i;
        }
    }
    return -1;
}

const imapFormalSyntax = {
    CHAR,
    CHAR8,
    SP,
    CTL,
    DQUOTE,
    ALPHA,
    DIGIT,
    'ATOM-CHAR': atomChar,
    'ASTRING-CHAR': astringChar,
    'TEXT-CHAR': textChar,
    'atom-specials': atomSpecials,
    'list-wildcards': listWildcards,
    'quoted-specials': quotedSpecials,
    'resp-specials': respSpecials,
    tag,
    command,
    verify
};

export default imapFormalSyntax;
