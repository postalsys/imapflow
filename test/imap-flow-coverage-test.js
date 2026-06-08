'use strict';

// Targeted coverage for ImapFlow internals that need precise state setups:
// the lock queue processor (processLocks), authentication fallbacks, and a few
// reader/handler error branches.

const { ImapFlow } = require('../lib/imap-flow');

const makeClient = (overrides = {}) => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' },
        logger: false,
        ...overrides
    });
    client.socket = { destroyed: false, destroy: () => {} };
    client.usable = true;
    return client;
};

const drain = () => new Promise(resolve => setImmediate(resolve));

// ============================================================================
// processLocks
// ============================================================================

module.exports['Coverage: processLocks is re-entrant safe (already processing)'] = async test => {
    let client = makeClient();
    let resolveOpen;
    // mailboxOpen blocks until we resolve it, keeping processingLock busy
    client.mailboxOpen = () =>
        new Promise(resolve => {
            resolveOpen = () => resolve({ path: 'A' });
        });

    let lockAPromise = client.getMailboxLock('A');
    await drain(); // let processLocks start and await mailboxOpen

    // Second request while the first is still being processed -> hits the
    // "already processing" early return.
    let lockBPromise = client.getMailboxLock('B');
    await drain();

    // Now let the first mailbox open complete
    client.mailbox = { path: 'A', readOnly: false };
    resolveOpen();
    let lockA = await lockAPromise;
    test.ok(lockA);

    // Releasing A lets B be processed; B opens a different mailbox
    client.mailboxOpen = async () => {
        client.mailbox = { path: 'B', readOnly: false };
        return { path: 'B' };
    };
    lockA.release();
    let lockB = await lockBPromise;
    test.ok(lockB);
    lockB.release();
    await drain();
    test.done();
};

module.exports['Coverage: processLocks yields to the event loop on many failing locks'] = async test => {
    let client = makeClient();
    client.usable = false; // every lock fails immediately via the NoConnection path

    let promises = [];
    for (let i = 0; i < 7; i++) {
        promises.push(client.getMailboxLock('M' + i).catch(err => err));
    }
    let results = await Promise.all(promises);
    test.equal(results.length, 7);
    results.forEach(r => test.equal(r.code, 'NoConnection'));
    test.done();
};

module.exports['Coverage: processLocks marks mailbox missing when SELECT NO and LIST verify throws'] = async test => {
    let client = makeClient();
    client.mailboxOpen = async () => {
        let err = new Error('SELECT failed');
        err.responseStatus = 'NO';
        throw err;
    };
    // run('LIST') used to verify existence throws -> inner catch (3849-3850)
    client.run = async () => {
        throw new Error('LIST blew up');
    };
    let err = null;
    try {
        await client.getMailboxLock('Ghost');
    } catch (e) {
        err = e;
    }
    test.ok(err);
    test.equal(err.responseStatus, 'NO');
    test.done();
};

module.exports['Coverage: processLocks marks mailboxMissing when LIST returns empty'] = async test => {
    let client = makeClient();
    client.mailboxOpen = async () => {
        let err = new Error('SELECT failed');
        err.responseStatus = 'NO';
        throw err;
    };
    client.run = async () => []; // empty LIST -> mailbox confirmed missing
    let err = null;
    try {
        await client.getMailboxLock('Ghost');
    } catch (e) {
        err = e;
    }
    test.ok(err.mailboxMissing);
    test.done();
};

module.exports['Coverage: processLocks yields after 5 processed locks'] = async test => {
    let client = makeClient();
    client.usable = false; // each queued lock fails and continues
    let rejects = 0;
    for (let i = 0; i < 6; i++) {
        client.locks.push({
            resolve: () => {},
            reject: () => {
                rejects++;
            },
            path: 'P',
            options: {},
            lockId: i
        });
    }
    await client.processLocks();
    test.equal(rejects, 6);
    test.done();
};

module.exports['Coverage: getMailboxLock includes description in trace logs'] = async test => {
    let client = makeClient();
    client.mailbox = { path: 'INBOX', readOnly: false };
    // a description on the lock options exercises the `...(options.description && {...})` spreads
    let lock = await client.getMailboxLock('INBOX', { description: 'my work' });
    test.ok(lock);
    lock.release();
    await drain();
    test.done();
};

