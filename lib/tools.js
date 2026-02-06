/* eslint no-control-regex:0 */

'use strict';

const libmime = require('libmime');
const { resolveCharset } = require('./charsets');
const { compiler } = require('./handler/imap-handler');
const { createHash } = require('crypto');
const { JPDecoder } = require('./jp-decoder');
const iconv = require('iconv-lite');

const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'];

/**
 * Error subclass thrown when IMAP authentication fails.
 */
class AuthenticationFailure extends Error {
    authenticationFailed = true;
}

const tools = {
    /**
     * Encodes a mailbox path to modified UTF-7 if the server does not support UTF8=ACCEPT.
     *
     * @param {Object} connection - IMAP connection instance
     * @param {String} path - Mailbox path to encode
     * @returns {String} Encoded mailbox path
     */
    encodePath(connection, path) {
        path = (path || '').toString();
        if (!connection.enabled.has('UTF8=ACCEPT') && /[&\x00-\x08\x0b-\x0c\x0e-\x1f\u0080-\uffff]/.test(path)) {
            try {
                path = iconv.encode(path, 'utf-7-imap').toString();
            } catch {
                // ignore, keep name as is
            }
        }
        return path;
    },

    /**
     * Decodes a mailbox path from modified UTF-7 if the server does not support UTF8=ACCEPT.
     *
     * @param {Object} connection - IMAP connection instance
     * @param {String} path - Mailbox path to decode
     * @returns {String} Decoded mailbox path
     */
    decodePath(connection, path) {
        path = (path || '').toString();
        if (!connection.enabled.has('UTF8=ACCEPT') && /[&]/.test(path)) {
            try {
                path = iconv.decode(Buffer.from(path), 'utf-7-imap').toString();
            } catch {
                // ignore, keep name as is
            }
        }
        return path;
    },

    /**
     * Normalizes a mailbox path by joining array segments with the namespace delimiter,
     * uppercasing INBOX, and prepending the namespace prefix if needed.
     *
     * @param {Object} connection - IMAP connection instance
     * @param {String|String[]} path - Mailbox path or array of path segments
     * @param {Boolean} [skipNamespace] - If true, skips prepending the namespace prefix
     * @returns {String} Normalized mailbox path
     */
    normalizePath(connection, path, skipNamespace) {
        if (Array.isArray(path)) {
            path = path.join((connection.namespace && connection.namespace.delimiter) || '');
        }

        if (path.toUpperCase() === 'INBOX') {
            // inbox is not case sensitive
            return 'INBOX';
        }

        // ensure namespace prefix if needed
        if (!skipNamespace && connection.namespace && connection.namespace.prefix && path.indexOf(connection.namespace.prefix) !== 0) {
            path = connection.namespace.prefix + path;
        }

        return path;
    },

    /**
     * Compares two mailbox paths for equality after normalization.
     *
     * @param {Object} connection - IMAP connection instance
     * @param {String} a - First mailbox path
     * @param {String} b - Second mailbox path
     * @returns {Boolean} True if the paths are equal after normalization
     */
    comparePaths(connection, a, b) {
        if (!a || !b) {
            return false;
        }
        return tools.normalizePath(connection, a) === tools.normalizePath(connection, b);
    },

    /**
     * Parses a capability response list into a Map of capability names to values.
     *
     * @param {Array} list - Array of capability objects from IMAP response
     * @returns {Map<string, boolean|number>} Map of capability names to `true` or numeric values
     */
    updateCapabilities(list) {
        let map = new Map();

        if (list && Array.isArray(list)) {
            list.forEach(val => {
                if (typeof val.value !== 'string') {
                    return false;
                }
                let capability = val.value.toUpperCase().trim();

                if (capability === 'IMAP4REV1') {
                    map.set('IMAP4rev1', true);
                    return;
                }

                if (capability.indexOf('APPENDLIMIT=') === 0) {
                    let splitPos = capability.indexOf('=');
                    let appendLimit = Number(capability.substr(splitPos + 1)) || 0;
                    map.set('APPENDLIMIT', appendLimit);
                    return;
                }

                map.set(capability, true);
            });
        }

        return map;
    },

    AuthenticationFailure,

    /**
     * Extracts the IMAP response status code (e.g. AUTHENTICATIONFAILED, NONEXISTENT)
     * from a parsed server response.
     *
     * @param {Object} response - Parsed IMAP server response
     * @returns {String|false} Uppercase status code string, or false if not found
     */
    getStatusCode(response) {
        return response &&
            response.attributes &&
            response.attributes[0] &&
            response.attributes[0].section &&
            response.attributes[0].section[0] &&
            typeof response.attributes[0].section[0].value === 'string'
            ? response.attributes[0].section[0].value.toUpperCase().trim()
            : false;
    },

    /**
     * Compiles an IMAP response object back into a human-readable string.
     *
     * @param {Object} response - Parsed IMAP server response
     * @returns {Promise<String|false>} Compiled response text, or false if no response
     */
    async getErrorText(response) {
        if (!response) {
            return false;
        }

        return (await compiler(response)).toString();
    },

    /**
     * Enhances an IMAP command error with the server response code and text.
     *
     * @param {Error} err - Error object with a `response` property
     * @returns {Promise<Error>} The enhanced error with `serverResponseCode` and string `response`
     */
    async enhanceCommandError(err) {
        let errorCode = tools.getStatusCode(err.response);
        if (errorCode) {
            err.serverResponseCode = errorCode;
        }
        err.response = await tools.getErrorText(err.response);
        return err;
    },

    /**
     * Converts a flat list of mailbox folders into a tree structure.
     *
     * @param {Object[]} folders - Array of folder objects from LIST/LSUB response
     * @returns {Object} Tree structure with a `root` flag and nested `folders` arrays
     */
    getFolderTree(folders) {
        let tree = {
            root: true,
            folders: []
        };

        let getTreeNode = parents => {
            let node = tree;
            if (!parents || !parents.length) {
                return node;
            }

            for (let parent of parents) {
                let cur = node.folders && node.folders.find(folder => folder.name === parent);
                if (cur) {
                    node = cur;
                } else {
                    // not yet set
                    cur = {
                        name: parent,
                        folders: []
                    };
                }
            }

            return node;
        };

        for (let folder of folders) {
            let parent = getTreeNode(folder.parent);
            // see if entry already exists
            let existing = parent.folders && parent.folders.find(existing => existing.name === folder.name);
            if (existing) {
                // update values
                existing.name = folder.name;
                existing.flags = folder.flags;
                existing.path = folder.path;
                existing.subscribed = !!folder.subscribed;
                existing.listed = !!folder.listed;
                existing.status = !!folder.status;

                if (folder.specialUse) {
                    existing.specialUse = folder.specialUse;
                }

                if (folder.flags.has('\\Noselect')) {
                    existing.disabled = true;
                }
                if (folder.flags.has('\\HasChildren') && !existing.folders) {
                    existing.folders = [];
                }
            } else {
                // create new
                let data = {
                    name: folder.name,
                    flags: folder.flags,
                    path: folder.path,
                    subscribed: !!folder.subscribed,
                    listed: !!folder.listed,
                    status: !!folder.status
                };

                if (folder.delimiter) {
                    data.delimiter = folder.delimiter;
                }

                if (folder.specialUse) {
                    data.specialUse = folder.specialUse;
                }

                if (folder.flags.has('\\Noselect')) {
                    data.disabled = true;
                }

                if (folder.flags.has('\\HasChildren')) {
                    data.folders = [];
                }

                if (!parent.folders) {
                    parent.folders = [];
                }
                parent.folders.push(data);
            }
        }

        return tree;
    },

    /**
     * Derives a flag color name from a message's flags Set using Apple Mail color flag rules.
     *
     * @param {Set<string>} flags - Message flags Set
     * @returns {String|null} Color name (e.g. 'red', 'orange') or null if not flagged
     */
    getFlagColor(flags) {
        if (!flags.has('\\Flagged')) {
            return null;
        }

        // Apple Mail encodes flag colors as a 3-bit value using $MailFlagBit0/1/2 keywords.
        // Bit 0 = 1, Bit 1 = 2, Bit 2 = 4. The resulting integer (0-6) indexes into FLAG_COLORS:
        // 0=red, 1=orange, 2=yellow, 3=green, 4=blue, 5=purple, 6=grey.
        // Value 7 (all bits set) is unused; defaults to red.
        const bit0 = flags.has('$MailFlagBit0') ? 1 : 0;
        const bit1 = flags.has('$MailFlagBit1') ? 2 : 0;
        const bit2 = flags.has('$MailFlagBit2') ? 4 : 0;

        const color = bit0 | bit1 | bit2; // eslint-disable-line no-bitwise

        return FLAG_COLORS[color] || 'red'; // default to red for the unused \b111
    },

    /**
     * Converts a color name to the corresponding flag add/remove operations for Apple Mail color flags.
     *
     * @param {String} color - Color name (e.g. 'red', 'orange', 'yellow')
     * @returns {Object|null} Object with `add` and `remove` arrays of flag strings, or null if invalid color
     */
    getColorFlags(color) {
        // Reverse mapping from a color name to the Apple Mail $MailFlagBit0/1/2 flags.
        // Returns an object with 'add' and 'remove' arrays so the caller can STORE +FLAGS/-FLAGS.
        const colorCode = color ? FLAG_COLORS.indexOf((color || '').toString().toLowerCase().trim()) : null;
        if (colorCode < 0 && colorCode !== null) {
            return null;
        }

        // Decompose color index back into its 3-bit representation
        const bits = [];
        bits[0] = colorCode & 1; // eslint-disable-line no-bitwise
        bits[1] = colorCode & 2; // eslint-disable-line no-bitwise
        bits[2] = colorCode & 4; // eslint-disable-line no-bitwise

        // If colorCode is truthy (non-zero), add \Flagged; if zero/null, remove \Flagged
        let result = { add: colorCode ? ['\\Flagged'] : [], remove: colorCode ? [] : ['\\Flagged'] };

        // For each bit, add the corresponding $MailFlagBitN if set, remove it if unset
        for (let i = 0; i < bits.length; i++) {
            if (bits[i]) {
                result.add.push(`$MailFlagBit${i}`);
            } else {
                result.remove.push(`$MailFlagBit${i}`);
            }
        }
        return result;
    },

    /**
     * Formats a raw untagged FETCH response into a structured message object.
     *
     * @param {Object} untagged - Parsed untagged IMAP response
     * @param {Object} mailbox - Current mailbox state object
     * @returns {Promise<Object>} Formatted message object with properties like seq, uid, flags, envelope, etc.
     */
    async formatMessageResponse(untagged, mailbox) {
        let map = {};

        map.seq = Number(untagged.command);

        let key;
        let attributes = (untagged.attributes && untagged.attributes[1]) || [];
        for (let i = 0, len = attributes.length; i < len; i++) {
            let attribute = attributes[i];
            if (i % 2 === 0) {
                key = (
                    await compiler({
                        attributes: [attribute]
                    })
                )
                    .toString()
                    .toLowerCase()
                    .replace(/<\d+(\.\d+)?>$/, '');
                continue;
            }
            if (typeof key !== 'string') {
                // should not happen
                continue;
            }

            let getString = attribute => {
                if (!attribute) {
                    return false;
                }
                if (typeof attribute.value === 'string') {
                    return attribute.value;
                }
                if (Buffer.isBuffer(attribute.value)) {
                    return attribute.value.toString();
                }
            };

            let getBuffer = attribute => {
                if (!attribute) {
                    return false;
                }
                if (Buffer.isBuffer(attribute.value)) {
                    return attribute.value;
                }
            };

            let getArray = attribute => {
                if (Array.isArray(attribute)) {
                    return attribute.map(entry => (entry && typeof entry.value === 'string' ? entry.value : false)).filter(entry => entry);
                }
            };

            switch (key) {
                case 'body[]':
                case 'binary[]':
                    map.source = getBuffer(attribute);
                    break;

                case 'uid':
                    map.uid = Number(getString(attribute));
                    // If the UID we just saw is >= the mailbox's uidNext, bump uidNext.
                    // This keeps the local uidNext estimate current without requiring a
                    // separate STATUS command, handling cases where new messages arrived
                    // since the last SELECT/EXAMINE.
                    if (map.uid && (!mailbox.uidNext || mailbox.uidNext <= map.uid)) {
                        mailbox.uidNext = map.uid + 1;
                    }
                    break;

                case 'modseq':
                    map.modseq = BigInt(getArray(attribute)[0]);
                    // Similarly, keep the local highestModseq estimate up to date.
                    // This is critical for CONDSTORE/QRESYNC delta syncing.
                    if (map.modseq && (!mailbox.highestModseq || mailbox.highestModseq < map.modseq)) {
                        mailbox.highestModseq = map.modseq;
                    }
                    break;

                case 'emailid':
                    // OBJECTID extension (RFC 8474): server-assigned stable email identifier
                    map.emailId = getArray(attribute)[0];
                    break;

                case 'x-gm-msgid':
                    // Gmail extension: X-GM-MSGID is Gmail's unique message ID.
                    // Mapped to the same emailId field as OBJECTID for a unified API,
                    // but this is a Gmail-specific numeric string, not an RFC 8474 ObjectID.
                    map.emailId = getString(attribute);
                    break;

                case 'threadid':
                    map.threadId = getArray(attribute)[0];
                    break;

                case 'x-gm-thrid':
                    map.threadId = getString(attribute);
                    break;

                case 'x-gm-labels':
                    map.labels = new Set(getArray(attribute));
                    break;

                case 'rfc822.size':
                    map.size = Number(getString(attribute)) || 0;
                    break;

                case 'flags':
                    map.flags = new Set(getArray(attribute));
                    break;

                case 'envelope':
                    map.envelope = tools.parseEnvelope(attribute);
                    break;

                case 'bodystructure':
                    map.bodyStructure = tools.parseBodystructure(attribute);
                    break;

                case 'internaldate': {
                    let value = getString(attribute);
                    let date = new Date(value);
                    if (date.toString() === 'Invalid Date') {
                        map.internalDate = value;
                    } else {
                        map.internalDate = date;
                    }
                    break;
                }

                default: {
                    let match = key.match(/(body|binary)\[/i);
                    if (match) {
                        let partKey = key.replace(/^(body|binary)\[|]$/gi, '');
                        partKey = partKey.replace(/\.fields.*$/g, '');

                        let value = getBuffer(attribute);
                        if (partKey === 'header') {
                            map.headers = value;
                            break;
                        }

                        if (!map.bodyParts) {
                            map.bodyParts = new Map();
                        }
                        map.bodyParts.set(partKey, value);
                        break;
                    }
                    break;
                }
            }
        }

        if (map.emailId || map.uid) {
            // define account unique ID for this email

            // normalize path to use ascii, so we would always get the same ID
            let path = mailbox.path;
            if (/[0x80-0xff]/.test(path)) {
                try {
                    path = iconv.encode(path, 'utf-7-imap').toString();
                } catch {
                    // ignore
                }
            }

            map.id =
                map.emailId ||
                createHash('md5')
                    .update([path, mailbox.uidValidity?.toString() || '', map.uid.toString()].join(':'))
                    .digest('hex');
        }

        if (map.flags) {
            let flagColor = tools.getFlagColor(map.flags);
            if (flagColor) {
                map.flagColor = flagColor;
            }
        }

        return map;
    },

    /**
     * Strips surrounding double quotes from a name string.
     *
     * @param {String} name - Raw name string potentially wrapped in quotes
     * @returns {String} Name with surrounding quotes removed
     */
    processName(name) {
        name = (name || '').toString();
        if (name.length > 2 && name.at(0) === '"' && name.at(-1) === '"') {
            name = name.replace(/^"|"$/g, '');
        }
        return name;
    },

    /**
     * Parses a raw IMAP ENVELOPE response into a structured envelope object.
     *
     * @param {Array} entry - Raw envelope data array from IMAP response
     * @returns {Object} Parsed envelope with date, subject, from, to, cc, bcc, messageId, etc.
     */
    parseEnvelope(entry) {
        let getStrValue = obj => {
            if (!obj) {
                return false;
            }
            if (typeof obj.value === 'string') {
                return obj.value;
            }
            if (Buffer.isBuffer(obj.value)) {
                return obj.value.toString();
            }
            return obj.value;
        };

        let processAddresses = function (list) {
                return []
                    .concat(list || [])
                    .map(addr => {
                        let address = (getStrValue(addr[2]) || '') + '@' + (getStrValue(addr[3]) || '');
                        if (address === '@') {
                            address = '';
                        }
                        return {
                            name: tools.processName(libmime.decodeWords(getStrValue(addr[0]))),
                            address
                        };
                    })
                    .filter(addr => addr.name || addr.address);
            },
            envelope = {};

        if (entry[0] && entry[0].value) {
            let date = new Date(getStrValue(entry[0]));
            if (date.toString() === 'Invalid Date') {
                envelope.date = getStrValue(entry[0]);
            } else {
                envelope.date = date;
            }
        }

        if (entry[1] && entry[1].value) {
            envelope.subject = libmime.decodeWords(getStrValue(entry[1]));
        }

        if (entry[2] && entry[2].length) {
            envelope.from = processAddresses(entry[2]);
        }

        if (entry[3] && entry[3].length) {
            envelope.sender = processAddresses(entry[3]);
        }

        if (entry[4] && entry[4].length) {
            envelope.replyTo = processAddresses(entry[4]);
        }

        if (entry[5] && entry[5].length) {
            envelope.to = processAddresses(entry[5]);
        }

        if (entry[6] && entry[6].length) {
            envelope.cc = processAddresses(entry[6]);
        }

        if (entry[7] && entry[7].length) {
            envelope.bcc = processAddresses(entry[7]);
        }

        if (entry[8] && entry[8].value) {
            envelope.inReplyTo = (getStrValue(entry[8]) || '').toString().trim();
        }

        if (entry[9] && entry[9].value) {
            envelope.messageId = (getStrValue(entry[9]) || '').toString().trim();
        }

        return envelope;
    },

    /**
     * Parses structured MIME parameter arrays (including RFC 2231 continuations)
     * into a flat key-value object.
     *
     * @param {Array} arr - Raw parameter array from BODYSTRUCTURE response
     * @returns {Object} Key-value object of decoded parameters
     */
    getStructuredParams(arr) {
        let key;

        let params = {};

        // BODYSTRUCTURE parameters come as flat key/value pairs: [key1, val1, key2, val2, ...]
        [].concat(arr || []).forEach((val, j) => {
            if (j % 2) {
                params[key] = libmime.decodeWords(((val && val.value) || '').toString());
            } else {
                key = ((val && val.value) || '').toString().toLowerCase();
            }
        });

        // Detect RFC 2231 encoded filenames that were placed in the plain 'filename' param
        // instead of 'filename*'. The pattern charset'language'encoded_value indicates encoding.
        if (params.filename && !params['filename*'] && /^[a-z\-_0-9]+'[a-z]*'[^'\x00-\x08\x0b\x0c\x0e-\x1f\u0080-\uFFFF]+/.test(params.filename)) {
            // seems like encoded value
            let [encoding, , encodedValue] = params.filename.split("'");
            if (resolveCharset(encoding)) {
                params['filename*'] = `${encoding}''${encodedValue}`;
            }
        }

        // RFC 2231 parameter continuations: parameters like filename*0, filename*1, etc.
        // are split parts of a single value. Parameters ending with '*' contain charset info.
        // This pass collects continuation parts and groups them by their base key name.
        Object.keys(params).forEach(key => {
            let actualKey;
            let nr;
            let value;

            // Match keys ending with *N or *N* (where N is the continuation index)
            let match = key.match(/\*((\d+)\*?)?$/);

            if (!match) {
                // nothing to do here, does not seem like a continuation param
                return;
            }

            actualKey = key.substr(0, match.index).toLowerCase();
            nr = Number(match[2]) || 0;

            if (!params[actualKey] || typeof params[actualKey] !== 'object') {
                params[actualKey] = {
                    charset: false,
                    values: []
                };
            }

            value = params[key];

            // The first segment (*0*) may contain charset and language: charset'language'value
            if (nr === 0 && match[0].charAt(match[0].length - 1) === '*' && (match = value.match(/^([^']*)'[^']*'(.*)$/))) {
                params[actualKey].charset = match[1] || 'utf-8';
                value = match[2];
            }

            params[actualKey].values.push({ nr, value });

            // remove the old reference
            delete params[key];
        });

        // Reassemble split RFC 2231 strings by sorting continuation parts and joining them.
        // For charset-encoded values, convert URL-encoded (%XX) sequences to MIME quoted-printable
        // format (=?charset?Q?...?=) so libmime.decodeWords can decode them to Unicode.
        Object.keys(params).forEach(key => {
            let value;
            if (params[key] && Array.isArray(params[key].values)) {
                value = params[key].values
                    .sort((a, b) => a.nr - b.nr)
                    .map(val => (val && val.value) || '')
                    .join('');

                if (params[key].charset) {
                    // Convert URL encoding (%AB) to MIME quoted-printable (=AB) by:
                    // 1. Escaping QP-special chars (=, ?, _, space) as %XX
                    // 2. Replacing all '%' with '=' to switch from URL encoding to QP encoding
                    // 3. Wrapping in =?charset?Q?...?= for libmime to decode
                    params[key] = libmime.decodeWords(
                        '=?' +
                            params[key].charset +
                            '?Q?' +
                            value
                                // fix invalidly encoded chars
                                .replace(/[=?_\s]/g, s => {
                                    let c = s.charCodeAt(0).toString(16);
                                    if (s === ' ') {
                                        return '_';
                                    } else {
                                        return '%' + (c.length < 2 ? '0' : '') + c;
                                    }
                                })
                                // change from urlencoding to percent encoding
                                .replace(/%/g, '=') +
                            '?='
                    );
                } else {
                    params[key] = libmime.decodeWords(value);
                }
            }
        });

        return params;
    },

    /**
     * Parses a raw IMAP BODYSTRUCTURE response into a structured tree of body parts.
     *
     * @param {Array} entry - Raw BODYSTRUCTURE data array from IMAP response
     * @returns {Object} Parsed body structure tree with part numbers, types, parameters, and child nodes
     */
    parseBodystructure(entry) {
        // Recursively walks the BODYSTRUCTURE tree, building MIME part numbers.
        // Part numbers follow the IMAP dot-notation: "1", "1.1", "2.3", etc.
        // The root multipart has no part number; its children start at 1.
        let walk = (node, path) => {
            path = path || [];

            let curNode = {},
                i = 0,
                part = 0;

            // Build the dot-separated part number from the path array (e.g., [1,2] -> "1.2")
            if (path.length) {
                curNode.part = path.join('.');
            }

            // multipart: first elements are arrays (child body parts), followed by the subtype string
            if (Array.isArray(node[0])) {
                curNode.childNodes = [];
                // Each child array is a nested body part; increment part counter for each
                while (Array.isArray(node[i])) {
                    curNode.childNodes.push(walk(node[i], path.concat(++part)));
                    i++;
                }

                // multipart type
                curNode.type = 'multipart/' + ((node[i++] || {}).value || '').toString().toLowerCase();

                // extension data (not available for BODY requests)

                // body parameter parenthesized list
                if (i < node.length - 1) {
                    if (node[i]) {
                        curNode.parameters = tools.getStructuredParams(node[i]);
                    }
                    i++;
                }
            } else {
                // content type
                curNode.type = [((node[i++] || {}).value || '').toString().toLowerCase(), ((node[i++] || {}).value || '').toString().toLowerCase()].join('/');

                // body parameter parenthesized list
                if (node[i]) {
                    curNode.parameters = tools.getStructuredParams(node[i]);
                }
                i++;

                // id
                if (node[i]) {
                    curNode.id = ((node[i] || {}).value || '').toString();
                }
                i++;

                // description
                if (node[i]) {
                    curNode.description = ((node[i] || {}).value || '').toString();
                }
                i++;

                // encoding
                if (node[i]) {
                    curNode.encoding = ((node[i] || {}).value || '').toString().toLowerCase();
                }
                i++;

                // size
                if (node[i]) {
                    curNode.size = Number((node[i] || {}).value || 0) || 0;
                }
                i++;

                if (curNode.type === 'message/rfc822') {
                    // message/rfc822 is special in IMAP BODYSTRUCTURE: after the standard
                    // 7 fields, it includes an embedded envelope, a nested bodystructure,
                    // and a line count for the encapsulated message.

                    // envelope of the encapsulated message
                    if (node[i]) {
                        curNode.envelope = tools.parseEnvelope([].concat(node[i] || []));
                    }
                    i++;

                    if (node[i]) {
                        curNode.childNodes = [
                            // The nested bodystructure reuses the same path (not path+1) because
                            // the encapsulated message shares the part number with its wrapper.
                            // Distinction is via suffixes: path.MIME = wrapper headers,
                            // path.HEADER = encapsulated message headers.
                            walk(node[i], path)
                        ];
                    }
                    i++;

                    // line count
                    if (node[i]) {
                        curNode.lineCount = Number((node[i] || {}).value || 0) || 0;
                    }
                    i++;
                }

                if (/^text\//.test(curNode.type)) {
                    // Per RFC 3501, text/* parts include an additional line count field after size.
                    // However, some servers omit this field, producing 11 elements instead of 12+.

                    // NB! some less known servers do not include the line count value
                    // length should be 12+
                    if (node.length === 11 && Array.isArray(node[i + 1]) && !Array.isArray(node[i + 2])) {
                        // invalid structure, disposition params are shifted -- skip the line count
                    } else {
                        // correct structure, line count number is provided
                        if (node[i]) {
                            // line count
                            curNode.lineCount = Number((node[i] || {}).value || 0) || 0;
                        }
                        i++;
                    }
                }

                // extension data (not available for BODY requests)

                // md5
                if (i < node.length - 1) {
                    if (node[i]) {
                        curNode.md5 = ((node[i] || {}).value || '').toString().toLowerCase();
                    }
                    i++;
                }
            }

            // the following are shared extension values (for both multipart and non-multipart parts)
            // not available for BODY requests

            // body disposition
            if (i < node.length - 1) {
                if (Array.isArray(node[i]) && node[i].length) {
                    curNode.disposition = ((node[i][0] || {}).value || '').toString().toLowerCase();
                    if (Array.isArray(node[i][1])) {
                        curNode.dispositionParameters = tools.getStructuredParams(node[i][1]);
                    }
                }
                i++;
            }

            // body language
            if (i < node.length - 1) {
                if (node[i]) {
                    curNode.language = [].concat(node[i] || []).map(val => ((val && val.value) || '').toString().toLowerCase());
                }
                i++;
            }

            // body location
            // NB! defined as a "string list" in RFC3501 but replaced in errata document with "string"
            // Errata: http://www.rfc-editor.org/errata_search.php?rfc=3501
            if (i < node.length - 1) {
                if (node[i]) {
                    curNode.location = ((node[i] || {}).value || '').toString();
                }
                i++;
            }

            return curNode;
        };

        return walk(entry);
    },

    /**
     * Checks if a value is a Date object.
     *
     * @param {*} obj - Value to check
     * @returns {Boolean} True if the value is a Date object
     */
    isDate(obj) {
        return Object.prototype.toString.call(obj) === '[object Date]';
    },

    /**
     * Converts a value to a valid Date object, or returns null.
     *
     * @param {*} value - Date object or date string to convert
     * @returns {Date|null} Valid Date object, or null if conversion fails
     */
    toValidDate(value) {
        if (!value) {
            return null;
        }
        if (typeof value === 'string') {
            value = new Date(value);
        }
        if (!tools.isDate(value) || value.toString() === 'Invalid Date') {
            return null;
        }
        return value;
    },

    /**
     * Formats a date value into IMAP date format (DD-Mon-YYYY).
     *
     * @param {Date|String} value - Date to format
     * @returns {String|undefined} Formatted date string, or undefined if invalid
     */
    formatDate(value) {
        value = tools.toValidDate(value);
        if (!value) {
            return;
        }

        let dateParts = value.toISOString().substr(0, 10).split('-');
        dateParts.reverse();

        let months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        dateParts[1] = months[Number(dateParts[1]) - 1];

        return dateParts.join('-');
    },

    /**
     * Formats a date value into IMAP date-time format (DD-Mon-YYYY HH:MM:SS +0000).
     *
     * @param {Date|String} value - Date to format
     * @returns {String|undefined} Formatted date-time string, or undefined if invalid
     */
    formatDateTime(value) {
        value = tools.toValidDate(value);
        if (!value) {
            return;
        }

        let dateStr = tools.formatDate(value).replace(/^0/, ' '); //starts with date-day-fixed with leading 0 replaced by SP
        let timeStr = value.toISOString().substr(11, 8);

        return `${dateStr} ${timeStr} +0000`;
    },

    /**
     * Normalizes a flag string. Returns false for non-settable flags (e.g. \Recent),
     * and capitalizes system flags properly.
     *
     * @param {String} flag - Flag string to normalize
     * @returns {String|false} Normalized flag string, or false if the flag cannot be set
     */
    formatFlag(flag) {
        switch (flag.toLowerCase()) {
            case '\\recent':
                // can not set or remove
                return false;
            case '\\seen':
            case '\\answered':
            case '\\flagged':
            case '\\deleted':
            case '\\draft':
                // can not set or remove
                return flag.toLowerCase().replace(/^\\./, c => c.toUpperCase());
        }
        return flag;
    },

    /**
     * Checks if a flag can be used in the given mailbox based on permanent flags.
     *
     * @param {Object} mailbox - Mailbox object with permanentFlags
     * @param {String} flag - Flag to check
     * @returns {Boolean} True if the flag is allowed
     */
    canUseFlag(mailbox, flag) {
        return !mailbox || !mailbox.permanentFlags || mailbox.permanentFlags.has('\\*') || mailbox.permanentFlags.has(flag);
    },

    /**
     * Expands an IMAP sequence range string (e.g. "1:3,5,7:9") into an array of numbers.
     *
     * @param {String} range - IMAP sequence range string
     * @returns {Number[]} Array of expanded sequence numbers
     */
    expandRange(range) {
        return range.split(',').flatMap(entry => {
            entry = entry.trim();
            let colon = entry.indexOf(':');
            if (colon < 0) {
                return Number(entry) || 0;
            }
            let first = Number(entry.substr(0, colon)) || 0;
            let second = Number(entry.substr(colon + 1)) || 0;
            if (first === second) {
                return first;
            }
            let list = [];
            if (first < second) {
                for (let i = first; i <= second; i++) {
                    list.push(i);
                }
            } else {
                for (let i = first; i >= second; i--) {
                    list.push(i);
                }
            }
            return list;
        });
    },

    /**
     * Returns a stream decoder for the given charset. Uses a special Japanese
     * charset decoder for JIS/ISO-2022-JP, otherwise delegates to iconv-lite.
     *
     * @param {String} [charset='ascii'] - Character set name
     * @returns {Object} A stream decoder (Transform stream) for the charset
     */
    getDecoder(charset) {
        charset = (charset || 'ascii').toString().trim().toLowerCase();
        if (/^jis|^iso-?2022-?jp|^EUCJP/i.test(charset)) {
            // special case not supported by iconv-lite
            return new JPDecoder(charset);
        }

        return iconv.decodeStream(charset);
    },

    /**
     * Packs an array of message sequence numbers into a compact IMAP range string
     * (e.g. [1,2,3,5,7,8] becomes "1:3,5,7:8").
     *
     * @param {Number|Number[]} list - Sequence number or array of sequence numbers
     * @returns {String} Packed IMAP sequence range string
     */
    packMessageRange(list) {
        if (!Array.isArray(list)) {
            list = [].concat(list || []);
        }

        if (!list.length) {
            return '';
        }

        list.sort((a, b) => a - b);

        let last = list[list.length - 1];
        let result = [[last]];
        for (let i = list.length - 2; i >= 0; i--) {
            if (list[i] === list[i + 1] - 1) {
                result[0].unshift(list[i]);
                continue;
            }
            result.unshift([list[i]]);
        }

        result = result.map(item => {
            if (item.length === 1) {
                return item[0];
            }
            return item.shift() + ':' + item.pop();
        });

        return result.join(',');
    }
};

module.exports = tools;
