import type { ImapFlow, ExecResponse } from '../imap-flow.js';

/**
 * Closes the currently selected mailbox.
 *
 * @param connection - IMAP connection instance
 * @returns True on success, false on failure, or undefined if not in SELECTED state
 */
export default async function close(connection: ImapFlow): Promise<boolean | undefined> {
    if (connection.state !== connection.states.SELECTED) {
        // nothing to do here
        return;
    }

    let response: ExecResponse;
    try {
        // IMAP CLOSE (RFC 3501 6.4.2): permanently removes all messages flagged \Deleted
        // from the currently selected mailbox (implicit expunge) and deselects it.
        // Unlike EXPUNGE, CLOSE does not send individual untagged EXPUNGE responses.
        response = await connection.exec('CLOSE');
        response.next();

        // Transition from SELECTED back to AUTHENTICATED state.
        // Clear mailbox metadata so subsequent operations know no mailbox is selected.
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
}
