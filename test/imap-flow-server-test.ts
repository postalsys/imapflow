import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { MailboxObject } from '../src/types.js';
import { createServer, listen, makeClient } from './fixtures/scripted-server.js';
import { installRejectionDetector } from './fixtures/test-client.js';

// End-to-end ImapFlow tests against a scriptable in-process mock IMAP server.
// This exercises the connection lifecycle that pure unit tests cannot reach:
// connect/greeting handling, startSession (CAPABILITY/ID/NAMESPACE/ENABLE),
// authentication, the reader loop (OK/NO/BAD/untagged/continuation handling),
// send/trySend/write, socket handlers, autoidle, locks, logout and close.

describe('imap-flow-server', () => {
    // ---------------------------------------------------------------------------
    // Tests
    // ---------------------------------------------------------------------------
    it('Server: full connect + session + logout', async () => {
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        assert.ok(client.authenticated, 'authenticated');
        assert.ok(client.usable, 'usable');
        assert.ok(client.capabilities.has('IMAP4rev1'));
        assert.ok(client.serverInfo || client.namespace, 'namespace set');

        await client.logout();
        assert.equal(client.state, client.states.LOGOUT);

        client.close();
        server.close();
    });
    it('Server: protocol lines are logged when the logger takes them, and the cleartext fallback is warned about', async () => {
        let server = createServer();
        let port = await listen(server);

        // A logger that captures every level, with a threshold of its own when given one
        let captureLogger = (isLevelEnabled?: (level: string) => boolean) => {
            let entries: any[] = [];
            let logger: any = { isLevelEnabled };
            for (let level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
                logger[level] = (entry: any) => entries.push({ level, ...entry });
            }
            return { logger, entries };
        };
        let runSession = async (overrides: any, onClient?: (client: any) => void) => {
            let client = makeClient(port, overrides);
            client.on('error', () => {});
            onClient?.(client);
            await client.connect();
            await client.logout();
            client.close();
        };

        // A logger that takes everything sees both directions of the session, and the warning
        // that the session stayed in cleartext because the server offered no STARTTLS
        let { logger, entries } = captureLogger();
        await runSession({ logger });

        assert.ok(
            entries.some(entry => entry.level === 'debug' && entry.src === 'c' && /^\d+ LOGIN "test" "\(\* value hidden \*\)"$/.test(entry.msg)),
            'client commands are logged, with the password masked'
        );
        assert.ok(
            entries.some(entry => entry.level === 'debug' && entry.src === 's' && /^\* CAPABILITY /.test(entry.msg)),
            'server responses are logged'
        );
        let warnings = entries.filter(entry => entry.level === 'warn');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].msg, /does not support STARTTLS/);

        // A logger that reports debug disabled gets no protocol lines (and the client does
        // not serialize them for it), but the warning still comes through
        ({ logger, entries } = captureLogger(level => level === 'warn'));
        await runSession({ logger });

        assert.equal(entries.filter(entry => entry.src === 'c' || entry.src === 's').length, 0, 'no protocol lines');
        assert.equal(entries.filter(entry => entry.level === 'warn').length, 1);

        // Emitted log events are not subject to the logger's threshold
        let events: any[] = [];
        await runSession({ logger, emitLogs: true }, client => client.on('log', (entry: any) => events.push(entry)));

        assert.ok(events.some(entry => entry.src === 's' && /^\* CAPABILITY /.test(entry.msg)));

        server.close();
    });
    it('Server: BYE greeting rejects connect even if the server keeps the socket open', async () => {
        let server = createServer({ greeting: '* BYE Server too busy\r\n' });
        let port = await listen(server);
        let client = makeClient(port, { greetingTimeout: 10 * 1000 });
        client.on('error', () => {});

        let started = Date.now();
        await assert.rejects(client.connect(), (err: any) => {
            assert.equal(err.code, 'ClosedAfterConnectText');
            assert.equal(err.reason, 'Server too busy');
            return true;
        });
        assert.ok(Date.now() - started < 5000, 'rejected without waiting for the greeting timeout');

        client.close();
        server.close();
    });
    // connect() must settle on its own: a hang would otherwise only show up as the whole run timing out
    const settlesWithin = <T>(promise: Promise<T>, ms = 3000): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        let timeout = new Promise<never>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('connect() did not settle')), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };
    it('Server: verifyOnly connect rejects on a BYE greeting', async () => {
        let server = createServer({ greeting: '* BYE Too many connections\r\n' });
        let port = await listen(server);
        let client = makeClient(port, { verifyOnly: true, greetingTimeout: 60 * 1000 });
        client.on('error', () => {});

        await assert.rejects(settlesWithin(client.connect()), (err: any) => {
            assert.equal(err.code, 'ClosedAfterConnectText');
            assert.equal(err.reason, 'Too many connections');
            return true;
        });

        client.close();
        server.close();
    });
    it('Server: verifyOnly connect rejects when the server closes before the greeting', async () => {
        let server = net.createServer(socket => {
            socket.on('error', () => {});
            socket.end();
        });
        let port = await listen(server);
        let client = makeClient(port, { verifyOnly: true, greetingTimeout: 60 * 1000 });
        client.on('error', () => {});

        await assert.rejects(settlesWithin(client.connect()), (err: any) => {
            assert.equal(err.code, 'ClosedAfterConnectText');
            return true;
        });

        client.close();
        server.close();
    });
    it('Server: close() before the TCP connection is up rejects connect', async () => {
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        // connect() runs synchronously up to the point where the socket is dialled, so this
        // close() lands before onConnect
        let connecting = client.connect();
        let dialled = client.socket;
        client.close();

        await assert.rejects(settlesWithin(connecting), (err: any) => {
            assert.equal(err.code, 'ClosedAfterConnectText');
            return true;
        });
        assert.ok(dialled && dialled.destroyed, 'the dialled socket is destroyed');

        server.close();
    });
    it('Server: connect() on an instance that was already closed rejects', async () => {
        let client = makeClient(1);
        client.on('error', () => {});
        client.close();

        await assert.rejects(settlesWithin(client.connect()), (err: any) => {
            assert.equal(err.code, 'NoConnection');
            assert.equal(err.rejectedFrom, 'connect');
            return true;
        });
        assert.ok(!client.socket, 'no socket was dialled');
    });
    it('Server: qresync option adds QRESYNC to ENABLE', async () => {
        let enabledArgs = null;
        let server = createServer({
            capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE CONDSTORE QRESYNC',
            handlers: {
                ENABLE(ctx: any) {
                    enabledArgs = ctx.args;
                    ctx.write('* ENABLED CONDSTORE QRESYNC\r\n');
                    ctx.ok('ENABLE completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port, { qresync: true });
        client.on('error', () => {});

        await client.connect();
        assert.ok(/QRESYNC/.test(enabledArgs || ''), 'QRESYNC requested in ENABLE');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: connect runs NOOP and LIST', async () => {
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        await client.noop();
        let folders = await client.list();
        assert.ok(folders.length >= 2);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: LIST attributes glued together without a space still yield the special-use mailboxes', async () => {
        // home.pl answers LIST RETURN (SPECIAL-USE CHILDREN SUBSCRIBED) with the special-use
        // flag and the CHILDREN flag run together. Each such line used to fail to parse and
        // its mailbox vanished from the listing, so a sent message had no Sent mailbox to
        // be uploaded into. The source assertion is what proves the flag came off the wire:
        // a mailbox named SENT would have been recognized by name even without it
        let server = createServer({
            capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE CHILDREN LIST-EXTENDED LIST-STATUS SPECIAL-USE',
            handlers: {
                LIST(ctx: any) {
                    ctx.write('* LIST (\\Subscribed \\HasChildren) "." "INBOX"\r\n');
                    ctx.write('* LIST (\\Subscribed \\Drafts\\HasNoChildren) "." "DRAFTS"\r\n');
                    ctx.write('* LIST (\\Subscribed \\Sent\\HasNoChildren) "." "SENT"\r\n');
                    ctx.write('* LIST (\\Subscribed \\Junk\\HasNoChildren) "." "SPAM"\r\n');
                    ctx.write('* LIST (\\Subscribed \\Trash\\HasNoChildren) "." "TRASH"\r\n');
                    ctx.ok('Completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        let folders = await client.list();

        let byPath = new Map(folders.map(entry => [entry.path, entry]));
        assert.deepEqual(
            ['DRAFTS', 'SENT', 'SPAM', 'TRASH'].map(path => byPath.get(path)?.specialUse),
            ['\\Drafts', '\\Sent', '\\Junk', '\\Trash']
        );

        let sent = byPath.get('SENT')!;
        assert.equal(sent.specialUseSource, 'extension');
        assert.equal(sent.subscribed, true);
        assert.ok(sent.flags.has('\\HasNoChildren'));

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: enable compression negotiation (server declines)', async () => {
        let server = createServer();
        let port = await listen(server);
        // disableCompression false -> client issues COMPRESS, server says NO
        let client = makeClient(port, { disableCompression: false });
        client.on('error', () => {});

        await client.connect();
        assert.ok(client.usable);
        assert.ok(!client._deflate, 'compression not enabled when server declines');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: AUTHENTICATE LOGIN flow', async () => {
        let server = createServer({
            capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE AUTH=LOGIN',
            handlers: {
                AUTHENTICATE(ctx: any) {
                    // SASL LOGIN: server prompts for username then password
                    ctx.write('+ VXNlcm5hbWU6\r\n'); // "Username:"
                    ctx.socket.once('data', () => {
                        ctx.write('+ UGFzc3dvcmQ6\r\n'); // "Password:"
                        ctx.socket.once('data', () => {
                            ctx.ok('AUTHENTICATE completed');
                        });
                    });
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        assert.ok(client.authenticated);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: SELECT, SEARCH, STORE and EXPUNGE via run', async () => {
        let server = createServer({
            handlers: {
                STORE(ctx: any) {
                    ctx.write('* 1 FETCH (FLAGS (\\Seen))\r\n');
                    ctx.ok('STORE completed');
                },
                EXPUNGE(ctx: any) {
                    ctx.write('* 1 EXPUNGE\r\n');
                    ctx.ok('EXPUNGE completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        let mailbox = await client.mailboxOpen('INBOX');
        assert.equal(mailbox.exists, 3);

        let found = await client.search({ seen: true }, { uid: false });
        assert.deepEqual(found, [1, 2, 3]);

        let stored = await client.messageFlagsAdd('1', ['\\Seen']);
        assert.ok(stored);

        let expungeEvents = [];
        client.on('expunge', e => expungeEvents.push(e));
        await client.messageDelete('1', { uid: false });
        assert.ok(expungeEvents.length >= 1);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: FETCH delivers a message answered with ENVELOPE NIL and BODYSTRUCTURE NIL', async () => {
        let server = createServer({
            handlers: {
                FETCH(ctx: any) {
                    ctx.write('* 1 FETCH (UID 11 ENVELOPE NIL BODYSTRUCTURE NIL)\r\n');
                    ctx.write('* 2 FETCH (UID 12 ENVELOPE ("Mon, 1 Jan 2024 00:00:00 +0000" "Hi" NIL NIL NIL NIL NIL NIL NIL "<a@b>"))\r\n');
                    ctx.ok('FETCH completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        await client.mailboxOpen('INBOX');
        let messages: any[] = [];
        for await (let msg of client.fetch('1:2', { uid: true, envelope: true, bodyStructure: true })) {
            messages.push(msg);
        }
        assert.deepEqual(
            messages.map(msg => msg.uid),
            [11, 12]
        );
        assert.equal(messages[0].envelope, undefined);
        assert.equal(messages[0].bodyStructure, undefined);
        assert.equal(messages[1].envelope.subject, 'Hi');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: FETCH via fetchOne', async () => {
        let server = createServer({
            handlers: {
                FETCH(ctx: any) {
                    ctx.write('* 1 FETCH (UID 11 FLAGS (\\Seen) RFC822.SIZE 42)\r\n');
                    ctx.ok('FETCH completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        await client.mailboxOpen('INBOX');
        let msg: any = await client.fetchOne('1', { uid: true, flags: true, size: true });
        assert.equal((msg as any).uid, 11);
        assert.equal((msg as any)!.size, 42);
        assert.ok((msg as any)!.flags.has('\\Seen'));

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: download() reads a body part the server sends as a quoted string', async () => {
        // issue #403: Yahoo answers small sections with a quoted string instead of a literal
        let mime = 'Content-Type: text/plain; name="a.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\n';
        let server = createServer({
            handlers: {
                UID(ctx: any) {
                    ctx.write(`* 1 FETCH (UID 5 RFC822.SIZE 300 BODY[2.MIME] {${mime.length}}\r\n${mime} BODY[2]<0> "VGVzdA==")\r\n`);
                    ctx.ok('FETCH completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        await client.mailboxOpen('INBOX');

        let { meta, content }: any = await client.download('5', '2', { uid: true });
        assert.ok(content, 'download() must yield a content stream for a quoted body part');
        assert.equal(meta.encoding, 'base64');
        let chunks: Buffer[] = [];
        for await (let chunk of content) {
            chunks.push(chunk);
        }
        assert.equal(Buffer.concat(chunks).toString(), 'Test');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: APPEND with synchronizing literal', async () => {
        let server = createServer({
            capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE UIDPLUS',
            handlers: {
                APPEND(ctx: any) {
                    ctx.ok('[APPENDUID 12345 9] APPEND completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        let res = await client.append('INBOX', 'Subject: hi\r\n\r\nbody', ['\\Seen']);
        assert.ok(res);
        assert.equal(res.uid, 9);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: AUTHENTICATE PLAIN flow', async () => {
        let server = createServer({
            capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE AUTH=PLAIN',
            handlers: {
                AUTHENTICATE(ctx: any) {
                    ctx.write('+ \r\n');
                    ctx.socket.once('data', () => ctx.ok('AUTHENTICATE completed'));
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        assert.ok(client.authenticated);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: AUTHENTICATE XOAUTH2 with accessToken', async () => {
        let server = createServer({
            capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE AUTH=XOAUTH2',
            handlers: {
                AUTHENTICATE(ctx: any) {
                    ctx.ok('AUTHENTICATE completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port, { auth: { user: 'test', accessToken: 'token-123' } });
        client.on('error', () => {});

        await client.connect();
        assert.ok(client.authenticated);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: backslash username forces LOGIN method', async () => {
        let loginUsed = false;
        let server = createServer({
            capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE AUTH=PLAIN',
            handlers: {
                LOGIN(ctx: any) {
                    loginUsed = true;
                    ctx.ok('LOGIN completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port, { auth: { user: 'domain\\user', pass: 'secret' } });
        client.on('error', () => {});

        await client.connect();
        assert.ok(client.authenticated);
        assert.ok(loginUsed, 'used LOGIN command despite AUTH=PLAIN');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: LOGINDISABLED rejects connect', async () => {
        let server = createServer({
            capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE LOGINDISABLED'
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        let err = null;
        try {
            await client.connect();
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'connect rejected when login disabled');

        client.close();
        server.close();
    });
    it('Server: missing auth config rejects connect', async () => {
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port, { auth: false });
        client.on('error', () => {});

        let err = null;
        try {
            await client.connect();
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'connect rejected without auth');

        client.close();
        server.close();
    });
    it('Server: auth without password rejects connect', async () => {
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port, { auth: { user: 'only-user' } });
        client.on('error', () => {});

        let err = null;
        try {
            await client.connect();
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'connect rejected without password');

        client.close();
        server.close();
    });
    it('Server: command returning NO rejects with responseStatus', async () => {
        let server = createServer({
            handlers: {
                CREATE(ctx: any) {
                    ctx.no('Mailbox already exists');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        let err: any = null;
        try {
            await client.mailboxCreate('Existing');
        } catch (e) {
            err = e;
        }
        assert.ok(err);
        assert.equal(err.responseStatus, 'NO');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: command returning BAD rejects', async () => {
        let server = createServer({
            handlers: {
                CREATE(ctx: any) {
                    ctx.bad('Invalid arguments');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        let err: any = null;
        try {
            await client.mailboxCreate('Whatever');
        } catch (e) {
            err = e;
        }
        assert.ok(err);
        assert.equal(err.responseStatus, 'BAD');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: verifyOnly connect lists mailboxes and logs out', async () => {
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port, { verifyOnly: true, includeMailboxes: true });
        client.on('error', () => {});

        await client.connect();
        assert.ok(Array.isArray(client._mailboxList), 'mailbox list captured');
        assert.ok(client._mailboxList.length >= 1);
        // verifyOnly logs out at the end of startSession
        assert.equal(client.state, client.states.LOGOUT);

        client.close();
        server.close();
    });
    it('Server: verifyOnly keeps the authentication result after logging out', async () => {
        // The whole point of verifyOnly is to report whether the credentials work. The mode logs out
        // before connect() resolves, so if close() cleared `authenticated` the caller would read false
        // off a connection that had just authenticated, with no later moment to read the real answer.
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port, { verifyOnly: true, includeMailboxes: true });
        client.on('error', () => {});

        await client.connect();
        assert.ok(client.authenticated, 'authentication result survives the verifyOnly logout');

        client.close();
        assert.ok(client.authenticated, 'and survives an explicit close as well');

        server.close();
    });
    it('Server: an ordinary session clears the authentication state on close', async () => {
        // The counterpart: for a session that is not verifyOnly, `authenticated` describes live state
        // and must not survive the connection, or reconnect logic reads it as still signed in.
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        assert.ok(client.authenticated, 'authenticated while the session is up');

        client.close();
        assert.equal(client.authenticated, false, 'cleared once the session ends');

        server.close();
    });
    it('Server: ID is re-requested after login when first response is sparse', async () => {
        let idCalls = 0;
        let server = createServer({
            handlers: {
                ID(ctx: any) {
                    idCalls++;
                    if (idCalls === 1) {
                        // sparse/NIL ID before login triggers a re-request afterwards
                        ctx.write('* ID NIL\r\n');
                    } else {
                        ctx.write('* ID ("name" "mock" "version" "1")\r\n');
                    }
                    ctx.ok('ID completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        assert.ok(idCalls >= 2, 'ID requested again after login');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: a refused login closes the connection with the rejected connect', async () => {
        // The socket used to stay open after connect() had been rejected: the instance can not be
        // reused, so nothing would ever use it, and the inactivity watchdog raised ETIMEOUT on
        // it minutes later (as an uncaught exception without an 'error' listener)
        let server = createServer({
            handlers: {
                LOGIN(ctx: any) {
                    ctx.no('[AUTHENTICATIONFAILED] Invalid credentials');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port, { socketTimeout: 200 });
        let errors: any[] = [];
        let closed = 0;
        client.on('error', err => errors.push(err));
        client.on('close', () => closed++);

        await assert.rejects(client.connect(), (err: any) => err.authenticationFailed === true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(client.isClosed, true, 'the transport went with the failed attempt');
        assert.equal(closed, 1);

        // Past the socket timeout: nothing fires on a connection that is gone
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.deepEqual(errors, []);

        server.close();
    });
    it('Server: a connection lost during login is reported once, through the rejected connect', async () => {
        // The socket close rejects connect() and fails the in-flight LOGIN; the session setup
        // then fails as a consequence, and that used to be raised as a second 'error' event,
        // an unhandled rejection for a caller without an 'error' listener
        let server = createServer({
            handlers: {
                LOGIN(ctx: any) {
                    ctx.socket.end();
                }
            }
        });
        let port = await listen(server);
        let detector = installRejectionDetector();
        let client = makeClient(port);
        let errors: any[] = [];
        client.on('error', err => errors.push(err));

        await assert.rejects(client.connect(), (err: any) => err.code === 'ClosedAfterConnectText');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.deepEqual(errors, [], 'no second report');
        assert.equal(client.isClosed, true);
        detector.check();

        server.close();
    });
    it('Server: an unsolicited BYE closes the connection without waiting for the socket to go', async () => {
        // The server says it is about to close but keeps the socket open (a FIN lost to a
        // partition, a middlebox). The in-flight command and everything queued behind it used to
        // wait for the socket watchdog, minutes later.
        let server = createServer({
            handlers: {
                NOOP(ctx: any) {
                    ctx.write('* BYE Session expired\r\n');
                    ctx.ok('NOOP completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});
        await client.connect();

        let first = client.noop().then(
            () => 'resolved',
            (err: any) => err.code
        );
        // Queued straight behind it, the way the command pipeline queues them
        let queued = ['NOOP', 'LIST'].map(command =>
            client.exec(command).then(
                () => 'resolved',
                (err: any) => err.rejectedFrom || err.code
            )
        );
        assert.equal(await first, 'resolved', 'the command the BYE answered completes');
        assert.deepEqual(await Promise.all(queued), ['sendAfterLogout', 'sendAfterLogout'], 'the queued commands fail at once');
        assert.equal(client.state, client.states.LOGOUT);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(client.isClosed, true, 'the connection is closed without waiting for the socket');

        server.close();
    });
    it('Server: NAMESPACE BAD with auth message surfaces auth failure', async () => {
        let server = createServer({
            handlers: {
                NAMESPACE(ctx: any) {
                    ctx.bad('User is authenticated but not connected');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        let err: any = null;
        try {
            await client.connect();
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'connect rejected');
        assert.ok(/Authentication failed/i.test(err.message) || (err as any).authenticationFailed, 'reported as auth failure');

        client.close();
        server.close();
    });
    it('Server: getMailboxLock selects and releases', async () => {
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        let lock = await client.getMailboxLock('INBOX');
        assert.equal((client.mailbox as MailboxObject).path, 'INBOX');
        lock.release();

        // second lock on same mailbox -> fast path
        let lock2 = await client.getMailboxLock('INBOX');
        lock2.release();

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: getMailboxLock rejects for missing mailbox', async () => {
        let server = createServer({
            handlers: {
                SELECT(ctx: any) {
                    ctx.no('Mailbox does not exist');
                },
                LIST(ctx: any) {
                    // empty LIST -> mailbox confirmed missing
                    ctx.ok('LIST completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        let err: any = null;
        try {
            await client.getMailboxLock('Missing');
        } catch (e) {
            err = e;
        }
        assert.ok(err);
        assert.ok(err.mailboxMissing, 'flagged as missing mailbox');

        // mailboxOpen() used to leave the flag unset for the same failure
        await assert.rejects(client.mailboxOpen('Missing'), (err: any) => err.mailboxMissing === true);

        client.close();
        server.close();
    });
    it('Server: IDLE then break out', async () => {
        let idleTag: any = null;
        let doneReceived = false;
        // Capabilities MUST advertise IDLE, otherwise the client falls back to NOOP polling
        // and never sends an IDLE command at all.
        let server: any = createServer({
            capabilities: 'IMAP4rev1 IDLE ID ENABLE NAMESPACE UIDPLUS CONDSTORE MOVE QUOTA',
            handlers: {
                IDLE(ctx: any) {
                    // Remember the IDLE command tag so the matching DONE can complete it.
                    idleTag = ctx.tag;
                    ctx.write('+ idling\r\n');
                },
                DONE(ctx: any) {
                    doneReceived = true;
                    // Complete the original IDLE command so client.idle() resolves cleanly.
                    ctx.socket.write(`${idleTag} OK IDLE terminated\r\n`);
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        await client.mailboxOpen('INBOX');

        // Enter IDLE, then break out by issuing another command. Queuing NOOP triggers
        // preCheck(), which sends DONE; the server's DONE handler then completes IDLE.
        let idlePromise = client.idle();
        await client.noop();
        await idlePromise;

        assert.ok(doneReceived, 'server received the DONE continuation');
        assert.equal(client.idling, false, 'client left the IDLE state');

        client.close();
        server.close();
    });
    it('Server: stats counts bytes', async () => {
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        let stats = client.stats();
        assert.ok(stats.sent > 0);
        assert.ok(stats.received > 0);

        let stats2 = client.stats(true); // reset
        assert.ok(stats2.sent >= 0);
        let stats3 = client.stats();
        assert.equal(stats3.sent, 0);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: PREAUTH greeting skips login', async () => {
        let server = createServer({
            greeting: '* PREAUTH [CAPABILITY IMAP4rev1 ID ENABLE NAMESPACE] already authenticated\r\n'
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        assert.equal(client.state, client.states.AUTHENTICATED);
        assert.ok(client.usable);
        // documented contract: `true` if the connection was authenticated by PREAUTH
        assert.strictEqual(client.authenticated, true);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: unsolicited EXISTS and VANISHED reach the untagged handlers', async () => {
        let server = createServer({
            capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE QRESYNC',
            handlers: {
                NOOP(ctx: any) {
                    // unsolicited untagged updates piggybacked on NOOP
                    ctx.write('* 5 EXISTS\r\n');
                    ctx.write('* VANISHED 1:2\r\n');
                    ctx.ok('NOOP completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        await client.mailboxOpen('INBOX');

        let existsEvent: any = null;
        let expungeEvents: any = [];
        client.on('exists', e => {
            existsEvent = e;
        });
        client.on('expunge', e => expungeEvents.push(e));

        await client.noop();
        // allow the untagged handlers to run
        await new Promise(r => setTimeout(r, 20));

        assert.ok(existsEvent, 'EXISTS handler fired');
        assert.equal(existsEvent.count, 5);
        assert.ok(expungeEvents.length >= 1, 'VANISHED handler fired');
        assert.equal(expungeEvents[0].vanished, true);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: rev2-shaped SELECT response is tolerated through the full pipeline', async () => {
        // RFC 9051 requires rev2 servers to include an untagged LIST in the SELECT
        // response and a CLOSED response code when another mailbox was selected, and
        // to omit RECENT/UNSEEN. The client must consume such a response cleanly.
        let server = createServer({
            capabilities: 'IMAP4rev2 ID ENABLE NAMESPACE',
            handlers: {
                SELECT(ctx: any) {
                    ctx.write('* OK [CLOSED] Previous mailbox closed\r\n');
                    ctx.write('* 3 EXISTS\r\n');
                    ctx.write('* LIST () "/" INBOX\r\n');
                    ctx.write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n');
                    ctx.write('* OK [PERMANENTFLAGS (\\Seen \\*)] Limited\r\n');
                    ctx.write('* OK [UIDVALIDITY 12345] UIDs valid\r\n');
                    ctx.write('* OK [UIDNEXT 100] Predicted next UID\r\n');
                    ctx.ok('[READ-WRITE] SELECT completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        let errors = [];
        client.on('error', err => errors.push(err));

        await client.connect();
        assert.ok(client.capabilities.has('IMAP4rev2'));

        let mailbox = await client.mailboxOpen('INBOX');
        assert.equal(mailbox.path, 'INBOX');
        assert.equal(mailbox.exists, 3);
        assert.equal(mailbox.uidNext, 100);
        assert.equal(mailbox.uidValidity, 12345n);

        // re-select drives the CLOSED response code through the live pipeline again
        let again = await client.mailboxOpen('INBOX');
        assert.equal(again.exists, 3);
        assert.equal(errors.length, 0, 'no errors from the rev2-shaped response');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: rev2 advertised next to rev1 but ENABLE rejected - listing stays plain and inside the error budget', async () => {
        // Exchange Online, 2026-09: the mailbox backend advertises ENABLE and IMAP4rev2
        // next to IMAP4rev1, answers ENABLE IMAP4REV2 and every LIST with RETURN options
        // with BAD, and closes the connection after three rejected commands in a
        // session. The one rejection the client cannot avoid is the ENABLE; the listing
        // must then go straight to a plain LIST instead of walking the RETURN option
        // ladder, and must not spend a second rejection on LSUB, which such a server
        // (rev2 dropped it) rejects the same way
        let rejections = 0;
        let lists = 0;
        const reject = (ctx: any) => {
            ctx.bad('Command Argument Error. 12');
            if (++rejections >= 3) {
                ctx.write('* BYE Connection closed. 14\r\n');
                ctx.socket.end();
            }
        };
        let server = createServer({
            capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE IMAP4rev2 CHILDREN',
            handlers: {
                ENABLE: reject,
                LIST(ctx: any) {
                    if (/\bRETURN\b/i.test(ctx.args)) {
                        return reject(ctx);
                    }
                    lists++;
                    ctx.write('* LIST (\\HasNoChildren) "/" INBOX\r\n');
                    ctx.write('* LIST (\\HasNoChildren) "/" "Sent Items"\r\n');
                    ctx.ok('LIST completed');
                },
                LSUB: reject
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        let errors: any[] = [];
        client.on('error', err => errors.push(err));

        await client.connect();
        assert.ok(client.usable, 'the rejected ENABLE does not cost the session');
        assert.equal(client.skipRev2, true);
        assert.equal(client.enabled.has('IMAP4REV2'), false);
        assert.ok(client.capabilities.has('IMAP4rev2'), 'the advertisement stays on record as what the server said');

        for (let round = 1; round <= 2; round++) {
            let listing = await client.list();
            assert.ok(
                listing.some(entry => entry.path === 'INBOX'),
                `INBOX listed on round ${round}`
            );
            assert.ok(
                listing.every(entry => entry.subscribed),
                `subscription state is unknowable here, so every folder is assumed subscribed on round ${round}`
            );
        }

        // ENABLE, every LIST carrying RETURN options and LSUB all count as rejections,
        // so one means the ENABLE alone: the ladder was never walked and LSUB never sent
        assert.equal(rejections, 1);
        assert.equal(lists, 2, 'one plain LIST per listing');
        assert.equal(errors.length, 0);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: rev2 is not enabled on Strato RZimapd, which breaks SEARCH in that mode', async () => {
        // Strato RZimapd 7.1.12 (issue #411): advertises IMAP4rev2 next to IMAP4rev1 and
        // accepts ENABLE IMAP4rev2, but from then on answers every SEARCH with an ESEARCH
        // response that has no ALL item, which means "no matches". ENABLE cannot be
        // undone, so the server has to be recognized from its ID response beforehand
        let rev2Enabled = false;
        let enableArgs: string[] = [];
        let server = createServer({
            capabilities: 'IMAP4rev1 IMAP4rev2 ID ENABLE NAMESPACE CONDSTORE',
            handlers: {
                ID(ctx: any) {
                    ctx.write('* ID ("name" "RZimapd")\r\n');
                    ctx.ok('ID completed');
                },
                ENABLE(ctx: any) {
                    enableArgs.push(ctx.args);
                    rev2Enabled = /\bIMAP4rev2\b/i.test(ctx.args);
                    ctx.write(`* ENABLED CONDSTORE${rev2Enabled ? ' IMAP4rev2' : ''}\r\n`);
                    ctx.ok('ENABLE completed');
                },
                UID(ctx: any) {
                    if (rev2Enabled) {
                        ctx.write(`* ESEARCH (TAG "${ctx.tag}") UID\r\n`);
                    } else {
                        ctx.write('* SEARCH 10 11 12\r\n');
                    }
                    ctx.ok('SEARCH completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);

        await client.connect();
        assert.equal(enableArgs.length, 1);
        assert.doesNotMatch(enableArgs[0]!, /IMAP4rev2/i);
        assert.equal(client.skipLsub, false, 'unlike a rejected ENABLE, the IMAP4rev1 session keeps LSUB');

        await client.mailboxOpen('INBOX');
        assert.deepEqual(await client.search({ uid: '10:12' }, { uid: true }), [10, 11, 12]);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: unsolicited STATUS for another mailbox is tolerated', async () => {
        // RFC 9051 (Appendix E item 20): with rev2, servers may push updates that are
        // unrelated to the selected mailbox (e.g. a STATUS for another mailbox during
        // IDLE). The client must ignore them without corrupting the selected state.
        let server = createServer({
            handlers: {
                NOOP(ctx: any) {
                    ctx.write('* STATUS "Other" (MESSAGES 5 UNSEEN 1)\r\n');
                    ctx.ok('NOOP completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        let errors = [];
        client.on('error', (err: any) => errors.push(err));

        await client.connect();
        await client.mailboxOpen('INBOX');
        assert.equal((client.mailbox as MailboxObject).exists, 3);

        await client.noop();
        await new Promise(r => setTimeout(r, 20));

        assert.equal((client.mailbox as any).path, 'INBOX', 'selected mailbox unchanged');
        assert.equal((client.mailbox as any).exists, 3, 'selected mailbox message count unchanged');
        assert.equal(errors.length, 0, 'unsolicited STATUS must not raise errors');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: invalid tagged response rejects with InvalidResponse', async () => {
        let server = createServer({
            handlers: {
                CREATE(ctx: any) {
                    // a tagged response whose command is neither OK/NO/BAD
                    ctx.write(`${ctx.tag} WEIRD unexpected status\r\n`);
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        let err: any = null;
        try {
            await client.mailboxCreate('Whatever');
        } catch (e) {
            err = e;
        }
        assert.ok(err);
        assert.equal(err.code, 'InvalidResponse');

        client.close();
        server.close();
    });
    it('Server: reader tolerates an unparseable untagged line', async () => {
        let server = createServer({
            handlers: {
                NOOP(ctx: any) {
                    // malformed untagged line that the parser cannot parse, then a valid OK
                    ctx.write('* 1 FETCH (]\r\n');
                    ctx.ok('NOOP completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        // The malformed line is logged & skipped; NOOP still resolves
        await client.noop();
        assert.ok(true);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: reader yields to event loop on many untagged responses', async () => {
        let server = createServer({
            handlers: {
                STORE(ctx: any) {
                    // 12 untagged FETCH responses + OK in a SINGLE write. STORE's FETCH
                    // responses go through the (non-backpressured) global handler, so the
                    // reader drains all >10 items in one pass and hits the periodic yield.
                    let out = '';
                    for (let i = 1; i <= 12; i++) {
                        out += `* ${i} FETCH (FLAGS (\\Seen))\r\n`;
                    }
                    out += `${ctx.tag} OK STORE completed\r\n`;
                    ctx.write(out);
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        await client.mailboxOpen('INBOX');
        let ok = await client.messageFlagsAdd('1:12', ['\\Seen']);
        assert.ok(ok);

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: partial FETCH NO is treated as success', async () => {
        let server = createServer({
            handlers: {
                FETCH(ctx: any) {
                    ctx.write('* 1 FETCH (UID 1 FLAGS (\\Seen))\r\n');
                    ctx.no('Some of the requested messages no longer exist');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        await client.mailboxOpen('INBOX');
        // The NO with this specific text is treated as success rather than rejecting
        let msg = await client.fetchOne('1', { uid: true });
        assert.ok(msg);
        assert.equal(msg.uid, 1);

        await client.logout();
        client.close();
        server.close();
    });

    // NB: the socket-timeout -> NOOP/IDLE recovery handler is covered deterministically
    // in imap-flow-coverage-test.js (the _socketTimeout tests) rather than via a flaky
    // real-clock socket timeout here.
    it('Server: greeting timeout rejects connect', async () => {
        // Server accepts the socket but never sends a greeting
        let server: any = net.createServer(socket => {
            socket.on('error', () => {});
            // intentionally silent
        });
        await new Promise(resolve => (server.listen as any)(0, '127.0.0.1', resolve));
        let port = (server.address() as any).port;

        let client = makeClient(port, { greetingTimeout: 100 });
        client.on('error', () => {});

        let err: any = null;
        try {
            await client.connect();
        } catch (e) {
            err = e;
        }
        assert.ok(err);
        assert.equal(err.code, 'GREETING_TIMEOUT');

        client.close();
        server.close();
    });
    it('Server: connection timeout rejects connect', async () => {
        // 192.0.2.0/24 (TEST-NET-1, RFC 5737) is reserved and never answers, so the TCP
        // connect hangs until the (very short) connection timeout fires.
        let client = makeClient(9, { host: '192.0.2.1', connectionTimeout: 120 });
        client.on('error', () => {});

        let err: any = null;
        try {
            await client.connect();
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'connect rejected');
        assert.equal(err.code, 'CONNECT_TIMEOUT');

        client.close();
    });
    it('Server: proxy connection failure rejects connect', async () => {
        let client = makeClient(1, {
            // point at a port with nothing listening so the proxy setup fails
            proxy: 'socks://127.0.0.1:1'
        });
        client.on('error', () => {});

        let err = null;
        try {
            await client.connect();
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'connect rejected on proxy failure');

        client.close();
    });
    it('Server: close clears public session state', async () => {
        // Callers inspect these properties in reconnect logic, so they must not keep describing a
        // session that is gone.
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        let events: any = [];
        client.on('mailboxClose', mailbox => events.push({ event: 'mailboxClose', path: mailbox.path }));
        client.on('close', () => events.push({ event: 'close' }));

        await client.connect();
        await client.mailboxOpen('INBOX');

        assert.ok(client.mailbox, 'a mailbox is selected');
        assert.ok(client.authenticated, 'the session is authenticated');
        assert.ok(client.currentSelectCommand, 'the select command is remembered for polling');

        client.close();

        assert.equal(client.mailbox, false, 'mailbox state cleared');
        assert.equal(client.currentSelectCommand, false, 'saved select command cleared');
        assert.equal(client.authenticated, false, 'authentication state cleared');
        assert.equal(client.preCheck, false, 'preCheck cleared');
        assert.equal(client.usable, false, 'connection no longer usable');
        assert.equal(client.idling, false, 'idling cleared');
        assert.equal(client.state, client.states.LOGOUT, 'state is LOGOUT');

        // The selected mailbox transitions to closed exactly once, before 'close'
        assert.deepEqual(events, [{ event: 'mailboxClose', path: 'INBOX' }, { event: 'close' }], 'mailboxClose is emitted once, ahead of close');

        // Repeated close() is idempotent and emits nothing more
        client.close();
        client.close();
        assert.equal(events.length, 2, 'no duplicate events from repeated close()');

        server.close();
    });
    it('Server: close without a selected mailbox emits no mailboxClose', async () => {
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        let mailboxCloseCount = 0;
        client.on('mailboxClose', () => mailboxCloseCount++);

        await client.connect();
        client.close();

        assert.equal(mailboxCloseCount, 0, 'nothing to close, nothing emitted');
        server.close();
    });
    it('Server: GETQUOTA fallback releases the parser', async () => {
        // Regression: the GETQUOTA fallback never handed its response back to the reader, so the
        // parser stayed blocked on its backpressure callback and every later command hung.
        let server = createServer({
            capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE QUOTA',
            handlers: {
                GETQUOTAROOT(ctx: any) {
                    // root only, no inline QUOTA response - forces the fallback command
                    ctx.write('* QUOTAROOT "INBOX" "userquota"\r\n');
                    ctx.ok('GETQUOTAROOT completed');
                },
                GETQUOTA(ctx: any) {
                    ctx.write('* QUOTA "userquota" (STORAGE 512 1024)\r\n');
                    ctx.ok('GETQUOTA completed');
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();

        let quota = await client.getQuota();
        assert.ok(quota, 'quota resolved');
        assert.equal(quota.quotaRoot, 'userquota', 'quota root from the first command');
        assert.equal(quota.storage?.usage, 512 * 1024, 'quota usage from the fallback command');

        // The parser must still be live: a following command has to complete.
        let noopResponse = await client.exec('NOOP', false, {});
        noopResponse.next();
        assert.ok(noopResponse.response, 'the connection still processes commands after the fallback');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: oversized literal cannot inject protocol', async () => {
        // Response-injection regression. With a lowered maxLiteralSize the parser rejects the
        // literal, and everything after the marker line is ordinary message content chosen by a
        // third party. None of it may be parsed: no untagged handler may fire and the forged
        // tagged completion may not settle the in-flight request.
        let server = createServer({
            handlers: {
                NOOP(ctx: any) {
                    ctx.write(
                        `* 1 FETCH (BODY[] {5000}\r\n` + //
                            `INNOCENT MESSAGE TEXT\r\n` +
                            `* 9999 EXISTS\r\n` +
                            `${ctx.tag} OK forged completion\r\n`
                    );
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port, { maxLiteralSize: 1024 });

        let errors: any = [];
        let existsEvents: any = [];
        client.on('error', err => errors.push(err));
        client.on('exists', ev => existsEvents.push(ev));

        await client.connect();
        let mailbox = await client.mailboxOpen('INBOX');
        assert.equal(mailbox.exists, 3, 'mailbox opened with the server reported count');

        let noopErr = null;
        try {
            // exec() surfaces the raw command outcome, so a forged tagged completion would show
            // up here as a resolved request (client.noop() would swallow it into `false`).
            await client.exec('NOOP', false, {});
            assert.ok(false, 'the forged tagged completion must not resolve the in-flight command');
        } catch (err) {
            noopErr = err;
        }

        assert.ok(noopErr, 'the in-flight command rejected instead of accepting injected content');
        assert.deepEqual(existsEvents, [], 'the injected untagged EXISTS never reached an untagged handler');
        assert.ok(
            errors.some((err: any) => err.code === 'LiteralTooLarge'),
            'the limit violation is surfaced to the caller'
        );
        assert.ok(client.isClosed || !client.usable, 'the connection failed closed');

        client.close();
        server.close();
    });
    it('Server: socket close triggers close handling', async () => {
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        let closed = false;
        client.on('close', () => {
            closed = true;
        });

        // Drop the server side
        server.close();
        (client.socket as any).destroy();

        await new Promise(r => setTimeout(r, 60));
        assert.ok(closed || client.isClosed, 'connection closed');
        client.close();
    });
    it('Server: an unparseable tagged completion fails the command instead of stalling', async () => {
        // A tagged line the parser cannot make sense of used to be logged and dropped.
        // currentRequest then stayed set forever, so trySend() stopped dispatching and
        // every later command queued behind a promise that never settled.
        let server = createServer({
            handlers: {
                SELECT(ctx: any) {
                    // A control character inside the response code is not parseable
                    ctx.write(`${ctx.tag} OK [\x01BAD-CODE] SELECT completed\r\n`);
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();

        let selectErr = null;
        try {
            await client.mailboxOpen('INBOX');
        } catch (err) {
            selectErr = err;
        }
        assert.ok(selectErr, 'the command whose completion could not be parsed must reject');

        // The connection has to keep working: the next command still gets dispatched
        let folders = await client.list();
        assert.ok(Array.isArray(folders) && folders.length, 'later commands still run');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: a NUL-padded unparseable completion still fails the command', async () => {
        // Buggy servers pad lines with leading NUL bytes; the parser strips them before
        // reading the tag. The unparsed-completion recovery has to see the same tag the
        // parser saw, or the command hangs for exactly the server class the NUL
        // workaround exists for.
        let server = createServer({
            handlers: {
                SELECT(ctx: any) {
                    ctx.write(`\x00\x00${ctx.tag} OK [\x01BAD-CODE] SELECT completed\r\n`);
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();

        let selectErr = null;
        try {
            await client.mailboxOpen('INBOX');
        } catch (err) {
            selectErr = err;
        }
        assert.ok(selectErr, 'the command whose completion could not be parsed must reject');

        let folders = await client.list();
        assert.ok(Array.isArray(folders) && folders.length, 'later commands still run');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: a sequence-shaped token in a server response does not fail the connection', async () => {
        // The incoming token parser accepts sequence-shaped tokens the strict outgoing
        // grammar rejects ("1:2:3"). Every parsed response is re-compiled for the log, so
        // that pass must skip the validation - one quirky but parseable server line would
        // otherwise tear down the whole connection.
        let server = createServer({
            handlers: {
                NOOP(ctx: any) {
                    ctx.write(`${ctx.tag} OK [XDATA 1:2:3] NOOP completed\r\n`);
                }
            }
        });
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        await client.noop();
        assert.ok(client.usable, 'connection must stay usable');

        let folders = await client.list();
        assert.ok(Array.isArray(folders) && folders.length, 'later commands still run');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: an invalid range rejects the command without wedging the queue', async () => {
        // The compiler refuses invalid sequence sets before anything reaches the wire.
        // The dispatch layer has to treat that as the command's own failure: the request
        // must reject (even when queued behind an in-flight command) and the queue must
        // keep moving instead of waiting forever on a response that can never arrive.
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        await client.mailboxOpen('INBOX');

        let err: any = null;
        try {
            await client.fetchOne('1;2', { uid: true });
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'the invalid range must reject');
        assert.equal(err && err.code, 'InvalidSequenceSet');

        // Queued variant: the invalid command sits behind an in-flight one; every promise
        // must settle and the command behind the invalid one must still run
        let results = await Promise.allSettled([client.noop(), client.fetchOne('3;4', { uid: true }), client.noop()]);
        assert.equal(results[0].status, 'fulfilled', 'command before the invalid one succeeds');
        assert.equal(results[1].status, 'rejected', 'queued invalid command must reject, not hang');
        assert.equal(results[2].status, 'fulfilled', 'command after the invalid one still runs');

        await client.logout();
        client.close();
        server.close();
    });
    it('Server: a throwing response listener does not fail the command', async () => {
        // 'response' is emitted after a tagged completion parses successfully. A listener
        // throwing synchronously used to be caught by the parse-failure path, which
        // rejected the in-flight command with a bogus ParserError even though the server
        // had executed it.
        let server = createServer();
        let port = await listen(server);
        let client = makeClient(port);
        client.on('error', () => {});

        await client.connect();
        client.on('response', payload => {
            if (payload.response === 'OK') {
                throw new Error('listener bug');
            }
        });

        await client.noop();
        let mailbox = await client.mailboxOpen('INBOX');
        assert.ok(mailbox, 'commands succeed despite the throwing listener');

        await client.logout();
        client.close();
        server.close();
    });
});
