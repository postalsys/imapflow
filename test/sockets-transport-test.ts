import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import zlib from 'node:zlib';
import { ImapFlow, createSocketsTransport } from '../src/imap-flow.js';
import { isIpLiteral } from '../src/tools.js';
import { startMockImapServer, type MockImapServer } from './cloudflare/mock-imap-server.js';
import { createShim, type ShimState } from './fixtures/sockets-shim.js';
import { freePort } from './cloudflare/harness.js';

// createSocketsTransport() runs on celld (test/celld/ covers it there). Here it runs against the
// cloudflare:sockets API implemented over node:net and node:tls by test/fixtures/sockets-shim.ts.

describe('createSocketsTransport()', () => {
    let server: MockImapServer;
    let tlsServer: MockImapServer;
    let refusingServer: MockImapServer;
    let state: ShimState;

    const client = (target: MockImapServer, options?: Partial<ConstructorParameters<typeof ImapFlow>[0]>) =>
        new ImapFlow({
            host: target.host,
            port: target.port,
            secure: false,
            doSTARTTLS: false,
            auth: { user: 'user', pass: 'pass' },
            logger: false,
            transport: createSocketsTransport(createShim(state)),
            ...options
        });

    before(async () => {
        server = await startMockImapServer({ starttls: true, compress: true });
        tlsServer = await startMockImapServer({ secure: true });
        refusingServer = await startMockImapServer({ capabilities: ['STARTTLS'] });
    });

    after(async () => {
        await Promise.all([server.close(), tlsServer.close(), refusingServer.close()]);
    });

    beforeEach(() => {
        state = { startTlsCalls: 0 };
    });

    it('runs a compressed cleartext session', async () => {
        const imap = client(server);
        await imap.connect();
        assert.equal(imap.socket && (imap.socket as net.Socket).remoteAddress, '127.0.0.1');
        assert.ok(server.commands.includes('COMPRESS DEFLATE'));
        const lock = await imap.getMailboxLock('INBOX');
        const source = Buffer.from('Subject: over sockets\r\n\r\n' + 'x'.repeat(256 * 1024) + '\r\n');
        const appended = await imap.append('INBOX', source);
        assert.ok(appended && appended.uid);
        const message = await imap.fetchOne(String(appended.uid), { source: true, envelope: true }, { uid: true });
        assert.ok(message);
        assert.equal(message.envelope?.subject, 'over sockets');
        assert.deepEqual(message.source, source);
        lock.release();
        await imap.logout();
    });

    it('runs a session over implicit TLS', async () => {
        const imap = client(tlsServer, { secure: true });
        await imap.connect();
        assert.equal(imap.secureConnection, true);
        assert.equal(imap.tls, false, 'the sockets API has no cipher details');
        await imap.logout();
    });

    it('upgrades with STARTTLS with no read in flight', async () => {
        const imap = client(server, { doSTARTTLS: true, disableCompression: true });
        await imap.connect();
        assert.equal(state.startTlsCalls, 1);
        assert.equal(imap.secureConnection, true);
        assert.ok(!imap.capabilities.has('STARTTLS'), 'the capabilities were read again over TLS');
        await imap.noop();
        await imap.logout();
    });

    it('keeps reading when STARTTLS is refused', async () => {
        const imap = client(refusingServer, { doSTARTTLS: undefined });
        await imap.connect();
        assert.equal(state.startTlsCalls, 0);
        assert.equal(imap.secureConnection, false);
        await imap.noop();
        await imap.logout();
    });

    it('refuses the TLS options the runtime can not honor', async () => {
        for (const [options, message] of [
            [{ secure: true, tls: { rejectUnauthorized: false } }, /tls\.rejectUnauthorized=false/],
            [{ secure: true, tls: { ca: 'ca' } }, /tls\.ca/],
            [{ secure: true, servername: 'imap.example.com' }, /servername/]
        ] as const) {
            const imap = client(tlsServer, options);
            await assert.rejects(imap.connect(), (err: any) => err.code === 'UnsupportedTransportOption' && message.test(err.message));
        }
    });

    it('refuses the TLS options on a STARTTLS upgrade', async () => {
        const imap = client(server, { doSTARTTLS: true, tls: { rejectUnauthorized: false } });
        // the cleartext connection is not checked, only the upgrade
        await assert.rejects(imap.connect(), (err: any) => err.code === 'UnsupportedTransportOption' && err.tlsFailed === true);
        assert.equal(state.startTlsCalls, 0);
    });

    it('can not be combined with a proxy', async () => {
        const imap = client(server, { proxy: 'socks5://127.0.0.1:1080' });
        await assert.rejects(imap.connect(), { code: 'UnsupportedTransportOption' });
    });

    it('reports a connect() that throws', async () => {
        state = { startTlsCalls: 0, throwOnConnect: new Error('connect refused by the runtime') };
        const imap = client(server);
        await assert.rejects(imap.connect(), /connect refused by the runtime/);
    });

    it('reports a connection that can not be opened', async () => {
        const port = await freePort();
        const imap = new ImapFlow({ host: '127.0.0.1', port, secure: false, logger: false, transport: createSocketsTransport(createShim(state)) });
        await assert.rejects(imap.connect(), { code: 'ECONNREFUSED' });
    });

    it('times out a socket the server stopped answering', async () => {
        const sockets = new Set<net.Socket>();
        const silent = net.createServer(socket => {
            sockets.add(socket);
            socket.on('error', () => false);
            socket.write('* OK [CAPABILITY IMAP4rev1] silent\r\n');
        });
        await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
        try {
            const imap = new ImapFlow({
                host: '127.0.0.1',
                port: (silent.address() as net.AddressInfo).port,
                secure: false,
                doSTARTTLS: false,
                socketTimeout: 300,
                auth: { user: 'user', pass: 'pass' },
                logger: false,
                transport: createSocketsTransport(createShim(state))
            });
            imap.on('error', () => false);
            await assert.rejects(imap.connect(), { code: 'ETIMEOUT' });
        } finally {
            sockets.forEach(socket => socket.destroy());
            await new Promise(resolve => silent.close(resolve));
        }
    });

    it('closes the client when the server ends the connection', async () => {
        let serverSocket: net.Socket | null = null;
        const closing = net.createServer(socket => {
            serverSocket = socket;
            socket.on('error', () => false);
            socket.on('data', data => {
                const tag = data.toString().split(' ')[0];
                socket.write(`${tag} OK done\r\n`);
            });
            socket.write('* PREAUTH [CAPABILITY IMAP4rev1] ready\r\n');
        });
        await new Promise<void>(resolve => closing.listen(0, '127.0.0.1', resolve));
        try {
            const imap = new ImapFlow({
                host: '127.0.0.1',
                port: (closing.address() as net.AddressInfo).port,
                secure: false,
                doSTARTTLS: false,
                logger: false,
                transport: createSocketsTransport(createShim(state))
            });
            await imap.connect();
            const closed = new Promise(resolve => imap.once('close', resolve));
            serverSocket!.end();
            await closed;
            assert.equal(imap.usable, false);
        } finally {
            serverSocket!.destroy();
            await new Promise(resolve => closing.close(resolve));
        }
    });

    it('skips COMPRESS when the runtime has no streaming DEFLATE', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(zlib, 'createDeflateRaw')!;
        Object.defineProperty(zlib, 'createDeflateRaw', { value: undefined, configurable: true });
        try {
            const before = server.commands.length;
            const imap = client(server);
            await imap.connect();
            assert.ok(!server.commands.slice(before).some(command => command.startsWith('COMPRESS')));
            await imap.noop();
            await imap.logout();
        } finally {
            Object.defineProperty(zlib, 'createDeflateRaw', descriptor);
        }
    });
});

