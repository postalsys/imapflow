'use strict';

const { ImapFlow } = require('../lib/imap-flow');

module.exports['Create imapflow instance'] = test => {
    let imapFlow = new ImapFlow();
    test.ok(imapFlow);
    test.done();
};

module.exports['Create imapflow instance with custom logger'] = async test => {
    class CustomLogger {
        constructor() {}

        debug(obj) {
            console.log(JSON.stringify(obj));
        }

        info(obj) {
            console.log(JSON.stringify(obj));
        }

        warn(obj) {
            console.log(JSON.stringify(obj));
        }

        // eslint-disable-next-line no-unused-vars
        error(obj) {
            // we don't actually want to log anything here.
        }
    }

    let imapFlow = new ImapFlow({
        logger: new CustomLogger()
    });
    test.ok(imapFlow);
    try {
        await imapFlow.connect();
    } catch (ex) {
        // it is PERFECTLY okay to have an exception here. We expect an ECONNREFUSED if an exception occurs.
        test.equal(ex.code, 'ECONNREFUSED');
    }
    test.done();
};

// ---------------------------------------------------------------------------
// Helpers for testing prototype methods on a mock context
// ---------------------------------------------------------------------------
const createFetchContext = runOverride => ({
    mailbox: { path: 'INBOX', exists: 10 },
    isClosed: false,
    socket: { destroyed: false },
    resolveRange: async range => range,
    run: runOverride
});

function callFetch(ctx, range, query, options) {
    return ImapFlow.prototype.fetch.call(ctx, range, query, options);
}

// ---------------------------------------------------------------------------
// setFlagColor tests
// ---------------------------------------------------------------------------

module.exports['setFlagColor with valid color calls STORE for add and remove'] = async test => {
    let storeCalls = [];
    const ctx = {
        resolveRange: async range => range,
        run: async (command, range, flags, opts) => {
            storeCalls.push({ command, range, flags, operation: opts.operation });
            return true;
        }
    };

    let result = await ImapFlow.prototype.setFlagColor.call(ctx, '1:*', 'orange');

    test.equal(storeCalls.length, 2, 'run should be called twice');

    test.equal(storeCalls[0].command, 'STORE');
    test.equal(storeCalls[0].operation, 'add');
    test.ok(storeCalls[0].flags.indexOf('\\Flagged') >= 0, 'add flags should include \\Flagged');
    test.ok(storeCalls[0].flags.indexOf('$MailFlagBit0') >= 0, 'add flags should include $MailFlagBit0');

    test.equal(storeCalls[1].command, 'STORE');
    test.equal(storeCalls[1].operation, 'remove');
    test.ok(storeCalls[1].flags.indexOf('$MailFlagBit1') >= 0, 'remove flags should include $MailFlagBit1');
    test.ok(storeCalls[1].flags.indexOf('$MailFlagBit2') >= 0, 'remove flags should include $MailFlagBit2');

    test.ok(result, 'should return truthy result');
    test.done();
};

module.exports['setFlagColor with invalid color returns false'] = async test => {
    let runCalled = false;
    const ctx = {
        resolveRange: async range => range,
        run: async () => {
            runCalled = true;
        }
    };

    let result = await ImapFlow.prototype.setFlagColor.call(ctx, '1:*', 'invalid');

    test.strictEqual(result, false, 'should return false for invalid color');
    test.ok(!runCalled, 'run should not be called');
    test.done();
};

module.exports['setFlagColor with empty range returns false'] = async test => {
    let runCalled = false;
    const ctx = {
        resolveRange: async () => null,
        run: async () => {
            runCalled = true;
        }
    };

    let result = await ImapFlow.prototype.setFlagColor.call(ctx, '1:*', 'orange');

    test.strictEqual(result, false, 'should return false for empty range');
    test.ok(!runCalled, 'run should not be called');
    test.done();
};

