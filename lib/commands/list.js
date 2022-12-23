'use strict';

const { decodePath, encodePath, normalizePath } = require('../tools.js');
const { specialUse } = require('../special-use');

// Lists mailboxes from server
module.exports = async (connection, reference, mailbox, options) => {
    options = options || {};

    const FLAG_SORT_ORDER = ['\\Inbox', '\\Flagged', '\\Sent', '\\Drafts', '\\All', '\\Archive', '\\Junk', '\\Trash'];
    const SOURCE_SORT_ORDER = ['user', 'extension', 'name'];

    let listCommand = connection.capabilities.has('XLIST') && !connection.capabilities.has('SPECIAL-USE') ? 'XLIST' : 'LIST';

    let response;
    try {
        let entries = [];

        let statusMap = new Map();
        let returnArgs = [];
        let statusQueryAttributes = [];

        if (options.statusQuery) {
            Object.keys(options.statusQuery || {}).forEach(key => {
                if (!options.statusQuery[key]) {
                    return;
                }

                switch (key.toUpperCase()) {
                    case 'MESSAGES':
                    case 'RECENT':
                    case 'UIDNEXT':
                    case 'UIDVALIDITY':
                    case 'UNSEEN':
                        statusQueryAttributes.push({ type: 'ATOM', value: key.toUpperCase() });
                        break;

                    case 'HIGHESTMODSEQ':
                        if (connection.capabilities.has('CONDSTORE')) {
                            statusQueryAttributes.push({ type: 'ATOM', value: key.toUpperCase() });
                        }
                        break;
                }
            });
        }

        if (listCommand === 'LIST' && connection.capabilities.has('LIST-STATUS') && statusQueryAttributes.length) {
            returnArgs.push({ type: 'ATOM', value: 'STATUS' }, statusQueryAttributes);
            if (connection.capabilities.has('SPECIAL-USE')) {
                returnArgs.push({ type: 'ATOM', value: 'SPECIAL-USE' });
            }
        }

        let specialUseMatches = {};
        let addSpecialUseMatch = (entry, type, source) => {
            if (!specialUseMatches[type]) {
                specialUseMatches[type] = [];
            }
            specialUseMatches[type].push({ entry, source });
        };

        let specialUseHints = {};
        if (options.specialUseHints && typeof options.specialUseHints === 'object') {
            for (let type of Object.keys(options.specialUseHints)) {
                if (['sent', 'junk', 'trash', 'drafts'].includes(type) && options.specialUseHints[type] && typeof options.specialUseHints[type] === 'string') {
                    specialUseHints[normalizePath(connection, options.specialUseHints[type])] = `\\${type.replace(/^./, c => c.toUpperCase())}`;
                }
            }
        }

        let runList = async (reference, mailbox) => {
            const cmdArgs = [encodePath(connection, reference), encodePath(connection, mailbox)];

            if (returnArgs.length) {
                cmdArgs.push({ type: 'ATOM', value: 'RETURN' }, returnArgs);
            }

            response = await connection.exec(listCommand, cmdArgs, {
                untagged: {
                    [listCommand]: async untagged => {
                        if (!untagged.attributes || !untagged.attributes.length) {
                            return;
                        }

                        let entry = {
                            path: normalizePath(connection, decodePath(connection, (untagged.attributes[2] && untagged.attributes[2].value) || '')),
                            pathAsListed: (untagged.attributes[2] && untagged.attributes[2].value) || '',
                            flags: new Set(untagged.attributes[0].map(entry => entry.value)),
                            delimiter: untagged.attributes[1] && untagged.attributes[1].value,
                            listed: true
                        };

                        if (specialUseHints[entry.path]) {
                            addSpecialUseMatch(entry, specialUseHints[entry.path], 'user');
                        }

                        if (listCommand === 'XLIST' && entry.flags.has('\\Inbox')) {
                            // XLIST specific flag, ignore
                            entry.flags.delete('\\Inbox');
                            if (entry.path !== 'INBOX') {
                                // XLIST may use localised inbox name
                                addSpecialUseMatch(entry, '\\Inbox', 'extension');
                            }
                        }

                        if (entry.path.toUpperCase() === 'INBOX') {
                            addSpecialUseMatch(entry, '\\Inbox', 'name');
                        }

                        if (entry.delimiter && entry.path.charAt(0) === entry.delimiter) {
                            entry.path = entry.path.slice(1);
                        }

                        entry.parentPath = entry.delimiter && entry.path ? entry.path.substr(0, entry.path.lastIndexOf(entry.delimiter)) : '';
                        entry.parent = entry.delimiter ? entry.path.split(entry.delimiter) : [entry.path];
                        entry.name = entry.parent.pop();

                        let { flag: specialUseFlag, source: flagSource } = specialUse(
                            connection.capabilities.has('XLIST') || connection.capabilities.has('SPECIAL-USE'),
                            entry
                        );

                        if (specialUseFlag) {
                            addSpecialUseMatch(entry, specialUseFlag, flagSource);
                        }

                        entries.push(entry);
                    },

                    STATUS: async untagged => {
                        let statusPath = normalizePath(connection, decodePath(connection, (untagged.attributes[0] && untagged.attributes[0].value) || ''));
                        let statusList = untagged.attributes && Array.isArray(untagged.attributes[1]) ? untagged.attributes[1] : false;
                        if (!statusList || !statusPath) {
                            return;
                        }

                        let key;

                        let map = { path: statusPath };

                        statusList.forEach((entry, i) => {
                            if (i % 2 === 0) {
                                key = entry && typeof entry.value === 'string' ? entry.value : false;
                                return;
                            }
                            if (!key || !entry || typeof entry.value !== 'string') {
                                return;
                            }
                            let value = false;
                            switch (key.toUpperCase()) {
                                case 'MESSAGES':
                                    key = 'messages';
                                    value = !isNaN(entry.value) ? Number(entry.value) : false;
                                    break;

                                case 'RECENT':
                                    key = 'recent';
                                    value = !isNaN(entry.value) ? Number(entry.value) : false;
                                    break;

                                case 'UIDNEXT':
                                    key = 'uidNext';
                                    value = !isNaN(entry.value) ? Number(entry.value) : false;
                                    break;

                                case 'UIDVALIDITY':
                                    key = 'uidValidity';
                                    value = !isNaN(entry.value) ? BigInt(entry.value) : false;
                                    break;

                                case 'UNSEEN':
                                    key = 'unseen';
                                    value = !isNaN(entry.value) ? Number(entry.value) : false;
                                    break;

                                case 'HIGHESTMODSEQ':
                                    key = 'highestModseq';
                                    value = !isNaN(entry.value) ? BigInt(entry.value) : false;
                                    break;
                            }
                            if (value === false) {
                                return;
                            }

                            map[key] = value;
                        });

                        statusMap.set(statusPath, map);
                    }
                }
            });
            response.next();
        };

        let normalizedReference = normalizePath(connection, reference || '');
        await runList(normalizedReference, normalizePath(connection, mailbox || '', true));

        if (options.listOnly) {
            return entries;
        }

        if (normalizedReference && !specialUseMatches['\\Inbox']) {
            // INBOX was most probably not included in the listing if namespace was used
            await runList('', 'INBOX');
        }

        if (options.statusQuery) {
            for (let entry of entries) {
                if (!entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent')) {
                    if (statusMap.has(entry.path)) {
                        entry.status = statusMap.get(entry.path);
                    } else if (!statusMap.size) {
                        // run STATUS command
                        try {
                            entry.status = await connection.run('STATUS', entry.path, options.statusQuery);
                        } catch (err) {
                            entry.status = { error: err };
                        }
                    }
                }
            }
        }

        response = await connection.exec(
            'LSUB',
            [encodePath(connection, normalizePath(connection, reference || '')), encodePath(connection, normalizePath(connection, mailbox || '', true))],
            {
                untagged: {
                    LSUB: async untagged => {
                        if (!untagged.attributes || !untagged.attributes.length) {
                            return;
                        }

                        let entry = {
                            path: normalizePath(connection, decodePath(connection, (untagged.attributes[2] && untagged.attributes[2].value) || '')),
                            pathAsListed: (untagged.attributes[2] && untagged.attributes[2].value) || '',
                            flags: new Set(untagged.attributes[0].map(entry => entry.value)),
                            delimiter: untagged.attributes[1] && untagged.attributes[1].value,
                            subscribed: true
                        };

                        if (entry.path.toUpperCase() === 'INBOX') {
                            addSpecialUseMatch(entry, '\\Inbox', 'name');
                        }

                        if (entry.delimiter && entry.path.charAt(0) === entry.delimiter) {
                            entry.path = entry.path.slice(1);
                        }

                        entry.parentPath = entry.delimiter && entry.path ? entry.path.substr(0, entry.path.lastIndexOf(entry.delimiter)) : '';
                        entry.parent = entry.delimiter ? entry.path.split(entry.delimiter) : [entry.path];
                        entry.name = entry.parent.pop();

                        let existing = entries.find(existing => existing.path === entry.path);
                        if (existing) {
                            existing.subscribed = true;
                            entry.flags.forEach(flag => existing.flags.add(flag));
                        } else {
                            // ignore non-listed folders
                            /*
                            let specialUseFlag = specialUse(connection.capabilities.has('XLIST') || connection.capabilities.has('SPECIAL-USE'), entry);
                            if (specialUseFlag && !flagsSeen.has(specialUseFlag)) {
                                entry.specialUse = specialUseFlag;
                            }
                            entries.push(entry);
                            */
                        }
                    }
                }
            }
        );
        response.next();

        for (let type of Object.keys(specialUseMatches)) {
            let sortedEntries = specialUseMatches[type].sort((a, b) => {
                let aSource = SOURCE_SORT_ORDER.indexOf(a.source);
                let bSource = SOURCE_SORT_ORDER.indexOf(b.source);
                if (aSource === bSource) {
                    return a.entry.path.localeCompare(b.entry.path);
                }
                return aSource - bSource;
            });

            if (!sortedEntries[0].entry.specialUse) {
                sortedEntries[0].entry.specialUse = type;
                sortedEntries[0].entry.specialUseSource = sortedEntries[0].source;
            }
        }

        let inboxEntry = entries.find(entry => entry.specialUse === '\\Inbox');
        if (inboxEntry && !inboxEntry.subscribed) {
            // override server settings and make INBOX always as subscribed
            inboxEntry.subscribed = true;
        }

        return entries.sort((a, b) => {
            if (a.specialUse && !b.specialUse) {
                return -1;
            }
            if (!a.specialUse && b.specialUse) {
                return 1;
            }
            if (a.specialUse && b.specialUse) {
                return FLAG_SORT_ORDER.indexOf(a.specialUse) - FLAG_SORT_ORDER.indexOf(b.specialUse);
            }

            let aList = [].concat(a.parent).concat(a.name);
            let bList = [].concat(b.parent).concat(b.name);

            for (let i = 0; i < aList.length; i++) {
                let aPart = aList[i];
                let bPart = bList[i];
                if (aPart !== bPart) {
                    return aPart.localeCompare(bPart || '');
                }
            }

            return a.path.localeCompare(b.path);
        });
    } catch (err) {
        connection.log.warn({ msg: 'Failed to list folders', err, cid: connection.id });
        throw err;
    }
};
