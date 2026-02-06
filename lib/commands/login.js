'use strict';

const { getStatusCode, getErrorText } = require('../tools.js');

/**
 * Authenticates user using the IMAP LOGIN command.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} username - The username to authenticate with
 * @param {string} password - The password to authenticate with
 * @returns {Promise<string|undefined>} The authenticated username, or undefined if already authenticated
 * @throws {Error} If authentication fails, with authenticationFailed and serverResponseCode properties set
 */
module.exports = async (connection, username, password) => {
    if (connection.state !== connection.states.NOT_AUTHENTICATED) {
        // nothing to do here
        return;
    }

    try {
        let response = await connection.exec('LOGIN', [
            { type: 'STRING', value: username },
            // sensitive: true prevents the password from appearing in debug logs
            { type: 'STRING', value: password, sensitive: true }
        ]);
        response.next();

        // Record that LOGIN was the method used, so the connection knows which
        // auth mechanism succeeded (used for reconnection and diagnostics).
        connection.authCapabilities.set('LOGIN', true);

        return username;
    } catch (err) {
        let errorCode = getStatusCode(err.response);
        if (errorCode) {
            err.serverResponseCode = errorCode;
        }
        err.authenticationFailed = true;
        err.response = await getErrorText(err.response);
        throw err;
    }
};
