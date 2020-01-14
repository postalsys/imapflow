'use strict';

// Sends ID info to server and updates server info data based on response
module.exports = async (connection, clientInfo) => {
    if (!connection.capabilities.has('ID')) {
        // nothing to do here
        return;
    }

    let response;
    try {
        let map = {};
        response = await connection.exec('ID', [!clientInfo ? null : Object.keys(clientInfo).flatMap(key => [key, clientInfo[key].toString()])], {
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
        connection.log.error(err);
        return false;
    }
};
