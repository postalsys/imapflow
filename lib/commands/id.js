'use strict';

const { formatDateTime } = require('../tools.js');

/**
 * Sends ID info to the server and updates server info data based on the response.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {Object} clientInfo - Client identification key-value pairs to send to the server
 * @returns {Promise<Object|boolean|undefined>} Server information map, false on failure, or undefined if ID not supported
 */
// RFC 2971: The ID command exchanges client/server implementation info
// (name, version, vendor, etc.) for diagnostic and compatibility purposes.
module.exports = async (connection, clientInfo) => {
    if (!connection.capabilities.has('ID')) {
        // nothing to do here
        return;
    }

    let response;
    try {
        let map = {};

        // Convert the clientInfo object into a flat array of alternating key-value strings
        // for the IMAP wire format: ("key1" "value1" "key2" "value2" ...)
        let formattedClientInfo = !clientInfo
            ? null
            : Object.keys(clientInfo)
                  .map(key => [key, formatValue(key, clientInfo[key])])
                  .filter(entry => entry[1])
                  .flatMap(entry => entry);

        if (formattedClientInfo && !formattedClientInfo.length) {
            // value array has no elements
            formattedClientInfo = null;
        }

        response = await connection.exec('ID', [formattedClientInfo], {
            untagged: {
                // Parse the server's ID response: a flat list of alternating key-value atoms.
                // Even indices (i % 2 === 0) are keys, odd indices are the corresponding values.
                ID: async untagged => {
                    let params = untagged.attributes && untagged.attributes[0];
                    let key;
                    (Array.isArray(params) ? params : [].concat(params || [])).forEach((val, i) => {
                        if (i % 2 === 0) {
                            key = val.value;
                        } else if (typeof key === 'string' && typeof val.value === 'string') {
                            map[key.toLowerCase().trim()] = val.value;
                        }
                    });
                }
            }
        });
        connection.serverInfo = map;
        response.next();
        return map;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};

/**
 * Formats a client info value for the ID command.
 *
 * @param {string} key - The info key name
 * @param {*} value - The value to format
 * @returns {string} Formatted value string
 */
function formatValue(key, value) {
    switch (key.toLowerCase()) {
        case 'date':
            // RFC 2971 requires the "date" field to use IMAP date-time format
            // (e.g., "06-Feb-2026 12:00:00 +0000"), not ISO 8601 or other formats.
            return formatDateTime(value);
        default:
            // Other values are strings without newlines
            return (value || '').toString().replace(/\s+/g, ' ');
    }
}
