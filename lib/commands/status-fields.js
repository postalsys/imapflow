'use strict';

const { parseBigIntValue, parseUintValue, MAX_UINT32_DIGITS } = require('../tools.js');

// STATUS data items (RFC 3501 section 6.3.10, RFC 7162 for HIGHESTMODSEQ, RFC 9051 for SIZE
// and DELETED) mapped to the property name each one is exposed under, together with the
// parser that turns the raw response token into a usable value. Shared by the STATUS command
// and by the inline STATUS responses of LIST-STATUS (RFC 5819) so the two cannot drift apart.
//
// Every parser rejects anything that is not a bounded decimal digit run, returning false.
// These values are server-controlled and several of them are written straight into the live
// mailbox state, where a NaN or a value coerced to Infinity corrupts every later range
// computation. A plain isNaN() test is not enough: it passes '1e5', ' 12 ' and 'Infinity',
// and BigInt() throws on all three, aborting the walk over the remaining fields.
const uint32 = value => parseUintValue(value, MAX_UINT32_DIGITS);

const STATUS_FIELDS = {
    MESSAGES: { key: 'messages', parser: uint32 },
    RECENT: { key: 'recent', parser: uint32 },
    UIDNEXT: { key: 'uidNext', parser: uint32 },
    // Nominally 32-bit, but stored as a BigInt precisely so a server that exceeds that still
    // round-trips, so the wider bound applies
    UIDVALIDITY: { key: 'uidValidity', parser: value => parseBigIntValue(value) },
    UNSEEN: { key: 'unseen', parser: uint32 },
    HIGHESTMODSEQ: { key: 'highestModseq', parser: value => parseBigIntValue(value) },
    // IMAP4rev2 additions (RFC 9051): total mailbox size in octets (number64, exact as a JS
    // number up to 2^53-1) and count of messages carrying the \Deleted flag
    SIZE: { key: 'size', parser: value => parseUintValue(value) },
    DELETED: { key: 'deleted', parser: uint32 }
};

/**
 * Walks a STATUS data-item list - alternating item-name and item-value tokens - and reports
 * every recognized field that parsed successfully. Unknown item names and unusable values are
 * skipped, so one bad field never costs the rest of the response.
 *
 * @param {Array} list - Parsed attribute list from the untagged STATUS response.
 * @param {Function} onField - Called as (key, value) for each usable field.
 */
const parseStatusList = (list, onField) => {
    let name;
    list.forEach((entry, i) => {
        if (i % 2 === 0) {
            name = entry && typeof entry.value === 'string' ? entry.value : false;
            return;
        }

        if (!name || !entry) {
            return;
        }

        // The item name is server-controlled, but uppercasing it before the lookup means no
        // Object.prototype member can be reached: every builtin name has a lowercase letter.
        const field = STATUS_FIELDS[name.toUpperCase()];
        if (!field) {
            return;
        }

        const value = field.parser(entry.value);
        if (value === false) {
            return;
        }

        onField(field.key, value);
    });
};

module.exports = { parseStatusList };
