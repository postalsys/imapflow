import { normalizePath, encodePath, reportCommandError, getSelectedMailbox } from '../tools.js';
import { parseCopyUid } from './copyuid-parser.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';
import type { ImapAttributeNode } from '../handler/types.js';
import type { CopyResponseObject, MessageRangeOptions } from '../types.js';

/**
 * Copies messages from the current mailbox to another mailbox.
 *
 * @param connection - IMAP connection instance
 * @param range - Message sequence number or UID range
 * @param destination - Destination mailbox path
 * @param options - Copy options
 * @param options.uid - If true, use UID COPY instead of COPY
 * @returns Copy result with UID mapping if available, false on failure, or undefined if preconditions not met
 */
export default async function copy(
    connection: ImapFlow,
    range: string,
    destination: string | string[],
    options?: MessageRangeOptions | undefined
): Promise<CopyResponseObject | false | undefined> {
    let mailbox = getSelectedMailbox(connection);
    if (!mailbox || !range || !destination) {
        // nothing to do here
        return;
    }

    options = options || {};
    destination = normalizePath(connection, destination);

    let attributes: ImapAttributeNode[] = [
        { type: 'SEQUENCE', value: range },
        { type: 'ATOM', value: encodePath(connection, destination) }
    ];

    let response: ExecResponse;
    try {
        response = await connection.exec(options.uid ? 'UID COPY' : 'COPY', attributes);
        response.next();

        let map: CopyResponseObject = { path: mailbox.path, destination };

        // UIDPLUS (RFC 4315): the server may include a COPYUID response code in the
        // tagged OK response, providing a mapping from source UIDs to destination UIDs.
        parseCopyUid(response.response, map);

        return map;
    } catch (err: any) {
        await reportCommandError(connection, err);
        return false;
    }
}
