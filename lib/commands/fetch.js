'use strict';

const { formatMessageResponse } = require('../tools');

// Fetches emails from server
module.exports = async (connection, range, query, options) => {
    if (connection.state !== connection.states.SELECTED || !range) {
        // nothing to do here
        return;
    }

    options = options || {};

    let mailbox = connection.mailbox;

    const commandKey = connection.capabilities.has('BINARY') && options.binary && !connection.disableBinary ? 'BINARY' : 'BODY';

    let retryCount = 0;
    while (retryCount < 4) {
        let messages = {
            count: 0,
            list: []
        };

        let response;
        try {
            let attributes = [{ type: 'SEQUENCE', value: (range || '*').toString() }];

            let queryStructure = [];

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

            ['all', 'fast', 'full', 'uid', 'flags', 'bodyStructure', 'envelope', 'internalDate'].forEach(key => {
                if (query[key]) {
                    queryStructure.push({ type: 'ATOM', value: key.toUpperCase() });
                }
            });

            if (query.size) {
                queryStructure.push({ type: 'ATOM', value: 'RFC822.SIZE' });
            }

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

            // if possible, always request for unique email id
            if (connection.capabilities.has('OBJECTID')) {
                queryStructure.push({ type: 'ATOM', value: 'EMAILID' });
            } else if (connection.capabilities.has('X-GM-EXT-1')) {
                queryStructure.push({ type: 'ATOM', value: 'X-GM-MSGID' });
            }

            if (query.threadId) {
                if (connection.capabilities.has('OBJECTID')) {
                    queryStructure.push({ type: 'ATOM', value: 'THREADID' });
                } else if (connection.capabilities.has('X-GM-EXT-1')) {
                    queryStructure.push({ type: 'ATOM', value: 'X-GM-THRID' });
                }
            }

            if (query.labels) {
                if (connection.capabilities.has('X-GM-EXT-1')) {
                    queryStructure.push({ type: 'ATOM', value: 'X-GM-LABELS' });
                }
            }

            // always ask for modseq if possible
            if (connection.enabled.has('CONDSTORE') && !mailbox.noModseq) {
                queryStructure.push({ type: 'ATOM', value: 'MODSEQ' });
            }

            // always make sure to include UID in the request as well even though server might auto-add it itself
            if (!query.uid) {
                queryStructure.push({ type: 'ATOM', value: 'UID' });
            }

            if (query.headers) {
                if (Array.isArray(query.headers)) {
                    setBodyPeek([{ type: 'ATOM', value: 'HEADER.FIELDS' }, query.headers.map(header => ({ type: 'ATOM', value: header }))]);
                } else {
                    setBodyPeek({ type: 'ATOM', value: 'HEADER' });
                }
            }

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

            if (queryStructure.length === 1) {
                queryStructure = queryStructure.pop();
            }

            attributes.push(queryStructure);

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
                // retrying
                connection.log.warn({
                    msg: 'Retrying throttled request',
                    cid: connection.id,
                    code: err.code,
                    response: err.responseText,
                    throttleReset: err.throttleReset,
                    retryCount
                });
                retryCount++;
                continue;
            }

            connection.log.warn({ err, cid: connection.id });
            return false;
        }
    }
};
