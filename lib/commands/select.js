'use strict';

const { encodePath, normalizePath, enhanceCommandError } = require('../tools.js');

/**
 * Selects or examines a mailbox, making it the current mailbox for subsequent operations.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} path - Mailbox path to select
 * @param {Object} [options] - Select options
 * @param {boolean} [options.readOnly] - If true, use EXAMINE instead of SELECT (read-only access)
 * @param {string} [options.changedSince] - QRESYNC modseq value to fetch changes since
 * @param {BigInt} [options.uidValidity] - QRESYNC UID validity value
 * @returns {Promise<Object|undefined>} Mailbox info object with path, flags, exists, uidNext, uidValidity, highestModseq, etc., or undefined if preconditions not met
 * @throws {Error} If the SELECT/EXAMINE command fails
 */
module.exports = async (connection, path, options) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }
    options = options || {};

    path = normalizePath(connection, path);

    // Ensure we have folder metadata (delimiter, flags, specialUse) by running LIST if needed.
    // This is cached in connection.folders to avoid repeated LIST calls.
    if (!connection.folders.has(path)) {
        let folders = await connection.run('LIST', '', path);
        if (!folders) {
            throw new Error('Failed to fetch folders');
        }
        folders.forEach(folder => {
            connection.folders.set(folder.path, folder);
        });
    }

    let folderListData = connection.folders.has(path) ? connection.folders.get(path) : false;

    let response;
    try {
        let map = { path };
        if (folderListData) {
            ['delimiter', 'specialUse', 'subscribed', 'listed'].forEach(key => {
                if (folderListData[key]) {
                    map[key] = folderListData[key];
                }
            });
        }

        // QRESYNC (RFC 7162): allows efficient mailbox resynchronization by sending
        // the last known UIDVALIDITY and HIGHESTMODSEQ. Server responds with only
        // the changes (new flags, expunged UIDs) since that point.
        let extraArgs = [];
        if (connection.enabled.has('QRESYNC') && options.changedSince && options.uidValidity) {
            extraArgs.push([
                { type: 'ATOM', value: 'QRESYNC' },
                [
                    { type: 'ATOM', value: options.uidValidity?.toString() },
                    { type: 'ATOM', value: options.changedSince.toString() }
                ]
            ]);
            map.qresync = true;
        }

        let encodedPath = encodePath(connection, path);

        // SELECT opens the mailbox read-write; EXAMINE opens it read-only.
        // Path encoding: if the encoded path contains '&' (UTF-7 encoding marker),
        // send as quoted STRING to avoid parser issues with the ampersand.
        let selectCommand = {
            command: !options.readOnly ? 'SELECT' : 'EXAMINE',
            arguments: [{ type: encodedPath.indexOf('&') >= 0 ? 'STRING' : 'ATOM', value: encodedPath }].concat(extraArgs || [])
        };

        response = await connection.exec(selectCommand.command, selectCommand.arguments, {
            untagged: {
                // Untagged OK responses carry response codes in brackets, e.g.:
                // * OK [UIDVALIDITY 1234] UIDs valid
                // * OK [PERMANENTFLAGS (\Seen \Answered \*)] Flags permitted
                // The section array holds the parsed bracket contents: section[0] is the
                // key (e.g., "UIDVALIDITY"), section[1] is the value or list.
                OK: async untagged => {
                    if (!untagged.attributes || !untagged.attributes.length) {
                        return;
                    }
                    let section = !untagged.attributes[0].value && untagged.attributes[0].section;
                    // Handle response codes with a key-value pair (section has 2+ elements)
                    if (section && section.length > 1 && section[0].type === 'ATOM' && typeof section[0].value === 'string') {
                        let key = section[0].value.toLowerCase();
                        let value;

                        // Value can be a single string or a list of strings (e.g., PERMANENTFLAGS)
                        if (typeof section[1].value === 'string') {
                            value = section[1].value;
                        } else if (Array.isArray(section[1])) {
                            value = section[1].map(entry => (typeof entry.value === 'string' ? entry.value : false)).filter(entry => entry);
                        }

                        switch (key) {
                            // CONDSTORE (RFC 7162): highest mod-sequence value for the mailbox.
                            // Used for incremental sync -- clients compare against their cached
                            // value to detect changes. Stored as BigInt since modseq values
                            // can exceed Number.MAX_SAFE_INTEGER.
                            case 'highestmodseq':
                                key = 'highestModseq';
                                if (/^[0-9]+$/.test(value)) {
                                    value = BigInt(value);
                                }
                                break;

                            // OBJECTID (RFC 8474): server-assigned unique mailbox identifier.
                            // Unlike path, this ID survives renames. Value comes as a
                            // parenthesized list, so extract the first (only) element.
                            case 'mailboxid':
                                key = 'mailboxId';
                                if (Array.isArray(value) && value.length) {
                                    value = value[0];
                                }
                                break;

                            // Flags that the client can change permanently on messages in
                            // this mailbox. Includes \* if the server allows custom flags.
                            case 'permanentflags':
                                key = 'permanentFlags';
                                value = new Set(value);
                                break;

                            // The next UID that will be assigned to a new message in this
                            // mailbox. Useful for detecting new arrivals.
                            case 'uidnext':
                                key = 'uidNext';
                                value = Number(value);
                                break;

                            // Unique identifier validity value. If this changes between
                            // sessions, all previously cached UIDs are invalid and the
                            // client must re-sync from scratch.
                            case 'uidvalidity':
                                key = 'uidValidity';
                                if (/^[0-9]+$/.test(value)) {
                                    value = BigInt(value);
                                }
                                break;
                        }

                        map[key] = value;
                    }

                    // Handle response codes with only a keyword (no value), e.g., [NOMODSEQ]
                    if (section && section.length === 1 && section[0].type === 'ATOM' && typeof section[0].value === 'string') {
                        let key = section[0].value.toLowerCase();
                        switch (key) {
                            // NOMODSEQ means the mailbox does not support mod-sequences.
                            // CONDSTORE/QRESYNC features are unavailable for this mailbox.
                            case 'nomodseq':
                                key = 'noModseq';
                                map[key] = true;
                                break;
                        }
                    }
                },

                // Untagged FLAGS response lists all flags defined for this mailbox
                // (both system flags and custom flags). Example: * FLAGS (\Seen \Answered \Flagged)
                FLAGS: async untagged => {
                    if (!untagged.attributes || (!untagged.attributes.length && Array.isArray(untagged.attributes[0]))) {
                        return;
                    }
                    let flags = untagged.attributes[0].map(flag => (typeof flag.value === 'string' ? flag.value : false)).filter(flag => flag);
                    map.flags = new Set(flags);
                },

                // Untagged EXISTS response: "* <count> EXISTS" tells us the total number
                // of messages in the mailbox. The count is in the command field (numeric prefix).
                EXISTS: async untagged => {
                    let num = Number(untagged.command);
                    if (isNaN(num)) {
                        return false;
                    }

                    map.exists = num;
                },

                // VANISHED responses (QRESYNC): server reports UIDs that have been expunged
                // since the client's last known state. Only received when QRESYNC was requested.
                // A dummy mailbox object is passed because the mailbox isn't officially open yet.
                VANISHED: async untagged => {
                    await connection.untaggedVanished(untagged, { path, uidNext: false, uidValidity: false });
                },

                // Untagged FETCH during SELECT/EXAMINE: only occurs with QRESYNC, delivering
                // updated flags for messages that changed since the client's last modseq.
                FETCH: async untagged => {
                    await connection.untaggedFetch(untagged, { path, uidNext: false, uidValidity: false });
                }
            }
        });

        // The tagged OK response to SELECT/EXAMINE includes [READ-ONLY] or [READ-WRITE]
        // in its response code, indicating the access mode the server granted.
        let section = !response.response.attributes[0].value && response.response.attributes[0].section;
        if (section && section.length && section[0].type === 'ATOM' && typeof section[0].value === 'string') {
            map.readOnly = section[0].value.toUpperCase() === 'READ-ONLY';
        }

        // Validate QRESYNC preconditions (RFC 7162 Section 3.2.5):
        // QRESYNC results are only valid if UIDVALIDITY matches, HIGHESTMODSEQ is
        // present, and the mailbox supports mod-sequences. If any condition fails,
        // the client cannot trust the incremental updates and must do a full resync.
        if (map.qresync && (options.uidValidity !== map.uidValidity || !map.highestModseq || map.noModseq)) {
            map.qresync = false;
        }

        // Transition mailbox state: save previous mailbox reference, temporarily
        // clear it, then emit events and set the new mailbox.
        let currentMailbox = connection.mailbox;
        connection.mailbox = false;

        // Emit mailboxClose if we're switching from a different mailbox.
        // Re-selecting the same mailbox (e.g., for resync) does not trigger close/open.
        if (currentMailbox && currentMailbox.path !== path) {
            connection.emit('mailboxClose', currentMailbox);
        }

        connection.mailbox = map;
        // Save the SELECT command for potential re-use (e.g., NOOP fallback polling
        // re-issues the SELECT to detect changes on servers without IDLE support).
        connection.currentSelectCommand = selectCommand;
        connection.state = connection.states.SELECTED;

        if (!currentMailbox || currentMailbox.path !== path) {
            connection.emit('mailboxOpen', connection.mailbox);
        }

        response.next();
        return map;
    } catch (err) {
        await enhanceCommandError(err);

        // If SELECT/EXAMINE fails while a mailbox was already selected, we must
        // reset to AUTHENTICATED state since the server has implicitly deselected
        // the previous mailbox on failure (RFC 3501 Section 6.3.1).
        if (connection.state === connection.states.SELECTED) {
            let currentMailbox = connection.mailbox;

            connection.mailbox = false;
            connection.currentSelectCommand = false;
            connection.state = connection.states.AUTHENTICATED;

            if (currentMailbox) {
                connection.emit('mailboxClose', currentMailbox);
            }
        }

        connection.log.warn({ err, cid: connection.id });
        throw err;
    }
};
