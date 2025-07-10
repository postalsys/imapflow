/* eslint no-control-regex:0 */

'use strict';

const { formatDate, formatFlag, canUseFlag, isDate } = require('./tools.js');

/**
 * Sets a boolean flag in the IMAP search attributes.
 * Automatically handles UN- prefixing for falsy values.
 *
 * @param {Array} attributes - Array to append the attribute to
 * @param {string} term - The flag name (e.g., 'SEEN', 'DELETED')
 * @param {boolean} value - Whether to set or unset the flag
 * @example
 * setBoolOpt(attributes, 'SEEN', false) // Adds 'UNSEEN'
 * setBoolOpt(attributes, 'UNSEEN', false) // Adds 'SEEN' (removes UN prefix)
 */
let setBoolOpt = (attributes, term, value) => {
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
 * Adds a search option with its value(s) to the attributes array.
 * Handles NOT operations and array values.
 *
 * @param {Array} attributes - Array to append the attribute to
 * @param {string} term - The search term (e.g., 'FROM', 'SUBJECT')
 * @param {*} value - The value for the search term (string, array, or falsy for NOT)
 * @param {string} [type='ATOM'] - The attribute type
 */
let setOpt = (attributes, term, value, type) => {
    type = type || 'ATOM';

    // Handle NOT operations for false or null values
    if (value === false || value === null) {
        attributes.push({ type, value: 'NOT' });
    }

    attributes.push({ type, value: term.toUpperCase() });

    // Handle array values (e.g., multiple UIDs)
    if (Array.isArray(value)) {
        value.forEach(entry => attributes.push({ type, value: (entry || '').toString() }));
    } else {
        attributes.push({ type, value: value.toString() });
    }
};

/**
 * Processes date fields for IMAP search.
 * Converts JavaScript dates to IMAP date format.
 *
 * @param {Array} attributes - Array to append the attribute to
 * @param {string} term - The date search term (e.g., 'BEFORE', 'SINCE')
 * @param {*} value - Date value to format
 */
let processDateField = (attributes, term, value) => {
    if (['BEFORE', 'SENTBEFORE'].includes(term.toUpperCase()) && isDate(value) && value.toISOString().substring(11) !== '00:00:00.000Z') {
        // Set to next day to include current day as well, othwerise BEFORE+AFTER
        // searches for the same day but different time values do not match anything
        value = new Date(value.getTime() + 24 * 3600 * 1000);
    }

    let date = formatDate(value);
    if (!date) {
        return;
    }

    setOpt(attributes, term, date);
};

// Pre-compiled regex for better performance
const UNICODE_PATTERN = /[^\x00-\x7F]/;

/**
 * Checks if a string contains Unicode characters.
 * Used to determine if CHARSET UTF-8 needs to be specified.
 *
 * @param {*} str - String to check
 * @returns {boolean} True if string contains non-ASCII characters
 */
let isUnicodeString = str => {
    if (!str || typeof str !== 'string') {
        return false;
    }

    // Regex test is ~3-5x faster than Buffer.byteLength
    // Matches any character outside ASCII range (0x00-0x7F)
    return UNICODE_PATTERN.test(str);
};

/**
 * Compiles a JavaScript object query into IMAP search command attributes.
 * Supports standard IMAP search criteria and extensions like OBJECTID and Gmail extensions.
 *
 * @param {Object} connection - IMAP connection object
 * @param {Object} connection.capabilities - Set of server capabilities
 * @param {Object} connection.enabled - Set of enabled extensions
 * @param {Object} connection.mailbox - Current mailbox information
 * @param {Set} connection.mailbox.flags - Available flags in the mailbox
 * @param {Object} query - Search query object
 * @returns {Array} Array of IMAP search attributes
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
module.exports.searchCompiler = (connection, query) => {
    const attributes = [];

    // Track if we need to specify UTF-8 charset
    let hasUnicode = false;
    const mailbox = connection.mailbox;

    /**
     * Recursively walks through the query object and builds IMAP attributes.
     * @param {Object} params - Query parameters to process
     */
    const walk = params => {
        Object.keys(params || {}).forEach(term => {
            switch (term.toUpperCase()) {
                // Custom sequence range support (non-standard)
                case 'SEQ':
                    {
                        let value = params[term];
                        if (typeof value === 'number') {
                            value = value.toString();
                        }
                        // Only accept valid sequence strings (no whitespace)
                        if (typeof value === 'string' && /^\S+$/.test(value)) {
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
                case 'NEW':
                case 'OLD':
                case 'RECENT':
                    if (params[term]) {
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
                    if (isUnicodeString(params[term])) {
                        hasUnicode = true;
                    }
                    if (params[term]) {
                        setOpt(attributes, term, params[term]);
                    }
                    break;

                // UID sequences
                case 'UID':
                    if (params[term]) {
                        setOpt(attributes, term, params[term], 'SEQUENCE');
                    }
                    break;

                // Email ID support (OBJECTID or Gmail extension)
                case 'EMAILID':
                    if (connection.capabilities.has('OBJECTID')) {
                        setOpt(attributes, 'EMAILID', params[term]);
                    } else if (connection.capabilities.has('X-GM-EXT-1')) {
                        // Fallback to Gmail message ID
                        setOpt(attributes, 'X-GM-MSGID', params[term]);
                    }
                    break;

                // Thread ID support (OBJECTID or Gmail extension)
                case 'THREADID':
                    if (connection.capabilities.has('OBJECTID')) {
                        setOpt(attributes, 'THREADID', params[term]);
                    } else if (connection.capabilities.has('X-GM-EXT-1')) {
                        // Fallback to Gmail thread ID
                        setOpt(attributes, 'X-GM-THRID', params[term]);
                    }
                    break;

                // Gmail raw search
                case 'GMRAW':
                case 'GMAILRAW': // alias for GMRAW
                    if (connection.capabilities.has('X-GM-EXT-1')) {
                        if (isUnicodeString(params[term])) {
                            hasUnicode = true;
                        }
                        setOpt(attributes, 'X-GM-RAW', params[term]);
                    } else {
                        let error = new Error('Server does not support X-GM-EXT-1 extension required for X-GM-RAW');
                        error.code = 'MissingServerExtension';
                        throw error;
                    }
                    break;

                // Date searches with WITHIN extension support
                case 'BEFORE':
                case 'SINCE':
                    {
                        // Use WITHIN extension for better timezone handling if available
                        if (connection.capabilities.has('WITHIN') && isDate(params[term])) {
                            // Convert to seconds ago from now
                            const now = Date.now();
                            const withinSeconds = Math.round(Math.max(0, now - params[term].getTime()) / 1000);
                            let withinKeyword;
                            switch (term.toUpperCase()) {
                                case 'BEFORE':
                                    withinKeyword = 'OLDER';
                                    break;
                                case 'SINCE':
                                    withinKeyword = 'YOUNGER';
                                    break;
                            }
                            setOpt(attributes, withinKeyword, withinSeconds.toString());
                            break;
                        }

                        // Fallback to standard date search
                        processDateField(attributes, term, params[term]);
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
                        // Only add if flag is supported or already exists in mailbox
                        if (canUseFlag(mailbox, flag) || mailbox.flags.has(flag)) {
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

                            if (isUnicodeString(value)) {
                                hasUnicode = true;
                            }

                            setOpt(attributes, term, [header.toUpperCase().trim(), value]);
                        });
                    }
                    break;

                // NOT operator
                case 'NOT':
                    {
                        if (!params[term]) {
                            break;
                        }

                        if (typeof params[term] === 'object') {
                            attributes.push({ type: 'ATOM', value: 'NOT' });
                            // Recursively process NOT conditions
                            walk(params[term]);
                        }
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
                         * @param {Array} list - List of conditions to OR together
                         * @returns {Array} Binary tree structure
                         */
                        let genOrTree = list => {
                            let group = false;
                            let groups = [];

                            // Group items in pairs
                            list.forEach((entry, i) => {
                                if (i % 2 === 0) {
                                    group = [entry];
                                } else {
                                    group.push(entry);
                                    groups.push(group);
                                    group = false;
                                }
                            });

                            // Handle odd number of items
                            if (group && group.length) {
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
                         * @param {Array|Object} entry - Tree node to process
                         */
                        let walkOrTree = entry => {
                            if (Array.isArray(entry)) {
                                // Only add OR for multiple items
                                if (entry.length > 1) {
                                    attributes.push({ type: 'ATOM', value: 'OR' });
                                }
                                entry.forEach(walkOrTree);
                                return;
                            }
                            if (entry && typeof entry === 'object') {
                                walk(entry);
                            }
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
    if (hasUnicode && !connection.enabled.has('UTF8=ACCEPT')) {
        attributes.unshift({ type: 'ATOM', value: 'UTF-8' });
        attributes.unshift({ type: 'ATOM', value: 'CHARSET' });
    }

    return attributes;
};
