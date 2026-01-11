'use strict';

/* eslint-disable new-cap */
// BigInt() is a standard JS function but triggers new-cap rule

// ============================================
// Mock Connection Factory
// ============================================

const createMockConnection = (overrides = {}) => {
    const states = {
        NOT_AUTHENTICATED: 1,
        AUTHENTICATED: 2,
        SELECTED: 3,
        LOGOUT: 4
    };

    const defaultMailbox = {
        path: 'INBOX',
        flags: new Set(['\\Seen', '\\Answered', '\\Flagged', '\\Deleted', '\\Draft']),
        permanentFlags: new Set(['\\*']),
        exists: 100,
        recent: 5,
        uidNext: 1000,
        uidValidity: BigInt(12345),
        noModseq: false
    };

    return {
        states,
        state: overrides.state || states.SELECTED,
        id: 'test-connection-id',
        capabilities: new Map(overrides.capabilities || [['IMAP4rev1', true]]),
        enabled: new Set(overrides.enabled || []),
        authCapabilities: new Map(),
        mailbox: overrides.mailbox || { ...defaultMailbox },
        namespace: overrides.namespace || { delimiter: '/', prefix: '' },
        expectCapabilityUpdate: overrides.expectCapabilityUpdate || false,
        log: {
            warn: () => {},
            info: () => {},
            error: () => {},
            debug: () => {},
            trace: () => {}
        },
        close: overrides.close || (() => {}),
        emit: overrides.emit || (() => {}),
        currentSelectCommand: false,
        messageFlagsAdd: overrides.messageFlagsAdd || (async () => {}),
        run: overrides.run || (async () => {}),
        exec:
            overrides.exec ||
            (async () => ({
                next: () => {},
                response: { attributes: [] }
            })),
        ...overrides
    };
};

// ============================================
// CAPABILITY Command Tests
// ============================================

const capabilityCommand = require('../lib/commands/capability');

module.exports['Commands: capability returns cached when available'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map([
            ['IMAP4rev1', true],
            ['IDLE', true]
        ]),
        expectCapabilityUpdate: false
    });

    const result = await capabilityCommand(connection);
    test.ok(result instanceof Map);
    test.equal(result.get('IDLE'), true);
    test.done();
};

module.exports['Commands: capability fetches when empty'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map(),
        exec: async () => ({ next: () => {} })
    });

    const result = await capabilityCommand(connection);
    test.ok(result instanceof Map);
    test.done();
};

module.exports['Commands: capability fetches when update expected'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        capabilities: new Map([['IMAP4rev1', true]]),
        expectCapabilityUpdate: true,
        exec: async () => {
            execCalled = true;
            return { next: () => {} };
        }
    });

    await capabilityCommand(connection);
    test.equal(execCalled, true);
    test.done();
};

module.exports['Commands: capability handles error'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map(),
        exec: async () => {
            throw new Error('Command failed');
        }
    });

    const result = await capabilityCommand(connection);
    test.equal(result, false);
    test.done();
};

// ============================================
// NOOP Command Tests
// ============================================

const noopCommand = require('../lib/commands/noop');

module.exports['Commands: noop success'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        exec: async cmd => {
            test.equal(cmd, 'NOOP');
            execCalled = true;
            return { next: () => {} };
        }
    });

    const result = await noopCommand(connection);
    test.equal(result, true);
    test.equal(execCalled, true);
    test.done();
};

module.exports['Commands: noop handles error'] = async test => {
    const connection = createMockConnection({
        exec: async () => {
            throw new Error('Command failed');
        }
    });

    const result = await noopCommand(connection);
    test.equal(result, false);
    test.done();
};

// ============================================
// LOGIN Command Tests
// ============================================

const loginCommand = require('../lib/commands/login');

module.exports['Commands: login success'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 1, // NOT_AUTHENTICATED
        exec: async (cmd, attrs) => {
            execArgs = { cmd, attrs };
            return { next: () => {} };
        }
    });

    const result = await loginCommand(connection, 'testuser', 'testpass');
    test.equal(result, 'testuser');
    test.equal(execArgs.cmd, 'LOGIN');
    test.equal(execArgs.attrs[0].value, 'testuser');
    test.equal(execArgs.attrs[1].value, 'testpass');
    test.equal(execArgs.attrs[1].sensitive, true);
    test.done();
};

module.exports['Commands: login skips when already authenticated'] = async test => {
    const connection = createMockConnection({
        state: 2 // AUTHENTICATED
    });

    const result = await loginCommand(connection, 'testuser', 'testpass');
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: login handles error'] = async test => {
    const connection = createMockConnection({
        state: 1,
        exec: async () => {
            const err = new Error('Auth failed');
            err.response = { attributes: [] };
            throw err;
        }
    });

    try {
        await loginCommand(connection, 'testuser', 'wrongpass');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.authenticationFailed, true);
    }
    test.done();
};

// ============================================
// LOGOUT Command Tests
// ============================================

const logoutCommand = require('../lib/commands/logout');

module.exports['Commands: logout success'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        exec: async cmd => {
            test.equal(cmd, 'LOGOUT');
            execCalled = true;
            return { next: () => {} };
        }
    });

    const result = await logoutCommand(connection);
    test.equal(result, true);
    test.equal(execCalled, true);
    test.done();
};

module.exports['Commands: logout handles error'] = async test => {
    const connection = createMockConnection({
        exec: async () => {
            throw new Error('Command failed');
        }
    });

    const result = await logoutCommand(connection);
    test.equal(result, false);
    test.done();
};

// ============================================
// CLOSE Command Tests
// ============================================

const closeCommand = require('../lib/commands/close');

module.exports['Commands: close success'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        state: 3, // SELECTED
        exec: async cmd => {
            test.equal(cmd, 'CLOSE');
            execCalled = true;
            return { next: () => {} };
        }
    });

    const result = await closeCommand(connection);
    test.equal(result, true);
    test.equal(execCalled, true);
    test.done();
};

module.exports['Commands: close skips when not selected'] = async test => {
    const connection = createMockConnection({
        state: 2 // AUTHENTICATED, not SELECTED
    });

    const result = await closeCommand(connection);
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: close handles error'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async () => {
            throw new Error('Command failed');
        }
    });

    const result = await closeCommand(connection);
    test.equal(result, false);
    test.done();
};

// ============================================
// SEARCH Command Tests
// ============================================

const searchCommand = require('../lib/commands/search');

module.exports['Commands: search with ALL'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            execArgs = { cmd, attrs };
            // Simulate SEARCH response
            if (opts && opts.untagged && opts.untagged.SEARCH) {
                await opts.untagged.SEARCH({
                    attributes: [{ value: '1' }, { value: '2' }, { value: '3' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await searchCommand(connection, true, {});
    test.deepEqual(result, [1, 2, 3]);
    test.equal(execArgs.cmd, 'SEARCH');
    test.done();
};

module.exports['Commands: search with UID option'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            execCmd = cmd;
            if (opts && opts.untagged && opts.untagged.SEARCH) {
                await opts.untagged.SEARCH({ attributes: [{ value: '100' }] });
            }
            return { next: () => {} };
        }
    });

    const result = await searchCommand(connection, { all: true }, { uid: true });
    test.deepEqual(result, [100]);
    test.equal(execCmd, 'UID SEARCH');
    test.done();
};

module.exports['Commands: search with query object'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            // Check that search compiler was used
            test.ok(attrs.some(a => a.value === 'FROM'));
            if (opts && opts.untagged && opts.untagged.SEARCH) {
                await opts.untagged.SEARCH({ attributes: [] });
            }
            return { next: () => {} };
        }
    });

    const result = await searchCommand(connection, { from: 'test@example.com' }, {});
    test.ok(Array.isArray(result));
    test.done();
};

module.exports['Commands: search skips when not selected'] = async test => {
    const connection = createMockConnection({
        state: 2 // AUTHENTICATED
    });

    const result = await searchCommand(connection, { all: true }, {});
    test.equal(result, false);
    test.done();
};

module.exports['Commands: search handles error'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async () => {
            const err = new Error('Search failed');
            err.response = { attributes: [] };
            throw err;
        }
    });

    const result = await searchCommand(connection, { all: true }, {});
    test.equal(result, false);
    test.done();
};

module.exports['Commands: search returns false for invalid query'] = async test => {
    const connection = createMockConnection({ state: 3 });

    const result = await searchCommand(connection, 'invalid-query', {});
    test.equal(result, false);
    test.done();
};

// ============================================
// STORE Command Tests
// ============================================

const storeCommand = require('../lib/commands/store');

module.exports['Commands: store add flags'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            execArgs = { cmd, attrs };
            return { next: () => {} };
        }
    });

    const result = await storeCommand(connection, '1:10', ['\\Seen'], { operation: 'add' });
    test.equal(result, true);
    test.equal(execArgs.cmd, 'STORE');
    test.ok(execArgs.attrs[1].value.startsWith('+'));
    test.done();
};

module.exports['Commands: store remove flags'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            execArgs = { cmd, attrs };
            return { next: () => {} };
        }
    });

    const result = await storeCommand(connection, '1:10', ['\\Seen'], { operation: 'remove' });
    test.equal(result, true);
    test.ok(execArgs.attrs[1].value.startsWith('-'));
    test.done();
};

