'use strict';

// Auto-IDLE policy: how the `autoIdleDelay` option is normalized, and when the timer is allowed
// to arm at all.
//
// Both matter more than the option looks. The configured value reaches setTimeout directly, where
// NaN, a negative number and anything above the 32-bit range all become a 1ms timer, i.e. an
// IDLE/DONE round trip around every single command. And arming while a caller still owns the
// connection injects that round trip - or, with `missingIdleCommand` set to SELECT or STATUS, a
// mailbox poll - between two of that caller's own commands.

const { ImapFlow } = require('../lib/imap-flow');
const { withFakeTimers } = require('./fixtures/fake-timers');

const DEFAULT_DELAY = 15 * 1000;
const DEFAULT_SOCKET_TIMEOUT = 5 * 60 * 1000;
const SOCKET_MARGIN = 1000;

const makeClient = (overrides = {}) => {
    let client = new ImapFlow({
        host: '127.0.0.1',
        port: 993,
        logger: false,
        auth: { user: 'test', pass: 'secret' },
        ...overrides
    });
    client.socket = { destroyed: false, destroy: () => {} };
    client.usable = true;
    return client;
};

// Captures warn entries, so the "silently ignored configuration" cases can be asserted as
// reported rather than guessed at.
const makeLoggingClient = (overrides = {}) => {
    let warnings = [];
    let client = makeClient({
        ...overrides,
        logger: { trace() {}, debug() {}, info() {}, warn: entry => warnings.push(entry), error() {}, fatal() {} }
    });
    return { client, warnings };
};

// A client parked in SELECTED with a no-op idle(), ready for autoidle() to be called directly
const makeIdleReadyClient = (overrides = {}) => {
    let client = makeClient({ maxLockHoldTime: 0, ...overrides });
    client.state = client.states.SELECTED;
    client.mailbox = { path: 'INBOX', readOnly: false };
    client.idle = async () => {};
    return client;
};

// ============================================================================
// option normalization
// ============================================================================

module.exports['Auto-IDLE: an unset delay uses the default'] = test => {
    let { client, warnings } = makeLoggingClient();
    test.equal(client.autoIdleDelay, DEFAULT_DELAY);
    test.equal(warnings.length, 0, 'the default is not a misconfiguration');
    test.done();
};

module.exports['Auto-IDLE: a configured delay is honored and reaches setTimeout'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeIdleReadyClient({ autoIdleDelay: 1234 });
        test.equal(client.autoIdleDelay, 1234);

        client.autoidle();

        let armed = timers.pending();
        test.equal(armed.length, 1, 'exactly one auto-IDLE timer is armed');
        test.equal(armed[0].delay, 1234, 'the configured delay is what the timer uses');

        client.close();
    });
    test.done();
};

module.exports['Auto-IDLE: numeric strings are accepted'] = test => {
    // The normal shape of a value coming from an environment variable or a JSON/YAML config file
    test.equal(makeClient({ autoIdleDelay: '2000' }).autoIdleDelay, 2000);
    test.equal(makeClient({ autoIdleDelay: ' 2000 ' }).autoIdleDelay, 2000);
    test.done();
};

module.exports['Auto-IDLE: zero is honored, fractions are floored'] = test => {
    test.equal(makeClient({ autoIdleDelay: 0 }).autoIdleDelay, 0);
    test.equal(makeClient({ autoIdleDelay: 1500.9 }).autoIdleDelay, 1500);
    test.done();
};

module.exports['Auto-IDLE: unusable values fall back to the default and are reported'] = test => {
    // Every one of these is something setTimeout would turn into a 1ms timer, or something a
    // caller plausibly means as "off" - which is what disableAutoIdle is for.
    for (let value of [NaN, -1, -0.5, Infinity, -Infinity, 'soon', '', '   ', true, false, {}, []]) {
        let { client, warnings } = makeLoggingClient({ autoIdleDelay: value });
        test.equal(client.autoIdleDelay, DEFAULT_DELAY, `${String(value)} falls back to the default`);
        test.equal(warnings.length, 1, `${String(value)} is reported rather than silently swallowed`);
        test.equal(warnings[0].msg, 'Adjusted unusable autoIdleDelay option');
    }
    test.done();
};

