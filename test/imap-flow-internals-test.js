'use strict';

// Targeted unit tests for low-level ImapFlow internals that are awkward to reach
// through a full session: emitError routing, write() guards, run() dispatch
// guards, the synthetic logger, the streamer error handler, autoidle scheduling
// and the untaggedFetch flag/modseq branches.

const { ImapFlow } = require('../lib/imap-flow');
const { withFakeTimers } = require('./fixtures/fake-timers');
const { makeClient, makeIdleReadyClient } = require('./fixtures/test-client');

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
    // Stands in for the upgrade's settle() helper, which owns clearing `upgrading`,
    // the upgrade timer and the temporary handshake handlers.
    client._upgradeReject = err => {
        rejected = err;
        client.upgrading = false;
    };
    let err = new Error('tls boom');
    client.emitError(err);
    test.equal(rejected, err);
    test.equal(client._upgradeReject, null, 'the rejector is consumed exactly once');
    test.equal(client.upgrading, false);
    test.done();
};

module.exports['Internals: emitError closes when an upgrade has no rejector'] = test => {
    let client = makeClient();
    client.socket = { destroyed: true, destroy: () => {} };
    client.upgrading = true;
    client._upgradeReject = null;

    let emitted = false;
    client.on('error', () => {
        emitted = true;
    });

    client.emitError(new Error('tls boom'));

    test.equal(client.upgrading, false, 'the upgrade flag is cleared');
    test.equal(emitted, false, 'no duplicate error event while the upgrade owns reporting');
    client.close();
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

// A writable client whose raw traffic log is captured, for the two logRaw branches
const makeRawLogClient = rawSensitiveCommand => {
    let logs = [];
    let written = [];
    let client = makeClient({ logRaw: true });
    client.log = { trace: o => logs.push(o), debug: () => {}, warn: () => {}, error: () => {}, info: () => {} };
    client.socket = { destroyed: false };
    client.writeSocket = { destroyed: false, write: c => written.push(c) };
    client.rawSensitiveCommand = rawSensitiveCommand;
    return { client, logs, written };
};

module.exports['Internals: write logs raw data when logRaw enabled'] = test => {
    let { client, logs, written } = makeRawLogClient(false);
    client.write('A NOOP');
    let entry = logs.find(l => l.src === 'c' && l.msg === 'write to socket');
    test.ok(entry);
    test.equal(Buffer.from(entry.data, 'base64').toString(), 'A NOOP\r\n');
    test.ok(!entry.hidden);
    test.equal(written.length, 1);
    test.done();
};

module.exports['Internals: write withholds raw data for a credential-bearing command'] = test => {
    // send() sets this for LOGIN/AUTHENTICATE before the first frame reaches the socket
    let { client, logs, written } = makeRawLogClient(true);
    client.write('A1 LOGIN "user" "hunter2"');
    let entry = logs.find(l => l.src === 'c' && l.msg === 'write to socket');
    test.ok(entry);
    test.ok(entry.hidden);
    // The placeholder is fixed width, so the entry cannot disclose the password length
    test.equal(Buffer.from(entry.data, 'base64').toString(), '(* value hidden *)\r\n');
    // The frame itself is still written to the socket unchanged
    test.equal(written[0].toString(), 'A1 LOGIN "user" "hunter2"\r\n');
    test.done();
};

module.exports['Internals: send marks credential-bearing commands for the raw log'] = async test => {
    let client = makeClient();
    let written = [];
    client.socket = { destroyed: false };
    client.writeSocket = { destroyed: false, write: c => written.push(c) };

    // Lower case on purpose: the wire protocol is case-insensitive and exec() passes the
    // caller's spelling through unchanged, so the classification must normalize it
    await client.send({
        tag: 'A1',
        command: 'login',
        attributes: [
            { type: 'STRING', value: 'user' },
            { type: 'STRING', value: 'hunter2', sensitive: true }
        ],
        options: {}
    });
    test.equal(client.rawSensitiveCommand, true);

    await client.send({ tag: 'A2', command: 'NOOP', attributes: [], options: {} });
    test.equal(client.rawSensitiveCommand, false);

    // A command outside the list still masks if it marks an attribute sensitive, so the
    // declarative marker alone is enough to keep a new command out of the raw log. Nested
    // because the command compiler honors the marker at any depth.
    await client.send({
        tag: 'A3',
        command: 'SETMETADATA',
        attributes: [{ type: 'ATOM', value: 'INBOX' }, [{ type: 'STRING', value: 'token', sensitive: true }]],
        options: {}
    });
    test.equal(client.rawSensitiveCommand, true);

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

module.exports['Internals: autoidle schedules idle when selected'] = async test => {
    await withFakeTimers(async timers => {
        let client = makeIdleReadyClient();

        let idleCalled = false;
        client.idle = async () => {
            idleCalled = true;
        };

        client.autoidle();
        await timers.fire();

        test.ok(idleCalled);
    });
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
    // Logger object missing the 'error' method -> falls through to console.error
    let partial = {
        trace() {},
        debug() {},
        info() {},
        warn() {}
        // no error, no fatal
    };
    let client = makeClient({ logger: partial });
    let origConsoleError = console.error;
    let logged = [];
    console.error = (...args) => logged.push(args);
    try {
        let err = new Error('boom failure');
        err.code = 'XBOOM';
        // The answer is often one level down: this library attaches the underlying failure
        // as an enumerable `_err`
        err._err = Object.assign(new Error('inner failure'), { code: 'ECONNREFUSED' });
        client.log.error({ msg: 'boom', err });
        // A circular structure must not throw out of the log call, and must not be dropped
        let circular = { msg: 'loop' };
        circular.self = circular;
        client.log.error(circular);
    } finally {
        console.error = origConsoleError;
    }
    test.equal(logged.length, 2);
    // The Error was flattened, so message, stack and enumerable fields survive stringify
    let entry = JSON.parse(logged[0][0]);
    test.equal(entry.msg, 'boom');
    test.equal(entry.err.message, 'boom failure');
    test.equal(entry.err.code, 'XBOOM');
    test.ok(entry.err.stack);
    test.equal(entry.err._err.message, 'inner failure');
    test.equal(entry.err._err.code, 'ECONNREFUSED');
    // Unserializable entries still reach console.error, just not as JSON
    test.equal(logged[1][0].msg, 'loop');
    test.done();
};

module.exports['Internals: getLogger keeps cause and AggregateError members'] = test => {
    let client = makeClient({ emitLogs: true });
    let entries = [];
    client.on('log', entry => entries.push(entry));

    let inner = Object.assign(new Error('inner failure'), { code: 'ECONNREFUSED' });
    client.log.error({ msg: 'wrapped', err: new Error('outer failure', { cause: inner }) });
    // Node reports a multi-address connect failure as an AggregateError
    client.log.error({ msg: 'aggregate', err: new AggregateError([inner], 'all attempts failed') });

    test.equal(entries[0].err.cause.message, 'inner failure');
    test.equal(entries[0].err.cause.code, 'ECONNREFUSED');
    test.equal(entries[1].err.errors.length, 1);
    test.equal(entries[1].err.errors[0].message, 'inner failure');
    test.done();
};

module.exports['Internals: getLogger bounds a looping and a deep error chain'] = test => {
    let client = makeClient({ emitLogs: true });
    let entries = [];
    client.on('log', entry => entries.push(entry));

    // A chain that loops back must terminate rather than recurse forever
    let looping = new Error('looping failure');
    looping._err = looping;
    client.log.error({ msg: 'loop', err: looping });
    test.equal(entries[0].err.message, 'looping failure');
    test.equal(entries[0].err._err, 'looping failure');

    // A chain longer than the depth cap is truncated rather than walked to the end
    let deep = new Error('level 0');
    for (let i = 1; i <= 6; i++) {
        deep = Object.assign(new Error(`level ${i}`), { _err: deep });
    }
    client.log.error({ msg: 'deep', err: deep });
    test.equal(entries[1].err._err._err._err.message, 'level 3');
    // Past the cap the chain collapses to messages instead of being walked to the end
    test.equal(entries[1].err._err._err._err._err, 'level 2');

    test.done();
};

module.exports['Internals: getLogger never throws out of a log call'] = test => {
    let client = makeClient({ emitLogs: true });
    let entries = [];
    client.on('log', entry => entries.push(entry));

    // A throwing property getter on the logged error must not escape
    let hostile = {
        get message() {
            throw new Error('getter blew up');
        },
        stack: 'x'
    };
    test.doesNotThrow(() => client.log.warn({ msg: 'hostile', err: hostile }));

    // Neither must a throwing 'log' listener
    client.on('log', () => {
        throw new Error('listener blew up');
    });
    test.doesNotThrow(() => client.log.warn({ msg: 'still fine' }));

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
    client.untaggedHandlers = { 5: () => 'numeric-keyword-handler' };
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
    client.streamer = {/* unused here */};
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

// ============================================================================
// runInternal dispatch guards
// ============================================================================

module.exports['Internals: runInternal returns false for unknown command'] = async test => {
    let client = makeClient();
    client.socket = { destroyed: false };
    let res = await client.runInternal('NOT_A_COMMAND');
    test.equal(res, false);
    test.done();
};

module.exports['Internals: runInternal throws NoConnection when the socket is destroyed'] = async test => {
    let client = makeClient();
    client.socket = { destroyed: true };
    let err = null;
    try {
        await client.runInternal('NOOP');
    } catch (e) {
        err = e;
    }
    test.ok(err);
    test.equal(err.code, 'NoConnection');
    test.done();
};

// ============================================================================
// send() onSend error containment
// ============================================================================

module.exports['Internals: send contains a throwing onSend callback'] = async test => {
    let client = makeClient();
    let written = [];
    let warnings = [];
    client.socket = { destroyed: false };
    client.writeSocket = { destroyed: false, write: chunk => written.push(chunk) };
    client.state = client.states.AUTHENTICATED;
    client.log.warn = entry => warnings.push(entry);
    client.currentRequest = { tag: 'A1', sent: false };

    // The command is already on the wire when onSend runs, so a throwing callback
    // must be logged and swallowed instead of rejecting the request
    await client.send({
        tag: 'A1',
        command: 'NOOP',
        attributes: [],
        options: {
            onSend: () => {
                throw new Error('onSend boom');
            }
        }
    });

    test.equal(written.length, 1, 'the command was written to the socket');
    test.equal(written[0].toString(), 'A1 NOOP\r\n', 'the actual wire bytes went out before onSend ran');
    test.equal(client.currentRequest.sent, true, 'the request is marked as sent');
    test.ok(
        warnings.some(entry => entry && entry.err && entry.err.message === 'onSend boom'),
        'the callback error was logged'
    );
    test.done();
};

// ============================================================================
// countUnknownTag teardown guard
// ============================================================================

module.exports['Internals: countUnknownTag ignores tags on a closed connection'] = test => {
    let client = makeClient();
    client.isClosed = true;
    client.countUnknownTag('A1');
    test.equal(client._unknownTagCount, 0, 'teardown crossover is not counted');
    test.done();
};

// ============================================================================
// rejectUnparsedCompletion
// ============================================================================

// Installs a command that is current and on the wire, returning a holder for
// the rejection the reader loop would deliver to the caller
const armInFlight = (client, tag) => {
    let captured = { err: null };
    client.currentRequest = { tag, sent: true };
    client.requestTagMap.set(tag, {
        tag,
        reject: err => {
            captured.err = err;
        }
    });
    return captured;
};

module.exports['Internals: rejectUnparsedCompletion ignores lines without an in-flight command'] = test => {
    let client = makeClient();

    client.currentRequest = false;
    client.rejectUnparsedCompletion(Buffer.from('A1 OK done'), new Error('parse fail'));
    test.equal(client.currentRequest, false, 'no request to settle');

    // A command that is current but not yet on the wire must not be settled either
    client.currentRequest = { tag: 'A1', sent: false };
    client.rejectUnparsedCompletion(Buffer.from('A1 OK done'), new Error('parse fail'));
    test.ok(client.currentRequest, 'the unsent request is untouched');
    test.done();
};

module.exports['Internals: rejectUnparsedCompletion recovers the tag from NUL-padded raw bytes'] = async test => {
    let client = makeClient();
    let captured = armInFlight(client, 'A1');

    // The parser died before extracting a tag - the raw line carries the buggy-server
    // NUL padding, so the fallback must skip it and stop at the first non-tag byte
    let parserError = new Error('parse fail');
    client.rejectUnparsedCompletion(Buffer.from('\x00\x00A1 \x07garbage'), parserError);

    test.ok(captured.err, 'the in-flight command was failed');
    test.equal(captured.err.code, 'ParserError');
    test.equal(captured.err.parserError, parserError);
    test.equal(client.currentRequest, false, 'the request slot was cleared');
    test.done();
};

module.exports['Internals: rejectUnparsedCompletion ignores a mismatched raw tag'] = test => {
    let client = makeClient();
    let captured = armInFlight(client, 'A1');

    client.rejectUnparsedCompletion(Buffer.from('A2 NO other'), new Error('parse fail'));

    test.equal(captured.err, null, 'a line for another tag settles nothing');
    test.ok(client.currentRequest, 'the in-flight request stays current');
    test.done();
};
