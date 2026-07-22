'use strict';

const { enhanceCommandError, hasCapability, isValidSequenceValue } = require('../tools.js');
const { searchCompiler } = require('../search-compiler.js');

/**
 * Strips the leading (TAG "X") correlator list and the optional UID atom from an
 * ESEARCH untagged response, leaving only the result keyword/value pairs.
 * The IMAP parser represents parenthesized groups as plain Arrays, not objects
 * with type: 'LIST'.
 *
 * @param {Array} attrs - Raw attribute array from the IMAP parser
 * @returns {Array} Attribute array starting at the first result keyword
 */
const stripEsearchPrefix = attrs => {
    let start = 0;
    if (attrs[start] && Array.isArray(attrs[start])) start++;
    if (attrs[start] && typeof attrs[start].value === 'string' && attrs[start].value.toUpperCase() === 'UID') start++;
    return attrs.slice(start);
};

/**
 * Parses the key-value attributes from an ESEARCH untagged response.
 *
 * Receives the attribute list AFTER stripping the leading (TAG "X") list
 * and the UID atom — i.e. only the result keyword/value pairs remain.
 *
 * ALL and PARTIAL.messages are kept as compact sequence-set strings.
 * Use expandRange() from tools.js if you need to expand them.
 *
 * @param {Array} attrs - Attribute array from the IMAP parser
 * @returns {Object} ESearchResult object
 */
function parseEsearchResponse(attrs) {
    const result = {};
    let i = 0;
    while (i < attrs.length) {
        const token = attrs[i];
        if (!token || token.type !== 'ATOM') {
            i++;
            continue;
        }
        const key = token.value.toUpperCase();
        if (i + 1 >= attrs.length) {
            i++;
            continue;
        }
        switch (key) {
            case 'COUNT': {
                const n = Number(attrs[++i]?.value);
                if (!isNaN(n)) result.count = n;
                break;
            }
            case 'MIN': {
                const n = Number(attrs[++i]?.value);
                if (!isNaN(n)) result.min = n;
                break;
            }
            case 'MAX': {
                const n = Number(attrs[++i]?.value);
                if (!isNaN(n)) result.max = n;
                break;
            }
            case 'ALL': {
                const allToken = attrs[++i];
                if (allToken && typeof allToken.value === 'string') {
                    result.all = allToken.value;
                }
                break;
            }
            case 'PARTIAL': {
                const listToken = attrs[++i];
                const items = Array.isArray(listToken) ? listToken : null;
                if (!items || items.length < 2) break;
                result.partial = {
                    range: items[0].value,
                    messages: items[1].value
                };
                break;
            }
            default:
                // Skip the value token for unknown keys to keep the stream aligned.
                // The loop's unconditional i++ at the bottom advances past the key;
                // this extra i++ advances past the value token.
                i++;
                break;
        }
        i++;
    }
    return result;
}

/**
 * Searches for messages matching the specified criteria.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {Object|boolean} query - Search query object, or true/empty object to match all messages
 * @param {Object} [options] - Search options
 * @param {boolean} [options.uid] - If true, use UID SEARCH instead of SEARCH
 * @param {Array} [options.returnOptions] - ESEARCH RETURN options. When present AND the
 *   server advertises ESEARCH capability, triggers ESEARCH and returns an ESearchResult.
 *   Items are strings ('MIN','MAX','COUNT','ALL') or objects ({ partial: '1:100' }).
 *   When server lacks ESEARCH, falls back to plain SEARCH and returns number[].
 * @returns {Promise<number[]|Object|boolean>}
 */
