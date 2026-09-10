import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ImapFlow } from '../src/imap-flow.js';
import type { MailboxObject } from '../src/types.js';

// End-to-end ImapFlow tests against a scriptable in-process mock IMAP server.
// This exercises the connection lifecycle that pure unit tests cannot reach:
// connect/greeting handling, startSession (CAPABILITY/ID/NAMESPACE/ENABLE),
// authentication, the reader loop (OK/NO/BAD/untagged/continuation handling),
// send/trySend/write, socket handlers, autoidle, locks, logout and close.

// ---------------------------------------------------------------------------
// Mock IMAP server
// ---------------------------------------------------------------------------
// `handlers` maps an uppercase command keyword to (ctx) => void, where ctx
// provides { tag, line, args, write(str), ok(text), no(text), bad(text), socket }.
// Sensible defaults are provided for a full happy-path session; tests override
// individual commands as needed.
const createServer = (options = {}) => {
    const capabilities = (options as any).capabilities || 'IMAP4rev1 ID ENABLE NAMESPACE UIDPLUS CONDSTORE MOVE QUOTA';
    const greeting = (options as any).greeting || `* OK [CAPABILITY ${capabilities}] mock ready\r\n`;

    const defaults = {
        CAPABILITY(ctx: any) {
            ctx.write(`* CAPABILITY ${capabilities}\r\n`);
            ctx.ok('CAPABILITY completed');
        },
        ID(ctx: any) {
            ctx.write('* ID ("name" "mock" "version" "1.0")\r\n');
            ctx.ok('ID completed');
        },
        NAMESPACE(ctx: any) {
            ctx.write('* NAMESPACE (("" "/")) NIL NIL\r\n');
            ctx.ok('NAMESPACE completed');
        },
        ENABLE(ctx: any) {
            ctx.write('* ENABLED CONDSTORE\r\n');
            ctx.ok('ENABLE completed');
        },
        LOGIN(ctx: any) {
            ctx.ok('LOGIN completed');
        },
        COMPRESS(ctx: any) {
            ctx.no('COMPRESS not available');
        },
        SELECT(ctx: any) {
            ctx.write('* 3 EXISTS\r\n');
            ctx.write('* 0 RECENT\r\n');
            ctx.write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n');
            ctx.write('* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] Limited\r\n');
            ctx.write('* OK [UIDVALIDITY 12345] UIDs valid\r\n');
            ctx.write('* OK [UIDNEXT 100] Predicted next UID\r\n');
            ctx.write('* OK [HIGHESTMODSEQ 1000] Highest\r\n');
            ctx.ok('[READ-WRITE] SELECT completed');
        },
        EXAMINE(ctx: any) {
            ctx.write('* 3 EXISTS\r\n');
            ctx.write('* OK [UIDVALIDITY 12345] UIDs valid\r\n');
            ctx.write('* OK [UIDNEXT 100] Predicted next UID\r\n');
            ctx.ok('[READ-ONLY] EXAMINE completed');
        },
        LIST(ctx: any) {
            ctx.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
            ctx.write('* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n');
            ctx.ok('LIST completed');
        },
        LSUB(ctx: any) {
            ctx.write('* LSUB (\\HasNoChildren) "/" "INBOX"\r\n');
            ctx.ok('LSUB completed');
        },
        STATUS(ctx: any) {
            ctx.write('* STATUS "INBOX" (MESSAGES 3 UIDNEXT 100 UIDVALIDITY 12345 UNSEEN 1)\r\n');
            ctx.ok('STATUS completed');
        },
        NOOP(ctx: any) {
            ctx.ok('NOOP completed');
        },
        LOGOUT(ctx: any) {
            ctx.write('* BYE Logging out\r\n');
            ctx.ok('LOGOUT completed');
        },
        SEARCH(ctx: any) {
            ctx.write('* SEARCH 1 2 3\r\n');
            ctx.ok('SEARCH completed');
        },
        CREATE(ctx: any) {
            ctx.ok('CREATE completed');
        },
        DELETE(ctx: any) {
            ctx.ok('DELETE completed');
        },
        RENAME(ctx: any) {
            ctx.ok('RENAME completed');
        },
        SUBSCRIBE(ctx: any) {
            ctx.ok('SUBSCRIBE completed');
        },
        UNSUBSCRIBE(ctx: any) {
            ctx.ok('UNSUBSCRIBE completed');
        }
    };

    const handlers = Object.assign({}, defaults, (options as any).handlers || {});

    const server = net.createServer(socket => {
        socket.setNoDelay(true);
        socket.on('error', () => {});
        if ((options as any).onConnect) {
            (options as any).onConnect(socket);
        }
        if (greeting) {
            socket.write(greeting);
        }

        let buf = Buffer.alloc(0);
        let literalRemaining = 0;
        let cmdPrefix = '';

        const dispatch = (fullLine: any) => {
            // fullLine is the first physical line of the command (tag + command + args);
            // literal payloads are not needed to choose a response.
            let parts = fullLine.split(' ');
            let tag = parts[0];
            let command = (parts[1] || '').toUpperCase();
            // IDLE is terminated by a bare, untagged "DONE" continuation line, so it
            // has no tag/command split — route it to the DONE handler explicitly.
            if (!parts[1] && (parts[0] || '').toUpperCase() === 'DONE') {
                command = 'DONE';
            }
            let args = parts.slice(2).join(' ');

            const ctx = {
                tag,
                command,
                line: fullLine,
                args,
                socket,
                write: (str: any) => socket.write(str),
                ok: (text: any) => socket.write(`${tag} OK ${text || 'completed'}\r\n`),
                no: (text: any) => socket.write(`${tag} NO ${text || 'failed'}\r\n`),
                bad: (text: any) => socket.write(`${tag} BAD ${text || 'bad'}\r\n`)
            };

            let handler = handlers[command];
            if (typeof handler === 'function') {
                handler(ctx);
            } else if (handler === null) {
                // explicitly silent (e.g. simulate no response)
            } else {
                ctx.bad(`Unknown command ${command}`);
            }
        };

        const processBuffer = () => {
            // Loop until we run out of complete lines / literal data.
            while (true) {
                if (literalRemaining > 0) {
                    if (buf.length < literalRemaining) {
                        return;
                    }
                    buf = buf.slice(literalRemaining);
                    literalRemaining = 0;
                    // Fall through to read the continuation line (post-literal text + CRLF)
                }

                let idx = buf.indexOf('\r\n');
                if (idx < 0) {
                    return;
                }
                let line = buf.slice(0, idx).toString('binary');
                buf = buf.slice(idx + 2);

                let combined = cmdPrefix + line;

                // Synchronizing / non-synchronizing literal at end of line?
                let m = combined.match(/\{(\d+)(\+)?\}$/);
                if (m) {
                    literalRemaining = Number(m[1]);
                    // Keep the prefix (sans literal marker) for command keyword extraction
                    cmdPrefix = combined.replace(/\{(\d+)(\+)?\}$/, '<literal> ');
                    if (!m[2]) {
                        // synchronizing literal -> tell client to proceed
                        socket.write('+ Ready for literal data\r\n');
                    }
                    continue;
                }

                cmdPrefix = '';
                dispatch(combined);
            }
        };

        socket.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
            processBuffer();
        });
    });

    return server;
};

