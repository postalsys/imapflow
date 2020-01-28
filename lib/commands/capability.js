'use strict';

// Refresh capabilities from server
module.exports = async connection => {
    if (connection.capabilities.size && !connection.expectCapabilityUpdate) {
        return connection.capabilities;
    }

    let response;
    try {
        // untagged capability response is processed by global handler
        response = await connection.exec('CAPABILITY');

        response.next();
        return connection.capabilities;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