module.exports['Commands: store set flags'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            execArgs = { cmd, attrs };
            return { next: () => {} };
        }
    });

    const result = await storeCommand(connection, '1:10', ['\\Seen'], { operation: 'set' });
    test.equal(result, true);
    test.ok(!execArgs.attrs[1].value.startsWith('+'));
    test.ok(!execArgs.attrs[1].value.startsWith('-'));
    test.done();
};

module.exports['Commands: store with UID'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3,
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {} };
        }
    });

    await storeCommand(connection, '100', ['\\Flagged'], { uid: true });
    test.equal(execCmd, 'UID STORE');
    test.done();
};

module.exports['Commands: store with silent'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            execArgs = { cmd, attrs };
            return { next: () => {} };
        }
    });

    await storeCommand(connection, '1', ['\\Seen'], { silent: true });
    test.ok(execArgs.attrs[1].value.includes('.SILENT'));
    test.done();
};

module.exports['Commands: store with Gmail labels'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['X-GM-EXT-1', true]]),
        exec: async (cmd, attrs) => {
            execArgs = { cmd, attrs };
            return { next: () => {} };
        }
    });

    await storeCommand(connection, '1', ['Important'], { useLabels: true });
    test.ok(execArgs.attrs[1].value.includes('X-GM-LABELS'));
    test.done();
};

module.exports['Commands: store skips when labels not supported'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map() // No X-GM-EXT-1
    });

    const result = await storeCommand(connection, '1', ['Label'], { useLabels: true });
    test.equal(result, false);
    test.done();
};

module.exports['Commands: store skips when not selected'] = async test => {
    const connection = createMockConnection({ state: 2 });

    const result = await storeCommand(connection, '1:10', ['\\Seen'], {});
    test.equal(result, false);
    test.done();
};

module.exports['Commands: store skips when no range'] = async test => {
    const connection = createMockConnection({ state: 3 });

    const result = await storeCommand(connection, null, ['\\Seen'], {});
    test.equal(result, false);
    test.done();
};

module.exports['Commands: store with CONDSTORE'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 3,
        enabled: new Set(['CONDSTORE']),
        exec: async (cmd, attrs) => {
            execArgs = { cmd, attrs };
            return { next: () => {} };
        }
    });

    await storeCommand(connection, '1', ['\\Seen'], { unchangedSince: 12345 });
    test.ok(execArgs.attrs.some(a => Array.isArray(a) && a.some(x => x.value === 'UNCHANGEDSINCE')));
    test.done();
};

module.exports['Commands: store handles error'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async () => {
            const err = new Error('Store failed');
            err.response = { attributes: [] };
            throw err;
        }
    });

    const result = await storeCommand(connection, '1', ['\\Seen'], {});
    test.equal(result, false);
    test.done();
};

// ============================================
// COPY Command Tests
// ============================================

const copyCommand = require('../lib/commands/copy');

module.exports['Commands: copy success'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            execArgs = { cmd, attrs };
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    const result = await copyCommand(connection, '1:10', 'Archive', {});
    test.ok(result);
    test.equal(result.destination, 'Archive');
    test.equal(execArgs.cmd, 'COPY');
    test.done();
};

module.exports['Commands: copy with UID'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3,
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    await copyCommand(connection, '100', 'Archive', { uid: true });
    test.equal(execCmd, 'UID COPY');
    test.done();
};

module.exports['Commands: copy with COPYUID response'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        section: [{ value: 'COPYUID' }, { value: '12345' }, { value: '1:3' }, { value: '100:102' }]
                    }
                ]
            }
        })
    });

    const result = await copyCommand(connection, '1:3', 'Archive', {});
    test.ok(result.uidValidity);
    test.ok(result.uidMap instanceof Map);
    test.equal(result.uidMap.get(1), 100);
    test.equal(result.uidMap.get(2), 101);
    test.equal(result.uidMap.get(3), 102);
    test.done();
};

module.exports['Commands: copy skips when not selected'] = async test => {
    const connection = createMockConnection({ state: 2 });

    const result = await copyCommand(connection, '1:10', 'Archive', {});
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: copy skips when no range'] = async test => {
    const connection = createMockConnection({ state: 3 });

    const result = await copyCommand(connection, null, 'Archive', {});
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: copy skips when no destination'] = async test => {
    const connection = createMockConnection({ state: 3 });

    const result = await copyCommand(connection, '1:10', null, {});
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: copy handles error'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async () => {
            const err = new Error('Copy failed');
            err.response = { attributes: [] };
            throw err;
        }
    });

    const result = await copyCommand(connection, '1:10', 'Archive', {});
    test.equal(result, false);
    test.done();
};

// ============================================
// MOVE Command Tests
// ============================================

const moveCommand = require('../lib/commands/move');

module.exports['Commands: move with MOVE capability'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]]),
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    await moveCommand(connection, '1:10', 'Archive', {});
    test.equal(execCmd, 'MOVE');
    test.done();
};

module.exports['Commands: move with UID and MOVE capability'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]]),
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    await moveCommand(connection, '100', 'Archive', { uid: true });
    test.equal(execCmd, 'UID MOVE');
    test.done();
};

module.exports['Commands: move skips when not selected'] = async test => {
    const connection = createMockConnection({ state: 2 });

    const result = await moveCommand(connection, '1:10', 'Archive', {});
    test.equal(result, undefined);
    test.done();
};

// ============================================
// EXPUNGE Command Tests
// ============================================

const expungeCommand = require('../lib/commands/expunge');

module.exports['Commands: expunge success'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        state: 3,
        exec: async cmd => {
            test.equal(cmd, 'EXPUNGE');
            execCalled = true;
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    const result = await expungeCommand(connection, '1:*', {});
    test.equal(result, true);
    test.equal(execCalled, true);
    test.done();
};

module.exports['Commands: expunge with UID range'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['UIDPLUS', true]]),
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    await expungeCommand(connection, '1:100', { uid: true });
    test.equal(execCmd, 'UID EXPUNGE');
    test.done();
};

module.exports['Commands: expunge skips when not selected'] = async test => {
    const connection = createMockConnection({ state: 2 });

    const result = await expungeCommand(connection, '1:*', {});
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: expunge skips when no range'] = async test => {
    const connection = createMockConnection({ state: 3 });

    const result = await expungeCommand(connection, null, {});
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: expunge handles error'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async () => {
            const err = new Error('Expunge failed');
            err.response = { attributes: [] };
            throw err;
        }
    });

    const result = await expungeCommand(connection, '1:*', {});
    test.equal(result, false);
    test.done();
};

// ============================================
// CREATE Command Tests
// ============================================

const createCommand = require('../lib/commands/create');

module.exports['Commands: create success'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs) => {
            execArgs = { cmd, attrs };
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    const result = await createCommand(connection, 'NewFolder');
    test.ok(result);
    test.equal(result.created, true);
    test.equal(execArgs.cmd, 'CREATE');
    test.done();
};

module.exports['Commands: create skips when not authenticated'] = async test => {
    const connection = createMockConnection({ state: 1 });

    const result = await createCommand(connection, 'NewFolder');
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: create handles ALREADYEXISTS'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Mailbox already exists');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'ALREADYEXISTS' }]
                    },
                    { type: 'TEXT', value: 'Mailbox already exists' }
                ]
            };
            throw err;
        }
    });

    const result = await createCommand(connection, 'ExistingFolder');
    test.ok(result);
    test.equal(result.created, false);
    test.done();
};

module.exports['Commands: create throws on other errors'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Create failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [{ type: 'TEXT', value: 'Create failed' }]
            };
            throw err;
        }
    });

    try {
        await createCommand(connection, 'NewFolder');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.ok(err.message.includes('Create failed'));
    }
    test.done();
};

// ============================================
// DELETE Command Tests
// ============================================

const deleteCommand = require('../lib/commands/delete');

module.exports['Commands: delete success'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 2,
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {} };
        }
    });

    const result = await deleteCommand(connection, 'OldFolder');
    test.ok(result);
    test.equal(result.path, 'OldFolder');
    test.equal(execCmd, 'DELETE');
    test.done();
};

module.exports['Commands: delete skips when not authenticated'] = async test => {
    const connection = createMockConnection({ state: 1 });

    const result = await deleteCommand(connection, 'OldFolder');
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: delete throws on error'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Delete failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [{ type: 'TEXT', value: 'Delete failed' }]
            };
            throw err;
        }
    });

    try {
        await deleteCommand(connection, 'OldFolder');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.ok(err.message.includes('Delete failed'));
    }
    test.done();
};

// ============================================
// RENAME Command Tests
// ============================================

const renameCommand = require('../lib/commands/rename');

module.exports['Commands: rename success'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs) => {
            execArgs = { cmd, attrs };
            return { next: () => {} };
        }
    });

    const result = await renameCommand(connection, 'OldName', 'NewName');
    test.ok(result);
    test.equal(result.path, 'OldName');
    test.equal(result.newPath, 'NewName');
    test.equal(execArgs.cmd, 'RENAME');
    test.done();
};

module.exports['Commands: rename skips when not authenticated'] = async test => {
    const connection = createMockConnection({ state: 1 });

    const result = await renameCommand(connection, 'OldName', 'NewName');
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: rename throws on error'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Rename failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [{ type: 'TEXT', value: 'Rename failed' }]
            };
            throw err;
        }
    });

    try {
        await renameCommand(connection, 'OldName', 'NewName');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.ok(err.message.includes('Rename failed'));
    }
    test.done();
};

// ============================================
// SUBSCRIBE/UNSUBSCRIBE Command Tests
// ============================================

