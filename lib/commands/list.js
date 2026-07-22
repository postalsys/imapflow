'use strict';

const { decodePath, encodePath, normalizePath, enhanceCommandError, hasCapability, isRev2Active, buildStatusQueryAttributes } = require('../tools.js');
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
    // SPECIAL-USE is checked with rev2 folding - a rev2 session implies SPECIAL-USE,
    // so LIST is preferred even if a rev2 server also advertised legacy XLIST.
    let listCommand = connection.capabilities.has('XLIST') && !hasCapability(connection, 'SPECIAL-USE') ? 'XLIST' : 'LIST';

    try {
        // Accumulators filled by the untagged LIST/STATUS handlers below. statusMap
        // caches STATUS responses received inline via LIST-STATUS extension, keyed by
        // normalized mailbox path (avoids separate STATUS commands per mailbox), and
        // specialUseMatches tracks candidate mailboxes for each special-use type.
        // (Re)initialized at the start of each retry stage of the main listing.
        let entries;
        let statusMap;
        let specialUseMatches;

        // STATUS data items to request (MESSAGES, UIDNEXT, etc.)
        let statusQueryAttributes = buildStatusQueryAttributes(connection, options.statusQuery);

        // Extended LIST syntax (RETURN options) is understood by servers advertising
        // LIST-EXTENDED (RFC 5258) or IMAP4rev2 (RFC 9051). Deliberately keyed on the
        // advertisement alone (not hasCapability/isRev2Active): the staged retry below
        // handles servers that advertise but reject RETURN options, so the wider gate
        // is safe for anything it covers, while gates without a retry ladder stay
        // conservative.
        let supportsExtendedList = connection.capabilities.has('LIST-EXTENDED') || connection.capabilities.has('IMAP4rev2');

        // RETURN options for the LIST command. Servers occasionally advertise the
        // extensions but still reject RETURN options - the staged retry below then
        // re-runs the LIST with fewer options and latches a skip flag for the option
        // group the server proved to reject, keeping later listings efficient.

        // LIST-STATUS (RFC 5819, folded into base IMAP4rev2): request STATUS data
        // inline with LIST, avoiding a separate STATUS command for each mailbox.
        let canRequestStatus =
            listCommand === 'LIST' && !connection.skipListStatusArgs && hasCapability(connection, 'LIST-STATUS') && !!statusQueryAttributes.length;

        // RETURN (SUBSCRIBED): request subscription state inline instead of a separate
        // LSUB command. IMAP4rev2 removed LSUB entirely, and some servers (e.g.
        // Exchange in IMAP4rev2 mode) reject it with BAD even while still advertising
        // IMAP4rev1.
        let canRequestSubscribed = listCommand === 'LIST' && !options.listOnly && !connection.skipListSubscribedArg && supportsExtendedList;

        // Auxiliary RETURN options (SPECIAL-USE/CHILDREN) that ride along with the
        // STATUS/SUBSCRIBED option groups. When RETURN options are present, servers
        // may report only what was explicitly requested (verified against Dovecot
        // 2.4: special-use and child attributes disappear from such responses), so
        // request everything a plain LIST would have provided.
        let auxArgsAvailable = hasCapability(connection, 'SPECIAL-USE') || connection.capabilities.has('CHILDREN') || supportsExtendedList;
        let stageHasAuxArgs = stage => (stage.status || stage.subscribed) && stage.aux !== false && !connection.skipListAuxArgs && auxArgsAvailable;

        // Builds the RETURN (...) argument list for one retry stage
        let buildListArgs = stage => {
            let args = [];
            if (stage.status) {
                args.push({ type: 'ATOM', value: 'STATUS' }, statusQueryAttributes);
            }
            if (stageHasAuxArgs(stage)) {
                if (hasCapability(connection, 'SPECIAL-USE')) {
                    args.push({ type: 'ATOM', value: 'SPECIAL-USE' });
                }
                if (connection.capabilities.has('CHILDREN') || supportsExtendedList) {
                    args.push({ type: 'ATOM', value: 'CHILDREN' });
                }
            }
            if (stage.subscribed) {
                args.push({ type: 'ATOM', value: 'SUBSCRIBED' });
            }
            return args;
        };

        // Multiple mailboxes may claim the same special-use type (e.g., \\Sent) via
        // different sources (user hint, server extension, name match). After listing,
        // the best match wins.
        let addSpecialUseMatch = (entry, type, source) => {
            if (!specialUseMatches[type]) {
                specialUseMatches[type] = [];
            }
            specialUseMatches[type].push({ entry, source });
        };

        // RFC 5258: the \NonExistent attribute implies \Noselect. Some servers only
        // return \NonExistent for phantom folders, so add \Noselect as well to keep
        // the flags consistent for consumers that only check \Noselect.
        // RETURN (SUBSCRIBED) - and some LSUB implementations - report subscription
        // state as a \Subscribed attribute. Move it to the subscribed property so the
        // output shape is the same however the state was delivered.
        let normalizeFlags = entry => {
            if (entry.flags.has('\\NonExistent')) {
                entry.flags.add('\\Noselect');
            }
            if (entry.flags.has('\\Subscribed')) {
                entry.flags.delete('\\Subscribed');
                entry.subscribed = true;
            }
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
        let runList = async (reference, mailbox, returnArgs) => {
            const cmdArgs = [encodePath(connection, reference), encodePath(connection, mailbox)];

            if (returnArgs.length) {
                cmdArgs.push({ type: 'ATOM', value: 'RETURN' }, returnArgs);
            }

            let response = await connection.exec(listCommand, cmdArgs, {
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

                        normalizeFlags(entry);

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
                        // is the inbox per RFC 3501. Phantom \NonExistent entries (subscribed
                        // leftovers of deleted mailboxes) must not claim the slot by name.
                        if (entry.path.toUpperCase() === 'INBOX' && !entry.flags.has('\\NonExistent')) {
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
                            connection.capabilities.has('XLIST') || hasCapability(connection, 'SPECIAL-USE'),
                            entry
                        );

                        // A name-based guess for a \NonExistent phantom entry could win the
                        // special-use slot over the real folder - only server-provided flags
                        // are trusted for nonexistent entries
                        if (specialUseFlag && (flagSource !== 'name' || !entry.flags.has('\\NonExistent'))) {
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
        let normalizedMailbox = normalizePath(connection, mailbox || '', true);

        // Retry stages for the main listing: start with all applicable RETURN options
        // and drop one option group per retry. Consecutive stages differ by exactly one
        // group, so a success right after a rejection identifies the offending group
        // and only that group's skip flag is latched for the rest of the connection.
        // When a stage carrying the auxiliary SPECIAL-USE/CHILDREN options is rejected,
        // a copy of the same stage without them is inserted first (once per listing),
        // so an auxiliary-only rejection does not get a whole option group blamed.
        let stages = [];
        if (canRequestStatus && canRequestSubscribed) {
            stages.push({ status: true, subscribed: true });
        }
        if (canRequestStatus) {
            stages.push({ status: true, subscribed: false });
        } else if (canRequestSubscribed) {
            stages.push({ status: false, subscribed: true });
        }
        stages.push({ status: false, subscribed: false });

        // A tagged BAD is how servers reject unrecognized RETURN options (RFC 9051
        // section 6.3.9). A tagged NO is an operational failure, and throttling
        // errors (code ETHROTTLE) also surface with a BAD status - neither says
        // anything about the RETURN options, so they propagate to the caller.
        let isRejectedCommand = err => err.responseStatus === 'BAD' && err.code !== 'ETHROTTLE';

        // Stage of the successful attempt - reused by the INBOX fixup and the LSUB
        // decision below
        let successStage = null;

        let lastRejectedStage = null;
        let auxRetryInserted = false;
        for (let i = 0; i < stages.length; i++) {
            let stage = stages[i];
            let stageArgs = buildListArgs(stage);
            // Discard partial results from a rejected attempt
            entries = [];
            statusMap = new Map();
            specialUseMatches = {};
            try {
                await runList(normalizedReference, normalizedMailbox, stageArgs);
                if (lastRejectedStage) {
                    // Latch only the option group that was present in the rejected
                    // attempt but missing from this successful one - that group is
                    // proven to be what the server rejects. An unproven group (e.g.
                    // SUBSCRIBED when both groups were dropped one by one) is decided
                    // by the reduced stage list of the next listing.
                    if (lastRejectedStage.subscribed && !stage.subscribed) {
                        connection.skipListSubscribedArg = true;
                    }
                    if (lastRejectedStage.status && !stage.status) {
                        connection.skipListStatusArgs = true;
                    }
                    if (
                        stageHasAuxArgs(lastRejectedStage) &&
                        stage.aux === false &&
                        lastRejectedStage.status === stage.status &&
                        lastRejectedStage.subscribed === stage.subscribed
                    ) {
                        // Same option groups, only the auxiliary args dropped - the
                        // auxiliaries are proven to be what the server rejects
                        connection.skipListAuxArgs = true;
                    }
                }
                successStage = stage;
                break;
            } catch (err) {
                if (i === stages.length - 1 || !isRejectedCommand(err)) {
                    throw err;
                }
                lastRejectedStage = stage;
                if (!auxRetryInserted && stageHasAuxArgs(stage)) {
                    // The rejection may be about the auxiliary options rather than the
                    // option groups - try the same groups without the auxiliaries before
                    // dropping a group
                    stages.splice(i + 1, 0, { ...stage, aux: false });
                    auxRetryInserted = true;
                }
                connection.log.warn({ msg: 'LIST RETURN options rejected, retrying with reduced options', err, cid: connection.id });
            }
        }

        if (options.listOnly) {
            return entries;
        }

        // When listing with a namespace prefix (e.g., "INBOX."), INBOX itself may
        // not appear in results. Run a separate LIST for INBOX to ensure it's included.
        if (normalizedReference && !specialUseMatches['\\Inbox']) {
            let returnArgs = buildListArgs(successStage);
            // Snapshot the accumulator sizes: a rejected fixup attempt may have
            // streamed partial untagged responses before its tagged BAD, and those
            // must be discarded before the retry or INBOX would be listed twice -
            // while the main run's results must be kept
            let entryCountBefore = entries.length;
            let specialUseCountsBefore = {};
            for (let type of Object.keys(specialUseMatches)) {
                specialUseCountsBefore[type] = specialUseMatches[type].length;
            }
            try {
                await runList('', 'INBOX', returnArgs);
            } catch (err) {
                // The main listing just succeeded with the same RETURN options, so a
                // rejection here says nothing about the options themselves - retry
                // this one call plain without latching any skip flags. Accepted edge:
                // if the main run filled statusMap, INBOX ends up without inline
                // status data.
                if (!returnArgs.length || !isRejectedCommand(err)) {
                    throw err;
                }
                entries.length = entryCountBefore;
                for (let type of Object.keys(specialUseMatches)) {
                    if (!(type in specialUseCountsBefore)) {
                        delete specialUseMatches[type];
                    } else {
                        specialUseMatches[type].length = specialUseCountsBefore[type];
                    }
                }
                connection.log.warn({ msg: 'INBOX LIST with RETURN options failed, retrying plain', err, cid: connection.id });
                await runList('', 'INBOX', []);
            }
        }

        // Attach STATUS data to each selectable mailbox. If LIST-STATUS was used,
        // data is already in statusMap; otherwise, fall back to individual STATUS commands.
        if (options.statusQuery) {
            // RECENT does not exist in IMAP4rev2, so it is never requested from a rev2
            // session - its defined value there is always 0 (the STATUS command module
            // applies the same rule on the per-mailbox fallback path)
            let syntheticRecent = options.statusQuery.recent && isRev2Active(connection);
            for (let entry of entries) {
                // \\Noselect and \\NonExistent mailboxes cannot hold messages
                if (!entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent')) {
                    if (statusMap.has(entry.path)) {
                        entry.status = statusMap.get(entry.path);
                        if (syntheticRecent) {
                            entry.status.recent = 0;
                        }
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
        let runLsub = async () => {
            let response = await connection.exec('LSUB', [encodePath(connection, normalizedReference), encodePath(connection, normalizedMailbox)], {
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
                            normalizeFlags(existing);
                        }
                        // Non-listed subscribed folders are intentionally ignored
                    }
                }
            });
            response.next();
        };

        // Skipped when RETURN (SUBSCRIBED) already provided subscription state or when
        // this connection's server already rejected LSUB once. Safety net: if the
        // extended LIST was accepted but not a single mailbox came back subscribed on a
        // non-rev2 session, assume the server silently ignored RETURN (SUBSCRIBED) and
        // fall back to LSUB anyway (a rev2 session has no LSUB to fall back to, and an
        // account without any subscriptions legitimately looks the same).
        let needsLsub = !successStage.subscribed || (!isRev2Active(connection) && !entries.some(entry => entry.subscribed));
        if (needsLsub && !connection.skipLsub) {
            try {
                await runLsub();
            } catch (err) {
                if (isRejectedCommand(err)) {
                    // Tagged BAD: the server does not recognize the command (IMAP4rev2
                    // removed LSUB) - skip LSUB for the rest of this connection
                    connection.skipLsub = true;
                } else if (err.responseStatus !== 'NO' || err.code === 'ETHROTTLE') {
                    // Transport failures and throttling: rethrow, every follow-up
                    // command would fail too or the caller needs to back off
                    throw err;
                }
                // Subscription state is auxiliary - keep the LIST results usable. A
                // tagged NO is treated as transient, so the next listing tries again.
                connection.log.warn({ msg: 'Failed to request subscription info', err, cid: connection.id });
            }
        }

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
        // Rewrite the parsed err.response into the response text and set
        // serverResponseCode, same as the other command modules
        await enhanceCommandError(err);
        connection.log.warn({ msg: 'Failed to list folders', err, cid: connection.id });
        throw err;
    }
};
