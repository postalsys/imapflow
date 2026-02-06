'use strict';

/**
 * Enables IMAP extensions on the server.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string[]} extensionList - List of extension names to enable
 * @returns {Promise<Set|boolean|undefined>} Set of enabled extensions, false on failure, or undefined if not applicable
 */
module.exports = async (connection, extensionList) => {
    if (!connection.capabilities.has('ENABLE') || connection.state !== connection.states.AUTHENTICATED) {
        // nothing to do here
        return;
    }

    // Pre-filter: only request extensions the server actually advertised in its
    // CAPABILITY response. Requesting unsupported extensions would cause an error.
    extensionList = extensionList.filter(extension => connection.capabilities.has(extension.toUpperCase()));
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
        connection.enabled = enabled;
        response.next();
        return enabled;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
