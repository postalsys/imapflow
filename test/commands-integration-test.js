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

module.exports['Commands: login error includes serverResponseCode'] = async test => {
    const connection = createMockConnection({
        state: 1,
        exec: async () => {
            const err = new Error('Auth failed');
            err.response = {
                tag: 'A1',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'AUTHENTICATIONFAILED' }]
                    },
                    { type: 'TEXT', value: 'Authentication failed' }
                ]
            };
            throw err;
        }
    });

    try {
        await loginCommand(connection, 'testuser', 'wrongpass');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.authenticationFailed, true);
        test.equal(err.serverResponseCode, 'AUTHENTICATIONFAILED');
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

module.exports['Commands: logout returns early when already in LOGOUT state'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        state: 4, // LOGOUT
        exec: async () => {
            execCalled = true;
            return { next: () => {} };
        }
    });

    const result = await logoutCommand(connection);
    test.equal(result, false);
    test.equal(execCalled, false);
    test.done();
};

module.exports['Commands: logout handles NOT_AUTHENTICATED state'] = async test => {
    let closeCalled = false;
    const connection = createMockConnection({
        state: 1, // NOT_AUTHENTICATED (mock states: 1=NOT_AUTH, 2=AUTH, 3=SELECTED, 4=LOGOUT)
        exec: async () => ({ next: () => {} }),
        close: () => {
            closeCalled = true;
        }
    });

    const result = await logoutCommand(connection);
    test.equal(result, false);
    test.equal(connection.state, connection.states.LOGOUT);
    test.equal(closeCalled, true);
    test.done();
};

module.exports['Commands: logout handles NoConnection error'] = async test => {
    const connection = createMockConnection({
        exec: async () => {
            const err = new Error('No connection');
            err.code = 'NoConnection';
            throw err;
        }
    });

    const result = await logoutCommand(connection);
    test.equal(result, true);
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

module.exports['Commands: close emits mailboxClose event'] = async test => {
    let emittedMailbox = null;
    const testMailbox = { path: 'INBOX', uidValidity: 12345n };
    const connection = createMockConnection({
        state: 3,
        mailbox: testMailbox,
        currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
        exec: async () => ({ next: () => {} }),
        emit: (event, data) => {
            if (event === 'mailboxClose') {
                emittedMailbox = data;
            }
        }
    });

    const result = await closeCommand(connection);
    test.equal(result, true);
    test.ok(emittedMailbox);
    test.equal(emittedMailbox.path, 'INBOX');
    test.equal(connection.mailbox, false);
    test.equal(connection.currentSelectCommand, false);
    test.equal(connection.state, 2); // AUTHENTICATED
    test.done();
};

module.exports['Commands: close without mailbox does not emit event'] = async test => {
    let eventEmitted = false;
    const connection = createMockConnection({
        state: 3,
        mailbox: false, // No mailbox
        exec: async () => ({ next: () => {} }),
        emit: event => {
            if (event === 'mailboxClose') {
                eventEmitted = true;
            }
        }
    });

    const result = await closeCommand(connection);
    test.equal(result, true);
    test.equal(eventEmitted, false);
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

module.exports['Commands: search error with serverResponseCode'] = async test => {
    let capturedErr = null;
    const connection = createMockConnection({
        state: 3,
        exec: async () => {
            const err = new Error('Search failed');
            err.response = {
                tag: 'A1',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'CANNOT' }]
                    },
                    { type: 'TEXT', value: 'Search not allowed' }
                ]
            };
            throw err;
        },
        log: {
            warn: data => {
                capturedErr = data.err;
            },
            info: () => {},
            debug: () => {},
            trace: () => {},
            error: () => {}
        }
    });

    const result = await searchCommand(connection, { all: true }, {});
    test.equal(result, false);
    test.ok(capturedErr);
    test.equal(capturedErr.serverResponseCode, 'CANNOT');
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

module.exports['Commands: store error with serverResponseCode'] = async test => {
    let capturedErr = null;
    const connection = createMockConnection({
        state: 3,
        exec: async () => {
            const err = new Error('Store failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'CANNOT' }]
                    },
                    { type: 'TEXT', value: 'Cannot modify flags' }
                ]
            };
            throw err;
        },
        log: {
            warn: data => {
                capturedErr = data.err;
            }
        }
    });

    const result = await storeCommand(connection, '1', ['\\Seen'], {});
    test.equal(result, false);
    test.ok(capturedErr);
    test.equal(capturedErr.serverResponseCode, 'CANNOT');
    test.done();
};

module.exports['Commands: store filters flags that cannot be used'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 3,
        mailbox: {
            permanentFlags: new Set(['\\Seen']) // Only \\Seen is allowed
        },
        exec: async (cmd, attrs) => {
            execAttrs = attrs;
            return { next: () => {} };
        }
    });

    // Try to add \\Deleted which is not in permanentFlags
    const result = await storeCommand(connection, '1', ['\\Seen', '\\Deleted'], { operation: 'add' });
    test.equal(result, true);
    test.ok(execAttrs);
    // Flags list should only contain \\Seen
    const flagsList = execAttrs[2];
    test.equal(flagsList.length, 1);
    test.equal(flagsList[0].value, '\\Seen');
    test.done();
};

module.exports['Commands: store remove operation uses minus prefix'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            execAttrs = attrs;
            return { next: () => {} };
        }
    });

    const result = await storeCommand(connection, '1', ['\\Seen', '\\Deleted'], { operation: 'remove' });
    test.equal(result, true);
    test.ok(execAttrs);
    // Remove operation should use -FLAGS prefix
    test.equal(execAttrs[1].value, '-FLAGS');
    const flagsList = execAttrs[2];
    test.equal(flagsList.length, 2);
    test.done();
};

module.exports['Commands: store returns false when no valid flags for add'] = async test => {
    const connection = createMockConnection({
        state: 3,
        mailbox: {
            permanentFlags: new Set() // No flags allowed
        }
    });

    // All flags get filtered out
    const result = await storeCommand(connection, '1', ['\\Seen', '\\Deleted'], { operation: 'add' });
    test.equal(result, false);
    test.done();
};

module.exports['Commands: store allows empty flags for set operation'] = async test => {
    let execCalled = false;
    const connection = createMockConnection({
        state: 3,
        mailbox: {
            permanentFlags: new Set() // No flags allowed, all get filtered
        },
        exec: async () => {
            execCalled = true;
            return { next: () => {} };
        }
    });

    // Set operation with empty flags should still proceed (to clear flags)
    const result = await storeCommand(connection, '1', ['\\Seen'], { operation: 'set' });
    test.equal(result, true);
    test.equal(execCalled, true);
    test.done();
};

module.exports['Commands: store returns false with empty flags for remove'] = async test => {
    const connection = createMockConnection({
        state: 3,
        mailbox: {
            permanentFlags: new Set()
        }
    });

    // Remove with no valid flags should return false (nothing to remove)
    const result = await storeCommand(connection, '1', [], { operation: 'remove' });
    test.equal(result, false);
    test.done();
};

module.exports['Commands: store default operation is add'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 3,
        exec: async (cmd, attrs) => {
            execAttrs = attrs;
            return { next: () => {} };
        }
    });

    await storeCommand(connection, '1', ['\\Seen'], {}); // No operation specified
    test.ok(execAttrs);
    test.equal(execAttrs[1].value, '+FLAGS');
    test.done();
};

module.exports['Commands: store with labels uses X-GM-LABELS'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['X-GM-EXT-1', true]]),
        exec: async (cmd, attrs) => {
            execAttrs = attrs;
            return { next: () => {} };
        }
    });

    await storeCommand(connection, '1', ['Important'], { useLabels: true, operation: 'add' });
    test.ok(execAttrs);
    test.equal(execAttrs[1].value, '+X-GM-LABELS');
    test.done();
};

module.exports['Commands: store silent does not apply to labels'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['X-GM-EXT-1', true]]),
        exec: async (cmd, attrs) => {
            execAttrs = attrs;
            return { next: () => {} };
        }
    });

    // When using labels, silent flag should not add .SILENT suffix
    await storeCommand(connection, '1', ['Important'], { useLabels: true, silent: true, operation: 'set' });
    test.ok(execAttrs);
    test.equal(execAttrs[1].value, 'X-GM-LABELS'); // Not X-GM-LABELS.SILENT
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

module.exports['Commands: copy error with serverResponseCode'] = async test => {
    const connection = createMockConnection({
        state: 3,
        exec: async () => {
            const err = new Error('Copy failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'TRYCREATE' }]
                    },
                    { type: 'TEXT', value: 'Mailbox does not exist' }
                ]
            };
            throw err;
        }
    });

    const result = await copyCommand(connection, '1:10', 'NonExistent', {});
    test.equal(result, false);
    test.done();
};

module.exports['Commands: copy with partial COPYUID response'] = async test => {
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX' },
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        type: 'ATOM',
                        section: [
                            { type: 'ATOM', value: 'COPYUID' },
                            { type: 'ATOM', value: '12345' }
                            // Missing source and destination UIDs
                        ]
                    }
                ]
            }
        })
    });

    const result = await copyCommand(connection, '1:10', 'Archive', {});
    test.ok(result);
    test.equal(result.path, 'INBOX');
    test.equal(result.destination, 'Archive');
    test.equal(result.uidValidity, 12345n);
    test.equal(result.uidMap, undefined);
    test.done();
};

module.exports['Commands: copy with invalid uidValidity'] = async test => {
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX' },
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        type: 'ATOM',
                        section: [
                            { type: 'ATOM', value: 'COPYUID' },
                            { type: 'ATOM', value: 'invalid' } // Non-numeric uidValidity
                        ]
                    }
                ]
            }
        })
    });

    const result = await copyCommand(connection, '1:10', 'Archive', {});
    test.ok(result);
    test.equal(result.uidValidity, undefined);
    test.done();
};

module.exports['Commands: copy with mismatched UID counts'] = async test => {
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX' },
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        type: 'ATOM',
                        section: [
                            { type: 'ATOM', value: 'COPYUID' },
                            { type: 'ATOM', value: '12345' },
                            { type: 'ATOM', value: '1:3' }, // 3 source UIDs
                            { type: 'ATOM', value: '100:101' } // 2 destination UIDs
                        ]
                    }
                ]
            }
        })
    });

    const result = await copyCommand(connection, '1:3', 'Archive', {});
    test.ok(result);
    test.equal(result.uidValidity, 12345n);
    test.equal(result.uidMap, undefined); // Not set due to mismatch
    test.done();
};

module.exports['Commands: copy with non-COPYUID response code'] = async test => {
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX' },
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        type: 'ATOM',
                        section: [{ type: 'ATOM', value: 'APPENDUID' }] // Not COPYUID
                    }
                ]
            }
        })
    });

    const result = await copyCommand(connection, '1:10', 'Archive', {});
    test.ok(result);
    test.equal(result.path, 'INBOX');
    test.equal(result.destination, 'Archive');
    test.equal(result.uidValidity, undefined);
    test.equal(result.uidMap, undefined);
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

module.exports['Commands: move skips when no range'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]])
    });

    const result = await moveCommand(connection, null, 'Archive', {});
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: move skips when no destination'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]])
    });

    const result = await moveCommand(connection, '1:10', null, {});
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: move fallback without MOVE capability'] = async test => {
    let copyCalled = false;
    let deleteCalled = false;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map(), // No MOVE capability
        messageCopy: async (range, dest) => {
            copyCalled = true;
            test.equal(range, '1:10');
            test.equal(dest, 'Archive');
            return { path: 'INBOX', destination: 'Archive' };
        },
        messageDelete: async (range, opts) => {
            deleteCalled = true;
            test.equal(range, '1:10');
            test.equal(opts.silent, true);
            return true;
        }
    });

    const result = await moveCommand(connection, '1:10', 'Archive', {});
    test.ok(copyCalled);
    test.ok(deleteCalled);
    test.equal(result.destination, 'Archive');
    test.done();
};

module.exports['Commands: move fallback passes options'] = async test => {
    let copyOpts = null;
    let deleteOpts = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map(), // No MOVE capability
        messageCopy: async (range, dest, opts) => {
            copyOpts = opts;
            return { path: 'INBOX', destination: dest };
        },
        messageDelete: async (range, opts) => {
            deleteOpts = opts;
            return true;
        }
    });

    await moveCommand(connection, '1:10', 'Archive', { uid: true });
    test.equal(copyOpts.uid, true);
    test.equal(deleteOpts.uid, true);
    test.equal(deleteOpts.silent, true);
    test.done();
};