module.exports['Auto-IDLE: the delay is capped below socketTimeout'] = test => {
    // A delay at or above socketTimeout means the inactivity watchdog fires before IDLE ever
    // starts. `idling` is still false at that point, so the handler emits ETIMEOUT and tears down
    // a quiet but perfectly healthy connection instead of letting it enter IDLE.
    let { client, warnings } = makeLoggingClient({ autoIdleDelay: 10 * 60 * 1000 });
    test.equal(client.autoIdleDelay, DEFAULT_SOCKET_TIMEOUT - SOCKET_MARGIN);
    test.equal(warnings.length, 1, 'the caller is told the value was capped');

    // The cap follows a custom socketTimeout, and keeps the delay inside the range setTimeout can
    // represent: 2 ** 31 and larger would otherwise silently become a 1ms timer.
    test.equal(makeClient({ autoIdleDelay: 60000, socketTimeout: 30000 }).autoIdleDelay, 29000);
    test.equal(makeClient({ autoIdleDelay: 2 ** 31 }).autoIdleDelay, DEFAULT_SOCKET_TIMEOUT - SOCKET_MARGIN);
    test.equal(makeClient({ autoIdleDelay: Number.MAX_SAFE_INTEGER }).autoIdleDelay, DEFAULT_SOCKET_TIMEOUT - SOCKET_MARGIN);
    test.done();
};

module.exports['Auto-IDLE: capping the default for a short socketTimeout is silent'] = test => {
    let { client, warnings } = makeLoggingClient({ socketTimeout: 5000 });
    test.equal(client.autoIdleDelay, 4000, 'the default is capped too');
    test.equal(warnings.length, 0, 'but nothing was misconfigured, so nothing is reported');
    test.done();
};

// ============================================================================
// when the timer may arm
// ============================================================================

module.exports['Auto-IDLE: no timer is armed while a mailbox lock is held'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeIdleReadyClient({ autoIdleDelay: 200 });

        let lock = await client.getMailboxLock('INBOX');
        test.ok(client.currentLock, 'the lock was granted through the fast path');

        client.autoidle();
        test.equal(timers.count(), 0, 'IDLE must not be injected between a lock holder own commands');

        lock.release();
        let armed = timers.pending();
        test.equal(armed.length, 1, 'releasing the lock re-arms auto-IDLE');
        test.equal(armed[0].delay, 200);

        client.close();
    });
    test.done();
};

module.exports['Auto-IDLE: acquiring a lock through SELECT leaves no timer behind'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeIdleReadyClient({ autoIdleDelay: 200 });
        client.mailbox = false;
        // The SELECT that opens the mailbox goes through run(), which re-arms auto-IDLE when it
        // settles - a moment before currentLock is set. That timer would fire inside the lock.
        client.mailboxOpen = async path => {
            client.mailbox = { path, readOnly: false };
            client.autoidle();
            return client.mailbox;
        };

        let lock = await client.getMailboxLock('INBOX');
        test.ok(client.currentLock, 'the lock was granted through the SELECT path');
        test.equal(timers.count(), 0, 'the timer armed while opening the mailbox was cleared');

        lock.release();
        test.equal(timers.count(), 1, 'and auto-IDLE resumes once the lock is released');

        client.close();
    });
    test.done();
};

module.exports['Auto-IDLE: releasing a lock with another one queued does not arm'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeIdleReadyClient({ autoIdleDelay: 200 });

        let lock = await client.getMailboxLock('INBOX');
        // Queue a second request; the connection is not free when the first holder lets go
        let queued = client.getMailboxLock('INBOX');
        test.equal(client.locks.length, 1, 'the second request is waiting');

        lock.release();
        test.equal(timers.count(), 0, 'the next holder owns the connection, so IDLE stays off');

        (await queued).release();
        test.equal(timers.count(), 1, 'the last release re-arms auto-IDLE');

        client.close();
    });
    test.done();
};

