import { encodePath, normalizePath, isAuthenticatedState, reportCommandError } from '../tools.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';

/**
 * Runs SUBSCRIBE or UNSUBSCRIBE for a mailbox, the shared body of the two commands.
 *
 * @param connection - IMAP connection instance
 * @param command - SUBSCRIBE or UNSUBSCRIBE
 * @param path - Mailbox path
 * @returns True on success, false on failure, or undefined if preconditions not met
 */
export async function setSubscription(connection: ImapFlow, command: 'SUBSCRIBE' | 'UNSUBSCRIBE', path: string | string[]): Promise<boolean | undefined> {
    if (!isAuthenticatedState(connection)) {
        // nothing to do here
        return;
    }

    path = normalizePath(connection, path);

    let response: ExecResponse;
    try {
        response = await connection.exec(command, [{ type: 'ATOM', value: encodePath(connection, path) }]);
        response.next();
        return true;
    } catch (err: any) {
        await reportCommandError(connection, err);
        return false;
    }
}