module.exports['Coverage: processLocks logs active lock and returns when already processing'] = async test => {
    let client = makeClient();
    client.mailbox = { path: 'INBOX' }; // so the log records the active mailbox path
    client.processingLock = true; // simulate a concurrent processor
    client.currentLock = { lockId: 7, options: { description: 'held lock' } };
    // returns immediately after logging the active lock details
    await client.processLocks();
    test.ok(true);
    test.done();
};

// ============================================================================
// close() internal error handling
// ============================================================================

module.exports['Coverage: close swallows streamer cleanup errors'] = test => {
    let client = makeClient();
    client.streamer = {
        removeListener() {},
        destroyed: false,
        destroy() {
            throw new Error('streamer destroy boom');
        }
    };
    // Should not throw despite the streamer.destroy failure
    client.close();
    test.ok(true);
    test.done();
};

module.exports['Coverage: close swallows top-level errors'] = test => {
    let client = makeClient();
    // folders.clear() throws -> the outer try/catch in close() handles it
    client.folders = {
        clear() {
            throw new Error('folders boom');
        }
    };
    client.close();
    test.ok(true);
    test.done();
};

module.exports['Coverage: lock acquired via SELECT logs description'] = async test => {
    let client = makeClient();
    client.mailbox = false; // force the SELECT/EXAMINE path
    client.mailboxOpen = async path => {
        client.mailbox = { path, readOnly: false };
        return { path };
    };
    let lock = await client.getMailboxLock('Work', { description: 'selected-path lock' });
    test.equal(client.mailbox.path, 'Work');
    lock.release();
    await drain();
    test.done();
};

module.exports['Coverage: lock failure logs description'] = async test => {
    let client = makeClient();
    client.mailbox = false;
    client.mailboxOpen = async () => {
        throw new Error('cannot open');
    };
    let err = null;
    try {
        await client.getMailboxLock('Bad', { description: 'failing lock' });
    } catch (e) {
        err = e;
    }
    test.ok(err);
    test.done();
};

module.exports['Coverage: getMailboxLock logs active lock description while one is held'] = test => {
    let client = makeClient();
    // a held lock carrying a description exercises the activeLock spread in the request log
    client.currentLock = { lockId: 1, options: { description: 'currently held' } };
    let p = client.getMailboxLock('Queued', { description: 'queued lock' });
    p.catch(() => {}); // it will never resolve (held lock blocks); just exercise the log
    test.ok(p && typeof p.then === 'function');
    client.close(); // rejects the queued lock and cleans up
    test.done();
};

// ============================================================================
// initialOK / serverBye fallbacks
// ============================================================================

module.exports['Coverage: initialOK tolerates a greeting with no attributes'] = async test => {
    let client = makeClient();
    client.isClosed = true; // so beginSession short-circuits without starting a session
    await client.initialOK({}); // no .attributes -> (message.attributes || [])
    test.equal(client.greeting, '');
    test.done();
};

module.exports['Coverage: serverBye defaults the reason when none is given'] = async test => {
    let client = makeClient();
    await client.serverBye({}); // no attributes -> reason falls back to the default
    test.equal(client.byeReason, 'Server closed connection');
    test.done();
};

// ============================================================================
// authenticate fallbacks
// ============================================================================

module.exports['Coverage: authenticate throws when state is LOGOUT'] = async test => {
    let client = makeClient();
    client.state = client.states.LOGOUT;
    let err = null;
    try {
        await client.authenticate();
    } catch (e) {
        err = e;
    }
    test.ok(err);
    test.done();
};

module.exports['Coverage: authenticate returns true when already authenticated'] = async test => {
    let client = makeClient();
    client.state = client.states.AUTHENTICATED;
    let res = await client.authenticate();
    test.equal(res, true);
    test.done();
};

module.exports['Coverage: authenticate throws when run yields falsy auth result'] = async test => {
    let client = makeClient();
    client.state = client.states.NOT_AUTHENTICATED;
    client.capabilities = new Map(); // no AUTH= -> LOGIN path
    client.run = async () => false; // LOGIN returns falsy -> "No matching authentication method"
    let err = null;
    try {
        await client.authenticate();
    } catch (e) {
        err = e;
    }
    test.ok(err);
    test.done();
};

// ============================================================================
// Socket event handlers (built by setSocketHandlers)
// ============================================================================

// Minimal socket stub that records listeners so handlers can be invoked directly.
const makeSocketStub = () => ({
    destroyed: false,
    once() {},
    on() {},
    removeListener() {},
    destroy() {}
});