const subscribeCommand = require('../lib/commands/subscribe');
const unsubscribeCommand = require('../lib/commands/unsubscribe');

module.exports['Commands: subscribe success'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 2,
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {} };
        }
    });

    const result = await subscribeCommand(connection, 'Folder');
    test.equal(result, true);
    test.equal(execCmd, 'SUBSCRIBE');
    test.done();
};

module.exports['Commands: subscribe skips when not authenticated'] = async test => {
    const connection = createMockConnection({ state: 1 });

    const result = await subscribeCommand(connection, 'Folder');
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: unsubscribe success'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 2,
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {} };
        }
    });

    const result = await unsubscribeCommand(connection, 'Folder');
    test.equal(result, true);
    test.equal(execCmd, 'UNSUBSCRIBE');
    test.done();
};

module.exports['Commands: unsubscribe skips when not authenticated'] = async test => {
    const connection = createMockConnection({ state: 1 });

    const result = await unsubscribeCommand(connection, 'Folder');
    test.equal(result, undefined);
    test.done();
};

// ============================================
// ENABLE Command Tests
// ============================================

const enableCommand = require('../lib/commands/enable');

module.exports['Commands: enable success'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['ENABLE', true],
            ['CONDSTORE', true]
        ]),
        exec: async () => ({ next: () => {} })
    });

    const result = await enableCommand(connection, ['CONDSTORE']);
    // Returns Set of enabled extensions
    test.ok(result instanceof Set);
    test.done();
};

module.exports['Commands: enable skips when not authenticated'] = async test => {
    const connection = createMockConnection({ state: 1 });

    const result = await enableCommand(connection, ['CONDSTORE']);
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: enable skips when ENABLE not supported'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map() // No ENABLE capability
    });

    const result = await enableCommand(connection, ['CONDSTORE']);
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: enable handles error'] = async test => {
    const connection = createMockConnection({
        state: 2,
        // Need to include CONDSTORE so the filter doesn't skip it
        capabilities: new Map([
            ['ENABLE', true],
            ['CONDSTORE', true]
        ]),
        exec: async () => {
            throw new Error('Enable failed');
        }
    });

    const result = await enableCommand(connection, ['CONDSTORE']);
    test.equal(result, false);
    test.done();
};

// ============================================
// COMPRESS Command Tests
// ============================================

const compressCommand = require('../lib/commands/compress');

module.exports['Commands: compress success'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        capabilities: new Map([['COMPRESS=DEFLATE', true]]),
        exec: async () => {
            execCalled = true;
            return { next: () => {} };
        }
    });

    const result = await compressCommand(connection);
    test.equal(result, true);
    test.equal(execCalled, true);
    test.done();
};

module.exports['Commands: compress skips when not supported'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map() // No COMPRESS=DEFLATE
    });

    const result = await compressCommand(connection);
    // Returns false when not supported (not undefined)
    test.equal(result, false);
    test.done();
};

module.exports['Commands: compress handles error'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map([['COMPRESS=DEFLATE', true]]),
        exec: async () => {
            throw new Error('Compress failed');
        }
    });

    const result = await compressCommand(connection);
    test.equal(result, false);
    test.done();
};

// ============================================
// STARTTLS Command Tests
// ============================================

const starttlsCommand = require('../lib/commands/starttls');

module.exports['Commands: starttls success'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        capabilities: new Map([['STARTTLS', true]]),
        exec: async () => {
            execCalled = true;
            return { next: () => {} };
        }
    });

    const result = await starttlsCommand(connection);
    test.equal(result, true);
    test.equal(execCalled, true);
    test.done();
};

module.exports['Commands: starttls skips when not supported'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map() // No STARTTLS
    });

    const result = await starttlsCommand(connection);
    // Returns false when not supported (not undefined)
    test.equal(result, false);
    test.done();
};

module.exports['Commands: starttls handles error'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map([['STARTTLS', true]]),
        exec: async () => {
            throw new Error('STARTTLS failed');
        }
    });

    const result = await starttlsCommand(connection);
    test.equal(result, false);
    test.done();
};

// ============================================
// FETCH Command Tests
// ============================================

const fetchCommand = require('../lib/commands/fetch');

module.exports['Commands: fetch basic query'] = async test => {
    let execCalled = false;
    let execCommand = '';
    const connection = createMockConnection({
        state: 3, // SELECTED
        exec: async (cmd, attrs, opts) => {
            execCalled = true;
            execCommand = cmd;
            // Simulate a FETCH response
            if (opts && opts.untagged && opts.untagged.FETCH) {
                await opts.untagged.FETCH({
                    command: '1',
                    attributes: [
                        { value: '1' },
                        [{ type: 'ATOM', value: 'UID' }, { type: 'ATOM', value: '100' }, { type: 'ATOM', value: 'FLAGS' }, [{ value: '\\Seen' }]]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await fetchCommand(connection, '1:*', { uid: true, flags: true });
    test.equal(execCalled, true);
    test.equal(execCommand, 'FETCH');
    test.ok(result);
    test.equal(result.count, 1);
    test.ok(Array.isArray(result.list));
    test.done();
};

module.exports['Commands: fetch with UID option'] = async test => {
    let execCommand = '';
    const connection = createMockConnection({
        state: 3,
        exec: async cmd => {
            execCommand = cmd;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1:*', { uid: true }, { uid: true });
    test.equal(execCommand, 'UID FETCH');
    test.done();
};

module.exports['Commands: fetch skips when not selected'] = async test => {
    const connection = createMockConnection({ state: 2 }); // AUTHENTICATED, not SELECTED

    const result = await fetchCommand(connection, '1:*', { uid: true });
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: fetch skips when no range'] = async test => {
    const connection = createMockConnection({ state: 3 });

    const result = await fetchCommand(connection, null, { uid: true });
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: fetch with envelope query'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { envelope: true });
    test.ok(queryAttrs);
    // Check that ENVELOPE is in the query
    const hasEnvelope = JSON.stringify(queryAttrs).includes('ENVELOPE');
    test.ok(hasEnvelope);
    test.done();
};

module.exports['Commands: fetch with bodyStructure query'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { bodyStructure: true });
    test.ok(queryAttrs);
    const hasBODYSTRUCTURE = JSON.stringify(queryAttrs).includes('BODYSTRUCTURE');
    test.ok(hasBODYSTRUCTURE);
    test.done();
};

module.exports['Commands: fetch with size query'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { size: true });
    test.ok(queryAttrs);
    const hasRFC822SIZE = JSON.stringify(queryAttrs).includes('RFC822.SIZE');
    test.ok(hasRFC822SIZE);
    test.done();
};

module.exports['Commands: fetch with source query'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { source: true });
    test.ok(queryAttrs);
    const hasBODYPEEK = JSON.stringify(queryAttrs).includes('BODY.PEEK');
    test.ok(hasBODYPEEK);
    test.done();
};

module.exports['Commands: fetch with source partial'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { source: { start: 0, maxLength: 1024 } });
    test.ok(queryAttrs);
    // Partial should be set
    const queryStr = JSON.stringify(queryAttrs);
    test.ok(queryStr.includes('BODY.PEEK'));
    test.done();
};

module.exports['Commands: fetch with BINARY capability'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['BINARY', true]]),
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { source: true }, { binary: true });
    test.ok(queryAttrs);
    const hasBINARYPEEK = JSON.stringify(queryAttrs).includes('BINARY.PEEK');
    test.ok(hasBINARYPEEK);
    test.done();
};

module.exports['Commands: fetch with OBJECTID capability'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['OBJECTID', true]]),
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { flags: true });
    test.ok(queryAttrs);
    const hasEMAILID = JSON.stringify(queryAttrs).includes('EMAILID');
    test.ok(hasEMAILID);
    test.done();
};

module.exports['Commands: fetch with X-GM-EXT-1 capability'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['X-GM-EXT-1', true]]),
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { flags: true });
    test.ok(queryAttrs);
    const hasXGMMSGID = JSON.stringify(queryAttrs).includes('X-GM-MSGID');
    test.ok(hasXGMMSGID);
    test.done();
};

module.exports['Commands: fetch with threadId query'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['OBJECTID', true]]),
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { threadId: true });
    test.ok(queryAttrs);
    const hasTHREADID = JSON.stringify(queryAttrs).includes('THREADID');
    test.ok(hasTHREADID);
    test.done();
};

module.exports['Commands: fetch with labels query'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['X-GM-EXT-1', true]]),
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { labels: true });
    test.ok(queryAttrs);
    const hasXGMLABELS = JSON.stringify(queryAttrs).includes('X-GM-LABELS');
    test.ok(hasXGMLABELS);
    test.done();
};

module.exports['Commands: fetch with CONDSTORE enabled'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        enabled: new Set(['CONDSTORE']),
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { flags: true });
    test.ok(queryAttrs);
    const hasMODSEQ = JSON.stringify(queryAttrs).includes('MODSEQ');
    test.ok(hasMODSEQ);
    test.done();
};

module.exports['Commands: fetch with headers array'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { headers: ['Subject', 'From', 'To'] });
    test.ok(queryAttrs);
    const queryStr = JSON.stringify(queryAttrs);
    test.ok(queryStr.includes('HEADER.FIELDS'));
    test.done();
};

