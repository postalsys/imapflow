'use strict';

const { normalizePath, encodePath, expandRange, enhanceCommandError } = require('../tools.js');

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
        // Format: [COPYUID <uidValidity> <sourceUids> <destUids>]
        let section = response.response.attributes && response.response.attributes[0] && response.response.attributes[0].section;
        let responseCode = section && section.length && section[0] && typeof section[0].value === 'string' ? section[0].value : '';
        switch (responseCode) {
            case 'COPYUID':
                {
                    // section[1] = destination mailbox UIDVALIDITY
                    let uidValidity = section[1] && typeof section[1].value === 'string' && !isNaN(section[1].value) ? BigInt(section[1].value) : false;
                    if (uidValidity) {
                        map.uidValidity = uidValidity;
                    }

                    // section[2] = source UID set, section[3] = destination UID set
                    // Both can be ranges (e.g., "1:3") which expandRange() converts to arrays
                    let sourceUids = section[2] && typeof section[2].value === 'string' ? expandRange(section[2].value) : false;
                    let destinationUids = section[3] && typeof section[3].value === 'string' ? expandRange(section[3].value) : false;
                    // Build a source->destination UID map for the caller to track where messages went
                    if (sourceUids && destinationUids && sourceUids.length === destinationUids.length) {
                        map.uidMap = new Map(sourceUids.map((uid, i) => [uid, destinationUids[i]]));
                    }
                }
                break;
        }

        return map;
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
