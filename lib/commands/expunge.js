'use strict';

const { enhanceCommandError } = require('../tools.js');

/**
 * Deletes specified messages by flagging them as Deleted and expunging.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} range - Message sequence number or UID range
 * @param {Object} [options] - Expunge options
 * @param {boolean} [options.uid] - If true, use UID EXPUNGE when UIDPLUS is available
 * @returns {Promise<boolean|undefined>} True on success, false on failure, or undefined if preconditions not met
 */
module.exports = async (connection, range, options) => {
    if (connection.state !== connection.states.SELECTED || !range) {
        // nothing to do here
        return;
    }

    options = options || {};

    // Two-step deletion process per IMAP protocol:
    // Step 1: Mark the target messages with the \Deleted flag.
    await connection.messageFlagsAdd(range, ['\\Deleted'], options);

    // Step 2: Issue EXPUNGE to permanently remove \Deleted messages.
    // With UIDPLUS (RFC 4315): "UID EXPUNGE <uids>" removes only the specified UIDs,
    // leaving other \Deleted messages untouched -- important for concurrent access.
    // Without UIDPLUS: plain "EXPUNGE" removes ALL messages flagged \Deleted in the mailbox.
    let byUid = options.uid && connection.capabilities.has('UIDPLUS');
    let command = byUid ? 'UID EXPUNGE' : 'EXPUNGE';
    let attributes = byUid ? [{ type: 'SEQUENCE', value: range }] : false;

    let response;
    try {
        response = await connection.exec(command, attributes);

        // CONDSTORE (RFC 7162): the server may return HIGHESTMODSEQ in the response code
        // (e.g., "A OK [HIGHESTMODSEQ 9122] Expunge completed").
        // Track this so the client can detect concurrent mailbox changes via mod-sequences.
        let section = response.response.attributes && response.response.attributes[0] && response.response.attributes[0].section;
        let responseCode = section && section.length && section[0] && typeof section[0].value === 'string' ? section[0].value : '';
        if (responseCode.toUpperCase() === 'HIGHESTMODSEQ') {
            let highestModseq = section[1] && typeof section[1].value === 'string' && !isNaN(section[1].value) ? BigInt(section[1].value) : false;
            if (highestModseq && (!connection.mailbox.highestModseq || highestModseq > connection.mailbox.highestModseq)) {
                connection.mailbox.highestModseq = highestModseq;
            }
        }

        response.next();
        return true;
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
