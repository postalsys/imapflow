'use strict';

const { normalizePath, encodePath, enhanceCommandError } = require('../tools.js');
const { parseCopyUid } = require('./copyuid-parser.js');

/**
 * Copies messages from the current mailbox to another mailbox.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} range - Message sequence number or UID range
 * @param {string} destination - Destination mailbox path
 * @param {Object} [options] - Copy options
 * @param {boolean} [options.uid] - If true, use UID COPY instead of COPY
 * @returns {Promise<{path: string, destination: string, uidValidity?: BigInt, uidMap?: Map}|boolean|undefined>} Copy result with UID mapping if available, false on failure, or undefined if preconditions not met
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

    let response;
    try {
        response = await connection.exec(options.uid ? 'UID COPY' : 'COPY', attributes);
        response.next();

        let map = { path: connection.mailbox.path, destination };

        // UIDPLUS (RFC 4315): the server may include a COPYUID response code in the
        // tagged OK response, providing a mapping from source UIDs to destination UIDs.
        parseCopyUid(response.response, map);

        return map;
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
