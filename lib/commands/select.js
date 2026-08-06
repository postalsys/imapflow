'use strict';

const { encodePath, normalizePath, enhanceCommandError, parseBigIntValue, parseUintValue, getStringList, MAX_UINT32_DIGITS } = require('../tools.js');

// Response codes carrying a value that SELECT/EXAMINE may write to the mailbox object, keyed by
// the lowercased code, mapped to the fixed public property name and the parser for the value.
// Every parser returns false for a value it cannot use, and the field is then left unset.
//
// This is an allowlist on purpose. The mailbox object is API surface: without one, an arbitrary
// server-sent [KEY value] code could overwrite `path` (defeating the DELETE/RENAME guards that
// compare paths) or `flags`, and a parenthesized value under "__proto__" would replace the
// object's prototype. The lookup itself is on a null-prototype object for the same reason - the
// key is lowercased, so "constructor" would otherwise resolve to an inherited member.
const VALUED_RESPONSE_CODES = Object.assign(Object.create(null), {
    // CONDSTORE (RFC 7162): highest mod-sequence value for the mailbox, used for incremental
    // sync. Stored as a BigInt since modseq values can exceed Number.MAX_SAFE_INTEGER.
    //
    // A value that is not a bounded digit run is dropped rather than stored raw: every consumer
    // compares highestModseq relationally, and a relational compare against a non-numeric string
    // is false in both directions, so the value could never advance and delta sync would stop.
    highestmodseq: { key: 'highestModseq', parse: value => parseBigIntValue(value) },

    // Unique identifier validity. If this changes between sessions, all previously cached UIDs
    // are invalid and the client must re-sync from scratch. Nominally 32-bit, but stored as a
    // BigInt precisely so a server that exceeds that still round-trips, hence the wider bound.
    uidvalidity: { key: 'uidValidity', parse: value => parseBigIntValue(value) },

    // The next UID to be assigned in this mailbox, useful for detecting new arrivals. A huge
    // digit run would coerce to Infinity and corrupt every later UID range computation.
    uidnext: { key: 'uidNext', parse: value => parseUintValue(value, MAX_UINT32_DIGITS) },

    // Sequence number of the first unseen message (RFC 3501 section 7.1). Not a count of unseen
    // messages - use mailboxStatus() with {unseen: true} for that.
    unseen: { key: 'unseen', parse: value => parseUintValue(value, MAX_UINT32_DIGITS) },

    // APPENDLIMIT (RFC 7889): largest message size in octets the server accepts for APPEND into
    // this mailbox. Spelled all lowercase, unlike the camelCase fields around it, because that is
    // the name this object has always exposed.
    appendlimit: { key: 'appendlimit', parse: value => parseUintValue(value) },

    // OBJECTID (RFC 8474): server-assigned mailbox identifier that survives renames. Sent as a
    // parenthesized list, but servers in the wild send it bare too.
    mailboxid: {
        key: 'mailboxId',
        parse: value => (Array.isArray(value) ? value.length > 0 && value[0] : typeof value === 'string' && value)
    },

    // Flags the client may change permanently on messages in this mailbox, including \* if the
    // server allows custom flags. Only the parenthesized form carries flags, and a malformed
    // value must leave permanentFlags unset rather than set an empty Set: canUseFlag() reads
    // unset as permissive and empty as deny-all, so an empty Set would turn every later flag
    // update into a silent no-op for the rest of the session.
    permanentflags: { key: 'permanentFlags', parse: value => Array.isArray(value) && new Set(value) }
});

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
    // Note: this uses run() rather than runInternal(), so it terminates a running IDLE first,
    // which is what a caller-issued mailboxOpen() needs. Fallback polling reaches SELECT through
    // runInternal(), and on a cache miss this LIST awaits the polling session's own preCheck and
    // so cancels that session. Not a deadlock, and only reachable when the folder is uncached,
    // but a polled SELECT of an unlisted folder ends the poll early.
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
            /* c8 ignore next */ // extraArgs is always initialised to an array, so the [] fallback is unreachable
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
                    if (section && section.length > 1 && section[0] && section[0].type === 'ATOM' && typeof section[0].value === 'string') {
                        let key = section[0].value.toLowerCase();
                        let value;

                        // Value can be a single string or a list of strings (e.g., PERMANENTFLAGS).
                        // section[1] can be a parsed NIL (null), and so can any element inside a
                        // parenthesized list, so both levels need the guard
                        if (section[1] && typeof section[1].value === 'string') {
                            value = section[1].value;
                        } else if (Array.isArray(section[1])) {
                            value = getStringList(section[1]);
                        }

                        let field = VALUED_RESPONSE_CODES[key];
                        if (field) {
                            let parsed = field.parse(value);
                            if (parsed !== false) {
                                map[field.key] = parsed;
                            }
                        }
                    }

                    // Handle response codes with only a keyword (no value), e.g., [NOMODSEQ].
                    // NOMODSEQ means the mailbox does not support mod-sequences, so the
                    // CONDSTORE/QRESYNC features are unavailable for it.
                    if (section && section.length === 1 && section[0] && section[0].type === 'ATOM' && section[0].value?.toUpperCase() === 'NOMODSEQ') {
                        map.noModseq = true;
                    }
                },

                // Untagged FLAGS response lists all flags defined for this mailbox
                // (both system flags and custom flags). Example: * FLAGS (\Seen \Answered \Flagged)
                FLAGS: async untagged => {
                    if (!untagged.attributes || !untagged.attributes.length || !Array.isArray(untagged.attributes[0])) {
                        return;
                    }
                    map.flags = new Set(getStringList(untagged.attributes[0]));
                },

                // Untagged EXISTS response: "* <count> EXISTS" tells us the total number
                // of messages in the mailbox. The count is in the command field (numeric prefix).
                EXISTS: async untagged => {
                    // Not a usable count: anything but a bounded digit run. A long digit run
                    // coerces to Infinity, which would corrupt every later range computation
                    let num = parseUintValue(untagged.command, MAX_UINT32_DIGITS);
                    if (num === false) {
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
        // in its response code, indicating the access mode the server granted. A tagged OK
        // with no resp-text has no `attributes` property at all, and unlike the untagged
        // handlers above this runs in the command body, where a throw would tear down the
        // mailbox state the server has actually selected.
        let okAttributes = (response.response && response.response.attributes) || [];
        let section = okAttributes[0] && !okAttributes[0].value && okAttributes[0].section;
        if (section && section.length && section[0] && section[0].type === 'ATOM' && typeof section[0].value === 'string') {
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
