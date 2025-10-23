'use strict';

const { ImapFlow } = require('../lib/imap-flow');

module.exports['Commands: Client instantiation'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    test.ok(client);
    test.equal(typeof client.exec, 'function');
    test.done();
};

module.exports['Commands: Method availability'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    // Check that key IMAP methods exist
    test.equal(typeof client.connect, 'function');
    test.equal(typeof client.logout, 'function');
    test.equal(typeof client.list, 'function');
    test.equal(typeof client.mailboxOpen, 'function');
    test.equal(typeof client.mailboxClose, 'function');
    test.equal(typeof client.search, 'function');
    test.equal(typeof client.fetch, 'function');
    test.done();
};

module.exports['Commands: State management methods'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    test.equal(typeof client.mailboxCreate, 'function');
    test.equal(typeof client.mailboxDelete, 'function');
    test.equal(typeof client.mailboxRename, 'function');
    test.equal(typeof client.mailboxSubscribe, 'function');
    test.equal(typeof client.mailboxUnsubscribe, 'function');
    test.done();
};

module.exports['Commands: Message operation methods'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    test.equal(typeof client.messageFlagsSet, 'function');
    test.equal(typeof client.messageFlagsAdd, 'function');
    test.equal(typeof client.messageFlagsRemove, 'function');
    test.equal(typeof client.messageCopy, 'function');
    test.equal(typeof client.messageMove, 'function');
    test.equal(typeof client.messageDelete, 'function');
    test.done();
};

module.exports['Commands: Utility methods'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    test.equal(typeof client.noop, 'function');
    test.equal(typeof client.getQuota, 'function');
    test.equal(typeof client.stats, 'function');
    test.equal(typeof client.getRandomId, 'function');
    test.done();
};
