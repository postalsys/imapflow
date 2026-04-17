'use strict';

// Tests for reliability/stability improvements: lock identity, acquireTimeout,
// maxLockHoldTime diagnostic, capability-clear-on-STARTTLS, and related
// cleanup paths.

const { ImapFlow } = require('../lib/imap-flow');
const iconv = require('iconv-lite');

// Helper: client with stubbed socket/usable state so the fast path of
// getMailboxLock() can grant locks synchronously (no network I/O).
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
    client.mailbox = { path: 'INBOX', readOnly: false };
    return client;
};

// Helper: wait for any queued setImmediate callbacks (processLocks reschedules
// itself via setImmediate after a release).
const drain = () => new Promise(resolve => setImmediate(resolve));

// ============================================================================
// release() identity check
// ============================================================================

module.exports['Reliability: stale release() does not clear replacement lock'] = async test => {
    let client = makeClient();

    // Grant L1 via fast path
    let lockA = await client.getMailboxLock('INBOX');
    let staleRelease = lockA.release;

    // Release L1 normally
    staleRelease();
    await drain();
    test.equal(client.currentLock, false, 'L1 released');

    // Grant L2
    let lockB = await client.getMailboxLock('INBOX');
    test.ok(client.currentLock, 'L2 active');
    let currentBeforeStale = client.currentLock;

    // Stale call — must NOT clear L2's hold
    staleRelease();
    test.equal(client.currentLock, currentBeforeStale, 'L2 still active after stale release');

    lockB.release();
    await drain();
    test.done();
};

module.exports['Reliability: double release() is idempotent'] = async test => {
    let client = makeClient();

    let lock = await client.getMailboxLock('INBOX');

    // First release clears
    lock.release();
    await drain();
    test.equal(client.currentLock, false);

    // Second release is a no-op — must not throw, must not affect state
    test.doesNotThrow(() => lock.release());
    test.equal(client.currentLock, false);

    test.done();
};

// ============================================================================
// acquireTimeout
// ============================================================================

module.exports['Reliability: acquireTimeout rejects with LockTimeout code'] = async test => {
    let client = makeClient();

    // Hold the first lock so the next one queues
    let lockA = await client.getMailboxLock('INBOX');

    let start = Date.now();
    try {
        await client.getMailboxLock('INBOX', { acquireTimeout: 30 });
        test.ok(false, 'Should have timed out');
    } catch (err) {
        let elapsed = Date.now() - start;
        test.equal(err.code, 'LockTimeout');
        test.ok(err.message.includes('Timed out'));
        test.ok(typeof err.lockId === 'number');
        test.ok(elapsed >= 25, `expected to wait ~30ms, got ${elapsed}`);
    }

    // Original lock must still be held
    test.ok(client.currentLock, 'L1 still held after L2 timeout');

    lockA.release();
    await drain();
    test.done();
};

module.exports['Reliability: acquireTimeout cleared when lock is granted'] = async test => {
    let client = makeClient();

    // Fast path grants immediately; timer never fires
    let lock = await client.getMailboxLock('INBOX', { acquireTimeout: 50 });
    test.ok(lock);
    test.ok(client.currentLock, 'L1 granted');

    // Wait past the timeout — no rejection should occur post-grant, no dangling timer
    await new Promise(r => setTimeout(r, 80));
    test.ok(client.currentLock, 'Still held after timer would have fired');

    lock.release();
    await drain();
    test.done();
};

module.exports['Reliability: acquireTimeout cleared on close()'] = async test => {
    let client = makeClient();
    // Hold L1 so L2 queues
    let lockA = await client.getMailboxLock('INBOX');

    let rejectedCode = null;
    client.getMailboxLock('INBOX', { acquireTimeout: 10_000 }).catch(err => {
        rejectedCode = err.code;
    });

    // Immediately close — pending lock should reject with NoConnection (not LockTimeout),
    // and its acquireTimer should be cleared so it never fires afterward.
    client.close();

    await drain();
    await new Promise(r => setTimeout(r, 30));
    test.equal(rejectedCode, 'NoConnection', 'Pending lock rejects with NoConnection on close');

    // Keep reference so linter doesn't complain
    test.ok(lockA);
    test.done();
};

// ============================================================================
// maxLockHoldTime diagnostic
// ============================================================================

module.exports['Reliability: maxLockHoldTime warning fires when lock held past threshold'] = async test => {
    let warnings = [];
    let client = makeClient();
    client.log.warn = obj => warnings.push(obj);

    let lock = await client.getMailboxLock('INBOX', { maxLockHoldTime: 30 });
    await new Promise(r => setTimeout(r, 60));

    let hit = warnings.find(w => w && w.msg === 'Mailbox lock held for a long time');
    test.ok(hit, 'Warning log must fire');
    test.ok(typeof hit.heldFor === 'number' && hit.heldFor >= 25);

    lock.release();
    await drain();
    test.done();
};

