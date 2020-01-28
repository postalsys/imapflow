'use strict';

// Enables extensions
module.exports = async (connection, extensionList) => {
    if (!connection.capabilities.has('ENABLE') || connection.state !== connection.states.AUTHENTICATED) {
        // nothing to do here
        return;
    }

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