const listen = (server: any) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const makeClient = (port: any, overrides = {}) =>
    new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: false,
        disableAutoIdle: true,
        disableCompression: true,
        logger: false,
        auth: { user: 'test', pass: 'secret' },
        ...overrides
    });

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
        // with BAD, and closes the connection after three rejected commands. The one
        // rejection the client cannot avoid is the ENABLE; the listing must then go
        // straight to a plain LIST plus LSUB instead of walking the RETURN option ladder
        let rejections = 0;
        let lists = 0;
        let lsubs = 0;
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
                LSUB(ctx: any) {
                    lsubs++;
                    ctx.write('* LSUB (\\HasNoChildren) "/" INBOX\r\n');
                    ctx.ok('LSUB completed');
                }
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
            assert.equal(listing.find(entry => entry.path === 'INBOX')!.subscribed, true, 'LSUB answered the subscription state');
        }

        // Every LIST carrying RETURN options and every ENABLE counts as a rejection, so
        // one is the ENABLE and the ladder was never walked
        assert.equal(rejections, 1);
        assert.equal(lists, 2, 'one plain LIST per listing');
        assert.equal(lsubs, 2);
        assert.equal(errors.length, 0);

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

        let quota: any = await client.getQuota();
        assert.ok(quota, 'quota resolved');
        assert.equal(quota.quotaRoot, 'userquota', 'quota root from the first command');
        assert.equal((quota.storage as any).usage, 512 * 1024, 'quota usage from the fallback command');

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
