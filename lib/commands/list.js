'use strict';

const { normalizePath } = require('../tools.js');
const utf7 = require('utf7').imap;
const { specialUse } = require('../special-use');

// Lists mailboxes from server
module.exports = async (connection, reference, mailbox) => {
    let listCommand = connection.capabilities.has('XLIST') && !connection.capabilities.has('SPECIAL-USE') ? 'XLIST' : 'LIST';

    let response;
    try {
        let flagsSeen = new Set();
        let entries = [];
        response = await connection.exec(listCommand, [normalizePath(connection, reference || ''), normalizePath(connection, mailbox || '', true)], {
            untagged: {
                [listCommand]: async untagged => {
                    if (!untagged.attributes || !untagged.attributes.length) {
                        return;
                    }

                    let entry = {
                        path: (untagged.attributes[2] && untagged.attributes[2].value) || '',
                        flags: new Set(untagged.attributes[0].map(entry => entry.value)),
                        delimiter: (untagged.attributes[1] && untagged.attributes[1].value) || connection.namespace.prefix,
                        listed: true
                    };

                    if (listCommand === 'XLIST' && entry.flags.has('\\Inbox')) {
                        // XLIST specific flag, ignore
                        entry.flags.delete('\\Inbox');
                        if (entry.path !== 'INBOX') {
                            // XLIST may use localised inbox name
                            entry.specialUse = '\\Inbox';
                        }
                    }

                    if (entry.path.toUpperCase() === 'INBOX') {
                        entry.specialUse = '\\Inbox';
                    }

                    if (entry.path.charAt(0) === entry.delimiter) {
                        entry.path = entry.path.slice(1);
                    }

                    entry.parent = entry.path.split(entry.delimiter).map(folder => {
                        if (!connection.enabled.has('UTF8=ACCEPT')) {
                            try {
                                return utf7.decode(folder);
                            } catch (err) {
                                return folder; // keep as is
                            }
                        } else {
                            return folder; // keep as is
                        }
                    });

                    entry.path = normalizePath(connection, entry.path);
                    entry.name = entry.parent.pop();

                    let specialUseFlag = specialUse(connection.capabilities.has('XLIST') || connection.capabilities.has('SPECIAL-USE'), entry);
                    if (specialUseFlag && !flagsSeen.has(specialUseFlag)) {
                        entry.specialUse = specialUseFlag;
                    }

                    entries.push(entry);
                }
            }
        });
        response.next();

        response = await connection.exec('LSUB', [normalizePath(connection, reference || ''), normalizePath(connection, mailbox || '', true)], {
            untagged: {
                LSUB: async untagged => {
                    if (!untagged.attributes || !untagged.attributes.length) {
                        return;
                    }

                    let entry = {
                        flags: new Set(untagged.attributes[0].map(entry => entry.value)),
                        delimiter: (untagged.attributes[1] && untagged.attributes[1].value) || connection.namespace.prefix,
                        path: (untagged.attributes[2] && untagged.attributes[2].value) || '',
                        subscribed: true
                    };

                    if (entry.path.toUpperCase() === 'INBOX') {
                        entry.specialUse = '\\Inbox';
                    }

                    if (entry.path.charAt(0) === entry.delimiter) {
                        entry.path = entry.path.slice(1);
                    }

                    entry.parent = entry.path.split(entry.delimiter).map(folder => {
                        if (!connection.enabled.has('UTF8=ACCEPT')) {
                            try {
                                return utf7.decode(folder);
                            } catch (err) {
                                return folder; // keep as is
                            }
                        } else {
                            return folder; // keep as is
                        }
                    });

                    entry.name = entry.parent.pop();

                    let existing = entries.find(existing => existing.path === entry.path);
                    if (existing) {
                        existing.subscribed = true;
                        entry.flags.forEach(flag => existing.flags.add(flag));
                    } else {
                        let specialUseFlag = specialUse(connection.capabilities.has('XLIST') || connection.capabilities.has('SPECIAL-USE'), entry);
                        if (specialUseFlag && !flagsSeen.has(specialUseFlag)) {
                            entry.specialUse = specialUseFlag;
                        }
                        entries.push(entry);
                    }
                }
            }
        });
        response.next();
        return entries;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
