/* eslint no-control-regex:0 */

import { formatDate, formatFlag, toValidDate, isRev2Active } from './tools.js';
import type { ImapFlow } from './imap-flow.js';
import type { ImapFlowError } from './errors.js';
import type { ImapAttributeNode } from './handler/types.js';
import type { SearchObject } from './types.js';

/**
 * A compiled search attribute: a token, or a parenthesized group of tokens
 */
export type SearchAttribute = ImapAttributeNode | SearchAttribute[];

// Matches any character outside the ASCII range
const UNICODE_PATTERN = /[^\x00-\x7F]/;

/**
 * Sets a boolean flag in the IMAP search attributes.
 * Automatically handles UN- prefixing for falsy values.
 *
 * @param attributes - Array to append the attribute to
 * @param term - The flag name (e.g., 'SEEN', 'DELETED')
 * @param value - Whether to set or unset the flag
 * @example
 * setBoolOpt(attributes, 'SEEN', false) // Adds 'UNSEEN'
 * setBoolOpt(attributes, 'UNSEEN', false) // Adds 'SEEN' (removes UN prefix)
 */
let setBoolOpt = (attributes: SearchAttribute[], term: string, value: boolean): void => {
    if (!value) {
        // For falsy values, toggle the UN- prefix
        if (/^un/i.test(term)) {
            // Remove existing UN prefix
            term = term.slice(2);
        } else {
            // Add UN prefix
            term = 'UN' + term;
        }
    }

    attributes.push({ type: 'ATOM', value: term.toUpperCase() });
};

/**
 * Normalizes a user-supplied sequence set (string, number, bigint, or an array of
 * them) into the single string value of a SEQUENCE token. An array is one
 * comma-joined set: separate tokens would be parsed by the server as extra
 * sequence-number search keys ANDed to the query, not as part of the set.
 *
 * @param value - The sequence set value(s)
 * @returns The joined sequence set string
 */
let toSequenceValue = (value: unknown): string => ([] as unknown[]).concat(value).join(',');

/**
 * Builds the token for a search value. A quoted string may only carry 7-bit
 * characters (RFC 3501 section 9), so a non-ASCII value is sent as a literal;
 * strict servers reply BAD to UTF-8 inside a quoted string. A literal can not
 * carry NUL either (CHAR8 is %x01-ff), so such a value stays an ATOM and the
 * compiler rejects it.
 *
 * @param value - The search value
 * @returns An ATOM token (quoted by the compiler when needed), or a LITERAL token
 */
let toSearchValue = (value: string): ImapAttributeNode =>
    UNICODE_PATTERN.test(value) && !value.includes('\0') ? { type: 'LITERAL', value: Buffer.from(value) } : { type: 'ATOM', value };

/**
 * Adds a search option with its value(s) to the attributes array.
 * Handles NOT operations and array values.
 *
 * @param attributes - Array to append the attribute to
 * @param term - The search term (e.g., 'FROM', 'SUBJECT')
 * @param value - The value for the search term (string, array, or falsy for NOT)
 */
let setOpt = (attributes: SearchAttribute[], term: string, value: any): void => {
    // Handle NOT operations for false or null values
    if (value === false || value === null) {
        attributes.push({ type: 'ATOM', value: 'NOT' });
    }

    attributes.push({ type: 'ATOM', value: term.toUpperCase() });

    // Handle array values (e.g. HEADER name/value pairs)
    if (Array.isArray(value)) {
        value.forEach(entry => attributes.push(toSearchValue((entry || '').toString())));
    } else {
        attributes.push(toSearchValue(value.toString()));
    }
};

/**
 * Processes date fields for IMAP search.
 * Converts JavaScript dates to IMAP date format.
 *
 * @param attributes - Array to append the attribute to
 * @param term - The date search term (e.g., 'BEFORE', 'SINCE')
 * @param value - Date value to format
 */
let processDateField = (attributes: SearchAttribute[], term: string, value: unknown): void => {
    // Normalize first. A Date brand check is not enough on its own: an invalid
    // Date is still a Date and toISOString() throws on it. Normalizing here also
    // means a date string behaves exactly like the equivalent Date object.
    let date = toValidDate(value);
    if (!date) {
        return;
    }

    if (['BEFORE', 'SENTBEFORE'].includes(term.toUpperCase()) && date.toISOString().substring(11) !== '00:00:00.000Z') {
        // Set to next day to include current day as well, othwerise BEFORE+AFTER
        // searches for the same day but different time values do not match anything
        date = new Date(date.getTime() + 24 * 3600 * 1000);
    }

    // Still reachable after the guard above: the +24h shift can push a near-max
    // Date past the representable range
    let formatted = formatDate(date);
    if (!formatted) {
        return;
    }

    setOpt(attributes, term, formatted);
};

