'use strict';

const { normalizePath, encodePath, expandRange, enhanceCommandError } = require('../tools.js');

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

    // Extract COPYUID response code (UIDPLUS, RFC 4315) from either an untagged
    // OK response or the final tagged OK. MOVE uses the same COPYUID format as COPY
    // to report the source-to-destination UID mapping.
    let checkMoveInfo = response => {
        let section = response.attributes && response.attributes[0] && response.attributes[0].section;
        let responseCode = section && section.length && section[0] && typeof section[0].value === 'string' ? section[0].value : '';
        switch (responseCode) {
            case 'COPYUID':
                {
                    let uidValidity = section[1] && typeof section[1].value === 'string' && !isNaN(section[1].value) ? BigInt(section[1].value) : false;
                    if (uidValidity) {
                        map.uidValidity = uidValidity;
                    }

                    let sourceUids = section[2] && typeof section[2].value === 'string' ? expandRange(section[2].value) : false;
                    let destinationUids = section[3] && typeof section[3].value === 'string' ? expandRange(section[3].value) : false;
                    if (sourceUids && destinationUids && sourceUids.length === destinationUids.length) {
                        map.uidMap = new Map(sourceUids.map((uid, i) => [uid, destinationUids[i]]));
                    }
                }
                break;
        }
    };

    let response;
    try {
        // Some servers send COPYUID in an untagged OK before the tagged response,
        // others include it in the tagged OK. We check both to be safe.
        response = await connection.exec(options.uid ? 'UID MOVE' : 'MOVE', attributes, {
            untagged: {
                OK: async untagged => {
                    checkMoveInfo(untagged);
                }
            }
        });
        response.next();

        checkMoveInfo(response.response);
        return map;
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
