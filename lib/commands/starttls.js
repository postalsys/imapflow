'use strict';

/**
 * Initiates STARTTLS connection upgrade.
 *
 * @param {Object} connection - IMAP connection instance
 * @returns {Promise<boolean>} True if STARTTLS was initiated, false if not supported or already secure
 */
module.exports = async connection => {
    if (!connection.capabilities.has('STARTTLS') || connection.secureConnection) {
        // nothing to do here
        return false;
    }

    let response;
    try {
        response = await connection.exec('STARTTLS');
        response.next();
        return true;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
