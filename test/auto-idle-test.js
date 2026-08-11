'use strict';

// Auto-IDLE policy: how the `autoIdleDelay` option is normalized, when the timer is allowed to
// arm at all, and how the socket inactivity watchdog treats connections that are supposed to be
// quiet.
//
// All of it matters more than the option looks. The configured value reaches setTimeout directly,
// where NaN, a negative number and anything above the 32-bit range all become a 1ms timer, i.e.
// an IDLE/DONE round trip around every single command. Arming while a caller still owns the
// connection injects that round trip - or, with `missingIdleCommand` set to SELECT or STATUS, a
// mailbox poll - between two of that caller's own commands. And the watchdog has to tell a
// connection that is legitimately quiet (idling, a stalled download, a held lock) from one whose
// command reply is overdue.

const { makeClient, makeIdleReadyClient, chunkedFetchOne } = require('./fixtures/test-client');
const { withFakeTimers } = require('./fixtures/fake-timers');

const DEFAULT_DELAY = 15 * 1000;
const DEFAULT_SOCKET_TIMEOUT = 5 * 60 * 1000;
const SOCKET_MARGIN = 1000;
const TIMEOUT_MAX = 2 ** 31 - 1;

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
        test.equal(warnings[0].reason, 'not a non-negative finite number', `${String(value)} is reported with the right reason`);
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

module.exports['Auto-IDLE: the cap stays inside the timer range for a huge socketTimeout'] = test => {
    // socket.setTimeout truncates an over-range socketTimeout on its own, so a huge watchdog
    // deadline still works - but the auto-IDLE delay must not inherit the raw value, or
    // setTimeout would turn it into a 1ms timer and IDLE would follow every single command.
    test.equal(makeClient({ socketTimeout: 2 ** 32, autoIdleDelay: 2 ** 31 }).autoIdleDelay, TIMEOUT_MAX - SOCKET_MARGIN);
    test.equal(makeClient({ socketTimeout: 2200000000, autoIdleDelay: 2150000000 }).autoIdleDelay, TIMEOUT_MAX - SOCKET_MARGIN);
    test.done();
};

module.exports['Auto-IDLE: capping the default for a short socketTimeout is silent'] = test => {
    let { client, warnings } = makeLoggingClient({ socketTimeout: 5000 });
    test.equal(client.autoIdleDelay, 4000, 'the default is capped too');
    test.equal(warnings.length, 0, 'but nothing was misconfigured, so nothing is reported');
    test.done();
};

module.exports['Auto-IDLE: an invalid value keeps its own reason when the default is then capped'] = test => {
    // 'soon' falls back to the 15s default, which a 5s socketTimeout then caps to 4s. The
    // warning must still name what was wrong with the configured value - the cap applied to
    // the fallback, not to anything the caller asked for.
    let { client, warnings } = makeLoggingClient({ autoIdleDelay: 'soon', socketTimeout: 5000 });
    test.equal(client.autoIdleDelay, 4000);
    test.equal(warnings.length, 1);
    test.equal(warnings[0].reason, 'not a non-negative finite number');
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

module.exports['Auto-IDLE: the armed timer re-checks the busy guard when it fires'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeIdleReadyClient({ autoIdleDelay: 200 });
        let idleCalls = 0;
        client.idle = async () => {
            idleCalls++;
        };

        client.autoidle();
        test.equal(timers.count(), 1, 'the timer was armed on a free connection');

        // Ownership taken without clearing the timer - the guard must not depend on every
        // ownership-taking path remembering its clearTimeout.
        client.currentRequest = { tag: 'A001', command: 'FETCH', sent: true };
        await timers.fire();
        test.equal(idleCalls, 0, 'a connection that is busy at fire time does not start IDLE');

        client.currentRequest = false;
        client.autoidle();
        await timers.fire();
        test.equal(idleCalls, 1, 'a connection that is free at fire time does');

        client.close();
    });
    test.done();
};

