'use strict';

const { encodePath, normalizePath, buildStatusQueryAttributes, isRev2Active } = require('../tools.js');
const { parseStatusList } = require('./status-fields.js');

// STATUS fields that also refresh the live mailbox state when the queried mailbox is the
// currently selected one. Keyed by the output property name parseStatusList() reports.
const MAILBOX_UPDATERS = {
    messages: (value, connection, path) => {
        let prevCount = connection.mailbox.exists;
        if (prevCount !== value) {
            connection.mailbox.exists = value;
            connection.emit('exists', { path, count: value, prevCount });
        }
    },
    uidNext: (value, connection) => {
        connection.mailbox.uidNext = value;
    },
    highestModseq: (value, connection) => {
        connection.mailbox.highestModseq = value;
    }
};

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

    // Build the list of STATUS data items the caller wants
    let queryAttributes = buildStatusQueryAttributes(connection, query);

    // RECENT does not exist in IMAP4rev2 so it is never requested from a rev2
    // session; its defined value there is always 0. Synthesizing it keeps the
    // return shape identical to a rev1 session for the same query.
    let syntheticRecent = query && query.recent && isRev2Active(connection);

    if (!queryAttributes.length) {
        // A query that only contained items unavailable on this session - the
        // caller still gets a status object if every such item has a defined value
        return syntheticRecent ? { path, recent: 0 } : false;
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
                    parseStatusList(list, (key, value) => {
                        map[key] = value;

                        if (updateCurrent && MAILBOX_UPDATERS[key]) {
                            MAILBOX_UPDATERS[key](value, connection, path);
                        }
                    });
                }
            }
        });
        response.next();
        if (syntheticRecent) {
            map.recent = 0;
        }
        return map;
    } catch (err) {
        // A NO response usually means the mailbox doesn't exist. Verify by
        // running LIST -- if no results, throw a clear NotFound error instead
        // of the generic IMAP error.
        // Note: this uses run(), so when STATUS was dispatched by fallback polling through
        // runInternal() the LIST awaits that polling session's own preCheck and cancels it.
        // Not a deadlock, and only reachable when the server rejects the STATUS, but a polled
        // STATUS of a missing folder ends the poll early.
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
