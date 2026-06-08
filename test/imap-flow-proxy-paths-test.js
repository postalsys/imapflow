'use strict';

// Exercises connect()'s proxy code path by injecting a mocked proxyConnection
// (via proxyquire) that returns a cleartext socket connected to an in-process
// mock IMAP server. Also covers the proxy-setup failure path.

const net = require('net');
const tls = require('tls');
const proxyquire = require('proxyquire');
const { cert, key } = require('./fixtures/test-tls');

const CAPS = 'IMAP4rev1 ID ENABLE NAMESPACE';

// Minimal mock IMAP server (plaintext) sufficient for a full session.
const createServer = () =>
    net.createServer(socket => {
        socket.on('error', () => {});
        let buf = '';
        socket.on('data', data => {
            buf += data.toString('binary');
            let idx;
            while ((idx = buf.indexOf('\r\n')) >= 0) {
                let line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                let parts = line.split(' ');
                let tag = parts[0];
                let cmd = (parts[1] || '').toUpperCase();
                switch (cmd) {
                    case 'CAPABILITY':
                        socket.write(`* CAPABILITY ${CAPS}\r\n${tag} OK done\r\n`);
                        break;
                    case 'ID':
                        socket.write(`* ID ("name" "mock" "version" "1")\r\n${tag} OK done\r\n`);
                        break;
                    case 'LOGIN':
                        socket.write(`${tag} OK LOGIN done\r\n`);
                        break;
                    case 'NAMESPACE':
                        socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`);
                        break;
                    case 'ENABLE':
                        socket.write(`${tag} OK done\r\n`);
                        break;
                    case 'LOGOUT':
                        socket.write(`* BYE bye\r\n${tag} OK done\r\n`);
                        break;
                    default:
                        socket.write(`${tag} OK ok\r\n`);
                }
            }
        });
        socket.write(`* OK [CAPABILITY ${CAPS}] ready\r\n`);
    });

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

module.exports['Proxy: cleartext connection established through a proxy socket'] = async test => {
    let server = createServer();
    let port = await listen(server);

    // Mock proxyConnection to hand back a real cleartext socket to our server.
    const { ImapFlow } = proxyquire('../lib/imap-flow', {
        './proxy-connection': {
            proxyConnection: async () => net.connect(port, '127.0.0.1'),
            detachEarlyErrorHandler: () => {}
        }
    });

    let client = new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: false,
        proxy: 'socks://127.0.0.1:1080',
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' }
    });
    client.on('error', () => {});

    await client.connect();
    test.ok(client.usable, 'session established over the proxied socket');
    test.ok(client.authenticated);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Proxy: TLS connection established through a proxy socket'] = async test => {
    let server = tls.createServer({ cert, key }, socket => {
        socket.on('error', () => {});
        let buf = '';
        socket.on('data', data => {
            buf += data.toString('binary');
            let idx;
            while ((idx = buf.indexOf('\r\n')) >= 0) {
                let line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                let parts = line.split(' ');
                let tag = parts[0];
                let cmd = (parts[1] || '').toUpperCase();
                if (cmd === 'CAPABILITY') socket.write(`* CAPABILITY ${CAPS}\r\n${tag} OK done\r\n`);
                else if (cmd === 'ID') socket.write(`* ID ("name" "m")\r\n${tag} OK done\r\n`);
                else if (cmd === 'NAMESPACE') socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`);
                else if (cmd === 'LOGOUT') socket.write(`* BYE bye\r\n${tag} OK done\r\n`);
                else socket.write(`${tag} OK ok\r\n`);
            }
        });
        socket.write(`* OK [CAPABILITY ${CAPS}] ready\r\n`);
    });
    let port = await listen(server);

    // proxyConnection returns a plaintext TCP socket; the client then wraps it in TLS.
    const { ImapFlow } = proxyquire('../lib/imap-flow', {
        './proxy-connection': {
            proxyConnection: async () => net.connect(port, '127.0.0.1'),
            detachEarlyErrorHandler: () => {}
        }
    });

    let client = new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: true,
        servername: 'localhost',
        tls: { rejectUnauthorized: false },
        proxy: 'socks://127.0.0.1:1080',
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' }
    });
    client.on('error', () => {});

    await client.connect();
    test.ok(client.secureConnection, 'TLS handshake over the proxy socket');
    test.ok(client.usable);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Proxy: a null proxy socket rejects connect'] = async test => {
    const { ImapFlow } = proxyquire('../lib/imap-flow', {
        './proxy-connection': {
            proxyConnection: async () => null, // proxy setup yields no socket
            detachEarlyErrorHandler: () => {}
        }
    });

    let client = new ImapFlow({
        host: '127.0.0.1',
        port: 1,
        secure: false,
        proxy: 'socks://127.0.0.1:1080',
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' }
    });
    client.on('error', () => {});

    let err = null;
    try {
        await client.connect();
    } catch (e) {
        err = e;
    }
    test.ok(err, 'connect rejected when proxy returns no socket');
    test.equal(err.code, 'ProxyError');

    client.close();
    test.done();
};

module.exports['Proxy: proxyConnection throwing rejects connect'] = async test => {
    const { ImapFlow } = proxyquire('../lib/imap-flow', {
        './proxy-connection': {
            proxyConnection: async () => {
                let e = new Error('SOCKS handshake failed');
                e.code = 'ESOCKS';
                throw e;
            },
            detachEarlyErrorHandler: () => {}
        }
    });

    let client = new ImapFlow({
        host: '127.0.0.1',
        port: 1,
        secure: false,
        proxy: 'socks://127.0.0.1:1080',
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' }
    });
    client.on('error', () => {});

    let err = null;
    try {
        await client.connect();
    } catch (e) {
        err = e;
    }
    test.ok(err);
    test.equal(err.code, 'ESOCKS');

    client.close();
    test.done();
};
