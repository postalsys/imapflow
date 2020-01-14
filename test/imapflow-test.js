'use strict';

const { ImapFlow } = require('../lib/imap-flow');

module.exports['Create imapflow instance'] = test => {
    let imapFlow = new ImapFlow();
    test.ok(imapFlow);
    test.done();
};
