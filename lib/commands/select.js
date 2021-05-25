'use strict';

const { normalizePath, getStatusCode, getErrorText } = require('../tools.js');

// Selects a mailbox
module.exports = async (connection, path, options) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }
    options = options || {};

    path = normalizePath(connection, path);

    if (!connection.folders.has(path)) {
        let folders = await connection.run('LIST', '', path);
        if (!folders) {
            throw new Error('Failed to fetch folders');
        }
        folders.forEach(folder => {
            connection.folders.set(folder.path, folder);
        });
    }
    let folderListData = connection.folders.has(path) ? connection.folders.get(path) : false;

    let response;
    try {
        let map = { path };
        if (folderListData) {
            ['delimiter', 'specialUse', 'subscribed', 'listed'].forEach(key => {
                if (folderListData[key]) {
                    map[key] = folderListData[key];
                }
            });
        }
        response = await connection.exec(!options.readOnly ? 'SELECT' : 'EXAMINE', [{ type: 'ATOM', value: path }], {
            untagged: {
                OK: async untagged => {
                    if (!untagged.attributes || !untagged.attributes.length) {
                        return;
                    }
                    let section = !untagged.attributes[0].value && untagged.attributes[0].section;
                    if (section && section.length > 1 && section[0].type === 'ATOM' && typeof section[0].value === 'string') {
                        let key = section[0].value.toLowerCase();
                        let value;

                        if (typeof section[1].value === 'string') {
                            value = section[1].value;
                        } else if (Array.isArray(section[1])) {
                            value = section[1].map(entry => (typeof entry.value === 'string' ? entry.value : false)).filter(entry => entry);
                        }

                        switch (key) {
                            case 'highestmodseq':
                                key = 'highestModseq';
                                if (/^[0-9]+$/.test(value)) {
                                    value = BigInt(value);
                                }
                                break;

                            case 'mailboxid':
                                key = 'mailboxId';
                                if (Array.isArray(value) && value.length) {
                                    value = value[0];
                                }
                                break;

                            case 'permanentflags':
                                key = 'permanentFlags';
                                value = new Set(value);
                                break;

                            case 'uidnext':
                                key = 'uidNext';
                                value = Number(value);
                                break;

                            case 'uidvalidity':
                                key = 'uidValidity';
                                if (/^[0-9]+$/.test(value)) {
                                    value = BigInt(value);
                                }
                                break;
                        }

                        map[key] = value;
                    }
                },
                FLAGS: async untagged => {
                    if (!untagged.attributes || (!untagged.attributes.length && Array.isArray(untagged.attributes[0]))) {
                        return;
                    }
                    let flags = untagged.attributes[0].map(flag => (typeof flag.value === 'string' ? flag.value : false)).filter(flag => flag);
                    map.flags = new Set(flags);
                },
                EXISTS: async untagged => {
                    let num = Number(untagged.command);
                    if (isNaN(num)) {
                        return false;
                    }

                    map.exists = num;
                }
            }
        });

        let section = !response.response.attributes[0].value && response.response.attributes[0].section;
        if (section && section.length && section[0].type === 'ATOM' && typeof section[0].value === 'string') {
            switch (section[0].value.toUpperCase()) {
                case 'READ-ONLY':
                    map.readOnly = true;
                    break;
                case 'READ-WRITE':
                default:
                    map.readOnly = false;
                    break;
            }
        }

        let currentMailbox = connection.mailbox;
        connection.mailbox = false;

        if (currentMailbox && currentMailbox.path !== path) {
            connection.emit('mailboxClose', currentMailbox);
        }

        connection.mailbox = map;
        connection.state = connection.states.SELECTED;

        if (!currentMailbox || currentMailbox.path !== path) {
            connection.emit('mailboxOpen', connection.mailbox);
        }

        response.next();
        return map;
    } catch (err) {
        let errorCode = getStatusCode(err.response);
        if (errorCode) {
            err.serverResponseCode = errorCode;
        }
        err.response = await getErrorText(err.response);

        if (connection.state === connection.states.SELECTED) {
            // reset selected state

            let currentMailbox = connection.mailbox;

            connection.mailbox = false;
            connection.state = connection.states.AUTHENTICATED;

            if (currentMailbox) {
                connection.emit('mailboxClose', currentMailbox);
            }
        }

        connection.log.warn({ err, cid: connection.id });
        throw err;
    }
};
