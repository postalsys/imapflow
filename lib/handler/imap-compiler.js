/* eslint no-console: 0, new-cap: 0 */

'use strict';

const imapFormalSyntax = require('./imap-formal-syntax');

// A single element of a sequence-set as defined by the RFC 9051 grammar: a number
// or a range, where "*" stands for the largest number in use. Digit strings are not
// range-checked here (a server rejects "0" or an overlong number on its own); the
// point of the check is that nothing outside this alphabet can reach the wire.
const SEQ_RANGE = /^(\d+|\*)(:(\d+|\*))?$/;

// Validates a full sequence-set: comma-separated SEQ_RANGE elements, or "$"
// (RFC 5182 SEARCHRES), which references the previous SEARCH result and is only
// valid as the entire set. Split into per-element tests on purpose - a whole-set
// regex with an unbounded repeat group overflows the regex engine's backtrack
// stack with an uncoded RangeError on valid sets in the million-element range,
// while the per-element regex is bounded.
const isValidSequenceSet = value => value === '$' || value.split(',').every(part => SEQ_RANGE.test(part));

// Numeric tokens may only put the digit alphabet on the wire. Anything that does
// not round to a bounded non-negative integer (NaN, Infinity, negatives, unsafe
// magnitudes) degrades to 0 - the fallback the NaN coercion has always used.
const safeNumber = value => {
    let num = Math.round(Number(value));
    return Number.isSafeInteger(num) && num >= 0 ? num : 0;
};

// Characters that cannot appear in an IMAP quoted string: CR and LF terminate a
// command line, and NUL is outside the CHAR production entirely. A value carrying
// any of them has to be sent as a literal, so quoting it is never correct.
const NOT_QUOTABLE = /[\r\n\0]/;

// A line terminator ends an IMAP command, so no token may carry one to the wire.
const CRLF = /[\r\n]/;

/**
 * Quotes a value as an IMAP quoted string. Only DQUOTE and backslash are escaped -
 * the IMAP grammar defines no other escape sequence, so JSON-style escaping (which
 * turns a tab into a literal backslash-t and a control character into \\uXXXX) would
 * silently change the value the server receives.
 *
 * @param {string} value - The value to quote.
 * @returns {string} The quoted string, ready to be written to the wire.
 * @throws {Error} If the value contains CR, LF or NUL, which a quoted string cannot carry.
 */
