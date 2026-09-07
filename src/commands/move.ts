import { normalizePath, encodePath, enhanceCommandError, hasCapability } from '../tools.js';
import { parseCopyUid } from './copyuid-parser.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';
import type { ImapAttributeNode, ImapResponse } from '../handler/types.js';
import type { CopyResponseObject, MailboxObject, MessageRangeOptions } from '../types.js';

/**
 * Moves messages from the current mailbox to another mailbox.
 *
 * @param connection - IMAP connection instance
 * @param range - Message sequence number or UID range
 * @param destination - Destination mailbox path
 * @param options - Move options
 * @param options.uid - If true, use UID MOVE instead of MOVE
 * @returns Move result with UID mapping if available, false on failure, or undefined if preconditions not met
 */
export default async function move(
    connection: ImapFlow,
    range: string,
    destination: string | string[],
    options?: MessageRangeOptions | undefined
): Promise<CopyResponseObject | false | undefined> {
    if (connection.state !== connection.states.SELECTED || !range || !destination) {
        // nothing to do here
        return;
    }

    options = options || {};
    destination = normalizePath(connection, destination);

    let attributes: ImapAttributeNode[] = [
        { type: 'SEQUENCE', value: range },
        { type: 'ATOM', value: encodePath(connection, destination) }
    ];

    let map: CopyResponseObject = { path: (connection.mailbox as MailboxObject).path, destination };

    // Fallback for servers without the MOVE extension (RFC 6851):
    // emulate MOVE using COPY + flag as \Deleted + EXPUNGE.
    if (!hasCapability(connection, 'MOVE')) {
        let result = await connection.messageCopy(range, destination, options);
        await connection.messageDelete(range, Object.assign({ silent: true }, options));
        return result;
    }

    let response: ExecResponse;
    try {
        // Some servers send COPYUID in an untagged OK before the tagged response,
        // others include it in the tagged OK. We check both to be safe.
        response = await connection.exec(options.uid ? 'UID MOVE' : 'MOVE', attributes, {
            untagged: {
                OK: async (untagged: ImapResponse) => {
                    parseCopyUid(untagged, map);
                }
            }
        });
        response.next();

        parseCopyUid(response.response, map);
        return map;
    } catch (err: any) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
}
