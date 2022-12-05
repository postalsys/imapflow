/* eslint no-console: 0, new-cap: 0 */

'use strict';

const imapFormalSyntax = require('./imap-formal-syntax');

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
 * Compiles an input object into
 */
module.exports = async (response, options) => {
    let { asArray, isLogging, literalPlus, literalMinus } = options || {};
    const respParts = [];

    let resp = [].concat(formatRespEntry(response.tag, true) || []).concat(response.command ? formatRespEntry(' ' + response.command) : []);
    let val;
    let lastType;

    let walk = async (node, options) => {
        options = options || {};

        let lastRespEntry = resp.length && resp[resp.length - 1];
        let lastRespByte = (lastRespEntry && lastRespEntry.length && lastRespEntry[lastRespEntry.length - 1]) || '';
        if (typeof lastRespByte === 'number') {
            lastRespByte = String.fromCharCode(lastRespByte);
        }

        if (lastType === 'LITERAL' || (!['(', '<', '['].includes(lastRespByte) && resp.length)) {
            if (options.subArray) {
                // ignore separator
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

            // check if we need to skip separtor WS between two arrays
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

                    let canAppend = !asArray || literalPlus || (literalMinus && literalLength <= 4096);
                    let usePlus = canAppend && (literalMinus || literalPlus);

                    resp.push(formatRespEntry(`${node.isLiteral8 ? '~' : ''}{${literalLength}${usePlus ? '+' : ''}}\r\n`));

                    if (canAppend) {
                        if (node.value && node.value.length) {
                            resp.push(formatRespEntry(node.value));
                        }
                    } else {
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
                    if (node.value === '' || imapFormalSyntax.verify(val.charAt(0) === '\\' ? val.substr(1) : val, imapFormalSyntax['ATOM-CHAR']()) >= 0) {
                        val = JSON.stringify(val);
                    }

                    resp.push(formatRespEntry(val));
                }

                if (node.section) {
                    resp.push(formatRespEntry('['));

                    for (let child of node.section) {
                        await walk(child);
                    }

                    resp.push(formatRespEntry(']'));
                }
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
