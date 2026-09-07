import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../src/imap-flow.js';
import { makeSocketStub } from './fixtures/test-client.js';

// Targeted coverage for ImapFlow internals that need precise state setups:
// the lock queue processor (processLocks), authentication fallbacks, and a few
// reader/handler error branches.

const makeClient = (overrides = {}) => {
    let client: any = new ImapFlow({
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
// reader() error branches (handlers throwing must not break the loop)
// ============================================================================

// Helper: drive reader() over a fixed list of pre-built data items.
const runReaderWith = async (client: any, payloads: any) => {
    let items = payloads.map((p: any) => ({ payload: Buffer.from(p), literals: [], next: () => {} }));
    let idx = 0;
    client.streamer = { read: () => (idx < items.length ? items[idx++] : null) };
    await client.reader();
    return idx;
};

describe('imap-flow-coverage', () => {
    // ============================================================================
    // processLocks
    // ============================================================================
    it('Coverage: processLocks is re-entrant safe (already processing)', async () => {
        let client = makeClient();
        let resolveOpen: any;
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
        assert.ok(lockA);

        // Releasing A lets B be processed; B opens a different mailbox
        client.mailboxOpen = async () => {
            client.mailbox = { path: 'B', readOnly: false };
            return { path: 'B' };
        };
        lockA.release();
        let lockB = await lockBPromise;
        assert.ok(lockB);
        lockB.release();
        await drain();
    });
    it('Coverage: processLocks yields to the event loop on many failing locks', async () => {
        let client = makeClient();
        client.usable = false; // every lock fails immediately via the NoConnection path

        let promises = [];
        for (let i = 0; i < 7; i++) {
            promises.push(client.getMailboxLock('M' + i).catch((err: any) => err));
        }
        let results = await Promise.all(promises);
        assert.equal(results.length, 7);
        results.forEach(r => assert.equal(r.code, 'NoConnection'));
    });
    it('Coverage: processLocks marks mailbox missing when SELECT NO and LIST verify throws', async () => {
        let client = makeClient();
        client.mailboxOpen = async () => {
            let err = new Error('SELECT failed');
            (err as any).responseStatus = 'NO';
            throw err;
        };
        // run('LIST') used to verify existence throws -> inner catch (3849-3850)
        client.run = async () => {
            throw new Error('LIST blew up');
        };
        let err: any = null;
        try {
            await client.getMailboxLock('Ghost');
        } catch (e) {
            err = e;
        }
        assert.ok(err);
        assert.equal((err as any).responseStatus, 'NO');
    });
    it('Coverage: processLocks marks mailboxMissing when LIST returns empty', async () => {
        let client = makeClient();
        client.mailboxOpen = async () => {
            let err = new Error('SELECT failed');
            (err as any).responseStatus = 'NO';
            throw err;
        };
        client.run = async () => []; // empty LIST -> mailbox confirmed missing
        let err: any = null;
        try {
            await client.getMailboxLock('Ghost');
        } catch (e) {
            err = e;
        }
        assert.ok(err.mailboxMissing as any);
    });
    it('Coverage: processLocks yields after 5 processed locks', async () => {
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
        assert.equal(rejects, 6);
    });
    it('Coverage: getMailboxLock includes description in trace logs', async () => {
        let client = makeClient();
        client.mailbox = { path: 'INBOX', readOnly: false };
        // a description on the lock options exercises the `...(options.description && {...})` spreads
        let lock = await client.getMailboxLock('INBOX', { description: 'my work' });
        assert.ok(lock);
        lock.release();
        await drain();
    });
    it('Coverage: processLocks logs active lock and returns when already processing', async () => {
        let client = makeClient();
        client.mailbox = { path: 'INBOX' }; // so the log records the active mailbox path
        client.processingLock = true; // simulate a concurrent processor
        client.currentLock = { lockId: 7, options: { description: 'held lock' } };
        // returns immediately after logging the active lock details
        await client.processLocks();
        assert.ok(true);
    });

    // ============================================================================
    // close() internal error handling
    // ============================================================================
    it('Coverage: close swallows streamer cleanup errors', () => {
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
        assert.ok(true);
    });
    it('Coverage: close swallows top-level errors', () => {
        let client = makeClient();
        // folders.clear() throws -> the outer try/catch in close() handles it
        client.folders = {
            clear() {
                throw new Error('folders boom');
            }
        };
        client.close();
        assert.ok(true);
    });
    it('Coverage: lock acquired via SELECT logs description', async () => {
        let client = makeClient();
        client.mailbox = false; // force the SELECT/EXAMINE path
        client.mailboxOpen = async (path: any) => {
            client.mailbox = { path, readOnly: false } as any;
            return { path };
        };
        let lock = await client.getMailboxLock('Work', { description: 'selected-path lock' });
        assert.equal((client.mailbox as any).path, 'Work');
        lock.release();
        await drain();
    });
    it('Coverage: lock failure logs description', async () => {
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
        assert.ok(err);
    });
    it('Coverage: getMailboxLock logs active lock description while one is held', () => {
        let client = makeClient();
        // a held lock carrying a description exercises the activeLock spread in the request log
        client.currentLock = { lockId: 1, options: { description: 'currently held' } };
        let p = client.getMailboxLock('Queued', { description: 'queued lock' });
        p.catch(() => {}); // it will never resolve (held lock blocks); just exercise the log
        assert.ok(p && typeof p.then === 'function');
        client.close();
    });

    // ============================================================================
    // initialOK / serverBye fallbacks
    // ============================================================================
    it('Coverage: initialOK tolerates a greeting with no attributes', async () => {
        let client = makeClient();
        client.isClosed = true; // so beginSession short-circuits without starting a session
        await client.initialOK({}); // no .attributes -> (message.attributes || [])
        assert.equal(client.greeting, '');
    });
    it('Coverage: serverBye defaults the reason when none is given', async () => {
        let client = makeClient();
        await client.serverBye({}); // no attributes -> reason falls back to the default
        assert.equal(client.byeReason, 'Server closed connection');
    });

    // ============================================================================
    // authenticate fallbacks
    // ============================================================================
    it('Coverage: authenticate throws when state is LOGOUT', async () => {
        let client = makeClient();
        client.state = client.states.LOGOUT;
        let err = null;
        try {
            await client.authenticate();
        } catch (e) {
            err = e;
        }
        assert.ok(err);
    });
    it('Coverage: authenticate returns true when already authenticated', async () => {
        let client = makeClient();
        client.state = client.states.AUTHENTICATED;
        let res = await client.authenticate();
        assert.equal(res, true);
    });
    it('Coverage: authenticate throws when run yields falsy auth result', async () => {
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
        assert.ok(err);
    });

    // ============================================================================
    // Socket event handlers (built by setSocketHandlers)
    // ============================================================================
    it('Coverage: setSocketHandlers removes a lingering connect error handler', () => {
        let client = makeClient();
        let removed = null;
        client.socket = {
            destroyed: false,
            once() {},
            on() {},
            removeListener(evt: any, fn: any) {
                removed = fn;
            },
            destroy() {}
        };
        client.writeSocket = client.socket;
        let handler = () => {};
        client._connectErrorHandler = handler;
        client.setSocketHandlers();
        assert.equal(removed, handler, 'temporary connect error handler removed');
        assert.equal(client._connectErrorHandler, null);
    });
    it('Coverage: initialPREAUTH is a no-op once closed', async () => {
        let client = makeClient();
        client.isClosed = true;
        let started = false;
        client.startSession = async () => {
            started = true;
        };
        await client.initialPREAUTH();
        assert.equal(started, false);
    });
    it('Coverage: initialPREAUTH routes startSession failure to onUnhandledError', async () => {
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
        assert.equal(client.state, client.states.AUTHENTICATED);
        assert.ok(closedAfter, 'closeAfter invoked from the PREAUTH error handler');
    });
    it('Coverage: _socketError logs and emits the error', () => {
        let client = makeClient();
        client.socket = makeSocketStub();
        client.writeSocket = client.socket;
        client.setSocketHandlers();
        let emitted = null;
        client.on('error', (err: any) => {
            emitted = err;
        });
        // not connecting/upgrading -> emitError falls through to emit('error')
        client._socketError(new Error('socket failure'));
        assert.ok(emitted);
    });
    it('Coverage: _socketTimeout recovers an IDLE connection with NOOP', async () => {
        let client = makeClient();
        client.socket = makeSocketStub();
        client.writeSocket = client.socket;
        client.setSocketHandlers();
        client.idling = true;
        client.usable = true;
        let noopRun = false;
        let idleResumed = false;
        client.run = async (cmd: any) => {
            if (cmd === 'NOOP') noopRun = true;
            return true;
        };
        client.idle = async () => {
            idleResumed = true;
        };
        client._socketTimeout();
        await drain();
        await drain();
        assert.ok(noopRun, 'NOOP issued to recover IDLE');
        // Restarting IDLE is autoidle()'s decision once the NOOP settles (run() re-arms it);
        // the watchdog handler itself must not bypass the busy guard by calling idle() directly.
        assert.equal(idleResumed, false, 'the handler does not restart IDLE by itself');
    });
    it('Coverage: _socketTimeout emits error when idling but unusable', () => {
        let client = makeClient();
        client.socket = makeSocketStub();
        client.writeSocket = client.socket;
        client.setSocketHandlers();
        client.idling = true;
        client.usable = false; // cannot recover -> emitError
        let emitted: any = null;
        client.on('error', (err: any) => {
            emitted = err;
        });
        client._socketTimeout();
        assert.ok(emitted);
        assert.equal(emitted.code, 'ETIMEOUT');
    });
    it('Coverage: _socketTimeout emits error for non-IDLE operations', () => {
        let client = makeClient();
        client.socket = makeSocketStub();
        client.writeSocket = client.socket;
        client.setSocketHandlers();
        client.idling = false;
        let emitted: any = null;
        client.on('error', (err: any) => {
            emitted = err;
        });
        client._socketTimeout();
        assert.ok(emitted);
        assert.equal(emitted.code, 'ETIMEOUT');
    });
    it('Coverage: _socketTimeout IDLE recovery closes on failure', async () => {
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
        assert.ok(closed, 'connection closed after failed IDLE recovery');
    });

    // ============================================================================
    // reader() periodic event-loop yield
    // ============================================================================
    it('Coverage: reader yields after processing many items in one pass', async () => {
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
        assert.equal(idx, 12, 'all items drained in one reader pass');
    });
    it('Coverage: reader swallows a throwing onPlusTag handler', async () => {
        let client = makeClient();
        client.currentRequest = {
            options: {
                onPlusTag: async () => {
                    throw new Error('plus boom');
                }
            }
        };
        let count = await runReaderWith(client, ['+ go ahead']);
        assert.equal(count, 1);
    });
    it('Coverage: reader swallows a throwing section handler', async () => {
        let client = makeClient();
        client.sectionHandlers = {
            CAPABILITY: async () => {
                throw new Error('section boom');
            }
        };
        let count = await runReaderWith(client, ['* OK [CAPABILITY FOO] hi']);
        assert.equal(count, 1);
    });
    it('Coverage: reader swallows a throwing untagged handler', async () => {
        let client = makeClient();
        client.untaggedHandlers = {
            FOO: async () => {
                throw new Error('untagged boom');
            }
        };
        let count = await runReaderWith(client, ['* FOO bar']);
        assert.equal(count, 1);
    });
    it('Coverage: reader swallows a throwing trySend after a tagged response', async () => {
        let client = makeClient();
        let resolved = false;
        client.currentRequest = { tag: 'A1', sent: true };
        client.requestTagMap.set('A1', {
            command: 'NOOP',
            attributes: [],
            options: {},
            resolve: (arg: any) => {
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
        assert.equal(count, 1);
        assert.ok(resolved, 'request still resolved despite trySend failure');
    });
    it('Coverage: reader handles compiler failure when building executedCommand', async () => {
        let client = makeClient();
        let rejected: any = null;
        // A request whose attributes cannot be compiled -> the executedCommand try/catch is hit
        client.currentRequest = { tag: 'A1', sent: true };
        client.requestTagMap.set('A1', {
            command: 'NOOP',
            // a circular/odd attribute that makes the logging compiler throw
            attributes: [
                {
                    type: 'LITERAL',
                    get value() {
                        throw new Error('compile boom');
                    }
                }
            ],
            options: {},
            resolve: () => {},
            reject: (err: any) => {
                rejected = err;
            }
        } as any);
        await runReaderWith(client, ['A1 NO it failed']);
        assert.ok(rejected);
        assert.equal(rejected.responseStatus, 'NO');
    });
    it('Coverage: reader caps very large throttle backoff', async () => {
        let client = makeClient();
        let rejected = null;
        client.currentRequest = { tag: 'A1', sent: true };
        client.requestTagMap.set('A1', {
            command: 'FETCH',
            attributes: [],
            options: {},
            resolve: () => {},
            reject: (err: any) => {
                rejected = err;
            }
        });
        // Run the reader; immediately abort the throttle wait via close() so the test
        // does not actually wait. The large backoff value exercises the 5-minute cap.
        let readerPromise = runReaderWith(client, ['A1 BAD Request is throttled. Suggested Backoff Time: 999999999 milliseconds']);
        // give the reader a tick to register the throttle timer, then abort it
        await drain();
        for (let entry of client._throttleWaits) {
            clearTimeout(entry.timer);
            entry.resolve(true);
        }
        client._throttleWaits.clear();
        await readerPromise;
        assert.ok(rejected);
    });

    // ============================================================================
    // beginSession when already closed
    // ============================================================================
    it('Coverage: beginSession is a no-op once closed', () => {
        let client = makeClient();
        client.isClosed = true;
        let started = false;
        client.startSession = async () => {
            started = true;
        };
        client.beginSession(() => {});
        assert.equal(started, false, 'startSession not invoked when closed');
    });
});
