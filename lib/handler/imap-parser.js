'use strict';

const imapFormalSyntax = require('./imap-formal-syntax');
const { ParserInstance } = require('./parser-instance');

module.exports = async (command, options) => {
    options = options || {};

    let nullBytesRemoved = 0;

    // special case with a buggy IMAP server where responses are padded with zero bytes
    if (command[0] === 0) {
        // find the first non null byte and trim
        for (let i = 0; i < command.length; i++) {
            if (command[i] !== 0) {
                // trim to here
                command = command.slice(i);
                nullBytesRemoved = i;
                break;
            }
        }
    }

    const parser = new ParserInstance(command, options);
    const response = {};

    response.tag = await parser.getTag();
    await parser.getSpace();
    response.command = await parser.getCommand();

    if (nullBytesRemoved) {
        response.nullBytesRemoved = nullBytesRemoved;
    }

    if (['UID', 'AUTHENTICATE'].indexOf((response.command || '').toUpperCase()) >= 0) {
        await parser.getSpace();
        response.command += ' ' + (await parser.getElement(imapFormalSyntax.command()));
    }

    if (parser.remainder.trim().length) {
        await parser.getSpace();
        response.attributes = await parser.getAttributes();
    }

    if (parser.humanReadable) {
        response.attributes = (response.attributes || []).concat({
            type: 'TEXT',
            value: parser.humanReadable
        });
    }

    return response;
};