module.exports['Commands: fetch with headers true'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { headers: true });
    test.ok(queryAttrs);
    const queryStr = JSON.stringify(queryAttrs);
    test.ok(queryStr.includes('HEADER'));
    test.done();
};

module.exports['Commands: fetch with bodyParts'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { bodyParts: ['1', '2'] });
    test.ok(queryAttrs);
    const queryStr = JSON.stringify(queryAttrs);
    test.ok(queryStr.includes('BODY.PEEK'));
    test.done();
};

module.exports['Commands: fetch with bodyParts object'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { bodyParts: [{ key: '1', start: 0, maxLength: 100 }] });
    test.ok(queryAttrs);
    const queryStr = JSON.stringify(queryAttrs);
    test.ok(queryStr.includes('BODY.PEEK'));
    test.done();
};

module.exports['Commands: fetch with bodyParts skips invalid'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    // Invalid entries: null, object without key, number
    await fetchCommand(connection, '1', { bodyParts: [null, { noKey: true }, 123, '1'] });
    test.ok(queryAttrs);
    // Should still work - just skips invalid entries
    test.done();
};

module.exports['Commands: fetch with changedSince'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        enabled: new Set(['CONDSTORE']),
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { flags: true }, { changedSince: '12345' });
    test.ok(queryAttrs);
    const queryStr = JSON.stringify(queryAttrs);
    test.ok(queryStr.includes('CHANGEDSINCE'));
    test.done();
};

module.exports['Commands: fetch with changedSince and QRESYNC'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        enabled: new Set(['CONDSTORE', 'QRESYNC']),
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { flags: true }, { changedSince: '12345', uid: true });
    test.ok(queryAttrs);
    const queryStr = JSON.stringify(queryAttrs);
    test.ok(queryStr.includes('VANISHED'));
    test.done();
};

module.exports['Commands: fetch with onUntaggedFetch callback'] = async test => {
    let callbackCalled = false;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.FETCH) {
                await opts.untagged.FETCH({
                    command: '1',
                    attributes: [
                        { value: '1' },
                        [
                            { type: 'ATOM', value: 'UID' },
                            { type: 'ATOM', value: '100' }
                        ]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    await fetchCommand(
        connection,
        '1',
        { uid: true },
        {
            onUntaggedFetch: (msg, done) => {
                callbackCalled = true;
                done();
            }
        }
    );
    test.equal(callbackCalled, true);
    test.done();
};

module.exports['Commands: fetch callback error propagates'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.FETCH) {
                await opts.untagged.FETCH({
                    command: '1',
                    attributes: [
                        { value: '1' },
                        [
                            { type: 'ATOM', value: 'UID' },
                            { type: 'ATOM', value: '100' }
                        ]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    try {
        await fetchCommand(
            connection,
            '1',
            { uid: true },
            {
                onUntaggedFetch: (msg, done) => {
                    done(new Error('Callback error'));
                }
            }
        );
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.message, 'Callback error');
    }
    test.done();
};

module.exports['Commands: fetch handles error'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async () => {
            throw new Error('Fetch failed');
        }
    });

    try {
        await fetchCommand(connection, '1', { uid: true });
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.message, 'Fetch failed');
    }
    test.done();
};

module.exports['Commands: fetch retries on throttle error'] = async test => {
    let attempts = 0;
    const connection = createMockConnection({
        state: 3,
        exec: async () => {
            attempts++;
            if (attempts < 3) {
                const err = new Error('Throttled');
                err.code = 'ETHROTTLE';
                err.throttleReset = 10; // 10ms for testing
                throw err;
            }
            return { next: () => {} };
        }
    });

    const result = await fetchCommand(connection, '1', { uid: true });
    test.ok(result);
    test.equal(attempts, 3);
    test.done();
};

module.exports['Commands: fetch with all/fast/full query'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { all: true, fast: true, full: true, internalDate: true });
    test.ok(queryAttrs);
    const queryStr = JSON.stringify(queryAttrs);
    test.ok(queryStr.includes('ALL'));
    test.ok(queryStr.includes('FAST'));
    test.ok(queryStr.includes('FULL'));
    test.ok(queryStr.includes('INTERNALDATE'));
    test.done();
};

// ============================================
// LIST Command Tests
// ============================================

const listCommand = require('../lib/commands/list');

module.exports['Commands: list basic'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            execCalled = true;
            // Simulate LIST response
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    test.equal(execCalled, true);
    test.ok(Array.isArray(result));
    test.done();
};

module.exports['Commands: list with XLIST capability'] = async test => {
    let usedListCommand = '';
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['XLIST', true]]),
        exec: async (cmd, attrs, opts) => {
            // Capture the first LIST/XLIST command, not LSUB
            if ((cmd === 'LIST' || cmd === 'XLIST') && !usedListCommand) {
                usedListCommand = cmd;
            }
            if (opts && opts.untagged && opts.untagged[cmd]) {
                await opts.untagged[cmd]({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
            }
            return { next: () => {} };
        }
    });

    await listCommand(connection, '', '*');
    test.equal(usedListCommand, 'XLIST');
    test.done();
};

module.exports['Commands: list prefers LIST over XLIST when SPECIAL-USE available'] = async test => {
    let usedListCommand = '';
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([
            ['XLIST', true],
            ['SPECIAL-USE', true]
        ]),
        exec: async (cmd, attrs, opts) => {
            // Capture the first LIST/XLIST command, not LSUB
            if ((cmd === 'LIST' || cmd === 'XLIST') && !usedListCommand) {
                usedListCommand = cmd;
            }
            if (opts && opts.untagged && opts.untagged[cmd]) {
                await opts.untagged[cmd]({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
            }
            return { next: () => {} };
        }
    });

    await listCommand(connection, '', '*');
    test.equal(usedListCommand, 'LIST');
    test.done();
};

module.exports['Commands: list with statusQuery'] = async test => {
    let listAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([
            ['LIST-STATUS', true],
            ['SPECIAL-USE', true]
        ]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST') {
                listAttrs = attrs;
                if (opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '10' }, { value: 'UNSEEN' }, { value: '5' }]]
                    });
                }
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*', {
        statusQuery: { messages: true, unseen: true }
    });
    test.ok(listAttrs);
    const attrsStr = JSON.stringify(listAttrs);
    test.ok(attrsStr.includes('RETURN'));
    test.ok(attrsStr.includes('STATUS'));
    test.ok(Array.isArray(result));
    test.done();
};

module.exports['Commands: list with CONDSTORE status query'] = async test => {
    let listAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([
            ['LIST-STATUS', true],
            ['CONDSTORE', true]
        ]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST') {
                listAttrs = attrs;
                if (opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
            }
            return { next: () => {} };
        }
    });

    await listCommand(connection, '', '*', {
        statusQuery: { highestModseq: true }
    });
    test.ok(listAttrs);
    const attrsStr = JSON.stringify(listAttrs);
    test.ok(attrsStr.includes('HIGHESTMODSEQ'));
    test.done();
};

module.exports['Commands: list with listOnly option'] = async test => {
    let lsubCalled = false;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LSUB') {
                lsubCalled = true;
            }
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*', { listOnly: true });
    test.equal(lsubCalled, false);
    test.ok(Array.isArray(result));
    test.done();
};

module.exports['Commands: list with specialUseHints'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Sent Items' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*', {
        specialUseHints: { sent: 'Sent Items' }
    });
    test.ok(Array.isArray(result));
    // The Sent Items folder should have specialUse set
    const sentFolder = result.find(e => e.path === 'Sent Items');
    test.ok(sentFolder);
    test.equal(sentFolder.specialUse, '\\Sent');
    test.done();
};

module.exports['Commands: list handles INBOX specially'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            if ((cmd === 'LIST' || cmd === 'LSUB') && opts && opts.untagged) {
                const handler = opts.untagged[cmd];
                if (handler) {
                    await handler({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    const inbox = result.find(e => e.path === 'INBOX');
    test.ok(inbox);
    test.equal(inbox.specialUse, '\\Inbox');
    // INBOX should always be subscribed
    test.equal(inbox.subscribed, true);
    test.done();
};

module.exports['Commands: list runs separate INBOX query when using namespace'] = async test => {
    let listCalls = 0;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST') {
                listCalls++;
                if (opts && opts.untagged && opts.untagged.LIST) {
                    // First call is for the namespace, second for INBOX
                    if (listCalls === 1) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX/Subfolder' }]
                        });
                    } else {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                }
            }
            return { next: () => {} };
        }
    });

    await listCommand(connection, 'INBOX/', '*');
    // Should have called LIST twice - once for namespace, once for INBOX
    test.equal(listCalls, 2);
    test.done();
};

module.exports['Commands: list handles LSUB merging'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                });
            }
            if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                await opts.untagged.LSUB({
                    attributes: [[{ value: '\\Subscribed' }], { value: '/' }, { value: 'Folder1' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    const folder = result.find(e => e.path === 'Folder1');
    test.ok(folder);
    test.equal(folder.subscribed, true);
    test.equal(folder.listed, true);
    test.done();
};

module.exports['Commands: list handles error'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async () => {
            throw new Error('List failed');
        }
    });

    try {
        await listCommand(connection, '', '*');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.message, 'List failed');
    }
    test.done();
};

module.exports['Commands: list handles empty attributes'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                // Empty attributes - should be skipped
                await opts.untagged.LIST({ attributes: [] });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    test.ok(Array.isArray(result));
    test.equal(result.length, 0);
    test.done();
};

