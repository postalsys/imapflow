'use strict';

const { encodePath, normalizePath, getStatusCode, getErrorText } = require('../tools.js');

// Renames existing mailbox
module.exports = async (connection, path, newPath) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    path = normalizePath(connection, path);
    newPath = normalizePath(connection, newPath);

    if (connection.states.SELECTED && connection.mailbox.path === path) {
        await connection.run('CLOSE');
    }

    let response;
    try {
        let map = {
            path,
            newPath
        };
        response = await connection.exec('RENAME', [
            { type: 'ATOM', value: encodePath(connection, path) },
            { type: 'ATOM', value: encodePath(connection, newPath) }
        ]);
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
