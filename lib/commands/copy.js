'use strict';

const { getStatusCode, normalizePath, encodePath, expandRange, getErrorText } = require('../tools.js');

// Copies messages from current mailbox to some other mailbox
module.exports = async (connection, range, destination, options) => {
    if (connection.state !== connection.states.SELECTED || !range || !destination) {
        // nothing to do here
        return;
    }

    options = options || {};
    destination = normalizePath(connection, destination);

    let attributes = [
        { type: 'SEQUENCE', value: range },
        { type: 'ATOM', value: encodePath(connection, destination) }
    ];

    let response;
    try {
        response = await connection.exec(options.uid ? 'UID COPY' : 'COPY', attributes);
        response.next();

        let map = { path: connection.mailbox.path, destination };
        let section = response.response.attributes && response.response.attributes[0] && response.response.attributes[0].section;
        let responseCode = section && section.length && section[0] && typeof section[0].value === 'string' ? section[0].value : '';
        switch (responseCode) {
            case 'COPYUID':
                {
                    let uidValidity = section[1] && typeof section[1].value === 'string' && !isNaN(section[1].value) ? BigInt(section[1].value) : false;
                    if (uidValidity) {
                        map.uidValidity = uidValidity;
                    }

                    let sourceUids = section[2] && typeof section[2].value === 'string' ? expandRange(section[2].value) : false;
                    let destinationUids = section[3] && typeof section[3].value === 'string' ? expandRange(section[3].value) : false;
                    if (sourceUids && destinationUids && sourceUids.length === destinationUids.length) {
                        map.uidMap = new Map(sourceUids.map((uid, i) => [uid, destinationUids[i]]));
                    }
                }
                break;
        }

        return map;
    } catch (err) {
        let errorCode = getStatusCode(err.response);
        if (errorCode) {
            err.serverResponseCode = errorCode;
        }
        err.response = await getErrorText(err.response);

        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
