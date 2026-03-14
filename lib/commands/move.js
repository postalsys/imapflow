'use strict';

const { normalizePath, encodePath, enhanceCommandError } = require('../tools.js');
const { parseCopyUid } = require('./copyuid-parser.js');

/**
 * Moves messages from the current mailbox to another mailbox.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} range - Message sequence number or UID range
 * @param {string} destination - Destination mailbox path
 * @param {Object} [options] - Move options
 * @param {boolean} [options.uid] - If true, use UID MOVE instead of MOVE
 * @returns {Promise<{path: string, destination: string, uidValidity?: BigInt, uidMap?: Map}|boolean|undefined>} Move result with UID mapping if available, false on failure, or undefined if preconditions not met
 */
module.exports = async (connection, range, destination, options) => {
    if (connection.state !== connection.states.SELECTED || !range || !destination) {
        // nothing to do here
        return;
    }

    options = options || {};
    destination = normalizePath(connection, destination);

    let attributes = [
        { type: 'SEQUENCE', value: range },
        { type: 'ATOM', value: encodePath(connection, destination) }
    ];

    let map = { path: connection.mailbox.path, destination };

    // Fallback for servers without the MOVE extension (RFC 6851):
    // emulate MOVE using COPY + flag as \Deleted + EXPUNGE.
    if (!connection.capabilities.has('MOVE')) {
        let result = await connection.messageCopy(range, destination, options);
        await connection.messageDelete(range, Object.assign({ silent: true }, options));
        return result;
    }

    let response;
    try {
        // Some servers send COPYUID in an untagged OK before the tagged response,
        // others include it in the tagged OK. We check both to be safe.
        response = await connection.exec(options.uid ? 'UID MOVE' : 'MOVE', attributes, {
            untagged: {
                OK: async untagged => {
                    parseCopyUid(untagged, map);
                }
            }
        });
        response.next();

        parseCopyUid(response.response, map);
        return map;
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
