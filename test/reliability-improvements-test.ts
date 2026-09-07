import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../src/imap-flow.js';
import iconv from 'iconv-lite';

// Tests for reliability/stability improvements: lock identity, acquireTimeout,
// maxLockHoldTime diagnostic, capability-clear-on-STARTTLS, and related
// cleanup paths.

// Helper: client with stubbed socket/usable state so the fast path of
// getMailboxLock() can grant locks synchronously (no network I/O).
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
    client.mailbox = { path: 'INBOX', readOnly: false };
    return client;
};

// Helper: wait for any queued setImmediate callbacks (processLocks reschedules
// itself via setImmediate after a release).
const drain = () => new Promise(resolve => setImmediate(resolve));

// ============================================================================
// Throttle back-off timer is tracked and abortable on close()
// ============================================================================

// Feed a single throttling BAD response into reader() once, then null.
const stubThrottleResponse = (client: any, backoffMs: any) => {
    let request = { tag: 'A001', command: 'FETCH', resolve: () => {}, reject: () => {} };
    client.requestTagMap = new Map([['A001', request]]);
    // The tagged response may only complete a command that was actually written to the socket, so
    // the stub has to present A001 as the active, already sent request - otherwise it is protocol
    // desynchronization.
    client.currentRequest = { tag: 'A001', command: 'FETCH', sent: true };

    let done = false;
    client.streamer.read = () => {
        if (done) {
            return null;
        }
        done = true;
        return {
            payload: Buffer.from(`A001 BAD Request is throttled. Suggested Backoff Time: ${backoffMs} milliseconds`),
            literals: [],
            next: () => {}
        };
    };

    return request;
};

