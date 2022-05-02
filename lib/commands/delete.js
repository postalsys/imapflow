'use strict';

const { encodePath, normalizePath, getStatusCode, getErrorText } = require('../tools.js');

// Deletes an existing mailbox
module.exports = async (connection, path) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    path = normalizePath(connection, path);

    if (connection.states.SELECTED && connection.mailbox.path === path) {
        await connection.run('CLOSE');
    }

    let response;
    try {
        let map = {
            path
        };
        response = await connection.exec('DELETE', [{ type: 'ATOM', value: encodePath(connection, path) }]);
        response.next();
        return map;
    } catch (err) {
        let errorCode = getStatusCode(err.response);
        if (errorCode) {
            err.serverResponseCode = errorCode;
        }
        err.response = await getErrorText(err.response);

        connection.log.warn({ err, cid: connection.id });
        throw err;
    }
};