module.exports['Coverage: setSocketHandlers removes a lingering connect error handler'] = test => {
    let client = makeClient();
    let removed = null;
    client.socket = {
        destroyed: false,
        once() {},
        on() {},
        removeListener(evt, fn) {
            removed = fn;
        },
        destroy() {}
    };
    client.writeSocket = client.socket;
    let handler = () => {};
    client._connectErrorHandler = handler;
    client.setSocketHandlers();
    test.equal(removed, handler, 'temporary connect error handler removed');
    test.equal(client._connectErrorHandler, null);
    test.done();
};

module.exports['Coverage: initialPREAUTH is a no-op once closed'] = async test => {
    let client = makeClient();
    client.isClosed = true;
    let started = false;
    client.startSession = async () => {
        started = true;
    };
    await client.initialPREAUTH();
    test.equal(started, false);
    test.done();
};

module.exports['Coverage: initialPREAUTH routes startSession failure to onUnhandledError'] = async test => {
    let client = makeClient();
    client.initialResolve = false;
    client.initialReject = false; // no pending connect promise -> fall through to onUnhandledError
    client.startSession = async () => {
        throw new Error('session boom');
    };
    let closedAfter = false;
    client.closeAfter = () => {
        closedAfter = true;
    };
    await client.initialPREAUTH();
    await drain();
    await drain();
    test.equal(client.state, client.states.AUTHENTICATED);
    test.ok(closedAfter, 'closeAfter invoked from the PREAUTH error handler');
    test.done();
};

module.exports['Coverage: _socketError logs and emits the error'] = test => {
    let client = makeClient();
    client.socket = makeSocketStub();
    client.writeSocket = client.socket;
    client.setSocketHandlers();
    let emitted = null;
    client.on('error', err => {
        emitted = err;
    });
    // not connecting/upgrading -> emitError falls through to emit('error')
    client._socketError(new Error('socket failure'));
    test.ok(emitted);
    test.done();
};

module.exports['Coverage: _socketTimeout recovers an IDLE connection with NOOP'] = async test => {
    let client = makeClient();
    client.socket = makeSocketStub();
    client.writeSocket = client.socket;
    client.setSocketHandlers();
    client.idling = true;
    client.usable = true;
    let noopRun = false;
    let idleResumed = false;
    client.run = async cmd => {
        if (cmd === 'NOOP') noopRun = true;
        return true;
    };
    client.idle = async () => {
        idleResumed = true;
    };
    client._socketTimeout();
    await drain();
    await drain();
    test.ok(noopRun, 'NOOP issued to recover IDLE');
    test.ok(idleResumed, 'IDLE resumed after NOOP');
    test.done();
};

module.exports['Coverage: _socketTimeout emits error when idling but unusable'] = test => {
    let client = makeClient();
    client.socket = makeSocketStub();
    client.writeSocket = client.socket;
    client.setSocketHandlers();
    client.idling = true;
    client.usable = false; // cannot recover -> emitError
    let emitted = null;
    client.on('error', err => {
        emitted = err;
    });
    client._socketTimeout();
    test.ok(emitted);
    test.equal(emitted.code, 'ETIMEOUT');
    test.done();
};

module.exports['Coverage: _socketTimeout emits error for non-IDLE operations'] = test => {
    let client = makeClient();
    client.socket = makeSocketStub();
    client.writeSocket = client.socket;
    client.setSocketHandlers();
    client.idling = false;
    let emitted = null;
    client.on('error', err => {
        emitted = err;
    });
    client._socketTimeout();
    test.ok(emitted);
    test.equal(emitted.code, 'ETIMEOUT');
    test.done();
};

module.exports['Coverage: _socketTimeout IDLE recovery closes on failure'] = async test => {
    let client = makeClient();
    client.socket = makeSocketStub();
    client.writeSocket = client.socket;
    client.setSocketHandlers();
    client.idling = true;
    client.usable = true;
    client.run = async () => {
        throw new Error('NOOP failed');
    };
    let closed = false;
    client.close = () => {
        closed = true;
    };
    client._socketTimeout();
    await drain();
    await drain();
    test.ok(closed, 'connection closed after failed IDLE recovery');
    test.done();
};

// ============================================================================
// reader() periodic event-loop yield
// ============================================================================

module.exports['Coverage: reader yields after processing many items in one pass'] = async test => {
    let client = makeClient();
    client.mailbox = { path: 'INBOX', exists: 0 };
    // Queue 12 untagged EXISTS responses so a single reader() pass processes >10
    // items and hits the periodic `await setImmediate` yield.
    let items = [];
    for (let i = 1; i <= 12; i++) {
        items.push({ payload: Buffer.from(`* ${i} EXISTS`), literals: [], next: () => {} });
    }
    let idx = 0;
    client.streamer = {
        read: () => (idx < items.length ? items[idx++] : null)
    };
    client.on('exists', () => {});
    await client.reader();
    test.equal(idx, 12, 'all items drained in one reader pass');
    test.done();
};

