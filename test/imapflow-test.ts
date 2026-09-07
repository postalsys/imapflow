import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../src/imap-flow.js';

// ---------------------------------------------------------------------------
// Helpers for testing prototype methods on a mock context
// ---------------------------------------------------------------------------
const createFetchContext = (runOverride: any) => ({
    id: 'test-cid',
    mailbox: { path: 'INBOX', exists: 10 },
    isClosed: false,
    socket: { destroyed: false },
    resolveRange: async (range: any) => range,
    createConnectionError: ImapFlow.prototype.createConnectionError,
    run: runOverride
});

function callFetch(ctx: any, range: any, query: any, options: any) {
    return ImapFlow.prototype.fetch.call(ctx, range, query, options);
}

describe('imapflow', () => {
    it('Create imapflow instance', () => {
        let imapFlow = new ImapFlow();
        assert.ok(imapFlow);
    });
    it('Create imapflow instance with custom logger', async () => {
        class CustomLogger {
            constructor() {}

            debug(obj: any) {
                console.log(JSON.stringify(obj));
            }

            info(obj: any) {
                console.log(JSON.stringify(obj));
            }

            warn(obj: any) {
                console.log(JSON.stringify(obj));
            }

            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            error(obj: any) {
                // we don't actually want to log anything here.
            }
        }

        let imapFlow = new ImapFlow({
            logger: new CustomLogger()
        });
        assert.ok(imapFlow);
        try {
            await imapFlow.connect();
        } catch (ex: any) {
            // it is PERFECTLY okay to have an exception here. We expect an ECONNREFUSED if an exception occurs.
            assert.equal(ex.code, 'ECONNREFUSED');
        }
    });

    // ---------------------------------------------------------------------------
    // setFlagColor tests
    // ---------------------------------------------------------------------------
    it('setFlagColor with valid color calls STORE for add and remove', async () => {
        let storeCalls: any = [];
        const ctx = {
            resolveRange: async (range: any) => range,
            run: async (command: any, range: any, flags: any, opts: any) => {
                storeCalls.push({ command, range, flags, operation: opts.operation });
                return true;
            }
        };

        let result = await ImapFlow.prototype.setFlagColor.call(ctx, '1:*', 'orange');

        assert.equal(storeCalls.length, 2, 'run should be called twice');

        assert.equal(storeCalls[0].command, 'STORE');
        assert.equal(storeCalls[0].operation, 'add');
        assert.ok(storeCalls[0].flags.indexOf('\\Flagged') >= 0, 'add flags should include \\Flagged');
        assert.ok(storeCalls[0].flags.indexOf('$MailFlagBit0') >= 0, 'add flags should include $MailFlagBit0');

        assert.equal(storeCalls[1].command, 'STORE');
        assert.equal(storeCalls[1].operation, 'remove');
        assert.ok(storeCalls[1].flags.indexOf('$MailFlagBit1') >= 0, 'remove flags should include $MailFlagBit1');
        assert.ok(storeCalls[1].flags.indexOf('$MailFlagBit2') >= 0, 'remove flags should include $MailFlagBit2');

        assert.ok(result, 'should return truthy result');
    });
    it('setFlagColor with invalid color returns false', async () => {
        let runCalled = false;
        const ctx = {
            resolveRange: async (range: any) => range,
            run: async () => {
                runCalled = true;
            }
        };

        let result = await ImapFlow.prototype.setFlagColor.call(ctx, '1:*', 'invalid');

        assert.strictEqual(result, false, 'should return false for invalid color');
        assert.ok(!runCalled, 'run should not be called');
    });
    it('setFlagColor with empty range returns false', async () => {
        let runCalled = false;
        const ctx = {
            resolveRange: async () => null,
            run: async () => {
                runCalled = true;
            }
        };

        let result = await ImapFlow.prototype.setFlagColor.call(ctx, '1:*', 'orange');

        assert.strictEqual(result, false, 'should return false for empty range');
        assert.ok(!runCalled, 'run should not be called');
    });
    it('setFlagColor with red calls STORE with Flagged in add', async () => {
        let storeCalls: any = [];
        const ctx = {
            resolveRange: async (range: any) => range,
            run: async (command: any, range: any, flags: any, opts: any) => {
                storeCalls.push({ command, range, flags, operation: opts.operation });
                return true;
            }
        };

        let result = await ImapFlow.prototype.setFlagColor.call(ctx, '1:*', 'red');

        // red is index 0 (all bits zero), so add should contain only \Flagged,
        // and remove should contain all three MailFlagBit flags
        assert.ok(storeCalls.length >= 1, 'run should be called at least once');

        let addCall: any = storeCalls.find((c: any) => c.operation === 'add');
        assert.ok(addCall, 'should have an add operation');
        assert.ok(addCall.flags.indexOf('\\Flagged') >= 0, 'add flags should include \\Flagged for red');

        let removeCall: any = storeCalls.find((c: any) => c.operation === 'remove');
        assert.ok(removeCall, 'should have a remove operation');
        assert.ok(removeCall.flags.indexOf('$MailFlagBit0') >= 0, 'remove flags should include $MailFlagBit0');
        assert.ok(removeCall.flags.indexOf('$MailFlagBit1') >= 0, 'remove flags should include $MailFlagBit1');
        assert.ok(removeCall.flags.indexOf('$MailFlagBit2') >= 0, 'remove flags should include $MailFlagBit2');

        assert.ok(result, 'should return truthy result');
    });

    // ---------------------------------------------------------------------------
    // status test
    // ---------------------------------------------------------------------------
    it('status delegates to run with STATUS command', async () => {
        let runArgs = null;
        const ctx = {
            run: async (...args: any[]) => {
                runArgs = args;
                return { messages: 10, unseen: 3 };
            }
        };

        let result = await ImapFlow.prototype.status.call(ctx, 'INBOX', { unseen: true });

        assert.deepEqual(runArgs, ['STATUS', 'INBOX', { unseen: true }], 'run should be called with correct arguments');
        assert.deepEqual(result, { messages: 10, unseen: 3 }, 'should return the result from run');
    });

    // ---------------------------------------------------------------------------
    // getQuota tests
    // ---------------------------------------------------------------------------
    it('getQuota delegates to run with QUOTA command', async () => {
        let runArgs = null;
        const ctx = {
            run: async (...args: any[]) => {
                runArgs = args;
                return { storage: { usage: 1024, limit: 10240 } };
            }
        };

        let result: any = await ImapFlow.prototype.getQuota.call(ctx, 'Sent');

        assert.deepEqual(runArgs, ['QUOTA', 'Sent'], 'run should be called with correct arguments');
        assert.ok(result.storage, 'should return quota result');
    });
    it('getQuota defaults path to INBOX', async () => {
        let runArgs = null;
        const ctx = {
            run: async (...args: any[]) => {
                runArgs = args;
                return { storage: { usage: 512, limit: 10240 } };
            }
        };

        let result: any = await ImapFlow.prototype.getQuota.call(ctx);

        assert.deepEqual(runArgs, ['QUOTA', 'INBOX'], 'run should be called with INBOX as default path');
        assert.ok(result.storage, 'should return quota result');
    });

    // ---------------------------------------------------------------------------
    // fetch generator: error propagation tests
    // ---------------------------------------------------------------------------
    it('fetch generator: run error propagates to consumer', async () => {
        const run = async () => {
            throw new Error('FETCH failed');
        };
        const ctx = createFetchContext(run);
        let caught = false;
        try {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (let msg of (callFetch as any)(ctx, '1:5', { uid: true })) {
                // should not reach here
            }
        } catch (err: any) {
            caught = true;
            assert.equal(err.message, 'FETCH failed');
        }
        assert.ok(caught, 'error was caught');
    });
    it('fetch generator: socket destroyed mid-iteration throws EConnectionClosed', async () => {
        const run = async (cmd: any, range: any, query: any, opts: any) => {
            for (let i = 0; i < 3; i++) {
                await new Promise<void>(resolve => {
                    opts.onUntaggedFetch({ seq: i + 1, uid: 400 + i }, () => resolve());
                });
            }
        };
        const ctx = createFetchContext(run);
        let caught = false;
        try {
            for await (let msg of (callFetch as any)(ctx, '1:3', { uid: true })) {
                if (msg.seq === 1) {
                    ctx.socket.destroyed = true;
                }
            }
        } catch (err: any) {
            caught = true;
            assert.equal(err.code, 'EConnectionClosed');
        }
        assert.ok(caught, 'error was caught');
    });
});
