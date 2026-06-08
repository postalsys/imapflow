'use strict';

// End-to-end secure-transport tests: a successful STARTTLS upgrade and a direct
// TLS connection, both against in-process mock servers using a self-signed cert.
// These cover upgradeToSTARTTLS()'s success path and the TLS branches of connect().

const net = require('net');
const tls = require('tls');
const { ImapFlow } = require('../lib/imap-flow');
const { cert, key } = require('./fixtures/test-tls');

const CAPS = 'IMAP4rev1 ID ENABLE NAMESPACE';

// Shared per-connection IMAP line handler used by both the plaintext and the
// upgraded TLS phases. Returns responses for the minimal session commands.
const handleLine = (sock, line, onStartTls) => {
    let parts = line.split(' ');
    let tag = parts[0];
    let cmd = (parts[1] || '').toUpperCase();
    switch (cmd) {
        case 'CAPABILITY':
            sock.write(`* CAPABILITY ${CAPS} STARTTLS\r\n${tag} OK CAPABILITY done\r\n`);
            break;
        case 'STARTTLS':
            sock.write(`${tag} OK Begin TLS\r\n`);
            if (onStartTls) {
                onStartTls();
            }
            break;
        case 'ID':
            sock.write(`* ID ("name" "mock" "version" "1")\r\n${tag} OK ID done\r\n`);
            break;
        case 'LOGIN':
            sock.write(`${tag} OK LOGIN done\r\n`);
            break;
        case 'NAMESPACE':
            sock.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE done\r\n`);
            break;
        case 'ENABLE':
            sock.write(`${tag} OK ENABLE done\r\n`);
            break;
        case 'COMPRESS':
            sock.write(`${tag} NO not now\r\n`);
            break;
        case 'NOOP':
            sock.write(`${tag} OK NOOP done\r\n`);
            break;
        case 'LOGOUT':
            sock.write(`* BYE bye\r\n${tag} OK LOGOUT done\r\n`);
            break;
        default:
            sock.write(`${tag} BAD unknown ${cmd}\r\n`);
    }
};

const lineReader = (sock, onLine) => {
    let buf = '';
    let handler = data => {
        buf += data.toString('binary');
        let idx;
        while ((idx = buf.indexOf('\r\n')) >= 0) {
            let line = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            onLine(line);
        }
    };
    sock.on('data', handler);
    sock.on('error', () => {});
    return () => sock.removeListener('data', handler);
};

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// ---------------------------------------------------------------------------
// STARTTLS happy path
// ---------------------------------------------------------------------------

module.exports['Secure: STARTTLS upgrade completes a session'] = async test => {
    let server = net.createServer(rawSocket => {
        rawSocket.on('error', () => {});

        let detachPlain;
        detachPlain = lineReader(rawSocket, line => {
            handleLine(rawSocket, line, () => {
                // Upgrade: stop reading plaintext, wrap the socket in TLS
                detachPlain();
                let tlsSocket = new tls.TLSSocket(rawSocket, { isServer: true, key, cert });
                tlsSocket.on('error', () => {});
                tlsSocket.on('secure', () => {});
                lineReader(tlsSocket, l => handleLine(tlsSocket, l));
            });
        });

        rawSocket.write(`* OK [CAPABILITY ${CAPS} STARTTLS] ready\r\n`);
    });

    let port = await listen(server);
    let client = new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: false,
        doSTARTTLS: true,
        servername: 'localhost',
        tls: { rejectUnauthorized: false },
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' }
    });
    client.on('error', () => {});

    await client.connect();
    test.ok(client.secureConnection, 'connection upgraded to TLS');
    test.ok(client.authenticated, 'authenticated over TLS');
    test.ok(client.usable);

    await client.noop();
    await client.logout();
    client.close();
    server.close();
    test.done();
};

// ---------------------------------------------------------------------------
// Direct TLS connection
// ---------------------------------------------------------------------------

module.exports['Secure: direct TLS connection completes a session'] = async test => {
    let server = tls.createServer({ key, cert }, sock => {
        sock.on('error', () => {});
        lineReader(sock, line => handleLine(sock, line));
        sock.write(`* OK [CAPABILITY ${CAPS}] ready\r\n`);
    });

    let port = await listen(server);
    let client = new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: true,
        servername: 'localhost',
        tls: { rejectUnauthorized: false },
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' }
    });
    client.on('error', () => {});

    await client.connect();
    test.ok(client.secureConnection);
    test.ok(client.authenticated);
    test.ok(client.tls, 'cipher info recorded');

    await client.noop();
    await client.logout();
    client.close();
    server.close();
    test.done();
};

// ---------------------------------------------------------------------------
// STARTTLS required but unsupported -> fail closed
// ---------------------------------------------------------------------------

module.exports['Secure: doSTARTTLS=false skips an advertised upgrade'] = async test => {
    let server = net.createServer(sock => {
        sock.on('error', () => {});
        lineReader(sock, line => handleLine(sock, line)); // advertises STARTTLS in CAPABILITY
        sock.write(`* OK [CAPABILITY ${CAPS} STARTTLS] ready\r\n`);
    });
    let port = await listen(server);
    let client = new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: false,
        doSTARTTLS: false, // explicitly disabled -> stay plaintext
        tls: { rejectUnauthorized: false },
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' }
    });
    client.on('error', () => {});

    await client.connect();
    test.ok(!client.secureConnection, 'stayed on plaintext');
    test.ok(client.authenticated);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Secure: STARTTLS command rejected by server fails closed'] = async test => {
    let server = net.createServer(sock => {
        sock.on('error', () => {});
        lineReader(sock, line => {
            let parts = line.split(' ');
            let tag = parts[0];
            let cmd = (parts[1] || '').toUpperCase();
            if (cmd === 'CAPABILITY') {
                sock.write(`* CAPABILITY ${CAPS} STARTTLS\r\n${tag} OK done\r\n`);
            } else if (cmd === 'STARTTLS') {
                sock.write(`${tag} NO STARTTLS not available right now\r\n`);
            } else {
                sock.write(`${tag} OK ok\r\n`);
            }
        });
        sock.write(`* OK [CAPABILITY ${CAPS} STARTTLS] ready\r\n`);
    });
    let port = await listen(server);
    let client = new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: false,
        doSTARTTLS: true,
        tls: { rejectUnauthorized: false },
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
    test.ok(err, 'connect rejected when STARTTLS refused');
    test.ok(err.tlsFailed);

    client.close();
    server.close();
    test.done();
};

module.exports['Secure: STARTTLS handshake error rejects connect'] = async test => {
    // Server acknowledges STARTTLS then sends non-TLS garbage so the client's TLS
    // handshake fails, exercising the dedicated TLS-socket error handler.
    let server = net.createServer(rawSocket => {
        rawSocket.on('error', () => {});
        let detach = lineReader(rawSocket, line => {
            handleLine(rawSocket, line, () => {
                detach();
                // garbage instead of a TLS ServerHello
                rawSocket.write(Buffer.from('this is definitely not a TLS handshake\r\n'.repeat(8)));
            });
        });
        rawSocket.write(`* OK [CAPABILITY ${CAPS} STARTTLS] ready\r\n`);
    });
    let port = await listen(server);
    let client = new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: false,
        doSTARTTLS: true,
        servername: 'localhost',
        tls: { rejectUnauthorized: false },
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
    test.ok(err, 'connect rejected on TLS handshake failure');
    test.ok(err.tlsFailed, 'flagged as a TLS failure');

    client.close();
    server.close();
    test.done();
};

module.exports['Secure: STARTTLS required but not advertised throws'] = async test => {
    let server = net.createServer(sock => {
        sock.on('error', () => {});
        lineReader(sock, line => {
            let parts = line.split(' ');
            let tag = parts[0];
            let cmd = (parts[1] || '').toUpperCase();
            if (cmd === 'CAPABILITY') {
                // no STARTTLS advertised
                sock.write(`* CAPABILITY ${CAPS}\r\n${tag} OK done\r\n`);
            } else {
                sock.write(`${tag} OK ok\r\n`);
            }
        });
        sock.write(`* OK [CAPABILITY ${CAPS}] ready\r\n`);
    });

    let port = await listen(server);
    let client = new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: false,
        doSTARTTLS: true,
        servername: 'localhost',
        tls: { rejectUnauthorized: false },
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
    test.ok(err, 'connect rejected');
    test.ok(err.tlsFailed, 'flagged as TLS failure');

    client.close();
    server.close();
    test.done();
};
