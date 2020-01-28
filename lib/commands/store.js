'use strict';

const { getStatusCode, formatFlag, canUseFlag } = require('../tools.js');

// Updates flags for a message
module.exports = async (connection, range, flags, options) => {
    if (connection.state !== connection.states.SELECTED || !range) {
        // nothing to do here
        return;
    }

    options = options || {};
    let operation;

    switch ((options.operation || '').toLowerCase()) {
        case 'set':
            operation = 'FLAGS';
            break;
        case 'remove':
            operation = '-FLAGS';
            break;
        case 'add':
        default:
            operation = '+FLAGS';
            break;
    }

    flags = (Array.isArray(flags) ? flags : [].concat(flags || []))
        .map(flag => {
            flag = formatFlag(flag);

            if (!canUseFlag(connection.mailbox, flag) && operation !== 'remove') {
                // it does not seem that we can set this flag
                return false;
            }

            return flag;
        })
        .filter(flag => flag);

    if (!flags.length && operation !== 'set') {
        // nothing to do here
        return false;
    }

    if (options.silent) {
        operation += '.SILENT';
    }

    let attributes = [{ type: 'SEQUENCE', value: range }, { type: 'ATOM', value: operation }, flags.map(flag => ({ type: 'ATOM', value: flag }))];

    if (options.unchangedSince && connection.enabled.has('CONDSTORE')) {
        attributes.push([
            {
                type: 'ATOM',
                value: 'UNCHANGEDSINCE'
            },
            {
                type: 'ATOM',
                value: options.unchangedSince.toString()
            }
        ]);
    }

    let response;
    try {
        response = await connection.exec(options.uid ? 'UID STORE' : 'STORE', attributes);
        response.next();
        return true;
    } catch (err) {
        let errorCode = getStatusCode(err.response);
        if (errorCode) {
            err.serverResponseCode = errorCode;
        }

        connection.log.error({error: err, cid: connection.id});
        return false;
    }
};