module.exports['Auto-IDLE: no timer is armed while a command is in flight or queued'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeIdleReadyClient({ autoIdleDelay: 200 });

        // Concurrent commands each clear the timer on entry, so without this guard the first one
        // to settle would arm a timer that fires while the others are still running.
        client.currentRequest = { tag: 'A001', command: 'FETCH', sent: true };
        client.autoidle();
        test.equal(timers.count(), 0, 'a command in flight owns the connection');

        client.currentRequest = false;
        client.requestQueue = [{ tag: 'A002', command: 'FETCH' }];
        client.autoidle();
        test.equal(timers.count(), 0, 'so does a command still waiting in the queue');

        client.requestQueue = [];
        client.autoidle();
        test.equal(timers.count(), 1, 'an idle connection arms the timer');

        client.close();
    });
    test.done();
};

module.exports['Auto-IDLE: no timer is armed while a download is streaming'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeIdleReadyClient({ autoIdleDelay: 200 });
        let body = Buffer.from('A'.repeat(20));
        let armedAfterChunk = [];

        client.fetchOne = async (range, query) => {
            // Stands in for run(), which clears the auto-IDLE timer on entry and re-arms it once
            // the command settles. The pause between two chunks is where IDLE would slip in.
            clearTimeout(client.idleStartTimer);
            let start = query.source.start;
            let maxLength = query.source.maxLength;
            let part = { uid: 1, size: body.length, source: body.subarray(start, start + maxLength) };
            client.autoidle();
            armedAfterChunk.push(timers.count());
            return part;
        };

        let { content } = await client.download('1', false, { chunkSize: 4 });
        let received = [];
        for await (let chunk of content) {
            received.push(chunk);
        }

        test.equal(Buffer.concat(received).toString(), 'A'.repeat(20), 'the whole body arrived');
        test.ok(armedAfterChunk.length > 2, 'the body really was fetched in several chunks');
        test.deepEqual(
            armedAfterChunk.slice(1).filter(count => count !== 0),
            [],
            'no chunk boundary inside the download armed an auto-IDLE timer'
        );
        test.equal(timers.count(), 1, 'auto-IDLE resumes once the download stream is finished');

        client.close();
    });
    test.done();
};

module.exports['Auto-IDLE: a stalled download survives the socket watchdog'] = async test => {
    // Suppressing auto-IDLE during a download means `idling` is false when the inactivity
    // watchdog fires, so without the download clause the watchdog would tear down a connection
    // whose only problem is a consumer that stopped draining.
    let client = makeIdleReadyClient();
    client.usable = true;
    client._openDownloads = 1;

    let errors = [];
    client.on('error', err => errors.push(err));

    let recovered = [];
    client.run = async command => recovered.push(command);
    client.idle = async () => recovered.push('IDLE');

    client.socket = { destroyed: false, destroy: () => {}, once: () => {}, on: () => {} };
    client.writeSocket = client.socket;
    client.setSocketHandlers();
    client._socketTimeout();
    await new Promise(resolve => setImmediate(resolve));

    test.deepEqual(errors, [], 'no ETIMEOUT is emitted while a download is open');
    test.deepEqual(recovered, ['NOOP', 'IDLE'], 'the connection is kept alive instead');

    client._openDownloads = 0;
    client._socketTimeout();
    test.equal(errors.length, 1, 'once the download is done a quiet socket is a timeout again');
    test.equal(errors[0].code, 'ETIMEOUT');

    client.close();
    test.done();
};

module.exports['Auto-IDLE: a failing command still re-arms the timer'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeIdleReadyClient({ autoIdleDelay: 300 });
        // run() clears the timer before dispatching, so re-arming only on the success path would
        // leave auto-IDLE off for good after one rejected command.
        client.runInternal = async () => {
            throw new Error('command failed');
        };

        let err;
        try {
            await client.run('NOOP');
        } catch (E) {
            err = E;
        }

        test.ok(err, 'the failure still reaches the caller');
        let armed = timers.pending();
        test.equal(armed.length, 1, 'auto-IDLE is re-armed after a failed command');
        test.equal(armed[0].delay, 300);

        client.close();
    });
    test.done();
};