module.exports['Commands: list status fallback when LIST-STATUS not supported'] = async test => {
    let statusCalls = 0;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map(), // No LIST-STATUS
        // eslint-disable-next-line no-unused-vars
        run: async (cmd, path, query) => {
            if (cmd === 'STATUS') {
                statusCalls++;
                return { messages: 10, unseen: 5, path };
            }
        },
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*', {
        statusQuery: { messages: true, unseen: true }
    });
    test.ok(Array.isArray(result));
    // STATUS should have been called for each folder
    test.equal(statusCalls, 1);
    test.done();
};

module.exports['Commands: list handles STATUS errors gracefully'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map(),
        run: async cmd => {
            if (cmd === 'STATUS') {
                throw new Error('Status failed');
            }
        },
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*', {
        statusQuery: { messages: true }
    });
    const inbox = result.find(e => e.path === 'INBOX');
    test.ok(inbox);
    // Status should have error property
    test.ok(inbox.status);
    test.ok(inbox.status.error);
    test.done();
};

module.exports['Commands: list sorts by special use'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['SPECIAL-USE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                // Add folders out of order
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\Trash' }], { value: '/' }, { value: 'Trash' }]
                });
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\Sent' }], { value: '/' }, { value: 'Sent' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    // INBOX should be first (has \\Inbox special use)
    test.equal(result[0].specialUse, '\\Inbox');
    test.done();
};

module.exports['Commands: list handles delimiter in path'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [
                        [{ value: '\\HasNoChildren' }],
                        { value: '/' },
                        { value: '/Leading/Slash' } // Path starts with delimiter
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    const folder = result.find(e => e.name === 'Slash');
    test.ok(folder);
    // Leading delimiter should be removed
    test.equal(folder.path, 'Leading/Slash');
    test.done();
};

module.exports['Commands: list skips Noselect folders for status'] = async test => {
    let statusCalls = 0;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map(),
        run: async cmd => {
            if (cmd === 'STATUS') {
                statusCalls++;
                return { messages: 10 };
            }
        },
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\Noselect' }], { value: '/' }, { value: 'Parent' }]
                });
            }
            return { next: () => {} };
        }
    });

    await listCommand(connection, '', '*', { statusQuery: { messages: true } });
    // STATUS should not be called for Noselect folders
    test.equal(statusCalls, 0);
    test.done();
};

