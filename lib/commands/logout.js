'use strict';

// Logs out user and closes connection
module.exports = async connection => {
    if (connection.state === connection.states.LOGOUT) {
        // nothing to do here
        return;
    }

    let response;
    try {
        let map = {};
        response = await connection.exec('LOGOUT');
        response.next();
        connection.close();
        return map;
    } catch (err) {
        connection.log.error({error: err, cid: connection.id});
        return false;
    }
};
