'use strict';

const { formatFlag, canUseFlag, enhanceCommandError } = require('../tools.js');

/**
 * Updates flags or labels for messages in the selected mailbox.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} range - Message sequence number or UID range
 * @param {string|string[]} flags - Flag(s) to set, add, or remove
 * @param {Object} options - Store options
 * @param {boolean} [options.uid] - If true, use UID STORE instead of STORE
 * @param {boolean} [options.useLabels] - If true, operate on Gmail labels instead of flags
 * @param {boolean} [options.silent] - If true, use .SILENT variant to suppress server response
 * @param {string} [options.operation] - Operation type: 'set', 'add', or 'remove'
 * @param {string} [options.unchangedSince] - Only update messages not changed since this modseq value
 * @returns {Promise<boolean>} True on success, false on failure or if nothing to do
 */
module.exports = async (connection, range, flags, options) => {
    if (connection.state !== connection.states.SELECTED || !range || (options.useLabels && !connection.capabilities.has('X-GM-EXT-1'))) {
        // nothing to do here
        return false;
    }

    options = options || {};

    // Build the IMAP STORE operation name. The format is:
    //   [+|-]FLAGS[.SILENT] or [+|-]X-GM-LABELS
    // Where: no prefix = replace all, + = add, - = remove
    // .SILENT suppresses the server from sending back updated flags (saves bandwidth).
    let operation;

    operation = 'FLAGS';

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
    flags = (Array.isArray(flags) ? flags : [].concat(flags || []))
        .map(flag => {
            flag = formatFlag(flag);

            if (!canUseFlag(connection.mailbox, flag) && operation !== 'remove') {
                return false;
            }

            return flag;
        })
        .filter(flag => flag);

    // Allow empty flags only for 'set' operation (which clears all flags)
    if (!flags.length && options.operation !== 'set') {
        return false;
    }

    let attributes = [{ type: 'SEQUENCE', value: range }, { type: 'ATOM', value: operation }, flags.map(flag => ({ type: 'ATOM', value: flag }))];

    // CONDSTORE (RFC 7162): UNCHANGEDSINCE modifier prevents updating messages whose
    // mod-sequence is higher than the specified value, avoiding overwriting concurrent changes.
    if (options.unchangedSince && connection.enabled.has('CONDSTORE') && !connection.mailbox.noModseq) {
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

    let response;
    try {
        response = await connection.exec(options.uid ? 'UID STORE' : 'STORE', attributes);
        response.next();
        return true;
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