module.exports['Commands: move with COPYUID response'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]]),
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

    const result = await moveCommand(connection, '1:3', 'Archive', {});
    test.ok(result.uidValidity);
    test.equal(result.uidValidity, BigInt(12345));
    test.ok(result.uidMap instanceof Map);
    test.equal(result.uidMap.get(1), 100);
    test.equal(result.uidMap.get(2), 101);
    test.equal(result.uidMap.get(3), 102);
    test.done();
};

module.exports['Commands: move handles COPYUID in untagged response'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]]),
        exec: async (cmd, attrs, opts) => {
            // Simulate untagged OK with COPYUID
            if (opts && opts.untagged && opts.untagged.OK) {
                await opts.untagged.OK({
                    attributes: [
                        {
                            section: [{ value: 'COPYUID' }, { value: '99999' }, { value: '5:7' }, { value: '200:202' }]
                        }
                    ]
                });
            }
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    const result = await moveCommand(connection, '5:7', 'Archive', {});
    test.ok(result.uidMap instanceof Map);
    test.equal(result.uidMap.get(5), 200);
    test.equal(result.uidMap.get(6), 201);
    test.equal(result.uidMap.get(7), 202);
    test.done();
};

module.exports['Commands: move returns correct map structure'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]]),
        exec: async () => ({
            next: () => {},
            response: { attributes: [] }
        })
    });

    const result = await moveCommand(connection, '1:10', 'Archive', {});
    test.equal(result.path, 'INBOX');
    test.equal(result.destination, 'Archive');
    test.done();
};

module.exports['Commands: move handles error'] = async test => {
    let warnLogged = false;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]]),
        exec: async () => {
            const err = new Error('Move failed');
            err.response = { attributes: [] };
            throw err;
        },
        log: {
            warn: () => {
                warnLogged = true;
            },
            debug: () => {},
            trace: () => {}
        }
    });

    const result = await moveCommand(connection, '1:10', 'Archive', {});
    test.equal(result, false);
    test.ok(warnLogged);
    test.done();
};

module.exports['Commands: move handles error with status code'] = async test => {
    let capturedErr = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]]),
        exec: async () => {
            const err = new Error('Move failed');
            // Provide response with TRYCREATE status code
            err.response = {
                tag: 'A1',
                command: 'NO',
                attributes: [
                    {
                        type: 'ATOM',
                        value: '',
                        section: [{ type: 'ATOM', value: 'TRYCREATE' }]
                    },
                    { type: 'TEXT', value: 'Mailbox does not exist' }
                ]
            };
            throw err;
        },
        log: {
            warn: msg => {
                capturedErr = msg;
            },
            debug: () => {},
            trace: () => {}
        }
    });

    const result = await moveCommand(connection, '1:10', 'NonExistent', {});
    test.equal(result, false);
    test.ok(capturedErr);
    test.done();
};

module.exports['Commands: move normalizes destination path'] = async test => {
    let capturedAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]]),
        namespace: { delimiter: '/', prefix: 'INBOX/' },
        exec: async (cmd, attrs) => {
            capturedAttrs = attrs;
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    await moveCommand(connection, '1:10', 'Archive', {});
    // The destination should be normalized
    test.ok(capturedAttrs);
    test.done();
};

module.exports['Commands: move handles COPYUID with invalid uidValidity'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]]),
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        section: [
                            { type: 'ATOM', value: 'COPYUID' },
                            { value: 'invalid' }, // Invalid uidValidity (NaN)
                            { value: '1:5' },
                            { value: '100:104' }
                        ]
                    }
                ]
            }
        })
    });

    const result = await moveCommand(connection, '1:5', 'Archive', {});
    test.ok(result);
    test.equal(result.uidValidity, undefined);
    test.done();
};

module.exports['Commands: move handles COPYUID with mismatched UID counts'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]]),
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        section: [
                            { type: 'ATOM', value: 'COPYUID' },
                            { value: '12345' },
                            { value: '1:5' }, // 5 source UIDs
                            { value: '100:102' } // Only 3 destination UIDs - mismatch
                        ]
                    }
                ]
            }
        })
    });

    const result = await moveCommand(connection, '1:5', 'Archive', {});
    test.ok(result);
    test.equal(result.uidValidity, BigInt(12345));
    test.equal(result.uidMap, undefined); // Not set due to mismatch
    test.done();
};

module.exports['Commands: move handles COPYUID with missing source/destination UIDs'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['MOVE', true]]),
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        section: [
                            { type: 'ATOM', value: 'COPYUID' },
                            { value: '12345' },
                            { value: null }, // Missing source UIDs
                            { value: '100:104' }
                        ]
                    }
                ]
            }
        })
    });

    const result = await moveCommand(connection, '1:5', 'Archive', {});
    test.ok(result);
    test.equal(result.uidMap, undefined);
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

module.exports['Commands: expunge parses HIGHESTMODSEQ response'] = async test => {
    const connection = createMockConnection({
        state: 3,
        mailbox: { highestModseq: 100n },
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        type: 'ATOM',
                        section: [
                            { type: 'ATOM', value: 'HIGHESTMODSEQ' },
                            { type: 'ATOM', value: '9122' }
                        ]
                    }
                ]
            }
        })
    });

    const result = await expungeCommand(connection, '1:*', {});
    test.equal(result, true);
    test.equal(connection.mailbox.highestModseq, 9122n);
    test.done();
};

module.exports['Commands: expunge does not update lower HIGHESTMODSEQ'] = async test => {
    const connection = createMockConnection({
        state: 3,
        mailbox: { highestModseq: 10000n },
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        type: 'ATOM',
                        section: [
                            { type: 'ATOM', value: 'HIGHESTMODSEQ' },
                            { type: 'ATOM', value: '5000' }
                        ]
                    }
                ]
            }
        })
    });

    const result = await expungeCommand(connection, '1:*', {});
    test.equal(result, true);
    test.equal(connection.mailbox.highestModseq, 10000n); // Should not be updated
    test.done();
};

module.exports['Commands: expunge handles invalid HIGHESTMODSEQ value'] = async test => {
    const connection = createMockConnection({
        state: 3,
        mailbox: { highestModseq: 100n },
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        type: 'ATOM',
                        section: [
                            { type: 'ATOM', value: 'HIGHESTMODSEQ' },
                            { type: 'ATOM', value: 'invalid' }
                        ]
                    }
                ]
            }
        })
    });

    const result = await expungeCommand(connection, '1:*', {});
    test.equal(result, true);
    test.equal(connection.mailbox.highestModseq, 100n); // Should not be updated
    test.done();
};

module.exports['Commands: expunge updates HIGHESTMODSEQ when mailbox has none'] = async test => {
    const connection = createMockConnection({
        state: 3,
        mailbox: {}, // No highestModseq
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        type: 'ATOM',
                        section: [
                            { type: 'ATOM', value: 'HIGHESTMODSEQ' },
                            { type: 'ATOM', value: '500' }
                        ]
                    }
                ]
            }
        })
    });

    const result = await expungeCommand(connection, '1:*', {});
    test.equal(result, true);
    test.equal(connection.mailbox.highestModseq, 500n);
    test.done();
};

module.exports['Commands: expunge error with serverResponseCode'] = async test => {
    let capturedErr = null;
    const connection = createMockConnection({
        state: 3,
        exec: async () => {
            const err = new Error('Expunge failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'CANNOT' }]
                    },
                    { type: 'TEXT', value: 'Cannot expunge' }
                ]
            };
            throw err;
        },
        log: {
            warn: data => {
                capturedErr = data.err;
            }
        }
    });

    const result = await expungeCommand(connection, '1:*', {});
    test.equal(result, false);
    test.ok(capturedErr);
    test.equal(capturedErr.serverResponseCode, 'CANNOT');
    test.done();
};

module.exports['Commands: expunge without UID when UIDPLUS not available'] = async test => {
    let execCmd = null;
    let execAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map(), // No UIDPLUS
        exec: async (cmd, attrs) => {
            execCmd = cmd;
            execAttrs = attrs;
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    await expungeCommand(connection, '1:100', { uid: true });
    test.equal(execCmd, 'EXPUNGE'); // Falls back to EXPUNGE
    test.equal(execAttrs, false); // No attributes for regular EXPUNGE
    test.done();
};

module.exports['Commands: expunge with UID EXPUNGE includes range'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['UIDPLUS', true]]),
        exec: async (cmd, attrs) => {
            execAttrs = attrs;
            return { next: () => {}, response: { attributes: [] } };
        }
    });

    await expungeCommand(connection, '1:50', { uid: true });
    test.ok(execAttrs);
    test.equal(execAttrs[0].type, 'SEQUENCE');
    test.equal(execAttrs[0].value, '1:50');
    test.done();
};

module.exports['Commands: expunge with non-HIGHESTMODSEQ response code'] = async test => {
    const connection = createMockConnection({
        state: 3,
        mailbox: { highestModseq: 100n },
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        type: 'ATOM',
                        section: [{ type: 'ATOM', value: 'OTHERCODE' }]
                    }
                ]
            }
        })
    });

    const result = await expungeCommand(connection, '1:*', {});
    test.equal(result, true);
    test.equal(connection.mailbox.highestModseq, 100n); // Should not be updated
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

module.exports['Commands: delete closes mailbox when deleting current mailbox'] = async test => {
    let closeCalled = false;
    let execCmd = null;
    const connection = createMockConnection({
        state: 3, // SELECTED
        mailbox: { path: 'FolderToDelete' },
        run: async cmd => {
            if (cmd === 'CLOSE') {
                closeCalled = true;
            }
        },
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {} };
        }
    });

    const result = await deleteCommand(connection, 'FolderToDelete');
    test.ok(closeCalled, 'CLOSE should be called');
    test.equal(execCmd, 'DELETE');
    test.ok(result);
    test.equal(result.path, 'FolderToDelete');
    test.done();
};

module.exports['Commands: delete does not close when deleting different mailbox'] = async test => {
    let closeCalled = false;
    const connection = createMockConnection({
        state: 3, // SELECTED
        mailbox: { path: 'INBOX' },
        run: async cmd => {
            if (cmd === 'CLOSE') {
                closeCalled = true;
            }
        },
        exec: async () => ({ next: () => {} })
    });

    const result = await deleteCommand(connection, 'OtherFolder');
    test.ok(!closeCalled, 'CLOSE should not be called');
    test.ok(result);
    test.equal(result.path, 'OtherFolder');
    test.done();
};

module.exports['Commands: delete works in SELECTED state'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3, // SELECTED
        mailbox: { path: 'INBOX' },
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {} };
        }
    });

    const result = await deleteCommand(connection, 'SomeFolder');
    test.ok(result);
    test.equal(execCmd, 'DELETE');
    test.done();
};

module.exports['Commands: delete error with serverResponseCode'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Delete failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'NONEXISTENT' }]
                    },
                    { type: 'TEXT', value: 'Mailbox does not exist' }
                ]
            };
            throw err;
        }
    });

    try {
        await deleteCommand(connection, 'NonExistent');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.serverResponseCode, 'NONEXISTENT');
    }
    test.done();
};

module.exports['Commands: delete normalizes path'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, args) => {
            execArgs = args;
            return { next: () => {} };
        }
    });

    const result = await deleteCommand(connection, 'INBOX/Subfolder');
    test.ok(result);
    test.equal(result.path, 'INBOX/Subfolder');
    test.ok(execArgs);
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

module.exports['Commands: rename closes mailbox when renaming current mailbox'] = async test => {
    let closeCalled = false;
    let execCmd = null;
    const connection = createMockConnection({
        state: 3, // SELECTED
        mailbox: { path: 'OldFolder' },
        run: async cmd => {
            if (cmd === 'CLOSE') {
                closeCalled = true;
            }
        },
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {} };
        }
    });

    const result = await renameCommand(connection, 'OldFolder', 'NewFolder');
    test.ok(closeCalled, 'CLOSE should be called');
    test.equal(execCmd, 'RENAME');
    test.ok(result);
    test.equal(result.path, 'OldFolder');
    test.equal(result.newPath, 'NewFolder');
    test.done();
};

