import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../src/imap-flow.js';

// Helper: create a minimal mock context with the fetch() generator bound to it.
// The `run` override controls how untagged FETCH responses are delivered.
const createFetchContext = (runOverride: any) => ({
    id: 'test-cid',
    mailbox: { path: 'INBOX', exists: 10 },
    isClosed: false,
    socket: { destroyed: false },
    resolveRange: async (range: any) => range,
    createConnectionError: ImapFlow.prototype.createConnectionError,
    run: runOverride
});

// Helper: invoke the fetch generator on a mock context
function callFetch(ctx: any, range: any, query: any, options: any) {
    return ImapFlow.prototype.fetch.call(ctx, range, query, options);
}

// Helper: create a mock `run` that delivers `count` untagged FETCH responses,
// each with a `next` callback for backpressure. Returns a tracking object.
function createMockRun(count: any) {
    const tracker: any[] = {
        nextCalls: [], // records which message indices had next() called
        onUntaggedFetch: null,
        runResolved: false
    } as any;

    const run = async (_cmd: any, _range: any, _query: any, opts: any) => {
        (tracker as any).onUntaggedFetch = opts.onUntaggedFetch;

        for (let i = 0; i < count; i++) {
            await new Promise<void>(resolve => {
                opts.onUntaggedFetch({ seq: i + 1, uid: 100 + i }, () => {
                    (tracker as any).nextCalls.push(i);
                    resolve();
                });
            });
        }
        (tracker as any).runResolved = true;
    };

    return { tracker, run };
}

describe('fetch-generator', () => {
    // ---------------------------------------------------------------------------
    // Test: early break releases backpressure
    // ---------------------------------------------------------------------------
    it('fetch generator: early break releases backpressure', async () => {
        const { tracker, run }: any = createMockRun(5);
        const ctx = createFetchContext(run);

        const gen = (callFetch as any)(ctx, '1:5', { uid: true });
        // Consume only the first message and break
        for await (let msg of gen) {
            assert.ok(msg.seq === 1, 'should receive the first message');
            break;
        }

        // Allow microtasks to flush (the finally block runs synchronously with
        // generator return, but the remaining run() deliveries are async)
        await new Promise(r => setTimeout(r, 50));

        // The first message had next() called by the yield loop (res.next()).
        // Remaining queued/future messages should have next() called by the
        // finally block or the aborted guard.
        assert.equal(tracker.nextCalls.length, 5, 'all 5 messages should have next() called');
    });

    // ---------------------------------------------------------------------------
    // Test: subsequent operations work after early exit
    // ---------------------------------------------------------------------------
    it('fetch generator: connection usable after early break', async () => {
        let runCallCount = 0;

        const run = async (_cmd: any, _range: any, _query: any, opts: any) => {
            runCallCount++;
            // Deliver 3 messages
            for (let i = 0; i < 3; i++) {
                await new Promise<void>(resolve => {
                    opts.onUntaggedFetch({ seq: i + 1, uid: 200 + i }, () => resolve());
                });
            }
        };

        const ctx = createFetchContext(run);

        // First fetch: break early
        const gen1 = (callFetch as any)(ctx, '1:3', { uid: true });
        for await (let msg of gen1) {
            assert.ok(msg.seq === 1);
            break;
        }

        await new Promise(r => setTimeout(r, 50));

        // Second fetch: should work (run gets called again)
        const gen2 = (callFetch as any)(ctx, '1:3', { uid: true });
        let secondFetchMessages = [];
        for await (let msg of gen2) {
            secondFetchMessages.push(msg);
        }

        assert.ok(runCallCount === 2, 'run was called for both fetch operations');
        assert.ok(secondFetchMessages.length === 3, 'second fetch received all 3 messages');
    });

    // ---------------------------------------------------------------------------
    // Test: normal full iteration works correctly
    // ---------------------------------------------------------------------------
    it('fetch generator: normal full iteration receives all messages', async () => {
        const { tracker, run }: any = createMockRun(4);
        const ctx = createFetchContext(run);

        let messages = [];
        for await (let msg of (callFetch as any)(ctx, '1:4', { uid: true })) {
            messages.push(msg);
        }

        assert.equal(messages.length, 4, 'should receive all 4 messages');
        assert.equal(messages[0].seq, 1);
        assert.equal(messages[3].seq, 4);
        assert.equal(tracker.nextCalls.length, 4, 'all next() callbacks were called');
    });

    // ---------------------------------------------------------------------------
    // Test: error thrown in loop body releases backpressure
    // ---------------------------------------------------------------------------
    it('fetch generator: error in loop body releases backpressure', async () => {
        const { tracker, run }: any = createMockRun(5);
        const ctx = createFetchContext(run);

        const gen = (callFetch as any)(ctx, '1:5', { uid: true });

        let caught = false;
        try {
            for await (let msg of gen) {
                if (msg.seq === 2) {
                    throw new Error('intentional test error');
                }
            }
        } catch (err: any) {
            caught = true;
            assert.equal(err.message, 'intentional test error');
        }

        await new Promise(r => setTimeout(r, 50));

        assert.ok(caught, 'error was caught');
        // Messages 0 and 1 had next() called by the yield loop. The rest should
        // be drained by the finally block or the aborted guard.
        assert.equal(tracker.nextCalls.length, 5, 'all 5 messages should have next() called');
    });

    // ---------------------------------------------------------------------------
    // Test: zero messages from server
    // ---------------------------------------------------------------------------
    it('fetch generator: zero messages yields nothing', async () => {
        const { tracker, run }: any = createMockRun(0);
        const ctx = createFetchContext(run);

        let messages = [];
        for await (let msg of (callFetch as any)(ctx, '1:*', { uid: true })) {
            messages.push(msg);
        }

        assert.equal(messages.length, 0, 'no messages should be yielded');
        assert.equal(tracker.nextCalls.length, 0, 'no next() calls needed');
        assert.ok((tracker as any).runResolved, 'run should have resolved');
    });

    // ---------------------------------------------------------------------------
    // Test: connection closed during iteration throws and releases backpressure
    // ---------------------------------------------------------------------------
    it('fetch generator: connection closed mid-iteration throws and cleans up', async () => {
        const tracker: any[] = {
            nextCalls: []
        } as any;

        const run = async (_cmd: any, _range: any, _query: any, opts: any) => {
            for (let i = 0; i < 3; i++) {
                await new Promise<void>(resolve => {
                    opts.onUntaggedFetch({ seq: i + 1, uid: 300 + i }, () => {
                        (tracker as any).nextCalls.push(i);
                        resolve();
                    });
                });
            }
        };

        const ctx = createFetchContext(run);

        let caught = false;
        try {
            for await (let msg of (callFetch as any)(ctx, '1:3', { uid: true })) {
                if (msg.seq === 1) {
                    // Simulate connection closing after first message
                    ctx.isClosed = true;
                }
            }
        } catch (err: any) {
            caught = true;
            assert.equal(err.code, 'EConnectionClosed', 'should throw EConnectionClosed');
        }

        await new Promise(r => setTimeout(r, 50));

        assert.ok(caught, 'error was caught');
        assert.equal((tracker as any).nextCalls.length, 3, 'all next() callbacks should be called for cleanup');
    });
});
