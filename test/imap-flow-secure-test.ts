import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { ImapFlow } from '../src/imap-flow.js';
import { cert, key } from './fixtures/test-tls.js';

// End-to-end secure-transport tests: a successful STARTTLS upgrade and a direct
// TLS connection, both against in-process mock servers using a self-signed cert.
// These cover upgradeToSTARTTLS()'s success path and the TLS branches of connect().

const CAPS = 'IMAP4rev1 ID ENABLE NAMESPACE';

// Shared per-connection IMAP line handler used by both the plaintext and the
// upgraded TLS phases. Returns responses for the minimal session commands.
// `caps` is the full capability list to advertise for this phase - the STARTTLS
// test uses different pre- and post-TLS sets to prove the client discards the
// plaintext capabilities and re-fetches them over TLS (RFC 9051 6.2.1).
const handleLine = (sock: any, line: any, onStartTls: any, caps: any) => {
    caps = caps || `${CAPS} STARTTLS`;
    let parts = line.split(' ');
    let tag = parts[0];
    let cmd = (parts[1] || '').toUpperCase();
    switch (cmd) {
        case 'CAPABILITY':
            sock.write(`* CAPABILITY ${caps}\r\n${tag} OK CAPABILITY done\r\n`);
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

const lineReader = (sock: any, onLine: any) => {
    let buf = '';
    let handler = (data: any) => {
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

const listen = (server: any) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// Builds a STARTTLS mock server. Defaults give the happy path; options tweak a
// phase without another copy of the upgrade scaffold:
// - preTlsCaps / postTlsCaps: capability list advertised before / after the upgrade
// - startTlsOk: tag => string, overrides the response line to the STARTTLS command
// - onTlsLine: (tlsSocket, line) => boolean, intercepts post-upgrade lines; return
//   true when the line was handled
const createStartTlsServer: any = (opts = {}) =>
    net.createServer(rawSocket => {
        rawSocket.on('error', () => {});

        let preTlsCaps = (opts as any).preTlsCaps || `${CAPS} STARTTLS`;
        let postTlsCaps = (opts as any).postTlsCaps || CAPS;

        let detachPlain: any;
        detachPlain = lineReader(rawSocket, (line: any) => {
            let parts = line.split(' ');
            let tag = parts[0];
            let cmd = (parts[1] || '').toUpperCase();

            if (cmd === 'STARTTLS') {
                rawSocket.write((opts as any).startTlsOk ? (opts as any).startTlsOk(tag) : `${tag} OK Begin TLS\r\n`);
                detachPlain();
                let tlsSocket = new tls.TLSSocket(rawSocket, { isServer: true, key, cert });
                tlsSocket.on('error', () => {});
                lineReader(tlsSocket, (l: any) => {
                    if ((opts as any).onTlsLine && (opts as any).onTlsLine(tlsSocket, l)) {
                        return;
                    }
                    handleLine(tlsSocket, l, null, postTlsCaps);
                });
                return;
            }

            handleLine(rawSocket, line, null, preTlsCaps);
        });

        rawSocket.write(`* OK [CAPABILITY ${preTlsCaps}] ready\r\n`);
    });

// The client options shared by every STARTTLS test.
const makeStartTlsClient = (port: any, overrides = {}) =>
    new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: false,
        doSTARTTLS: true,
        servername: 'localhost',
        tls: { rejectUnauthorized: false },
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' },
        ...overrides
    });

// Every terminal upgrade path must leave no upgrade state behind
const assertUpgradeSettled = (client: any) => {
    assert.equal(client.upgrading, false, 'upgrading flag cleared');
    assert.equal(client._upgradeReject, null, 'upgrade rejector cleared');
    assert.equal(client.upgradeTimeout, null, 'upgrade timer cleared');
};

// Records every socket that went through configureSocket(), which is the single place the
// transport options (keepalive + inactivity watchdog) are applied.
const trackConfiguredSockets: any = (client: any) => {
    let sockets: any = [];
    let original = client.configureSocket.bind(client);
    client.configureSocket = (socket: any) => {
        sockets.push(socket);
        return original(socket);
    };
    return sockets;
};

describe('imap-flow-secure', () => {
    // ---------------------------------------------------------------------------
    // STARTTLS happy path
    // ---------------------------------------------------------------------------
    it('Secure: STARTTLS upgrade completes a session', async () => {
        // post-TLS phase advertises a different capability set
        let server = createStartTlsServer({
            preTlsCaps: `${CAPS} STARTTLS PRETLS-ONLY`,
            postTlsCaps: `${CAPS} POSTTLS-ONLY`
        });

        let port = await listen(server);
        let client = makeStartTlsClient(port);
        client.on('error', () => {});

        await client.connect();
        assert.ok(client.secureConnection, 'connection upgraded to TLS');
        assert.ok(client.authenticated, 'authenticated over TLS');
        assert.ok(client.usable);
        // RFC 9051 6.2.1: capabilities cached before STARTTLS MUST be discarded and
        // re-fetched over the TLS channel
        assert.ok(client.capabilities.has('POSTTLS-ONLY'), 'post-TLS capabilities were re-fetched');
        assert.ok(!client.capabilities.has('PRETLS-ONLY'), 'pre-TLS capabilities were discarded');

        await client.noop();
        await client.logout();
        client.close();
        server.close();
    });
    it('Secure: STARTTLS discards capabilities even when the OK carries a CAPABILITY code', async () => {
        // A server (or a MITM rewriting the plaintext stream) may stamp [CAPABILITY ...]
        // on the STARTTLS OK itself. That marks the capability set as freshly updated, so
        // a discard conditioned on "an update is still pending" would keep exactly the
        // pre-TLS list an attacker controls - the list that then chooses the AUTH
        // mechanism and answers LOGINDISABLED. RFC 9051 6.2.1 makes the discard mandatory.
        let server = createStartTlsServer({
            preTlsCaps: `${CAPS} STARTTLS PRETLS-ONLY`,
            postTlsCaps: `${CAPS} POSTTLS-ONLY`,
            // the OK itself carries a (pre-TLS, attacker-rewritable) CAPABILITY code
            startTlsOk: (tag: any) => `${tag} OK [CAPABILITY ${CAPS} PRETLS-ONLY] Begin TLS\r\n`
        });

        let port = await listen(server);
        let client = makeStartTlsClient(port);
        client.on('error', () => {});

        await client.connect();
        assert.ok(client.secureConnection, 'connection upgraded to TLS');
        assert.ok(client.capabilities.has('POSTTLS-ONLY'), 'post-TLS capabilities were re-fetched');
        assert.ok(!client.capabilities.has('PRETLS-ONLY'), 'pre-TLS capabilities were discarded');

        await client.logout();
        client.close();
        server.close();
    });
    it('Secure: pre-TLS rawCapabilities do not survive a failed re-fetch', async () => {
        // capabilities/authCapabilities are discarded at the upgrade, but rawCapabilities
        // is public surface external consumers read. If the post-TLS CAPABILITY re-fetch
        // fails, the pre-TLS list - the one an active attacker can rewrite - must not
        // linger there either.
        let server = createStartTlsServer({
            preTlsCaps: `${CAPS} STARTTLS PRETLS-ONLY`,
            postTlsCaps: `${CAPS} POSTTLS-ONLY`,
            onTlsLine: (tlsSocket: any, line: any) => {
                let parts = line.split(' ');
                if ((parts[1] || '').toUpperCase() === 'CAPABILITY') {
                    // the re-fetch over TLS fails
                    tlsSocket.write(`${parts[0]} NO CAPABILITY not available\r\n`);
                    return true;
                }
                return false;
            }
        });

        let port = await listen(server);
        let client = makeStartTlsClient(port);
        client.on('error', () => {});

        await client.connect();
        assert.ok(client.secureConnection, 'connection upgraded to TLS');
        assert.ok(!client.capabilities.has('PRETLS-ONLY'), 'pre-TLS capabilities were discarded');
        let raw = ([].concat as any)(client.rawCapabilities || []);
        assert.ok(!raw.some((entry: any) => entry && /PRETLS-ONLY/.test((entry as any).value || entry)), 'pre-TLS rawCapabilities were discarded');

        await client.logout();
        client.close();
        server.close();
    });
    it('Secure: STARTTLS session keeps the inactivity watchdog', async () => {
        // Regression: the inactivity timer was armed on the plain socket only, while the timeout
        // listener was attached to the TLS socket, so an upgraded session had no watchdog at all
        // and a dead connection was never noticed.
        let server = createStartTlsServer();
        let port = await listen(server);
        let client: any = makeStartTlsClient(port, { socketTimeout: 200 });

        let errors: any = [];
        client.on('error', (err: any) => errors.push(err));
        let closed = new Promise(resolve => client.once('close', resolve as any));
        let configured = trackConfiguredSockets(client);

        await client.connect();
        assert.ok(client.secureConnection, 'connection upgraded to TLS');
        assert.equal(configured.length, 2, 'both the plain socket and the upgraded socket are configured');
        assert.equal((client.socket as any).timeout, 200, 'the upgraded socket carries the configured inactivity timeout');
        assert.equal(configured[0].timeout, 0, 'the superseded plain-socket timer is cleared, not left armed');

        // No traffic from here on: the watchdog has to fire and take the connection down.
        await closed;

        assert.ok(
            errors.some((err: any) => err.code === 'ETIMEOUT'),
            'the inactivity watchdog reported a socket timeout'
        );
        assert.ok(client.isClosed, 'the connection closed after the timeout');

        client.close();
        server.close();
    });
    it('Secure: STARTTLS leaves no upgrade state behind on success', async () => {
        // Item 8: every terminal path of the upgrade runs through one settlement helper, so after
        // a successful handshake no timer, rejector, flag or temporary handler survives.
        let server = createStartTlsServer();
        let port = await listen(server);
        let client: any = makeStartTlsClient(port);
        client.on('error', () => {});

        await client.connect();

        assertUpgradeSettled(client);
        // The handshake-only handler is gone, leaving the generic socket error handler as the single
        // error path (during the handshake it is the other way round, which is what prevents a
        // handshake error from firing two handlers at once).
        assert.equal((client.socket as any).listenerCount('error'), 1, 'the TLS socket keeps exactly one error path');

        await client.logout();
        client.close();
        server.close();
    });
    it('Secure: close() during a STARTTLS upgrade settles the upgrade', async () => {
        // The server acknowledges STARTTLS but never performs a handshake. close() has to settle
        // the pending upgrade instead of leaving the session promise dangling forever.
        let server = net.createServer(rawSocket => {
            rawSocket.on('error', () => {});
            let detach = lineReader(rawSocket, (line: any) => {
                (handleLine as any)(rawSocket, line, () => {
                    detach(); // silence: no ServerHello, no data at all
                });
            });
            rawSocket.write(`* OK [CAPABILITY ${CAPS} STARTTLS] ready\r\n`);
        });
        let port = await listen(server);
        let client = makeStartTlsClient(port);
        client.on('error', () => {});

        let connectResult = client.connect().then(
            () => null,
            err => err
        );

        // Wait until the upgrade is in flight, then close the connection under it.
        while (!client.upgrading) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        // A late socket event would invoke the same settle helper the rejector exposes -
        // capture it before close() consumes it
        let settle: any = client._upgradeReject;
        client.close();

        let err = await connectResult;
        assert.ok(err, 'connect rejected rather than hanging on the abandoned upgrade');
        assert.ok(['ClosedAfterConnectText', 'ClosedAfterConnectTLS', 'NoConnection'].includes(err.code), `connect rejected with ${err.code}`);
        assertUpgradeSettled(client);

        // The late event lands after the upgrade already settled - it must be a no-op:
        // a settled upgrade neither claims the error as a TLS failure nor re-arms any state
        let lateErr: any = new Error('late socket error');
        settle(lateErr);
        assert.ok(!lateErr.tlsFailed, 'the late error was not marked as a TLS upgrade failure');
        assertUpgradeSettled(client);

        server.close();
    });
    it('Secure: STARTTLS handshake failure rejects connect', async () => {
        let server = createStartTlsServer();
        let port = await listen(server);
        // The tls option is erased entirely, not merely relaxed: certificate validation
        // stays on, so the mock server's self-signed certificate must fail the handshake,
        // and the upgrade builds its TLS options from the no-options fallback
        let client = makeStartTlsClient(port, { tls: undefined });
        client.on('error', () => {});

        let err = await client.connect().then(
            () => null,
            connectErr => connectErr
        );

        assert.ok(err, 'connect rejected on the failed handshake');
        assert.ok(err.tlsFailed, 'the error is marked as a TLS upgrade failure');
        assertUpgradeSettled(client);

        client.close();
        server.close();
    });

    // ---------------------------------------------------------------------------
    // Direct TLS connection
    // ---------------------------------------------------------------------------
    it('Secure: direct TLS connection completes a session', async () => {
        let server = tls.createServer({ key, cert }, sock => {
            sock.on('error', () => {});
            lineReader(sock, (line: any) => (handleLine as any)(sock, line));
            sock.write(`* OK [CAPABILITY ${CAPS}] ready\r\n`);
        });

        let port: any = await listen(server);
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
        assert.ok(client.secureConnection);
        assert.ok(client.authenticated);
        assert.ok(client.tls, 'cipher info recorded');

        await client.noop();
        await client.logout();
        client.close();
        server.close();
    });

    // ---------------------------------------------------------------------------
    // STARTTLS required but unsupported -> fail closed
    // ---------------------------------------------------------------------------
    it('Secure: doSTARTTLS=false skips an advertised upgrade', async () => {
        let server = net.createServer(sock => {
            sock.on('error', () => {});
            lineReader(sock, (line: any) => (handleLine as any)(sock, line)); // advertises STARTTLS in CAPABILITY
            sock.write(`* OK [CAPABILITY ${CAPS} STARTTLS] ready\r\n`);
        });
        let port: any = await listen(server);
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
        assert.ok(!client.secureConnection, 'stayed on plaintext');
        assert.ok(client.authenticated);

        await client.logout();
        client.close();
        server.close();
    });
    it('Secure: STARTTLS command rejected by server fails closed', async () => {
        let server = net.createServer(sock => {
            sock.on('error', () => {});
            lineReader(sock, (line: any) => {
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
        let port: any = await listen(server);
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

        let err: any = null;
        try {
            await client.connect();
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'connect rejected when STARTTLS refused');
        assert.ok(err.tlsFailed);

        client.close();
        server.close();
    });
    it('Secure: STARTTLS handshake error rejects connect', async () => {
        // Server acknowledges STARTTLS then sends non-TLS garbage so the client's TLS
        // handshake fails, exercising the dedicated TLS-socket error handler.
        let server = net.createServer(rawSocket => {
            rawSocket.on('error', () => {});
            let detach = lineReader(rawSocket, (line: any) => {
                (handleLine as any)(rawSocket, line, () => {
                    detach();
                    // garbage instead of a TLS ServerHello
                    rawSocket.write(Buffer.from('this is definitely not a TLS handshake\r\n'.repeat(8)));
                });
            });
            rawSocket.write(`* OK [CAPABILITY ${CAPS} STARTTLS] ready\r\n`);
        });
        let port: any = await listen(server);
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

        let err: any = null;
        try {
            await client.connect();
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'connect rejected on TLS handshake failure');
        assert.ok(err.tlsFailed, 'flagged as a TLS failure');

        client.close();
        server.close();
    });
    it('Secure: STARTTLS required but not advertised throws', async () => {
        let server = net.createServer(sock => {
            sock.on('error', () => {});
            lineReader(sock, (line: any) => {
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

        let port: any = await listen(server);
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

        let err: any = null;
        try {
            await client.connect();
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'connect rejected');
        assert.ok(err.tlsFailed, 'flagged as TLS failure');

        client.close();
        server.close();
    });
});