module.exports['setFlagColor with red calls STORE with Flagged in add'] = async test => {
    let storeCalls = [];
    const ctx = {
        resolveRange: async range => range,
        run: async (command, range, flags, opts) => {
            storeCalls.push({ command, range, flags, operation: opts.operation });
            return true;
        }
    };

    let result = await ImapFlow.prototype.setFlagColor.call(ctx, '1:*', 'red');

    // red is index 0 (all bits zero), so add should contain only \Flagged,
    // and remove should contain all three MailFlagBit flags
    test.ok(storeCalls.length >= 1, 'run should be called at least once');

    let addCall = storeCalls.find(c => c.operation === 'add');
    test.ok(addCall, 'should have an add operation');
    test.ok(addCall.flags.indexOf('\\Flagged') >= 0, 'add flags should include \\Flagged for red');

    let removeCall = storeCalls.find(c => c.operation === 'remove');
    test.ok(removeCall, 'should have a remove operation');
    test.ok(removeCall.flags.indexOf('$MailFlagBit0') >= 0, 'remove flags should include $MailFlagBit0');
    test.ok(removeCall.flags.indexOf('$MailFlagBit1') >= 0, 'remove flags should include $MailFlagBit1');
    test.ok(removeCall.flags.indexOf('$MailFlagBit2') >= 0, 'remove flags should include $MailFlagBit2');

    test.ok(result, 'should return truthy result');
    test.done();
};

// ---------------------------------------------------------------------------
// status test
// ---------------------------------------------------------------------------

module.exports['status delegates to run with STATUS command'] = async test => {
    let runArgs = null;
    const ctx = {
        run: async (...args) => {
            runArgs = args;
            return { messages: 10, unseen: 3 };
        }
    };

    let result = await ImapFlow.prototype.status.call(ctx, 'INBOX', { unseen: true });

    test.deepEqual(runArgs, ['STATUS', 'INBOX', { unseen: true }], 'run should be called with correct arguments');
    test.deepEqual(result, { messages: 10, unseen: 3 }, 'should return the result from run');
    test.done();
};

// ---------------------------------------------------------------------------
// getQuota tests
// ---------------------------------------------------------------------------

module.exports['getQuota delegates to run with QUOTA command'] = async test => {
    let runArgs = null;
    const ctx = {
        run: async (...args) => {
            runArgs = args;
            return { storage: { usage: 1024, limit: 10240 } };
        }
    };

    let result = await ImapFlow.prototype.getQuota.call(ctx, 'Sent');

    test.deepEqual(runArgs, ['QUOTA', 'Sent'], 'run should be called with correct arguments');
    test.ok(result.storage, 'should return quota result');
    test.done();
};

module.exports['getQuota defaults path to INBOX'] = async test => {
    let runArgs = null;
    const ctx = {
        run: async (...args) => {
            runArgs = args;
            return { storage: { usage: 512, limit: 10240 } };
        }
    };

    let result = await ImapFlow.prototype.getQuota.call(ctx);

    test.deepEqual(runArgs, ['QUOTA', 'INBOX'], 'run should be called with INBOX as default path');
    test.ok(result.storage, 'should return quota result');
    test.done();
};

// ---------------------------------------------------------------------------
// fetch generator: error propagation tests
// ---------------------------------------------------------------------------

module.exports['fetch generator: run error propagates to consumer'] = async test => {
    const run = async () => {
        throw new Error('FETCH failed');
    };
    const ctx = createFetchContext(run);
    let caught = false;
    try {
        // eslint-disable-next-line no-unused-vars
        for await (let msg of callFetch(ctx, '1:5', { uid: true })) {
            // should not reach here
        }
    } catch (err) {
        caught = true;
        test.equal(err.message, 'FETCH failed');
    }
    test.ok(caught, 'error was caught');
    test.done();
};

module.exports['fetch generator: socket destroyed mid-iteration throws EConnectionClosed'] = async test => {
    const run = async (cmd, range, query, opts) => {
        for (let i = 0; i < 3; i++) {
            await new Promise(resolve => {
                opts.onUntaggedFetch({ seq: i + 1, uid: 400 + i }, () => resolve());
            });
        }
    };
    const ctx = createFetchContext(run);
    let caught = false;
    try {
        for await (let msg of callFetch(ctx, '1:3', { uid: true })) {
            if (msg.seq === 1) {
                ctx.socket.destroyed = true;
            }
        }
    } catch (err) {
        caught = true;
        test.equal(err.code, 'EConnectionClosed');
    }
    test.ok(caught, 'error was caught');
    test.done();
};
