'use strict';

/**
 * Requests DEFLATE compression from the server.
 *
 * @param {Object} connection - IMAP connection instance
 * @returns {Promise<boolean>} True if compression was enabled, false otherwise
 */
// COMPRESS=DEFLATE (RFC 4978): enables zlib compression on the IMAP connection
// to reduce bandwidth. Once enabled, all subsequent data in both directions is compressed.
module.exports = async connection => {
    // Skip if the server doesn't support COMPRESS=DEFLATE, or if compression
    // is already active (connection._inflate exists) to avoid double-compression.
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
