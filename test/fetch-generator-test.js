'use strict';

const { ImapFlow } = require('../lib/imap-flow');

// Helper: create a minimal mock context with the fetch() generator bound to it.
// The `run` override controls how untagged FETCH responses are delivered.
const createFetchContext = runOverride => ({
    mailbox: { path: 'INBOX', exists: 10 },
    isClosed: false,
    socket: { destroyed: false },
    resolveRange: async range => range,
    run: runOverride
});

// Helper: invoke the fetch generator on a mock context
function callFetch(ctx, range, query, options) {
    return ImapFlow.prototype.fetch.call(ctx, range, query, options);
}

// Helper: create a mock `run` that delivers `count` untagged FETCH responses,
// each with a `next` callback for backpressure. Returns a tracking object.
function createMockRun(count) {
    const tracker = {
        nextCalls: [], // records which message indices had next() called
        onUntaggedFetch: null,
        runResolved: false
    };

    const run = async (_cmd, _range, _query, opts) => {
        tracker.onUntaggedFetch = opts.onUntaggedFetch;

        for (let i = 0; i < count; i++) {
            await new Promise(resolve => {
                opts.onUntaggedFetch({ seq: i + 1, uid: 100 + i }, () => {
                    tracker.nextCalls.push(i);
                    resolve();
                });
            });
        }
        tracker.runResolved = true;
    };

    return { tracker, run };
}

// ---------------------------------------------------------------------------
// Test: early break releases backpressure
// ---------------------------------------------------------------------------
module.exports['fetch generator: early break releases backpressure'] = async test => {
    const { tracker, run } = createMockRun(5);
    const ctx = createFetchContext(run);

    const gen = callFetch(ctx, '1:5', { uid: true });
    // Consume only the first message and break
    for await (let msg of gen) {
        test.ok(msg.seq === 1, 'should receive the first message');
        break;
    }

    // Allow microtasks to flush (the finally block runs synchronously with
    // generator return, but the remaining run() deliveries are async)
    await new Promise(r => setTimeout(r, 50));

    // The first message had next() called by the yield loop (res.next()).
    // Remaining queued/future messages should have next() called by the
    // finally block or the aborted guard.
    test.equal(tracker.nextCalls.length, 5, 'all 5 messages should have next() called');
    test.done();
};

// ---------------------------------------------------------------------------
// Test: subsequent operations work after early exit
// ---------------------------------------------------------------------------
module.exports['fetch generator: connection usable after early break'] = async test => {
    let runCallCount = 0;

    const run = async (_cmd, _range, _query, opts) => {
        runCallCount++;
        // Deliver 3 messages
        for (let i = 0; i < 3; i++) {
            await new Promise(resolve => {
                opts.onUntaggedFetch({ seq: i + 1, uid: 200 + i }, () => resolve());
            });
        }
    };

    const ctx = createFetchContext(run);

    // First fetch: break early
    const gen1 = callFetch(ctx, '1:3', { uid: true });
    for await (let msg of gen1) {
        test.ok(msg.seq === 1);
        break;
    }

    await new Promise(r => setTimeout(r, 50));

    // Second fetch: should work (run gets called again)
    const gen2 = callFetch(ctx, '1:3', { uid: true });
    let secondFetchMessages = [];
    for await (let msg of gen2) {
        secondFetchMessages.push(msg);
    }

    test.ok(runCallCount === 2, 'run was called for both fetch operations');
    test.ok(secondFetchMessages.length === 3, 'second fetch received all 3 messages');
    test.done();
};

// ---------------------------------------------------------------------------
// Test: normal full iteration works correctly
// ---------------------------------------------------------------------------
module.exports['fetch generator: normal full iteration receives all messages'] = async test => {
    const { tracker, run } = createMockRun(4);
    const ctx = createFetchContext(run);

    let messages = [];
    for await (let msg of callFetch(ctx, '1:4', { uid: true })) {
        messages.push(msg);
    }

    test.equal(messages.length, 4, 'should receive all 4 messages');
    test.equal(messages[0].seq, 1);
    test.equal(messages[3].seq, 4);
    test.equal(tracker.nextCalls.length, 4, 'all next() callbacks were called');
    test.done();
};

// ---------------------------------------------------------------------------
// Test: error thrown in loop body releases backpressure
// ---------------------------------------------------------------------------
module.exports['fetch generator: error in loop body releases backpressure'] = async test => {
    const { tracker, run } = createMockRun(5);
    const ctx = createFetchContext(run);

    const gen = callFetch(ctx, '1:5', { uid: true });

    let caught = false;
    try {
        for await (let msg of gen) {
            if (msg.seq === 2) {
                throw new Error('intentional test error');
            }
        }
    } catch (err) {
        caught = true;
        test.equal(err.message, 'intentional test error');
    }

    await new Promise(r => setTimeout(r, 50));

    test.ok(caught, 'error was caught');
    // Messages 0 and 1 had next() called by the yield loop. The rest should
    // be drained by the finally block or the aborted guard.
    test.equal(tracker.nextCalls.length, 5, 'all 5 messages should have next() called');
    test.done();
};

// ---------------------------------------------------------------------------
// Test: zero messages from server
// ---------------------------------------------------------------------------
module.exports['fetch generator: zero messages yields nothing'] = async test => {
    const { tracker, run } = createMockRun(0);
    const ctx = createFetchContext(run);

    let messages = [];
    for await (let msg of callFetch(ctx, '1:*', { uid: true })) {
        messages.push(msg);
    }

    test.equal(messages.length, 0, 'no messages should be yielded');
    test.equal(tracker.nextCalls.length, 0, 'no next() calls needed');
    test.ok(tracker.runResolved, 'run should have resolved');
    test.done();
};

// ---------------------------------------------------------------------------
// Test: connection closed during iteration throws and releases backpressure
// ---------------------------------------------------------------------------
module.exports['fetch generator: connection closed mid-iteration throws and cleans up'] = async test => {
    const tracker = {
        nextCalls: []
    };

    const run = async (_cmd, _range, _query, opts) => {
        for (let i = 0; i < 3; i++) {
            await new Promise(resolve => {
                opts.onUntaggedFetch({ seq: i + 1, uid: 300 + i }, () => {
                    tracker.nextCalls.push(i);
                    resolve();
                });
            });
        }
    };

    const ctx = createFetchContext(run);

    let caught = false;
    try {
        for await (let msg of callFetch(ctx, '1:3', { uid: true })) {
            if (msg.seq === 1) {
                // Simulate connection closing after first message
                ctx.isClosed = true;
            }
        }
    } catch (err) {
        caught = true;
        test.equal(err.code, 'EConnectionClosed', 'should throw EConnectionClosed');
    }

    await new Promise(r => setTimeout(r, 50));

    test.ok(caught, 'error was caught');
    test.equal(tracker.nextCalls.length, 3, 'all next() callbacks should be called for cleanup');
    test.done();
};
