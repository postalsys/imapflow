'use strict';

const { encodePath, getStatusCode, normalizePath, getErrorText } = require('../tools.js');

// Requests quota information for a mailbox
module.exports = async (connection, path) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state) || !path) {
        // nothing to do here
        return;
    }

    if (!connection.capabilities.has('QUOTA')) {
        return false;
    }

    path = normalizePath(connection, path);

    let map = { path };

    let processQuotaResponse = untagged => {
        let attributes = untagged.attributes && untagged.attributes[1];
        if (!attributes || !attributes.length) {
            return false;
        }

        let key = false;
        attributes.forEach((attribute, i) => {
            if (i % 3 === 0) {
                key = attribute && typeof attribute.value === 'string' ? attribute.value.toLowerCase() : false;
                return;
            }
            if (!key) {
                return;
            }

            let value = attribute && typeof attribute.value === 'string' && !isNaN(attribute.value) ? Number(attribute.value) : false;
            if (value === false) {
                return;
            }

            if (i % 3 === 1) {
                // usage
                if (!map[key]) {
                    map[key] = {};
                }
                map[key].usage = value * (key === 'storage' ? 1024 : 1);
            }

            if (i % 3 === 2) {
                // limit
                if (!map[key]) {
                    map[key] = {};
                }
                map[key].limit = value * (key === 'storage' ? 1024 : 1);

                if (map[key].limit) {
                    map[key].status = Math.round(((map[key].usage || 0) / map[key].limit) * 100) + '%';
                }
            }
        });
    };

    let quotaFound = false;
    let response;
    try {
        response = await connection.exec('GETQUOTAROOT', [{ type: 'ATOM', value: encodePath(connection, path) }], {
            untagged: {
                QUOTAROOT: async untagged => {
                    let quotaRoot =
                        untagged.attributes && untagged.attributes[1] && typeof untagged.attributes[1].value === 'string'
                            ? untagged.attributes[1].value
                            : false;
                    if (quotaRoot) {
                        map.quotaRoot = quotaRoot;
                    }
                },
                QUOTA: async untagged => {
                    quotaFound = true;
                    processQuotaResponse(untagged);
                }
            }
        });

        response.next();

        if (map.quotaRoot && !quotaFound) {
            response = await connection.exec('GETQUOTA', [{ type: 'ATOM', value: map.quotaRoot }], {
                untagged: {
                    QUOTA: async untagged => {
                        processQuotaResponse(untagged);
                    }
                }
            });
        }

        return map;
    } catch (err) {
        let errorCode = getStatusCode(err.response);
        if (errorCode) {
            err.serverResponseCode = errorCode;
        }
        err.response = await getErrorText(err.response);

        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
