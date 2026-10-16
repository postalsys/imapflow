import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, listen, makeClient } from './fixtures/scripted-server.js';

// A server that misbehaves on purpose: the cases a hostile server, or a MITM on a cleartext
// connection, can produce and the client must survive without reporting success it did not get.

const CAPS = 'IMAP4rev1 ID ENABLE NAMESPACE IDLE';

// A logger whose warn entries are captured, the rest is dropped
const capturingLogger = (warnings: any[]) => ({
    trace() {},
    debug() {},
    info() {},
    warn: (entry: any) => warnings.push(entry),
    error() {},
    fatal() {}
});

// A text part wrapped in n levels of multipart/mixed, as BODYSTRUCTURE renders it
const nestedMultipart = (depth: number): string => {
    let structure = '("text" "plain" ("charset" "us-ascii") NIL NIL "7bit" 12 1 NIL NIL NIL)';
    for (let i = 0; i < depth; i++) {
        structure = `(${structure} "mixed" ("boundary" "b${i}") NIL NIL)`;
    }
    return structure;
};

describe('server-hardening', () => {
    it('Hardening: a tagged BYE does not complete LOGIN', async () => {
        // RFC 9051 section 7.1.5: BYE is always untagged. It used to settle the command like an
        // OK, so a server answering LOGIN this way marked the session authenticated.
        let server = createServer({
            handlers: {
                LOGIN(ctx: any) {
                    ctx.write(`${ctx.tag} BYE Go away\r\n`);
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await assert.rejects(client.connect(), (err: any) => {
            assert.equal(err.code, 'NoConnection', `unexpected error: ${err.code} ${err.message}`);
            assert.equal(err.responseStatus, 'BYE');
            assert.ok(!err.authenticationFailed, 'a BYE says nothing about the credentials');
            return true;
        });
        assert.ok(!client.authenticated, 'the session was not marked authenticated');
        assert.ok(!client.usable, 'the connection never became usable');
        assert.equal(client.state, client.states.LOGOUT);

        client.close();
        server.close();
    });
    it('Hardening: a tagged BYE in reply to LOGOUT still counts as logged out', async () => {
        let server = createServer({
            handlers: {
                LOGOUT(ctx: any) {
                    ctx.write(`${ctx.tag} BYE Logging out\r\n`);
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        assert.equal(await client.logout(), true);
        assert.equal(client.state, client.states.LOGOUT);

        client.close();
        server.close();
    });
    it('Hardening: a PREAUTH greeting fails required STARTTLS without sending STARTTLS', async () => {
        // STARTTLS is only valid before authentication, which a PREAUTH greeting skips: there is no
        // way left to protect the session, so with doSTARTTLS required the connection must fail
        // instead of carrying on in cleartext. The capability list even advertises STARTTLS here,
        // the way a MITM would, and the command must still not go out.
        let starttlsSeen = false;
        let server = createServer({
            capabilities: `${CAPS} STARTTLS`,
            greeting: `* PREAUTH [CAPABILITY ${CAPS} STARTTLS] preauthenticated\r\n`,
            handlers: {
                STARTTLS(ctx: any) {
                    starttlsSeen = true;
                    ctx.bad('STARTTLS not allowed in this state');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port, { doSTARTTLS: true });
        client.on('error', () => {});

        await assert.rejects(client.connect(), (err: any) => {
            assert.ok(err.tlsFailed, `the failure is a TLS failure: ${err.message}`);
            assert.match(err.message, /PREAUTH/);
            return true;
        });
        assert.equal(starttlsSeen, false, 'STARTTLS was not sent in the authenticated state');
        assert.ok(!client.usable, 'the connection never became usable');

        client.close();
        server.close();
    });
    it('Hardening: a PREAUTH greeting with opportunistic STARTTLS continues with a warning', async () => {
        let starttlsSeen = false;
        let server = createServer({
            capabilities: `${CAPS} STARTTLS`,
            greeting: `* PREAUTH [CAPABILITY ${CAPS} STARTTLS] preauthenticated\r\n`,
            handlers: {
                STARTTLS(ctx: any) {
                    starttlsSeen = true;
                    ctx.bad('STARTTLS not allowed in this state');
                }
            }
        });
        let port = await listen(server);
        let warnings: any[] = [];
        let client = makeClient(port, { logger: capturingLogger(warnings) });
        client.on('error', () => {});

        await client.connect();
        assert.ok(client.authenticated, 'PREAUTH authenticated the session');
        assert.ok(client.usable);
        assert.equal(starttlsSeen, false, 'no STARTTLS was attempted in the authenticated state');
        assert.ok(
            warnings.some(entry => /PREAUTH/.test(entry.msg) && /unencrypted/.test(entry.msg)),
            `the cleartext session was warned about: ${JSON.stringify(warnings.map(entry => entry.msg))}`
        );

        await client.logout();
        client.close();
        server.close();
    });
    it('Hardening: an IDLE the server never acknowledges fails the connection within the socket timeout', async () => {
        // The socket watchdog only covers a server that goes quiet. One that keeps sending untagged
        // lines without ever answering "+" kept the IDLE in flight for good, with every later
        // command queued behind it.
        let server = createServer({
            capabilities: CAPS,
            handlers: {
                IDLE(ctx: any) {
                    let noise = setInterval(() => ctx.write('* OK still here\r\n'), 50);
                    ctx.socket.on('close', () => clearInterval(noise));
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port, { socketTimeout: 500 });
        let errors: any[] = [];
        client.on('error', err => errors.push(err));

        await client.connect();
        await client.mailboxOpen('INBOX');

        let started = Date.now();
        let idleResult = await client.idle();
        let elapsed = Date.now() - started;

        assert.equal(idleResult, false, 'the IDLE session reports failure');
        assert.ok(elapsed < 5000, `the deadline fired in time (${elapsed} ms)`);
        assert.equal(errors.length, 1, 'the connection failed once');
        assert.equal(errors[0].code, 'ETIMEOUT');
        assert.match(errors[0].message, /IDLE/);
        // and the queue is not stuck behind it: a later command fails right away
        await assert.rejects(client.noop(), (err: any) => {
            assert.equal(err.code, 'NoConnection');
            return true;
        });

        client.close();
        server.close();
    });
    it('Hardening: a message nested deeper than the parser limit still reaches the FETCH result', async () => {
        // The nesting is the message sender's doing, and the whole row used to fail to parse and
        // be dropped silently, so the message never reached the caller. The item that nests too
        // deep is left out instead, the rest of the row is delivered, and a warning says so.
        let server = createServer({
            capabilities: CAPS,
            handlers: {
                FETCH(ctx: any) {
                    // message 1 nests past the limit, message 2 stays within it
                    let seq = ctx.args.split(' ')[0];
                    let depth = seq === '1' ? 150 : 60;
                    ctx.write(`* ${seq} FETCH (UID ${seq === '1' ? 7 : 8} FLAGS (\\Seen) BODYSTRUCTURE ${nestedMultipart(depth)})\r\n`);
                    ctx.ok('FETCH completed');
                }
            }
        });
        let port = await listen(server);
        let warnings: any[] = [];
        let client = makeClient(port, { logger: capturingLogger(warnings) });
        client.on('error', () => {});

        await client.connect();
        await client.mailboxOpen('INBOX');

        let message: any = await client.fetchOne('1', { uid: true, flags: true, bodyStructure: true });
        assert.ok(message, 'the row was delivered');
        assert.equal(message.uid, 7);
        assert.ok(message.flags.has('\\Seen'));
        assert.equal(message.bodyStructure, undefined, 'the item that nested too deep is left out');
        assert.ok(
            warnings.some(entry => /nesting limit/.test(entry.msg) && entry.attributes.includes('BODYSTRUCTURE')),
            `the dropped item was warned about: ${JSON.stringify(warnings.map(entry => entry.msg))}`
        );

        // 60 nested multiparts used to exceed the limit (which was 25) and are parsed whole now
        message = await client.fetchOne('2', { uid: true, flags: true, bodyStructure: true });
        assert.equal(message.uid, 8);
        assert.ok(message.bodyStructure, 'a structure within the limit is parsed');
        let node = message.bodyStructure;
        let levels = 0;
        while (node.childNodes && node.childNodes.length) {
            assert.equal(node.type, 'multipart/mixed');
            node = node.childNodes[0];
            levels++;
        }
        assert.equal(levels, 60);
        assert.equal(node.type, 'text/plain');

        await client.logout();
        client.close();
        server.close();
    });
});