describe('isIpLiteral()', () => {
    it('tells IP literals from hostnames', () => {
        for (const host of ['127.0.0.1', '10.0.0.255', '::1', 'fe80::1', '2001:db8::8a2e:370:7334', '::ffff:192.0.2.1']) {
            assert.equal(isIpLiteral(host), true, host);
        }
        for (const host of ['localhost', 'imap.example.com', '1.2.3.example.com', 'host-1', '123']) {
            assert.equal(isIpLiteral(host), false, host);
        }
    });
});

// A sockets API socket whose streams and promises the test drives directly
const fakeSocket = () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let open!: (info?: { remoteAddress?: string; localAddress?: string }) => void;
    let fail!: (err: Error) => void;
    let closedReject!: (err: Error) => void;
    const written: string[] = [];
    let tlsSocket: ReturnType<typeof fakeSocket> | null = null;
    const opened = new Promise<{ remoteAddress?: string; localAddress?: string } | undefined>((resolve, reject) => {
        open = resolve;
        fail = reject;
    });
    const closed = new Promise<void>((_resolve, reject) => {
        closedReject = reject;
    });
    const socket = {
        readable: new ReadableStream<Uint8Array>(
            {
                start: c => {
                    controller = c;
                }
            },
            { highWaterMark: 0 }
        ),
        writable: new WritableStream<Uint8Array>({
            write: chunk => {
                written.push(Buffer.from(chunk).toString());
            }
        }),
        opened,
        closed,
        closeCalls: 0,
        closeFails: false,
        close: async () => {
            socket.closeCalls++;
            if (socket.closeFails) {
                throw new Error('already closed');
            }
        },
        startTls: () => {
            tlsSocket = fakeSocket();
            return tlsSocket.socket;
        }
    };
    return {
        socket,
        written,
        open,
        fail,
        closedReject,
        send: (data: string | Buffer) => controller.enqueue(new Uint8Array(Buffer.from(data))),
        end: () => controller.close(),
        error: (err: Error) => controller.error(err),
        get tls() {
            return tlsSocket;
        }
    };
};

