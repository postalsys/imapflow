'use strict';

// Closes a mailbox
module.exports = async connection => {
    if (connection.state !== connection.states.SELECTED) {
        // nothing to do here
        return;
    }

    let response;
    try {
        response = await connection.exec('CLOSE');
        response.next();
        connection.mailbox = false;
        connection.state = connection.states.AUTHENTICATED;
        return true;
    } catch (err) {
        connection.log.error(err);
        return false;
    }
};
