'use strict';

// Targeted unit tests for low-level ImapFlow internals that are awkward to reach
// through a full session: emitError routing, write() guards, run() dispatch
// guards, the synthetic logger, the streamer error handler, autoidle scheduling
// and the untaggedFetch flag/modseq branches.

const { ImapFlow } = require('../lib/imap-flow');

const makeClient = (overrides = {}) => {
    let client = new ImapFlow({
        host: 'imap.example.com',
        port: 993,
        auth: { user: 'test', pass: 'test' },
        logger: false,
        ...overrides
    });
    return client;
};

// ============================================================================
// emitError
// ============================================================================

module.exports['Internals: emitError ignores falsy error'] = test => {
    let client = makeClient();
    let emitted = false;
    client.on('error', () => {
        emitted = true;
    });
    client.emitError(null);
    test.equal(emitted, false);
    test.done();
};

module.exports['Internals: emitError routes to upgrade rejector while upgrading'] = test => {
    let client = makeClient();
    client.socket = { destroyed: true, destroy: () => {} };
    client.upgrading = true;
    let rejected = null;
    client._upgradeReject = err => {
        rejected = err;
    };
    let err = new Error('tls boom');
    client.emitError(err);
    test.equal(rejected, err);
    test.equal(client.upgrading, false);
    test.done();
};

module.exports['Internals: emitError rejects pending connect promise'] = test => {
    let client = makeClient();
    client.socket = { destroyed: true, destroy: () => {} };
    let rejected = null;
    client.initialReject = err => {
        rejected = err;
    };
    client.initialResolve = () => {};
    let err = new Error('connect boom');
    client.emitError(err);
    test.equal(rejected, err);
    test.equal(client.initialReject, false);
    test.done();
};

module.exports['Internals: emitError emits error event as fallback'] = test => {
    let client = makeClient();
    client.socket = { destroyed: true, destroy: () => {} };
    let emitted = null;
    client.on('error', err => {
        emitted = err;
    });
    let err = new Error('plain boom');
    client.emitError(err);
    test.equal(emitted, err);
    test.equal(err._connId, client.id);
    test.done();
};

// ============================================================================
// streamer error handler
// ============================================================================

module.exports['Internals: streamer error handler silently closes on transient codes'] = test => {
    let client = makeClient();
    let closeAfterCalled = false;
    client.closeAfter = () => {
        closeAfterCalled = true;
    };
    let emitted = false;
    client.on('error', () => {
        emitted = true;
    });
    client._streamerErrorHandler({ code: 'ECONNRESET', message: 'reset' });
    test.ok(closeAfterCalled);
    test.equal(emitted, false);
    test.done();
};

module.exports['Internals: streamer error handler emits on other codes'] = test => {
    let client = makeClient();
    client.socket = { destroyed: true, destroy: () => {} };
    let emitted = null;
    client.on('error', err => {
        emitted = err;
    });
    client._streamerErrorHandler({ code: 'EOTHER', message: 'weird' });
    test.ok(emitted);
    test.done();
};

// ============================================================================
// write()
// ============================================================================

module.exports['Internals: write throws when socket destroyed'] = test => {
    let client = makeClient();
    client.socket = { destroyed: true };
    test.throws(() => client.write('A NOOP'), /Socket is already closed/);
    test.done();
};

module.exports['Internals: write throws after logout'] = test => {
    let client = makeClient();
    client.socket = { destroyed: false };
    client.state = client.states.LOGOUT;
    test.throws(() => client.write('A NOOP'), /Can not send data after logged out/);
    test.done();
};

module.exports['Internals: write closes when writeSocket destroyed'] = test => {
    let client = makeClient();
    client.socket = { destroyed: false };
    client.writeSocket = { destroyed: true };
    client.state = client.states.AUTHENTICATED;
    let closed = false;
    client.close = () => {
        closed = true;
    };
    let res = client.write('A NOOP');
    test.equal(res, undefined);
    test.ok(closed);
    test.done();
};

module.exports['Internals: write returns false for non-string non-buffer'] = test => {
    let client = makeClient();
    let written = [];
    client.socket = { destroyed: false };
    client.writeSocket = { destroyed: false, write: c => written.push(c) };
    client.state = client.states.AUTHENTICATED;
    client.commandParts = [];
    let res = client.write({ not: 'a buffer' });
    test.equal(res, false);
    test.equal(written.length, 0);
    test.done();
};