const quoteString = value => {
    if (NOT_QUOTABLE.test(value)) {
        let error = new Error('Unquotable character in IMAP string value');
        error.code = 'InvalidStringValue';
        throw error;
    }
    return '"' + value.replace(/["\\]/g, char => '\\' + char) + '"';
};

/**
 * Compiles an input object into a sequence of Buffers representing an IMAP protocol response string.
 * Handles various node types including literals, strings, atoms, sections, sequences, and nested lists.
 *
 * @param {Object} response - The response object to compile.
 * @param {string} [response.tag] - The IMAP command tag (e.g., "*" or a sequence number).
 * @param {string} [response.command] - The IMAP command name.
 * @param {Array|Object} [response.attributes] - The response attributes to compile into IMAP format.
 * @param {Object} [options] - Compilation options.
 * @param {boolean} [options.asArray] - If true, returns an array of Buffers (one per literal segment); otherwise returns a single concatenated Buffer.
 * @param {boolean} [options.isLogging] - If true, redacts sensitive values and truncates long strings/literals for logging purposes.
 * @param {boolean} [options.literalPlus] - If true, uses the LITERAL+ extension (appends "+" to literal length markers).
 * @param {boolean} [options.literalMinus] - If true, uses the LITERAL- extension for literals up to 4096 bytes.
 * @returns {Promise<Buffer[]|Buffer>} A promise that resolves to an array of Buffers (if asArray is true) or a single concatenated Buffer.
 */
module.exports = async (response, options) => {
    let { asArray, isLogging, literalPlus, literalMinus } = options || {};
    const respParts = [];

    // Formats an entry (string, number or Buffer) into the Buffer that is written to
    // the wire, and is the choke point every emission passes through: a line
    // terminator ends an IMAP command, so no token - the tag and command name
    // included - may put one on the wire. The literal size marker and literal data
    // are the only emissions where CRLF is legitimate; those call sites opt out with
    // `raw`. Never enforced when logging: re-encoding an incoming server response for
    // the log or for error text must not throw, whatever the server sent. With
    // `returnEmpty`, an unrecognized entry type yields null instead of an empty
    // Buffer.
    const emitEntry = (entry, opts) => {
        let { returnEmpty, raw } = opts || {};
        if (!raw && !isLogging && (typeof entry === 'string' || Buffer.isBuffer(entry)) && CRLF.test(entry.toString('latin1'))) {
            let error = new Error('Line terminator in IMAP token');
            error.code = 'InvalidTokenValue';
            throw error;
        }

        if (typeof entry === 'string') {
            return Buffer.from(entry);
        }

        if (typeof entry === 'number') {
            return Buffer.from(entry.toString());
        }

        if (Buffer.isBuffer(entry)) {
            return entry;
        }

        if (returnEmpty) {
            return null;
        }

        return Buffer.alloc(0);
    };

    let resp = [].concat(emitEntry(response.tag, { returnEmpty: true }) || []).concat(response.command ? emitEntry(' ' + response.command) : []);
    let val;
    let lastType;

    let walk = async (node, options) => {
        options = options || {};

        // Determine whether a space separator is needed before this node.
        // Inspect the last byte written to decide context.
        let lastRespEntry = resp.length && resp[resp.length - 1];
        let lastRespByte = (lastRespEntry && lastRespEntry.length && lastRespEntry[lastRespEntry.length - 1]) || '';
        if (typeof lastRespByte === 'number') {
            lastRespByte = String.fromCharCode(lastRespByte);
        }

        // Add a space separator when:
        // - The previous token was a LITERAL. Literal data ends exactly at its declared length, so
        //   a following token always needs an explicit separator, even though the last written byte
        //   is arbitrary literal content.
        // - Otherwise: there is something written already (resp is not empty) and the last byte is
        //   not an opening delimiter ('(', '<' or '['), which suppresses the space.
        // A sub-array element in a consecutive-list context never gets one (no space between
        // adjacent lists).
        if (lastType === 'LITERAL' || (!['(', '<', '['].includes(lastRespByte) && resp.length)) {
            if (!options.subArray) {
                resp.push(emitEntry(' '));
            }
        }

        if (node && node.buffer && !Buffer.isBuffer(node)) {
            // mongodb binary
            node = node.buffer;
        }

        if (Array.isArray(node)) {
            lastType = 'LIST';
            resp.push(emitEntry('('));

            // check if we need to skip separator WS between two arrays
            let subArray = node.length > 1 && Array.isArray(node[0]);

            for (let child of node) {
                if (subArray && !Array.isArray(child)) {
                    subArray = false;
                }
                await walk(child, { subArray });
            }

            resp.push(emitEntry(')'));
            return;
        }

        if (!node && typeof node !== 'string' && typeof node !== 'number' && !Buffer.isBuffer(node)) {
            resp.push(emitEntry('NIL'));
            return;
        }

        if (typeof node === 'string' || Buffer.isBuffer(node)) {
            if (isLogging && node.length > 100) {
                resp.push(emitEntry('"(* ' + node.length + 'B string *)"'));
            } else {
                resp.push(emitEntry(isLogging ? JSON.stringify(node.toString()) : quoteString(node.toString())));
            }
            return;
        }

        if (typeof node === 'number') {
            resp.push(emitEntry(safeNumber(node))); // Only bounded non-negative integers allowed
            return;
        }

        lastType = node.type;

        if (isLogging && node.sensitive) {
            resp.push(emitEntry('"(* value hidden *)"'));
            return;
        }

        switch (node.type.toUpperCase()) {
            case 'LITERAL':
                if (isLogging) {
                    resp.push(emitEntry('"(* ' + node.value.length + 'B literal *)"'));
                } else {
                    // The literal size marker counts octets - string values are written as
                    // UTF-8, so their UTF-16 .length would undercount multi-byte characters
                    let literalLength = !node.value ? 0 : Buffer.isBuffer(node.value) ? node.value.length : Buffer.byteLength(node.value.toString());

                    // Append '+' to the size marker only when the extension actually permits a
                    // non-synchronizing literal of this size (RFC 7888): LITERAL+ always,
                    // LITERAL- only up to 4096 bytes
                    let usePlus = literalPlus || (literalMinus && literalLength <= 4096);
                    // canAppend: whether the literal data can be sent in the same buffer segment -
                    // non-synchronizing literals always, and everything in single-buffer mode
                    // (asArray false), which has no continuation flow
                    let canAppend = !asArray || usePlus;

                    // Emit the literal header: optional '~' prefix for literal8, then {size[+]}\r\n
                    resp.push(emitEntry(`${node.isLiteral8 ? '~' : ''}{${literalLength}${usePlus ? '+' : ''}}\r\n`, { raw: true }));

                    if (canAppend) {
                        // Literal data follows immediately in the same buffer segment
                        if (node.value && node.value.length) {
                            resp.push(emitEntry(node.value, { raw: true }));
                        }
                    } else {
                        // For synchronizing literals in asArray mode, split output into separate
                        // parts. The caller must send each part and wait for a continuation
                        // response from the server before sending the next.
                        respParts.push(resp);
                        resp = [].concat(emitEntry(node.value, { returnEmpty: true, raw: true }) || []);
                    }
                }
                break;

            case 'STRING':
                if (isLogging && node.value.length > 100) {
                    resp.push(emitEntry('"(* ' + node.value.length + 'B string *)"'));
                } else {
                    val = (node.value || '').toString();
                    resp.push(emitEntry(isLogging ? JSON.stringify(val) : quoteString(val)));
                }
                break;

            case 'SEQUENCE':
                // Sequence sets are written verbatim - they are the one token type with
                // no quoting to fall back on. Callers build them from user-supplied
                // ranges, so validate here, at the single point every outgoing sequence
                // set passes through, rather than trusting each command module. Skipped
                // when logging: the incoming token parser accepts sequence-shaped tokens
                // this strict grammar rejects (an ESEARCH set like "1:2:3", a folder
                // name like "12:30:00"), and re-compiling a server response for the log
                // or for error text must never throw.
                if (!isLogging && (typeof node.value === 'string' || typeof node.value === 'number' || Buffer.isBuffer(node.value))) {
                    val = node.value.toString();
                    if (val && !isValidSequenceSet(val)) {
                        let error = new Error('Invalid sequence set value');
                        error.code = 'InvalidSequenceSet';
                        throw error;
                    }
                }
                if (node.value) {
                    // raw: the validated alphabet cannot contain a line terminator, and
                    // re-scanning a potentially multi-megabyte set in the choke point
                    // would double the cost of exactly the sets this branch exists for
                    resp.push(emitEntry(node.value, { raw: true }));
                }
                break;

            case 'TEXT':
                // Response text is written verbatim. Only the parser produces it today, for
                // incoming lines, so this is a re-encoding path rather than a command-building
                // one. The emitEntry choke point would refuse a line terminator here too;
                // this check runs first only to raise the more specific InvalidTextValue code.
                if (node.value) {
                    if (!isLogging && CRLF.test(node.value.toString())) {
                        let error = new Error('Line terminator in IMAP text value');
                        error.code = 'InvalidTextValue';
                        throw error;
                    }
                    resp.push(emitEntry(node.value));
                }
                break;

            case 'NUMBER':
                // Coerced rather than written through: formatRespEntry passes a string or
                // Buffer straight to the wire, so a numeric token carrying a string value
                // would be another verbatim channel
                resp.push(emitEntry(safeNumber(node.value)));
                break;

            case 'ATOM':
            case 'SECTION':
                val = (node.value || '').toString();

                if (!node.section || val) {
                    // Verify the value contains only valid ATOM-CHAR characters.
                    // Strip a leading backslash before checking (system flags like \Seen start with '\').
                    // If any character fails verification, fall back to an IMAP quoted string
                    // (JSON.stringify is used only for log output, where values are display-escaped).
                    if (node.value === '' || imapFormalSyntax.verify(val.charAt(0) === '\\' ? val.substr(1) : val, imapFormalSyntax['ATOM-CHAR']()) >= 0) {
                        val = isLogging ? JSON.stringify(val) : quoteString(val);
                    }

                    resp.push(emitEntry(val));
                }

                // Section bracket handling: emit [section-contents] after the ATOM value
                // e.g., BODY[HEADER.FIELDS (Subject)] or BODY[1.MIME]
                if (node.section) {
                    resp.push(emitEntry('['));

                    for (let child of node.section) {
                        await walk(child);
                    }

                    resp.push(emitEntry(']'));
                }
                // Partial range: emit <origin.length> after the section brackets. Coerced
                // rather than joined as-is: this is the last token component written
                // verbatim, and the choke point is only worth relying on if it holds for
                // all of them. Every producer already passes numbers, so nothing changes
                // for them.
                if (node.partial) {
                    resp.push(emitEntry(`<${node.partial.map(safeNumber).join('.')}>`));
                }
                break;
        }
    };

    if (response.attributes) {
        let attributes = Array.isArray(response.attributes) ? response.attributes : [].concat(response.attributes);
        for (let child of attributes) {
            await walk(child);
        }
    }

    if (resp.length) {
        respParts.push(resp);
    }

    for (let i = 0; i < respParts.length; i++) {
        respParts[i] = Buffer.concat(respParts[i]);
    }

    return asArray ? respParts : respParts.flatMap(entry => entry);
};
