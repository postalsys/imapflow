import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapFlow } from '../src/imap-flow.js';
import { ImapStream } from '../src/handler/imap-stream.js';

// Minimal pre-STARTTLS IMAP server. Sends the greeting, advertises STARTTLS, and on the
// STARTTLS command invokes `onStartTls(socket, tag)` so each test controls what (if
// anything) is written after the tagged OK. It never performs a real TLS handshake.
const createStartTlsServer = (onStartTls: any) =>
    net.createServer(socket => {
        socket.on('error', () => {});
        socket.write('* OK [CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED] ready\r\n');

        let buf = '';
        socket.on('data', data => {
            buf += data.toString('binary');
            let idx;
            while ((idx = buf.indexOf('\r\n')) >= 0) {
                let line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                let parts = line.split(' ');
                let tag = parts[0];
                let command = (parts[1] || '').toUpperCase();
                if (command === 'CAPABILITY') {
                    socket.write('* CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED\r\n');
                    socket.write(`${tag} OK CAPABILITY done\r\n`);
                } else if (command === 'STARTTLS') {
                    onStartTls(socket, tag);
                }
            }
        });
    });

const makeClient = (port: any) =>
    new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: false,
        doSTARTTLS: true,
        servername: 'localhost',
        tls: { rejectUnauthorized: false },
        disableAutoIdle: true,
        logger: false,
        auth: { user: 'test', pass: 'test' }
    });

describe('starttls-injection', () => {
    // A MITM injects a response in the SAME segment as the STARTTLS OK, before the handshake.
    // This is caught by the parser-level trailing-data flag (Check 1 in upgradeToSTARTTLS).
    // Injection that instead arrives after the OK in a separate segment is caught by the
    // socket-level read after unpipe (Check 2) or, failing that, by TLS handshake corruption;
    // those fragmented cases are timing-dependent and not asserted deterministically here.
    it('STARTTLS: rejects same-segment plaintext injection', async () => {
        let server: any = createStartTlsServer((socket: any, tag: any) => {
            // OK and an injected untagged CAPABILITY in a single write, no TLS handshake.
            socket.write(`${tag} OK Begin TLS\r\n* CAPABILITY IMAP4rev1 INJECTED\r\n`);
        });

        await new Promise(resolve => (server.listen as any)(0, '127.0.0.1', resolve));
        let port = (server.address() as any).port;

        let client = makeClient(port);
        client.on('error', () => {});

        let connectErr: any = null;
        try {
            await client.connect();
            assert.ok(false, 'connect() must reject when data is injected after the STARTTLS OK');
        } catch (err) {
            connectErr = err;
        }

        assert.ok(connectErr, 'connect() rejected');
        assert.equal(connectErr.code, 'STARTTLS_INJECTION', 'rejection is flagged as an injection');
        assert.ok((connectErr as any).tlsFailed, 'rejection is treated as a TLS failure');
        // The connection must fail closed: it never becomes usable and never authenticates.
        // (The injected untagged response may be parsed transiently before teardown, so asserting
        // it never reaches the capability set would be a timing-fragile false assurance.)
        assert.ok(!client.usable, 'the connection did not become usable (failed closed)');
        assert.ok(!client.authenticated, 'the connection never authenticated');

        client.close();
        server.close();
    });

    // A compliant server stays silent after the STARTTLS OK. The injection guard must NOT
    // fire (no false positive); the upgrade proceeds to the TLS handshake, which then fails
    // here only because this stub server never speaks TLS — proving the guard let it through.
    it('STARTTLS: clean OK is not flagged as injection', async () => {
        let server: any = createStartTlsServer((socket: any, tag: any) => {
            // Only the tagged OK, nothing after it, then drop the connection.
            socket.write(`${tag} OK Begin TLS\r\n`);
            setImmediate(() => socket.destroy());
        });

        await new Promise(resolve => (server.listen as any)(0, '127.0.0.1', resolve));
        let port = (server.address() as any).port;

        let client = makeClient(port);
        client.on('error', () => {});

        let connectErr: any = null;
        try {
            await client.connect();
            assert.ok(false, 'connect() rejects because the stub never completes the TLS handshake');
        } catch (err) {
            connectErr = err;
        }

        assert.ok(connectErr, 'connect() rejected (no TLS handshake on the stub server)');
        assert.notEqual(connectErr.code, 'STARTTLS_INJECTION', 'a clean OK must not be flagged as injection');

        client.close();
        server.close();
    });

    // A STARTTLS handshake failure must reject connect() through a single error path: it must
    // not also emit an 'error' event (which would double-report and crash a listener-less client).
    it('STARTTLS: handshake failure has a single error path', async () => {
        let server: any = createStartTlsServer((socket: any, tag: any) => {
            // Acknowledge STARTTLS, then drop the connection instead of doing TLS.
            socket.write(`${tag} OK Begin TLS\r\n`);
            setImmediate(() => socket.destroy());
        });

        await new Promise(resolve => (server.listen as any)(0, '127.0.0.1', resolve));
        let port = (server.address() as any).port;

        let client = makeClient(port);

        // A second error path would emit here (and crash a listener-less client).
        let errorEvents = 0;
        client.on('error', () => {
            errorEvents++;
        });

        let connectErr: any = null;
        try {
            await client.connect();
            assert.ok(false, 'connect() should reject on STARTTLS handshake failure');
        } catch (err) {
            connectErr = err;
        }

        // Give any stray async error handler a chance to (wrongly) fire.
        await new Promise(r => setTimeout(r, 50));

        assert.ok(connectErr, 'connect() rejected');
        assert.ok(connectErr.tlsFailed, 'rejection is flagged as a TLS failure');
        assert.equal(errorEvents, 0, 'no duplicate error event emitted (single error path)');

        client.close();
        server.close();
    });

    // Unit-level check of the per-command trailing flag the guard relies on: each pushed
    // command records whether more input followed it, independently of later commands.
    it('STARTTLS: parser flags trailing data per command', (t, done) => {
        const stream = new ImapStream({ cid: 'test' });
        let flags: any = [];

        stream.on('readable', () => {
            let cmd;
            while ((cmd = stream.read()) !== null) {
                flags.push(cmd.trailingAfterLine);
                cmd.next();
            }
        });
        stream.on('error', err => assert.ifError(err));
        stream.on('end', () => {
            // First command had a second command after it -> true; the last one -> false.
            assert.deepEqual(flags, [true, false], 'trailingAfterLine is per-command and not overwritten');
            done();
        });

        // Two complete commands in a single write.
        stream.end(Buffer.from('A OK first\r\nB OK second\r\n'));
    });
});