module.exports['Auto-IDLE: no timer is armed while a download is streaming'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeIdleReadyClient({ autoIdleDelay: 200 });
        let body = Buffer.from('A'.repeat(20));
        let armedAfterChunk = [];

        let serveChunk = chunkedFetchOne(body);
        client.fetchOne = async (range, query) => {
            // Stands in for run(), which clears the auto-IDLE timer on entry and re-arms it once
            // the command settles. The pause between two chunks is where IDLE would slip in.
            clearTimeout(client.idleStartTimer);
            let part = await serveChunk(range, query);
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

module.exports['Auto-IDLE: a download counts as busy before control returns to the event loop'] = async test => {
    await withFakeTimers(async () => {
        let client = makeIdleReadyClient({ autoIdleDelay: 200 });
        let body = Buffer.from('B'.repeat(12));
        client.fetchOne = chunkedFetchOne(body);

        let { content } = await client.download('1', false, { chunkSize: 4 });
        // The head chunk's own FETCH re-arms auto-IDLE a moment before the download exists;
        // with a very short delay that timer fires before the deferred chunk loop starts, so
        // the busy guard must already see the download when download() hands the stream back.
        test.equal(client._openDownloads, 1, 'the download is counted before streaming starts');

        let received = [];
        for await (let chunk of content) {
            received.push(chunk);
        }
        test.equal(Buffer.concat(received).toString(), 'B'.repeat(12), 'the whole body arrived');
        test.equal(client._openDownloads, 0, 'the download is released once the stream is done');

        client.close();
    });
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

module.exports['Auto-IDLE: a failing IDLE break still re-arms the timer'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeIdleReadyClient({ autoIdleDelay: 300 });
        // run() awaits preCheck() (breaking an active IDLE) before dispatching. A break that
        // rejects exits run() before the command ever starts, and must still re-arm auto-IDLE
        // exactly like a failed command does.
        client.preCheck = async () => {
            throw new Error('IDLE break failed');
        };

        let err;
        try {
            await client.run('NOOP');
        } catch (E) {
            err = E;
        }

        test.ok(err, 'the failure still reaches the caller');
        let armed = timers.pending();
        test.equal(armed.length, 1, 'auto-IDLE is re-armed after the failed IDLE break');
        test.equal(armed[0].delay, 300);

        client.close();
    });
    test.done();
};

// ============================================================================
// the socket inactivity watchdog
// ============================================================================

// A client wired up for _socketTimeout() with recording stubs: recovery commands land in
// `recovered`, emitted errors in `errors`. run() is stubbed, so nothing here re-arms auto-IDLE -
// which is deliberate: the handler itself must never start IDLE, that decision belongs to
// autoidle() once the recovery NOOP settles for real.
const makeWatchdogClient = () => {
    let client = makeIdleReadyClient();
    let errors = [];
    let recovered = [];
    client.on('error', err => errors.push(err));
    client.run = async command => recovered.push(command);
    client.idle = async () => recovered.push('IDLE');
    client.writeSocket = client.socket;
    client.setSocketHandlers();
    return { client, errors, recovered };
};

const drainImmediate = () => new Promise(resolve => setImmediate(resolve));

module.exports['Auto-IDLE: a stalled download survives the socket watchdog'] = async test => {
    // Suppressing auto-IDLE during a download means `idling` is false when the inactivity
    // watchdog fires, so without the download clause the watchdog would tear down a connection
    // whose only problem is a consumer that stopped draining.
    let { client, errors, recovered } = makeWatchdogClient();
    client._openDownloads = 1;

    client._socketTimeout();
    await drainImmediate();

    test.deepEqual(errors, [], 'no ETIMEOUT is emitted while a download is open');
    test.deepEqual(recovered, ['NOOP'], 'kept alive with a NOOP only - IDLE mid-download is what the busy guard exists to prevent');

    client._openDownloads = 0;
    client._socketTimeout();
    test.equal(errors.length, 1, 'once the download is done a quiet socket is a timeout again');
    test.equal(errors[0].code, 'ETIMEOUT');

    client.close();
    test.ok(client.isClosed, 'the socket stub supports everything close() needs');
    test.done();
};

module.exports['Auto-IDLE: a stuck chunk FETCH mid-download is a dead connection'] = async test => {
    // A quiet socket while a command is awaiting its reply means the reply is overdue. A
    // recovery NOOP would only queue behind the stuck command and never reach the wire, so
    // the watchdog must report the timeout instead of recovering into a silent hang.
    let { client, errors, recovered } = makeWatchdogClient();
    client._openDownloads = 1;
    client.currentRequest = { tag: 'A001', command: 'FETCH', sent: true };

    client._socketTimeout();
    await drainImmediate();

    test.deepEqual(recovered, [], 'no recovery is attempted behind a stuck command');
    test.equal(errors.length, 1, 'the caller learns the connection is dead');
    test.equal(errors[0].code, 'ETIMEOUT');

    client.close();
    test.done();
};

module.exports['Auto-IDLE: a held mailbox lock keeps a quiet connection alive'] = async test => {
    // A lock holder pausing between commands for longer than socketTimeout is legitimate (the
    // held-lock diagnostic warns only after 30 minutes), and with auto-IDLE declining to arm
    // during a lock there is no IDLE traffic to keep the socket busy - the watchdog has to.
    let { client, errors, recovered } = makeWatchdogClient();
    client.currentLock = { lockId: 1 };

    client._socketTimeout();
    await drainImmediate();

    test.deepEqual(errors, [], 'the lock holder keeps its connection');
    test.deepEqual(recovered, ['NOOP'], 'kept alive with a NOOP only, no IDLE inside the lock');

    client.currentLock = false;
    client._socketTimeout();
    test.equal(errors.length, 1, 'with the lock gone a quiet socket is a timeout again');
    test.equal(errors[0].code, 'ETIMEOUT');

    client.close();
    test.done();
};

module.exports['Auto-IDLE: idling recovers even with the IDLE command in flight'] = async test => {
    // During true IDLE the in-flight command IS the IDLE command; run() breaks it through
    // preCheck() before the recovery NOOP goes out, so it does not count as stuck. A recovery
    // NOOP that then never settles does: the next timeout must fail rather than queue another.
    let { client, errors, recovered } = makeWatchdogClient();
    client.idling = true;
    client.currentRequest = { tag: 'A001', command: 'IDLE', sent: true };

    client._socketTimeout();
    await drainImmediate();
    test.deepEqual(errors, [], 'the idling connection is not torn down');
    test.deepEqual(recovered, ['NOOP'], 'it is recovered with a NOOP');

    client.idling = false;
    client.currentRequest = { tag: 'A002', command: 'NOOP', sent: true };
    client._socketTimeout();
    test.equal(errors.length, 1, 'a recovery NOOP that never settled is a dead connection');
    test.equal(errors[0].code, 'ETIMEOUT');

    client.close();
    test.done();
};
