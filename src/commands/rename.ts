import { encodePath, normalizePath, isAuthenticatedState, reportCommandError, getSelectedMailbox } from '../tools.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';
import type { MailboxRenameResponse } from '../types.js';

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
    if (!isAuthenticatedState(connection)) {
        // nothing to do here
        return;
    }

    // Normalize both paths (resolve special names, apply namespace prefix) and encode
    // them for the IMAP wire format (modified UTF-7 for non-ASCII characters).
    path = normalizePath(connection, path);
    newPath = normalizePath(connection, newPath);

    // Must close/deselect the mailbox before renaming if it's currently selected,
    // as IMAP servers will not rename an active mailbox.
    let selected = getSelectedMailbox(connection);
    if (selected && selected.path === path) {
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
        await reportCommandError(connection, err);
        throw err;
    }
}