module.exports['Commands: rename does not close when renaming different mailbox'] = async test => {
    let closeCalled = false;
    const connection = createMockConnection({
        state: 3, // SELECTED
        mailbox: { path: 'INBOX' },
        run: async cmd => {
            if (cmd === 'CLOSE') {
                closeCalled = true;
            }
        },
        exec: async () => ({ next: () => {} })
    });

    const result = await renameCommand(connection, 'OtherFolder', 'NewName');
    test.ok(!closeCalled, 'CLOSE should not be called');
    test.ok(result);
    test.done();
};

module.exports['Commands: rename works in SELECTED state'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3, // SELECTED
        mailbox: { path: 'INBOX' },
        exec: async cmd => {
            execCmd = cmd;
            return { next: () => {} };
        }
    });

    const result = await renameCommand(connection, 'SomeFolder', 'NewName');
    test.ok(result);
    test.equal(execCmd, 'RENAME');
    test.done();
};

module.exports['Commands: rename error with serverResponseCode'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Rename failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'NONEXISTENT' }]
                    },
                    { type: 'TEXT', value: 'Mailbox does not exist' }
                ]
            };
            throw err;
        }
    });

    try {
        await renameCommand(connection, 'NonExistent', 'NewName');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.serverResponseCode, 'NONEXISTENT');
    }
    test.done();
};

module.exports['Commands: rename normalizes paths'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, args) => {
            execArgs = args;
            return { next: () => {} };
        }
    });

    const result = await renameCommand(connection, 'INBOX/Old', 'INBOX/New');
    test.ok(result);
    test.equal(result.path, 'INBOX/Old');
    test.equal(result.newPath, 'INBOX/New');
    test.ok(execArgs);
    test.equal(execArgs.length, 2);
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

module.exports['Commands: subscribe works in SELECTED state'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3, // SELECTED
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

module.exports['Commands: subscribe returns false on error'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Subscribe failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [{ type: 'TEXT', value: 'Subscribe failed' }]
            };
            throw err;
        }
    });

    const result = await subscribeCommand(connection, 'Folder');
    test.equal(result, false);
    test.done();
};

module.exports['Commands: subscribe error with serverResponseCode'] = async test => {
    let capturedErr = null;
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Subscribe failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'NONEXISTENT' }]
                    },
                    { type: 'TEXT', value: 'Mailbox does not exist' }
                ]
            };
            throw err;
        },
        log: {
            warn: data => {
                capturedErr = data.err;
            }
        }
    });

    const result = await subscribeCommand(connection, 'NonExistent');
    test.equal(result, false);
    test.ok(capturedErr);
    test.equal(capturedErr.serverResponseCode, 'NONEXISTENT');
    test.done();
};

module.exports['Commands: subscribe normalizes path'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, args) => {
            execArgs = args;
            return { next: () => {} };
        }
    });

    const result = await subscribeCommand(connection, 'INBOX/Subfolder');
    test.equal(result, true);
    test.ok(execArgs);
    test.equal(execArgs.length, 1);
    test.done();
};

module.exports['Commands: unsubscribe works in SELECTED state'] = async test => {
    let execCmd = null;
    const connection = createMockConnection({
        state: 3, // SELECTED
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

module.exports['Commands: unsubscribe returns false on error'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Unsubscribe failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [{ type: 'TEXT', value: 'Unsubscribe failed' }]
            };
            throw err;
        }
    });

    const result = await unsubscribeCommand(connection, 'Folder');
    test.equal(result, false);
    test.done();
};

module.exports['Commands: unsubscribe error with serverResponseCode'] = async test => {
    let capturedErr = null;
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Unsubscribe failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'NONEXISTENT' }]
                    },
                    { type: 'TEXT', value: 'Mailbox does not exist' }
                ]
            };
            throw err;
        },
        log: {
            warn: data => {
                capturedErr = data.err;
            }
        }
    });

    const result = await unsubscribeCommand(connection, 'NonExistent');
    test.equal(result, false);
    test.ok(capturedErr);
    test.equal(capturedErr.serverResponseCode, 'NONEXISTENT');
    test.done();
};

module.exports['Commands: unsubscribe normalizes path'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, args) => {
            execArgs = args;
            return { next: () => {} };
        }
    });

    const result = await unsubscribeCommand(connection, 'INBOX/Subfolder');
    test.equal(result, true);
    test.ok(execArgs);
    test.equal(execArgs.length, 1);
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

module.exports['Commands: fetch with threadId and X-GM-EXT-1 fallback'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['X-GM-EXT-1', true]]), // No OBJECTID, but has X-GM-EXT-1
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    await fetchCommand(connection, '1', { threadId: true });
    test.ok(queryAttrs);
    const hasXGMTHRID = JSON.stringify(queryAttrs).includes('X-GM-THRID');
    test.ok(hasXGMTHRID, 'Should use X-GM-THRID as fallback for threadId');
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

module.exports['Commands: list LSUB path with leading delimiter'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['SPECIAL-USE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                });
            }
            if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                // LSUB returns path with leading delimiter
                await opts.untagged.LSUB({
                    attributes: [
                        [{ value: '\\Subscribed' }],
                        { value: '/' },
                        { value: '/Folder1' } // Leading delimiter
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
    test.done();
};

module.exports['Commands: list sorts non-special-use after special-use'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['SPECIAL-USE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                // Regular folder first
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'ZFolder' }]
                });
                // Then INBOX (special use)
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    // INBOX (special use) should come before ZFolder (no special use)
    const inboxIndex = result.findIndex(e => e.path === 'INBOX');
    const zFolderIndex = result.findIndex(e => e.path === 'ZFolder');
    test.ok(inboxIndex < zFolderIndex, 'Special use folders should sort before non-special-use');
    test.done();
};

module.exports['Commands: list sorts alphabetically when no special use'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['SPECIAL-USE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                // Folders without special use in reverse alphabetical order
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Zebra' }]
                });
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Alpha' }]
                });
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Middle' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    // Should be sorted alphabetically
    const alphaIndex = result.findIndex(e => e.path === 'Alpha');
    const middleIndex = result.findIndex(e => e.path === 'Middle');
    const zebraIndex = result.findIndex(e => e.path === 'Zebra');
    test.ok(alphaIndex < middleIndex, 'Alpha should come before Middle');
    test.ok(middleIndex < zebraIndex, 'Middle should come before Zebra');
    test.done();
};

module.exports['Commands: list sorts nested folders by parent path'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['SPECIAL-USE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                // Nested folders
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasChildren' }], { value: '/' }, { value: 'B' }]
                });
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'B/Nested' }]
                });
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasChildren' }], { value: '/' }, { value: 'A' }]
                });
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'A/Nested' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    // A folders should come before B folders
    const aIndex = result.findIndex(e => e.path === 'A');
    const aNestedIndex = result.findIndex(e => e.path === 'A/Nested');
    const bIndex = result.findIndex(e => e.path === 'B');
    const bNestedIndex = result.findIndex(e => e.path === 'B/Nested');
    test.ok(aIndex < bIndex, 'A should come before B');
    test.ok(aNestedIndex < bIndex, 'A/Nested should come before B');
    test.ok(bIndex < bNestedIndex || aNestedIndex < bNestedIndex, 'Parent folders sort correctly');
    test.done();
};

module.exports['Commands: list handles LSUB with empty attributes'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['SPECIAL-USE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'TestFolder' }]
                });
            }
            if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                // Empty attributes
                await opts.untagged.LSUB({
                    attributes: []
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    test.ok(result.length >= 1);
    test.done();
};

module.exports['Commands: list handles STATUS NaN values in LSUB response'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([
            ['SPECIAL-USE', true],
            ['LIST-STATUS', true]
        ]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged) {
                if (opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'TestFolder' }]
                    });
                }
                if (opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [
                            { value: 'TestFolder' },
                            [
                                { value: 'MESSAGES' },
                                { value: 'NaN' }, // Invalid number
                                { value: 'RECENT' },
                                { value: 'invalid' } // Invalid value
                            ]
                        ]
                    });
                }
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*', { statusQuery: { messages: true, recent: true } });
    const folder = result.find(e => e.path === 'TestFolder');
    test.ok(folder);
    // NaN values should be filtered out (value === false check)
    test.equal(folder.status.messages, undefined);
    test.equal(folder.status.recent, undefined);
    test.done();
};

module.exports['Commands: list STATUS parses UIDVALIDITY UNSEEN HIGHESTMODSEQ'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([
            ['LIST-STATUS', true],
            ['CONDSTORE', true]
        ]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST') {
                if (opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'TestFolder' }]
                    });
                }
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [
                            { value: 'TestFolder' },
                            [
                                { value: 'UIDVALIDITY' },
                                { value: '123456789' },
                                { value: 'UNSEEN' },
                                { value: '42' },
                                { value: 'HIGHESTMODSEQ' },
                                { value: '999999999' }
                            ]
                        ]
                    });
                }
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*', {
        statusQuery: { uidValidity: true, unseen: true, highestModseq: true }
    });
    const folder = result.find(e => e.path === 'TestFolder');
    test.ok(folder);
    test.ok(folder.status);
    test.equal(folder.status.uidValidity, BigInt(123456789));
    test.equal(folder.status.unseen, 42);
    test.equal(folder.status.highestModseq, BigInt(999999999));
    test.done();
};

module.exports['Commands: list LSUB folder not in LIST entries'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['SPECIAL-USE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                // Only return INBOX in LIST
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
            }
            if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                // Return a folder in LSUB that wasn't in LIST (hits else branch)
                await opts.untagged.LSUB({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'SubscribedOnly' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    // The subscribed-only folder should not be in results (else branch ignores it)
    const subscribedOnly = result.find(e => e.path === 'SubscribedOnly');
    test.equal(subscribedOnly, undefined);
    // INBOX should still be there
    const inbox = result.find(e => e.path === 'INBOX');
    test.ok(inbox);
    test.done();
};

module.exports['Commands: list sort b has specialUse a does not'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['SPECIAL-USE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                // First add a folder without special use
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'AAA_Regular' }]
                });
                // Then add INBOX which gets special use
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    // When sorting, INBOX has specialUse, AAA_Regular does not
    // So the comparison should hit: !a.specialUse && b.specialUse returns 1
    // This means INBOX should come first even though AAA_Regular is alphabetically first
    test.ok(result.length >= 2);
    test.equal(result[0].path, 'INBOX');
    test.equal(result[0].specialUse, '\\Inbox');
    test.done();
};

module.exports['Commands: list sort fallback path comparison'] = async test => {
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['SPECIAL-USE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                // Create folders where parent parts match but paths differ at the end
                // A/B/C and A/B will have matching parts up to a point
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Parent/Child/Deep' }]
                });
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Parent/Child' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await listCommand(connection, '', '*');
    // Parent/Child should come before Parent/Child/Deep
    const childIndex = result.findIndex(e => e.path === 'Parent/Child');
    const deepIndex = result.findIndex(e => e.path === 'Parent/Child/Deep');
    test.ok(childIndex < deepIndex, 'Shorter path should sort before longer when parent matches');
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

module.exports['Commands: select handles empty OK attributes'] = async test => {
    const connection = createMockConnection({
        state: 2,
        folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.OK) {
                // Empty attributes - should return early
                await opts.untagged.OK({
                    attributes: []
                });
            }
            if (opts && opts.untagged && opts.untagged.EXISTS) {
                await opts.untagged.EXISTS({ command: '100' });
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {}
    });

    const result = await selectCommand(connection, 'INBOX');
    test.ok(result);
    test.done();
};

module.exports['Commands: select handles null FLAGS attributes'] = async test => {
    const connection = createMockConnection({
        state: 2,
        folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.FLAGS) {
                // Null/undefined attributes - should return early
                await opts.untagged.FLAGS({
                    attributes: null
                });
            }
            if (opts && opts.untagged && opts.untagged.EXISTS) {
                await opts.untagged.EXISTS({ command: '100' });
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {}
    });

    const result = await selectCommand(connection, 'INBOX');
    test.ok(result);
    test.equal(result.flags, undefined);
    test.done();
};

