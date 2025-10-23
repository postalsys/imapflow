'use strict';

const { ImapFlow } = require('../lib/imap-flow');

module.exports['Connection: Basic connection options'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    test.equal(client.host, 'imap.example.com');
    test.equal(client.port, 993);
    test.done();
};

module.exports['Connection: Default options'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    test.equal(client.port, 110);
    test.equal(client.secureConnection, false);
    test.done();
};

module.exports['Connection: Secure connection defaults'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' }
    });

    test.equal(client.secureConnection, true);
    test.done();
};

module.exports['Connection: TLS options'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' },
        tls: {
            rejectUnauthorized: false,
            minVersion: 'TLSv1.3'
        }
    });

    test.equal(client.options.tls.rejectUnauthorized, false);
    test.equal(client.options.tls.minVersion, 'TLSv1.3');
    test.done();
};

module.exports['Connection: Authentication options'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: {
            user: 'testuser',
            pass: 'testpass',
            accessToken: 'token123'
        }
    });

    test.equal(client.options.auth.user, 'testuser');
    test.equal(client.options.auth.pass, 'testpass');
    test.equal(client.options.auth.accessToken, 'token123');
    test.done();
};

module.exports['Connection: Proxy configuration'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' },
        proxy: 'socks5://proxy.example.com:1080'
    });

    test.equal(client.options.proxy, 'socks5://proxy.example.com:1080');
    test.done();
};

module.exports['Connection: Client info'] = test => {
    let clientInfo = {
        name: 'Test Client',
        version: '1.0.0',
        vendor: 'Test Corp'
    };

    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' },
        clientInfo
    });

    test.equal(client.clientInfo.name, 'Test Client');
    test.equal(client.clientInfo.version, '1.0.0');
    test.equal(client.clientInfo.vendor, 'Test Corp');
    test.done();
};

module.exports['Connection: Logger configuration'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' },
        logger: false
    });

    test.equal(client.options.logger, false);
    test.done();
};

module.exports['Connection: Stats tracking'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    let stats = client.stats();
    test.ok(Object.prototype.hasOwnProperty.call(stats, 'sent'));
    test.ok(Object.prototype.hasOwnProperty.call(stats, 'received'));
    test.equal(typeof stats.sent, 'number');
    test.equal(typeof stats.received, 'number');
    test.done();
};

module.exports['Connection: Random ID generation'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    let id1 = client.getRandomId();
    let id2 = client.getRandomId();

    test.ok(typeof id1 === 'string' && id1.length > 0);
    test.ok(typeof id2 === 'string' && id2.length > 0);
    test.notEqual(id1, id2, 'IDs should be unique');
    test.done();
};

module.exports['Connection: State management'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    test.equal(client.state, client.states.NOT_AUTHENTICATED);
    test.equal(client.authenticated, false);
    test.ok(client.capabilities instanceof Map);
    test.done();
};

module.exports['Connection: Event emitter setup'] = test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        auth: { user: 'test', pass: 'test' }
    });

    test.equal(typeof client.on, 'function');
    test.equal(typeof client.emit, 'function');
    test.equal(typeof client.removeListener, 'function');
    test.done();
};
