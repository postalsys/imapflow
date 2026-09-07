// Exercises connect()'s proxy code path. The SOCKS transport is stubbed in place with a
// node:test mock on SocksClient.createConnection, so the real proxyConnection() hands
// ImapFlow a cleartext socket connected to an in-process mock IMAP server. Also covers the
// proxy-setup failure paths and an end to end run through a real HTTP CONNECT proxy.

import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { SocksClient } from 'socks';
import { cert, key } from './fixtures/test-tls.js';
import { ImapFlow } from '../src/imap-flow.js';

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

const listen = (server: net.Server): Promise<number> =>
    new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));

// Replaces the SOCKS negotiation for the duration of the test: proxyConnection() itself runs for
// real, only the dependency that would talk to a SOCKS server is stubbed. The mock is dropped
// again when the test finishes.
const stubSocks = (t: TestContext, createConnection: (options: any) => Promise<any>) => {
    t.mock.method(SocksClient, 'createConnection', createConnection as any);
    t.after(() => t.mock.restoreAll());
};

describe('imap-flow-proxy-paths', () => {
    it('Proxy: cleartext connection established through a proxy socket', async t => {
        let server = createServer();
        let port = await listen(server);

        // The SOCKS stub hands back a real cleartext socket to our server.
        stubSocks(t, async () => ({ socket: net.connect(port, '127.0.0.1') }));

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
        assert.ok(client.usable, 'session established over the proxied socket');
        assert.ok(client.authenticated);

        await client.logout();
        client.close();
        server.close();
    });

    it('Proxy: TLS connection established through a proxy socket', async t => {
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

        // The SOCKS stub returns a plaintext TCP socket; the client then wraps it in TLS.
        stubSocks(t, async () => ({ socket: net.connect(port, '127.0.0.1') }));

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
        assert.ok(client.secureConnection, 'TLS handshake over the proxy socket');
        assert.ok(client.usable);

        await client.logout();
        client.close();
        server.close();
    });

    it('Proxy: a null proxy socket rejects connect', async () => {
        // An unknown proxy protocol is the one path where proxyConnection() yields no socket at
        // all (it returns undefined instead of throwing), which is what connect() has to report
        // as a ProxyError of its own.
        let client = new ImapFlow({
            host: '127.0.0.1',
            port: 1,
            secure: false,
            proxy: 'ftp://127.0.0.1:21',
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
        assert.ok(err, 'connect rejected when proxy returns no socket');
        assert.equal(err.code, 'ProxyError');

        client.close();
    });

    it('Proxy: proxyConnection throwing rejects connect', async t => {
        stubSocks(t, async () => {
            let e: any = new Error('SOCKS handshake failed');
            e.code = 'ESOCKS';
            throw e;
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

        let err: any = null;
        try {
            await client.connect();
        } catch (e) {
            err = e;
        }
        assert.ok(err);
        assert.equal(err.code, 'ESOCKS');

        client.close();
    });

    // ---------------------------------------------------------------------------
    // End to end through a real HTTP CONNECT proxy (ImapFlow's own CONNECT helper)
    // ---------------------------------------------------------------------------

    // Minimal HTTP CONNECT proxy. `onConnect(socket, headers)` may take over the exchange (used to
    // simulate a proxy that never answers); otherwise the tunnel is established and piped. With
    // `coalesce`, the 200 response is held back until the destination speaks and then written in the
    // same segment as the destination's greeting - which is what a real proxy often does.
    const createHttpProxy = (onConnect?: ((socket: net.Socket, headers: string) => boolean) | null, { coalesce = false }: { coalesce?: boolean } = {}) =>
        net.createServer(socket => {
            socket.on('error', () => {});
            let buf = '';
            const onData = (data: Buffer) => {
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

    it('Proxy: session established through a real HTTP CONNECT proxy', async () => {
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
        assert.ok(client.usable, 'session established through the CONNECT tunnel');
        assert.ok(client.authenticated);

        await client.logout();
        client.close();
        proxy.close();
        imapServer.close();
    });

    it('Proxy: a greeting coalesced with the CONNECT response is not lost', async () => {
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
        assert.ok(client.usable, 'the coalesced greeting was parsed, so the session came up');
        assert.ok(client.capabilities.has('IMAP4rev1'), 'capabilities from the coalesced greeting are present');

        await client.logout();
        client.close();
        proxy.close();
        imapServer.close();
    });

    it('Proxy: a stalled proxy negotiation is bounded by connectionTimeout', async () => {
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
        let err: any = await client.connect().then(
            () => null,
            e => e
        );

        assert.ok(err, 'connect rejected instead of hanging in proxy negotiation');
        assert.equal(err.code, 'CONNECT_TIMEOUT', 'the documented connection timeout covers proxy negotiation');
        assert.ok(Date.now() - started < 3000, 'the deadline applied to the proxy phase, not only to the transport');

        client.close();
        proxy.close();
    });
});