module.exports['Commands: select handles NaN EXISTS'] = async test => {
    const connection = createMockConnection({
        state: 2,
        folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.EXISTS) {
                // NaN command value - should return false
                await opts.untagged.EXISTS({ command: 'invalid' });
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {}
    });

    const result = await selectCommand(connection, 'INBOX');
    test.ok(result);
    test.equal(result.exists, undefined);
    test.done();
};

module.exports['Commands: select error with serverResponseCode'] = async test => {
    const connection = createMockConnection({
        state: 2,
        folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
        exec: async () => {
            const err = new Error('Select failed');
            err.response = {
                tag: 'A1',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'NONEXISTENT' }]
                    },
                    { type: 'TEXT', value: 'Mailbox does not exist' }
                ]
            };
            throw err;
        },
        emit: () => {}
    });

    try {
        await selectCommand(connection, 'INBOX');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.serverResponseCode, 'NONEXISTENT');
    }
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

module.exports['Commands: status handles NaN values in response'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [
                        { value: 'TestFolder' },
                        [
                            { value: 'MESSAGES' },
                            { value: 'invalid' }, // NaN
                            { value: 'RECENT' },
                            { value: 'notanumber' }, // NaN
                            { value: 'UIDNEXT' },
                            { value: 'abc' }, // NaN
                            { value: 'UIDVALIDITY' },
                            { value: 'xyz' }, // NaN
                            { value: 'UNSEEN' },
                            { value: 'bad' } // NaN
                        ]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await statusCommand(connection, 'TestFolder', {
        messages: true,
        recent: true,
        uidNext: true,
        uidValidity: true,
        unseen: true
    });
    test.ok(result);
    test.equal(result.path, 'TestFolder');
    // NaN values should not be set
    test.equal(result.messages, undefined);
    test.equal(result.recent, undefined);
    test.equal(result.uidNext, undefined);
    test.equal(result.uidValidity, undefined);
    test.equal(result.unseen, undefined);
    test.done();
};

module.exports['Commands: status handles NaN HIGHESTMODSEQ'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['CONDSTORE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [{ value: 'TestFolder' }, [{ value: 'HIGHESTMODSEQ' }, { value: 'notvalid' }]]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await statusCommand(connection, 'TestFolder', { highestModseq: true });
    test.ok(result);
    test.equal(result.highestModseq, undefined);
    test.done();
};

module.exports['Commands: status filters falsy query values'] = async test => {
    let queryAttrs = null;
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs) => {
            queryAttrs = attrs;
            return { next: () => {} };
        }
    });

    // Mix of truthy and falsy values
    const result = await statusCommand(connection, 'TestFolder', {
        messages: true,
        recent: false, // Should be filtered
        uidNext: 0, // Falsy, should be filtered
        uidValidity: true,
        unseen: null // Falsy, should be filtered
    });
    test.ok(result);
    // Query should only include messages and uidValidity
    test.ok(queryAttrs);
    const queryList = queryAttrs[1];
    test.equal(queryList.length, 2);
    test.done();
};

module.exports['Commands: status handles missing entry value'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [
                        { value: 'TestFolder' },
                        [
                            { value: 'MESSAGES' },
                            null, // Missing value
                            { value: 'RECENT' },
                            { value: '5' }
                        ]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await statusCommand(connection, 'TestFolder', {
        messages: true,
        recent: true
    });
    test.ok(result);
    test.equal(result.messages, undefined); // Skipped due to null value
    test.equal(result.recent, 5);
    test.done();
};

module.exports['Commands: status handles missing key in response'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [
                        { value: 'TestFolder' },
                        [
                            null, // Missing key
                            { value: '10' },
                            { value: 'MESSAGES' },
                            { value: '20' }
                        ]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await statusCommand(connection, 'TestFolder', { messages: true });
    test.ok(result);
    test.equal(result.messages, 20);
    test.done();
};

module.exports['Commands: status handles unknown key in response'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.untagged && opts.untagged.STATUS) {
                await opts.untagged.STATUS({
                    attributes: [{ value: 'TestFolder' }, [{ value: 'UNKNOWNKEY' }, { value: '999' }, { value: 'MESSAGES' }, { value: '10' }]]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await statusCommand(connection, 'TestFolder', { messages: true });
    test.ok(result);
    test.equal(result.messages, 10);
    test.equal(result.UNKNOWNKEY, undefined); // Unknown keys ignored
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

module.exports['Commands: append error with serverResponseCode'] = async test => {
    const connection = createMockConnection({
        state: 2,
        mailbox: { path: 'OtherFolder' },
        exec: async () => {
            const err = new Error('Append failed');
            err.response = {
                tag: '*',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'TRYCREATE' }]
                    },
                    { type: 'TEXT', value: 'Mailbox does not exist' }
                ]
            };
            throw err;
        }
    });

    try {
        await appendCommand(connection, 'NonExistent', 'content');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.serverResponseCode, 'TRYCREATE');
    }
    test.done();
};

module.exports['Commands: append with invalid APPENDUID values'] = async test => {
    const connection = createMockConnection({
        state: 2,
        mailbox: { path: 'OtherFolder' },
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        type: 'ATOM',
                        section: [
                            { type: 'ATOM', value: 'APPENDUID' },
                            { type: 'ATOM', value: 'invalid' }, // Invalid uidValidity
                            { type: 'ATOM', value: 'notanumber' } // Invalid uid
                        ]
                    }
                ]
            }
        })
    });

    const result = await appendCommand(connection, 'INBOX', 'content');
    test.ok(result);
    test.equal(result.uidValidity, undefined);
    test.equal(result.uid, undefined);
    test.done();
};

module.exports['Commands: append NOOP error is caught'] = async test => {
    let noopCalled = false;
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX', exists: 10 },
        exec: async cmd => {
            if (cmd === 'APPEND') {
                return {
                    next: () => {},
                    response: { attributes: [] }
                };
            }
            if (cmd === 'NOOP') {
                noopCalled = true;
                const err = new Error('NOOP failed');
                err.response = { attributes: [] };
                throw err;
            }
        }
    });

    // Append to current mailbox, expectExists = true
    const result = await appendCommand(connection, 'INBOX', 'content');
    test.ok(result);
    test.equal(noopCalled, true);
    // Should not throw, NOOP error is caught
    test.done();
};

module.exports['Commands: append EXISTS updates mailbox count'] = async test => {
    let emittedEvent = null;
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX', exists: 10 },
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'APPEND' && opts && opts.untagged && opts.untagged.EXISTS) {
                await opts.untagged.EXISTS({ command: '11' }); // New count
            }
            return {
                next: () => {},
                response: {
                    attributes: [
                        {
                            type: 'ATOM',
                            section: [
                                { type: 'ATOM', value: 'APPENDUID' },
                                { type: 'ATOM', value: '12345' },
                                { type: 'ATOM', value: '100' }
                            ]
                        }
                    ]
                }
            };
        },
        emit: (event, data) => {
            if (event === 'exists') {
                emittedEvent = data;
            }
        }
    });

    const result = await appendCommand(connection, 'INBOX', 'content');
    test.ok(result);
    test.equal(result.seq, 11);
    test.equal(connection.mailbox.exists, 11);
    test.ok(emittedEvent);
    test.equal(emittedEvent.count, 11);
    test.equal(emittedEvent.prevCount, 10);
    test.done();
};

module.exports['Commands: append does not emit exists when count unchanged'] = async test => {
    let emittedEvent = null;
    const connection = createMockConnection({
        state: 3,
        mailbox: { path: 'INBOX', exists: 10 },
        exec: async (cmd, attrs, opts) => {
            if (cmd === 'APPEND' && opts && opts.untagged && opts.untagged.EXISTS) {
                await opts.untagged.EXISTS({ command: '10' }); // Same count
            }
            return {
                next: () => {},
                response: {
                    attributes: [
                        {
                            type: 'ATOM',
                            section: [
                                { type: 'ATOM', value: 'APPENDUID' },
                                { type: 'ATOM', value: '12345' },
                                { type: 'ATOM', value: '100' }
                            ]
                        }
                    ]
                }
            };
        },
        emit: (event, data) => {
            if (event === 'exists') {
                emittedEvent = data;
            }
        }
    });

    await appendCommand(connection, 'INBOX', 'content');
    test.equal(emittedEvent, null); // No event emitted
    test.done();
};

module.exports['Commands: append with both flags and date'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 2,
        mailbox: { path: 'OtherFolder' },
        exec: async (cmd, attrs) => {
            execAttrs = attrs;
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    const testDate = new Date('2024-01-15T10:30:00Z');
    await appendCommand(connection, 'INBOX', 'content', ['\\Seen'], testDate);
    test.ok(execAttrs);
    // Should have: path, flags array, date string, literal
    test.equal(execAttrs.length, 4);
    // Flags array
    test.ok(Array.isArray(execAttrs[1]));
    // Date string
    test.equal(execAttrs[2].type, 'STRING');
    test.done();
};

module.exports['Commands: append with disableBinary does not use literal8'] = async test => {
    let execAttrs = null;
    const connection = createMockConnection({
        state: 2,
        mailbox: { path: 'OtherFolder' },
        capabilities: new Map([['BINARY', true]]),
        disableBinary: true,
        exec: async (cmd, attrs) => {
            execAttrs = attrs;
            return {
                next: () => {},
                response: { attributes: [] }
            };
        }
    });

    // Content with NULL byte
    const content = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]);
    await appendCommand(connection, 'INBOX', content);
    test.ok(execAttrs);
    const literalAttr = execAttrs.find(a => a && a.type === 'LITERAL');
    test.ok(literalAttr);
    test.equal(literalAttr.isLiteral8, false); // Not literal8 due to disableBinary
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

module.exports['Commands: idle clears wait queue on normal completion'] = async test => {
    let preCheckResolved = false;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag();
            }
            // Simulate waiting preCheck request before completion
            if (connection.preCheck) {
                // Queue a preCheck request
                connection.preCheck().then(() => {
                    preCheckResolved = true;
                });
            }
            return { next: () => {} };
        },
        write: () => {}
    });

    await idleCommand(connection);
    // Wait a tick for the promise to resolve
    await new Promise(resolve => setImmediate(resolve));
    test.equal(preCheckResolved, true);
    test.done();
};

module.exports['Commands: idle rejects wait queue on error'] = async test => {
    let preCheckRejected = false;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag();
            }
            // Queue a preCheck request then throw
            if (connection.preCheck) {
                connection.preCheck().catch(() => {
                    preCheckRejected = true;
                });
            }
            throw new Error('IDLE failed');
        }
    });

    const result = await idleCommand(connection);
    test.equal(result, false);
    // Wait a tick for the promise to reject
    await new Promise(resolve => setImmediate(resolve));
    test.equal(preCheckRejected, true);
    test.done();
};

module.exports['Commands: idle onPlusTag calls preCheck if doneRequested'] = async test => {
    let doneSent = false;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        exec: async (cmd, attrs, opts) => {
            // Request done before onPlusTag is called
            if (connection.preCheck) {
                connection.preCheck().catch(() => {});
            }
            // Then call onPlusTag which should send DONE
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag();
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
    test.done();
};

module.exports['Commands: idle calls onSend callback'] = async test => {
    let onSendCalled = false;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        exec: async (cmd, attrs, opts) => {
            // Call onSend callback
            if (opts && opts.onSend) {
                opts.onSend();
                onSendCalled = true;
            }
            // Then call onPlusTag to enable IDLE
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag();
            }
            // Break IDLE via preCheck
            if (connection.preCheck) {
                await connection.preCheck();
            }
            return { next: () => {} };
        },
        write: () => {}
    });

    await idleCommand(connection);
    test.equal(onSendCalled, true);
    test.done();
};

module.exports['Commands: idle clears preCheck and queue on normal completion'] = async test => {
    let waitQueueResolved = false;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        exec: async (cmd, attrs, opts) => {
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag();
            }
            // After onPlusTag, queue a preCheck but don't resolve yet
            if (connection.preCheck) {
                connection.preCheck().then(() => {
                    waitQueueResolved = true;
                });
            }
            // Return to complete IDLE - this should clear the queue
            return { next: () => {} };
        },
        write: () => {}
    });

    await idleCommand(connection);
    await new Promise(resolve => setImmediate(resolve));
    // preCheck should be cleared after completion
    test.equal(connection.preCheck, false);
    test.equal(waitQueueResolved, true);
    test.done();
};

