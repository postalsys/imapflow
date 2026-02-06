'use strict';

/**
 * Logs out the user and closes the connection.
 *
 * @param {Object} connection - IMAP connection instance
 * @returns {Promise<boolean>} True if logout command succeeded, false otherwise
 */
module.exports = async connection => {
    if (connection.state === connection.states.LOGOUT) {
        // nothing to do here
        return false;
    }

    if (connection.state === connection.states.NOT_AUTHENTICATED) {
        connection.state = connection.states.LOGOUT;
        connection.close();
        return false;
    }

    let response;
    try {
        response = await connection.exec('LOGOUT');
        return true;
    } catch (err) {
        if (err.code === 'NoConnection') {
            return true;
        }
        connection.log.warn({ err, cid: connection.id });
        return false;
    } finally {
        // close even if command failed
        connection.state = connection.states.LOGOUT;
        if (response && typeof response.next === 'function') {
            response.next();
        }
        connection.close();
    }
};
