import { encodePath, normalizePath, enhanceCommandError } from '../tools.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';
import type { MailboxDeleteResponse, MailboxObject } from '../types.js';

/**
 * Deletes an existing mailbox.
 *
 * @param connection - IMAP connection instance
 * @param path - Mailbox path to delete
 * @returns Object with the deleted path, or undefined if preconditions not met
 * @throws If the DELETE command fails
 */
export default async function deleteMailbox(connection: ImapFlow, path: string | string[]): Promise<MailboxDeleteResponse | undefined> {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    path = normalizePath(connection, path);

    // If the mailbox to delete is currently selected, we must close/deselect it first.
    // IMAP servers reject DELETE on the currently selected mailbox (RFC 3501 6.3.4).
    if (connection.state === connection.states.SELECTED && (connection.mailbox as MailboxObject).path === path) {
        await connection.run('CLOSE');
    }

    let response: ExecResponse;
    try {
        let map: MailboxDeleteResponse = {
            path
        };
        response = await connection.exec('DELETE', [{ type: 'ATOM', value: encodePath(connection, path) }]);
        response.next();
        return map;
    } catch (err: any) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        throw err;
    }
}