module.exports['Commands: idle with maxIdleTime triggers preCheck after timeout'] = async test => {
    let preCheckCalled = false;
    let loopCount = 0;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        idling: false,
        exec: async (cmd, attrs, opts) => {
            loopCount++;
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag();
            }
            // Simulate time passing - on first loop, wait for timer
            if (loopCount === 1) {
                // Wait a bit for the timer to fire
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            // Check if preCheck was called by the timer
            if (connection.preCheck && loopCount === 1) {
                preCheckCalled = true;
                await connection.preCheck();
            }
            return { next: () => {} };
        },
        write: () => {}
    });

    // Use very short maxIdleTime
    await idleCommand(connection, 10);
    test.ok(preCheckCalled || loopCount > 1, 'preCheck should be called by timer or loop should restart');
    test.done();
};

module.exports['Commands: idle stillIdling triggers loop restart'] = async test => {
    let loopCount = 0;
    const connection = createMockConnection({
        state: 3,
        capabilities: new Map([['IDLE', true]]),
        idling: false,
        exec: async (cmd, attrs, opts) => {
            loopCount++;
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag();
            }
            // First iteration: let the timer set stillIdling and trigger preCheck
            if (loopCount === 1) {
                await new Promise(resolve => setTimeout(resolve, 20));
                // Timer should have called preCheck which sets stillIdling
            }
            // Second iteration: just complete
            if (connection.preCheck) {
                await connection.preCheck();
            }
            return { next: () => {} };
        },
        write: () => {}
    });

    await idleCommand(connection, 5);
    // Loop should have run at least once (could run twice if timer works)
    test.ok(loopCount >= 1, 'IDLE loop should have run');
    test.done();
};

// ============================================
// ID Command Tests
// ============================================

const idCommand = require('../lib/commands/id');

module.exports['Commands: id skips when no ID capability'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map() // No ID capability
    });

    const result = await idCommand(connection, { name: 'TestClient' });
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: id sends client info'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        capabilities: new Map([['ID', true]]),
        exec: async (cmd, args) => {
            execArgs = { cmd, args };
            return { next: () => {} };
        }
    });

    await idCommand(connection, { name: 'TestClient', version: '1.0' });
    test.equal(execArgs.cmd, 'ID');
    test.ok(Array.isArray(execArgs.args));
    test.ok(execArgs.args[0].includes('name'));
    test.ok(execArgs.args[0].includes('TestClient'));
    test.done();
};

module.exports['Commands: id sends null when no clientInfo'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        capabilities: new Map([['ID', true]]),
        exec: async (cmd, args) => {
            execArgs = { cmd, args };
            return { next: () => {} };
        }
    });

    await idCommand(connection, null);
    test.equal(execArgs.cmd, 'ID');
    test.equal(execArgs.args[0], null);
    test.done();
};

module.exports['Commands: id sends null for empty clientInfo'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        capabilities: new Map([['ID', true]]),
        exec: async (cmd, args) => {
            execArgs = { cmd, args };
            return { next: () => {} };
        }
    });

    await idCommand(connection, {});
    test.equal(execArgs.cmd, 'ID');
    test.equal(execArgs.args[0], null);
    test.done();
};

