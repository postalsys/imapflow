'use strict';

const { encodePath, normalizePath, getStatusCode, getErrorText } = require('../tools.js');

// Creates a new mailbox
module.exports = async (connection, path) => {
    if (![connection.states.AUTHENTICATED, connection.states.SELECTED].includes(connection.state)) {
        // nothing to do here
        return;
    }

    path = normalizePath(connection, path);

    let response;
    try {
        let map = {
            path
        };
        response = await connection.exec('CREATE', [{ type: 'ATOM', value: encodePath(connection, path) }]);

        let section =
            response.response.attributes &&
            response.response.attributes[0] &&
            response.response.attributes[0].section &&
            response.response.attributes[0].section.length
                ? response.response.attributes[0].section
                : false;

        if (section) {
            let key;
            section.forEach((attribute, i) => {
                if (i % 2 === 0) {
                    key = attribute && typeof attribute.value === 'string' ? attribute.value : false;
                    return;
                }

                if (!key) {
                    return;
                }

                let value;
                switch (key.toLowerCase()) {
                    case 'mailboxid':
                        key = 'mailboxId';
                        value = Array.isArray(attribute) && attribute[0] && typeof attribute[0].value === 'string' ? attribute[0].value : false;
                        break;
                }

                if (key && value) {
                    map[key] = value;
                }
            });
        }

        map.created = true;
        response.next();

        //make sure we are subscribed to the new folder as well
        await connection.run('SUBSCRIBE', path);

        return map;
    } catch (err) {
        let errorCode = getStatusCode(err.response);
        if (errorCode) {
            err.serverResponseCode = errorCode;
        }
        err.response = await getErrorText(err.response);

        switch (errorCode) {
            case 'ALREADYEXISTS':
                // no need to do anything, mailbox already exists
                return {
                    path,
                    created: false
                };
        }

        if (errorCode) {
            err.serverResponseCode = errorCode;
        }

        connection.log.warn({ err, cid: connection.id });
        throw err;
    }
};
