'use strict';

const imapFormalSyntax = require('./imap-formal-syntax');
const { ParserInstance } = require('./parser-instance');

module.exports = async (command, options) => {
    options = options || {};

    const parser = new ParserInstance(command, options);
    const response = {};

    response.tag = await parser.getTag();
    await parser.getSpace();
    response.command = await parser.getCommand();

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