// ============================================================================
// reader() error branches (handlers throwing must not break the loop)
// ============================================================================

// Helper: drive reader() over a fixed list of pre-built data items.
const runReaderWith = async (client, payloads) => {
    let items = payloads.map(p => ({ payload: Buffer.from(p), literals: [], next: () => {} }));
    let idx = 0;
    client.streamer = { read: () => (idx < items.length ? items[idx++] : null) };
    await client.reader();
    return idx;
};

module.exports['Coverage: reader swallows a throwing onPlusTag handler'] = async test => {
    let client = makeClient();
    client.currentRequest = {
        options: {
            onPlusTag: async () => {
                throw new Error('plus boom');
            }
        }
    };
    let count = await runReaderWith(client, ['+ go ahead']);
    test.equal(count, 1);
    test.done();
};

module.exports['Coverage: reader swallows a throwing section handler'] = async test => {
    let client = makeClient();
    client.sectionHandlers = {
        CAPABILITY: async () => {
            throw new Error('section boom');
        }
    };
    let count = await runReaderWith(client, ['* OK [CAPABILITY FOO] hi']);
    test.equal(count, 1);
    test.done();
};

module.exports['Coverage: reader swallows a throwing untagged handler'] = async test => {
    let client = makeClient();
    client.untaggedHandlers = {
        FOO: async () => {
            throw new Error('untagged boom');
        }
    };
    let count = await runReaderWith(client, ['* FOO bar']);
    test.equal(count, 1);
    test.done();
};

module.exports['Coverage: reader swallows a throwing trySend after a tagged response'] = async test => {
    let client = makeClient();
    let resolved = false;
    client.currentRequest = { tag: 'A1' };
    client.requestTagMap.set('A1', {
        command: 'NOOP',
        attributes: [],
        options: {},
        resolve: arg => {
            resolved = true;
            // the reader awaits arg.next(); call it so the loop proceeds
            arg.next();
        },
        reject: () => {}
    });
    client.trySend = async () => {
        throw new Error('trySend boom');
    };
    let count = await runReaderWith(client, ['A1 OK done']);
    test.equal(count, 1);
    test.ok(resolved, 'request still resolved despite trySend failure');
    test.done();
};

module.exports['Coverage: reader handles compiler failure when building executedCommand'] = async test => {
    let client = makeClient();
    let rejected = null;
    // A request whose attributes cannot be compiled -> the executedCommand try/catch is hit
    client.currentRequest = { tag: 'A1' };
    client.requestTagMap.set('A1', {
        command: 'NOOP',
        // a circular/odd attribute that makes the logging compiler throw
        attributes: [{ type: 'LITERAL', get value() { throw new Error('compile boom'); } }],
        options: {},
        resolve: () => {},
        reject: err => {
            rejected = err;
        }
    });
    await runReaderWith(client, ['A1 NO it failed']);
    test.ok(rejected);
    test.equal(rejected.responseStatus, 'NO');
    test.done();
};

module.exports['Coverage: reader caps very large throttle backoff'] = async test => {
    let client = makeClient();
    let rejected = null;
    client.currentRequest = { tag: 'A1' };
    client.requestTagMap.set('A1', {
        command: 'FETCH',
        attributes: [],
        options: {},
        resolve: () => {},
        reject: err => {
            rejected = err;
        }
    });
    // Run the reader; immediately abort the throttle wait via close() so the test
    // does not actually wait. The large backoff value exercises the 5-minute cap.
    let readerPromise = runReaderWith(client, ['A1 BAD Request is throttled. Suggested Backoff Time: 999999999 milliseconds']);
    // give the reader a tick to register the throttle timer, then abort it
    await drain();
    if (typeof client._throttleAbort === 'function') {
        client._throttleAbort(true);
    }
    await readerPromise;
    test.ok(rejected);
    test.done();
};

// ============================================================================
// beginSession when already closed
// ============================================================================

module.exports['Coverage: beginSession is a no-op once closed'] = test => {
    let client = makeClient();
    client.isClosed = true;
    let started = false;
    client.startSession = async () => {
        started = true;
    };
    client.beginSession(() => {});
    test.equal(started, false, 'startSession not invoked when closed');
    test.done();
};
