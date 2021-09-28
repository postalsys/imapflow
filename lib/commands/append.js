'use strict';

const { getStatusCode, formatFlag, canUseFlag, formatDateTime, normalizePath, comparePaths, getErrorText } = require('../tools.js');

// Appends a message to a mailbox
module.exports = async (connection, destination, content, flags, idate) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state) || !destination) {
        // nothing to do here
        return;
    }

    if (connection.capabilities.has('APPENDLIMIT')) {
        let appendLimit = connection.capabilities.get('APPENDLIMIT');
        if (typeof appendLimit === 'number' && appendLimit < content.length) {
            let err = new Error('Message content too big for APPENDLIMIT=' + appendLimit);
            err.serverResponseCode = 'APPENDLIMIT';
            throw err;
        }
    }

    destination = normalizePath(connection, destination);

    let expectExists = comparePaths(connection, connection.mailbox.path, destination);

    flags = (Array.isArray(flags) ? flags : [].concat(flags || []))
        .map(flag => flag && formatFlag(flag.toString()))
        .filter(flag => flag && canUseFlag(connection.mailbox, flag));

    let attributes = [{ type: 'ATOM', value: destination }];

    idate = idate ? formatDateTime(idate) : false;

    if (flags.length || idate) {
        attributes.push(flags.map(flag => ({ type: 'ATOM', value: flag })));
    }

    if (idate) {
        attributes.push({ type: 'STRING', value: idate }); // force quotes as required by date-time
    }

    attributes.push({ type: 'LITERAL', value: content });

    let map = { destination };
    if (connection.mailbox && connection.mailbox.path) {
        map.path = connection.mailbox.path;
    }

    let response;
    try {
        response = await connection.exec('APPEND', attributes, {
            untagged: expectExists
                ? {
                      EXISTS: async untagged => {
                          map.seq = Number(untagged.command);
                      }
                  }
                : false
        });

        let section = response.response.attributes && response.response.attributes[0] && response.response.attributes[0].section;
        if (section && section.length) {
            let responseCode = section[0] && typeof section[0].value === 'string' ? section[0].value : '';
            switch (responseCode.toUpperCase()) {
                case 'APPENDUID':
                    {
                        let uidValidity = section[1] && typeof section[1].value === 'string' && !isNaN(section[1].value) ? BigInt(section[1].value) : false;
                        let uid = section[2] && typeof section[2].value === 'string' && !isNaN(section[2].value) ? Number(section[2].value) : false;
                        if (uidValidity) {
                            map.uidValidity = uidValidity;
                        }
                        if (uid) {
                            map.uid = uid;
                        }
                    }
                    break;
            }
        }

        response.next();

        if (expectExists && !map.seq) {
            // try to use NOOP to get the new sequence number
            try {
                response = await connection.exec('NOOP', false, {
                    untagged: {
                        EXISTS: async untagged => {
                            map.seq = Number(untagged.command);
                        }
                    },
                    comment: 'Sequence not found from APPEND output'
                });
                response.next();
            } catch (err) {
                connection.log.warn({ err, cid: connection.id });
            }
        }

        if (map.seq && !map.uid) {
            let list = await connection.search({ seq: map.seq }, { uid: true });
            if (list && list.length) {
                map.uid = list[0];
            }
        }

        return map;
    } catch (err) {
        let errorCode = getStatusCode(err.response);
        if (errorCode) {
            err.serverResponseCode = errorCode;
        }
        err.response = await getErrorText(err.response);

        connection.log.warn({ err, cid: connection.id });
        throw err;
    }
};