module.exports['Commands: list XLIST removes Inbox flag from non-INBOX'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['XLIST', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'XLIST' && opts && opts.untagged && opts.untagged.XLIST) {
                // XLIST may have localised inbox name with \\Inbox flag
                await opts.untagged.XLIST({
                    attributes: [
                        [{ value: '\\Inbox' }, { value: '\\HasNoChildren' }],
                        { value: '/' },
                        { value: 'Posteingang' } // German for inbox
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    const folder = result.find(e => e.path === 'Posteingang');
    test.ok(folder);
    // \\Inbox flag should be removed from flags set
    test.equal(folder.flags.has('\\Inbox'), false);
    // But it should have \\Inbox special use
    test.equal(folder.specialUse, '\\Inbox');
    test.done();
};

// ============================================
// SELECT Command Tests
// ============================================

const selectCommand = require('../lib/commands/select');

module.exports['Commands: select basic'] = async test => {
    let execCalled = false;
    let execCommand = '';
    const connection = createMockConnection({
        state: 2, // AUTHENTICATED
        folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
        run: async () => [],
        exec: async (cmd, attrs, opts) => {
            execCalled = true;
            execCommand = cmd;
            // Simulate SELECT response
            if (opts && opts.untagged) {
                if (opts.untagged.FLAGS) {
                    await opts.untagged.FLAGS({
                        attributes: [[{ value: '\\Seen' }, { value: '\\Answered' }, { value: '\\Flagged' }]]
                    });
                }
                if (opts.untagged.EXISTS) {
                    await opts.untagged.EXISTS({ command: '100' });
                }
                if (opts.untagged.OK) {
                    await opts.untagged.OK({
                        attributes: [{ section: [{ type: 'ATOM', value: 'UIDVALIDITY' }, { value: '12345' }] }]
                    });
                    await opts.untagged.OK({
                        attributes: [{ section: [{ type: 'ATOM', value: 'UIDNEXT' }, { value: '1000' }] }]
                    });
                    await opts.untagged.OK({
                        attributes: [{ section: [{ type: 'ATOM', value: 'PERMANENTFLAGS' }, [{ value: '\\*' }]] }]
                    });
                }
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {}
    });

    const result = await selectCommand(connection, 'INBOX');
    test.equal(execCalled, true);
    test.equal(execCommand, 'SELECT');
    test.ok(result);
    test.equal(result.path, 'INBOX');
    test.equal(result.exists, 100);
    test.equal(result.readOnly, false);
    test.done();
};

module.exports['Commands: select with readOnly option uses EXAMINE'] = async test => {
    let execCommand = '';
    const connection = createMockConnection({
        state: 2,
        folders: new Map([['INBOX', { path: 'INBOX' }]]),
        run: async () => [],
        exec: async cmd => {
            execCommand = cmd;
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-ONLY' }] }] }
            };
        },
        emit: () => {}
    });

    const result = await selectCommand(connection, 'INBOX', { readOnly: true });
    test.equal(execCommand, 'EXAMINE');
    test.equal(result.readOnly, true);
    test.done();
};

module.exports['Commands: select skips when not authenticated'] = async test => {
    const connection = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

    const result = await selectCommand(connection, 'INBOX');
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: select fetches folder list if not cached'] = async test => {
    let listCalled = false;
    const connection = createMockConnection({
        state: 2,
        folders: new Map(), // Empty - will trigger LIST
        run: async cmd => {
            if (cmd === 'LIST') {
                listCalled = true;
                return [{ path: 'INBOX', delimiter: '/' }];
            }
        },
        exec: async () => ({
            next: () => {},
            response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
        }),
        emit: () => {}
    });

    await selectCommand(connection, 'INBOX');
    test.equal(listCalled, true);
    test.done();
};

module.exports['Commands: select throws when LIST fails'] = async test => {
    const connection = createMockConnection({
        state: 2,
        folders: new Map(),
        run: async () => null // LIST returns null
    });

    try {
        await selectCommand(connection, 'INBOX');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.message, 'Failed to fetch folders');
    }
    test.done();
};

module.exports['Commands: select with QRESYNC'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 2,
        enabled: new Set(['QRESYNC']),
        folders: new Map([['INBOX', { path: 'INBOX' }]]),
        run: async () => [],
        exec: async (cmd, attrs, opts) => {
            execAttrs = attrs;
            // Must return matching UIDVALIDITY and HIGHESTMODSEQ for QRESYNC to remain valid
            if (opts && opts.untagged && opts.untagged.OK) {
                await opts.untagged.OK({
                    attributes: [{ section: [{ type: 'ATOM', value: 'UIDVALIDITY' }, { value: '67890' }] }]
                });
                await opts.untagged.OK({
                    attributes: [{ section: [{ type: 'ATOM', value: 'HIGHESTMODSEQ' }, { value: '100' }] }]
                });
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {},
        untaggedVanished: async () => {},
        untaggedFetch: async () => {}
    });

    const result = await selectCommand(connection, 'INBOX', {
        changedSince: '12345',
        uidValidity: BigInt(67890)
    });
    test.ok(execAttrs);
    const attrsStr = JSON.stringify(execAttrs);
    test.ok(attrsStr.includes('QRESYNC'));
    test.equal(result.qresync, true);
    test.done();
};

module.exports['Commands: select QRESYNC invalidated when UIDVALIDITY mismatch'] = async test => {
    const connection = createMockConnection({
        state: 2,
        enabled: new Set(['QRESYNC']),
        folders: new Map([['INBOX', { path: 'INBOX' }]]),
        run: async () => [],
        exec: async (cmd, attrs, opts) => {
            // Return different UIDVALIDITY
            if (opts && opts.untagged && opts.untagged.OK) {
                await opts.untagged.OK({
                    attributes: [{ section: [{ type: 'ATOM', value: 'UIDVALIDITY' }, { value: '99999' }] }]
                });
                await opts.untagged.OK({
                    attributes: [{ section: [{ type: 'ATOM', value: 'HIGHESTMODSEQ' }, { value: '100' }] }]
                });
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {}
    });

    const result = await selectCommand(connection, 'INBOX', {
        changedSince: '12345',
        uidValidity: BigInt(67890) // Different from server's 99999
    });
    // QRESYNC should be invalidated due to UIDVALIDITY mismatch
    test.equal(result.qresync, false);
    test.done();
};

module.exports['Commands: select QRESYNC invalidated when NOMODSEQ'] = async test => {
    const connection = createMockConnection({
        state: 2,
        enabled: new Set(['QRESYNC']),
        folders: new Map([['INBOX', { path: 'INBOX' }]]),
        run: async () => [],
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.OK) {
                await opts.untagged.OK({
                    attributes: [{ section: [{ type: 'ATOM', value: 'UIDVALIDITY' }, { value: '67890' }] }]
                });
                // NOMODSEQ present
                await opts.untagged.OK({
                    attributes: [{ section: [{ type: 'ATOM', value: 'NOMODSEQ' }] }]
                });
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {}
    });

    const result = await selectCommand(connection, 'INBOX', {
        changedSince: '12345',
        uidValidity: BigInt(67890)
    });
    test.equal(result.noModseq, true);
    test.equal(result.qresync, false);
    test.done();
};

module.exports['Commands: select parses HIGHESTMODSEQ'] = async test => {
    const connection = createMockConnection({
        state: 2,
        folders: new Map([['INBOX', { path: 'INBOX' }]]),
        run: async () => [],
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.OK) {
                await opts.untagged.OK({
                    attributes: [{ section: [{ type: 'ATOM', value: 'HIGHESTMODSEQ' }, { value: '9876543210' }] }]
                });
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {}
    });

    const result = await selectCommand(connection, 'INBOX');
    test.equal(result.highestModseq, BigInt('9876543210'));
    test.done();
};

module.exports['Commands: select parses MAILBOXID'] = async test => {
    const connection = createMockConnection({
        state: 2,
        folders: new Map([['INBOX', { path: 'INBOX' }]]),
        run: async () => [],
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.OK) {
                await opts.untagged.OK({
                    attributes: [{ section: [{ type: 'ATOM', value: 'MAILBOXID' }, [{ value: 'abc123' }]] }]
                });
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {}
    });

    const result = await selectCommand(connection, 'INBOX');
    test.equal(result.mailboxId, 'abc123');
    test.done();
};

module.exports['Commands: select emits mailboxOpen event'] = async test => {
    let emittedEvents = [];
    const connection = createMockConnection({
        state: 2,
        mailbox: false, // No current mailbox
        folders: new Map([['INBOX', { path: 'INBOX' }]]),
        run: async () => [],
        exec: async () => ({
            next: () => {},
            response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
        }),
        emit: event => {
            emittedEvents.push(event);
        }
    });

    await selectCommand(connection, 'INBOX');
    test.ok(emittedEvents.includes('mailboxOpen'));
    test.done();
};

module.exports['Commands: select emits mailboxClose when switching'] = async test => {
    let emittedEvents = [];
    const connection = createMockConnection({
        state: 3, // Already SELECTED
        mailbox: { path: 'OldFolder' },
        folders: new Map([['INBOX', { path: 'INBOX' }]]),
        run: async () => [],
        exec: async () => ({
            next: () => {},
            response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
        }),
        emit: event => {
            emittedEvents.push(event);
        }
    });

    await selectCommand(connection, 'INBOX');
    test.ok(emittedEvents.includes('mailboxClose'));
    test.ok(emittedEvents.includes('mailboxOpen'));
    test.done();
};

module.exports['Commands: select handles error'] = async test => {
    const connection = createMockConnection({
        state: 2,
        folders: new Map([['INBOX', { path: 'INBOX' }]]),
        run: async () => [],
        exec: async () => {
            const err = new Error('Select failed');
            err.response = { attributes: [] };
            throw err;
        },
        emit: () => {}
    });

    try {
        await selectCommand(connection, 'INBOX');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.message, 'Select failed');
    }
    test.done();
};

module.exports['Commands: select resets state on error when SELECTED'] = async test => {
    let emittedEvent = '';
    const connection = createMockConnection({
        state: 3, // SELECTED
        mailbox: { path: 'CurrentFolder' },
        folders: new Map([['INBOX', { path: 'INBOX' }]]),
        run: async () => [],
        exec: async () => {
            const err = new Error('Select failed');
            err.response = { attributes: [] };
            throw err;
        },
        emit: event => {
            emittedEvent = event;
        }
    });

    try {
        await selectCommand(connection, 'INBOX');
    } catch (err) {
        // Expected - error is intentionally ignored
        err.expected = true;
    }
    test.equal(connection.state, 2); // Reset to AUTHENTICATED
    test.equal(connection.mailbox, false);
    test.equal(emittedEvent, 'mailboxClose');
    test.done();
};

module.exports['Commands: select copies folder metadata'] = async test => {
    const connection = createMockConnection({
        state: 2,
        folders: new Map([
            [
                'INBOX',
                {
                    path: 'INBOX',
                    delimiter: '/',
                    specialUse: '\\Inbox',
                    subscribed: true,
                    listed: true
                }
            ]
        ]),
        run: async () => [],
        exec: async () => ({
            next: () => {},
            response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
        }),
        emit: () => {}
    });

    const result = await selectCommand(connection, 'INBOX');
    test.equal(result.delimiter, '/');
    test.equal(result.specialUse, '\\Inbox');
    test.equal(result.subscribed, true);
    test.equal(result.listed, true);
    test.done();
};

module.exports['Commands: select handles VANISHED untagged'] = async test => {
    let vanishedCalled = false;
    const connection = createMockConnection({
        state: 2,
        enabled: new Set(['QRESYNC']),
        folders: new Map([['INBOX', { path: 'INBOX' }]]),
        run: async () => [],
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.VANISHED) {
                await opts.untagged.VANISHED({ attributes: [] });
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {},
        untaggedVanished: async () => {
            vanishedCalled = true;
        }
    });

    await selectCommand(connection, 'INBOX', { changedSince: '100', uidValidity: BigInt(123) });
    test.equal(vanishedCalled, true);
    test.done();
};

module.exports['Commands: select handles FETCH untagged'] = async test => {
    let fetchCalled = false;
    const connection = createMockConnection({
        state: 2,
        enabled: new Set(['QRESYNC']),
        folders: new Map([['INBOX', { path: 'INBOX' }]]),
        run: async () => [],
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.FETCH) {
                await opts.untagged.FETCH({ command: '1', attributes: [] });
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {},
        untaggedFetch: async () => {
            fetchCalled = true;
        }
    });

    await selectCommand(connection, 'INBOX', { changedSince: '100', uidValidity: BigInt(123) });
    test.equal(fetchCalled, true);
    test.done();
};

module.exports['Commands: select encodes path with special characters'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 2,
        folders: new Map([['Test&Folder', { path: 'Test&Folder' }]]),
        run: async () => [],
        exec: async (cmd, attrs) => {
            execAttrs = attrs;
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {}
    });

    await selectCommand(connection, 'Test&Folder');
    // Path with & should use STRING type instead of ATOM
    test.ok(execAttrs);
    test.equal(execAttrs[0].type, 'STRING');
    test.done();
};

// ============================================
// STATUS Command Tests
// ============================================

const statusCommand = require('../lib/commands/status');

module.exports['Commands: status basic'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        state: 2, // AUTHENTICATED
        exec: async (cmd, attrs, opts) => {
            execCalled = true;
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '100' }, { value: 'UNSEEN' }, { value: '10' }]]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await statusCommand(connection, 'INBOX', { messages: true, unseen: true });
    test.equal(execCalled, true);
    test.ok(result);
    test.equal(result.path, 'INBOX');
    test.equal(result.messages, 100);
    test.equal(result.unseen, 10);
    test.done();
};

module.exports['Commands: status skips when not authenticated'] = async test => {
    const connection = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

    const result = await statusCommand(connection, 'INBOX', { messages: true });
    test.equal(result, false);
    test.done();
};

module.exports['Commands: status skips when no path'] = async test => {
    const connection = createMockConnection({ state: 2 });

    const result = await statusCommand(connection, '', { messages: true });
    test.equal(result, false);
    test.done();
};

module.exports['Commands: status skips when no query attributes'] = async test => {
    const connection = createMockConnection({ state: 2 });

    const result = await statusCommand(connection, 'INBOX', {});
    test.equal(result, false);
    test.done();
};

module.exports['Commands: status skips when all query values are false'] = async test => {
    const connection = createMockConnection({ state: 2 });

    const result = await statusCommand(connection, 'INBOX', { messages: false, unseen: false });
    test.equal(result, false);
    test.done();
};

module.exports['Commands: status with all standard query attributes'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs, opts) => {
            queryAttrs = attrs;
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [
                        { value: 'INBOX' },
                        [
                            { value: 'MESSAGES' },
                            { value: '100' },
                            { value: 'RECENT' },
                            { value: '5' },
                            { value: 'UIDNEXT' },
                            { value: '1000' },
                            { value: 'UIDVALIDITY' },
                            { value: '12345' },
                            { value: 'UNSEEN' },
                            { value: '10' }
                        ]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await statusCommand(connection, 'INBOX', {
        messages: true,
        recent: true,
        uidNext: true,
        uidValidity: true,
        unseen: true
    });
    test.ok(queryAttrs);
    const queryStr = JSON.stringify(queryAttrs);
    test.ok(queryStr.includes('MESSAGES'));
    test.ok(queryStr.includes('RECENT'));
    test.ok(queryStr.includes('UIDNEXT'));
    test.ok(queryStr.includes('UIDVALIDITY'));
    test.ok(queryStr.includes('UNSEEN'));

    test.equal(result.messages, 100);
    test.equal(result.recent, 5);
    test.equal(result.uidNext, 1000);
    test.equal(result.uidValidity, BigInt(12345));
    test.equal(result.unseen, 10);
    test.done();
};

module.exports['Commands: status with HIGHESTMODSEQ and CONDSTORE'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['CONDSTORE', true]]),
        exec: async (cmd, attrs, opts) => {
            queryAttrs = attrs;
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [{ value: 'INBOX' }, [{ value: 'HIGHESTMODSEQ' }, { value: '9876543210' }]]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await statusCommand(connection, 'INBOX', { highestModseq: true });
    test.ok(queryAttrs);
    const queryStr = JSON.stringify(queryAttrs);
    test.ok(queryStr.includes('HIGHESTMODSEQ'));
    test.equal(result.highestModseq, BigInt('9876543210'));
    test.done();
};

module.exports['Commands: status ignores HIGHESTMODSEQ without CONDSTORE'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map(), // No CONDSTORE
        exec: async () => ({ next: () => {} })
    });

    const result = await statusCommand(connection, 'INBOX', { highestModseq: true });
    // Should return false since no valid query attributes
    test.equal(result, false);
    test.done();
};

