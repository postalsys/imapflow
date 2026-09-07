import { enhanceCommandError, hasCapability, isValidSequenceValue, EXPANDED_RANGE_LIMIT } from '../tools.js';
import { searchCompiler } from '../search-compiler.js';
import { parseEsearchResponse } from './esearch-parser.js';
import type { ImapFlow } from '../imap-flow.js';
import type { ImapFlowError } from '../errors.js';
import type { ImapAttributeList, ImapAttributeNode, ImapCompileNode, ImapResponse } from '../handler/types.js';
import type { ESearchResult, SearchObject, SearchOptions } from '../types.js';

/**
 * Strips the leading (TAG "X") correlator list and the optional UID atom from an
 * ESEARCH untagged response, leaving only the result keyword/value pairs.
 * The IMAP parser represents parenthesized groups as plain Arrays, not objects
 * with type: 'LIST'.
 *
 * @param attrs - Raw attribute array from the IMAP parser
 * @returns Attribute array starting at the first result keyword
 */
const stripEsearchPrefix = (attrs: ImapAttributeList): ImapAttributeList => {
    let start = 0;
    if (attrs[start] && Array.isArray(attrs[start])) start++;
    if (attrs[start] && typeof attrs[start]!.value === 'string' && (attrs[start]!.value as string).toUpperCase() === 'UID') start++;
    return attrs.slice(start);
};

/**
 * Searches for messages matching the specified criteria.
 *
 * @param connection - IMAP connection instance
 * @param query - Search query object, or true/empty object to match all messages
 * @param options - Search options
 * @param options.uid - If true, use UID SEARCH instead of SEARCH
 * @param options.returnOptions - ESEARCH RETURN options. When present AND the
 *   server advertises ESEARCH capability, triggers ESEARCH and returns an ESearchResult.
 *   Items are strings ('MIN','MAX','COUNT','ALL') or objects ({ partial: '1:100' }).
 *   When server lacks ESEARCH, falls back to plain SEARCH and returns number[].
 */
export default async function search(
    connection: ImapFlow,
    query: SearchObject | boolean | null | undefined,
    options?: SearchOptions | undefined
): Promise<number[] | ESearchResult | false> {
    if (connection.state !== connection.states.SELECTED) {
        // nothing to do here
        return false;
    }

    options = options || {};

    let attributes: ImapCompileNode[];

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
        const returnItems: ImapAttributeNode[] = [];
        for (const opt of options.returnOptions!) {
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
            const returnClause: ImapCompileNode[] = [{ type: 'ATOM', value: 'RETURN' }, returnItems];

            let esearchResult: ESearchResult = {};
            let response;
            try {
                response = await connection.exec(options.uid ? 'UID SEARCH' : 'SEARCH', [...returnClause, ...attributes], {
                    untagged: {
                        ESEARCH: async (untagged: ImapResponse) => {
                            if (!untagged || !untagged.attributes) return;
                            esearchResult = parseEsearchResponse(stripEsearchPrefix(untagged.attributes));
                        }
                    }
                });
                response.next();
                return esearchResult;
            } catch (err) {
                await enhanceCommandError(err as ImapFlowError);
                connection.log.warn({ err, cid: connection.id });
                return false;
            }
        }
        // returnItems was empty - fall through to legacy SEARCH path below
    }

    // Legacy SEARCH path (no returnOptions, or server lacks ESEARCH)
    // Use a Set to deduplicate sequence numbers/UIDs - servers may return
    // duplicates across multiple untagged SEARCH responses.
    let results = new Set<number>();
    let response;
    try {
        response = await connection.exec(options.uid ? 'UID SEARCH' : 'SEARCH', attributes, {
            untagged: {
                SEARCH: async (untagged: ImapResponse) => {
                    if (untagged && untagged.attributes && untagged.attributes.length) {
                        let truncated = false;
                        let discarded = false;
                        for (let attribute of untagged.attributes) {
                            // The result set is server-controlled and accumulated across
                            // responses, so stop at the same absolute ceiling expandRange()
                            // uses - a server streaming SEARCH responses could otherwise
                            // grow the set until the process runs out of memory
                            /* c8 ignore next 4 */ // reaching the ceiling needs 2^24 accumulated results, which no unit test can produce in reasonable time
                            if (results.size >= EXPANDED_RANGE_LIMIT) {
                                truncated = true;
                                break;
                            }
                            // Same nz-number check the ESEARCH branch below applies. isNaN()
                            // is not enough: it passes '1e400' (Infinity), '-3' and '2.5', and
                            // a single one of those makes the sequence set compiled from this
                            // result set invalid, failing the caller's whole follow-up command
                            let value = attribute && typeof attribute.value === 'string' ? Number(attribute.value) : NaN;
                            if (!isValidSequenceValue(value)) {
                                discarded = true;
                                continue;
                            }
                            results.add(value);
                        }
                        if (truncated || discarded) {
                            connection.log.warn({
                                msg: 'Invalid entries in the SEARCH result',
                                truncated,
                                discarded,
                                cid: connection.id
                            });
                        }
                    }
                },

                // IMAP4rev2 servers answer even a plain SEARCH with an untagged
                // ESEARCH response (RFC 9051 deprecated the SEARCH response), so
                // both forms are collected into the same result set
                ESEARCH: async (untagged: ImapResponse) => {
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
                        // The mailbox EXISTS count is itself server-supplied and can be
                        // absurdly large, so the budget is additionally capped at the same
                        // absolute ceiling expandRange() uses - a hostile server cannot
                        // bypass it by inflating EXISTS first
                        let overBudget = () => results.size >= existsCount() || results.size >= EXPANDED_RANGE_LIMIT;
                        let resolveId = (part: string) => (part === '*' ? (options!.uid ? 0 : existsCount()) : Number(part));
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
        await enhanceCommandError(err as ImapFlowError);
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
}
