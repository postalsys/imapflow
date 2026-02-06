'use strict';

const { decodePath, encodePath, normalizePath } = require('../tools.js');
const { specialUse } = require('../special-use');

/**
 * Lists mailboxes from the server, including subscription status and special-use flags.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} reference - Reference name (namespace prefix)
 * @param {string} mailbox - Mailbox name pattern with possible wildcards
 * @param {Object} [options] - List options
 * @param {boolean} [options.listOnly] - If true, return entries after LIST without LSUB or status queries
 * @param {Object} [options.statusQuery] - Status data items to query for each listed mailbox
 * @param {Object} [options.specialUseHints] - Hints mapping mailbox paths to special-use types (sent, junk, trash, drafts, archive)
 * @returns {Promise<Object[]>} Array of mailbox entries sorted by special-use flags and name
 * @throws {Error} If the LIST command fails
 */
module.exports = async (connection, reference, mailbox, options) => {
    options = options || {};

    // Special-use flags sorted by display priority (INBOX first, Trash last).
    // Used in the final sort to group special-use mailboxes at the top of the list.
    const FLAG_SORT_ORDER = ['\\Inbox', '\\Flagged', '\\Sent', '\\Drafts', '\\All', '\\Archive', '\\Junk', '\\Trash'];
    // Priority for how a special-use flag was determined: explicit user hint > server
    // extension flag (SPECIAL-USE/XLIST) > name-based guess. When multiple mailboxes
    // claim the same special-use type, the highest-priority source wins.
    const SOURCE_SORT_ORDER = ['user', 'extension', 'name'];

    // Prefer XLIST (legacy Gmail extension) only if SPECIAL-USE (RFC 6154) is unavailable.
    // Both provide special-use flags, but SPECIAL-USE is the standardized approach.
    let listCommand = connection.capabilities.has('XLIST') && !connection.capabilities.has('SPECIAL-USE') ? 'XLIST' : 'LIST';

    let response;
    try {
        let entries = [];

        // statusMap caches STATUS responses received inline via LIST-STATUS extension,
        // keyed by normalized mailbox path. This avoids separate STATUS commands per mailbox.
        let statusMap = new Map();
        let returnArgs = [];
        let statusQueryAttributes = [];

        // Build the list of STATUS data items to request (MESSAGES, UIDNEXT, etc.)
        if (options.statusQuery) {
            Object.keys(options.statusQuery || {}).forEach(key => {
                if (!options.statusQuery[key]) {
                    return;
                }

                switch (key.toUpperCase()) {
                    case 'MESSAGES':
                    case 'RECENT':
                    case 'UIDNEXT':
                    case 'UIDVALIDITY':
                    case 'UNSEEN':
                        statusQueryAttributes.push({ type: 'ATOM', value: key.toUpperCase() });
                        break;

                    case 'HIGHESTMODSEQ':
                        if (connection.capabilities.has('CONDSTORE')) {
                            statusQueryAttributes.push({ type: 'ATOM', value: key.toUpperCase() });
                        }
                        break;
                }
            });
        }

        // LIST-STATUS (RFC 5819): allows requesting STATUS data inline with LIST,
        // avoiding a separate STATUS command for each mailbox. Adds RETURN (STATUS (...))
        // and optionally SPECIAL-USE to the LIST command arguments.
        if (listCommand === 'LIST' && connection.capabilities.has('LIST-STATUS') && statusQueryAttributes.length) {
            returnArgs.push({ type: 'ATOM', value: 'STATUS' }, statusQueryAttributes);
            if (connection.capabilities.has('SPECIAL-USE')) {
                returnArgs.push({ type: 'ATOM', value: 'SPECIAL-USE' });
            }
        }

        // Tracks all candidate mailboxes for each special-use type (e.g., \\Sent).
        // Multiple mailboxes may claim the same type via different sources (user hint,
        // server extension, name match). After listing, the best match wins.
        let specialUseMatches = {};
        let addSpecialUseMatch = (entry, type, source) => {
            if (!specialUseMatches[type]) {
                specialUseMatches[type] = [];
            }
            specialUseMatches[type].push({ entry, source });
        };

        // User-provided hints map mailbox paths to special-use types (e.g., {sent: "Sent Items"}).
        // These override server-reported flags and name-based guesses. Converted to a
        // path-keyed lookup: { "Sent Items" => "\\Sent" }
        let specialUseHints = {};
        if (options.specialUseHints && typeof options.specialUseHints === 'object') {
            for (let type of Object.keys(options.specialUseHints)) {
                if (
                    ['sent', 'junk', 'trash', 'drafts', 'archive'].includes(type) &&
                    options.specialUseHints[type] &&
                    typeof options.specialUseHints[type] === 'string'
                ) {
                    // Capitalize first letter: "sent" -> "\\Sent"
                    specialUseHints[normalizePath(connection, options.specialUseHints[type])] = `\\${type.replace(/^./, c => c.toUpperCase())}`;
                }
            }
        }

        // Executes a LIST (or XLIST) command and collects mailbox entries.
        // Called once for the main listing and optionally again for INBOX if a
        // namespace prefix was used (INBOX may live outside the namespace).
        let runList = async (reference, mailbox) => {
            const cmdArgs = [encodePath(connection, reference), encodePath(connection, mailbox)];

            if (returnArgs.length) {
                cmdArgs.push({ type: 'ATOM', value: 'RETURN' }, returnArgs);
            }

            response = await connection.exec(listCommand, cmdArgs, {
                untagged: {
                    // Each untagged LIST response: * LIST (<flags>) "<delimiter>" "<mailbox name>"
                    // attributes[0] = flags array, attributes[1] = delimiter, attributes[2] = mailbox name
                    [listCommand]: async untagged => {
                        if (!untagged.attributes || !untagged.attributes.length) {
                            return;
                        }

                        let entry = {
                            // Decode from modified UTF-7 wire format and normalize the path
                            path: normalizePath(connection, decodePath(connection, (untagged.attributes[2] && untagged.attributes[2].value) || '')),
                            pathAsListed: (untagged.attributes[2] && untagged.attributes[2].value) || '',
                            flags: new Set(untagged.attributes[0].map(entry => entry.value)),
                            delimiter: untagged.attributes[1] && untagged.attributes[1].value,
                            listed: true
                        };

                        // Check user-provided hints first (highest priority)
                        if (specialUseHints[entry.path]) {
                            addSpecialUseMatch(entry, specialUseHints[entry.path], 'user');
                        }

                        // XLIST marks INBOX with a \\Inbox flag. Remove it from flags
                        // (it's not a standard flag) and register as special-use match.
                        // XLIST may also use a localised name (e.g., "Posteingang" for German INBOX).
                        if (listCommand === 'XLIST' && entry.flags.has('\\Inbox')) {
                            entry.flags.delete('\\Inbox');
                            if (entry.path !== 'INBOX') {
                                addSpecialUseMatch(entry, '\\Inbox', 'extension');
                            }
                        }

                        // Name-based INBOX detection: any mailbox named "INBOX" (case-insensitive)
                        // is the inbox per RFC 3501.
                        if (entry.path.toUpperCase() === 'INBOX') {
                            addSpecialUseMatch(entry, '\\Inbox', 'name');
                        }

                        // Strip leading delimiter (some servers prepend it to paths)
                        if (entry.delimiter && entry.path.charAt(0) === entry.delimiter) {
                            entry.path = entry.path.slice(1);
                        }

                        // Build parent path hierarchy for tree construction and sorting
                        entry.parentPath = entry.delimiter && entry.path ? entry.path.substr(0, entry.path.lastIndexOf(entry.delimiter)) : '';
                        entry.parent = entry.delimiter ? entry.path.split(entry.delimiter) : [entry.path];
                        entry.name = entry.parent.pop();

                        // Try to detect special-use from server flags or well-known names
                        // (e.g., "Sent", "Drafts", "Junk", "Trash")
                        let { flag: specialUseFlag, source: flagSource } = specialUse(
                            connection.capabilities.has('XLIST') || connection.capabilities.has('SPECIAL-USE'),
                            entry
                        );

                        if (specialUseFlag) {
                            addSpecialUseMatch(entry, specialUseFlag, flagSource);
                        }

                        entries.push(entry);
                    },

                    // Inline STATUS response from LIST-STATUS extension (RFC 5819).
                    // Parses alternating key-value pairs (i % 2 pattern).
                    STATUS: async untagged => {
                        let statusPath = normalizePath(connection, decodePath(connection, (untagged.attributes[0] && untagged.attributes[0].value) || ''));
                        let statusList = untagged.attributes && Array.isArray(untagged.attributes[1]) ? untagged.attributes[1] : false;
                        if (!statusList || !statusPath) {
                            return;
                        }

                        const STATUS_FIELD_MAP = {
                            MESSAGES: { key: 'messages', parser: Number },
                            RECENT: { key: 'recent', parser: Number },
                            UIDNEXT: { key: 'uidNext', parser: Number },
                            UIDVALIDITY: { key: 'uidValidity', parser: BigInt },
                            UNSEEN: { key: 'unseen', parser: Number },
                            HIGHESTMODSEQ: { key: 'highestModseq', parser: BigInt }
                        };

                        let key;
                        let map = { path: statusPath };

                        statusList.forEach((entry, i) => {
                            if (i % 2 === 0) {
                                key = entry && typeof entry.value === 'string' ? entry.value : false;
                                return;
                            }
                            if (!key || !entry || typeof entry.value !== 'string') {
                                return;
                            }

                            const fieldConfig = STATUS_FIELD_MAP[key.toUpperCase()];
                            if (!fieldConfig) {
                                return;
                            }

                            const value = !isNaN(entry.value) ? fieldConfig.parser(entry.value) : false;
                            if (value === false) {
                                return;
                            }

                            map[fieldConfig.key] = value;
                        });

                        statusMap.set(statusPath, map);
                    }
                }
            });
            response.next();
        };

        let normalizedReference = normalizePath(connection, reference || '');
        await runList(normalizedReference, normalizePath(connection, mailbox || '', true));

        if (options.listOnly) {
            return entries;
        }

        // When listing with a namespace prefix (e.g., "INBOX."), INBOX itself may
        // not appear in results. Run a separate LIST for INBOX to ensure it's included.
        if (normalizedReference && !specialUseMatches['\\Inbox']) {
            await runList('', 'INBOX');
        }

        // Attach STATUS data to each selectable mailbox. If LIST-STATUS was used,
        // data is already in statusMap; otherwise, fall back to individual STATUS commands.
        if (options.statusQuery) {
            for (let entry of entries) {
                // \\Noselect and \\NonExistent mailboxes cannot hold messages
                if (!entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent')) {
                    if (statusMap.has(entry.path)) {
                        entry.status = statusMap.get(entry.path);
                    } else if (!statusMap.size) {
                        // Server didn't support LIST-STATUS; fall back to per-mailbox STATUS
                        try {
                            entry.status = await connection.run('STATUS', entry.path, options.statusQuery);
                        } catch (err) {
                            entry.status = { error: err };
                        }
                    }
                }
            }
        }

        // LSUB (RFC 3501 6.3.9): queries which mailboxes the user is subscribed to.
        // We merge subscription info into the entries already collected from LIST.
        // Subscribed-only mailboxes that weren't in LIST are intentionally ignored
        // (they may be phantom entries from old subscriptions to deleted mailboxes).
        response = await connection.exec(
            'LSUB',
            [encodePath(connection, normalizePath(connection, reference || '')), encodePath(connection, normalizePath(connection, mailbox || '', true))],
            {
                untagged: {
                    LSUB: async untagged => {
                        if (!untagged.attributes || !untagged.attributes.length) {
                            return;
                        }

                        let entry = {
                            path: normalizePath(connection, decodePath(connection, (untagged.attributes[2] && untagged.attributes[2].value) || '')),
                            pathAsListed: (untagged.attributes[2] && untagged.attributes[2].value) || '',
                            flags: new Set(untagged.attributes[0].map(entry => entry.value)),
                            delimiter: untagged.attributes[1] && untagged.attributes[1].value,
                            subscribed: true
                        };

                        if (entry.path.toUpperCase() === 'INBOX') {
                            addSpecialUseMatch(entry, '\\Inbox', 'name');
                        }

                        if (entry.delimiter && entry.path.charAt(0) === entry.delimiter) {
                            entry.path = entry.path.slice(1);
                        }

                        entry.parentPath = entry.delimiter && entry.path ? entry.path.substr(0, entry.path.lastIndexOf(entry.delimiter)) : '';
                        entry.parent = entry.delimiter ? entry.path.split(entry.delimiter) : [entry.path];
                        entry.name = entry.parent.pop();

                        // Merge LSUB data into existing LIST entry if found
                        let existing = entries.find(existing => existing.path === entry.path);
                        if (existing) {
                            existing.subscribed = true;
                            // Merge any additional flags from LSUB into the LIST entry
                            entry.flags.forEach(flag => existing.flags.add(flag));
                        }
                        // Non-listed subscribed folders are intentionally ignored
                    }
                }
            }
        );
        response.next();

        // Resolve special-use conflicts: for each type, pick the best candidate
        // based on source priority (user > extension > name), then alphabetically.
        // Only the winning entry gets the specialUse property set.
        for (let type of Object.keys(specialUseMatches)) {
            let sortedEntries = specialUseMatches[type].sort((a, b) => {
                let aSource = SOURCE_SORT_ORDER.indexOf(a.source);
                let bSource = SOURCE_SORT_ORDER.indexOf(b.source);
                if (aSource === bSource) {
                    return a.entry.path.localeCompare(b.entry.path);
                }
                return aSource - bSource;
            });

            if (!sortedEntries[0].entry.specialUse) {
                sortedEntries[0].entry.specialUse = type;
                sortedEntries[0].entry.specialUseSource = sortedEntries[0].source;
            }
        }

        // INBOX should always appear as subscribed regardless of LSUB results
        let inboxEntry = entries.find(entry => entry.specialUse === '\\Inbox');
        if (inboxEntry && !inboxEntry.subscribed) {
            inboxEntry.subscribed = true;
        }

        // Sort: special-use mailboxes first (in FLAG_SORT_ORDER), then alphabetically
        // by path segments for a natural folder hierarchy ordering.
        return entries.sort((a, b) => {
            if (a.specialUse && !b.specialUse) {
                return -1;
            }
            if (!a.specialUse && b.specialUse) {
                return 1;
            }
            if (a.specialUse && b.specialUse) {
                return FLAG_SORT_ORDER.indexOf(a.specialUse) - FLAG_SORT_ORDER.indexOf(b.specialUse);
            }

            let aList = [].concat(a.parent).concat(a.name);
            let bList = [].concat(b.parent).concat(b.name);

            for (let i = 0; i < aList.length; i++) {
                let aPart = aList[i];
                let bPart = bList[i];
                if (aPart !== bPart) {
                    return aPart.localeCompare(bPart || '');
                }
            }

            return a.path.localeCompare(b.path);
        });
    } catch (err) {
        connection.log.warn({ msg: 'Failed to list folders', err, cid: connection.id });
        throw err;
    }
};
