'use strict';

const { getStatusCode, getErrorText } = require('../tools.js');

// Authenticates user using LOGIN
module.exports = async (connection, username, password) => {
    if (connection.state !== connection.states.NOT_AUTHENTICATED) {
        // nothing to do here
        return;
    }

    try {
        let response = await connection.exec('LOGIN', [
            { type: 'ATOM', value: username },
            { type: 'ATOM', value: password, sensitive: true }
        ]);
        response.next();

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
