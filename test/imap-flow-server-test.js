'use strict';

// End-to-end ImapFlow tests against a scriptable in-process mock IMAP server.
// This exercises the connection lifecycle that pure unit tests cannot reach:
// connect/greeting handling, startSession (CAPABILITY/ID/NAMESPACE/ENABLE),
// authentication, the reader loop (OK/NO/BAD/untagged/continuation handling),
// send/trySend/write, socket handlers, autoidle, locks, logout and close.

const net = require('net');
const { ImapFlow } = require('../lib/imap-flow');

// ---------------------------------------------------------------------------
// Mock IMAP server
// ---------------------------------------------------------------------------
// `handlers` maps an uppercase command keyword to (ctx) => void, where ctx
// provides { tag, line, args, write(str), ok(text), no(text), bad(text), socket }.
// Sensible defaults are provided for a full happy-path session; tests override
// individual commands as needed.
const createServer = (options = {}) => {
    const capabilities = options.capabilities || 'IMAP4rev1 ID ENABLE NAMESPACE UIDPLUS CONDSTORE MOVE QUOTA';
    const greeting = options.greeting || `* OK [CAPABILITY ${capabilities}] mock ready\r\n`;

    const defaults = {
        CAPABILITY(ctx) {
            ctx.write(`* CAPABILITY ${capabilities}\r\n`);
            ctx.ok('CAPABILITY completed');
        },
        ID(ctx) {
            ctx.write('* ID ("name" "mock" "version" "1.0")\r\n');
            ctx.ok('ID completed');
        },
        NAMESPACE(ctx) {
            ctx.write('* NAMESPACE (("" "/")) NIL NIL\r\n');
            ctx.ok('NAMESPACE completed');
        },
        ENABLE(ctx) {
            ctx.write('* ENABLED CONDSTORE\r\n');
            ctx.ok('ENABLE completed');
        },
        LOGIN(ctx) {
            ctx.ok('LOGIN completed');
        },
        COMPRESS(ctx) {
            ctx.no('COMPRESS not available');
        },
        SELECT(ctx) {
            ctx.write('* 3 EXISTS\r\n');
            ctx.write('* 0 RECENT\r\n');
            ctx.write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n');
            ctx.write('* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] Limited\r\n');
            ctx.write('* OK [UIDVALIDITY 12345] UIDs valid\r\n');
            ctx.write('* OK [UIDNEXT 100] Predicted next UID\r\n');
            ctx.write('* OK [HIGHESTMODSEQ 1000] Highest\r\n');
            ctx.ok('[READ-WRITE] SELECT completed');
        },
        EXAMINE(ctx) {
            ctx.write('* 3 EXISTS\r\n');
            ctx.write('* OK [UIDVALIDITY 12345] UIDs valid\r\n');
            ctx.write('* OK [UIDNEXT 100] Predicted next UID\r\n');
            ctx.ok('[READ-ONLY] EXAMINE completed');
        },
        LIST(ctx) {
            ctx.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
            ctx.write('* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n');
            ctx.ok('LIST completed');
        },
        LSUB(ctx) {
            ctx.write('* LSUB (\\HasNoChildren) "/" "INBOX"\r\n');
            ctx.ok('LSUB completed');
        },
        STATUS(ctx) {
            ctx.write('* STATUS "INBOX" (MESSAGES 3 UIDNEXT 100 UIDVALIDITY 12345 UNSEEN 1)\r\n');
            ctx.ok('STATUS completed');
        },
        NOOP(ctx) {
            ctx.ok('NOOP completed');
        },
        LOGOUT(ctx) {
            ctx.write('* BYE Logging out\r\n');
            ctx.ok('LOGOUT completed');
        },
        SEARCH(ctx) {
            ctx.write('* SEARCH 1 2 3\r\n');
            ctx.ok('SEARCH completed');
        },
        CREATE(ctx) {
            ctx.ok('CREATE completed');
        },
        DELETE(ctx) {
            ctx.ok('DELETE completed');
        },
        RENAME(ctx) {
            ctx.ok('RENAME completed');
        },
        SUBSCRIBE(ctx) {
            ctx.ok('SUBSCRIBE completed');
        },
        UNSUBSCRIBE(ctx) {
            ctx.ok('UNSUBSCRIBE completed');
        }
    };

    const handlers = Object.assign({}, defaults, options.handlers || {});

    const server = net.createServer(socket => {
        socket.setNoDelay(true);
        socket.on('error', () => {});
        if (options.onConnect) {
            options.onConnect(socket);
        }
        if (greeting) {
            socket.write(greeting);
        }

        let buf = Buffer.alloc(0);
        let literalRemaining = 0;
        let cmdPrefix = '';

        const dispatch = fullLine => {
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
                write: str => socket.write(str),
                ok: text => socket.write(`${tag} OK ${text || 'completed'}\r\n`),
                no: text => socket.write(`${tag} NO ${text || 'failed'}\r\n`),
                bad: text => socket.write(`${tag} BAD ${text || 'bad'}\r\n`)
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

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const makeClient = (port, overrides = {}) =>
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

module.exports['Server: full connect + session + logout'] = async test => {
    let server = createServer();
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();
    test.ok(client.authenticated, 'authenticated');
    test.ok(client.usable, 'usable');
    test.ok(client.capabilities.has('IMAP4rev1'));
    test.ok(client.serverInfo || client.namespace, 'namespace set');

    await client.logout();
    test.equal(client.state, client.states.LOGOUT);

    client.close();
    server.close();
    test.done();
};

module.exports['Server: qresync option adds QRESYNC to ENABLE'] = async test => {
    let enabledArgs = null;
    let server = createServer({
        capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE CONDSTORE QRESYNC',
        handlers: {
            ENABLE(ctx) {
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
    test.ok(/QRESYNC/.test(enabledArgs || ''), 'QRESYNC requested in ENABLE');

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: connect runs NOOP and LIST'] = async test => {
    let server = createServer();
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();
    await client.noop();
    let folders = await client.list();
    test.ok(folders.length >= 2);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: enable compression negotiation (server declines)'] = async test => {
    let server = createServer();
    let port = await listen(server);
    // disableCompression false -> client issues COMPRESS, server says NO
    let client = makeClient(port, { disableCompression: false });
    client.on('error', () => {});

    await client.connect();
    test.ok(client.usable);
    test.ok(!client._deflate, 'compression not enabled when server declines');

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: AUTHENTICATE LOGIN flow'] = async test => {
    let server = createServer({
        capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE AUTH=LOGIN',
        handlers: {
            AUTHENTICATE(ctx) {
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
    test.ok(client.authenticated);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: SELECT, SEARCH, STORE and EXPUNGE via run'] = async test => {
    let server = createServer({
        handlers: {
            STORE(ctx) {
                ctx.write('* 1 FETCH (FLAGS (\\Seen))\r\n');
                ctx.ok('STORE completed');
            },
            EXPUNGE(ctx) {
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
    test.equal(mailbox.exists, 3);

    let found = await client.search({ seen: true }, { uid: false });
    test.deepEqual(found, [1, 2, 3]);

    let stored = await client.messageFlagsAdd('1', ['\\Seen']);
    test.ok(stored);

    let expungeEvents = [];
    client.on('expunge', e => expungeEvents.push(e));
    await client.messageDelete('1', { uid: false });
    test.ok(expungeEvents.length >= 1);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: FETCH via fetchOne'] = async test => {
    let server = createServer({
        handlers: {
            FETCH(ctx) {
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
    let msg = await client.fetchOne('1', { uid: true, flags: true, size: true });
    test.equal(msg.uid, 11);
    test.equal(msg.size, 42);
    test.ok(msg.flags.has('\\Seen'));

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: APPEND with synchronizing literal'] = async test => {
    let server = createServer({
        capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE UIDPLUS',
        handlers: {
            APPEND(ctx) {
                ctx.ok('[APPENDUID 12345 9] APPEND completed');
            }
        }
    });
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();
    let res = await client.append('INBOX', 'Subject: hi\r\n\r\nbody', ['\\Seen']);
    test.ok(res);
    test.equal(res.uid, 9);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: AUTHENTICATE PLAIN flow'] = async test => {
    let server = createServer({
        capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE AUTH=PLAIN',
        handlers: {
            AUTHENTICATE(ctx) {
                ctx.write('+ \r\n');
                ctx.socket.once('data', () => ctx.ok('AUTHENTICATE completed'));
            }
        }
    });
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();
    test.ok(client.authenticated);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: AUTHENTICATE XOAUTH2 with accessToken'] = async test => {
    let server = createServer({
        capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE AUTH=XOAUTH2',
        handlers: {
            AUTHENTICATE(ctx) {
                ctx.ok('AUTHENTICATE completed');
            }
        }
    });
    let port = await listen(server);
    let client = makeClient(port, { auth: { user: 'test', accessToken: 'token-123' } });
    client.on('error', () => {});

    await client.connect();
    test.ok(client.authenticated);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: backslash username forces LOGIN method'] = async test => {
    let loginUsed = false;
    let server = createServer({
        capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE AUTH=PLAIN',
        handlers: {
            LOGIN(ctx) {
                loginUsed = true;
                ctx.ok('LOGIN completed');
            }
        }
    });
    let port = await listen(server);
    let client = makeClient(port, { auth: { user: 'domain\\user', pass: 'secret' } });
    client.on('error', () => {});

    await client.connect();
    test.ok(client.authenticated);
    test.ok(loginUsed, 'used LOGIN command despite AUTH=PLAIN');

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: LOGINDISABLED rejects connect'] = async test => {
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
    test.ok(err, 'connect rejected when login disabled');

    client.close();
    server.close();
    test.done();
};

module.exports['Server: missing auth config rejects connect'] = async test => {
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
    test.ok(err, 'connect rejected without auth');

    client.close();
    server.close();
    test.done();
};

module.exports['Server: auth without password rejects connect'] = async test => {
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
    test.ok(err, 'connect rejected without password');

    client.close();
    server.close();
    test.done();
};

module.exports['Server: command returning NO rejects with responseStatus'] = async test => {
    let server = createServer({
        handlers: {
            CREATE(ctx) {
                ctx.no('Mailbox already exists');
            }
        }
    });
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();
    let err = null;
    try {
        await client.mailboxCreate('Existing');
    } catch (e) {
        err = e;
    }
    test.ok(err);
    test.equal(err.responseStatus, 'NO');

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: command returning BAD rejects'] = async test => {
    let server = createServer({
        handlers: {
            CREATE(ctx) {
                ctx.bad('Invalid arguments');
            }
        }
    });
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();
    let err = null;
    try {
        await client.mailboxCreate('Whatever');
    } catch (e) {
        err = e;
    }
    test.ok(err);
    test.equal(err.responseStatus, 'BAD');

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: verifyOnly connect lists mailboxes and logs out'] = async test => {
    let server = createServer();
    let port = await listen(server);
    let client = makeClient(port, { verifyOnly: true, includeMailboxes: true });
    client.on('error', () => {});

    await client.connect();
    test.ok(Array.isArray(client._mailboxList), 'mailbox list captured');
    test.ok(client._mailboxList.length >= 1);
    // verifyOnly logs out at the end of startSession
    test.equal(client.state, client.states.LOGOUT);

    client.close();
    server.close();
    test.done();
};

module.exports['Server: ID is re-requested after login when first response is sparse'] = async test => {
    let idCalls = 0;
    let server = createServer({
        handlers: {
            ID(ctx) {
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
    test.ok(idCalls >= 2, 'ID requested again after login');

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: NAMESPACE BAD with auth message surfaces auth failure'] = async test => {
    let server = createServer({
        handlers: {
            NAMESPACE(ctx) {
                ctx.bad('User is authenticated but not connected');
            }
        }
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
    test.ok(err, 'connect rejected');
    test.ok(/Authentication failed/i.test(err.message) || err.authenticationFailed, 'reported as auth failure');

    client.close();
    server.close();
    test.done();
};

module.exports['Server: getMailboxLock selects and releases'] = async test => {
    let server = createServer();
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();
    let lock = await client.getMailboxLock('INBOX');
    test.equal(client.mailbox.path, 'INBOX');
    lock.release();

    // second lock on same mailbox -> fast path
    let lock2 = await client.getMailboxLock('INBOX');
    lock2.release();

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: getMailboxLock rejects for missing mailbox'] = async test => {
    let server = createServer({
        handlers: {
            SELECT(ctx) {
                ctx.no('Mailbox does not exist');
            },
            LIST(ctx) {
                // empty LIST -> mailbox confirmed missing
                ctx.ok('LIST completed');
            }
        }
    });
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();
    let err = null;
    try {
        await client.getMailboxLock('Missing');
    } catch (e) {
        err = e;
    }
    test.ok(err);
    test.ok(err.mailboxMissing, 'flagged as missing mailbox');

    client.close();
    server.close();
    test.done();
};

module.exports['Server: IDLE then break out'] = async test => {
    test.expect(2);
    let idleTag = null;
    let doneReceived = false;
    // Capabilities MUST advertise IDLE, otherwise the client falls back to NOOP polling
    // and never sends an IDLE command at all.
    let server = createServer({
        capabilities: 'IMAP4rev1 IDLE ID ENABLE NAMESPACE UIDPLUS CONDSTORE MOVE QUOTA',
        handlers: {
            IDLE(ctx) {
                // Remember the IDLE command tag so the matching DONE can complete it.
                idleTag = ctx.tag;
                ctx.write('+ idling\r\n');
            },
            DONE(ctx) {
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

    test.ok(doneReceived, 'server received the DONE continuation');
    test.equal(client.idling, false, 'client left the IDLE state');

    client.close();
    server.close();
    test.done();
};

module.exports['Server: stats counts bytes'] = async test => {
    let server = createServer();
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();
    let stats = client.stats();
    test.ok(stats.sent > 0);
    test.ok(stats.received > 0);

    let stats2 = client.stats(true); // reset
    test.ok(stats2.sent >= 0);
    let stats3 = client.stats();
    test.equal(stats3.sent, 0);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: PREAUTH greeting skips login'] = async test => {
    let server = createServer({
        greeting: '* PREAUTH [CAPABILITY IMAP4rev1 ID ENABLE NAMESPACE] already authenticated\r\n'
    });
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();
    test.equal(client.state, client.states.AUTHENTICATED);
    test.ok(client.usable);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: unsolicited EXISTS and VANISHED reach the untagged handlers'] = async test => {
    let server = createServer({
        capabilities: 'IMAP4rev1 ID ENABLE NAMESPACE QRESYNC',
        handlers: {
            NOOP(ctx) {
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

    let existsEvent = null;
    let expungeEvents = [];
    client.on('exists', e => {
        existsEvent = e;
    });
    client.on('expunge', e => expungeEvents.push(e));

    await client.noop();
    // allow the untagged handlers to run
    await new Promise(r => setTimeout(r, 20));

    test.ok(existsEvent, 'EXISTS handler fired');
    test.equal(existsEvent.count, 5);
    test.ok(expungeEvents.length >= 1, 'VANISHED handler fired');
    test.equal(expungeEvents[0].vanished, true);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: invalid tagged response rejects with InvalidResponse'] = async test => {
    let server = createServer({
        handlers: {
            CREATE(ctx) {
                // a tagged response whose command is neither OK/NO/BAD
                ctx.write(`${ctx.tag} WEIRD unexpected status\r\n`);
            }
        }
    });
    let port = await listen(server);
    let client = makeClient(port);
    client.on('error', () => {});

    await client.connect();
    let err = null;
    try {
        await client.mailboxCreate('Whatever');
    } catch (e) {
        err = e;
    }
    test.ok(err);
    test.equal(err.code, 'InvalidResponse');

    client.close();
    server.close();
    test.done();
};

module.exports['Server: reader tolerates an unparseable untagged line'] = async test => {
    let server = createServer({
        handlers: {
            NOOP(ctx) {
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
    test.ok(true);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: reader yields to event loop on many untagged responses'] = async test => {
    let server = createServer({
        handlers: {
            STORE(ctx) {
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
    test.ok(ok);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

module.exports['Server: partial FETCH NO is treated as success'] = async test => {
    let server = createServer({
        handlers: {
            FETCH(ctx) {
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
    test.ok(msg);
    test.equal(msg.uid, 1);

    await client.logout();
    client.close();
    server.close();
    test.done();
};

// NB: the socket-timeout -> NOOP/IDLE recovery handler is covered deterministically
// in imap-flow-coverage-test.js (the _socketTimeout tests) rather than via a flaky
// real-clock socket timeout here.

module.exports['Server: greeting timeout rejects connect'] = async test => {
    // Server accepts the socket but never sends a greeting
    let server = net.createServer(socket => {
        socket.on('error', () => {});
        // intentionally silent
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let port = server.address().port;

    let client = makeClient(port, { greetingTimeout: 100 });
    client.on('error', () => {});

    let err = null;
    try {
        await client.connect();
    } catch (e) {
        err = e;
    }
    test.ok(err);
    test.equal(err.code, 'GREETING_TIMEOUT');

    client.close();
    server.close();
    test.done();
};

module.exports['Server: connection timeout rejects connect'] = async test => {
    // 192.0.2.0/24 (TEST-NET-1, RFC 5737) is reserved and never answers, so the TCP
    // connect hangs until the (very short) connection timeout fires.
    let client = makeClient(9, { host: '192.0.2.1', connectionTimeout: 120 });
    client.on('error', () => {});

    let err = null;
    try {
        await client.connect();
    } catch (e) {
        err = e;
    }
    test.ok(err, 'connect rejected');
    test.equal(err.code, 'CONNECT_TIMEOUT');

    client.close();
    test.done();
};

module.exports['Server: proxy connection failure rejects connect'] = async test => {
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
    test.ok(err, 'connect rejected on proxy failure');

    client.close();
    test.done();
};

module.exports['Server: socket close triggers close handling'] = async test => {
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
    client.socket.destroy();

    await new Promise(r => setTimeout(r, 60));
    test.ok(closed || client.isClosed, 'connection closed');
    client.close();
    test.done();
};
