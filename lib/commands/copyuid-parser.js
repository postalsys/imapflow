'use strict';

const { expandRange } = require('../tools.js');

/**
 * Parses COPYUID response code from an IMAP response (RFC 4315).
 * Used by both COPY and MOVE commands to extract the UID mapping
 * from source mailbox to destination mailbox.
 *
 * @param {Object} response - IMAP response object with attributes
 * @param {Object} map - Result map to populate with uidValidity and uidMap
 */
function parseCopyUid(response, map) {
    let section = response.attributes && response.attributes[0] && response.attributes[0].section;
    let responseCode = section && section.length && section[0] && typeof section[0].value === 'string' ? section[0].value : '';

    if (responseCode !== 'COPYUID') {
        return;
    }

    let uidValidity = section[1] && typeof section[1].value === 'string' && !isNaN(section[1].value) ? BigInt(section[1].value) : false;
    if (uidValidity !== false) {
        map.uidValidity = uidValidity;
    }

    let sourceUids = section[2] && typeof section[2].value === 'string' ? expandRange(section[2].value) : false;
    let destinationUids = section[3] && typeof section[3].value === 'string' ? expandRange(section[3].value) : false;
    if (sourceUids && destinationUids && sourceUids.length === destinationUids.length) {
        map.uidMap = new Map(sourceUids.map((uid, i) => [uid, destinationUids[i]]));
    }
}

module.exports = { parseCopyUid };
