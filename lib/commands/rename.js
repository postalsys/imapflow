'use strict';

const { encodePath, normalizePath, enhanceCommandError } = require('../tools.js');

/**
 * Renames an existing mailbox.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} path - Current mailbox path
 * @param {string} newPath - New mailbox path
 * @returns {Promise<{path: string, newPath: string}|undefined>} Object with old and new paths, or undefined if preconditions not met
 * @throws {Error} If the RENAME command fails
 */
module.exports = async (connection, path, newPath) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    path = normalizePath(connection, path);
    newPath = normalizePath(connection, newPath);

    if (connection.state === connection.states.SELECTED && connection.mailbox.path === path) {
        await connection.run('CLOSE');
    }

    let response;
    try {
        let map = {
            path,
            newPath
        };
        response = await connection.exec('RENAME', [
            { type: 'ATOM', value: encodePath(connection, path) },
            { type: 'ATOM', value: encodePath(connection, newPath) }
        ]);
        response.next();
        return map;
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        throw err;
    }
};
