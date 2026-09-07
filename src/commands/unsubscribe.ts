import { encodePath, normalizePath, enhanceCommandError } from '../tools.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';

/**
 * Unsubscribes from a mailbox.
 *
 * @param connection - IMAP connection instance
 * @param path - Mailbox path to unsubscribe from
 * @returns True on success, false on failure, or undefined if preconditions not met
 */
export default async function unsubscribe(connection: ImapFlow, path: string | string[]): Promise<boolean | undefined> {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    path = normalizePath(connection, path);

    let response: ExecResponse;
    try {
        response = await connection.exec('UNSUBSCRIBE', [{ type: 'ATOM', value: encodePath(connection, path) }]);
        response.next();
        return true;
    } catch (err: any) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
}