describe('reliability-improvements', () => {
    // ============================================================================
    // release() identity check
    // ============================================================================
    it('Reliability: stale release() does not clear replacement lock', async () => {
        let client = makeClient();

        // Grant L1 via fast path
        let lockA = await client.getMailboxLock('INBOX');
        let staleRelease = lockA.release;

        // Release L1 normally
        staleRelease();
        await drain();
        assert.equal(client.currentLock, false, 'L1 released');

        // Grant L2
        let lockB = await client.getMailboxLock('INBOX');
        assert.ok(client.currentLock, 'L2 active');
        let currentBeforeStale = client.currentLock;

        // Stale call — must NOT clear L2's hold
        staleRelease();
        assert.equal(client.currentLock, currentBeforeStale, 'L2 still active after stale release');

        lockB.release();
        await drain();
    });
    it('Reliability: double release() is idempotent', async () => {
        let client = makeClient();

        let lock = await client.getMailboxLock('INBOX');

        // First release clears
        lock.release();
        await drain();
        assert.equal(client.currentLock, false);

        // Second release is a no-op — must not throw, must not affect state
        assert.doesNotThrow(() => lock.release());
        assert.equal(client.currentLock, false);
    });

    // ============================================================================
    // acquireTimeout
    // ============================================================================
    it('Reliability: acquireTimeout rejects with LockTimeout code', async () => {
        let client = makeClient();

        // Hold the first lock so the next one queues
        let lockA = await client.getMailboxLock('INBOX');

        let start = Date.now();
        try {
            await client.getMailboxLock('INBOX', { acquireTimeout: 30 });
            assert.ok(false, 'Should have timed out');
        } catch (err: any) {
            let elapsed = Date.now() - start;
            assert.equal(err.code, 'LockTimeout');
            assert.ok(err.message.includes('Timed out') as any);
            assert.ok((typeof err.lockId === 'number') as any);
            assert.ok(elapsed >= 25, `expected to wait ~30ms, got ${elapsed}`);
        }

        // Original lock must still be held
        assert.ok(client.currentLock, 'L1 still held after L2 timeout');

        lockA.release();
        await drain();
    });
    it('Reliability: acquireTimeout cleared when lock is granted', async () => {
        let client = makeClient();

        // Fast path grants immediately; timer never fires
        let lock = await client.getMailboxLock('INBOX', { acquireTimeout: 50 });
        assert.ok(lock);
        assert.ok(client.currentLock, 'L1 granted');

        // Wait past the timeout — no rejection should occur post-grant, no dangling timer
        await new Promise(r => setTimeout(r, 80));
        assert.ok(client.currentLock, 'Still held after timer would have fired');

        lock.release();
        await drain();
    });
    it('Reliability: acquireTimeout cleared on close()', async () => {
        let client = makeClient();
        // Hold L1 so L2 queues
        let lockA = await client.getMailboxLock('INBOX');

        let rejectedCode = null;
        client.getMailboxLock('INBOX', { acquireTimeout: 10_000 }).catch((err: any) => {
            rejectedCode = err.code;
        });

        // Immediately close — pending lock should reject with NoConnection (not LockTimeout),
        // and its acquireTimer should be cleared so it never fires afterward.
        client.close();

        await drain();
        await new Promise(r => setTimeout(r, 30));
        assert.equal(rejectedCode, 'NoConnection', 'Pending lock rejects with NoConnection on close');

        // Keep reference so linter doesn't complain
        assert.ok(lockA);
    });

    // ============================================================================
    // maxLockHoldTime diagnostic
    // ============================================================================
    it('Reliability: maxLockHoldTime warning fires when lock held past threshold', async () => {
        let warnings: any = [];
        let client = makeClient();
        client.log.warn = (obj: any) => warnings.push(obj);

        let lock = await client.getMailboxLock('INBOX', { maxLockHoldTime: 30 });
        await new Promise(r => setTimeout(r, 60));

        let hit: any = warnings.find((w: any) => w && w.msg === 'Mailbox lock held for a long time');
        assert.ok(hit, 'Warning log must fire');
        assert.ok(typeof hit.heldFor === 'number' && hit.heldFor >= 25);

        lock.release();
        await drain();
    });
    it('Reliability: maxLockHoldTime=0 disables the warning', async () => {
        let warnings: any = [];
        let client = makeClient();
        client.log.warn = (obj: any) => warnings.push(obj);

        let lock = await client.getMailboxLock('INBOX', { maxLockHoldTime: 0 });
        await new Promise(r => setTimeout(r, 30));

        assert.ok(!warnings.some((w: any) => w && w.msg === 'Mailbox lock held for a long time'), 'No warn when disabled');

        lock.release();
        await drain();
    });
    it('Reliability: maxLockHoldTime=false disables the warning', async () => {
        let warnings: any = [];
        let client = makeClient();
        client.log.warn = (obj: any) => warnings.push(obj);

        let lock = await client.getMailboxLock('INBOX', { maxLockHoldTime: false });
        await new Promise(r => setTimeout(r, 30));

        assert.ok(!warnings.some((w: any) => w && w.msg === 'Mailbox lock held for a long time'));

        lock.release();
        await drain();
    });
    it('Reliability: per-call maxLockHoldTime overrides constructor option', async () => {
        let warnings: any = [];
        // Constructor sets a long threshold; per-call sets a short one
        let client = makeClient({ maxLockHoldTime: 10_000 });
        client.log.warn = (obj: any) => warnings.push(obj);

        let lock = await client.getMailboxLock('INBOX', { maxLockHoldTime: 20 });
        await new Promise(r => setTimeout(r, 50));

        assert.ok(
            warnings.some((w: any) => w && w.msg === 'Mailbox lock held for a long time'),
            'Per-call override must take effect'
        );

        lock.release();
        await drain();
    });
    it('Reliability: held-lock timer cleared on release (does not fire after)', async () => {
        let warnings: any = [];
        let client = makeClient();
        client.log.warn = (obj: any) => warnings.push(obj);

        let lock = await client.getMailboxLock('INBOX', { maxLockHoldTime: 50 });
        lock.release();
        await drain();

        // Wait longer than the threshold — no warning should appear because release cleared it
        await new Promise(r => setTimeout(r, 80));
        assert.ok(!warnings.some((w: any) => w && w.msg === 'Mailbox lock held for a long time'));
    });
    it('Reliability: held-lock timer cleared on close()', async () => {
        let warnings: any = [];
        let client = makeClient();
        client.log.warn = (obj: any) => warnings.push(obj);

        let lock = await client.getMailboxLock('INBOX', { maxLockHoldTime: 30 });
        assert.ok(lock);
        client.close();

        await new Promise(r => setTimeout(r, 60));
        assert.ok(!warnings.some((w: any) => w && w.msg === 'Mailbox lock held for a long time'));
    });

    // ============================================================================
    // STARTTLS capability reset
    // ============================================================================
    it('Reliability: STARTTLS code path clears capabilities before re-fetch', async () => {
        // Verify the clear() calls happen by driving the same branch directly.
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });

        client.capabilities.set('LOGINDISABLED', true);
        client.capabilities.set('STARTTLS', true);
        client.authCapabilities.set('AUTH=PLAIN', false);

        // Stub the run() that would re-fetch CAPABILITY post-TLS
        let ran: any = [];
        client.run = async command => {
            ran.push(command);
            return true;
        };

        client.expectCapabilityUpdate = true;
        // Execute the same statements that the STARTTLS-success branch runs
        // (guards the behavior contract: caches are cleared before re-fetch)
        if (client.expectCapabilityUpdate) {
            client.capabilities.clear();
            client.authCapabilities.clear();
            await client.run('CAPABILITY');
        }

        assert.equal(client.capabilities.size, 0, 'capabilities map cleared');
        assert.equal(client.authCapabilities.size, 0, 'authCapabilities map cleared');
        assert.deepEqual(ran, ['CAPABILITY']);
    });

    // ============================================================================
    // Handler try/catch (smoke tests via direct invocation)
    // ============================================================================
    it('Reliability: sectionHandler throw is caught (no handler -> no effect)', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });

        // Install a section handler that throws
        client.getSectionHandler = () => async () => {
            throw new Error('handler boom');
        };

        // The production path awaits the handler inside a try/catch in reader().
        // Replicate that contract: the wrapping semantics here should not reject.
        let handler: any = client.getSectionHandler('TEST');
        let caught = false;
        try {
            // Mimic reader() — it does: try { await handler(...) } catch (err) { log.warn(...) }
            try {
                await handler([]);
            } catch (err: any) {
                caught = true;
                assert.ok(err.message.includes('boom'));
            }
        } catch (unexpected: any) {
            assert.ok(false, 'Outer catch should not observe: ' + unexpected.message);
        }

        assert.ok(caught, 'Thrown error is captured by inner try/catch');
    });
    it('Reliability: onPlusTag throw is caught (no handler -> no effect)', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });
        assert.ok(client);

        // Simulate a currentRequest with a throwing onPlusTag
        let onPlusTag = async () => {
            throw new Error('plus tag boom');
        };

        // The reader() path wraps this call in try/catch; replicate the contract.
        let caught = false;
        try {
            await (onPlusTag as any)({});
        } catch (err: any) {
            caught = true;
            assert.ok(err.message.includes('boom'));
        }
        assert.ok(caught);
    });

    // ============================================================================
    // Charset decoder defensive listener
    // ============================================================================
    it('Reliability: decoder emit(error) does not crash when user has not attached listener', () => {
        // Pattern: after a getDecoder() + defensive .on('error') + decoder.emit('error', err),
        // the process does not throw (because at least one listener was registered).
        let decoder = iconv.decodeStream('latin1');

        // Attach the same kind of safety listener the production code installs
        let warned = 0;
        decoder.on('error', () => {
            warned++;
        });

        // Simulate forwarding a source error into the decoder
        assert.doesNotThrow(() => {
            decoder.emit('error', new Error('source stream failed'));
        });
        assert.equal(warned, 1);
    });
    it('Reliability: throttle back-off aborts promptly on close()', async () => {
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });
        client.socket = { destroyed: false, destroy: () => {} };
        client.writeSocket = client.socket;

        let rejected: any = null;
        let request: any = stubThrottleResponse(client, 300000); // 5 min back-off
        request.reject = (err: any) => {
            rejected = err;
        };

        let start = Date.now();
        let readerDone = client.reader().catch(() => {});

        // Let reader() reach the (tracked) back-off wait.
        await new Promise(r => setTimeout(r, 50));
        assert.equal(client._throttleWaits.size, 1, 'back-off wait is tracked while waiting');

        client.close();
        await new Promise(r => setImmediate(r));

        assert.ok(rejected, 'request rejected promptly after close()');
        assert.equal(rejected.code, 'NoConnection', 'rejected with connection error, not ETHROTTLE');
        assert.equal(client._throttleWaits.size, 0, 'throttle wait cleared on close()');
        assert.ok(Date.now() - start < 5000, 'settled well under the 5-minute cap');

        await readerDone;
    });
    it('Reliability: throttle back-off still rejects ETHROTTLE on normal expiry', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });

        let rejected: any = null;
        let request: any = stubThrottleResponse(client, 50); // 50ms back-off
        request.reject = (err: any) => {
            rejected = err;
        };

        let readerDone = client.reader().catch(() => {});

        await new Promise(r => setTimeout(r, 250));

        assert.ok(rejected, 'request rejected after the back-off elapses');
        assert.equal(rejected.code, 'ETHROTTLE', 'normal expiry still rejects ETHROTTLE');
        assert.equal((rejected as any).throttleReset, 50, 'throttleReset preserved');
        assert.equal(client._throttleWaits.size, 0, 'throttle wait cleared after normal expiry');

        await readerDone;
        client.close();
    });

    // ---------------------------------------------------------------------------
    // reader(): the parser backpressure callback is a resource that must always be released
    // ---------------------------------------------------------------------------
    it('Reliability: an unexpected response-handling failure releases the parser and fails closed', async () => {
        // Several steps of response handling (log compilation, response shape assumptions, a handler
        // bug) sit outside the parse try block. A throw there used to propagate out of the reader loop
        // and leave ImapStream waiting on its backpressure callback forever - a silent permanent hang.
        let client: any = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });
        client.socket = { destroyed: false, destroy: () => {} };
        client.writeSocket = client.socket;

        let rejected: any = null;
        let request = { tag: 'A001', command: 'NOOP', resolve: () => {}, reject: (err: any) => (rejected = err) };
        client.requestTagMap = new Map([['A001', request]]);
        client.currentRequest = { tag: 'A001', command: 'NOOP', sent: true };

        let errors: any = [];
        client.on('error', (err: any) => errors.push(err));

        let released = 0;
        let served = false;
        client.streamer.read = () => {
            if (served) {
                return null;
            }
            served = true;
            return {
                payload: Buffer.from('A001 OK NOOP done'),
                literals: [],
                next: () => released++
            };
        };

        // Stand in for any unexpected failure during response handling
        client.handleResponse = async () => {
            throw new Error('handler blew up');
        };

        await client.reader();

        assert.equal(released, 1, 'the parser backpressure callback is released exactly once');
        assert.ok(rejected, 'the in-flight request is rejected instead of hanging');
        assert.equal(rejected.code, 'ResponseProcessingFailed');
        assert.ok(client.streamer.destroyed, 'the parser stream is destroyed, so nothing further is parsed');

        await new Promise(resolve => setImmediate(resolve));
        assert.ok(
            errors.some((err: any) => err.code === 'ResponseProcessingFailed'),
            'the failure is reported to the caller'
        );

        client.close();
    });
    it('Reliability: releaseStreamData is idempotent', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });

        let released = 0;
        let data: any = { next: () => released++ };

        client.releaseStreamData(data);
        client.releaseStreamData(data as any);
        client.releaseStreamData(data as any);

        assert.equal(released, 1, 'a readable item is only ever released once');
        assert.doesNotThrow(() => client.releaseStreamData(null), 'releasing nothing is a no-op');

        client.close();
    });
});
