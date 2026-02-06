'use strict';

/**
 * Closes the currently selected mailbox.
 *
 * @param {Object} connection - IMAP connection instance
 * @returns {Promise<boolean|undefined>} True on success, false on failure, or undefined if not in SELECTED state
 */
module.exports = async connection => {
    if (connection.state !== connection.states.SELECTED) {
        // nothing to do here
        return;
    }

    let response;
    try {
        response = await connection.exec('CLOSE');
        response.next();

        let currentMailbox = connection.mailbox;
        connection.mailbox = false;
        connection.currentSelectCommand = false;
        connection.state = connection.states.AUTHENTICATED;

        if (currentMailbox) {
            connection.emit('mailboxClose', currentMailbox);
        }
        return true;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
