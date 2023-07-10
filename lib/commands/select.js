'use strict';

const { encodePath, normalizePath, getStatusCode, getErrorText } = require('../tools.js');

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

        let extraArgs = [];
        if (connection.enabled.has('QRESYNC') && options.changedSince && options.uidValidity) {
            extraArgs.push([
                { type: 'ATOM', value: 'QRESYNC' },
                [
                    { type: 'ATOM', value: options.uidValidity.toString() },
                    { type: 'ATOM', value: options.changedSince.toString() }
                ]
            ]);
            map.qresync = true;
        }

        let encodedPath = encodePath(connection, path);

        let selectCommand = {
            command: !options.readOnly ? 'SELECT' : 'EXAMINE',
            arguments: [{ type: encodedPath.indexOf('&') >= 0 ? 'STRING' : 'ATOM', value: encodedPath }].concat(extraArgs || [])
        };

        response = await connection.exec(selectCommand.command, selectCommand.arguments, {
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

                    if (section && section.length === 1 && section[0].type === 'ATOM' && typeof section[0].value === 'string') {
                        let key = section[0].value.toLowerCase();
                        switch (key) {
                            case 'nomodseq':
                                key = 'noModseq';
                                map[key] = true;
                                break;
                        }
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
                },
                VANISHED: async untagged => {
                    await connection.untaggedVanished(
                        untagged,
                        // mailbox is not yet open, so use a dummy mailbox object
                        { path, uidNext: false, uidValidity: false }
                    );
                },
                // we should only get an untagged FETCH for a SELECT/EXAMINE if QRESYNC was asked for
                FETCH: async untagged => {
                    await connection.untaggedFetch(
                        untagged,
                        // mailbox is not yet open, so use a dummy mailbox object
                        { path, uidNext: false, uidValidity: false }
                    );
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

        if (
            map.qresync &&
            // UIDVALIDITY must be the same
            (options.uidValidity !== map.uidValidity ||
                // HIGHESTMODSEQ response must be present
                !map.highestModseq ||
                // NOMODSEQ is not allowed
                map.noModseq)
        ) {
            // QRESYNC does not apply here, so unset it
            map.qresync = false;
        }

        let currentMailbox = connection.mailbox;
        connection.mailbox = false;

        if (currentMailbox && currentMailbox.path !== path) {
            connection.emit('mailboxClose', currentMailbox);
        }

        connection.mailbox = map;
        connection.currentSelectCommand = selectCommand;
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
            connection.currentSelectCommand = false;
            connection.state = connection.states.AUTHENTICATED;

            if (currentMailbox) {
                connection.emit('mailboxClose', currentMailbox);
            }
        }

        connection.log.warn({ err, cid: connection.id });
        throw err;
    }
};
