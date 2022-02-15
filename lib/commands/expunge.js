'use strict';

const { getStatusCode, getErrorText } = require('../tools.js');

// Deletes specified messages
module.exports = async (connection, range, options) => {
    if (connection.state !== connection.states.SELECTED || !range) {
        // nothing to do here
        return;
    }

    options = options || {};

    await connection.messageFlagsAdd(range, ['\\Deleted'], options);

    let byUid = options.uid && connection.capabilities.has('UIDPLUS');
    let command = byUid ? 'UID EXPUNGE' : 'EXPUNGE';
    let attributes = byUid ? [{ type: 'SEQUENCE', value: range }] : false;

    let response;
    try {
        response = await connection.exec(command, attributes);

        // A OK [HIGHESTMODSEQ 9122] Expunge completed (0.010 + 0.000 + 0.012 secs).
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
        let errorCode = getStatusCode(err.response);
        if (errorCode) {
            err.serverResponseCode = errorCode;
        }
        err.response = await getErrorText(err.response);

        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
