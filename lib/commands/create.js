'use strict';

const { encodePath, normalizePath, getStatusCode, enhanceCommandError } = require('../tools.js');

/**
 * Creates a new mailbox and subscribes to it.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} path - Mailbox path to create
 * @returns {Promise<{path: string, created: boolean, mailboxId?: string}|undefined>} Object with path and creation status, or undefined if preconditions not met
 * @throws {Error} If the CREATE command fails (except when mailbox already exists)
 */
module.exports = async (connection, path) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    path = normalizePath(connection, path);

    let response;
    try {
        let map = {
            path
        };
        response = await connection.exec('CREATE', [{ type: 'ATOM', value: encodePath(connection, path) }]);

        // Parse the response code section (e.g., [MAILBOXID (<id>)]) from the tagged OK response.
        // IMAP response code attributes are structured as alternating key-value pairs.
        let section =
            response.response.attributes &&
            response.response.attributes[0] &&
            response.response.attributes[0].section &&
            response.response.attributes[0].section.length
                ? response.response.attributes[0].section
                : false;

        if (section) {
            let key;
            section.forEach((attribute, i) => {
                // IMAP key-value pairs: even indices (i % 2 === 0) are keys, odd indices are values
                if (i % 2 === 0) {
                    key = attribute && typeof attribute.value === 'string' ? attribute.value : false;
                    return;
                }

                if (!key) {
                    return;
                }

                let value;
                switch (key.toLowerCase()) {
                    case 'mailboxid':
                        key = 'mailboxId';
                        value = Array.isArray(attribute) && attribute[0] && typeof attribute[0].value === 'string' ? attribute[0].value : false;
                        break;
                }

                if (key && value) {
                    map[key] = value;
                }
            });
        }

        map.created = true;
        response.next();

        // Auto-subscribe after creation so the new mailbox appears in LSUB listings
        // and is visible to clients that only show subscribed folders.
        await connection.run('SUBSCRIBE', path);

        return map;
    } catch (err) {
        let errorCode = getStatusCode(err.response);
        // ALREADYEXISTS (RFC 5530) means the mailbox already exists on the server.
        // This is not a true error -- we return created:false to indicate nothing was created.
        if (errorCode === 'ALREADYEXISTS') {
            // no need to do anything, mailbox already exists
            return {
                path,
                created: false
            };
        }

        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        throw err;
    }
};
