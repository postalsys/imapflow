'use strict';

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
            debug: () => {}
        },
        close: overrides.close || (() => {}),
        emit: overrides.emit || (() => {}),
        currentSelectCommand: false,
        messageFlagsAdd: overrides.messageFlagsAdd || (async () => {}),
        run: overrides.run || (async () => {}),
        exec: overrides.exec || (async () => ({
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
        capabilities: new Map([['IMAP4rev1', true], ['IDLE', true]]),
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
        exec: async () => { throw new Error('Command failed'); }
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
        exec: async (cmd) => {
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
        exec: async () => { throw new Error('Command failed'); }
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
        exec: async (cmd) => {
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
        exec: async () => { throw new Error('Command failed'); }
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
        exec: async (cmd) => {
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
        exec: async () => { throw new Error('Command failed'); }
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
                    attributes: [
                        { value: '1' },
                        { value: '2' },
                        { value: '3' }
                    ]
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
        exec: async (cmd) => {
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
        exec: async (cmd) => {
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
                attributes: [{
                    section: [
                        { value: 'COPYUID' },
                        { value: '12345' },
                        { value: '1:3' },
                        { value: '100:102' }
                    ]
                }]
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
        exec: async (cmd) => {
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
        exec: async (cmd) => {
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
        exec: async (cmd) => {
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
        exec: async (cmd) => {
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
                attributes: [{
                    type: 'SECTION',
                    section: [{ type: 'ATOM', value: 'ALREADYEXISTS' }]
                }, { type: 'TEXT', value: 'Mailbox already exists' }]
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
        exec: async (cmd) => {
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
        exec: async (cmd) => {
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
        exec: async (cmd) => {
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
        capabilities: new Map([['ENABLE', true], ['CONDSTORE', true]]),
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
        capabilities: new Map([['ENABLE', true], ['CONDSTORE', true]]),
        exec: async () => { throw new Error('Enable failed'); }
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
        exec: async () => { throw new Error('Compress failed'); }
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
        exec: async () => { throw new Error('STARTTLS failed'); }
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
                        [
                            { type: 'ATOM', value: 'UID' },
                            { type: 'ATOM', value: '100' },
                            { type: 'ATOM', value: 'FLAGS' },
                            [{ value: '\\Seen' }]
                        ]
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
        exec: async (cmd) => {
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

    await fetchCommand(connection, '1', { uid: true }, {
        onUntaggedFetch: (msg, done) => {
            callbackCalled = true;
            done();
        }
    });
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
        await fetchCommand(connection, '1', { uid: true }, {
            onUntaggedFetch: (msg, done) => {
                done(new Error('Callback error'));
            }
        });
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.message, 'Callback error');
    }
    test.done();
};

module.exports['Commands: fetch handles error'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async () => { throw new Error('Fetch failed'); }
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
                    attributes: [
                        [{ value: '\\HasNoChildren' }],
                        { value: '/' },
                        { value: 'INBOX' }
                    ]
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
                    attributes: [
                        [{ value: '\\HasNoChildren' }],
                        { value: '/' },
                        { value: 'INBOX' }
                    ]
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
        capabilities: new Map([['XLIST', true], ['SPECIAL-USE', true]]),
        exec: async (cmd, attrs, opts) => {
            // Capture the first LIST/XLIST command, not LSUB
            if ((cmd === 'LIST' || cmd === 'XLIST') && !usedListCommand) {
                usedListCommand = cmd;
            }
            if (opts && opts.untagged && opts.untagged[cmd]) {
                await opts.untagged[cmd]({
                    attributes: [
                        [{ value: '\\HasNoChildren' }],
                        { value: '/' },
                        { value: 'INBOX' }
                    ]
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
        capabilities: new Map([['LIST-STATUS', true], ['SPECIAL-USE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST') {
                listAttrs = attrs;
                if (opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [
                            [{ value: '\\HasNoChildren' }],
                            { value: '/' },
                            { value: 'INBOX' }
                        ]
                    });
                }
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [
                            { value: 'INBOX' },
                            [
                                { value: 'MESSAGES' }, { value: '10' },
                                { value: 'UNSEEN' }, { value: '5' }
                            ]
                        ]
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
        capabilities: new Map([['LIST-STATUS', true], ['CONDSTORE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST') {
                listAttrs = attrs;
                if (opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [
                            [{ value: '\\HasNoChildren' }],
                            { value: '/' },
                            { value: 'INBOX' }
                        ]
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
                    attributes: [
                        [{ value: '\\HasNoChildren' }],
                        { value: '/' },
                        { value: 'INBOX' }
                    ]
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
                    attributes: [
                        [{ value: '\\HasNoChildren' }],
                        { value: '/' },
                        { value: 'Sent Items' }
                    ]
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
                        attributes: [
                            [{ value: '\\HasNoChildren' }],
                            { value: '/' },
                            { value: 'INBOX' }
                        ]
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
                            attributes: [
                                [{ value: '\\HasNoChildren' }],
                                { value: '/' },
                                { value: 'INBOX/Subfolder' }
                            ]
                        });
                    } else {
                        await opts.untagged.LIST({
                            attributes: [
                                [{ value: '\\HasNoChildren' }],
                                { value: '/' },
                                { value: 'INBOX' }
                            ]
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
                    attributes: [
                        [{ value: '\\HasNoChildren' }],
                        { value: '/' },
                        { value: 'Folder1' }
                    ]
                });
            }
            if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                await opts.untagged.LSUB({
                    attributes: [
                        [{ value: '\\Subscribed' }],
                        { value: '/' },
                        { value: 'Folder1' }
                    ]
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
        exec: async () => { throw new Error('List failed'); }
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
        run: async (cmd, path, query) => {
            if (cmd === 'STATUS') {
                statusCalls++;
                return { messages: 10, unseen: 5, path };
            }
        },
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [
                        [{ value: '\\HasNoChildren' }],
                        { value: '/' },
                        { value: 'INBOX' }
                    ]
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
        run: async (cmd) => {
            if (cmd === 'STATUS') {
                throw new Error('Status failed');
            }
        },
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [
                        [{ value: '\\HasNoChildren' }],
                        { value: '/' },
                        { value: 'INBOX' }
                    ]
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
                    attributes: [
                        [{ value: '\\Trash' }],
                        { value: '/' },
                        { value: 'Trash' }
                    ]
                });
                await opts.untagged.LIST({
                    attributes: [
                        [{ value: '\\HasNoChildren' }],
                        { value: '/' },
                        { value: 'INBOX' }
                    ]
                });
                await opts.untagged.LIST({
                    attributes: [
                        [{ value: '\\Sent' }],
                        { value: '/' },
                        { value: 'Sent' }
                    ]
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
        run: async (cmd) => {
            if (cmd === 'STATUS') {
                statusCalls++;
                return { messages: 10 };
            }
        },
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [
                        [{ value: '\\Noselect' }],
                        { value: '/' },
                        { value: 'Parent' }
                    ]
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
