import { encodePath, normalizePath, buildStatusQueryAttributes, isRev2Active } from '../tools.js';
import { parseStatusList } from './status-fields.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';
import type { ImapFlowError } from '../errors.js';
import type { ImapCompileNode, ImapResponse } from '../handler/types.js';
import type { MailboxObject, StatusObject, StatusQuery } from '../types.js';

// STATUS fields that also refresh the live mailbox state when the queried mailbox is the
// currently selected one. Keyed by the output property name parseStatusList() reports.
const MAILBOX_UPDATERS: { [key: string]: ((value: any, connection: ImapFlow, path: string) => void) | undefined } = {
    messages: (value: number, connection: ImapFlow, path: string) => {
        let mailbox = connection.mailbox as MailboxObject;
        let prevCount = mailbox.exists;
        if (prevCount !== value) {
            mailbox.exists = value;
            connection.emit('exists', { path, count: value, prevCount });
        }
    },
    uidNext: (value: number, connection: ImapFlow) => {
        (connection.mailbox as MailboxObject).uidNext = value;
    },
    highestModseq: (value: bigint, connection: ImapFlow) => {
        (connection.mailbox as MailboxObject).highestModseq = value;
    }
};

/**
 * Requests status information about a mailbox.
 *
 * @param connection - IMAP connection instance
 * @param path - Mailbox path to query
 * @param query - Status data items to request (e.g., {messages: true, uidNext: true, unseen: true})
 * @returns Status information object, or false if preconditions not met or on failure
 * @throws {Error} If the mailbox does not exist
 */
export default async function status(connection: ImapFlow, path: string | string[], query: StatusQuery | undefined): Promise<StatusObject | false> {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state) || !path) {
        // nothing to do here
        return false;
    }

    path = normalizePath(connection, path);
    let encodedPath = encodePath(connection, path);

    // Use quoted STRING if the encoded path contains '&' (modified UTF-7 marker),
    // otherwise use unquoted ATOM. Same approach as in SELECT.
    let attributes: ImapCompileNode[] = [{ type: encodedPath.indexOf('&') >= 0 ? 'STRING' : 'ATOM', value: encodedPath }];

    // Build the list of STATUS data items the caller wants
    let queryAttributes = buildStatusQueryAttributes(connection, query);

    // RECENT does not exist in IMAP4rev2 so it is never requested from a rev2
    // session; its defined value there is always 0. Synthesizing it keeps the
    // return shape identical to a rev1 session for the same query.
    let syntheticRecent = query && query.recent && isRev2Active(connection);

    if (!queryAttributes.length) {
        // A query that only contained items unavailable on this session - the
        // caller still gets a status object if every such item has a defined value
        return syntheticRecent ? { path, recent: 0 } : false;
    }

    attributes.push(queryAttributes);

    let response: ExecResponse;
    try {
        let map: StatusObject & { [key: string]: unknown } = { path };
        response = await connection.exec('STATUS', attributes, {
            untagged: {
                // STATUS response: * STATUS <mailbox> (<key> <value> <key> <value> ...)
                // Parsed as alternating key-value pairs (i % 2 pattern).
                STATUS: async (untagged: ImapResponse) => {
                    // If querying the currently selected mailbox, also update the
                    // connection's live mailbox state and emit events for changes.
                    let updateCurrent = connection.state === connection.states.SELECTED && path === (connection.mailbox as MailboxObject).path;

                    let list = untagged.attributes && Array.isArray(untagged.attributes[1]) ? untagged.attributes[1] : false;
                    if (!list) {
                        return;
                    }
                    parseStatusList(list, (key, value) => {
                        map[key] = value;

                        let updater = MAILBOX_UPDATERS[key];
                        if (updateCurrent && updater) {
                            updater(value, connection, path as string);
                        }
                    });
                }
            }
        });
        response.next();
        if (syntheticRecent) {
            map.recent = 0;
        }
        return map;
    } catch (err: any) {
        // A NO response usually means the mailbox doesn't exist. Verify by
        // running LIST: if no results, throw a clear NotFound error instead
        // of the generic IMAP error.
        // Note: this uses run(), so when STATUS was dispatched by fallback polling through
        // runInternal() the LIST awaits that polling session's own preCheck and cancels it.
        // Not a deadlock, and only reachable when the server rejects the STATUS, but a polled
        // STATUS of a missing folder ends the poll early.
        if (err.responseStatus === 'NO') {
            let folders = await connection.run('LIST', '', path, { listOnly: true });
            if (folders && !folders.length) {
                let error: ImapFlowError = new Error(`Mailbox doesn't exist: ${path}`);
                error.code = 'NotFound';
                error.response = err;
                throw error;
            }
        }

        connection.log.warn({ err, cid: connection.id });
        return false;
    }
}
