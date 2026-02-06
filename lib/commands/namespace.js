'use strict';

/**
 * Requests NAMESPACE info from the server.
 *
 * @param {Object} connection - IMAP connection instance
 * @returns {Promise<{prefix: string, delimiter: string}|{error: boolean, status: string, text: string}>} The primary personal namespace, or an error object on failure
 */
module.exports = async connection => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    if (!connection.capabilities.has('NAMESPACE')) {
        // Fallback: when the server does not support the NAMESPACE extension (RFC 2342),
        // derive the prefix and delimiter from a LIST "" "" command, which returns
        // the hierarchy delimiter and root name for the default mailbox hierarchy.
        let { prefix, delimiter } = await getListPrefix(connection);
        // Ensure the prefix ends with the delimiter so that appending a mailbox name
        // produces a valid path (e.g., "INBOX." + "Sent" = "INBOX.Sent").
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
                // The NAMESPACE response (RFC 2342) contains exactly three sections:
                //   [0] = personal namespaces (user's own mailboxes)
                //   [1] = other users' namespaces (shared by other users)
                //   [2] = shared namespaces (public/organizational folders)
                // Each section is either NIL or a list of (prefix, delimiter) pairs.
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

/**
 * Derives namespace prefix and delimiter from a LIST command when NAMESPACE is not supported.
 *
 * @param {Object} connection - IMAP connection instance
 * @returns {Promise<{prefix?: string, delimiter?: string, flags?: Set}>} Object with prefix, delimiter, and flags, or empty object on failure
 */
async function getListPrefix(connection) {
    let response;
    try {
        let map = {};
        // LIST "" "" is a special form that returns only the hierarchy delimiter
        // and the root name, without listing any actual mailboxes.
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

/**
 * Parses namespace information from an IMAP NAMESPACE response attribute.
 *
 * @param {Array} attribute - Namespace attribute array from the server response
 * @returns {Array<{prefix: string, delimiter: string}>|boolean} Array of namespace entries, or false if empty
 */
function getNamsepaceInfo(attribute) {
    if (!attribute || !attribute.length) {
        return false;
    }

    return attribute
        .filter(entry => entry.length >= 2 && typeof entry[0].value === 'string' && typeof entry[1].value === 'string')
        .map(entry => {
            let prefix = entry[0].value;
            let delimiter = entry[1].value;

            // Append the delimiter to the prefix if it doesn't already end with one,
            // so callers can construct full paths by simply concatenating prefix + name.
            if (delimiter && prefix && prefix.charAt(prefix.length - 1) !== delimiter) {
                prefix += delimiter;
            }
            return { prefix, delimiter };
        });
}
