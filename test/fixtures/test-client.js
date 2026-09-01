'use strict';

// Shared ImapFlow construction for unit tests that poke at internals without a live server.
// One definition instead of a per-file copy, so a change to what the constructor needs lands
// in one place and cannot drift between suites.

const { Writable } = require('node:stream');

const { ImapFlow } = require('../../lib/imap-flow');

// A socket stub complete enough for setSocketHandlers(), clearSocketHandlers() and close() to
// run against. removeListener/removeAllListeners matter most: close() removes the handlers it
// installed, and a stub without them makes close() throw half-way through teardown with the
// client still holding its socket and streamer references.
const makeSocketStub = () => ({
    destroyed: false,
    destroy: () => {},
    on: () => {},
    once: () => {},
    end: () => {},
    unpipe: () => {},
    removeListener: () => {},
    removeAllListeners: () => {},
    setKeepAlive: () => {},
    setTimeout: () => {}
});

// Bare construction: no socket, no state overrides. Tests that need a transport use
// makeSocketStub() or makeIdleReadyClient() instead of reaching for their own object literals.
const makeClient = (overrides = {}) =>
    new ImapFlow({
        host: '127.0.0.1',
        port: 993,
        logger: false,
        auth: { user: 'test', pass: 'secret' },
        ...overrides
    });

// A client parked in SELECTED with a stubbed socket and a no-op idle(), ready for autoidle(),
// lock handling and watchdog behavior to be exercised directly
const makeIdleReadyClient = (overrides = {}) => {
    let client = makeClient({ maxLockHoldTime: 0, ...overrides });
    client.socket = makeSocketStub();
    client.usable = true;
    client.state = client.states.SELECTED;
    client.mailbox = { path: 'INBOX', readOnly: false };
    client.idle = async () => {};
    return client;
};

// A fetchOne stand-in that serves `body` back in download()'s chunk-query shape
// ({source: {start, maxLength}}), so download tests do not each restate that contract
const chunkedFetchOne = body => async (range, query) => {
    let start = query.source.start;
    let maxLength = query.source.maxLength;
    return { uid: 1, size: body.length, source: body.subarray(start, start + maxLength) };
};

// Installs a process-level unhandledRejection detector for one test. Shared because getting the
// teardown wrong leaks a process listener into every test that runs after it, and because the
// assertion has to read the same way wherever a suite checks that nothing escaped.
const installRejectionDetector = test => {
    // Tracked as a separate flag rather than by testing the reason: a rejection can carry a falsy
    // value, and that is still an escaped rejection.
    let unhandled = false;
    let unhandledReason = null;
    const handler = reason => {
        unhandled = true;
        unhandledReason = reason;
    };
    process.on('unhandledRejection', handler);

    return {
        check() {
            process.removeListener('unhandledRejection', handler);
            test.equal(unhandled, false, 'no unhandledRejection should fire' + (unhandledReason ? ': ' + unhandledReason.message : ''));
        }
    };
};

// A Writable that always defers its callback, so writing to a stream piped into it fills the
// pipeline and forces the producer into backpressure. `delay` is only for tests that also need
// wall-clock time to pass; deferring at all is what triggers the drain wait.
const slowConsumer = (options = {}) => {
    let { delay = 0, onChunk } = options;
    return new Writable({
        highWaterMark: 1,
        write(chunk, enc, cb) {
            if (typeof onChunk === 'function') {
                onChunk(chunk);
            }
            if (delay) {
                setTimeout(cb, delay);
            } else {
                setImmediate(cb);
            }
        }
    });
};

module.exports = { makeClient, makeIdleReadyClient, makeSocketStub, chunkedFetchOne, installRejectionDetector, slowConsumer };