module.exports['Commands: status updates current mailbox when SELECTED'] = async test => {
    let existsEmitted = false;
    const connection = createMockConnection({
        state: 3, // SELECTED
        mailbox: { path: 'INBOX', exists: 50, uidNext: 500 },
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '100' }, { value: 'UIDNEXT' }, { value: '1000' }]]
                });
            }
            return { next: () => {} };
        },
        emit: event => {
            if (event === 'exists') existsEmitted = true;
        }
    });

    await statusCommand(connection, 'INBOX', { messages: true, uidNext: true });
    // Mailbox should be updated
    test.equal(connection.mailbox.exists, 100);
    test.equal(connection.mailbox.uidNext, 1000);
    // exists event should be emitted since count changed
    test.equal(existsEmitted, true);
    test.done();
};

module.exports['Commands: status does not emit exists when count unchanged'] = async test => {
    let existsEmitted = false;
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX', exists: 100 }, // Same as response
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '100' }]]
                });
            }
            return { next: () => {} };
        },
        emit: event => {
            if (event === 'exists') existsEmitted = true;
        }
    });

    await statusCommand(connection, 'INBOX', { messages: true });
    test.equal(existsEmitted, false);
    test.done();
};

module.exports['Commands: status handles error with NO response'] = async test => {
    const connection = createMockConnection({
        state: 2,
        run: async () => [], // LIST returns empty - folder doesn't exist
        exec: async () => {
            const err = new Error('Mailbox not found');
            err.responseStatus = 'NO';
            throw err;
        }
    });

    try {
        await statusCommand(connection, 'NonExistent', { messages: true });
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.code, 'NotFound');
    }
    test.done();
};

module.exports['Commands: status returns false on other errors'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Some error');
            err.responseStatus = 'BAD';
            throw err;
        }
    });

    const result = await statusCommand(connection, 'INBOX', { messages: true });
    test.equal(result, false);
    test.done();
};

module.exports['Commands: status handles empty STATUS response'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.STATUS) {
                // Empty list - should be ignored
                await opts.untagged.STATUS({
                    attributes: [{ value: 'INBOX' }, false]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await statusCommand(connection, 'INBOX', { messages: true });
    test.ok(result);
    test.equal(result.path, 'INBOX');
    // No messages property since response was empty
    test.equal(result.messages, undefined);
    test.done();
};

module.exports['Commands: status handles invalid entry values'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [
                        { value: 'INBOX' },
                        [
                            { value: 'MESSAGES' },
                            { value: 'not-a-number' },
                            { value: 'UNSEEN' },
                            { value: '10' },
                            null,
                            { value: '5' }, // Invalid key
                            { value: 'RECENT' },
                            null // Invalid value
                        ]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await statusCommand(connection, 'INBOX', { messages: true, unseen: true, recent: true });
    test.ok(result);
    // MESSAGES with invalid value should be skipped (isNaN check fails)
    test.equal(result.messages, undefined);
    // UNSEEN should work
    test.equal(result.unseen, 10);
    // RECENT with null value should be skipped
    test.equal(result.recent, undefined);
    test.done();
};

module.exports['Commands: status encodes path with special characters'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs) => {
            execAttrs = attrs;
            return { next: () => {} };
        }
    });

    await statusCommand(connection, 'Test&Folder', { messages: true });
    // Path with & should use STRING type instead of ATOM
    test.ok(execAttrs);
    test.equal(execAttrs[0].type, 'STRING');
    test.done();
};

module.exports['Commands: status works from SELECTED state'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        state: 3, // SELECTED
        mailbox: { path: 'OtherFolder' }, // Different folder
        exec: async (cmd, attrs, opts) => {
            execCalled = true;
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '50' }]]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await statusCommand(connection, 'INBOX', { messages: true });
    test.equal(execCalled, true);
    test.equal(result.messages, 50);
    test.done();
};

module.exports['Commands: status updates HIGHESTMODSEQ for current mailbox'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['CONDSTORE', true]]),
        mailbox: { path: 'INBOX', highestModseq: BigInt(100) },
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [{ value: 'INBOX' }, [{ value: 'HIGHESTMODSEQ' }, { value: '200' }]]
                });
            }
            return { next: () => {} };
        }
    });

    await statusCommand(connection, 'INBOX', { highestModseq: true });
    test.equal(connection.mailbox.highestModseq, BigInt(200));
    test.done();
};

// ============================================
// APPEND Command Tests
// ============================================

const appendCommand = require('../lib/commands/append');

module.exports['Commands: append basic'] = async test => {
    let appendCalled = false;
    const connection = createMockConnection({
        state: 2, // AUTHENTICATED
        mailbox: { path: 'OtherFolder' }, // Different folder to avoid EXISTS handling
        exec: async cmd => {
            if (cmd === 'APPEND') {
                appendCalled = true;
            }
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    const result = await appendCommand(connection, 'INBOX', 'Test message content');
    test.equal(appendCalled, true);
    test.ok(result);
    test.equal(result.destination, 'INBOX');
    test.done();
};

module.exports['Commands: append with Buffer content'] = async test => {
    let contentAttr = null;
    const connection = createMockConnection({
        state: 2,
        mailbox: { path: 'OtherFolder' },
        exec: async (cmd, attrs) => {
            if (cmd === 'APPEND' && Array.isArray(attrs)) {
                contentAttr = attrs.find(a => a && a.type === 'LITERAL');
            }
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    const buffer = Buffer.from('Test message');
    await appendCommand(connection, 'INBOX', buffer);
    test.ok(contentAttr);
    test.ok(Buffer.isBuffer(contentAttr.value));
    test.equal(contentAttr.value.toString(), 'Test message');
    test.done();
};

module.exports['Commands: append skips when not authenticated'] = async test => {
    const connection = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

    const result = await appendCommand(connection, 'INBOX', 'content');
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: append skips when no destination'] = async test => {
    const connection = createMockConnection({ state: 2 });

    const result = await appendCommand(connection, '', 'content');
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: append with flags'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 2,
        mailbox: { path: 'OtherFolder', permanentFlags: new Set(['\\*']) },
        exec: async (cmd, attrs) => {
            if (cmd === 'APPEND' && Array.isArray(attrs)) {
                execAttrs = attrs;
            }
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    await appendCommand(connection, 'INBOX', 'content', ['\\Seen', '\\Flagged']);
    test.ok(execAttrs);
    // Should have flags array between path and content
    const flagsAttr = execAttrs.find(a => Array.isArray(a));
    test.ok(flagsAttr);
    test.ok(flagsAttr.some(f => f.value === '\\Seen'));
    test.ok(flagsAttr.some(f => f.value === '\\Flagged'));
    test.done();
};

module.exports['Commands: append with internal date'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 2,
        mailbox: { path: 'OtherFolder' },
        exec: async (cmd, attrs) => {
            if (cmd === 'APPEND' && Array.isArray(attrs)) {
                execAttrs = attrs;
            }
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    const date = new Date('2024-01-15T10:30:00Z');
    await appendCommand(connection, 'INBOX', 'content', [], date);
    test.ok(execAttrs);
    // Should have date string
    const dateAttr = execAttrs.find(a => a && a.type === 'STRING');
    test.ok(dateAttr);
    test.ok(dateAttr.value.includes('2024'));
    test.done();
};

module.exports['Commands: append checks APPENDLIMIT'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['APPENDLIMIT', 100]]), // 100 byte limit
        mailbox: { path: 'INBOX' }
    });

    const largeContent = Buffer.alloc(200, 'x'); // 200 bytes, exceeds limit

    try {
        await appendCommand(connection, 'INBOX', largeContent);
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.serverResponseCode, 'APPENDLIMIT');
        test.ok(err.message.includes('APPENDLIMIT'));
    }
    test.done();
};

module.exports['Commands: append allows content within APPENDLIMIT'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['APPENDLIMIT', 1000]]),
        mailbox: { path: 'INBOX' },
        exec: async () => {
            execCalled = true;
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    const content = Buffer.alloc(500, 'x'); // Within limit
    await appendCommand(connection, 'INBOX', content);
    test.equal(execCalled, true);
    test.done();
};

module.exports['Commands: append with APPENDUID response'] = async test => {
    const connection = createMockConnection({
        state: 2,
        mailbox: { path: 'INBOX' },
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        section: [
                            { value: 'APPENDUID' },
                            { value: '12345' }, // uidValidity
                            { value: '100' } // uid
                        ]
                    }
                ]
            }
        })
    });

    const result = await appendCommand(connection, 'INBOX', 'content');
    test.equal(result.uidValidity, BigInt(12345));
    test.equal(result.uid, 100);
    test.done();
};

