/* eslint no-control-regex:0 */

'use strict';

const libmime = require('libmime');
const { compiler } = require('./handler/imap-handler');
const { createHash } = require('crypto');
const { JPDecoder } = require('./jp-decoder');
const iconv = require('iconv-lite');

module.exports = {
    encodePath(connection, path) {
        path = (path || '').toString();
        if (!connection.enabled.has('UTF8=ACCEPT') && /[&\x00-\x08\x0b-\x0c\x0e-\x1f\u0080-\uffff]/.test(path)) {
            try {
                path = iconv.encode(path, 'utf-7-imap').toString();
            } catch (err) {
                // ignore, keep name as is
            }
        }
        return path;
    },

    decodePath(connection, path) {
        path = (path || '').toString();
        if (!connection.enabled.has('UTF8=ACCEPT') && /[&]/.test(path)) {
            try {
                path = iconv.decode(Buffer.from(path), 'utf-7-imap').toString();
            } catch (err) {
                // ignore, keep name as is
            }
        }
        return path;
    },

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

    comparePaths(connection, a, b) {
        if (!a || !b) {
            return false;
        }
        return module.exports.normalizePath(connection, a) === module.exports.normalizePath(connection, b);
    },

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

    async getErrorText(response) {
        if (!response) {
            return false;
        }

        return (await compiler(response)).toString();
    },

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
                    listed: !!folder.listed
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
                    .replace(/<\d+>$/, '');
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
                    if (map.uid && (!mailbox.uidNext || mailbox.uidNext <= map.uid)) {
                        // current uidNext seems to be outdated, bump it
                        mailbox.uidNext = map.uid + 1;
                    }
                    break;

                case 'modseq':
                    map.modseq = BigInt(getArray(attribute)[0]);
                    if (map.modseq && (!mailbox.highestModseq || mailbox.highestModseq < map.modseq)) {
                        // current highestModseq seems to be outdated, bump it
                        mailbox.highestModseq = map.modseq;
                    }
                    break;

                case 'emailid':
                    map.emailId = getArray(attribute)[0];
                    break;

                case 'x-gm-msgid':
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
                    map.envelope = module.exports.parseEnvelope(attribute);
                    break;

                case 'bodystructure':
                    map.bodyStructure = module.exports.parseBodystructure(attribute);
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
                } catch (err) {
                    // ignore
                }
            }

            map.id = map.emailId || createHash('md5').update([path, mailbox.uidValidity.toString(), map.uid.toString()].join(':')).digest('hex');
        }

        return map;
    },

    processName(name) {
        name = (name || '').toString();
        if (name.length > 2 && name.at(0) === '"' && name.at(-1) === '"') {
            name = name.replace(/^"|"$/g, '');
        }
        return name;
    },

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
                return [].concat(list || []).map(addr => ({
                    name: module.exports.processName(libmime.decodeWords(getStrValue(addr[0]))),
                    address: (getStrValue(addr[2]) || '') + '@' + (getStrValue(addr[3]) || '')
                }));
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

    getStructuredParams(arr) {
        let key;

        let params = {};

        [].concat(arr || []).forEach((val, j) => {
            if (j % 2) {
                params[key] = libmime.decodeWords(((val && val.value) || '').toString());
            } else {
                key = ((val && val.value) || '').toString().toLowerCase();
            }
        });

        // preprocess values
        Object.keys(params).forEach(key => {
            let actualKey;
            let nr;
            let value;

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

            if (nr === 0 && match[0].charAt(match[0].length - 1) === '*' && (match = value.match(/^([^']*)'[^']*'(.*)$/))) {
                params[actualKey].charset = match[1] || 'utf-8';
                value = match[2];
            }

            params[actualKey].values.push({ nr, value });

            // remove the old reference
            delete params[key];
        });

        // concatenate split rfc2231 strings and convert encoded strings to mime encoded words
        Object.keys(params).forEach(key => {
            let value;
            if (params[key] && Array.isArray(params[key].values)) {
                value = params[key].values
                    .sort((a, b) => a.nr - b.nr)
                    .map(val => (val && val.value) || '')
                    .join('');

                if (params[key].charset) {
                    // convert "%AB" to "=?charset?Q?=AB?=" and then to unicode
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

    parseBodystructure(entry) {
        let walk = (node, path) => {
            path = path || [];

            let curNode = {},
                i = 0,
                part = 0;

            if (path.length) {
                curNode.part = path.join('.');
            }

            // multipart
            if (Array.isArray(node[0])) {
                curNode.childNodes = [];
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
                        curNode.parameters = this.getStructuredParams(node[i]);
                    }
                    i++;
                }
            } else {
                // content type
                curNode.type = [((node[i++] || {}).value || '').toString().toLowerCase(), ((node[i++] || {}).value || '').toString().toLowerCase()].join('/');

                // body parameter parenthesized list
                if (node[i]) {
                    curNode.parameters = this.getStructuredParams(node[i]);
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
                    // message/rfc adds additional envelope, bodystructure and line count values

                    // envelope
                    if (node[i]) {
                        curNode.envelope = module.exports.parseEnvelope([].concat(node[i] || []));
                    }
                    i++;

                    if (node[i]) {
                        curNode.childNodes = [
                            // rfc822 bodyparts share the same path, difference is between MIME and HEADER
                            // path.MIME returns message/rfc822 header
                            // path.HEADER returns inlined message header
                            walk(node[i], path)
                        ];
                    }
                    i++;

                    // line count
                    if (node[i]) {
                        curNode.lineCount = Number((node[i] || {}).value || 0) || 0;
                    }
                    i++;
                } else if (/^text\//.test(curNode.type)) {
                    // text/* adds additional line count values

                    // line count
                    if (node[i]) {
                        curNode.lineCount = Number((node[i] || {}).value || 0) || 0;
                    }
                    i++;
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
                        curNode.dispositionParameters = this.getStructuredParams(node[i][1]);
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

    formatDate(value) {
        if (typeof value === 'string') {
            value = new Date(value);
        }

        if (Object.prototype.toString(value) !== '[object Object]' || value.toString() === 'Invalid Date') {
            return;
        }

        value = value.toISOString().substr(0, 10);
        value = value.split('-');
        value.reverse();

        let months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        value[1] = months[Number(value[1]) - 1];

        return value.join('-');
    },

    formatDateTime(value) {
        if (!value) {
            return;
        }

        if (typeof value === 'string') {
            value = new Date(value);
        }

        if (Object.prototype.toString(value) !== '[object Object]' || value.toString() === 'Invalid Date') {
            return;
        }

        let dateStr = module.exports.formatDate(value).replace(/^0/, ''); //starts with date-day-fixed with leading 0 replaced by SP
        let timeStr = value.toISOString().substr(11, 8);

        return `${dateStr} ${timeStr} +0000`;
    },

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

    canUseFlag(mailbox, flag) {
        return !mailbox || !mailbox.permanentFlags || mailbox.permanentFlags.has('\\*') || mailbox.permanentFlags.has(flag);
    },

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

    getDecoder(charset) {
        charset = (charset || 'ascii').toString().trim().toLowerCase();
        if (/^jis|^iso-?2022-?jp|^EUCJP/i.test(charset)) {
            // special case not supported by iconv-lite
            return new JPDecoder(charset);
        }

        return iconv.decodeStream(charset);
    },

    packMessageRange(list) {
        if (typeof uidList === 'string')
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