/**
 * Throws a coded search compilation error.
 *
 * @param code - Error code, one of the ImapFlowErrorCode values
 * @param message - Error message
 */
let fail = (code: string, message: string): never => {
    let error: ImapFlowError = new Error(message);
    error.code = code;
    throw error;
};

/**
 * Checks whether any search value was compiled into a literal, which only
 * happens for non-ASCII values and means CHARSET UTF-8 needs to be specified.
 *
 * @param attributes - Compiled search attributes
 * @returns True if a LITERAL token is present
 */
let hasLiteral = (attributes: SearchAttribute[]): boolean => attributes.some(attr => (Array.isArray(attr) ? hasLiteral(attr) : attr.type === 'LITERAL'));

/**
 * Compiles a JavaScript object query into IMAP search command attributes.
 * Supports standard IMAP search criteria and extensions like OBJECTID and Gmail extensions.
 *
 * @param connection - IMAP connection object (capabilities and enabled extensions are read)
 * @param query - Search query object
 * @returns Array of IMAP search attributes
 * @throws {Error} When required server extensions are not available
 *
 * @example
 * // Simple search for unseen messages from a sender
 * searchCompiler(connection, {
 *   unseen: true,
 *   from: 'sender@example.com'
 * });
 *
 * @example
 * // Complex OR search with date range
 * searchCompiler(connection, {
 *   or: [
 *     { from: 'alice@example.com' },
 *     { from: 'bob@example.com' }
 *   ],
 *   since: new Date('2024-01-01')
 * });
 */
