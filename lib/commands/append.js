'use strict';

const {
    formatFlag,
    canUseFlag,
    formatDateTime,
    normalizePath,
    encodePath,
    comparePaths,
    enhanceCommandError,
    parseBigIntValue,
    parseUintValue,
    MAX_UINT32_DIGITS
} = require('../tools.js');

/**
 * Appends a message to a mailbox.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} destination - Destination mailbox path
 * @param {Buffer|string} content - Message content (RFC 822 format)
 * @param {string|string[]} [flags] - Message flags to set on the appended message
 * @param {Date|string} [idate] - Internal date to set for the message
 * @returns {Promise<{destination: string, path?: string, uid?: number, uidValidity?: BigInt, seq?: number}|undefined>} Append result with UID info if available, or undefined if preconditions not met
 * @throws {Error} If the APPEND command fails or message exceeds APPENDLIMIT
 */
module.exports = async (connection, destination, content, flags, idate) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state) || !destination) {
        // nothing to do here
        return;
    }

    if (typeof content === 'string') {
        content = Buffer.from(content);
    }

    // APPENDLIMIT capability (RFC 7889): server may advertise the maximum message
    // size it accepts. Check before sending to avoid a wasted round-trip.
    if (connection.capabilities.has('APPENDLIMIT')) {
        let appendLimit = connection.capabilities.get('APPENDLIMIT');
        if (typeof appendLimit === 'number' && appendLimit < content.length) {
            let err = new Error('Message content too big for APPENDLIMIT=' + appendLimit);
            err.serverResponseCode = 'APPENDLIMIT';
            throw err;
        }
    }

    destination = normalizePath(connection, destination);

    // If appending to the currently selected mailbox, we can listen for the
    // untagged EXISTS response to capture the new message's sequence number.
    let expectExists = comparePaths(connection, connection.mailbox.path, destination);

    // Validate and format flags. Only flags allowed by the mailbox's permanentFlags are included.
    flags = (Array.isArray(flags) ? flags : [].concat(flags || []))
        .map(flag => flag && formatFlag(flag.toString()))
        .filter(flag => flag && canUseFlag(connection.mailbox, flag));

    // APPEND command format: APPEND <mailbox> [<flags>] [<date-time>] <literal>
    let attributes = [{ type: 'ATOM', value: encodePath(connection, destination) }];

    // Internal date: the date the server should record for this message.
    // Must be quoted (STRING type) per the IMAP date-time grammar.
    idate = idate ? formatDateTime(idate) : false;

    // Flags and date are optional; flags must come before date if both are present
    if (flags.length || idate) {
        attributes.push(flags.map(flag => ({ type: 'ATOM', value: flag })));
    }

    if (idate) {
        attributes.push({ type: 'STRING', value: idate });
    }

    // BINARY extension (RFC 3516): if the message content contains NUL bytes,
    // use literal8 syntax (~{size}\r\n) instead of regular literal ({size}\r\n).
    // Regular literals cannot contain NUL bytes per the IMAP grammar.
    let isLiteral8 = false;
    if (connection.capabilities.has('BINARY') && !connection.disableBinary) {
        isLiteral8 = content.indexOf(Buffer.from([0])) >= 0;
    }

    attributes.push({ type: 'LITERAL', value: content, isLiteral8 });

    let map = { destination };
    if (connection.mailbox && connection.mailbox.path) {
        map.path = connection.mailbox.path;
    }

    // Handler for untagged EXISTS: captures the new message count which gives
    // us the sequence number of the appended message (it's the latest message).
    const handleExistsUpdate = untagged => {
        // The count is written into the live mailbox state below, so it has to clear the
        // same bar untaggedExists() applies: a digit run long enough to coerce to Infinity
        // would make resolveRange('*') compile to the literal string "Infinity" and break
        // every range-based command until the next SELECT.
        let seq = parseUintValue(untagged.command, MAX_UINT32_DIGITS);
        if (seq === false) {
            return;
        }
        map.seq = seq;

        // Update the connection's mailbox state and emit 'exists' event if the
        // count changed (notifies listeners about the new message).
        if (expectExists) {
            let prevCount = connection.mailbox.exists;
            if (map.seq !== prevCount) {
                connection.mailbox.exists = map.seq;
                connection.emit('exists', {
                    path: connection.mailbox.path,
                    count: map.seq,
                    prevCount
                });
            }
        }
    };

    let response;
    try {
        response = await connection.exec('APPEND', attributes, {
            // Only listen for EXISTS if we're appending to the currently selected mailbox
            untagged: expectExists ? { EXISTS: handleExistsUpdate } : false
        });

        // UIDPLUS (RFC 4315): the server may include APPENDUID response code in
        // the tagged OK. Format: [APPENDUID <uidValidity> <uid>]
        let section = response.response.attributes && response.response.attributes[0] && response.response.attributes[0].section;
        if (section && section.length) {
            let responseCode = section[0] && typeof section[0].value === 'string' ? section[0].value : '';
            if (responseCode.toUpperCase() === 'APPENDUID') {
                // Bounded digit runs only: isNaN() also passes '1e5', which BigInt() rejects
                // with a throw - and this catch rethrows, so the append would reject after the
                // message was already stored and a retrying caller would duplicate it.
                let uidValidity = parseBigIntValue(section[1] && section[1].value, MAX_UINT32_DIGITS);
                let uid = parseUintValue(section[2] && section[2].value, MAX_UINT32_DIGITS);
                if (uidValidity !== false) {
                    map.uidValidity = uidValidity;
                }
                if (uid) {
                    map.uid = uid;
                }
            }
        }

        response.next();

        // If we didn't get an EXISTS during APPEND (some servers don't send it
        // until the next command), issue a NOOP to flush pending notifications.
        if (expectExists && !map.seq) {
            try {
                response = await connection.exec('NOOP', false, {
                    untagged: { EXISTS: handleExistsUpdate },
                    comment: 'Sequence not found from APPEND output'
                });
                response.next();
            } catch (err) {
                connection.log.warn({ err, cid: connection.id });
            }
        }

        // If we have a sequence number but no UID (server doesn't support UIDPLUS),
        // look up the UID via SEARCH to provide a consistent result to the caller.
        if (map.seq && !map.uid) {
            let list = await connection.search({ seq: map.seq }, { uid: true });
            if (list && list.length) {
                map.uid = list[0];
            }
        }

        return map;
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        throw err;
    }
};
