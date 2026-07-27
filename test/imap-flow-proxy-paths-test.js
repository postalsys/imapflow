'use strict';

// Exercises connect()'s proxy code path by injecting a mocked proxyConnection
// (via proxyquire) that returns a cleartext socket connected to an in-process
// mock IMAP server. Also covers the proxy-setup failure path.

const net = require('net');
const tls = require('tls');
const proxyquire = require('proxyquire');
const { cert, key } = require('./fixtures/test-tls');
const { ImapFlow } = require('../lib/imap-flow');

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

// ---------------------------------------------------------------------------
// End to end through a real HTTP CONNECT proxy (ImapFlow's own CONNECT helper)
// ---------------------------------------------------------------------------

// Minimal HTTP CONNECT proxy. `onConnect(socket, headers)` may take over the exchange (used to
// simulate a proxy that never answers); otherwise the tunnel is established and piped. With
// `coalesce`, the 200 response is held back until the destination speaks and then written in the
// same segment as the destination's greeting - which is what a real proxy often does.
const createHttpProxy = (onConnect, { coalesce = false } = {}) =>
    net.createServer(socket => {
        socket.on('error', () => {});
        let buf = '';
        const onData = data => {
            buf += data.toString('binary');
            let idx = buf.indexOf('\r\n\r\n');
            if (idx < 0) {
                return;
            }
            socket.removeListener('data', onData);
            let headers = buf.slice(0, idx);
            let rest = buf.slice(idx + 4);
            let authority = (headers.split('\r\n')[0].match(/^CONNECT (\S+)/) || [])[1] || '';

            if (onConnect && onConnect(socket, headers)) {
                return;
            }

            let [, targetPort] = authority.split(':');
            let upstream = net.connect(Number(targetPort), '127.0.0.1', () => {
                if (rest) {
                    upstream.write(Buffer.from(rest, 'binary'));
                }

                const startTunnel = () => {
                    socket.pipe(upstream);
                    upstream.pipe(socket);
                };

                if (!coalesce) {
                    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
                    return startTunnel();
                }

                // Hold the CONNECT response until the destination sends something, then emit both
                // in a single write so the client has to preserve the trailing bytes itself.
                upstream.once('data', firstChunk => {
                    socket.write(Buffer.concat([Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'), firstChunk]));
                    startTunnel();
                });
            });
            upstream.on('error', () => socket.destroy());
        };
        socket.on('data', onData);
    });

module.exports['Proxy: session established through a real HTTP CONNECT proxy'] = async test => {
    let imapServer = createServer();
    let imapPort = await listen(imapServer);
    let proxy = createHttpProxy();
    let proxyPort = await listen(proxy);

    let client = new ImapFlow({
        host: '127.0.0.1',
        port: imapPort,
        secure: false,
        proxy: `http://127.0.0.1:${proxyPort}`,
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' }
    });
    client.on('error', () => {});

    await client.connect();
    test.ok(client.usable, 'session established through the CONNECT tunnel');
    test.ok(client.authenticated);

    await client.logout();
    client.close();
    proxy.close();
    imapServer.close();
    test.done();
};

module.exports['Proxy: a greeting coalesced with the CONNECT response is not lost'] = async test => {
    // The proxy answers CONNECT and the destination greeting in one segment. The bytes after the
    // header terminator belong to the tunnel, so they have to reach the parser - otherwise the
    // greeting is swallowed and connect() only fails at the greeting timeout.
    let imapServer = createServer();
    let imapPort = await listen(imapServer);
    let proxy = createHttpProxy(null, { coalesce: true });
    let proxyPort = await listen(proxy);

    let client = new ImapFlow({
        host: '127.0.0.1',
        port: imapPort,
        secure: false,
        proxy: `http://127.0.0.1:${proxyPort}`,
        greetingTimeout: 1500,
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' }
    });
    client.on('error', () => {});

    await client.connect();
    test.ok(client.usable, 'the coalesced greeting was parsed, so the session came up');
    test.ok(client.capabilities.has('IMAP4rev1'), 'capabilities from the coalesced greeting are present');

    await client.logout();
    client.close();
    proxy.close();
    imapServer.close();
    test.done();
};

module.exports['Proxy: a stalled proxy negotiation is bounded by connectionTimeout'] = async test => {
    // The proxy accepts the CONNECT request and then goes silent
    let proxy = createHttpProxy(() => true);
    let proxyPort = await listen(proxy);

    let client = new ImapFlow({
        host: '127.0.0.1',
        port: 143,
        secure: false,
        proxy: `http://127.0.0.1:${proxyPort}`,
        connectionTimeout: 150,
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' }
    });
    client.on('error', () => {});

    let started = Date.now();
    let err = await client.connect().then(
        () => null,
        e => e
    );

    test.ok(err, 'connect rejected instead of hanging in proxy negotiation');
    test.equal(err.code, 'CONNECT_TIMEOUT', 'the documented connection timeout covers proxy negotiation');
    test.ok(Date.now() - started < 3000, 'the deadline applied to the proxy phase, not only to the transport');

    client.close();
    proxy.close();
    test.done();
};
