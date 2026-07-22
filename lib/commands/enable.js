'use strict';

const { hasCapability } = require('../tools.js');

/**
 * Enables IMAP extensions on the server.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string[]} extensionList - List of extension names to enable
 * @returns {Promise<Set|boolean|undefined>} Set of enabled extensions, false on failure, or undefined if not applicable
 */
module.exports = async (connection, extensionList) => {
    // ENABLE is part of base IMAP4rev2, so rev2-only servers may omit the token
    if (!hasCapability(connection, 'ENABLE') || connection.state !== connection.states.AUTHENTICATED) {
        // nothing to do here
        return;
    }

    // Pre-filter: only request extensions the server actually advertised in its
    // CAPABILITY response. Requesting unsupported extensions would cause an error.
    // Compared case-insensitively - the capability map keeps canonical casing for
    // some keys (e.g. IMAP4rev2).
    let advertised = new Set([...connection.capabilities.keys()].map(capability => capability.toUpperCase()));
    extensionList = extensionList.filter(extension => advertised.has(extension.toUpperCase()));
    if (!extensionList.length) {
        return;
    }

    let response;
    try {
        let enabled = new Set();
        response = await connection.exec(
            'ENABLE',
            extensionList.map(extension => ({ type: 'ATOM', value: extension.toUpperCase() })),
            {
                untagged: {
                    // The untagged ENABLED response is a flat list of extension names
                    // (e.g., "* ENABLED CONDSTORE UTF8=ACCEPT"), NOT key-value pairs.
                    // Each attribute is a single extension identifier.
                    ENABLED: async untagged => {
                        if (!untagged.attributes || !untagged.attributes.length) {
                            return;
                        }
                        untagged.attributes.forEach(attr => {
                            if (attr.value && typeof attr.value === 'string') {
                                enabled.add(attr.value.toUpperCase().trim());
                            }
                        });
                    }
                }
            }
        );
        // Merge instead of replace - the untagged ENABLED response only lists
        // extensions enabled by this command (RFC 5161), so a replace would drop
        // grants from an earlier ENABLE call
        connection.enabled = new Set([...connection.enabled, ...enabled]);
        response.next();
        return connection.enabled;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