const transportFor = (fake: ReturnType<typeof fakeSocket>) => createSocketsTransport(() => fake.socket);
const options = { host: 'imap.example.com', port: 993 };
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('createSocketsTransport() socket', () => {
    it('reports the addresses of the connection', async () => {
        const fake = fakeSocket();
        let connected = false;
        const socket = transportFor(fake).connect(options, true, () => (connected = true)) as any;
        fake.open({ remoteAddress: '[2001:db8::1]:993', localAddress: 'not an address' });
        await tick();
        assert.equal(connected, true);
        assert.equal(socket.remoteAddress, '2001:db8::1');
        assert.equal(socket.remotePort, 993);
        assert.equal(socket.localAddress, undefined);
        socket.destroy();
    });

    it('emits timeout only after a whole idle period, however recent the last traffic', async () => {
        const fake = fakeSocket();
        const socket = transportFor(fake).connect(options, true, () => false) as any;
        fake.open({});
        await tick();
        let timeouts = 0;
        socket.on('timeout', () => timeouts++);
        socket.setTimeout(150);
        await new Promise(resolve => setTimeout(resolve, 100));
        socket.write('A1 NOOP\r\n');
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(timeouts, 0, 'the write 100ms in reset the idle period');
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(timeouts, 1);
        socket.destroy();
    });

    it('opens without address details', async () => {
        const fake = fakeSocket();
        const socket = transportFor(fake).connect(options, true, () => false) as any;
        fake.open(undefined);
        await tick();
        assert.equal(socket.remoteAddress, undefined);
        socket.destroy();
        assert.equal(fake.socket.closeCalls, 1);
    });

    it('starts reading once open when a read was requested before', async () => {
        const fake = fakeSocket();
        const socket = transportFor(fake).connect(options, true, () => false) as any;
        const data = new Promise<string>(resolve => socket.once('data', (chunk: Buffer) => resolve(chunk.toString())));
        await tick();
        fake.open({});
        fake.send('* OK ready\r\n');
        assert.equal(await data, '* OK ready\r\n');
        socket.destroy();
    });

    it('does not connect a socket destroyed before it opened, and ignores a failing close()', async () => {
        const fake = fakeSocket();
        fake.socket.closeFails = true;
        let connected = false;
        const socket = transportFor(fake).connect(options, true, () => (connected = true)) as any;
        socket.destroy();
        fake.open({});
        await tick();
        assert.equal(connected, false);
        assert.equal(fake.socket.closeCalls, 1);
    });

    it('refuses a write before the socket is open', async () => {
        const fake = fakeSocket();
        const socket = transportFor(fake).connect(options, true, () => false) as any;
        const error = new Promise<Error>(resolve => socket.once('error', resolve));
        socket.write('a NOOP\r\n');
        assert.match((await error).message, /not open yet/);
    });

    it('reports a connection that can not be opened, and a failed read or close', async () => {
        for (const failure of ['opened', 'read', 'closed'] as const) {
            const fake = fakeSocket();
            const socket = transportFor(fake).connect(options, true, () => false) as any;
            const error = new Promise<Error>(resolve => socket.once('error', resolve));
            if (failure === 'opened') {
                fake.fail(new Error('refused'));
            } else {
                fake.open({});
                socket.resume();
                await tick();
                if (failure === 'read') {
                    fake.error(new Error('refused'));
                } else {
                    fake.closedReject(new Error('refused'));
                }
            }
            assert.equal((await error).message, 'refused');
        }
    });

    it('ends when the server closes, and stops reading once destroyed', async () => {
        const fake = fakeSocket();
        const socket = transportFor(fake).connect(options, true, () => false) as any;
        fake.open({});
        const ended = new Promise(resolve => socket.once('end', resolve));
        socket.resume();
        fake.end();
        await ended;

        const other = fakeSocket();
        const destroyed = transportFor(other).connect(options, true, () => false) as any;
        other.open({});
        const chunks: Buffer[] = [];
        destroyed.on('data', (chunk: Buffer) => chunks.push(chunk));
        await tick();
        destroyed.destroy();
        other.send('late\r\n');
        await tick();
        assert.equal(chunks.length, 0);
    });

    it('stops reading while the consumer does not, and resumes', async () => {
        const fake = fakeSocket();
        const socket = transportFor(fake).connect(options, true, () => false) as any;
        fake.open({});
        await tick();
        socket.read(0);
        const large = Buffer.alloc(64 * 1024, 'x');
        fake.send(large);
        fake.send('tail');
        await tick();
        let received = 0;
        socket.on('data', (chunk: Buffer) => (received += chunk.length));
        await tick();
        await tick();
        assert.equal(received, large.length + 4);
        socket.destroy();
    });

    it('holds reads after a STARTTLS OK split over chunks, and keeps reading after a NO', async () => {
        const fake = fakeSocket();
        const transport = transportFor(fake);
        const socket = transport.connect({ host: 'imap.example.com', port: 143 }, false, () => false) as any;
        fake.open({});
        const received: string[] = [];
        socket.on('data', (chunk: Buffer) => received.push(chunk.toString()));
        await tick();

        transport.prepareUpgrade!(socket);
        socket.write('A1 STARTTLS\r\n');
        await tick();
        fake.send('* OK still cleartext\r\nA1 N');
        fake.send('O not now\r\n');
        fake.send('* 1 EXISTS\r\n');
        await tick();
        assert.equal(received.join(''), '* OK still cleartext\r\nA1 NO not now\r\n* 1 EXISTS\r\n', 'kept reading after the NO');
        assert.deepEqual(fake.written, ['A1 STARTTLS\r\n']);

        transport.prepareUpgrade!(socket);
        socket.write('A2 STARTTLS\r\n');
        await tick();
        fake.send('+ A2 OK not tagged\r\nA2 O');
        fake.send('K begin\r\n');
        await tick();
        fake.send('injected');
        await tick();
        assert.ok(received.join('').endsWith('+ A2 OK not tagged\r\nA2 OK begin\r\n'), 'nothing read after the OK');

        let secure = false;
        const tlsSocket = transport.upgrade(socket, { host: 'imap.example.com', port: 143 }, () => (secure = true)) as any;
        fake.tls!.open({});
        await tick();
        assert.equal(secure, true);
        tlsSocket.destroy();
        assert.equal(fake.socket.closeCalls, 0, 'the cleartext socket is left to the TLS one');
        assert.equal(fake.tls!.socket.closeCalls, 1);
    });

    it('refuses TLS options on an upgrade', () => {
        const fake = fakeSocket();
        const transport = transportFor(fake);
        const socket = transport.connect({ host: 'imap.example.com', port: 143 }, false, () => false);
        assert.throws(() => transport.upgrade(socket, { host: 'imap.example.com', port: 143, tls: { pfx: 'x' } }, () => false), {
            code: 'UnsupportedTransportOption'
        });
        socket.destroy();
    });
});