export const searchCompiler = (connection: ImapFlow, query: SearchObject): SearchAttribute[] => {
    const attributes: SearchAttribute[] = [];

    /**
     * Recursively walks through the query object and builds IMAP attributes.
     * @param params - Query parameters to process
     */
    const walk = (params: { [key: string]: any }): void => {
        // Compiles one NOT or OR operand, which the caller has already put its operator in
        // front of. An operand with several keys is wrapped in a sub-array so the IMAP compiler
        // emits parentheses around it, as the operator takes a single search-key
        // (RFC 3501 Section 6.4.4). An operand that compiles to nothing (an invalid date, an
        // empty object, ...) is refused: the operator would otherwise bind to whatever
        // criterion follows it and invert or widen the search.
        let walkOperand = (operator: string, obj: unknown): void => {
            let startIdx = attributes.length;
            if (obj && typeof obj === 'object') {
                walk(obj);
            }
            if (attributes.length === startIdx) {
                fail('InvalidSearchQuery', `Search operand for ${operator} does not include any usable search criteria`);
            }
            if (Object.keys(obj as object).length > 1) {
                let subAttrs = attributes.splice(startIdx);
                attributes.push(subAttrs);
            }
        };

        Object.keys(params || {}).forEach(term => {
            switch (term.toUpperCase()) {
                // Custom sequence range support (non-standard)
                case 'SEQ':
                    {
                        // Passed through as a SEQUENCE token: the compiler validates the
                        // set grammar and throws a coded error. An invalid value used to
                        // be dropped silently here, which turned a bad filter into an
                        // unrestricted search that matched every message.
                        let value = params[term] || params[term] === 0 ? toSequenceValue(params[term]) : '';
                        if (value) {
                            attributes.push({ type: 'SEQUENCE', value });
                        }
                    }
                    break;

                // Boolean flags that support UN- prefixing
                case 'ANSWERED':
                case 'DELETED':
                case 'DRAFT':
                case 'FLAGGED':
                case 'SEEN':
                case 'UNANSWERED':
                case 'UNDELETED':
                case 'UNDRAFT':
                case 'UNFLAGGED':
                case 'UNSEEN':
                    // toggles UN-prefix for falsy values
                    setBoolOpt(attributes, term, !!params[term]);
                    break;

                // Simple boolean flags without UN- support
                case 'ALL':
                    if (params[term]) {
                        setBoolOpt(attributes, term, true);
                    }
                    break;

                case 'NEW':
                case 'OLD':
                case 'RECENT':
                    if (params[term]) {
                        // The \Recent flag and the NEW/OLD/RECENT search keys were
                        // removed in IMAP4rev2 (RFC 9051) - a rev2 session would
                        // reject the whole search with a tagged BAD, so fail with a
                        // descriptive error instead
                        if (isRev2Active(connection)) {
                            fail('MissingServerExtension', `The "${term.toLowerCase()}" search key does not exist in IMAP4rev2`);
                        }
                        setBoolOpt(attributes, term, true);
                    }
                    break;

                // Numeric comparisons
                case 'LARGER':
                case 'SMALLER':
                case 'MODSEQ':
                    if (params[term]) {
                        setOpt(attributes, term, params[term]);
                    }
                    break;

                // Text search fields - check for Unicode
                case 'BCC':
                case 'BODY':
                case 'CC':
                case 'FROM':
                case 'SUBJECT':
                case 'TEXT':
                case 'TO':
                    if (params[term]) {
                        setOpt(attributes, term, params[term]);
                    }
                    break;

                // UID sequences. The key stays an ATOM and only the value is a
                // SEQUENCE token, so the compiler validates the sequence set
                // itself rather than the "UID" keyword in front of it.
                case 'UID':
                    if (params[term]) {
                        attributes.push({ type: 'ATOM', value: 'UID' });
                        attributes.push({ type: 'SEQUENCE', value: toSequenceValue(params[term]) });
                    }
                    break;

                // Email ID support (OBJECTID or Gmail extension)
                case 'EMAILID':
                    if (connection.capabilities.has('OBJECTID')) {
                        setOpt(attributes, 'EMAILID', params[term]);
                    } else if (connection.capabilities.has('X-GM-EXT-1')) {
                        // Fallback to Gmail message ID
                        setOpt(attributes, 'X-GM-MSGID', params[term]);
                    } else if (params[term]) {
                        // Dropping the criterion would widen the search to every message
                        // matching the rest of the query, which a delete or move acts on
                        fail('MissingServerExtension', 'Server does not support OBJECTID or X-GM-EXT-1 extension required for EMAILID');
                    }
                    break;

                // Thread ID support (OBJECTID or Gmail extension)
                case 'THREADID':
                    if (connection.capabilities.has('OBJECTID')) {
                        setOpt(attributes, 'THREADID', params[term]);
                    } else if (connection.capabilities.has('X-GM-EXT-1')) {
                        // Fallback to Gmail thread ID
                        setOpt(attributes, 'X-GM-THRID', params[term]);
                    } else if (params[term]) {
                        // Dropping the criterion would widen the search to every message
                        // matching the rest of the query, which a delete or move acts on
                        fail('MissingServerExtension', 'Server does not support OBJECTID or X-GM-EXT-1 extension required for THREADID');
                    }
                    break;

                // Gmail raw search
                case 'GMRAW':
                case 'GMAILRAW': // alias for GMRAW
                    if (connection.capabilities.has('X-GM-EXT-1')) {
                        setOpt(attributes, 'X-GM-RAW', params[term]);
                    } else {
                        fail('MissingServerExtension', 'Server does not support X-GM-EXT-1 extension required for X-GM-RAW');
                    }
                    break;

                // Gmail label search. Compiles { has, not } into an X-GM-RAW "label:"/"-label:" query
                // since Gmail labels are not a native IMAP SEARCH key. Gmail-only (X-GM-EXT-1).
                case 'LABELS': {
                    let labelQuery = params[term];
                    if (!labelQuery || typeof labelQuery !== 'object') {
                        break;
                    }

                    // Collapse whitespace/quotes and quote multi-word names so they survive as a single token
                    let formatLabel = (name: unknown): string => {
                        let label = (name || '')
                            .toString()
                            .replace(/[\s"]+/g, ' ')
                            .trim();
                        return label.indexOf(' ') >= 0 ? `"${label}"` : label;
                    };

                    let rawParts: string[] = [];
                    for (let name of ([] as unknown[]).concat(labelQuery.has || [])) {
                        if (name) {
                            rawParts.push(`label:${formatLabel(name)}`);
                        }
                    }
                    for (let name of ([] as unknown[]).concat(labelQuery.not || [])) {
                        if (name) {
                            rawParts.push(`-label:${formatLabel(name)}`);
                        }
                    }

                    // Empty filter is a no-op on any server (do not require the extension)
                    if (!rawParts.length) {
                        break;
                    }

                    if (!connection.capabilities.has('X-GM-EXT-1')) {
                        fail('MissingServerExtension', 'Server does not support X-GM-EXT-1 extension required for label search');
                    }

                    let rawQuery = rawParts.join(' ');
                    setOpt(attributes, 'X-GM-RAW', rawQuery);
                    break;
                }

                // Date searches with WITHIN extension support
                case 'BEFORE':
                case 'SINCE':
                    {
                        // Normalize above the capability check so the WITHIN shortcut
                        // and the standard path agree on what counts as a usable date
                        let value = toValidDate(params[term]);
                        if (!value) {
                            break;
                        }

                        // Use WITHIN extension for better timezone handling if available
                        if (connection.capabilities.has('WITHIN')) {
                            // Convert to seconds ago from now
                            const now = Date.now();
                            const withinSeconds = Math.round(Math.max(0, now - value.getTime()) / 1000);
                            const withinKeyword = term.toUpperCase() === 'BEFORE' ? 'OLDER' : 'YOUNGER';
                            setOpt(attributes, withinKeyword, withinSeconds.toString());
                            break;
                        }

                        // Fallback to standard date search
                        processDateField(attributes, term, value);
                    }
                    break;

                // Standard date searches
                case 'ON':
                case 'SENTBEFORE':
                case 'SENTON':
                case 'SENTSINCE':
                    processDateField(attributes, term, params[term]);
                    break;

                // Keyword/flag searches
                case 'KEYWORD':
                case 'UNKEYWORD':
                    {
                        let flag = formatFlag(params[term]);
                        // Compiled even when the mailbox does not allow the keyword: the
                        // correct answer is then the empty set, which dropping the
                        // criterion would turn into every message matching the rest
                        if (flag) {
                            setOpt(attributes, term, flag);
                        }
                    }
                    break;

                // Header field searches
                case 'HEADER':
                    if (params[term] && typeof params[term] === 'object') {
                        Object.keys(params[term]).forEach(header => {
                            let value = params[term][header];

                            // Allow boolean true to search for header existence
                            if (value === true) {
                                value = '';
                            }

                            // Skip non-string values (after true->'' conversion)
                            if (typeof value !== 'string') {
                                return;
                            }

                            setOpt(attributes, term, [header.toUpperCase().trim(), value]);
                        });
                    }
                    break;

                // NOT operator
                case 'NOT':
                    if (params[term] && typeof params[term] === 'object') {
                        attributes.push({ type: 'ATOM', value: 'NOT' });
                        walkOperand('NOT', params[term]);
                    }
                    break;

                // OR operator - complex logic for building OR trees
                case 'OR':
                    {
                        if (!params[term] || !Array.isArray(params[term]) || !params[term].length) {
                            break;
                        }

                        // Single element - just process it directly
                        if (params[term].length === 1) {
                            if (typeof params[term][0] === 'object' && params[term][0]) {
                                walk(params[term][0]);
                            }
                            break;
                        }

                        /**
                         * Generates a binary tree structure for OR operations.
                         * IMAP OR takes exactly 2 operands, so we need to nest them.
                         *
                         * @param list - List of conditions to OR together
                         * @returns Binary tree structure
                         */
                        let genOrTree = (list: any[]): any => {
                            let groups: any[] = [];

                            // Group items in pairs
                            for (let i = 0; i + 1 < list.length; i += 2) {
                                groups.push([list[i], list[i + 1]]);
                            }

                            // Handle odd number of items
                            if (list.length % 2) {
                                let group: any[] = [list[list.length - 1]];
                                while (group.length === 1 && Array.isArray(group[0])) {
                                    group = group[0];
                                }

                                groups.push(group);
                            }

                            // Recursively group until we have a binary tree
                            while (groups.length > 2) {
                                groups = genOrTree(groups);
                            }

                            // Flatten single-element arrays
                            while (groups.length === 1 && Array.isArray(groups[0])) {
                                groups = groups[0];
                            }

                            return groups;
                        };

                        /**
                         * Walks the OR tree and generates IMAP commands.
                         * @param entry - Tree node to process
                         */
                        let walkOrTree = (entry: any): void => {
                            if (Array.isArray(entry)) {
                                if (entry.length > 1) {
                                    attributes.push({ type: 'ATOM', value: 'OR' });
                                }
                                entry.forEach(walkOrTree);
                                return;
                            }
                            walkOperand('OR', entry);
                        };

                        walkOrTree(genOrTree(params[term]));
                    }
                    break;
            }
        });
    };

    // Process the query
    walk(query);

    // If we encountered Unicode strings and UTF-8 is not already accepted,
    // prepend CHARSET UTF-8 to the search command
    if (!connection.enabled.has('UTF8=ACCEPT') && hasLiteral(attributes)) {
        attributes.unshift({ type: 'ATOM', value: 'UTF-8' });
        attributes.unshift({ type: 'ATOM', value: 'CHARSET' });
    }

    return attributes;
};