module.exports['Internals: write logs raw data when logRaw enabled'] = test => {
    let logs = [];
    let client = makeClient({ logRaw: true });
    client.log = {
        trace: o => logs.push(o),
        debug: () => {},
        warn: () => {},
        error: () => {},
        info: () => {}
    };
    let written = [];
    client.socket = { destroyed: false };
    client.writeSocket = { destroyed: false, write: c => written.push(c) };
    client.state = client.states.AUTHENTICATED;
    client.commandParts = [];
    client.write('A NOOP');
    test.ok(logs.some(l => l.src === 'c' && l.msg === 'write to socket'));
    test.equal(written.length, 1);
    test.done();
};

module.exports['Internals: write appends CRLF only on final part'] = test => {
    let client = makeClient();
    let written = [];
    client.socket = { destroyed: false };
    client.writeSocket = { destroyed: false, write: c => written.push(c) };
    client.state = client.states.AUTHENTICATED;
    // Pending command parts => no CRLF appended to this chunk
    client.commandParts = ['more'];
    client.write(Buffer.from('literal'));
    test.equal(written[0].toString(), 'literal');
    test.done();
};

// ============================================================================
// run()
// ============================================================================

module.exports['Internals: run returns false for unknown command'] = async test => {
    let client = makeClient();
    client.socket = { destroyed: false };
    let res = await client.run('NOT_A_COMMAND');
    test.equal(res, false);
    test.done();
};

module.exports['Internals: run throws NoConnection without socket'] = async test => {
    let client = makeClient();
    client.socket = null;
    let err = null;
    try {
        await client.run('NOOP');
    } catch (e) {
        err = e;
    }
    test.ok(err);
    test.equal(err.code, 'NoConnection');
    test.done();
};

module.exports['Internals: run invokes preCheck and command handler'] = async test => {
    let client = makeClient();
    client.socket = { destroyed: false };
    let preCheckCalled = false;
    client.preCheck = async () => {
        preCheckCalled = true;
    };
    let handlerArgs = null;
    client.commands = new Map([
        [
            'TESTCMD',
            async (conn, a, b) => {
                handlerArgs = [a, b];
                return 'handled';
            }
        ]
    ]);
    let res = await client.run('TESTCMD', 1, 2);
    test.equal(res, 'handled');
    test.ok(preCheckCalled);
    test.deepEqual(handlerArgs, [1, 2]);
    test.done();
};

// ============================================================================
// autoidle
// ============================================================================

module.exports['Internals: autoidle does nothing when not selected'] = test => {
    let client = makeClient();
    client.state = client.states.AUTHENTICATED;
    client.autoidle();
    test.equal(client.idleStartTimer, undefined);
    test.done();
};

module.exports['Internals: autoidle schedules idle when selected'] = test => {
    let client = makeClient();
    client.state = client.states.SELECTED;

    let realSetTimeout = global.setTimeout;
    let idleCalled = false;
    client.idle = async () => {
        idleCalled = true;
    };
    // Intercept the 15s idle timer and fire it synchronously
    global.setTimeout = (fn, ms) => {
        if (ms === 15 * 1000) {
            fn();
            return { unref() {} };
        }
        return realSetTimeout(fn, ms);
    };
    try {
        client.autoidle();
    } finally {
        global.setTimeout = realSetTimeout;
    }
    test.ok(idleCalled);
    test.done();
};

// ============================================================================
// getLogger
// ============================================================================

module.exports['Internals: getLogger uses provided logger object'] = test => {
    let entries = [];
    let custom = {
        trace: o => entries.push(['trace', o]),
        debug: o => entries.push(['debug', o]),
        info: o => entries.push(['info', o]),
        warn: o => entries.push(['warn', o]),
        error: o => entries.push(['error', o]),
        fatal: o => entries.push(['fatal', o])
    };
    let client = makeClient({ logger: custom });
    client.log.info({ msg: 'hello' });
    test.ok(entries.some(e => e[0] === 'info'));
    test.done();
};

module.exports['Internals: getLogger falls back to console for missing fatal/error level'] = test => {
    // Logger object missing the 'error' method -> falls through to console.log
    let partial = {
        trace() {},
        debug() {},
        info() {},
        warn() {}
        // no error, no fatal
    };
    let client = makeClient({ logger: partial });
    let origConsoleLog = console.log;
    let logged = [];
    console.log = (...args) => logged.push(args);
    try {
        client.log.error({ msg: 'boom' });
    } finally {
        console.log = origConsoleLog;
    }
    test.ok(logged.length >= 1);
    test.done();
};

