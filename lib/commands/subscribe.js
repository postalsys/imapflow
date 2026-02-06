'use strict';

const { encodePath, normalizePath, enhanceCommandError } = require('../tools.js');

/**
 * Subscribes to a mailbox.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} path - Mailbox path to subscribe to
 * @returns {Promise<boolean|undefined>} True on success, false on failure, or undefined if preconditions not met
 */
module.exports = async (connection, path) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    path = normalizePath(connection, path);

    let response;
    try {
        response = await connection.exec('SUBSCRIBE', [{ type: 'ATOM', value: encodePath(connection, path) }]);
        response.next();
        return true;
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
