'use strict';

const { encodePath, normalizePath } = require('../tools.js');

/**
 * Requests status information about a mailbox.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} path - Mailbox path to query
 * @param {Object} query - Status data items to request (e.g., {messages: true, uidNext: true, unseen: true})
 * @returns {Promise<{path: string, messages?: number, recent?: number, uidNext?: number, uidValidity?: BigInt, unseen?: number, highestModseq?: BigInt}|boolean>} Status information object, or false if preconditions not met or on failure
 * @throws {Error} If the mailbox does not exist
 */
module.exports = async (connection, path, query) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state) || !path) {
        // nothing to do here
        return false;
    }

    path = normalizePath(connection, path);
    let encodedPath = encodePath(connection, path);

    // Use quoted STRING if the encoded path contains '&' (modified UTF-7 marker),
    // otherwise use unquoted ATOM. Same approach as in SELECT.
    let attributes = [{ type: encodedPath.indexOf('&') >= 0 ? 'STRING' : 'ATOM', value: encodedPath }];

    // Build the list of STATUS data items the caller wants.
    // HIGHESTMODSEQ requires the CONDSTORE extension to be available.
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
                // STATUS response: * STATUS <mailbox> (<key> <value> <key> <value> ...)
                // Parsed as alternating key-value pairs (i % 2 pattern).
                STATUS: async untagged => {
                    // If querying the currently selected mailbox, also update the
                    // connection's live mailbox state and emit events for changes.
                    let updateCurrent = connection.state === connection.states.SELECTED && path === connection.mailbox.path;

                    let list = untagged.attributes && Array.isArray(untagged.attributes[1]) ? untagged.attributes[1] : false;
                    if (!list) {
                        return;
                    }
                    // Maps IMAP STATUS field names to their output key names, type parsers,
                    // and optional callbacks to update the live mailbox state.
                    const STATUS_FIELD_MAP = {
                        MESSAGES: {
                            key: 'messages',
                            parser: Number,
                            updateMailbox: (val, conn) => {
                                let prevCount = conn.mailbox.exists;
                                if (prevCount !== val) {
                                    conn.mailbox.exists = val;
                                    conn.emit('exists', { path, count: val, prevCount });
                                }
                            }
                        },
                        RECENT: { key: 'recent', parser: Number },
                        UIDNEXT: {
                            key: 'uidNext',
                            parser: Number,
                            updateMailbox: (val, conn) => {
                                conn.mailbox.uidNext = val;
                            }
                        },
                        UIDVALIDITY: { key: 'uidValidity', parser: BigInt },
                        UNSEEN: { key: 'unseen', parser: Number },
                        HIGHESTMODSEQ: {
                            key: 'highestModseq',
                            parser: BigInt,
                            updateMailbox: (val, conn) => {
                                conn.mailbox.highestModseq = val;
                            }
                        }
                    };

                    let key;
                    list.forEach((entry, i) => {
                        if (i % 2 === 0) {
                            key = entry && typeof entry.value === 'string' ? entry.value : false;
                            return;
                        }
                        if (!key || !entry || typeof entry.value !== 'string') {
                            return;
                        }

                        const fieldConfig = STATUS_FIELD_MAP[key.toUpperCase()];
                        if (!fieldConfig) {
                            return;
                        }

                        const value = !isNaN(entry.value) ? fieldConfig.parser(entry.value) : false;
                        if (value === false) {
                            return;
                        }

                        map[fieldConfig.key] = value;

                        if (updateCurrent && fieldConfig.updateMailbox) {
                            fieldConfig.updateMailbox(value, connection);
                        }
                    });
                }
            }
        });
        response.next();
        return map;
    } catch (err) {
        // A NO response usually means the mailbox doesn't exist. Verify by
        // running LIST -- if no results, throw a clear NotFound error instead
        // of the generic IMAP error.
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