module.exports['Commands: append to current mailbox triggers EXISTS'] = async test => {
    let existsEmitted = false;
    const connection = createMockConnection({
        state: 3, // SELECTED
        mailbox: { path: 'INBOX', exists: 10 },
        exec: async (cmd, attrs, opts) => {
            // Simulate EXISTS untagged response
            if (cmd === 'APPEND' && opts && opts.untagged && opts.untagged.EXISTS) {
                await opts.untagged.EXISTS({ command: '11' });
            }
            return {
                next: () => {},
                response: { attributes: [] }
            };
        },
        emit: event => {
            if (event === 'exists') existsEmitted = true;
        },
        search: async () => [100] // Return UID
    });

    await appendCommand(connection, 'INBOX', 'content');
    test.equal(existsEmitted, true);
    test.equal(connection.mailbox.exists, 11);
    test.done();
};

module.exports['Commands: append runs NOOP to get sequence if not in EXISTS'] = async test => {
    let noopCalled = false;
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX', exists: 10 },
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'NOOP') {
                noopCalled = true;
                if (opts && opts.untagged && opts.untagged.EXISTS) {
                    await opts.untagged.EXISTS({ command: '11' });
                }
            }
            return {
                next: () => {},
                response: { attributes: [] }
            };
        },
        emit: () => {},
        search: async () => [100] // Return UID
    });

    const result = await appendCommand(connection, 'INBOX', 'content');
    test.equal(noopCalled, true);
    test.equal(result.seq, 11);
    test.done();
};

module.exports['Commands: append searches for UID if seq but no uid'] = async test => {
    let searchCalled = false;
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX', exists: 10 },
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.EXISTS) {
                await opts.untagged.EXISTS({ command: '11' });
            }
            return {
                next: () => {},
                response: { attributes: [] }
            };
        },
        emit: () => {},
        search: async () => {
            searchCalled = true;
            return [100];
        }
    });

    const result = await appendCommand(connection, 'INBOX', 'content');
    test.equal(searchCalled, true);
    test.equal(result.uid, 100);
    test.done();
};

module.exports['Commands: append with BINARY and NULL bytes'] = async test => {
    let literalAttr = null;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['BINARY', true]]),
        mailbox: { path: 'INBOX' },
        exec: async (cmd, attrs) => {
            literalAttr = attrs.find(a => a.type === 'LITERAL');
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    // Content with NULL byte
    const content = Buffer.concat([Buffer.from('test'), Buffer.from([0]), Buffer.from('data')]);
    await appendCommand(connection, 'INBOX', content);
    test.ok(literalAttr);
    test.equal(literalAttr.isLiteral8, true);
    test.done();
};

module.exports['Commands: append without BINARY uses regular literal'] = async test => {
    let literalAttr = null;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map(), // No BINARY
        mailbox: { path: 'INBOX' },
        exec: async (cmd, attrs) => {
            literalAttr = attrs.find(a => a.type === 'LITERAL');
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    const content = Buffer.concat([Buffer.from('test'), Buffer.from([0]), Buffer.from('data')]);
    await appendCommand(connection, 'INBOX', content);
    test.ok(literalAttr);
    test.equal(literalAttr.isLiteral8, false);
    test.done();
};

module.exports['Commands: append handles error'] = async test => {
    const connection = createMockConnection({
        state: 2,
        mailbox: { path: 'OtherFolder' },
        exec: async () => {
            const err = new Error('Append failed');
            err.response = { attributes: [] };
            throw err;
        }
    });

    try {
        await appendCommand(connection, 'INBOX', 'content');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.message, 'Append failed');
    }
    test.done();
};

module.exports['Commands: append filters invalid flags'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 2,
        mailbox: {
            path: 'OtherFolder',
            permanentFlags: new Set(['\\Seen', '\\Flagged']) // Only allow these
        },
        exec: async (cmd, attrs) => {
            if (cmd === 'APPEND' && Array.isArray(attrs)) {
                execAttrs = attrs;
            }
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    // Mix of valid and invalid flags
    await appendCommand(connection, 'INBOX', 'content', ['\\Seen', '\\CustomFlag', null, '\\Flagged']);
    test.ok(execAttrs);
    const flagsAttr = execAttrs.find(a => Array.isArray(a));
    test.ok(flagsAttr);
    // Should only contain allowed flags
    test.equal(flagsAttr.length, 2);
    test.done();
};

module.exports['Commands: append works from SELECTED state'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        state: 3, // SELECTED
        mailbox: { path: 'OtherFolder', exists: 10 },
        exec: async () => {
            execCalled = true;
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    // Append to different folder than current
    const result = await appendCommand(connection, 'INBOX', 'content');
    test.equal(execCalled, true);
    test.equal(result.destination, 'INBOX');
    test.done();
};

// ============================================
// IDLE Command Tests
// ============================================

const idleCommand = require('../lib/commands/idle');

module.exports['Commands: idle with IDLE capability'] = async test => {
    let execCommand = '';
    let idlingSet = false;
    const connection = createMockConnection({
        state: 3, // SELECTED
        capabilities: new Map([['IDLE', true]]),
        exec: async (cmd, attrs, opts) => {
            execCommand = cmd;
            idlingSet = connection.idling;
            // Simulate continuation response
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag();
            }
            return { next: () => {} };
        },
        write: () => {}
    });

    await idleCommand(connection);
    test.equal(execCommand, 'IDLE');
    test.equal(idlingSet, true);
    test.done();
};

module.exports['Commands: idle skips when not selected'] = async test => {
    const connection = createMockConnection({ state: 2 }); // AUTHENTICATED

    const result = await idleCommand(connection);
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: idle falls back to NOOP without IDLE capability'] = async test => {
    let noopCalled = false;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map(), // No IDLE
        currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
        exec: async cmd => {
            if (cmd === 'NOOP') {
                noopCalled = true;
                // Break out of the loop by calling preCheck
                if (connection.preCheck) {
                    await connection.preCheck();
                }
            }
            return { next: () => {} };
        }
    });

    // Start idle - it will loop with NOOP
    const idlePromise = idleCommand(connection);

    // Give it a moment to start, then break the loop
    await new Promise(resolve => setTimeout(resolve, 10));
    if (connection.preCheck) {
        await connection.preCheck();
    }

    await idlePromise;
    test.equal(noopCalled, true);
    test.done();
};

module.exports['Commands: idle preCheck breaks IDLE'] = async test => {
    let doneSent = false;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag();
            }
            // After IDLE is initiated, trigger preCheck
            if (connection.preCheck) {
                await connection.preCheck();
            }
            return { next: () => {} };
        },
        write: data => {
            if (data === 'DONE') {
                doneSent = true;
            }
        }
    });

    await idleCommand(connection);
    test.equal(doneSent, true);
    test.equal(connection.idling, false);
    test.done();
};

module.exports['Commands: idle handles error'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        exec: async () => {
            throw new Error('IDLE failed');
        }
    });

    const result = await idleCommand(connection);
    test.equal(result, false);
    test.equal(connection.idling, false);
    test.done();
};

module.exports['Commands: idle with maxIdleTime restarts loop'] = async test => {
    let idleCount = 0;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        exec: async (cmd, attrs, opts) => {
            idleCount++;
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag();
            }
            // Break after second iteration
            if (idleCount >= 2 && connection.preCheck) {
                await connection.preCheck();
            }
            return { next: () => {} };
        },
        write: () => {}
    });

    // Very short maxIdleTime to trigger restart
    await idleCommand(connection, 5);
    test.ok(idleCount >= 1);
    test.done();
};

module.exports['Commands: idle without currentSelectCommand returns immediately'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map(), // No IDLE
        currentSelectCommand: false // No select command
    });

    // Should resolve immediately
    await idleCommand(connection);
    test.ok(true);
    test.done();
};

module.exports['Commands: idle NOOP fallback uses STATUS when configured'] = async test => {
    let statusCalled = false;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map(),
        currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
        missingIdleCommand: 'STATUS',
        exec: async cmd => {
            if (cmd === 'STATUS') {
                statusCalled = true;
                if (connection.preCheck) {
                    await connection.preCheck();
                }
            }
            return { next: () => {} };
        }
    });

    await idleCommand(connection);
    test.equal(statusCalled, true);
    test.done();
};

module.exports['Commands: idle NOOP fallback uses SELECT when configured'] = async test => {
    let selectCalled = false;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map(),
        currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
        missingIdleCommand: 'SELECT',
        exec: async cmd => {
            if (cmd === 'SELECT') {
                selectCalled = true;
                if (connection.preCheck) {
                    await connection.preCheck();
                }
            }
            return { next: () => {} };
        }
    });

    await idleCommand(connection);
    test.equal(selectCalled, true);
    test.done();
};

module.exports['Commands: idle sets preCheck function'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag();
            }
            // Check that preCheck is set
            test.equal(typeof connection.preCheck, 'function');
            // Break the IDLE
            if (connection.preCheck) {
                await connection.preCheck();
            }
            return { next: () => {} };
        },
        write: () => {}
    });

    await idleCommand(connection);
    test.done();
};

module.exports['Commands: idle clears preCheck on completion'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag();
            }
            if (connection.preCheck) {
                await connection.preCheck();
            }
            return { next: () => {} };
        },
        write: () => {}
    });

    await idleCommand(connection);
    test.equal(connection.preCheck, false);
    test.done();
};

module.exports['Commands: idle NOOP fallback handles error'] = async test => {
    let errorLogged = false;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map(),
        currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
        exec: async () => {
            throw new Error('NOOP failed');
        },
        log: {
            warn: () => {
                errorLogged = true;
            },
            debug: () => {},
            trace: () => {}
        }
    });

    // Should resolve even on error
    await idleCommand(connection);
    test.equal(errorLogged, true);
    test.done();
};
