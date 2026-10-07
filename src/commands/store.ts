import { formatFlag, canUseFlag, encodePath, reportCommandError, getSelectedMailbox } from '../tools.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';
import type { ImapFlowError } from '../errors.js';
import type { ImapCompileNode } from '../handler/types.js';
import type { StoreOptions } from '../types.js';

/**
 * Options for the STORE command
 */
export interface StoreCommandOptions extends StoreOptions {
    /** Operation type: 'set', 'add', or 'remove' */
    operation?: string | undefined;
}

/**
 * Updates flags or labels for messages in the selected mailbox.
 *
 * @param connection - IMAP connection instance
 * @param range - Message sequence number or UID range
 * @param flags - Flag(s) to set, add, or remove
 * @param options - Store options
 * @returns True on success, false on failure or if nothing to do
 */
export default async function store(
    connection: ImapFlow,
    range: string,
    flags: string | string[],
    options?: StoreCommandOptions | undefined
): Promise<boolean> {
    options = options || {};

    let mailbox = getSelectedMailbox(connection);
    if (!mailbox || !range || (options.useLabels && !connection.capabilities.has('X-GM-EXT-1'))) {
        // nothing to do here
        return false;
    }

    // Build the IMAP STORE operation name. The format is:
    //   [+|-]FLAGS[.SILENT] or [+|-]X-GM-LABELS
    // Where: no prefix = replace all, + = add, - = remove
    // .SILENT suppresses the server from sending back updated flags (saves bandwidth).
    let operation = 'FLAGS';

    if (options.useLabels) {
        // Gmail labels (X-GM-EXT-1 extension): operates on labels instead of IMAP flags
        operation = 'X-GM-LABELS';
    } else if (options.silent) {
        operation = `${operation}.SILENT`;
    }

    // Normalized once: the raw value is also compared below, and a mixed-case 'SET' must not
    // take the set branch here and the add branch there.
    const operationName = (options.operation || '').toLowerCase();

    // Prefix determines the operation: none = set (replace), + = add, - = remove
    switch (operationName) {
        case 'set':
            break;
        case 'remove':
            operation = `-${operation}`;
            break;
        case 'add':
        default:
            operation = `+${operation}`;
            break;
    }

    // Only an explicitly empty array asks for every flag to be cleared. A missing value is not
    // that request, and neither is a 'set' whose flags all get dropped below: either would
    // compile to "FLAGS ()" and wipe the message instead of storing what was asked for. The
    // line is drawn at destroying flags, not at fidelity, so a set that keeps some of the
    // requested flags still runs, as the documented contract for those methods says.
    const clearAll = operationName === 'set' && Array.isArray(flags) && !flags.length;

    // permanentFlags lists the IMAP keywords the mailbox accepts and says nothing about Gmail
    // labels, so it is not consulted for X-GM-LABELS - the same reason an unrelated mailbox's
    // flags are not consulted for APPEND (issue #415).
    const flagSource = options.useLabels ? false : mailbox;

    // Validate each flag: format it (normalize backslash prefix for system flags, reject the
    // server-owned \Recent), then check that the mailbox allows it. Removal is always allowed
    // since it doesn't require the flag to be in permanentFlags.
    const dropped: string[] = [];
    flags = (Array.isArray(flags) ? flags : ([] as string[]).concat(flags || []))
        .map(flag => {
            // Gmail labels other than the \-prefixed system labels are mailbox names: astrings in
            // the form mailbox names take on the session (modified UTF-7 unless UTF-8 is enabled),
            // not atoms like IMAP keywords
            let formatted = options.useLabels && flag && flag.charAt(0) !== '\\' ? encodePath(connection, flag) : formatFlag(flag);

            if (!formatted || (!canUseFlag(flagSource, formatted) && operationName !== 'remove')) {
                dropped.push(flag);
                return false;
            }

            return formatted;
        })
        .filter((flag): flag is string => !!flag);

    // The caller is told nothing by the boolean this returns, so leave a trail for the flags
    // that never reached the server.
    if (dropped.length) {
        connection.log.warn({
            msg: 'Dropped flags the mailbox does not accept',
            cid: connection.id,
            path: mailbox.path,
            operation,
            dropped
        });
    }

    if (!flags.length && !clearAll) {
        return false;
    }

    let attributes: ImapCompileNode[] = [{ type: 'SEQUENCE', value: range }];

    // CONDSTORE (RFC 7162): UNCHANGEDSINCE modifier prevents updating messages whose
    // mod-sequence is higher than the specified value, avoiding overwriting concurrent changes.
    // The store-modifiers list goes between the sequence set and the item name (section 3.1.3).
    if (options.unchangedSince && connection.enabled.has('CONDSTORE') && !mailbox.noModseq) {
        attributes.push([
            {
                type: 'ATOM',
                value: 'UNCHANGEDSINCE'
            },
            {
                type: 'ATOM',
                value: options.unchangedSince.toString()
            }
        ]);
    }

    attributes.push(
        { type: 'ATOM', value: operation },
        flags.map(flag => ({ type: 'ATOM', value: flag }))
    );

    let response: ExecResponse;
    try {
        response = await connection.exec(options.uid ? 'UID STORE' : 'STORE', attributes);
        response.next();
        return true;
    } catch (err) {
        await reportCommandError(connection, err as ImapFlowError);
        return false;
    }
}