module.exports['Internals: getLogger emits log events when emitLogs set'] = test => {
    let client = makeClient({ logger: false });
    client.emitLogs = true;
    let events = [];
    client.on('log', entry => events.push(entry));
    let err = new Error('with stack');
    err.code = 'XCODE';
    client.log.warn({ msg: 'warned', err });
    test.equal(events.length, 1);
    test.equal(events[0].level, 'warn');
    test.equal(events[0].err.code, 'XCODE');
    test.ok(events[0].err.stack);
    test.done();
};

module.exports['Internals: logger:false suppresses output but still allows log calls'] = test => {
    let client = makeClient({ logger: false });
    // Should not throw
    client.log.debug({ msg: 'nothing happens' });
    test.ok(true);
    test.done();
};

// ============================================================================
// Misc branch coverage
// ============================================================================

module.exports['Internals: secure connection defaults to port 993'] = test => {
    let client = new ImapFlow({ secure: true });
    test.equal(client.port, 993);
    test.done();
};

module.exports['Internals: getUntaggedHandler ignores non-string type token'] = test => {
    let client = makeClient();
    client.untaggedHandlers = { '5': () => 'numeric-keyword-handler' };
    // numeric prefix but attributes[0].value is not a string -> keyword stays '5'
    let handler = client.getUntaggedHandler('5', [{ type: 'ATOM', value: 12345 }]);
    test.equal(handler(), 'numeric-keyword-handler');
    test.done();
};

module.exports['Internals: untaggedVanished filters non-string tag entries'] = async test => {
    let client = makeClient();
    client.mailbox = { path: 'INBOX' };
    let events = [];
    client.on('expunge', e => events.push(e));
    await client.untaggedVanished({
        attributes: [[{ value: 12345 }], { value: '7' }] // non-string tag value filtered out
    });
    test.equal(events.length, 1);
    test.equal(events[0].earlier, false);
    test.done();
};

module.exports['Internals: setFlagColor returns false when STORE yields falsy'] = async test => {
    let client = makeClient();
    client.mailbox = { path: 'INBOX', exists: 5 };
    client.socket = { destroyed: false };
    client.run = async () => false; // both add and remove STORE return falsy
    let res = await client.setFlagColor('1', 'red');
    test.equal(res, false);
    test.done();
};

module.exports['Internals: fetchOne with falsy seq coerces to empty string'] = async test => {
    let client = makeClient();
    client.mailbox = { path: 'INBOX', exists: 5 };
    let captured = null;
    client.run = async (cmd, seq) => {
        captured = seq;
        return { list: [] };
    };
    let res = await client.fetchOne(0, {});
    test.equal(captured, ''); // (0 || '').toString()
    test.equal(res, false);
    test.done();
};

module.exports['Internals: unbind falls back to socket when writeSocket missing'] = test => {
    let client = makeClient();
    let raw = {
        unpipe() {},
        on() {},
        once() {},
        removeListener() {}
    };
    client.socket = raw;
    client.writeSocket = null;
    client.streamer = { /* unused here */ };
    let result = client.unbind();
    test.equal(result.writeSocket, raw);
    test.done();
};

// ============================================================================
// untaggedFetch flag/modseq branches
// ============================================================================

module.exports['Internals: untaggedFetch includes modseq and flagColor'] = async test => {
    let client = makeClient();
    client.mailbox = { path: 'INBOX', exists: 5 };
    let evt = null;
    client.on('flags', e => {
        evt = e;
    });
    let untagged = {
        command: '2',
        attributes: [
            { type: 'ATOM', value: 'FETCH' },
            [
                { type: 'ATOM', value: 'UID' },
                { type: 'ATOM', value: '20' },
                { type: 'ATOM', value: 'MODSEQ' },
                [{ type: 'ATOM', value: '4242' }],
                { type: 'ATOM', value: 'FLAGS' },
                [{ type: 'ATOM', value: '\\Flagged' }]
            ]
        ]
    };
    await client.untaggedFetch(untagged);
    test.ok(evt);
    test.equal(evt.uid, 20);
    test.ok(evt.modseq);
    // \\Flagged with no MailFlagBit keywords maps to the red color
    test.equal(evt.flagColor, 'red');
    test.done();
};
