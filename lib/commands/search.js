'use strict';

const { enhanceCommandError } = require('../tools.js');
const { searchCompiler } = require('../search-compiler.js');

/**
 * Searches for messages matching the specified criteria.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {Object|boolean} query - Search query object, or true/empty object to match all messages
 * @param {Object} [options] - Search options
 * @param {boolean} [options.uid] - If true, use UID SEARCH instead of SEARCH
 * @returns {Promise<number[]|boolean>} Sorted array of matching sequence numbers or UIDs, or false on failure
 */
module.exports = async (connection, query, options) => {
    if (connection.state !== connection.states.SELECTED) {
        // nothing to do here
        return false;
    }

    options = options || {};

    let attributes;

    if (!query || query === true || (typeof query === 'object' && (!Object.keys(query).length || (Object.keys(query).length === 1 && query.all)))) {
        // search for all messages
        attributes = [{ type: 'ATOM', value: 'ALL' }];
    } else if (query && typeof query === 'object') {
        // normal query
        attributes = searchCompiler(connection, query);
    } else {
        return false;
    }

    let results = new Set();
    let response;
    try {
        response = await connection.exec(options.uid ? 'UID SEARCH' : 'SEARCH', attributes, {
            untagged: {
                SEARCH: async untagged => {
                    if (untagged && untagged.attributes && untagged.attributes.length) {
                        untagged.attributes.forEach(attribute => {
                            if (attribute && attribute.value && typeof attribute.value === 'string' && !isNaN(attribute.value)) {
                                results.add(Number(attribute.value));
                            }
                        });
                    }
                }
            }
        });
        response.next();
        return Array.from(results).sort((a, b) => a - b);
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