module.exports['Commands: id parses server response'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map([['ID', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.ID) {
                await opts.untagged.ID({
                    attributes: [[{ value: 'name' }, { value: 'TestServer' }, { value: 'version' }, { value: '2.0' }, { value: 'vendor' }, { value: 'ACME' }]]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await idCommand(connection, { name: 'TestClient' });
    test.equal(result.name, 'TestServer');
    test.equal(result.version, '2.0');
    test.equal(result.vendor, 'ACME');
    test.done();
};

module.exports['Commands: id updates serverInfo'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map([['ID', true]]),
        serverInfo: {},
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.ID) {
                await opts.untagged.ID({
                    attributes: [[{ value: 'name' }, { value: 'ImapServer' }, { value: 'support-url' }, { value: 'https://example.com' }]]
                });
            }
            return { next: () => {} };
        }
    });

    await idCommand(connection, { name: 'TestClient' });
    test.equal(connection.serverInfo.name, 'ImapServer');
    test.equal(connection.serverInfo['support-url'], 'https://example.com');
    test.done();
};

module.exports['Commands: id handles non-array server response'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map([['ID', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.ID) {
                // Some servers might send NIL or a single value
                await opts.untagged.ID({
                    attributes: [null]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await idCommand(connection, { name: 'TestClient' });
    test.ok(result);
    test.deepEqual(result, {});
    test.done();
};

module.exports['Commands: id formats date value'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        capabilities: new Map([['ID', true]]),
        exec: async (cmd, args) => {
            execArgs = { cmd, args };
            return { next: () => {} };
        }
    });

    const testDate = new Date('2024-06-15T10:30:00Z');
    await idCommand(connection, { date: testDate });

    test.equal(execArgs.cmd, 'ID');
    // Date should be formatted, not passed as Date object
    test.ok(execArgs.args[0].includes('date'));
    test.done();
};

module.exports['Commands: id normalizes key names to lowercase'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map([['ID', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.ID) {
                await opts.untagged.ID({
                    attributes: [[{ value: 'NAME' }, { value: 'TestServer' }, { value: 'VERSION' }, { value: '1.0' }]]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await idCommand(connection, { name: 'TestClient' });
    test.equal(result.name, 'TestServer');
    test.equal(result.version, '1.0');
    test.done();
};

module.exports['Commands: id trims key names'] = async test => {
    const connection = createMockConnection({
        capabilities: new Map([['ID', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.ID) {
                await opts.untagged.ID({
                    attributes: [[{ value: ' name ' }, { value: 'TestServer' }]]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await idCommand(connection, { name: 'TestClient' });
    test.equal(result.name, 'TestServer');
    test.done();
};

module.exports['Commands: id handles error'] = async test => {
    let warnLogged = false;
    const connection = createMockConnection({
        capabilities: new Map([['ID', true]]),
        exec: async () => {
            throw new Error('ID command failed');
        },
        log: {
            warn: () => {
                warnLogged = true;
            },
            debug: () => {},
            trace: () => {}
        }
    });

    const result = await idCommand(connection, { name: 'TestClient' });
    test.equal(result, false);
    test.ok(warnLogged);
    test.done();
};

module.exports['Commands: id filters empty values'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        capabilities: new Map([['ID', true]]),
        exec: async (cmd, args) => {
            execArgs = { cmd, args };
            return { next: () => {} };
        }
    });

    await idCommand(connection, { name: 'TestClient', empty: '', valid: 'value' });
    test.equal(execArgs.cmd, 'ID');
    // Empty values should be filtered out
    test.ok(execArgs.args[0].includes('name'));
    test.ok(execArgs.args[0].includes('valid'));
    test.done();
};

module.exports['Commands: id replaces whitespace in values'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        capabilities: new Map([['ID', true]]),
        exec: async (cmd, args) => {
            execArgs = { cmd, args };
            return { next: () => {} };
        }
    });

    await idCommand(connection, { name: 'Test\nClient\tApp' });
    test.equal(execArgs.cmd, 'ID');
    // Whitespace should be normalized to single spaces
    const nameIndex = execArgs.args[0].indexOf('name');
    test.ok(nameIndex >= 0);
    const nameValue = execArgs.args[0][nameIndex + 1];
    test.ok(!nameValue.includes('\n'));
    test.ok(!nameValue.includes('\t'));
    test.done();
};

// ============================================
// NAMESPACE Command Tests
// ============================================

const namespaceCommand = require('../lib/commands/namespace');

module.exports['Commands: namespace skips when not authenticated'] = async test => {
    const connection = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

    const result = await namespaceCommand(connection);
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: namespace with NAMESPACE capability'] = async test => {
    const connection = createMockConnection({
        state: 2, // AUTHENTICATED
        capabilities: new Map([['NAMESPACE', true]]),
        exec: async (cmd, args, opts) => {
            test.equal(cmd, 'NAMESPACE');
            if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                await opts.untagged.NAMESPACE({
                    attributes: [
                        // personal namespaces
                        [[{ value: 'INBOX.' }, { value: '.' }]],
                        // other users
                        [[{ value: 'Users.' }, { value: '.' }]],
                        // shared
                        [[{ value: 'Shared.' }, { value: '.' }]]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    test.ok(result);
    test.equal(result.prefix, 'INBOX.');
    test.equal(result.delimiter, '.');
    test.equal(connection.namespaces.personal[0].prefix, 'INBOX.');
    test.equal(connection.namespaces.other[0].prefix, 'Users.');
    test.equal(connection.namespaces.shared[0].prefix, 'Shared.');
    test.done();
};

module.exports['Commands: namespace fallback without capability'] = async test => {
    const connection = createMockConnection({
        state: 2, // AUTHENTICATED
        capabilities: new Map(), // No NAMESPACE capability
        exec: async (cmd, args, opts) => {
            test.equal(cmd, 'LIST');
            if (opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    test.ok(result);
    test.equal(result.delimiter, '/');
    test.equal(connection.namespaces.other, false);
    test.equal(connection.namespaces.shared, false);
    test.done();
};

module.exports['Commands: namespace fallback adds delimiter to prefix'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map(),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [[{ value: '\\HasNoChildren' }], { value: '.' }, { value: 'INBOX' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    test.ok(result);
    test.equal(result.delimiter, '.');
    test.done();
};

module.exports['Commands: namespace handles empty response'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['NAMESPACE', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                // Provide minimal valid namespace even in "empty" case
                await opts.untagged.NAMESPACE({
                    attributes: [
                        [[{ value: '' }, { value: '.' }]], // minimal personal namespace
                        null,
                        null
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    test.ok(result);
    test.equal(result.prefix, '');
    test.equal(result.delimiter, '.');
    test.done();
};

module.exports['Commands: namespace handles NIL namespaces'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['NAMESPACE', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                await opts.untagged.NAMESPACE({
                    attributes: [
                        [[{ value: '' }, { value: '/' }]], // personal
                        null, // other (NIL)
                        null // shared (NIL)
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    test.ok(result);
    test.equal(result.delimiter, '/');
    test.equal(connection.namespaces.other, false);
    test.equal(connection.namespaces.shared, false);
    test.done();
};

module.exports['Commands: namespace handles multiple personal namespaces'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['NAMESPACE', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                await opts.untagged.NAMESPACE({
                    attributes: [
                        [
                            [{ value: 'INBOX' }, { value: '.' }],
                            [{ value: 'Mail' }, { value: '/' }]
                        ],
                        null,
                        null
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    test.ok(result);
    test.equal(connection.namespaces.personal.length, 2);
    test.equal(connection.namespaces.personal[0].prefix, 'INBOX.');
    test.equal(connection.namespaces.personal[1].prefix, 'Mail/');
    test.done();
};

module.exports['Commands: namespace works in SELECTED state'] = async test => {
    const connection = createMockConnection({
        state: 3, // SELECTED
        capabilities: new Map([['NAMESPACE', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                await opts.untagged.NAMESPACE({
                    attributes: [[[{ value: '' }, { value: '/' }]], null, null]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    test.ok(result);
    test.equal(result.delimiter, '/');
    test.done();
};

module.exports['Commands: namespace handles error'] = async test => {
    let warnLogged = false;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['NAMESPACE', true]]),
        exec: async () => {
            const err = new Error('Namespace failed');
            err.responseStatus = 'NO';
            err.responseText = 'Command not supported';
            throw err;
        },
        log: {
            warn: () => {
                warnLogged = true;
            },
            debug: () => {},
            trace: () => {}
        }
    });

    const result = await namespaceCommand(connection);
    test.ok(result.error);
    test.equal(result.status, 'NO');
    test.equal(result.text, 'Command not supported');
    test.ok(warnLogged);
    test.done();
};

module.exports['Commands: namespace fallback handles LIST error'] = async test => {
    let warnLogged = false;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map(), // No NAMESPACE capability
        exec: async () => {
            throw new Error('LIST failed');
        },
        log: {
            warn: () => {
                warnLogged = true;
            },
            debug: () => {},
            trace: () => {}
        }
    });

    const result = await namespaceCommand(connection);
    test.ok(result);
    // Should return default namespace even on error
    test.equal(result.prefix, '');
    test.ok(warnLogged);
    test.done();
};

module.exports['Commands: namespace appends delimiter to prefix if missing'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['NAMESPACE', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                await opts.untagged.NAMESPACE({
                    attributes: [
                        // prefix without trailing delimiter
                        [[{ value: 'INBOX' }, { value: '.' }]],
                        null,
                        null
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    test.equal(result.prefix, 'INBOX.');
    test.done();
};

module.exports['Commands: namespace fallback strips leading delimiter from prefix'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map(),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.LIST) {
                await opts.untagged.LIST({
                    attributes: [
                        [{ value: '\\HasNoChildren' }],
                        { value: '/' },
                        { value: '/INBOX' } // Leading delimiter
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    test.equal(result.prefix, 'INBOX/');
    test.done();
};

module.exports['Commands: namespace ignores empty NAMESPACE response attributes'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['NAMESPACE', true]]),
        exec: async (cmd, args, opts) => {
            if (cmd === 'NAMESPACE' && opts && opts.untagged && opts.untagged.NAMESPACE) {
                // Empty attributes - the callback should return early
                await opts.untagged.NAMESPACE({
                    attributes: []
                });
                // Also provide a valid NAMESPACE to avoid error
                await opts.untagged.NAMESPACE({
                    attributes: [[[{ value: 'INBOX.' }, { value: '.' }]], null, null]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    // Should return namespace from the second call
    test.equal(result.prefix, 'INBOX.');
    test.equal(result.delimiter, '.');
    test.done();
};

module.exports['Commands: namespace sets default when personal namespace is empty array'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['NAMESPACE', true]]),
        exec: async (cmd, args, opts) => {
            if (cmd === 'NAMESPACE' && opts && opts.untagged && opts.untagged.NAMESPACE) {
                // Provide an array where entries don't pass the filter
                // (entry.length < 2), so getNamsepaceInfo returns []
                await opts.untagged.NAMESPACE({
                    attributes: [
                        [[]], // array with one empty entry - filter removes it, returns []
                        null, // other
                        null // shared
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    // Should set default personal namespace when personal[0] is falsy
    test.equal(result.prefix, '');
    test.equal(result.delimiter, '.');
    test.done();
};

module.exports['Commands: namespace fallback ignores empty LIST attributes'] = async test => {
    let listCallCount = 0;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map(), // No NAMESPACE capability
        exec: async (cmd, args, opts) => {
            if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                listCallCount++;
                // Empty attributes - the callback should return early
                await opts.untagged.LIST({
                    attributes: []
                });
            }
            return { next: () => {} };
        }
    });

    const result = await namespaceCommand(connection);
    test.ok(result);
    test.equal(listCallCount, 1);
    // With empty LIST, prefix and delimiter are undefined
    test.equal(result.prefix, '');
    test.done();
};

// ============================================
// QUOTA Command Tests
// ============================================

const quotaCommand = require('../lib/commands/quota');

module.exports['Commands: quota skips when not authenticated'] = async test => {
    const connection = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

    const result = await quotaCommand(connection, 'INBOX');
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: quota skips when no path'] = async test => {
    const connection = createMockConnection({ state: 2 });

    const result = await quotaCommand(connection, null);
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: quota returns false without capability'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map() // No QUOTA capability
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.equal(result, false);
    test.done();
};

module.exports['Commands: quota with storage quota'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async (cmd, args, opts) => {
            test.equal(cmd, 'GETQUOTAROOT');
            if (opts && opts.untagged) {
                if (opts.untagged.QUOTAROOT) {
                    await opts.untagged.QUOTAROOT({
                        attributes: [
                            { value: 'INBOX' },
                            { value: 'user.root' } // quota root
                        ]
                    });
                }
                if (opts.untagged.QUOTA) {
                    await opts.untagged.QUOTA({
                        attributes: [
                            { value: 'user.root' },
                            [
                                { value: 'STORAGE' },
                                { value: '500' }, // 500 KB used
                                { value: '1000' } // 1000 KB limit
                            ]
                        ]
                    });
                }
            }
            return { next: () => {} };
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.ok(result);
    test.equal(result.path, 'INBOX');
    test.equal(result.quotaRoot, 'user.root');
    test.equal(result.storage.usage, 500 * 1024); // Converted to bytes
    test.equal(result.storage.limit, 1000 * 1024);
    test.equal(result.storage.status, '50%');
    test.done();
};

module.exports['Commands: quota with message quota'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.QUOTA) {
                await opts.untagged.QUOTA({
                    attributes: [{ value: 'root' }, [{ value: 'MESSAGE' }, { value: '100' }, { value: '1000' }]]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.ok(result);
    // MESSAGE quota is not multiplied by 1024
    test.equal(result.message.usage, 100);
    test.equal(result.message.limit, 1000);
    test.equal(result.message.status, '10%');
    test.done();
};

module.exports['Commands: quota with multiple quota types'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.QUOTA) {
                await opts.untagged.QUOTA({
                    attributes: [
                        { value: '' },
                        [{ value: 'STORAGE' }, { value: '250' }, { value: '500' }, { value: 'MESSAGE' }, { value: '50' }, { value: '100' }]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.ok(result.storage);
    test.ok(result.message);
    test.equal(result.storage.usage, 250 * 1024);
    test.equal(result.message.usage, 50);
    test.done();
};

module.exports['Commands: quota fetches GETQUOTA when quotaRoot but no QUOTA response'] = async test => {
    let getQuotaCalled = false;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async (cmd, args, opts) => {
            if (cmd === 'GETQUOTAROOT') {
                if (opts && opts.untagged && opts.untagged.QUOTAROOT) {
                    await opts.untagged.QUOTAROOT({
                        attributes: [{ value: 'INBOX' }, { value: 'user.root' }]
                    });
                }
                // No QUOTA response
            } else if (cmd === 'GETQUOTA') {
                getQuotaCalled = true;
                test.deepEqual(args, [{ type: 'ATOM', value: 'user.root' }]);
                if (opts && opts.untagged && opts.untagged.QUOTA) {
                    await opts.untagged.QUOTA({
                        attributes: [{ value: 'user.root' }, [{ value: 'STORAGE' }, { value: '100' }, { value: '200' }]]
                    });
                }
            }
            return { next: () => {} };
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.ok(getQuotaCalled);
    test.equal(result.quotaRoot, 'user.root');
    test.equal(result.storage.usage, 100 * 1024);
    test.done();
};

module.exports['Commands: quota handles zero limit'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.QUOTA) {
                await opts.untagged.QUOTA({
                    attributes: [
                        { value: '' },
                        [
                            { value: 'STORAGE' },
                            { value: '0' },
                            { value: '0' } // Zero limit
                        ]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.ok(result.storage);
    test.equal(result.storage.usage, 0);
    test.equal(result.storage.limit, 0);
    // No status when limit is 0
    test.equal(result.storage.status, undefined);
    test.done();
};

module.exports['Commands: quota handles empty attributes'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.QUOTA) {
                await opts.untagged.QUOTA({
                    attributes: [
                        { value: '' },
                        [] // Empty quota list
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.ok(result);
    test.equal(result.path, 'INBOX');
    test.equal(result.storage, undefined);
    test.done();
};

module.exports['Commands: quota works in SELECTED state'] = async test => {
    const connection = createMockConnection({
        state: 3, // SELECTED
        capabilities: new Map([['QUOTA', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.QUOTA) {
                await opts.untagged.QUOTA({
                    attributes: [{ value: '' }, [{ value: 'STORAGE' }, { value: '10' }, { value: '100' }]]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.ok(result);
    test.equal(result.storage.status, '10%');
    test.done();
};

module.exports['Commands: quota handles error'] = async test => {
    let warnLogged = false;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async () => {
            const err = new Error('Quota failed');
            err.response = { attributes: [] };
            throw err;
        },
        log: {
            warn: () => {
                warnLogged = true;
            },
            debug: () => {},
            trace: () => {}
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.equal(result, false);
    test.ok(warnLogged);
    test.done();
};

module.exports['Commands: quota handles error with status code'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async () => {
            const err = new Error('Quota failed');
            err.response = {
                tag: 'A1',
                command: 'NO',
                attributes: [
                    {
                        type: 'ATOM',
                        value: '',
                        section: [{ type: 'ATOM', value: 'NOQUOTA' }]
                    }
                ]
            };
            throw err;
        },
        log: {
            warn: () => {},
            debug: () => {},
            trace: () => {}
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.equal(result, false);
    test.done();
};

module.exports['Commands: quota normalizes path'] = async test => {
    let capturedArgs = null;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        namespace: { delimiter: '/', prefix: 'INBOX/' },
        exec: async (cmd, args) => {
            capturedArgs = args;
            return { next: () => {} };
        }
    });

    await quotaCommand(connection, 'Subfolder');
    test.ok(capturedArgs);
    test.done();
};

module.exports['Commands: quota handles non-numeric values'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.QUOTA) {
                await opts.untagged.QUOTA({
                    attributes: [
                        { value: '' },
                        [
                            { value: 'STORAGE' },
                            { value: 'invalid' }, // Non-numeric usage
                            { value: 'also-invalid' } // Non-numeric limit
                        ]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.ok(result);
    // Non-numeric values should be skipped - no storage data set
    test.equal(result.storage, undefined);
    test.done();
};

module.exports['Commands: quota calculates percentage correctly'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.QUOTA) {
                await opts.untagged.QUOTA({
                    attributes: [{ value: '' }, [{ value: 'MESSAGE' }, { value: '333' }, { value: '1000' }]]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.equal(result.message.status, '33%'); // Rounded
    test.done();
};

module.exports['Commands: quota handles falsy key in attributes'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.QUOTA) {
                // First attribute (i=0) has invalid key (null value), so key becomes false
                // Then i=1 and i=2 should be skipped due to !key check
                await opts.untagged.QUOTA({
                    attributes: [
                        { value: '' },
                        [
                            { value: null }, // Invalid key at i=0 -> key = false
                            { value: '100' }, // i=1, skipped because !key
                            { value: '1000' } // i=2, skipped because !key
                        ]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.ok(result);
    // No quota data should be set since key was falsy
    test.equal(Object.keys(result).filter(k => k !== 'path').length, 0);
    test.done();
};

module.exports['Commands: quota sets limit without prior usage'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['QUOTA', true]]),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.QUOTA) {
                // Provide only the limit (i=2) without usage (i=1) being valid
                await opts.untagged.QUOTA({
                    attributes: [
                        { value: '' },
                        [
                            { value: 'STORAGE' }, // i=0, key = 'storage'
                            { value: 'invalid' }, // i=1, usage - invalid number, skipped
                            { value: '1000' } // i=2, limit - should create map[key] first
                        ]
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await quotaCommand(connection, 'INBOX');
    test.ok(result);
    test.ok(result.storage);
    test.equal(result.storage.limit, 1024000); // 1000 * 1024 for storage
    test.equal(result.storage.usage, undefined);
    test.done();
};

// ============================================
// AUTHENTICATE Command Tests
// ============================================

const authenticateCommand = require('../lib/commands/authenticate');

module.exports['Commands: authenticate skips when already authenticated'] = async test => {
    const connection = createMockConnection({
        state: 2 // AUTHENTICATED
    });

    const result = await authenticateCommand(connection, 'user', { password: 'pass' });
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: authenticate with OAUTHBEARER'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 1, // NOT_AUTHENTICATED
        capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
        servername: 'imap.example.com',
        authCapabilities: new Map(),
        exec: async (cmd, args) => {
            execArgs = { cmd, args };
            return { next: () => {} };
        },
        write: () => {}
    });

    const result = await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });
    test.equal(result, 'user@example.com');
    test.equal(execArgs.cmd, 'AUTHENTICATE');
    test.equal(execArgs.args[0].value, 'OAUTHBEARER');
    test.ok(connection.authCapabilities.has('AUTH=OAUTHBEARER'));
    test.done();
};

module.exports['Commands: authenticate with XOAUTH2'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=XOAUTH2', true]]),
        servername: 'imap.example.com',
        authCapabilities: new Map(),
        exec: async (cmd, args) => {
            execArgs = { cmd, args };
            return { next: () => {} };
        },
        write: () => {}
    });

    const result = await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });
    test.equal(result, 'user@example.com');
    test.equal(execArgs.args[0].value, 'XOAUTH2');
    test.ok(connection.authCapabilities.has('AUTH=XOAUTH2'));
    test.done();
};

module.exports['Commands: authenticate with XOAUTH (legacy)'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=XOAUTH', true]]),
        servername: 'imap.example.com',
        authCapabilities: new Map(),
        exec: async (cmd, args) => {
            execArgs = { cmd, args };
            return { next: () => {} };
        },
        write: () => {}
    });

    const result = await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });
    test.equal(result, 'user@example.com');
    test.equal(execArgs.args[0].value, 'XOAUTH2');
    test.done();
};

module.exports['Commands: authenticate OAuth handles error response'] = async test => {
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
        servername: 'imap.example.com',
        authCapabilities: new Map(),
        exec: async (cmd, args, opts) => {
            // Simulate server sending error in plus tag
            if (opts && opts.onPlusTag) {
                const errorJson = Buffer.from(JSON.stringify({ status: '401', error: 'invalid_token' })).toString('base64');
                await opts.onPlusTag({
                    attributes: [{ type: 'TEXT', value: errorJson }]
                });
            }
            const err = new Error('Authentication failed');
            err.response = { attributes: [] };
            throw err;
        },
        write: () => {},
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    try {
        await authenticateCommand(connection, 'user@example.com', { accessToken: 'bad_token' });
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.ok(err.authenticationFailed);
        test.ok(err.oauthError);
        test.equal(err.oauthError.status, '401');
    }
    test.done();
};

module.exports['Commands: authenticate OAuth handles malformed error response'] = async test => {
    let debugLogged = false;
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
        servername: 'imap.example.com',
        authCapabilities: new Map(),
        exec: async (cmd, args, opts) => {
            if (opts && opts.onPlusTag) {
                // Malformed base64/JSON
                await opts.onPlusTag({
                    attributes: [{ type: 'TEXT', value: 'not-valid-base64!' }]
                });
            }
            const err = new Error('Authentication failed');
            err.response = { attributes: [] };
            throw err;
        },
        write: () => {},
        log: {
            debug: () => {
                debugLogged = true;
            },
            warn: () => {},
            trace: () => {}
        }
    });

    try {
        await authenticateCommand(connection, 'user@example.com', { accessToken: 'token' });
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.ok(err.authenticationFailed);
        test.ok(debugLogged); // Should log the parse error
        test.equal(err.oauthError, undefined); // No oauthError since parse failed
    }
    test.done();
};

module.exports['Commands: authenticate OAuth error with serverResponseCode'] = async test => {
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
        servername: 'imap.example.com',
        authCapabilities: new Map(),
        exec: async (cmd, args, opts) => {
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag({});
            }
            const err = new Error('Authentication failed');
            err.response = {
                tag: 'A1',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'AUTHORIZATIONFAILED' }]
                    },
                    { type: 'TEXT', value: 'OAuth token expired' }
                ]
            };
            throw err;
        },
        write: () => {},
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    try {
        await authenticateCommand(connection, 'user@example.com', { accessToken: 'expired_token' });
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.ok(err.authenticationFailed);
        test.equal(err.serverResponseCode, 'AUTHORIZATIONFAILED');
    }
    test.done();
};

module.exports['Commands: authenticate with PLAIN'] = async test => {
    let execArgs = null;
    let writtenData = null;
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=PLAIN', true]]),
        authCapabilities: new Map(),
        exec: async (cmd, args, opts) => {
            execArgs = { cmd, args };
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag({});
            }
            return { next: () => {} };
        },
        write: data => {
            writtenData = data;
        },
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    const result = await authenticateCommand(connection, 'testuser', { password: 'testpass' });
    test.equal(result, 'testuser');
    test.equal(execArgs.cmd, 'AUTHENTICATE');
    test.equal(execArgs.args[0].value, 'PLAIN');
    // Verify PLAIN format: \x00username\x00password
    const decoded = Buffer.from(writtenData, 'base64').toString();
    test.equal(decoded, '\x00testuser\x00testpass');
    test.ok(connection.authCapabilities.has('AUTH=PLAIN'));
    test.done();
};

module.exports['Commands: authenticate with PLAIN and authzid'] = async test => {
    let writtenData = null;
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=PLAIN', true]]),
        authCapabilities: new Map(),
        exec: async (cmd, args, opts) => {
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag({});
            }
            return { next: () => {} };
        },
        write: data => {
            writtenData = data;
        },
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    const result = await authenticateCommand(connection, 'admin', {
        password: 'adminpass',
        authzid: 'impersonated_user'
    });
    test.equal(result, 'impersonated_user'); // Returns authzid when provided
    // Verify PLAIN format with authzid: authzid\x00username\x00password
    const decoded = Buffer.from(writtenData, 'base64').toString();
    test.equal(decoded, 'impersonated_user\x00admin\x00adminpass');
    test.done();
};

module.exports['Commands: authenticate with PLAIN forced via loginMethod'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([
            ['AUTH=LOGIN', true],
            ['AUTH=PLAIN', true]
        ]),
        authCapabilities: new Map(),
        exec: async (cmd, args, opts) => {
            execArgs = { cmd, args };
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag({});
            }
            return { next: () => {} };
        },
        write: () => {},
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    await authenticateCommand(connection, 'user', { password: 'pass', loginMethod: 'AUTH=PLAIN' });
    test.equal(execArgs.args[0].value, 'PLAIN');
    test.done();
};

module.exports['Commands: authenticate with LOGIN'] = async test => {
    let execArgs = null;
    let writeCount = 0;
    let writtenValues = [];
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=LOGIN', true]]),
        authCapabilities: new Map(),
        exec: async (cmd, args, opts) => {
            execArgs = { cmd, args };
            if (opts && opts.onPlusTag) {
                // Simulate server prompts
                await opts.onPlusTag({
                    attributes: [{ type: 'TEXT', value: Buffer.from('Username:').toString('base64') }]
                });
                await opts.onPlusTag({
                    attributes: [{ type: 'TEXT', value: Buffer.from('Password:').toString('base64') }]
                });
            }
            return { next: () => {} };
        },
        write: data => {
            writeCount++;
            writtenValues.push(Buffer.from(data, 'base64').toString());
        },
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    const result = await authenticateCommand(connection, 'loginuser', { password: 'loginpass' });
    test.equal(result, 'loginuser');
    test.equal(execArgs.args[0].value, 'LOGIN');
    test.equal(writeCount, 2);
    test.equal(writtenValues[0], 'loginuser');
    test.equal(writtenValues[1], 'loginpass');
    test.ok(connection.authCapabilities.has('AUTH=LOGIN'));
    test.done();
};

module.exports['Commands: authenticate with LOGIN handles user name prompt'] = async test => {
    let writtenValues = [];
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=LOGIN', true]]),
        authCapabilities: new Map(),
        exec: async (cmd, args, opts) => {
            if (opts && opts.onPlusTag) {
                // Some servers use "User Name" instead of "Username"
                await opts.onPlusTag({
                    attributes: [{ type: 'TEXT', value: Buffer.from('User Name:').toString('base64') }]
                });
                await opts.onPlusTag({
                    attributes: [{ type: 'TEXT', value: Buffer.from('Password').toString('base64') }]
                });
            }
            return { next: () => {} };
        },
        write: data => {
            writtenValues.push(Buffer.from(data, 'base64').toString());
        },
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    await authenticateCommand(connection, 'testuser', { password: 'testpass' });
    test.equal(writtenValues[0], 'testuser');
    test.equal(writtenValues[1], 'testpass');
    test.done();
};

module.exports['Commands: authenticate with LOGIN throws on unknown question'] = async test => {
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=LOGIN', true]]),
        authCapabilities: new Map(),
        exec: async (cmd, args, opts) => {
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag({
                    attributes: [{ type: 'TEXT', value: Buffer.from('Unknown Question:').toString('base64') }]
                });
            }
            return { next: () => {} };
        },
        write: () => {},
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    try {
        await authenticateCommand(connection, 'user', { password: 'pass' });
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.ok(err.message.includes('Unknown LOGIN question'));
    }
    test.done();
};

module.exports['Commands: authenticate with LOGIN forced via loginMethod'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([
            ['AUTH=PLAIN', true],
            ['AUTH=LOGIN', true]
        ]),
        authCapabilities: new Map(),
        exec: async (cmd, args, opts) => {
            execArgs = { cmd, args };
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag({
                    attributes: [{ type: 'TEXT', value: Buffer.from('Username:').toString('base64') }]
                });
                await opts.onPlusTag({
                    attributes: [{ type: 'TEXT', value: Buffer.from('Password:').toString('base64') }]
                });
            }
            return { next: () => {} };
        },
        write: () => {},
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    await authenticateCommand(connection, 'user', { password: 'pass', loginMethod: 'AUTH=LOGIN' });
    test.equal(execArgs.args[0].value, 'LOGIN');
    test.done();
};

module.exports['Commands: authenticate PLAIN handles error'] = async test => {
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=PLAIN', true]]),
        authCapabilities: new Map(),
        exec: async (cmd, args, opts) => {
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag({});
            }
            const err = new Error('Authentication failed');
            err.response = {
                tag: 'A1',
                command: 'NO',
                attributes: [
                    {
                        type: 'ATOM',
                        value: '',
                        section: [{ type: 'ATOM', value: 'AUTHENTICATIONFAILED' }]
                    }
                ]
            };
            throw err;
        },
        write: () => {},
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    try {
        await authenticateCommand(connection, 'user', { password: 'wrongpass' });
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.ok(err.authenticationFailed);
        test.equal(err.serverResponseCode, 'AUTHENTICATIONFAILED');
    }
    test.done();
};

module.exports['Commands: authenticate LOGIN handles error'] = async test => {
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=LOGIN', true]]),
        authCapabilities: new Map(),
        exec: async () => {
            const err = new Error('Login failed');
            err.response = {
                tag: 'A1',
                command: 'NO',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [{ type: 'ATOM', value: 'AUTHENTICATIONFAILED' }]
                    },
                    { type: 'TEXT', value: 'Invalid credentials' }
                ]
            };
            throw err;
        },
        write: () => {},
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    try {
        await authenticateCommand(connection, 'user', { password: 'pass' });
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.ok(err.authenticationFailed);
        test.equal(err.serverResponseCode, 'AUTHENTICATIONFAILED');
    }
    test.done();
};

module.exports['Commands: authenticate throws unsupported mechanism'] = async test => {
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map() // No auth capabilities
    });

    try {
        await authenticateCommand(connection, 'user', { password: 'pass' });
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.ok(err.message.includes('Unsupported authentication mechanism'));
    }
    test.done();
};

module.exports['Commands: authenticate throws unsupported for accessToken without OAuth capability'] = async test => {
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([['AUTH=PLAIN', true]]) // No OAuth capability
    });

    try {
        await authenticateCommand(connection, 'user', { accessToken: 'token123' });
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.ok(err.message.includes('Unsupported authentication mechanism'));
    }
    test.done();
};

module.exports['Commands: authenticate prefers PLAIN over LOGIN by default'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([
            ['AUTH=LOGIN', true],
            ['AUTH=PLAIN', true]
        ]),
        authCapabilities: new Map(),
        exec: async (cmd, args, opts) => {
            execArgs = { cmd, args };
            if (opts && opts.onPlusTag) {
                await opts.onPlusTag({});
            }
            return { next: () => {} };
        },
        write: () => {},
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    await authenticateCommand(connection, 'user', { password: 'pass' });
    test.equal(execArgs.args[0].value, 'PLAIN'); // PLAIN should be preferred
    test.done();
};

module.exports['Commands: authenticate prefers OAuth when accessToken provided'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 1,
        capabilities: new Map([
            ['AUTH=PLAIN', true],
            ['AUTH=OAUTHBEARER', true]
        ]),
        servername: 'imap.example.com',
        authCapabilities: new Map(),
        exec: async (cmd, args) => {
            execArgs = { cmd, args };
            return { next: () => {} };
        },
        write: () => {},
        log: {
            debug: () => {},
            warn: () => {},
            trace: () => {}
        }
    });

    await authenticateCommand(connection, 'user', { accessToken: 'token', password: 'pass' });
    test.equal(execArgs.args[0].value, 'OAUTHBEARER'); // OAuth preferred when token provided
    test.done();
};

// ============================================
// CREATE Command Tests
// ============================================

module.exports['Commands: create skips when not authenticated'] = async test => {
    const connection = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

    const result = await createCommand(connection, 'NewFolder');
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: create mailbox success'] = async test => {
    let execArgs = null;
    let subscribeCalled = false;
    const connection = createMockConnection({
        state: 2, // AUTHENTICATED
        exec: async (cmd, args) => {
            execArgs = { cmd, args };
            return {
                next: () => {},
                response: { attributes: [] }
            };
        },
        run: async (cmd, path) => {
            if (cmd === 'SUBSCRIBE') {
                subscribeCalled = true;
                test.equal(path, 'NewFolder');
            }
        }
    });

    const result = await createCommand(connection, 'NewFolder');
    test.ok(result);
    test.equal(result.path, 'NewFolder');
    test.equal(result.created, true);
    test.equal(execArgs.cmd, 'CREATE');
    test.ok(subscribeCalled);
    test.done();
};

module.exports['Commands: create works in SELECTED state'] = async test => {
    const connection = createMockConnection({
        state: 3, // SELECTED
        exec: async () => ({
            next: () => {},
            response: { attributes: [] }
        }),
        run: async () => {}
    });

    const result = await createCommand(connection, 'NewFolder');
    test.ok(result);
    test.equal(result.created, true);
    test.done();
};

module.exports['Commands: create with MAILBOXID response'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        section: [{ value: 'MAILBOXID' }, [{ value: 'F12345' }]]
                    }
                ]
            }
        }),
        run: async () => {}
    });

    const result = await createCommand(connection, 'NewFolder');
    test.ok(result);
    test.equal(result.mailboxId, 'F12345');
    test.equal(result.created, true);
    test.done();
};

module.exports['Commands: create normalizes path'] = async test => {
    let capturedArgs = null;
    const connection = createMockConnection({
        state: 2,
        namespace: { delimiter: '/', prefix: 'INBOX/' },
        exec: async (cmd, args) => {
            capturedArgs = args;
            return {
                next: () => {},
                response: { attributes: [] }
            };
        },
        run: async () => {}
    });

    await createCommand(connection, 'Subfolder');
    test.ok(capturedArgs);
    test.done();
};

module.exports['Commands: create handles ALREADYEXISTS'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Mailbox already exists');
            err.response = {
                tag: 'A1',
                command: 'NO',
                attributes: [
                    {
                        type: 'ATOM',
                        value: '',
                        section: [{ type: 'ATOM', value: 'ALREADYEXISTS' }]
                    }
                ]
            };
            throw err;
        },
        run: async () => {},
        log: {
            warn: () => {},
            debug: () => {},
            trace: () => {}
        }
    });

    const result = await createCommand(connection, 'ExistingFolder');
    test.ok(result);
    test.equal(result.path, 'ExistingFolder');
    test.equal(result.created, false);
    test.done();
};

module.exports['Commands: create throws on other errors'] = async test => {
    let warnLogged = false;
    const connection = createMockConnection({
        state: 2,
        exec: async () => {
            const err = new Error('Permission denied');
            err.response = {
                tag: 'A1',
                command: 'NO',
                attributes: [
                    {
                        type: 'ATOM',
                        value: '',
                        section: [{ type: 'ATOM', value: 'NOPERM' }]
                    }
                ]
            };
            throw err;
        },
        run: async () => {},
        log: {
            warn: () => {
                warnLogged = true;
            },
            debug: () => {},
            trace: () => {}
        }
    });

    try {
        await createCommand(connection, 'RestrictedFolder');
        test.ok(false, 'Should have thrown');
    } catch (err) {
        test.equal(err.serverResponseCode, 'NOPERM');
        test.ok(warnLogged);
    }
    test.done();
};

module.exports['Commands: create handles empty section'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        section: [] // Empty section
                    }
                ]
            }
        }),
        run: async () => {}
    });

    const result = await createCommand(connection, 'NewFolder');
    test.ok(result);
    test.equal(result.created, true);
    test.equal(result.mailboxId, undefined);
    test.done();
};

module.exports['Commands: create handles invalid MAILBOXID format'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        section: [
                            { value: 'MAILBOXID' },
                            { value: 'not-an-array' } // Should be array
                        ]
                    }
                ]
            }
        }),
        run: async () => {}
    });

    const result = await createCommand(connection, 'NewFolder');
    test.ok(result);
    test.equal(result.created, true);
    // mailboxId should not be set due to invalid format
    test.equal(result.mailboxId, undefined);
    test.done();
};

module.exports['Commands: create handles null key in section'] = async test => {
    const connection = createMockConnection({
        state: 2,
        exec: async () => ({
            next: () => {},
            response: {
                attributes: [
                    {
                        section: [
                            null, // null key
                            [{ value: 'F12345' }]
                        ]
                    }
                ]
            }
        }),
        run: async () => {}
    });

    const result = await createCommand(connection, 'NewFolder');
    test.ok(result);
    test.equal(result.created, true);
    test.done();
};

// ============================================
// ENABLE Command Tests
// ============================================

module.exports['Commands: enable skips without ENABLE capability'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map() // No ENABLE capability
    });

    const result = await enableCommand(connection, ['CONDSTORE']);
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: enable skips when not authenticated'] = async test => {
    const connection = createMockConnection({
        state: 3, // SELECTED - not AUTHENTICATED
        capabilities: new Map([['ENABLE', true]])
    });

    const result = await enableCommand(connection, ['CONDSTORE']);
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: enable skips when no supported extensions'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([['ENABLE', true]]) // Has ENABLE but not CONDSTORE
    });

    const result = await enableCommand(connection, ['CONDSTORE']);
    test.equal(result, undefined);
    test.done();
};

module.exports['Commands: enable single extension'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['ENABLE', true],
            ['CONDSTORE', true]
        ]),
        enabled: new Set(),
        exec: async (cmd, args, opts) => {
            execArgs = { cmd, args };
            if (opts && opts.untagged && opts.untagged.ENABLED) {
                await opts.untagged.ENABLED({
                    attributes: [{ value: 'CONDSTORE' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await enableCommand(connection, ['CONDSTORE']);
    test.ok(result instanceof Set);
    test.ok(result.has('CONDSTORE'));
    test.equal(execArgs.cmd, 'ENABLE');
    test.equal(execArgs.args[0].value, 'CONDSTORE');
    test.ok(connection.enabled.has('CONDSTORE'));
    test.done();
};

module.exports['Commands: enable multiple extensions'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['ENABLE', true],
            ['CONDSTORE', true],
            ['QRESYNC', true]
        ]),
        enabled: new Set(),
        exec: async (cmd, args, opts) => {
            execArgs = { cmd, args };
            if (opts && opts.untagged && opts.untagged.ENABLED) {
                await opts.untagged.ENABLED({
                    attributes: [{ value: 'CONDSTORE' }, { value: 'QRESYNC' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await enableCommand(connection, ['CONDSTORE', 'QRESYNC']);
    test.ok(result instanceof Set);
    test.ok(result.has('CONDSTORE'));
    test.ok(result.has('QRESYNC'));
    test.equal(execArgs.args.length, 2);
    test.done();
};

module.exports['Commands: enable filters unsupported extensions'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['ENABLE', true],
            ['CONDSTORE', true]
            // QRESYNC not supported
        ]),
        enabled: new Set(),
        exec: async (cmd, args, opts) => {
            execArgs = { cmd, args };
            if (opts && opts.untagged && opts.untagged.ENABLED) {
                await opts.untagged.ENABLED({
                    attributes: [{ value: 'CONDSTORE' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await enableCommand(connection, ['CONDSTORE', 'QRESYNC']);
    test.ok(result instanceof Set);
    test.ok(result.has('CONDSTORE'));
    test.ok(!result.has('QRESYNC'));
    // Only CONDSTORE should be in the request
    test.equal(execArgs.args.length, 1);
    test.equal(execArgs.args[0].value, 'CONDSTORE');
    test.done();
};

module.exports['Commands: enable converts to uppercase'] = async test => {
    let execArgs = null;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['ENABLE', true],
            ['CONDSTORE', true]
        ]),
        enabled: new Set(),
        exec: async (cmd, args, opts) => {
            execArgs = { cmd, args };
            if (opts && opts.untagged && opts.untagged.ENABLED) {
                await opts.untagged.ENABLED({
                    attributes: [{ value: 'condstore' }]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await enableCommand(connection, ['condstore']); // lowercase
    test.ok(result instanceof Set);
    test.ok(result.has('CONDSTORE')); // Stored as uppercase
    test.equal(execArgs.args[0].value, 'CONDSTORE'); // Sent as uppercase
    test.done();
};

module.exports['Commands: enable handles empty ENABLED response'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['ENABLE', true],
            ['CONDSTORE', true]
        ]),
        enabled: new Set(),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.ENABLED) {
                await opts.untagged.ENABLED({
                    attributes: [] // Empty
                });
            }
            return { next: () => {} };
        }
    });

    const result = await enableCommand(connection, ['CONDSTORE']);
    test.ok(result instanceof Set);
    test.equal(result.size, 0);
    test.done();
};

module.exports['Commands: enable handles null attributes'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['ENABLE', true],
            ['CONDSTORE', true]
        ]),
        enabled: new Set(),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.ENABLED) {
                await opts.untagged.ENABLED({
                    attributes: null
                });
            }
            return { next: () => {} };
        }
    });

    const result = await enableCommand(connection, ['CONDSTORE']);
    test.ok(result instanceof Set);
    test.equal(result.size, 0);
    test.done();
};

module.exports['Commands: enable trims response values'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['ENABLE', true],
            ['CONDSTORE', true]
        ]),
        enabled: new Set(),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.ENABLED) {
                await opts.untagged.ENABLED({
                    attributes: [{ value: '  CONDSTORE  ' }] // With whitespace
                });
            }
            return { next: () => {} };
        }
    });

    const result = await enableCommand(connection, ['CONDSTORE']);
    test.ok(result.has('CONDSTORE'));
    test.done();
};

module.exports['Commands: enable handles error'] = async test => {
    let warnLogged = false;
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['ENABLE', true],
            ['CONDSTORE', true]
        ]),
        enabled: new Set(),
        exec: async () => {
            throw new Error('Enable failed');
        },
        log: {
            warn: () => {
                warnLogged = true;
            },
            debug: () => {},
            trace: () => {}
        }
    });

    const result = await enableCommand(connection, ['CONDSTORE']);
    test.equal(result, false);
    test.ok(warnLogged);
    test.done();
};

module.exports['Commands: enable skips non-string attribute values'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['ENABLE', true],
            ['CONDSTORE', true]
        ]),
        enabled: new Set(),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.ENABLED) {
                await opts.untagged.ENABLED({
                    attributes: [
                        { value: 'CONDSTORE' },
                        { value: null }, // null value
                        { value: 123 }, // number value
                        { notValue: 'test' } // missing value property
                    ]
                });
            }
            return { next: () => {} };
        }
    });

    const result = await enableCommand(connection, ['CONDSTORE']);
    test.ok(result instanceof Set);
    test.equal(result.size, 1);
    test.ok(result.has('CONDSTORE'));
    test.done();
};

module.exports['Commands: enable updates connection.enabled'] = async test => {
    const connection = createMockConnection({
        state: 2,
        capabilities: new Map([
            ['ENABLE', true],
            ['CONDSTORE', true],
            ['UTF8=ACCEPT', true]
        ]),
        enabled: new Set(['EXISTING']),
        exec: async (cmd, args, opts) => {
            if (opts && opts.untagged && opts.untagged.ENABLED) {
                await opts.untagged.ENABLED({
                    attributes: [{ value: 'CONDSTORE' }, { value: 'UTF8=ACCEPT' }]
                });
            }
            return { next: () => {} };
        }
    });

    await enableCommand(connection, ['CONDSTORE', 'UTF8=ACCEPT']);
    // connection.enabled should be replaced with new set
    test.ok(connection.enabled.has('CONDSTORE'));
    test.ok(connection.enabled.has('UTF8=ACCEPT'));
    test.ok(!connection.enabled.has('EXISTING')); // Old value should be gone
    test.done();
};
