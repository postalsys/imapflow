'use strict';

// Requests NAMESPACE info from server
module.exports = async connection => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    if (!connection.capabilities.has('NAMESPACE')) {
        // try to derive from listing
        let { prefix, delimiter } = await getListPrefix(connection);
        if (delimiter && prefix && prefix.charAt(prefix.length - 1) !== delimiter) {
            prefix += delimiter;
        }
        let map = {
            personal: [{ prefix: prefix || '', delimiter }],
            other: false,
            shared: false
        };
        connection.namespaces = map;
        connection.namespace = connection.namespaces.personal[0];
        return connection.namespace;
    }

    let response;
    try {
        let map = {};
        response = await connection.exec('NAMESPACE', false, {
            untagged: {
                NAMESPACE: async untagged => {
                    if (!untagged.attributes || !untagged.attributes.length) {
                        return;
                    }
                    map.personal = getNamsepaceInfo(untagged.attributes[0]);
                    map.other = getNamsepaceInfo(untagged.attributes[1]);
                    map.shared = getNamsepaceInfo(untagged.attributes[2]);
                }
            }
        });
        connection.namespaces = map;

        // make sure that we have the first personal namespace always set
        if (!connection.namespaces.personal[0]) {
            connection.namespaces.personal[0] = { prefix: '', delimiter: '.' };
        }
        connection.namespaces.personal[0].prefix = connection.namespaces.personal[0].prefix || '';
        response.next();

        connection.namespace = connection.namespaces.personal[0];

        return connection.namespace;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return {
            error: true,
            status: err.responseStatus,
            text: err.responseText
        };
    }
};

async function getListPrefix(connection) {
    let response;
    try {
        let map = {};
        response = await connection.exec('LIST', ['', ''], {
            untagged: {
                LIST: async untagged => {
                    if (!untagged.attributes || !untagged.attributes.length) {
                        return;
                    }

                    map.flags = new Set(untagged.attributes[0].map(entry => entry.value));
                    map.delimiter = untagged.attributes[1] && untagged.attributes[1].value;
                    map.prefix = (untagged.attributes[2] && untagged.attributes[2].value) || '';
                    if (map.delimiter && map.prefix.charAt(0) === map.delimiter) {
                        map.prefix = map.prefix.slice(1);
                    }
                }
            }
        });
        response.next();
        return map;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return {};
    }
}

function getNamsepaceInfo(attribute) {
    if (!attribute || !attribute.length) {
        return false;
    }

    return attribute
        .filter(entry => entry.length >= 2 && typeof entry[0].value === 'string' && typeof entry[1].value === 'string')
        .map(entry => {
            let prefix = entry[0].value;
            let delimiter = entry[1].value;

            if (delimiter && prefix && prefix.charAt(prefix.length - 1) !== delimiter) {
                prefix += delimiter;
            }
            return { prefix, delimiter };
        });
}
