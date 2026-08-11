'use strict';

// Shared ImapFlow construction for unit tests that poke at internals without a live server.
// One definition instead of a per-file copy, so a change to what the constructor needs lands
// in one place and cannot drift between suites.

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

module.exports = { makeClient, makeIdleReadyClient, makeSocketStub, chunkedFetchOne };
