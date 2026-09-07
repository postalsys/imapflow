import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../src/imap-flow.js';
import { withFakeTimers } from './fixtures/fake-timers.js';
import { makeClient, makeIdleReadyClient } from './fixtures/test-client.js';

// A writable client whose raw traffic log is captured, for the two logRaw branches
const makeRawLogClient: any = (rawSensitiveCommand: any) => {
    let logs: any = [];
    let written: any = [];
    let client = makeClient({ logRaw: true });
    client.log = { trace: (o: any) => logs.push(o), debug: () => {}, warn: () => {}, error: () => {}, info: () => {} };
    client.socket = { destroyed: false };
    client.writeSocket = { destroyed: false, write: (c: any) => written.push(c) };
    client.rawSensitiveCommand = rawSensitiveCommand;
    return { client, logs, written };
};

// ============================================================================
// rejectUnparsedCompletion
// ============================================================================

// Installs a command that is current and on the wire, returning a holder for
// the rejection the reader loop would deliver to the caller
const armInFlight = (client: any, tag: any) => {
    let captured = { err: null };
    client.currentRequest = { tag, sent: true };
    client.requestTagMap.set(tag, {
        tag,
        reject: (err: any) => {
            captured.err = err;
        }
    });
    return captured;
};

describe('imap-flow-internals', () => {
    // Targeted unit tests for low-level ImapFlow internals that are awkward to reach
    // through a full session: emitError routing, write() guards, run() dispatch
    // guards, the synthetic logger, the streamer error handler, autoidle scheduling
    // and the untaggedFetch flag/modseq branches.

    // ============================================================================
    // emitError
    // ============================================================================
    it('Internals: emitError ignores falsy error', () => {
        let client = makeClient();
        let emitted = false;
        client.on('error', () => {
            emitted = true;
        });
        client.emitError(null);
        assert.equal(emitted, false);
    });
    it('Internals: emitError routes to upgrade rejector while upgrading', () => {
        let client = makeClient();
        client.socket = { destroyed: true, destroy: () => {} };
        client.upgrading = true;
        let rejected = null;
        // Stands in for the upgrade's settle() helper, which owns clearing `upgrading`,
        // the upgrade timer and the temporary handshake handlers.
        client._upgradeReject = (err: any) => {
            rejected = err;
            client.upgrading = false;
        };
        let err = new Error('tls boom');
        client.emitError(err);
        assert.equal(rejected, err);
        assert.equal(client._upgradeReject, null, 'the rejector is consumed exactly once');
        assert.equal(client.upgrading, false);
    });
    it('Internals: emitError closes when an upgrade has no rejector', () => {
        let client = makeClient();
        client.socket = { destroyed: true, destroy: () => {} };
        client.upgrading = true;
        client._upgradeReject = null;

        let emitted = false;
        client.on('error', () => {
            emitted = true;
        });

        client.emitError(new Error('tls boom'));

        assert.equal(client.upgrading, false, 'the upgrade flag is cleared');
        assert.equal(emitted, false, 'no duplicate error event while the upgrade owns reporting');
        client.close();
    });
    it('Internals: emitError rejects pending connect promise', () => {
        let client = makeClient();
        client.socket = { destroyed: true, destroy: () => {} };
        let rejected = null;
        client.initialReject = (err: any) => {
            rejected = err;
        };
        client.initialResolve = () => {};
        let err = new Error('connect boom');
        client.emitError(err);
        assert.equal(rejected, err);
        assert.equal(client.initialReject, false);
    });
    it('Internals: emitError emits error event as fallback', () => {
        let client = makeClient();
        client.socket = { destroyed: true, destroy: () => {} };
        let emitted = null;
        client.on('error', (err: any) => {
            emitted = err;
        });
        let err: any = new Error('plain boom');
        client.emitError(err);
        assert.equal(emitted, err);
        assert.equal(err._connId, client.id);
    });

    // ============================================================================
    // streamer error handler
    // ============================================================================
    it('Internals: streamer error handler silently closes on transient codes', () => {
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
        assert.ok(closeAfterCalled);
        assert.equal(emitted, false);
    });
    it('Internals: streamer error handler emits on other codes', () => {
        let client = makeClient();
        client.socket = { destroyed: true, destroy: () => {} };
        let emitted = null;
        client.on('error', (err: any) => {
            emitted = err;
        });
        client._streamerErrorHandler({ code: 'EOTHER', message: 'weird' });
        assert.ok(emitted);
    });

    // ============================================================================
    // write()
    // ============================================================================
    it('Internals: write throws when socket destroyed', () => {
        let client = makeClient();
        client.socket = { destroyed: true };
        assert.throws(() => client.write('A NOOP'), /Socket is already closed/);
    });
    it('Internals: write throws after logout', () => {
        let client = makeClient();
        client.socket = { destroyed: false };
        client.state = client.states.LOGOUT;
        assert.throws(() => client.write('A NOOP'), /Can not send data after logged out/);
    });
    it('Internals: write closes when writeSocket destroyed', () => {
        let client = makeClient();
        client.socket = { destroyed: false };
        client.writeSocket = { destroyed: true };
        client.state = client.states.AUTHENTICATED;
        let closed = false;
        client.close = () => {
            closed = true;
        };
        let res = client.write('A NOOP');
        assert.equal(res, undefined);
        assert.ok(closed);
    });
    it('Internals: write returns false for non-string non-buffer', () => {
        let client = makeClient();
        let written = [];
        client.socket = { destroyed: false };
        client.writeSocket = { destroyed: false, write: (c: any) => written.push(c) };
        client.state = client.states.AUTHENTICATED;
        client.commandParts = [];
        let res = client.write({ not: 'a buffer' });
        assert.equal(res, false);
        assert.equal(written.length, 0);
    });
    it('Internals: write logs raw data when logRaw enabled', () => {
        let { client, logs, written } = makeRawLogClient(false);
        client.write('A NOOP');
        let entry = logs.find((l: any) => l.src === 'c' && l.msg === 'write to socket');
        assert.ok(entry);
        assert.equal(Buffer.from(entry.data, 'base64').toString(), 'A NOOP\r\n');
        assert.ok(!entry.hidden);
        assert.equal(written.length, 1);
    });
    it('Internals: write withholds raw data for a credential-bearing command', () => {
        // send() sets this for LOGIN/AUTHENTICATE before the first frame reaches the socket
        let { client, logs, written } = makeRawLogClient(true);
        client.write('A1 LOGIN "user" "hunter2"');
        let entry = logs.find((l: any) => l.src === 'c' && l.msg === 'write to socket');
        assert.ok(entry);
        assert.ok(entry.hidden);
        // The placeholder is fixed width, so the entry cannot disclose the password length
        assert.equal(Buffer.from(entry.data, 'base64').toString(), '(* value hidden *)\r\n');
        // The frame itself is still written to the socket unchanged
        assert.equal(written[0].toString(), 'A1 LOGIN "user" "hunter2"\r\n');
    });
    it('Internals: send marks credential-bearing commands for the raw log', async () => {
        let client = makeClient();
        let written = [];
        client.socket = { destroyed: false };
        client.writeSocket = { destroyed: false, write: (c: any) => written.push(c) };

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
        assert.equal(client.rawSensitiveCommand, true);

        await client.send({ tag: 'A2', command: 'NOOP', attributes: [], options: {} });
        assert.equal(client.rawSensitiveCommand, false);

        // A command outside the list still masks if it marks an attribute sensitive, so the
        // declarative marker alone is enough to keep a new command out of the raw log. Nested
        // because the command compiler honors the marker at any depth.
        await client.send({
            tag: 'A3',
            command: 'SETMETADATA',
            attributes: [{ type: 'ATOM', value: 'INBOX' }, [{ type: 'STRING', value: 'token', sensitive: true }]],
            options: {}
        });
        assert.equal(client.rawSensitiveCommand, true);
    });
    it('Internals: write appends CRLF only on final part', () => {
        let client = makeClient();
        let written: any = [];
        client.socket = { destroyed: false };
        client.writeSocket = { destroyed: false, write: (c: any) => written.push(c) };
        client.state = client.states.AUTHENTICATED;
        // Pending command parts => no CRLF appended to this chunk
        client.commandParts = ['more'];
        client.write(Buffer.from('literal'));
        assert.equal(written[0].toString(), 'literal');
    });

    // ============================================================================
    // run()
    // ============================================================================
    it('Internals: run returns false for unknown command', async () => {
        let client = makeClient();
        client.socket = { destroyed: false };
        let res = await client.run('NOT_A_COMMAND');
        assert.equal(res, false);
    });
    it('Internals: run throws NoConnection without socket', async () => {
        let client = makeClient();
        client.socket = null;
        let err: any = null;
        try {
            await client.run('NOOP');
        } catch (e) {
            err = e;
        }
        assert.ok(err);
        assert.equal(err.code, 'NoConnection');
    });
    it('Internals: run invokes preCheck and command handler', async () => {
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
                async (conn: any, a: any, b: any) => {
                    handlerArgs = [a, b];
                    return 'handled';
                }
            ]
        ]);
        let res = await client.run('TESTCMD', 1, 2);
        assert.equal(res, 'handled');
        assert.ok(preCheckCalled);
        assert.deepEqual(handlerArgs, [1, 2]);
    });

    // ============================================================================
    // autoidle
    // ============================================================================
    it('Internals: autoidle does nothing when not selected', () => {
        let client = makeClient();
        client.state = client.states.AUTHENTICATED;
        client.autoidle();
        assert.equal(client.idleStartTimer, undefined);
    });
    it('Internals: autoidle schedules idle when selected', async () => {
        await withFakeTimers(async timers => {
            let client = makeIdleReadyClient();

            let idleCalled = false;
            client.idle = async () => {
                idleCalled = true;
            };

            client.autoidle();
            await timers.fire();

            assert.ok(idleCalled);
        });
    });

    // ============================================================================
    // getLogger
    // ============================================================================
    it('Internals: getLogger uses provided logger object', () => {
        let entries: any = [];
        let custom = {
            trace: (o: any) => entries.push(['trace', o]),
            debug: (o: any) => entries.push(['debug', o]),
            info: (o: any) => entries.push(['info', o]),
            warn: (o: any) => entries.push(['warn', o]),
            error: (o: any) => entries.push(['error', o]),
            fatal: (o: any) => entries.push(['fatal', o])
        };
        let client = makeClient({ logger: custom });
        client.log.info({ msg: 'hello' });
        assert.ok(entries.some((e: any) => e[0] === 'info'));
    });
    it('Internals: getLogger falls back to console for missing fatal/error level', () => {
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
        let logged: any = [];
        console.error = (...args) => logged.push(args);
        try {
            let err: any = new Error('boom failure');
            err.code = 'XBOOM';
            // The answer is often one level down: this library attaches the underlying failure
            // as an enumerable `_err`
            (err as any)._err = Object.assign(new Error('inner failure'), { code: 'ECONNREFUSED' });
            client.log.error({ msg: 'boom', err });
            // A circular structure must not throw out of the log call, and must not be dropped
            let circular: any = { msg: 'loop' };
            circular.self = circular;
            client.log.error(circular);
        } finally {
            console.error = origConsoleError;
        }
        assert.equal(logged.length, 2);
        // The Error was flattened, so message, stack and enumerable fields survive stringify
        let entry: any = JSON.parse(logged[0][0]);
        assert.equal(entry.msg, 'boom');
        assert.equal(entry.err.message, 'boom failure');
        assert.equal(entry.err.code, 'XBOOM');
        assert.ok(entry.err.stack);
        assert.equal(entry.err._err.message, 'inner failure');
        assert.equal(entry.err._err.code, 'ECONNREFUSED');
        // Unserializable entries still reach console.error, just not as JSON
        assert.equal(logged[1][0].msg, 'loop');
    });
    it('Internals: getLogger keeps cause and AggregateError members', () => {
        let client = makeClient({ emitLogs: true });
        let entries: any = [];
        client.on('log', (entry: any) => entries.push(entry));

        let inner = Object.assign(new Error('inner failure'), { code: 'ECONNREFUSED' });
        client.log.error({ msg: 'wrapped', err: new Error('outer failure', { cause: inner }) });
        // Node reports a multi-address connect failure as an AggregateError
        client.log.error({ msg: 'aggregate', err: new AggregateError([inner], 'all attempts failed') });

        assert.equal(entries[0].err.cause.message, 'inner failure');
        assert.equal(entries[0].err.cause.code, 'ECONNREFUSED');
        assert.equal(entries[1].err.errors.length, 1);
        assert.equal(entries[1].err.errors[0].message, 'inner failure');
    });
    it('Internals: getLogger bounds a looping and a deep error chain', () => {
        let client = makeClient({ emitLogs: true });
        let entries: any = [];
        client.on('log', (entry: any) => entries.push(entry));

        // A chain that loops back must terminate rather than recurse forever
        let looping: any = new Error('looping failure');
        looping._err = looping;
        client.log.error({ msg: 'loop', err: looping });
        assert.equal(entries[0].err.message, 'looping failure');
        assert.equal(entries[0].err._err, 'looping failure');

        // A chain longer than the depth cap is truncated rather than walked to the end
        let deep = new Error('level 0');
        for (let i = 1; i <= 6; i++) {
            deep = Object.assign(new Error(`level ${i}`), { _err: deep });
        }
        client.log.error({ msg: 'deep', err: deep });
        assert.equal(entries[1].err._err._err._err.message, 'level 3');
        // Past the cap the chain collapses to messages instead of being walked to the end
        assert.equal(entries[1].err._err._err._err._err, 'level 2');
    });
    it('Internals: getLogger never throws out of a log call', () => {
        let client = makeClient({ emitLogs: true });
        let entries = [];
        client.on('log', (entry: any) => entries.push(entry));

        // A throwing property getter on the logged error must not escape
        let hostile = {
            get message() {
                throw new Error('getter blew up');
            },
            stack: 'x'
        };
        assert.doesNotThrow(() => client.log.warn({ msg: 'hostile', err: hostile }));

        // Neither must a throwing 'log' listener
        client.on('log', () => {
            throw new Error('listener blew up');
        });
        assert.doesNotThrow(() => client.log.warn({ msg: 'still fine' }));
    });
    it('Internals: getLogger emits log events when emitLogs set', () => {
        let client = makeClient({ logger: false });
        client.emitLogs = true;
        let events: any = [];
        client.on('log', (entry: any) => events.push(entry));
        let err: any = new Error('with stack');
        err.code = 'XCODE';
        client.log.warn({ msg: 'warned', err });
        assert.equal(events.length, 1);
        assert.equal(events[0].level, 'warn');
        assert.equal(events[0].err.code, 'XCODE');
        assert.ok(events[0].err.stack);
    });
    it('Internals: logger:false suppresses output but still allows log calls', () => {
        let client = makeClient({ logger: false });
        // Should not throw
        client.log.debug({ msg: 'nothing happens' });
        assert.ok(true);
    });

    // ============================================================================
    // Misc branch coverage
    // ============================================================================
    it('Internals: secure connection defaults to port 993', () => {
        let client = new ImapFlow({ secure: true });
        assert.equal(client.port, 993);
    });
    it('Internals: getUntaggedHandler ignores non-string type token', () => {
        let client = makeClient();
        client.untaggedHandlers = { 5: () => 'numeric-keyword-handler' };
        // numeric prefix but attributes[0].value is not a string -> keyword stays '5'
        let handler = client.getUntaggedHandler('5', [{ type: 'ATOM', value: 12345 }]);
        assert.equal(handler(), 'numeric-keyword-handler');
    });
    it('Internals: untaggedVanished filters non-string tag entries', async () => {
        let client = makeClient();
        client.mailbox = { path: 'INBOX' };
        let events: any = [];
        client.on('expunge', (e: any) => events.push(e));
        await client.untaggedVanished({
            attributes: [[{ value: 12345 }], { value: '7' }] // non-string tag value filtered out
        });
        assert.equal(events.length, 1);
        assert.equal(events[0].earlier, false);
    });
    it('Internals: setFlagColor returns false when STORE yields falsy', async () => {
        let client = makeClient();
        client.mailbox = { path: 'INBOX', exists: 5 };
        client.socket = { destroyed: false };
        client.run = async () => false; // both add and remove STORE return falsy
        let res = await client.setFlagColor('1', 'red');
        assert.equal(res, false);
    });
    it('Internals: fetchOne with falsy seq coerces to empty string', async () => {
        let client = makeClient();
        client.mailbox = { path: 'INBOX', exists: 5 };
        let captured = null;
        client.run = async (cmd: any, seq: any) => {
            captured = seq;
            return { list: [] };
        };
        let res = await client.fetchOne(0, {});
        assert.equal(captured, ''); // (0 || '').toString()
        assert.equal(res, false);
    });
    it('Internals: unbind falls back to socket when writeSocket missing', () => {
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
        assert.equal(result.writeSocket, raw);
    });

    // ============================================================================
    // untaggedFetch flag/modseq branches
    // ============================================================================
    it('Internals: untaggedFetch includes modseq and flagColor', async () => {
        let client = makeClient();
        client.mailbox = { path: 'INBOX', exists: 5 };
        let evt: any = null;
        client.on('flags', (e: any) => {
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
        assert.ok(evt);
        assert.equal(evt.uid, 20);
        assert.ok((evt as any).modseq);
        // \\Flagged with no MailFlagBit keywords maps to the red color
        assert.equal((evt as any).flagColor, 'red');
    });

    // ============================================================================
    // runInternal dispatch guards
    // ============================================================================
    it('Internals: runInternal returns false for unknown command', async () => {
        let client = makeClient();
        client.socket = { destroyed: false };
        let res = await client.runInternal('NOT_A_COMMAND');
        assert.equal(res, false);
    });
    it('Internals: runInternal throws NoConnection when the socket is destroyed', async () => {
        let client = makeClient();
        client.socket = { destroyed: true };
        let err: any = null;
        try {
            await client.runInternal('NOOP');
        } catch (e) {
            err = e;
        }
        assert.ok(err);
        assert.equal(err.code, 'NoConnection');
    });

    // ============================================================================
    // send() onSend error containment
    // ============================================================================
    it('Internals: send contains a throwing onSend callback', async () => {
        let client = makeClient();
        let written: any = [];
        let warnings: any = [];
        client.socket = { destroyed: false };
        client.writeSocket = { destroyed: false, write: (chunk: any) => written.push(chunk) };
        client.state = client.states.AUTHENTICATED;
        client.log.warn = (entry: any) => warnings.push(entry);
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

        assert.equal(written.length, 1, 'the command was written to the socket');
        assert.equal(written[0].toString(), 'A1 NOOP\r\n', 'the actual wire bytes went out before onSend ran');
        assert.equal(client.currentRequest.sent, true, 'the request is marked as sent');
        assert.ok(
            warnings.some((entry: any) => entry && entry.err && entry.err.message === 'onSend boom'),
            'the callback error was logged'
        );
    });

    // ============================================================================
    // countUnknownTag teardown guard
    // ============================================================================
    it('Internals: countUnknownTag ignores tags on a closed connection', () => {
        let client = makeClient();
        client.isClosed = true;
        client.countUnknownTag('A1');
        assert.equal(client._unknownTagCount, 0, 'teardown crossover is not counted');
    });
    it('Internals: rejectUnparsedCompletion ignores lines without an in-flight command', () => {
        let client = makeClient();

        client.currentRequest = false;
        client.rejectUnparsedCompletion(Buffer.from('A1 OK done'), new Error('parse fail'));
        assert.equal(client.currentRequest, false, 'no request to settle');

        // A command that is current but not yet on the wire must not be settled either
        client.currentRequest = { tag: 'A1', sent: false };
        client.rejectUnparsedCompletion(Buffer.from('A1 OK done'), new Error('parse fail'));
        assert.ok(client.currentRequest, 'the unsent request is untouched');
    });
    it('Internals: rejectUnparsedCompletion recovers the tag from NUL-padded raw bytes', async () => {
        let client = makeClient();
        let captured: any = armInFlight(client, 'A1');

        // The parser died before extracting a tag - the raw line carries the buggy-server
        // NUL padding, so the fallback must skip it and stop at the first non-tag byte
        let parserError = new Error('parse fail');
        client.rejectUnparsedCompletion(Buffer.from('\x00\x00A1 \x07garbage'), parserError);

        assert.ok(captured.err, 'the in-flight command was failed');
        assert.equal(captured.err.code, 'ParserError');
        assert.equal((captured.err as any).parserError, parserError);
        assert.equal(client.currentRequest, false, 'the request slot was cleared');
    });
    it('Internals: rejectUnparsedCompletion ignores a mismatched raw tag', () => {
        let client = makeClient();
        let captured = armInFlight(client, 'A1');

        client.rejectUnparsedCompletion(Buffer.from('A2 NO other'), new Error('parse fail'));

        assert.equal(captured.err, null, 'a line for another tag settles nothing');
        assert.ok(client.currentRequest, 'the in-flight request stays current');
    });
});
