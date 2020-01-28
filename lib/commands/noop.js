'use strict';

// Sends a NO-OP command
module.exports = async connection => {
    try {
        let response = await connection.exec('NOOP');
        response.next();
        return true;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
