'use strict';

/**
 * Requests DEFLATE compression from the server.
 *
 * @param {Object} connection - IMAP connection instance
 * @returns {Promise<boolean>} True if compression was enabled, false otherwise
 */
module.exports = async connection => {
    if (!connection.capabilities.has('COMPRESS=DEFLATE') || connection._inflate) {
        // nothing to do here
        return false;
    }

    let response;
    try {
        response = await connection.exec('COMPRESS', [{ type: 'ATOM', value: 'DEFLATE' }]);
        response.next();
        return true;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
