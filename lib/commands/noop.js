'use strict';

/**
 * Sends a NOOP command to the server.
 *
 * @param {Object} connection - IMAP connection instance
 * @returns {Promise<boolean>} True on success, false on failure
 */
module.exports = async connection => {
    try {
        let response = await connection.exec('NOOP', false, { comment: 'Requested by command' });
        response.next();
        return true;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
