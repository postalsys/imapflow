'use strict';

// Authenticates user using LOGIN
module.exports = async (connection, username, password) => {
    if (connection.state !== connection.states.NOT_AUTHENTICATED) {
        // nothing to do here
        return;
    }

    let response = await connection.exec('LOGIN', [
        { type: 'ATOM', value: username },
        { type: 'ATOM', value: password, sensitive: true }
    ]);
    response.next();
    return true;
};
