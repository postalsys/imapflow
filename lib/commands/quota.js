'use strict';

const { encodePath, normalizePath, enhanceCommandError } = require('../tools.js');

/**
 * Requests quota information for a mailbox.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} path - Mailbox path to query quota for
 * @returns {Promise<{path: string, quotaRoot?: string, storage?: {usage: number, limit: number, status: string}, message?: {usage: number, limit: number, status: string}}|boolean|undefined>} Quota information object, false if QUOTA not supported or on failure, or undefined if preconditions not met
 */
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
            const position = i % 3;

            if (position === 0) {
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

            if (!map[key]) {
                map[key] = {};
            }

            const multiplier = key === 'storage' ? 1024 : 1;

            if (position === 1) {
                map[key].usage = value * multiplier;
            } else if (position === 2) {
                map[key].limit = value * multiplier;
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
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