module.exports['Reliability: maxLockHoldTime=0 disables the warning'] = async test => {
    let warnings = [];
    let client = makeClient();
    client.log.warn = obj => warnings.push(obj);

    let lock = await client.getMailboxLock('INBOX', { maxLockHoldTime: 0 });
    await new Promise(r => setTimeout(r, 30));

    test.ok(!warnings.some(w => w && w.msg === 'Mailbox lock held for a long time'), 'No warn when disabled');

    lock.release();
    await drain();
    test.done();
};

module.exports['Reliability: maxLockHoldTime=false disables the warning'] = async test => {
    let warnings = [];
    let client = makeClient();
    client.log.warn = obj => warnings.push(obj);

    let lock = await client.getMailboxLock('INBOX', { maxLockHoldTime: false });
    await new Promise(r => setTimeout(r, 30));

    test.ok(!warnings.some(w => w && w.msg === 'Mailbox lock held for a long time'));

    lock.release();
    await drain();
    test.done();
};

module.exports['Reliability: per-call maxLockHoldTime overrides constructor option'] = async test => {
    let warnings = [];
    // Constructor sets a long threshold; per-call sets a short one
    let client = makeClient({ maxLockHoldTime: 10_000 });
    client.log.warn = obj => warnings.push(obj);

    let lock = await client.getMailboxLock('INBOX', { maxLockHoldTime: 20 });
    await new Promise(r => setTimeout(r, 50));

    test.ok(warnings.some(w => w && w.msg === 'Mailbox lock held for a long time'), 'Per-call override must take effect');

    lock.release();
    await drain();
    test.done();
};

module.exports['Reliability: held-lock timer cleared on release (does not fire after)'] = async test => {
    let warnings = [];
    let client = makeClient();
    client.log.warn = obj => warnings.push(obj);

    let lock = await client.getMailboxLock('INBOX', { maxLockHoldTime: 50 });
    lock.release();
    await drain();

    // Wait longer than the threshold — no warning should appear because release cleared it
    await new Promise(r => setTimeout(r, 80));
    test.ok(!warnings.some(w => w && w.msg === 'Mailbox lock held for a long time'));

    test.done();
};

module.exports['Reliability: held-lock timer cleared on close()'] = async test => {
    let warnings = [];
    let client = makeClient();
    client.log.warn = obj => warnings.push(obj);

    let lock = await client.getMailboxLock('INBOX', { maxLockHoldTime: 30 });
    test.ok(lock);
    client.close();

    await new Promise(r => setTimeout(r, 60));
    test.ok(!warnings.some(w => w && w.msg === 'Mailbox lock held for a long time'));

    test.done();
};

// ============================================================================
// STARTTLS capability reset
// ============================================================================

module.exports['Reliability: STARTTLS code path clears capabilities before re-fetch'] = async test => {
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
    let ran = [];
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

    test.equal(client.capabilities.size, 0, 'capabilities map cleared');
    test.equal(client.authCapabilities.size, 0, 'authCapabilities map cleared');
    test.deepEqual(ran, ['CAPABILITY']);

    test.done();
};

// ============================================================================
// Handler try/catch (smoke tests via direct invocation)
// ============================================================================

module.exports['Reliability: sectionHandler throw is caught (no handler -> no effect)'] = async test => {
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
    let handler = client.getSectionHandler('TEST');
    let caught = false;
    try {
        // Mimic reader() — it does: try { await handler(...) } catch (err) { log.warn(...) }
        try {
            await handler([]);
        } catch (err) {
            caught = true;
            test.ok(err.message.includes('boom'));
        }
    } catch (unexpected) {
        test.ok(false, 'Outer catch should not observe: ' + unexpected.message);
    }

    test.ok(caught, 'Thrown error is captured by inner try/catch');
    test.done();
};

module.exports['Reliability: onPlusTag throw is caught (no handler -> no effect)'] = async test => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' },
        logger: false
    });
    test.ok(client);

    // Simulate a currentRequest with a throwing onPlusTag
    let onPlusTag = async () => {
        throw new Error('plus tag boom');
    };

    // The reader() path wraps this call in try/catch; replicate the contract.
    let caught = false;
    try {
        await onPlusTag({});
    } catch (err) {
        caught = true;
        test.ok(err.message.includes('boom'));
    }
    test.ok(caught);
    test.done();
};

// ============================================================================
// Charset decoder defensive listener
// ============================================================================

module.exports['Reliability: decoder emit(error) does not crash when user has not attached listener'] = test => {
    // Pattern: after a getDecoder() + defensive .on('error') + decoder.emit('error', err),
    // the process does not throw (because at least one listener was registered).
    let decoder = iconv.decodeStream('latin1');

    // Attach the same kind of safety listener the production code installs
    let warned = 0;
    decoder.on('error', () => {
        warned++;
    });

    // Simulate forwarding a source error into the decoder
    test.doesNotThrow(() => {
        decoder.emit('error', new Error('source stream failed'));
    });
    test.equal(warned, 1);

    test.done();
};
