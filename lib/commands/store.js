'use strict';

const { getStatusCode, formatFlag, canUseFlag, getErrorText } = require('../tools.js');

// Updates flags for a message
module.exports = async (connection, range, flags, options) => {
    if (connection.state !== connection.states.SELECTED || !range || (options.useLabels && !connection.capabilities.has('X-GM-EXT-1'))) {
        // nothing to do here
        return false;
    }

    options = options || {};
    let operation;

    operation = 'FLAGS';

    if (options.useLabels) {
        operation = 'X-GM-LABELS';
    } else if (options.silent) {
        operation = `${operation}.SILENT`;
    }

    switch ((options.operation || '').toLowerCase()) {
        case 'set':
            // do nothing, keep operation value as is
            break;
        case 'remove':
            operation = `-${operation}`;
            break;
        case 'add':
        default:
            operation = `+${operation}`;
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

    let attributes = [{ type: 'SEQUENCE', value: range }, { type: 'ATOM', value: operation }, flags.map(flag => ({ type: 'ATOM', value: flag }))];

    if (options.unchangedSince && connection.enabled.has('CONDSTORE') && !connection.mailbox.noModseq) {
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
        err.response = await getErrorText(err.response);

        connection.log.warn({ err, cid: connection.id });
        return false;
    }
};
