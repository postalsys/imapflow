'use strict';

const { formatMessageResponse } = require('../tools');

/**
 * Fetches emails from the server.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {string} range - Message sequence number or UID range
 * @param {Object} query - Fetch query specifying which data to retrieve (e.g., flags, envelope, bodyStructure, headers, source, bodyParts)
 * @param {Object} [options] - Fetch options
 * @param {boolean} [options.uid] - If true, use UID FETCH instead of FETCH
 * @param {boolean} [options.binary] - If true, use BINARY fetch when available
 * @param {string} [options.changedSince] - Only fetch messages changed since this modseq value
 * @param {Function} [options.onUntaggedFetch] - Callback for processing each fetched message individually
 * @returns {Promise<{count: number, list: Object[]}|undefined>} Object with message count and list, or undefined if not in SELECTED state
 */
module.exports = async (connection, range, query, options) => {
    if (connection.state !== connection.states.SELECTED || !range) {
        // nothing to do here
        return;
    }

    options = options || {};

    let mailbox = connection.mailbox;

    // Use BINARY extension for fetching if supported and requested, otherwise fall back to BODY
    const commandKey = connection.capabilities.has('BINARY') && options.binary && !connection.disableBinary ? 'BINARY' : 'BODY';

    // Retry logic for ETHROTTLE errors (server rate limiting) with exponential backoff
    let retryCount = 0;
    const maxRetries = 4;
    const baseDelay = 1000; // Start with 1 second delay

    while (retryCount < maxRetries) {
        let messages = {
            count: 0,
            list: []
        };

        let response;
        try {
            let attributes = [{ type: 'SEQUENCE', value: (range || '*').toString() }];

            let queryStructure = [];

            // Helper to build BODY.PEEK[section]<partial> or BINARY.PEEK[section]<partial> atoms.
            // PEEK avoids marking messages as \Seen. Section identifies what to fetch (HEADER, specific part, etc.)
            // Partial is an optional byte range [start, maxLength].
            let setBodyPeek = (attributes, partial) => {
                let bodyPeek = {
                    type: 'ATOM',
                    value: `${commandKey}.PEEK`,
                    section: [],
                    partial
                };

                if (Array.isArray(attributes)) {
                    attributes.forEach(attribute => {
                        bodyPeek.section.push(attribute);
                    });
                } else if (attributes) {
                    bodyPeek.section.push(attributes);
                }

                queryStructure.push(bodyPeek);
            };

            // IMAP fetch macros (ALL, FAST, FULL) and standard data items map directly to IMAP atoms
            ['all', 'fast', 'full', 'uid', 'flags', 'bodyStructure', 'envelope', 'internalDate'].forEach(key => {
                if (query[key]) {
                    queryStructure.push({ type: 'ATOM', value: key.toUpperCase() });
                }
            });

            if (query.size) {
                queryStructure.push({ type: 'ATOM', value: 'RFC822.SIZE' });
            }

            // Fetch full message source, optionally with byte range (start/maxLength)
            if (query.source) {
                let partial;
                if (typeof query.source === 'object' && (query.source.start || query.source.maxLength)) {
                    partial = [Number(query.source.start) || 0];
                    if (query.source.maxLength && !isNaN(query.source.maxLength)) {
                        partial.push(Number(query.source.maxLength));
                    }
                }
                queryStructure.push({ type: 'ATOM', value: `${commandKey}.PEEK`, section: [], partial });
            }

            // Always request a unique email ID for message deduplication.
            // Prefer OBJECTID (RFC 8474) over Gmail's X-GM-MSGID extension.
            if (connection.capabilities.has('OBJECTID')) {
                queryStructure.push({ type: 'ATOM', value: 'EMAILID' });
            } else if (connection.capabilities.has('X-GM-EXT-1')) {
                queryStructure.push({ type: 'ATOM', value: 'X-GM-MSGID' });
            }

            // Thread ID: OBJECTID's THREADID or Gmail's X-GM-THRID
            if (query.threadId) {
                if (connection.capabilities.has('OBJECTID')) {
                    queryStructure.push({ type: 'ATOM', value: 'THREADID' });
                } else if (connection.capabilities.has('X-GM-EXT-1')) {
                    queryStructure.push({ type: 'ATOM', value: 'X-GM-THRID' });
                }
            }

            // Gmail labels are only available with X-GM-EXT-1 extension
            if (query.labels) {
                if (connection.capabilities.has('X-GM-EXT-1')) {
                    queryStructure.push({ type: 'ATOM', value: 'X-GM-LABELS' });
                }
            }

            // always ask for modseq if possible
            if (connection.enabled.has('CONDSTORE') && !mailbox.noModseq) {
                queryStructure.push({ type: 'ATOM', value: 'MODSEQ' });
            }

            // Always include UID in the response even if not explicitly requested,
            // since we use it internally for message identification and tracking
            if (!query.uid) {
                queryStructure.push({ type: 'ATOM', value: 'UID' });
            }

            // Headers: fetch all headers or only specific ones via HEADER.FIELDS
            if (query.headers) {
                if (Array.isArray(query.headers)) {
                    setBodyPeek([{ type: 'ATOM', value: 'HEADER.FIELDS' }, query.headers.map(header => ({ type: 'ATOM', value: header }))]);
                } else {
                    setBodyPeek({ type: 'ATOM', value: 'HEADER' });
                }
            }

            // Fetch specific body parts by MIME part number (e.g., "1", "1.2", "2.MIME")
            // Each part can optionally include a byte range (start/maxLength)
            if (query.bodyParts && query.bodyParts.length) {
                query.bodyParts.forEach(part => {
                    if (!part) {
                        return;
                    }
                    let key;
                    let partial;
                    if (typeof part === 'object') {
                        if (!part.key || typeof part.key !== 'string') {
                            return;
                        }
                        key = part.key.toUpperCase();
                        if (part.start || part.maxLength) {
                            partial = [Number(part.start) || 0];
                            if (part.maxLength && !isNaN(part.maxLength)) {
                                partial.push(Number(part.maxLength));
                            }
                        }
                    } else if (typeof part === 'string') {
                        key = part.toUpperCase();
                    } else {
                        return;
                    }

                    setBodyPeek({ type: 'ATOM', value: key }, partial);
                });
            }

            // IMAP requires a single item to not be wrapped in parentheses, but
            // multiple items must be in a list. If only one item, unwrap the array.
            if (queryStructure.length === 1) {
                queryStructure = queryStructure.pop();
            }

            attributes.push(queryStructure);

            // CONDSTORE extension: only fetch messages with modseq higher than the given value.
            // QRESYNC adds VANISHED to also get expunged UIDs since last sync.
            if (options.changedSince && connection.enabled.has('CONDSTORE') && !mailbox.noModseq) {
                let changedSinceArgs = [
                    {
                        type: 'ATOM',
                        value: 'CHANGEDSINCE'
                    },
                    {
                        type: 'ATOM',
                        value: options.changedSince.toString()
                    }
                ];

                if (options.uid && connection.enabled.has('QRESYNC')) {
                    changedSinceArgs.push({
                        type: 'ATOM',
                        value: 'VANISHED'
                    });
                }

                attributes.push(changedSinceArgs);
            }

            response = await connection.exec(options.uid ? 'UID FETCH' : 'FETCH', attributes, {
                untagged: {
                    // Each matching message triggers an untagged FETCH response.
                    // If onUntaggedFetch callback is provided, stream messages to it one by one
                    // (useful for large result sets). Otherwise, collect all into messages.list.
                    FETCH: async untagged => {
                        messages.count++;
                        let formatted = await formatMessageResponse(untagged, mailbox);
                        if (typeof options.onUntaggedFetch === 'function') {
                            await new Promise((resolve, reject) => {
                                options.onUntaggedFetch(formatted, err => {
                                    if (err) {
                                        reject(err);
                                    } else {
                                        resolve();
                                    }
                                });
                            });
                        } else {
                            messages.list.push(formatted);
                        }
                    }
                }
            });

            response.next();
            return messages;
        } catch (err) {
            if (err.code === 'ETHROTTLE') {
                // Server returned a throttle error (rate limiting). Retry with exponential backoff.
                // Delay doubles each retry: 1s, 2s, 4s, 8s (capped at 30s).
                // If server provides a throttleReset hint, use that if longer.
                const backoffDelay = Math.min(baseDelay * Math.pow(2, retryCount), 30000); // Cap at 30 seconds

                // Use throttle reset time if provided and longer than backoff
                const delay = err.throttleReset && err.throttleReset > backoffDelay ? err.throttleReset : backoffDelay;

                connection.log.warn({
                    msg: 'Retrying throttled request with exponential backoff',
                    cid: connection.id,
                    code: err.code,
                    response: err.responseText,
                    throttleReset: err.throttleReset,
                    retryCount,
                    delayMs: delay
                });

                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, delay));

                retryCount++;
                continue;
            }

            connection.log.warn({ err, cid: connection.id });
            throw err;
        }
    }
};
