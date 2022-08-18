'use strict';

const { encodePath, normalizePath } = require('../tools.js');

// Requests info about a mailbox
module.exports = async (connection, path, query) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state) || !path) {
        // nothing to do here
        return false;
    }

    path = normalizePath(connection, path);
    let encodedPath = encodePath(connection, path);

    let attributes = [{ type: encodedPath.indexOf('&') >= 0 ? 'STRING' : 'ATOM', value: encodedPath }];

    let queryAttributes = [];
    Object.keys(query || {}).forEach(key => {
        if (!query[key]) {
            return;
        }

        switch (key.toUpperCase()) {
            case 'MESSAGES':
            case 'RECENT':
            case 'UIDNEXT':
            case 'UIDVALIDITY':
            case 'UNSEEN':
                queryAttributes.push({ type: 'ATOM', value: key.toUpperCase() });
                break;

            case 'HIGHESTMODSEQ':
                if (connection.capabilities.has('CONDSTORE')) {
                    queryAttributes.push({ type: 'ATOM', value: key.toUpperCase() });
                }
                break;
        }
    });

    if (!queryAttributes.length) {
        return false;
    }

    attributes.push(queryAttributes);

    let response;
    try {
        let map = { path };
        response = await connection.exec('STATUS', attributes, {
            untagged: {
                STATUS: async untagged => {
                    // If STATUS is for current mailbox then update mailbox values
                    let updateCurrent = connection.state === connection.states.SELECTED && path === connection.mailbox.path;

                    let list = untagged.attributes && Array.isArray(untagged.attributes[1]) ? untagged.attributes[1] : false;
                    if (!list) {
                        return;
                    }
                    let key;
                    list.forEach((entry, i) => {
                        if (i % 2 === 0) {
                            key = entry && typeof entry.value === 'string' ? entry.value : false;
                            return;
                        }
                        if (!key || !entry || typeof entry.value !== 'string') {
                            return;
                        }
                        let value = false;
                        switch (key.toUpperCase()) {
                            case 'MESSAGES':
                                key = 'messages';
                                value = !isNaN(entry.value) ? Number(entry.value) : false;
                                if (updateCurrent) {
                                    let prevCount = connection.mailbox.exists;
                                    if (prevCount !== value) {
                                        // somehow message count in current folder has changed?
                                        connection.mailbox.exists = value;
                                        connection.emit('exists', {
                                            path,
                                            count: value,
                                            prevCount
                                        });
                                    }
                                }
                                break;

                            case 'RECENT':
                                key = 'recent';
                                value = !isNaN(entry.value) ? Number(entry.value) : false;
                                break;

                            case 'UIDNEXT':
                                key = 'uidNext';
                                value = !isNaN(entry.value) ? Number(entry.value) : false;
                                if (updateCurrent) {
                                    connection.mailbox.uidNext = value;
                                }
                                break;

                            case 'UIDVALIDITY':
                                key = 'uidValidity';
                                value = !isNaN(entry.value) ? BigInt(entry.value) : false;
                                break;

                            case 'UNSEEN':
                                key = 'unseen';
                                value = !isNaN(entry.value) ? Number(entry.value) : false;
                                break;

                            case 'HIGHESTMODSEQ':
                                key = 'highestModseq';
                                value = !isNaN(entry.value) ? BigInt(entry.value) : false;
                                if (updateCurrent) {
                                    connection.mailbox.highestModseq = value;
                                }
                                break;
                        }
                        if (value === false) {
                            return;
                        }

                        map[key] = value;
                    });
                }
            }
        });
        response.next();
        return map;
    } catch (err) {
        if (err.responseStatus === 'NO') {
            let folders = await connection.run('LIST', '', path, { listOnly: true });
            if (folders && !folders.length) {
                let error = new Error(`Mailbox doesn't exist: ${path}`);
                error.code = 'NotFound';
                error.response = err;
                throw error;
            }
        }

        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
