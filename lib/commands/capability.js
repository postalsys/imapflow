'use strict';

/**
 * Refreshes capabilities from server.
 *
 * @param {Object} connection - IMAP connection instance
 * @returns {Promise<Map|boolean>} Server capabilities map, or false on failure
 */
// Capabilities are normally received and updated by the global response handler
// (e.g., from the server greeting or after authentication). This explicit CAPABILITY
// command is only needed when capabilities must be refreshed on demand, such as
// after STARTTLS or when the server signals a capability change.
module.exports = async connection => {
    if (connection.capabilities.size && !connection.expectCapabilityUpdate) {
        return connection.capabilities;
    }

    let response;
    try {
        // The actual parsing of the untagged CAPABILITY response is handled by the
        // global handler, not here. We just trigger the server to send it.
        response = await connection.exec('CAPABILITY');

        response.next();
        return connection.capabilities;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
