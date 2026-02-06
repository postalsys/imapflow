'use strict';

const { formatDateTime } = require('../tools.js');

/**
 * Sends ID info to the server and updates server info data based on the response.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {Object} clientInfo - Client identification key-value pairs to send to the server
 * @returns {Promise<Object|boolean|undefined>} Server information map, false on failure, or undefined if ID not supported
 */
module.exports = async (connection, clientInfo) => {
    if (!connection.capabilities.has('ID')) {
        // nothing to do here
        return;
    }

    let response;
    try {
        let map = {};

        // convert object into an array of value tuples
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
            // Date has to be in imap date-time format
            return formatDateTime(value);
        default:
            // Other values are strings without newlines
            return (value || '').toString().replace(/\s+/g, ' ');
    }
}
