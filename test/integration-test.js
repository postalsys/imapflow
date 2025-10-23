'use strict';

const { ImapFlow } = require('../lib/imap-flow');

module.exports['Integration: Basic client creation'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    test.ok(client);
    test.equal(client.state, client.states.NOT_AUTHENTICATED);
    test.equal(client.authenticated, false);
    test.done();
};

module.exports['Integration: Multiple client instances'] = test => {
    let client1 = new ImapFlow({
        host: 'imap1.example.com',
        auth: { user: 'test1', pass: 'test1' }
    });

    let client2 = new ImapFlow({
        host: 'imap2.example.com',
        auth: { user: 'test2', pass: 'test2' }
    });

    test.ok(client1);
    test.ok(client2);
    test.notEqual(client1.id, client2.id);
    test.done();
};

module.exports['Integration: Client configuration'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        secure: true,
        auth: { user: 'test', pass: 'test' },
        logger: false
    });

    test.equal(client.host, 'imap.example.com');
    test.equal(client.port, 993);
    test.equal(client.secureConnection, true);
    test.done();
};

module.exports['Integration: Event emitter functionality'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    let eventFired = false;
    client.on('test-event', () => {
        eventFired = true;
    });

    client.emit('test-event');

    setTimeout(() => {
        test.ok(eventFired);
        test.done();
    }, 10);
};

module.exports['Integration: Stats functionality'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    let stats = client.stats();
    test.ok(typeof stats === 'object');
    test.ok(Object.prototype.hasOwnProperty.call(stats, 'sent'));
    test.ok(Object.prototype.hasOwnProperty.call(stats, 'received'));

    // Reset stats
    let resetStats = client.stats(true);
    test.ok(typeof resetStats === 'object');
    test.done();
};
