'use strict';

const { encodePath, normalizePath, enhanceCommandError } = require('../tools.js');

// Unsubscribes from a mailbox
module.exports = async (connection, path) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    path = normalizePath(connection, path);

    let response;
    try {
        response = await connection.exec('UNSUBSCRIBE', [{ type: 'ATOM', value: encodePath(connection, path) }]);
        response.next();
        return true;
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
