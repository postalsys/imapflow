'use strict';

const { normalizePath, getStatusCode } = require('../tools.js');

// Subscribes to a mailbox
module.exports = async (connection, path) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    path = normalizePath(connection, path);

    let response;
    try {
        response = await connection.exec('SUBSCRIBE', [{ type: 'ATOM', value: path }]);
        response.next();
        return true;
    } catch (err) {
        let errorCode = getStatusCode(err.response);
        if (errorCode) {
            err.serverResponseCode = errorCode;
        }

        connection.log.error({error: err, cid: connection.id});
        return false;
    }
};
