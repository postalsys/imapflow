'use strict';

const { enhanceCommandError } = require('../tools.js');
const { searchCompiler } = require('../search-compiler.js');

/**
 * SORT command (RFC 5256)
 * Returns message sequence numbers or UIDs sorted by the specified criteria.
 *
 * @param {Object} connection - IMAP connection
 * @param {Array} sortCriteria - Sort criteria, e.g., ['REVERSE', 'DATE'] or [{ reverse: true }, 'date']
 * @param {Object} query - Search query (same as SEARCH command)
 * @param {Object} options - Options (uid: true for UID SORT)
 * @returns {Array|false} - Sorted array of sequence numbers/UIDs, or false if not supported/failed
 */
module.exports = async (connection, sortCriteria, query, options) => {
    if (connection.state !== connection.states.SELECTED) {
        // nothing to do here
        return false;
    }

    // Check if server supports SORT extension
    if (!connection.capabilities.has('SORT')) {
        return false;
    }

    options = options || {};

    // Normalize sort criteria to IMAP format
    // Accept both ['REVERSE', 'DATE'] and [{ reverse: true }, 'date'] formats
    const sortAttributes = [];
    if (Array.isArray(sortCriteria)) {
        for (const criterion of sortCriteria) {
            if (typeof criterion === 'string') {
                sortAttributes.push({ type: 'ATOM', value: criterion.toUpperCase() });
            } else if (criterion && typeof criterion === 'object') {
                if (criterion.reverse) {
                    sortAttributes.push({ type: 'ATOM', value: 'REVERSE' });
                }
                // Handle criterion.key or just use the criterion as-is if it's a sort key object
                const key = criterion.key || Object.keys(criterion).find(k => k !== 'reverse');
                if (key && key !== 'reverse') {
                    sortAttributes.push({ type: 'ATOM', value: key.toUpperCase() });
                }
            }
        }
    }

    // Default to DATE if no valid sort criteria provided
    if (sortAttributes.length === 0) {
        sortAttributes.push({ type: 'ATOM', value: 'DATE' });
    }

    // Build search attributes
    let searchAttributes;
    if (!query || query === true || (typeof query === 'object' && (!Object.keys(query).length || (Object.keys(query).length === 1 && query.all)))) {
        // search for all messages
        searchAttributes = [{ type: 'ATOM', value: 'ALL' }];
    } else if (query && typeof query === 'object') {
        // normal query
        searchAttributes = searchCompiler(connection, query);
    } else {
        return false;
    }

    // Build the full SORT command attributes:
    // SORT (sort-criteria) charset search-criteria
    const attributes = [
        // Sort criteria wrapped in parentheses (as a list)
        sortAttributes,
        // Charset - UTF-8 is required by RFC 5256
        { type: 'ATOM', value: 'UTF-8' },
        // Search criteria
        ...searchAttributes
    ];

    let results = [];
    let response;
    try {
        response = await connection.exec(options.uid ? 'UID SORT' : 'SORT', attributes, {
            untagged: {
                SORT: async untagged => {
                    if (untagged && untagged.attributes && untagged.attributes.length) {
                        untagged.attributes.forEach(attribute => {
                            if (attribute && attribute.value && typeof attribute.value === 'string' && !isNaN(attribute.value)) {
                                results.push(Number(attribute.value));
                            }
                        });
                    }
                }
            }
        });
        response.next();
        // Return results in order (server already sorted them)
        return results;
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
