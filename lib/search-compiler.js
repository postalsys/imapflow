'use strict';

const { formatDate, formatFlag, canUseFlag } = require('./tools.js');

let setBoolOpt = (attributes, term, value) => {
    if (!value) {
        if (/^un/i.test(term)) {
            term = term.slice(2);
        } else {
            term = 'UN' + term;
        }
    }

    attributes.push({ type: 'ATOM', value: term.toUpperCase() });
};

let setOpt = (attributes, term, value, type) => {
    type = type || 'ATOM';

    if (value === false || value === null) {
        attributes.push({ type, value: 'NOT' });
    }

    attributes.push({ type, value: term.toUpperCase() });

    if (Array.isArray(value)) {
        value.forEach(entry => attributes.push({ type, value: (entry || '').toString() }));
    } else {
        attributes.push({ type, value: value.toString() });
    }
};

let processDateField = (attributes, term, value) => {
    let date = formatDate(value);
    if (!date) {
        return;
    }

    setOpt(attributes, term, date);
};

module.exports.searchCompiler = (connection, query) => {
    const attributes = [];

    const mailbox = connection.mailbox;

    const walk = params => {
        Object.keys(params || {}).forEach(term => {
            switch (term.toUpperCase()) {
                case 'SEQ': // custom key for sequence range
                    {
                        let value = params[term];
                        if (typeof value === 'number') {
                            value = value.toString();
                        }
                        if (typeof value === 'string' && /^\S+$/.test(value)) {
                            attributes.push({ type: 'SEQUENCE', value });
                        }
                    }
                    break;

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

                case 'ALL':
                case 'NEW':
                case 'OLD':
                case 'RECENT':
                    if (params[term]) {
                        setBoolOpt(attributes, term, true);
                    }
                    break;

                case 'BCC':
                case 'BODY':
                case 'CC':
                case 'FROM':
                case 'LARGER':
                case 'SMALLER':
                case 'SUBJECT':
                case 'TEXT':
                case 'TO':
                case 'MODSEQ':
                    if (params[term]) {
                        setOpt(attributes, term, params[term]);
                    }
                    break;

                case 'UID':
                    if (params[term]) {
                        setOpt(attributes, term, params[term], 'SEQUENCE');
                    }
                    break;

                case 'EMAILID':
                    if (connection.capabilities.has('OBJECTID')) {
                        setOpt(attributes, 'EMAILID', params[term]);
                    } else if (connection.capabilities.has('X-GM-EXT-1')) {
                        setOpt(attributes, 'X-GM-MSGID', params[term]);
                    }
                    break;
                case 'THREADID':
                    if (connection.capabilities.has('OBJECTID')) {
                        setOpt(attributes, 'THREADID', params[term]);
                    } else if (connection.capabilities.has('X-GM-EXT-1')) {
                        setOpt(attributes, 'X-GM-THRID', params[term]);
                    }
                    break;
                case 'GMRAW':
                case 'GMAILRAW': // alias for GMRAW
                    if (connection.capabilities.has('X-GM-EXT-1')) {
                        setOpt(attributes, 'X-GM-RAW', params[term]);
                    } else {
                        let error = new Error('Server does not support X-GM-EXT-1 extension required for X-GM-RAW');
                        error.code = 'MissingServerExtension';
                        throw error;
                    }
                    break;

                case 'BEFORE':
                case 'ON':
                case 'SINCE':
                case 'SENTBEFORE':
                case 'SENTON':
                case 'SENTSINCE':
                    processDateField(attributes, term, params[term]);
                    break;

                case 'KEYWORD':
                case 'UNKEYWORD':
                    {
                        let flag = formatFlag(params[term]);
                        if (canUseFlag(mailbox, flag) || mailbox.flags.has(flag)) {
                            setOpt(attributes, term, flag);
                        }
                    }
                    break;

                case 'HEADER':
                    if (params[term] && typeof params[term] === 'object') {
                        Object.keys(params[term]).forEach(header => {
                            let value = params[term][header];
                            if (value === true) {
                                value = '';
                            }

                            if (typeof value !== 'string') {
                                return;
                            }

                            setOpt(attributes, term, [header.toUpperCase().trim(), value]);
                        });
                    }
                    break;

                case 'OR':
                    {
                        if (!params[term] || !Array.isArray(params[term]) || !params[term].length) {
                            break;
                        }

                        if (params[term].length === 1) {
                            if (typeof params[term][0] === 'object' && params[term][0]) {
                                walk(params[term][0]);
                            }
                            break;
                        }

                        // OR values has to be grouped by 2
                        // OR conditional1 conditional2
                        let genOrTree = list => {
                            let group = false;
                            let groups = [];

                            list.forEach((entry, i) => {
                                if (i % 2 === 0) {
                                    group = [entry];
                                } else {
                                    group.push(entry);
                                    groups.push(group);
                                    group = false;
                                }
                            });

                            if (group && group.length) {
                                while (group.length === 1 && Array.isArray(group[0])) {
                                    group = group[0];
                                }

                                groups.push(group);
                            }

                            while (groups.length > 2) {
                                groups = genOrTree(groups);
                            }

                            while (groups.length === 1 && Array.isArray(groups[0])) {
                                groups = groups[0];
                            }

                            return groups;
                        };

                        let walkOrTree = entry => {
                            if (Array.isArray(entry)) {
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

    walk(query);

    return attributes;
};