module.exports = async (connection, query, options) => {
    if (connection.state !== connection.states.SELECTED) {
        // nothing to do here
        return false;
    }

    options = options || {};

    let attributes;

    // Three query branches:
    // 1. Empty/truthy/all-only query -> use IMAP "SEARCH ALL" to match every message
    // 2. Non-empty object -> compile into IMAP SEARCH criteria via searchCompiler
    // 3. Anything else (unexpected type) -> bail out with false
    if (!query || query === true || (typeof query === 'object' && (!Object.keys(query).length || (Object.keys(query).length === 1 && query.all)))) {
        // search for all messages
        attributes = [{ type: 'ATOM', value: 'ALL' }];
    } else if (query && typeof query === 'object') {
        // normal query
        attributes = searchCompiler(connection, query);
    } else {
        return false;
    }

    // ESEARCH is part of base IMAP4rev2
    const useEsearch = options.returnOptions && options.returnOptions.length > 0 && hasCapability(connection, 'ESEARCH');

    if (useEsearch) {
        // Build RETURN (...) item list
        const returnItems = [];
        for (const opt of options.returnOptions) {
            if (typeof opt === 'string') {
                returnItems.push({ type: 'ATOM', value: opt.toUpperCase() });
            } else if (opt && typeof opt.partial === 'string') {
                // RFC 9394: PARTIAL is an atom followed by the range atom, both inside RETURN (...)
                returnItems.push({ type: 'ATOM', value: 'PARTIAL' });
                returnItems.push({ type: 'ATOM', value: opt.partial });
            }
        }

        // If all returnOptions entries were invalid (e.g. objects lacking a string
        // `partial` field), returnItems would be empty. Emitting "RETURN ()" is
        // technically valid per RFC 4731 but returns nothing useful. Fall through
        // to the legacy SEARCH path instead so the caller gets a usable result.
        if (returnItems.length > 0) {
            const returnClause = [{ type: 'ATOM', value: 'RETURN' }, returnItems];

            let esearchResult = {};
            let response;
            try {
                response = await connection.exec(options.uid ? 'UID SEARCH' : 'SEARCH', [...returnClause, ...attributes], {
                    untagged: {
                        ESEARCH: async untagged => {
                            if (!untagged || !untagged.attributes) return;
                            esearchResult = parseEsearchResponse(stripEsearchPrefix(untagged.attributes));
                        }
                    }
                });
                response.next();
                return esearchResult;
            } catch (err) {
                await enhanceCommandError(err);
                connection.log.warn({ err, cid: connection.id });
                return false;
            }
        }
        // returnItems was empty — fall through to legacy SEARCH path below
    }

    // ── Legacy SEARCH path (no returnOptions, or server lacks ESEARCH) ────
    // Use a Set to deduplicate sequence numbers/UIDs -- servers may return
    // duplicates across multiple untagged SEARCH responses.
    let results = new Set();
    let response;
    try {
        response = await connection.exec(options.uid ? 'UID SEARCH' : 'SEARCH', attributes, {
            untagged: {
                SEARCH: async untagged => {
                    if (untagged && untagged.attributes && untagged.attributes.length) {
                        untagged.attributes.forEach(attribute => {
                            if (attribute && attribute.value && typeof attribute.value === 'string' && !isNaN(attribute.value)) {
                                results.add(Number(attribute.value));
                            }
                        });
                    }
                },

                // IMAP4rev2 servers answer even a plain SEARCH with an untagged
                // ESEARCH response (RFC 9051 deprecated the SEARCH response), so
                // both forms are collected into the same result set
                ESEARCH: async untagged => {
                    if (!untagged || !untagged.attributes) {
                        return;
                    }
                    let parsed = parseEsearchResponse(stripEsearchPrefix(untagged.attributes));
                    if (parsed.all) {
                        // Walk the compact sequence-set directly into the Set - the ALL
                        // result may cover the entire mailbox, so expanding it into an
                        // intermediate array first would double the peak memory use.
                        // The set comes from an untrusted server: endpoints must be
                        // valid nz-numbers ('Infinity' would otherwise loop forever)
                        // and the expansion stops at the mailbox EXISTS count - a
                        // conforming server cannot match more messages than exist, so
                        // a hostile range like 1:4294967295 cannot exhaust memory.
                        // A '*' means "largest number in use": that is exactly EXISTS
                        // for message sequence numbers, while server-sent UID sets may
                        // not contain '*' at all (RFC 9051 section 4.1.1), so UID
                        // parts with '*' are dropped
                        let existsCount = () => (connection.mailbox && connection.mailbox.exists) || 0;
                        let overBudget = () => results.size >= existsCount();
                        let resolveId = part => (part === '*' ? (options.uid ? 0 : existsCount()) : Number(part));
                        let truncated = false;
                        let discarded = false;
                        sequenceSetLoop: for (let part of parsed.all.split(',')) {
                            part = part.trim();
                            let colon = part.indexOf(':');
                            if (colon < 0) {
                                let value = resolveId(part);
                                if (!isValidSequenceValue(value)) {
                                    discarded = true;
                                    continue;
                                }
                                if (overBudget()) {
                                    truncated = true;
                                    break;
                                }
                                results.add(value);
                                continue;
                            }
                            let first = resolveId(part.substr(0, colon));
                            let second = resolveId(part.substr(colon + 1));
                            if (!isValidSequenceValue(first) || !isValidSequenceValue(second)) {
                                discarded = true;
                                continue;
                            }
                            for (let id = Math.min(first, second); id <= Math.max(first, second); id++) {
                                if (overBudget()) {
                                    truncated = true;
                                    break sequenceSetLoop;
                                }
                                results.add(id);
                            }
                        }
                        if (truncated || discarded) {
                            connection.log.warn({
                                msg: 'Invalid entries in the ESEARCH ALL result',
                                truncated,
                                discarded,
                                cid: connection.id
                            });
                        }
                    }
                }
            }
        });
        response.next();
        // Sort numerically for consistent, predictable output order
        return Array.from(results).sort((a, b) => a - b);
    } catch (err) {
        await enhanceCommandError(err);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};

// Exported for unit testing — not intended as public library API
module.exports.parseEsearchResponse = parseEsearchResponse;
