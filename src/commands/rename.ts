import { encodePath, normalizePath, enhanceCommandError } from '../tools.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';
import type { MailboxObject, MailboxRenameResponse } from '../types.js';

/**
 * Renames an existing mailbox.
 *
 * @param connection - IMAP connection instance
 * @param path - Current mailbox path
 * @param newPath - New mailbox path
 * @returns Object with old and new paths, or undefined if preconditions not met
 * @throws If the RENAME command fails
 */
export default async function rename(connection: ImapFlow, path: string | string[], newPath: string | string[]): Promise<MailboxRenameResponse | undefined> {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    // Normalize both paths (resolve special names, apply namespace prefix) and encode
    // them for the IMAP wire format (modified UTF-7 for non-ASCII characters).
    path = normalizePath(connection, path);
    newPath = normalizePath(connection, newPath);

    // Must close/deselect the mailbox before renaming if it's currently selected,
    // as IMAP servers will not rename an active mailbox.
    if (connection.state === connection.states.SELECTED && (connection.mailbox as MailboxObject).path === path) {
        await connection.run('CLOSE');
    }

    let response: ExecResponse;
    try {
        let map: MailboxRenameResponse = {
            path,
            newPath
        };
        response = await connection.exec('RENAME', [
            { type: 'ATOM', value: encodePath(connection, path) },
            { type: 'ATOM', value: encodePath(connection, newPath) }
        ]);
        response.next();
        return map;
    } catch (err: any) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        throw err;
    }
}
