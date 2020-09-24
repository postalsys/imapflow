'use strict';

// Logs out user and closes connection
module.exports = async connection => {
    if (connection.state === connection.states.LOGOUT) {
        // nothing to do here
        return false;
    }

    let response;
    try {
        response = await connection.exec('LOGOUT');
        return true;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    } finally {
        // close even if command failed
        connection.state = connection.states.LOGOUT;
        response.next();
        connection.close();
    }
};
