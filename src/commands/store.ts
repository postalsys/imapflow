import { formatFlag, canUseFlag, enhanceCommandError } from '../tools.js';
import type { ImapFlow, ExecResponse } from '../imap-flow.js';
import type { ImapFlowError } from '../errors.js';
import type { ImapCompileNode } from '../handler/types.js';
import type { MailboxObject, StoreOptions } from '../types.js';

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
export default async function store(connection: ImapFlow, range: string, flags: string | string[], options: StoreCommandOptions): Promise<boolean> {
    if (connection.state !== connection.states.SELECTED || !range || (options.useLabels && !connection.capabilities.has('X-GM-EXT-1'))) {
        // nothing to do here
        return false;
    }

    /* c8 ignore next */ // options.useLabels is dereferenced in the guard above, so options is always defined here
    options = options || {};

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

    // Prefix determines the operation: none = set (replace), + = add, - = remove
    switch ((options.operation || '').toLowerCase()) {
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

    // Validate each flag: format it (normalize backslash prefix for system flags),
    // then check if the mailbox's permanentFlags allow it. Removal is always allowed
    // since it doesn't require the flag to be in permanentFlags.
    flags = (Array.isArray(flags) ? flags : ([] as string[]).concat(flags || []))
        .map(flag => {
            let formatted = formatFlag(flag);

            if (!canUseFlag(connection.mailbox, formatted as string) && options.operation !== 'remove') {
                return false;
            }

            return formatted;
        })
        .filter((flag): flag is string => !!flag);

    // Allow empty flags only for 'set' operation (which clears all flags)
    if (!flags.length && options.operation !== 'set') {
        return false;
    }

    let attributes: ImapCompileNode[] = [
        { type: 'SEQUENCE', value: range },
        { type: 'ATOM', value: operation },
        flags.map(flag => ({ type: 'ATOM', value: flag }))
    ];

    // CONDSTORE (RFC 7162): UNCHANGEDSINCE modifier prevents updating messages whose
    // mod-sequence is higher than the specified value, avoiding overwriting concurrent changes.
    if (options.unchangedSince && connection.enabled.has('CONDSTORE') && !(connection.mailbox as MailboxObject).noModseq) {
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

    let response: ExecResponse;
    try {
        response = await connection.exec(options.uid ? 'UID STORE' : 'STORE', attributes);
        response.next();
        return true;
    } catch (err) {
        await enhanceCommandError(err as ImapFlowError);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
}
