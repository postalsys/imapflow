/* eslint no-console: 0, new-cap: 0 */

'use strict';

const imapFormalSyntax = require('./imap-formal-syntax');

/**
 * Formats a response entry into a Buffer.
 *
 * @param {string|number|Buffer} entry - The value to convert to a Buffer.
 * @param {boolean} [returnEmpty] - If true, returns null instead of an empty Buffer when the entry is not a recognized type.
 * @returns {Buffer|null} The entry as a Buffer, or null if returnEmpty is true and the entry is not a recognized type.
 */
const formatRespEntry = (entry, returnEmpty) => {
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

    let resp = [].concat(formatRespEntry(response.tag, true) || []).concat(response.command ? formatRespEntry(' ' + response.command) : []);
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

        // Add a space separator unless:
        // - The previous token was a LITERAL (literal data is self-delimiting after CRLF)
        // - The last byte was '(', '<', or '[' (opening delimiters suppress the space)
        // - This is the first token (resp is empty)
        // - This is a sub-array element in a consecutive-list context (no space between adjacent lists)
        if (lastType === 'LITERAL' || (!['(', '<', '['].includes(lastRespByte) && resp.length)) {
            if (options.subArray) {
                // ignore separator between consecutive sub-arrays in a list
            } else {
                resp.push(formatRespEntry(' '));
            }
        }

        if (node && node.buffer && !Buffer.isBuffer(node)) {
            // mongodb binary
            node = node.buffer;
        }

        if (Array.isArray(node)) {
            lastType = 'LIST';
            resp.push(formatRespEntry('('));

            // check if we need to skip separator WS between two arrays
            let subArray = node.length > 1 && Array.isArray(node[0]);

            for (let child of node) {
                if (subArray && !Array.isArray(child)) {
                    subArray = false;
                }
                await walk(child, { subArray });
            }

            resp.push(formatRespEntry(')'));
            return;
        }

        if (!node && typeof node !== 'string' && typeof node !== 'number' && !Buffer.isBuffer(node)) {
            resp.push(formatRespEntry('NIL'));
            return;
        }

        if (typeof node === 'string' || Buffer.isBuffer(node)) {
            if (isLogging && node.length > 100) {
                resp.push(formatRespEntry('"(* ' + node.length + 'B string *)"'));
            } else {
                resp.push(formatRespEntry(JSON.stringify(node.toString())));
            }
            return;
        }

        if (typeof node === 'number') {
            resp.push(formatRespEntry(Math.round(node) || 0)); // Only integers allowed
            return;
        }

        lastType = node.type;

        if (isLogging && node.sensitive) {
            resp.push(formatRespEntry('"(* value hidden *)"'));
            return;
        }

        switch (node.type.toUpperCase()) {
            case 'LITERAL':
                if (isLogging) {
                    resp.push(formatRespEntry('"(* ' + node.value.length + 'B literal *)"'));
                } else {
                    let literalLength = !node.value ? 0 : Math.max(node.value.length, 0);

                    // canAppend: whether the literal data can be sent in the same buffer segment.
                    // With LITERAL+ (RFC 7888) the client does not wait for a continuation response.
                    // With LITERAL- (RFC 7888) the client can skip the wait only for literals <= 4096 bytes.
                    // When asArray is false we always append inline (single-buffer mode).
                    let canAppend = !asArray || literalPlus || (literalMinus && literalLength <= 4096);
                    // Append '+' to the size marker when using LITERAL+ or LITERAL- (non-synchronizing)
                    let usePlus = canAppend && (literalMinus || literalPlus);

                    // Emit the literal header: optional '~' prefix for literal8, then {size[+]}\r\n
                    resp.push(formatRespEntry(`${node.isLiteral8 ? '~' : ''}{${literalLength}${usePlus ? '+' : ''}}\r\n`));

                    if (canAppend) {
                        // Literal data follows immediately in the same buffer segment
                        if (node.value && node.value.length) {
                            resp.push(formatRespEntry(node.value));
                        }
                    } else {
                        // For synchronizing literals in asArray mode, split output into separate
                        // parts. The caller must send each part and wait for a continuation
                        // response from the server before sending the next.
                        respParts.push(resp);
                        resp = [].concat(formatRespEntry(node.value, true) || []);
                    }
                }
                break;

            case 'STRING':
                if (isLogging && node.value.length > 100) {
                    resp.push(formatRespEntry('"(* ' + node.value.length + 'B string *)"'));
                } else {
                    resp.push(formatRespEntry(JSON.stringify((node.value || '').toString())));
                }
                break;

            case 'TEXT':
            case 'SEQUENCE':
                if (node.value) {
                    resp.push(formatRespEntry(node.value));
                }
                break;

            case 'NUMBER':
                resp.push(formatRespEntry(node.value || 0));
                break;

            case 'ATOM':
            case 'SECTION':
                val = (node.value || '').toString();

                if (!node.section || val) {
                    // Verify the value contains only valid ATOM-CHAR characters.
                    // Strip a leading backslash before checking (system flags like \Seen start with '\').
                    // If any character fails verification, quote-escape the entire value with JSON.stringify.
                    if (node.value === '' || imapFormalSyntax.verify(val.charAt(0) === '\\' ? val.substr(1) : val, imapFormalSyntax['ATOM-CHAR']()) >= 0) {
                        val = JSON.stringify(val);
                    }

                    resp.push(formatRespEntry(val));
                }

                // Section bracket handling: emit [section-contents] after the ATOM value
                // e.g., BODY[HEADER.FIELDS (Subject)] or BODY[1.MIME]
                if (node.section) {
                    resp.push(formatRespEntry('['));

                    for (let child of node.section) {
                        await walk(child);
                    }

                    resp.push(formatRespEntry(']'));
                }
                // Partial range: emit <origin.length> after the section brackets
                if (node.partial) {
                    resp.push(formatRespEntry(`<${node.partial.join('.')}>`));
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
