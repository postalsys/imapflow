/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import imapCommands from '../src/imap-commands.js';
import capabilityCommand from '../src/commands/capability.js';
import noopCommand from '../src/commands/noop.js';
import loginCommand from '../src/commands/login.js';
import logoutCommand from '../src/commands/logout.js';
import closeCommand from '../src/commands/close.js';
import searchCommand from '../src/commands/search.js';
import storeCommand from '../src/commands/store.js';
import copyCommand from '../src/commands/copy.js';
import moveCommand from '../src/commands/move.js';
import expungeCommand from '../src/commands/expunge.js';
import createCommand from '../src/commands/create.js';
import deleteCommand from '../src/commands/delete.js';
import renameCommand from '../src/commands/rename.js';
import subscribeCommand from '../src/commands/subscribe.js';
import unsubscribeCommand from '../src/commands/unsubscribe.js';
import enableCommand from '../src/commands/enable.js';
import compressCommand from '../src/commands/compress.js';
import starttlsCommand from '../src/commands/starttls.js';
import fetchCommand from '../src/commands/fetch.js';
import listCommand from '../src/commands/list.js';
import selectCommand from '../src/commands/select.js';
import statusCommand from '../src/commands/status.js';
import appendCommand from '../src/commands/append.js';
import idleCommand from '../src/commands/idle.js';
import idCommand from '../src/commands/id.js';
import namespaceCommand from '../src/commands/namespace.js';
import quotaCommand from '../src/commands/quota.js';
import authenticateCommand from '../src/commands/authenticate.js';
import { ImapFlow } from '../src/imap-flow.js';
import { canUseFlag } from '../src/tools.js';
import type { MailboxObject } from '../src/types.js';

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

    const connection: any = {
        states,
        state: (overrides as any).state || states.SELECTED,
        id: 'test-connection-id',
        // Mirrors imap-flow.js, which always resolves a port before authenticating. Without a
        // default the OAUTHBEARER payload builds `port=undefined`.
        port: (overrides as any).port || 993,
        capabilities: new Map((overrides as any).capabilities || [['IMAP4rev1', true]]),
        enabled: new Set((overrides as any).enabled || []),
        authCapabilities: new Map(),
        mailbox: (overrides as any).mailbox || { ...defaultMailbox },
        namespace: (overrides as any).namespace || { delimiter: '/', prefix: '' },
        expectCapabilityUpdate: (overrides as any).expectCapabilityUpdate || false,
        log: {
            warn: () => {},
            info: () => {},
            error: () => {},
            debug: () => {},
            trace: () => {}
        },
        close: (overrides as any).close || (() => {}),
        emit: (overrides as any).emit || (() => {}),
        // A live transport: command implementations that guard against polling or writing on a
        // dead connection (idle.js) need this to look established.
        socket: (overrides as any).socket || { destroyed: false },
        currentSelectCommand: false,
        skipListSubscribedArg: false,
        skipListStatusArgs: false,
        skipListAuxArgs: false,
        skipLsub: false,
        messageFlagsAdd: (overrides as any).messageFlagsAdd || (async () => {}),
        // Mirrors ImapFlow.throttleWait(): resolves false on normal expiry, true when close()
        // aborted the wait. The mock resolves immediately so throttle retries stay fast.
        throttleWait: (overrides as any).throttleWait || (async () => false),
        createNoConnectionError:
            (overrides as any).createNoConnectionError || (() => Object.assign(new Error('Connection not available'), { code: 'NoConnection' })),
        run: (overrides as any).run || (async () => {}),
        // Mirrors ImapFlow.runInternal(): dispatch through the command registry without the
        // preCheck/auto-IDLE handshake that run() performs, so a fallback poll runs the real
        // SELECT/STATUS implementation.
        runInternal:
            (overrides as any).runInternal ||
            (async (command: any, ...args: any[]) => {
                let handler = imapCommands.get(command.toUpperCase());
                return handler ? await handler(connection, ...args) : false;
            }),
        exec:
            (overrides as any).exec ||
            (async () => ({
                next: () => {},
                response: { attributes: [] }
            })),
        ...overrides
    };

    return connection;
};

// Decodes the base64 SASL payload that authenticate() hands to exec().
const decodeSaslPayload = (execArgs: any) => Buffer.from(execArgs.args[1].value, 'base64').toString();

// Builds the error shape the reader loop attaches to failed commands: tagged
// rejections carry responseStatus ('BAD'/'NO'), transport and throttling
// failures carry a code ('NoConnection', 'ETHROTTLE').
const commandError = (message: any, responseStatus: any, code: any) => {
    let err: any = new Error(message);
    if (responseStatus) {
        err.responseStatus = responseStatus;
    }
    if (code) {
        (err as any).code = code;
    }
    return err;
};

// ============================================
// Untrusted response value handling
// ============================================
// Servers control every value in these responses. Each test below pins a value the client
// must refuse to store, or a malformed shape it must survive without losing the response.

const selectWithOkCodes = (sections: any) =>
    createMockConnection({
        state: 2, // AUTHENTICATED
        folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
        run: async () => [],
        exec: async (cmd: any, attrs: any, opts: any) => {
            if (opts && opts.untagged && opts.untagged.OK) {
                for (let section of sections) {
                    await opts.untagged.OK({ attributes: [{ section }] });
                }
            }
            return {
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            };
        },
        emit: () => {}
    });

describe('commands-integration', () => {
    // ============================================
    // CAPABILITY Command Tests
    // ============================================
    it('Commands: capability returns cached when available', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['IDLE', true]
            ]),
            expectCapabilityUpdate: false
        });

        const result = await capabilityCommand(connection);
        assert.ok(result instanceof Map);
        assert.equal(result.get('IDLE'), true);
    });
    it('Commands: capability fetches when empty', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map(),
            exec: async () => ({ next: () => {} })
        });

        const result = await capabilityCommand(connection);
        assert.ok(result instanceof Map);
    });
    it('Commands: capability fetches when update expected', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            capabilities: new Map([['IMAP4rev1', true]]),
            expectCapabilityUpdate: true,
            exec: async () => {
                execCalled = true;
                return { next: () => {} };
            }
        });

        await capabilityCommand(connection);
        assert.equal(execCalled, true);
    });
    it('Commands: capability handles error', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map(),
            exec: async () => {
                throw new Error('Command failed');
            }
        });

        const result = await capabilityCommand(connection);
        assert.equal(result, false);
    });

    // ============================================
    // NOOP Command Tests
    // ============================================
    it('Commands: noop success', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            exec: async (cmd: any) => {
                assert.equal(cmd, 'NOOP');
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await noopCommand(connection);
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: noop handles error', async () => {
        const connection: any = createMockConnection({
            exec: async () => {
                throw new Error('Command failed');
            }
        });

        const result = await noopCommand(connection);
        assert.equal(result, false);
    });

    // ============================================
    // LOGIN Command Tests
    // ============================================
    it('Commands: login success', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1, // NOT_AUTHENTICATED
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        const result = await loginCommand(connection, 'testuser', 'testpass');
        assert.equal(result, 'testuser');
        assert.equal(execArgs.cmd, 'LOGIN');
        assert.equal(execArgs!.attrs[0].value, 'testuser');
        assert.equal(execArgs!.attrs[1].value, 'testpass');
        assert.equal(execArgs!.attrs[1].sensitive, true);
    });
    it('Commands: login skips when already authenticated', async () => {
        const connection: any = createMockConnection({
            state: 2 // AUTHENTICATED
        });

        const result = await loginCommand(connection, 'testuser', 'testpass');
        assert.equal(result, undefined);
    });
    it('Commands: login handles error', async () => {
        const connection: any = createMockConnection({
            state: 1,
            exec: async () => {
                const err: any = new Error('Auth failed');
                err.response = { attributes: [] };
                throw err;
            }
        });

        try {
            await loginCommand(connection, 'testuser', 'wrongpass');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.authenticationFailed, true);
        }
    });
    it('Commands: login error includes serverResponseCode', async () => {
        const connection: any = createMockConnection({
            state: 1,
            exec: async () => {
                const err: any = new Error('Auth failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.authenticationFailed, true);
            assert.equal(err.serverResponseCode as any, 'AUTHENTICATIONFAILED');
        }
    });

    // ============================================
    // LOGOUT Command Tests
    // ============================================
    it('Commands: logout success', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            exec: async (cmd: any) => {
                assert.equal(cmd, 'LOGOUT');
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await logoutCommand(connection);
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: logout handles error', async () => {
        const connection: any = createMockConnection({
            exec: async () => {
                throw new Error('Command failed');
            }
        });

        const result = await logoutCommand(connection);
        assert.equal(result, false);
    });
    it('Commands: logout returns early when already in LOGOUT state', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 4, // LOGOUT
            exec: async () => {
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await logoutCommand(connection);
        assert.equal(result, false);
        assert.equal(execCalled, false);
    });
    it('Commands: logout handles NOT_AUTHENTICATED state', async () => {
        let closeCalled = false;
        const connection: any = createMockConnection({
            state: 1, // NOT_AUTHENTICATED (mock states: 1=NOT_AUTH, 2=AUTH, 3=SELECTED, 4=LOGOUT)
            exec: async () => ({ next: () => {} }),
            close: () => {
                closeCalled = true;
            }
        });

        const result = await logoutCommand(connection);
        assert.equal(result, false);
        assert.equal(connection.state, connection.states.LOGOUT);
        assert.equal(closeCalled, true);
    });
    it('Commands: logout handles NoConnection error', async () => {
        const connection: any = createMockConnection({
            exec: async () => {
                const err: any = new Error('No connection');
                err.code = 'NoConnection';
                throw err;
            }
        });

        const result = await logoutCommand(connection);
        assert.equal(result, true);
    });

    // ============================================
    // CLOSE Command Tests
    // ============================================
    it('Commands: close success', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            exec: async (cmd: any) => {
                assert.equal(cmd, 'CLOSE');
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await closeCommand(connection);
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: close skips when not selected', async () => {
        const connection: any = createMockConnection({
            state: 2 // AUTHENTICATED, not SELECTED
        });

        const result = await closeCommand(connection);
        assert.equal(result, undefined);
    });
    it('Commands: close handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                throw new Error('Command failed');
            }
        });

        const result = await closeCommand(connection);
        assert.equal(result, false);
    });
    it('Commands: close emits mailboxClose event', async () => {
        let emittedMailbox: any = null;
        const testMailbox = { path: 'INBOX', uidValidity: 12345n };
        const connection: any = createMockConnection({
            state: 3,
            mailbox: testMailbox,
            currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
            exec: async () => ({ next: () => {} }),
            emit: (event: any, data: any) => {
                if (event === 'mailboxClose') {
                    emittedMailbox = data;
                }
            }
        });

        const result = await closeCommand(connection);
        assert.equal(result, true);
        assert.ok(emittedMailbox);
        assert.equal(emittedMailbox.path, 'INBOX');
        assert.equal(connection.mailbox, false);
        assert.equal(connection.currentSelectCommand, false);
        assert.equal(connection.state, 2); // AUTHENTICATED
    });
    it('Commands: close without mailbox does not emit event', async () => {
        let eventEmitted = false;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: false, // No mailbox
            exec: async () => ({ next: () => {} }),
            emit: (event: any) => {
                if (event === 'mailboxClose') {
                    eventEmitted = true;
                }
            }
        });

        const result = await closeCommand(connection);
        assert.equal(result, true);
        assert.equal(eventEmitted, false);
    });

    // ============================================
    // SEARCH Command Tests
    // ============================================
    it('Commands: search with ALL', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.deepEqual(result, [1, 2, 3]);
        assert.equal(execArgs.cmd, 'SEARCH');
    });
    it('Commands: search collects results from an ESEARCH reply to plain SEARCH', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                // IMAP4rev2 servers answer a plain SEARCH with an untagged ESEARCH
                // response instead of the deprecated SEARCH response
                if (opts && opts.untagged && opts.untagged.ESEARCH) {
                    await opts.untagged.ESEARCH({
                        attributes: [
                            [
                                { type: 'ATOM', value: 'TAG' },
                                { type: 'STRING', value: 'A282' }
                            ],
                            { type: 'ATOM', value: 'ALL' },
                            { type: 'ATOM', value: '1:3,5' }
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await searchCommand(connection, true, {});
        assert.deepEqual(result, [1, 2, 3, 5]);
    });
    it('Commands: search returns empty array for an ESEARCH reply without ALL', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                // RFC 9051: an ESEARCH response with no matches omits the ALL item
                if (opts && opts.untagged && opts.untagged.ESEARCH) {
                    await opts.untagged.ESEARCH({
                        attributes: [
                            [
                                { type: 'ATOM', value: 'TAG' },
                                { type: 'STRING', value: 'A282' }
                            ],
                            { type: 'ATOM', value: 'COUNT' },
                            { type: 'ATOM', value: '0' }
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await searchCommand(connection, true, {});
        assert.deepEqual(result, []);
    });
    it('Commands: search caps a hostile ESEARCH ALL range at the mailbox size', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            mailbox: { path: 'INBOX', exists: 100 },
            exec: async (cmd: any, attrs: any, opts: any) => {
                // A few bytes of hostile response must not expand into billions of ids
                await opts.untagged.ESEARCH({
                    attributes: [
                        { type: 'ATOM', value: 'ALL' },
                        { type: 'ATOM', value: '1:4294967295' }
                    ]
                });
                return { next: () => {} };
            }
        });

        const result: any = await searchCommand(connection, true, {});
        // A conforming server cannot match more messages than the mailbox holds
        assert.equal(result.length, 100);
        assert.equal(result[0] as any, 1);
        assert.equal(result[99] as any, 100);
    });
    it('Commands: search resolves * in an ESEARCH ALL sequence-set', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            mailbox: { path: 'INBOX', exists: 5 },
            exec: async (cmd: any, attrs: any, opts: any) => {
                await opts.untagged.ESEARCH({
                    attributes: [
                        { type: 'ATOM', value: 'ALL' },
                        { type: 'ATOM', value: '3:*' }
                    ]
                });
                return { next: () => {} };
            }
        });

        const result = await searchCommand(connection, true, {});
        // '*' means the largest sequence number in use, which is the EXISTS count
        assert.deepEqual(result, [3, 4, 5]);
    });
    it('Commands: search drops * from ESEARCH UID results', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            mailbox: { path: 'INBOX', exists: 5, uidNext: 1000 },
            exec: async (cmd: any, attrs: any, opts: any) => {
                await opts.untagged.ESEARCH({
                    attributes: [
                        [
                            { type: 'ATOM', value: 'TAG' },
                            { type: 'STRING', value: 'A1' }
                        ],
                        { type: 'ATOM', value: 'UID' },
                        { type: 'ATOM', value: 'ALL' },
                        { type: 'ATOM', value: '7,3:*' }
                    ]
                });
                return { next: () => {} };
            }
        });

        const result = await searchCommand(connection, true, { uid: true });
        // Server-sent UID sets may not contain '*' (RFC 9051 4.1.1) - the offending
        // part is dropped, valid parts are kept
        assert.deepEqual(result, [7]);
    });
    it('Commands: search discards invalid single values in an ESEARCH ALL set', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            mailbox: { path: 'INBOX', exists: 5 },
            exec: async (cmd: any, attrs: any, opts: any) => {
                // '0' is not a valid nz-number and 'foo' is garbage - both single
                // values must be dropped while the valid one survives
                await opts.untagged.ESEARCH({
                    attributes: [
                        { type: 'ATOM', value: 'ALL' },
                        { type: 'ATOM', value: '0,foo,4' }
                    ]
                });
                return { next: () => {} };
            }
        });

        const result = await searchCommand(connection, true, {});
        assert.deepEqual(result, [4]);
    });
    it('Commands: search truncates single-value ESEARCH ALL entries at the mailbox size', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            mailbox: { path: 'INBOX', exists: 2 },
            exec: async (cmd: any, attrs: any, opts: any) => {
                // More single values than the mailbox holds - the walk must stop at
                // the EXISTS budget instead of collecting the excess
                await opts.untagged.ESEARCH({
                    attributes: [
                        { type: 'ATOM', value: 'ALL' },
                        { type: 'ATOM', value: '1,2,3,4' }
                    ]
                });
                return { next: () => {} };
            }
        });

        const result = await searchCommand(connection, true, {});
        assert.deepEqual(result, [1, 2]);
    });
    it('Commands: search ignores an ESEARCH reply without attributes on the plain path', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                // A degenerate untagged ESEARCH with no attributes must not crash
                // the collector or contribute results
                await opts.untagged.ESEARCH({ attributes: null });
                await opts.untagged.ESEARCH({
                    attributes: [
                        { type: 'ATOM', value: 'ALL' },
                        { type: 'ATOM', value: '2' }
                    ]
                });
                return { next: () => {} };
            }
        });

        const result = await searchCommand(connection, true, {});
        assert.deepEqual(result, [2]);
    });
    it('Commands: search treats an ESEARCH ALL set without a mailbox size as empty', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            // No exists value at all - the budget is zero, nothing may be collected
            mailbox: { path: 'INBOX' },
            exec: async (cmd: any, attrs: any, opts: any) => {
                await opts.untagged.ESEARCH({
                    attributes: [
                        { type: 'ATOM', value: 'ALL' },
                        { type: 'ATOM', value: '1:3' }
                    ]
                });
                return { next: () => {} };
            }
        });

        const result = await searchCommand(connection, true, {});
        assert.deepEqual(result, []);
    });
    it('Commands: search with UID option', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                execCmd = cmd;
                if (opts && opts.untagged && opts.untagged.SEARCH) {
                    await opts.untagged.SEARCH({ attributes: [{ value: '100' }] });
                }
                return { next: () => {} };
            }
        });

        const result = await searchCommand(connection, { all: true }, { uid: true });
        assert.deepEqual(result, [100]);
        assert.equal(execCmd, 'UID SEARCH');
    });
    it('Commands: search with query object', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                // Check that search compiler was used
                assert.ok(attrs.some((a: any) => a.value === 'FROM'));
                if (opts && opts.untagged && opts.untagged.SEARCH) {
                    await opts.untagged.SEARCH({ attributes: [] });
                }
                return { next: () => {} };
            }
        });

        const result = await searchCommand(connection, { from: 'test@example.com' }, {});
        assert.ok(Array.isArray(result));
    });
    it('Commands: search skips when not selected', async () => {
        const connection: any = createMockConnection({
            state: 2 // AUTHENTICATED
        });

        const result = await searchCommand(connection, { all: true }, {});
        assert.equal(result, false);
    });
    it('Commands: search handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                const err: any = new Error('Search failed');
                err.response = { attributes: [] };
                throw err;
            }
        });

        const result = await searchCommand(connection, { all: true }, {});
        assert.equal(result, false);
    });
    it('Commands: search returns false for invalid query', async () => {
        const connection: any = createMockConnection({ state: 3 });

        const result = await searchCommand(connection, 'invalid-query' as any, {});
        assert.equal(result, false);
    });
    it('Commands: search error with serverResponseCode', async () => {
        let capturedErr: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                const err: any = new Error('Search failed');
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
                warn: (data: any) => {
                    capturedErr = data.err;
                },
                info: () => {},
                debug: () => {},
                trace: () => {},
                error: () => {}
            }
        });

        const result = await searchCommand(connection, { all: true }, {});
        assert.equal(result, false);
        assert.ok(capturedErr);
        assert.equal(capturedErr.serverResponseCode, 'CANNOT');
    });

    // ============================================
    // STORE Command Tests
    // ============================================
    it('Commands: store add flags', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        const result = await storeCommand(connection, '1:10', ['\\Seen'], { operation: 'add' });
        assert.equal(result, true);
        assert.equal(execArgs.cmd, 'STORE');
        assert.ok(execArgs!.attrs[1].value.startsWith('+'));
    });
    it('Commands: store drops the Recent flag from the wire', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        // \Recent is owned by the server (and removed entirely in IMAP4rev2) - a
        // client-side STORE must never try to set it
        const result = await storeCommand(connection, '1:10', ['\\Seen', '\\Recent'], { operation: 'add' });
        assert.equal(result, true);
        const attrsStr = JSON.stringify(execArgs.attrs);
        assert.ok(attrsStr.includes('\\\\Seen'));
        assert.ok(!attrsStr.toLowerCase().includes('recent'));
    });
    it('Commands: store remove flags', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        const result = await storeCommand(connection, '1:10', ['\\Seen'], { operation: 'remove' });
        assert.equal(result, true);
        assert.ok(execArgs.attrs[1].value.startsWith('-'));
    });
    it('Commands: store remove keeps a flag not in permanentFlags', async () => {
        // Mailbox permits only \Seen (no \*), so \Custom is not a permanent flag. Removal must still be
        // sent: a flag does not need to be permitted to be removed. Regression guard — the check used
        // to test the rewritten wire-form operation instead of options.operation and dropped the flag.
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { permanentFlags: new Set(['\\Seen']) },
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        const result = await storeCommand(connection, '1:10', ['\\Custom'], { operation: 'remove' });
        assert.equal(result, true);
        assert.ok(execArgs, 'a STORE command should be issued');
        assert.equal(execArgs.attrs[1].value, '-FLAGS');
        assert.deepEqual(
            (execArgs as any).attrs[2].map((flag: any) => flag.value),
            ['\\Custom'],
            'the removed flag must be present in the command'
        );
    });
    it('Commands: store add drops a flag not in permanentFlags', async () => {
        // Control for the regression above: the permanentFlags guard must still apply to non-remove
        // operations. Adding a flag the mailbox does not permit yields no command and a false result.
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { permanentFlags: new Set(['\\Seen']) },
            exec: async () => {
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await storeCommand(connection, '1:10', ['\\Custom'], { operation: 'add' });
        assert.equal(result, false, 'adding a non-permitted flag should fail');
        assert.equal(execCalled, false, 'no STORE command should be issued');
    });
    it('Commands: store set flags', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        const result = await storeCommand(connection, '1:10', ['\\Seen'], { operation: 'set' });
        assert.equal(result, true);
        assert.ok(!execArgs.attrs[1].value.startsWith('+'));
        assert.ok(!execArgs!.attrs[1].value.startsWith('-'));
    });
    it('Commands: store with UID', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        await storeCommand(connection, '100', ['\\Flagged'], { uid: true });
        assert.equal(execCmd, 'UID STORE');
    });
    it('Commands: store with silent', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        await storeCommand(connection, '1', ['\\Seen'], { silent: true });
        assert.ok(execArgs.attrs[1].value.includes('.SILENT'));
    });
    it('Commands: store with Gmail labels', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['X-GM-EXT-1', true]]),
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        await storeCommand(connection, '1', ['Important'], { useLabels: true });
        assert.ok(execArgs.attrs[1].value.includes('X-GM-LABELS'));
    });
    it('Commands: store skips when labels not supported', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map() // No X-GM-EXT-1
        });

        const result = await storeCommand(connection, '1', ['Label'], { useLabels: true });
        assert.equal(result, false);
    });
    it('Commands: store skips when not selected', async () => {
        const connection: any = createMockConnection({ state: 2 });

        const result = await storeCommand(connection, '1:10', ['\\Seen'], {});
        assert.equal(result, false);
    });
    it('Commands: store skips when no range', async () => {
        const connection: any = createMockConnection({ state: 3 });

        const result = await storeCommand(connection, null as any, ['\\Seen'], {});
        assert.equal(result, false);
    });
    it('Commands: store with CONDSTORE', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            enabled: new Set(['CONDSTORE']),
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        await storeCommand(connection, '1', ['\\Seen'], { unchangedSince: 12345 });
        assert.ok(execArgs.attrs.some((a: any) => Array.isArray(a) && a.some(x => x.value === 'UNCHANGEDSINCE')));
    });
    it('Commands: store handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                const err: any = new Error('Store failed');
                err.response = { attributes: [] };
                throw err;
            }
        });

        const result = await storeCommand(connection, '1', ['\\Seen'], {});
        assert.equal(result, false);
    });
    it('Commands: store error with serverResponseCode', async () => {
        let capturedErr: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                const err: any = new Error('Store failed');
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
                warn: (data: any) => {
                    capturedErr = data.err;
                }
            }
        });

        const result = await storeCommand(connection, '1', ['\\Seen'], {});
        assert.equal(result, false);
        assert.ok(capturedErr);
        assert.equal(capturedErr.serverResponseCode, 'CANNOT');
    });
    it('Commands: store filters flags that cannot be used', async () => {
        let execAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: {
                permanentFlags: new Set(['\\Seen']) // Only \\Seen is allowed
            },
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {} };
            }
        });

        // Try to add \\Deleted which is not in permanentFlags
        const result = await storeCommand(connection, '1', ['\\Seen', '\\Deleted'], { operation: 'add' });
        assert.equal(result, true);
        assert.ok(execAttrs);
        // Flags list should only contain \\Seen
        const flagsList: any = execAttrs[2];
        assert.equal(flagsList.length, 1);
        assert.equal((flagsList[0] as any).value, '\\Seen');
    });
    it('Commands: store remove operation uses minus prefix', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {} };
            }
        });

        const result = await storeCommand(connection, '1', ['\\Seen', '\\Deleted'], { operation: 'remove' });
        assert.equal(result, true);
        assert.ok(execAttrs);
        // Remove operation should use -FLAGS prefix
        assert.equal(execAttrs[1].value, '-FLAGS');
        const flagsList: any = execAttrs[2];
        assert.equal(flagsList.length, 2);
    });
    it('Commands: store returns false when no valid flags for add', async () => {
        const connection: any = createMockConnection({
            state: 3,
            mailbox: {
                permanentFlags: new Set() // No flags allowed
            }
        });

        // All flags get filtered out
        const result = await storeCommand(connection, '1', ['\\Seen', '\\Deleted'], { operation: 'add' });
        assert.equal(result, false);
    });
    it('Commands: store allows empty flags for set operation', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
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
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: store returns false with empty flags for remove', async () => {
        const connection: any = createMockConnection({
            state: 3,
            mailbox: {
                permanentFlags: new Set()
            }
        });

        // Remove with no valid flags should return false (nothing to remove)
        const result = await storeCommand(connection, '1', [], { operation: 'remove' });
        assert.equal(result, false);
    });
    it('Commands: store default operation is add', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {} };
            }
        });

        await storeCommand(connection, '1', ['\\Seen'], {}); // No operation specified
        assert.ok(execAttrs);
        assert.equal(execAttrs[1].value, '+FLAGS');
    });
    it('Commands: store with labels uses X-GM-LABELS', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['X-GM-EXT-1', true]]),
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {} };
            }
        });

        await storeCommand(connection, '1', ['Important'], { useLabels: true, operation: 'add' });
        assert.ok(execAttrs);
        assert.equal(execAttrs[1].value, '+X-GM-LABELS');
    });
    it('Commands: store silent does not apply to labels', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['X-GM-EXT-1', true]]),
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {} };
            }
        });

        // When using labels, silent flag should not add .SILENT suffix
        await storeCommand(connection, '1', ['Important'], { useLabels: true, silent: true, operation: 'set' });
        assert.ok(execAttrs);
        assert.equal(execAttrs[1].value, 'X-GM-LABELS'); // Not X-GM-LABELS.SILENT
    });

    // ============================================
    // COPY Command Tests
    // ============================================
    it('Commands: copy success', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return {
                    next: () => {},
                    response: { attributes: [] }
                };
            }
        });

        const result = await copyCommand(connection, '1:10', 'Archive', {});
        assert.ok(result);
        assert.equal(result.destination, 'Archive');
        assert.equal(execArgs.cmd, 'COPY');
    });
    it('Commands: copy with UID', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await copyCommand(connection, '100', 'Archive', { uid: true });
        assert.equal(execCmd, 'UID COPY');
    });
    it('Commands: copy with COPYUID response', async () => {
        const connection: any = createMockConnection({
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

        const result: any = await copyCommand(connection, '1:3', 'Archive', {});
        assert.ok((result as any).uidValidity);
        assert.ok((result as any)!.uidMap instanceof Map);
        assert.equal((result as any)!.uidMap.get(1), 100);
        assert.equal((result as any)!.uidMap.get(2), 101);
        assert.equal((result as any)!.uidMap.get(3), 102);
    });
    it('Commands: copy skips when not selected', async () => {
        const connection: any = createMockConnection({ state: 2 });

        const result = await copyCommand(connection, '1:10', 'Archive', {});
        assert.equal(result, undefined);
    });
    it('Commands: copy skips when no range', async () => {
        const connection: any = createMockConnection({ state: 3 });

        const result = await copyCommand(connection, null as any, 'Archive', {});
        assert.equal(result, undefined);
    });
    it('Commands: copy skips when no destination', async () => {
        const connection: any = createMockConnection({ state: 3 });

        const result = await copyCommand(connection, '1:10', null as any, {});
        assert.equal(result, undefined);
    });
    it('Commands: copy handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                const err: any = new Error('Copy failed');
                err.response = { attributes: [] };
                throw err;
            }
        });

        const result = await copyCommand(connection, '1:10', 'Archive', {});
        assert.equal(result, false);
    });
    it('Commands: copy error with serverResponseCode', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                const err: any = new Error('Copy failed');
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
        assert.equal(result, false);
    });
    it('Commands: copy with partial COPYUID response', async () => {
        const connection: any = createMockConnection({
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
        assert.ok(result);
        assert.equal(result.path, 'INBOX');
        assert.equal(result.destination, 'Archive');
        assert.equal(result.uidValidity, 12345n);
        assert.equal(result.uidMap, undefined);
    });
    it('Commands: copy with invalid uidValidity', async () => {
        const connection: any = createMockConnection({
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
        assert.ok(result);
        assert.equal(result.uidValidity, undefined);
    });
    it('Commands: copy with mismatched UID counts', async () => {
        const connection: any = createMockConnection({
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
        assert.ok(result);
        assert.equal(result.uidValidity, 12345n);
        assert.equal(result.uidMap, undefined); // Not set due to mismatch
    });
    it('Commands: copy with non-COPYUID response code', async () => {
        const connection: any = createMockConnection({
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
        assert.ok(result);
        assert.equal(result.path, 'INBOX');
        assert.equal(result.destination, 'Archive');
        assert.equal(result.uidValidity, undefined);
        assert.equal(result.uidMap, undefined);
    });

    // ============================================
    // MOVE Command Tests
    // ============================================
    it('Commands: move with MOVE capability', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['MOVE', true]]),
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await moveCommand(connection, '1:10', 'Archive', {});
        assert.equal(execCmd, 'MOVE');
    });
    it('Commands: move with UID and MOVE capability', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['MOVE', true]]),
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await moveCommand(connection, '100', 'Archive', { uid: true });
        assert.equal(execCmd, 'UID MOVE');
    });
    it('Commands: move uses MOVE via folded rev2 capability', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3,
            // No MOVE token - RFC 9051 folds MOVE into base IMAP4rev2
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await moveCommand(connection, '1:10', 'Archive', {});
        assert.equal(execCmd, 'MOVE');
    });
    it('Commands: move skips when not selected', async () => {
        const connection: any = createMockConnection({ state: 2 });

        const result = await moveCommand(connection, '1:10', 'Archive', {});
        assert.equal(result, undefined);
    });
    it('Commands: move skips when no range', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['MOVE', true]])
        });

        const result = await moveCommand(connection, null as any, 'Archive', {});
        assert.equal(result, undefined);
    });
    it('Commands: move skips when no destination', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['MOVE', true]])
        });

        const result = await moveCommand(connection, '1:10', null as any, {});
        assert.equal(result, undefined);
    });
    it('Commands: move fallback without MOVE capability', async () => {
        let copyCalled = false;
        let deleteCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(), // No MOVE capability
            messageCopy: async (range: any, dest: any) => {
                copyCalled = true;
                assert.equal(range, '1:10');
                assert.equal(dest, 'Archive');
                return { path: 'INBOX', destination: 'Archive' };
            },
            messageDelete: async (range: any, opts: any) => {
                deleteCalled = true;
                assert.equal(range, '1:10');
                assert.equal(opts.silent, true);
                return true;
            }
        });

        const result: any = await moveCommand(connection, '1:10', 'Archive', {});
        assert.ok(copyCalled);
        assert.ok(deleteCalled);
        assert.equal((result as any).destination, 'Archive');
    });
    it('Commands: move fallback passes options', async () => {
        let copyOpts: any = null;
        let deleteOpts: any = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(), // No MOVE capability
            messageCopy: async (range: any, dest: any, opts: any) => {
                copyOpts = opts;
                return { path: 'INBOX', destination: dest };
            },
            messageDelete: async (range: any, opts: any) => {
                deleteOpts = opts;
                return true;
            }
        });

        await moveCommand(connection, '1:10', 'Archive', { uid: true });
        assert.equal(copyOpts.uid, true);
        assert.equal(deleteOpts.uid, true);
        assert.equal(deleteOpts!.silent, true);
    });
    it('Commands: move with COPYUID response', async () => {
        const connection: any = createMockConnection({
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

        const result: any = await moveCommand(connection, '1:3', 'Archive', {});
        assert.ok((result as any).uidValidity);
        assert.equal((result as any)!.uidValidity, BigInt(12345));
        assert.ok((result as any)!.uidMap instanceof Map);
        assert.equal((result as any)!.uidMap.get(1), 100);
        assert.equal((result as any)!.uidMap.get(2), 101);
        assert.equal((result as any)!.uidMap.get(3), 102);
    });
    it('Commands: move handles COPYUID in untagged response', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['MOVE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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

        const result: any = await moveCommand(connection, '5:7', 'Archive', {});
        assert.ok((result as any).uidMap instanceof Map);
        assert.equal((result as any)!.uidMap.get(5), 200);
        assert.equal((result as any)!.uidMap.get(6), 201);
        assert.equal((result as any)!.uidMap.get(7), 202);
    });
    it('Commands: move returns correct map structure', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['MOVE', true]]),
            exec: async () => ({
                next: () => {},
                response: { attributes: [] }
            })
        });

        const result: any = await moveCommand(connection, '1:10', 'Archive', {});
        assert.equal((result as any).path, 'INBOX');
        assert.equal((result as any)!.destination, 'Archive');
    });
    it('Commands: move handles error', async () => {
        let warnLogged = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['MOVE', true]]),
            exec: async () => {
                const err: any = new Error('Move failed');
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
        assert.equal(result, false);
        assert.ok(warnLogged);
    });
    it('Commands: move handles error with status code', async () => {
        let capturedErr = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['MOVE', true]]),
            exec: async () => {
                const err: any = new Error('Move failed');
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
                warn: (msg: any) => {
                    capturedErr = msg;
                },
                debug: () => {},
                trace: () => {}
            }
        });

        const result = await moveCommand(connection, '1:10', 'NonExistent', {});
        assert.equal(result, false);
        assert.ok(capturedErr);
    });
    it('Commands: move normalizes destination path', async () => {
        let capturedAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['MOVE', true]]),
            namespace: { delimiter: '/', prefix: 'INBOX/' },
            exec: async (cmd: any, attrs: any) => {
                capturedAttrs = attrs;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await moveCommand(connection, '1:10', 'Archive', {});
        // The destination should be normalized
        assert.ok(capturedAttrs);
    });
    it('Commands: move handles COPYUID with invalid uidValidity', async () => {
        const connection: any = createMockConnection({
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
        assert.ok(result);
        assert.equal(result.uidValidity, undefined);
    });
    it('Commands: move handles COPYUID with mismatched UID counts', async () => {
        const connection: any = createMockConnection({
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
        assert.ok(result);
        assert.equal(result.uidValidity, BigInt(12345));
        assert.equal(result.uidMap, undefined); // Not set due to mismatch
    });
    it('Commands: move handles COPYUID with missing source/destination UIDs', async () => {
        const connection: any = createMockConnection({
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
        assert.ok(result);
        assert.equal(result.uidMap, undefined);
    });

    // ============================================
    // EXPUNGE Command Tests
    // ============================================
    it('Commands: expunge success', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any) => {
                assert.equal(cmd, 'EXPUNGE');
                execCalled = true;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: expunge with UID range', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['UIDPLUS', true]]),
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await expungeCommand(connection, '1:100', { uid: true });
        assert.equal(execCmd, 'UID EXPUNGE');
    });
    it('Commands: expunge uses UID EXPUNGE via folded rev2 capability', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3,
            // No UIDPLUS token - RFC 9051 folds UIDPLUS into base IMAP4rev2. Falling
            // back to plain EXPUNGE here would purge every \Deleted message instead
            // of only the requested range.
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await expungeCommand(connection, '1:100', { uid: true });
        assert.equal(execCmd, 'UID EXPUNGE');
    });
    it('Commands: expunge skips when not selected', async () => {
        const connection: any = createMockConnection({ state: 2 });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, undefined);
    });
    it('Commands: expunge skips when no range', async () => {
        const connection: any = createMockConnection({ state: 3 });

        const result = await expungeCommand(connection, null as any, {});
        assert.equal(result, undefined);
    });
    it('Commands: expunge handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                const err: any = new Error('Expunge failed');
                err.response = { attributes: [] };
                throw err;
            }
        });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, false);
    });
    it('Commands: expunge parses HIGHESTMODSEQ response', async () => {
        const connection: any = createMockConnection({
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
        assert.equal(result, true);
        assert.equal(connection.mailbox.highestModseq, 9122n);
    });
    it('Commands: expunge does not update lower HIGHESTMODSEQ', async () => {
        const connection: any = createMockConnection({
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
        assert.equal(result, true);
        assert.equal(connection.mailbox.highestModseq, 10000n); // Should not be updated
    });
    it('Commands: expunge handles invalid HIGHESTMODSEQ value', async () => {
        const connection: any = createMockConnection({
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
        assert.equal(result, true);
        assert.equal(connection.mailbox.highestModseq, 100n); // Should not be updated
    });
    it('Commands: expunge updates HIGHESTMODSEQ when mailbox has none', async () => {
        const connection: any = createMockConnection({
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
        assert.equal(result, true);
        assert.equal(connection.mailbox.highestModseq, 500n);
    });
    it('Commands: expunge error with serverResponseCode', async () => {
        let capturedErr: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                const err: any = new Error('Expunge failed');
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
                warn: (data: any) => {
                    capturedErr = data.err;
                }
            }
        });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, false);
        assert.ok(capturedErr);
        assert.equal(capturedErr.serverResponseCode, 'CANNOT');
    });
    it('Commands: expunge without UID when UIDPLUS not available', async () => {
        let execCmd = null;
        let execAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(), // No UIDPLUS
            exec: async (cmd: any, attrs: any) => {
                execCmd = cmd;
                execAttrs = attrs;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await expungeCommand(connection, '1:100', { uid: true });
        assert.equal(execCmd, 'EXPUNGE'); // Falls back to EXPUNGE
        assert.equal(execAttrs, false); // No attributes for regular EXPUNGE
    });
    it('Commands: expunge with UID EXPUNGE includes range', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['UIDPLUS', true]]),
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await expungeCommand(connection, '1:50', { uid: true });
        assert.ok(execAttrs);
        assert.equal(execAttrs[0].type, 'SEQUENCE');
        assert.equal((execAttrs[0] as any).value, '1:50');
    });
    it('Commands: expunge with non-HIGHESTMODSEQ response code', async () => {
        const connection: any = createMockConnection({
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
        assert.equal(result, true);
        assert.equal(connection.mailbox.highestModseq, 100n); // Should not be updated
    });

    // ============================================
    // CREATE Command Tests
    // ============================================
    it('Commands: create success', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        const result = await createCommand(connection, 'NewFolder');
        assert.ok(result);
        assert.equal(result.created, true);
        assert.equal(execArgs.cmd, 'CREATE');
    });
    it('Commands: create skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 });

        const result = await createCommand(connection, 'NewFolder');
        assert.equal(result, undefined);
    });
    it('Commands: create handles ALREADYEXISTS', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Mailbox already exists');
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
        assert.ok(result);
        assert.equal(result.created, false);
    });
    it('Commands: create throws on other errors', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Create failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('Create failed'));
        }
    });

    // ============================================
    // DELETE Command Tests
    // ============================================
    it('Commands: delete success', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await deleteCommand(connection, 'OldFolder');
        assert.ok(result);
        assert.equal(result.path, 'OldFolder');
        assert.equal(execCmd, 'DELETE');
    });
    it('Commands: delete skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 });

        const result = await deleteCommand(connection, 'OldFolder');
        assert.equal(result, undefined);
    });
    it('Commands: delete throws on error', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Delete failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('Delete failed'));
        }
    });
    it('Commands: delete closes mailbox when deleting current mailbox', async () => {
        let closeCalled = false;
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'FolderToDelete' },
            run: async (cmd: any) => {
                if (cmd === 'CLOSE') {
                    closeCalled = true;
                }
            },
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await deleteCommand(connection, 'FolderToDelete');
        assert.ok(closeCalled, 'CLOSE should be called');
        assert.equal(execCmd, 'DELETE');
        assert.ok(result);
        assert.equal(result.path, 'FolderToDelete');
    });
    it('Commands: delete does not close when deleting different mailbox', async () => {
        let closeCalled = false;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'INBOX' },
            run: async (cmd: any) => {
                if (cmd === 'CLOSE') {
                    closeCalled = true;
                }
            },
            exec: async () => ({ next: () => {} })
        });

        const result = await deleteCommand(connection, 'OtherFolder');
        assert.ok(!closeCalled, 'CLOSE should not be called');
        assert.ok(result);
        assert.equal(result.path, 'OtherFolder');
    });
    it('Commands: delete works in SELECTED state', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'INBOX' },
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await deleteCommand(connection, 'SomeFolder');
        assert.ok(result);
        assert.equal(execCmd, 'DELETE');
    });
    it('Commands: delete error with serverResponseCode', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Delete failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.serverResponseCode, 'NONEXISTENT');
        }
    });
    it('Commands: delete normalizes path', async () => {
        let execArgs = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, args: any) => {
                execArgs = args;
                return { next: () => {} };
            }
        });

        const result = await deleteCommand(connection, 'INBOX/Subfolder');
        assert.ok(result);
        assert.equal(result.path, 'INBOX/Subfolder');
        assert.ok(execArgs);
    });

    // ============================================
    // RENAME Command Tests
    // ============================================
    it('Commands: rename success', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        const result = await renameCommand(connection, 'OldName', 'NewName');
        assert.ok(result);
        assert.equal(result.path, 'OldName');
        assert.equal(result.newPath, 'NewName');
        assert.equal(execArgs.cmd, 'RENAME');
    });
    it('Commands: rename skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 });

        const result = await renameCommand(connection, 'OldName', 'NewName');
        assert.equal(result, undefined);
    });
    it('Commands: rename throws on error', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Rename failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('Rename failed'));
        }
    });
    it('Commands: rename closes mailbox when renaming current mailbox', async () => {
        let closeCalled = false;
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'OldFolder' },
            run: async (cmd: any) => {
                if (cmd === 'CLOSE') {
                    closeCalled = true;
                }
            },
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await renameCommand(connection, 'OldFolder', 'NewFolder');
        assert.ok(closeCalled, 'CLOSE should be called');
        assert.equal(execCmd, 'RENAME');
        assert.ok(result);
        assert.equal(result.path, 'OldFolder');
        assert.equal(result.newPath, 'NewFolder');
    });
    it('Commands: rename does not close when renaming different mailbox', async () => {
        let closeCalled = false;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'INBOX' },
            run: async (cmd: any) => {
                if (cmd === 'CLOSE') {
                    closeCalled = true;
                }
            },
            exec: async () => ({ next: () => {} })
        });

        const result = await renameCommand(connection, 'OtherFolder', 'NewName');
        assert.ok(!closeCalled, 'CLOSE should not be called');
        assert.ok(result);
    });
    it('Commands: rename works in SELECTED state', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'INBOX' },
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await renameCommand(connection, 'SomeFolder', 'NewName');
        assert.ok(result);
        assert.equal(execCmd, 'RENAME');
    });
    it('Commands: rename error with serverResponseCode', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Rename failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.serverResponseCode, 'NONEXISTENT');
        }
    });
    it('Commands: rename normalizes paths', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, args: any) => {
                execArgs = args;
                return { next: () => {} };
            }
        });

        const result = await renameCommand(connection, 'INBOX/Old', 'INBOX/New');
        assert.ok(result);
        assert.equal(result.path, 'INBOX/Old');
        assert.equal(result.newPath, 'INBOX/New');
        assert.ok(execArgs);
        assert.equal(execArgs.length, 2);
    });

    // ============================================
    // SUBSCRIBE/UNSUBSCRIBE Command Tests
    // ============================================
    it('Commands: subscribe success', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await subscribeCommand(connection, 'Folder');
        assert.equal(result, true);
        assert.equal(execCmd, 'SUBSCRIBE');
    });
    it('Commands: subscribe skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 });

        const result = await subscribeCommand(connection, 'Folder');
        assert.equal(result, undefined);
    });
    it('Commands: unsubscribe success', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await unsubscribeCommand(connection, 'Folder');
        assert.equal(result, true);
        assert.equal(execCmd, 'UNSUBSCRIBE');
    });
    it('Commands: unsubscribe skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 });

        const result = await unsubscribeCommand(connection, 'Folder');
        assert.equal(result, undefined);
    });
    it('Commands: subscribe works in SELECTED state', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await subscribeCommand(connection, 'Folder');
        assert.equal(result, true);
        assert.equal(execCmd, 'SUBSCRIBE');
    });
    it('Commands: subscribe returns false on error', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Subscribe failed');
                err.response = {
                    tag: '*',
                    command: 'NO',
                    attributes: [{ type: 'TEXT', value: 'Subscribe failed' }]
                };
                throw err;
            }
        });

        const result = await subscribeCommand(connection, 'Folder');
        assert.equal(result, false);
    });
    it('Commands: subscribe error with serverResponseCode', async () => {
        let capturedErr: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Subscribe failed');
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
                warn: (data: any) => {
                    capturedErr = data.err;
                }
            }
        });

        const result = await subscribeCommand(connection, 'NonExistent');
        assert.equal(result, false);
        assert.ok(capturedErr);
        assert.equal(capturedErr.serverResponseCode, 'NONEXISTENT');
    });
    it('Commands: subscribe normalizes path', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, args: any) => {
                execArgs = args;
                return { next: () => {} };
            }
        });

        const result = await subscribeCommand(connection, 'INBOX/Subfolder');
        assert.equal(result, true);
        assert.ok(execArgs);
        assert.equal(execArgs.length, 1);
    });
    it('Commands: unsubscribe works in SELECTED state', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await unsubscribeCommand(connection, 'Folder');
        assert.equal(result, true);
        assert.equal(execCmd, 'UNSUBSCRIBE');
    });
    it('Commands: unsubscribe returns false on error', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Unsubscribe failed');
                err.response = {
                    tag: '*',
                    command: 'NO',
                    attributes: [{ type: 'TEXT', value: 'Unsubscribe failed' }]
                };
                throw err;
            }
        });

        const result = await unsubscribeCommand(connection, 'Folder');
        assert.equal(result, false);
    });
    it('Commands: unsubscribe error with serverResponseCode', async () => {
        let capturedErr: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Unsubscribe failed');
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
                warn: (data: any) => {
                    capturedErr = data.err;
                }
            }
        });

        const result = await unsubscribeCommand(connection, 'NonExistent');
        assert.equal(result, false);
        assert.ok(capturedErr);
        assert.equal(capturedErr.serverResponseCode, 'NONEXISTENT');
    });
    it('Commands: unsubscribe normalizes path', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, args: any) => {
                execArgs = args;
                return { next: () => {} };
            }
        });

        const result = await unsubscribeCommand(connection, 'INBOX/Subfolder');
        assert.equal(result, true);
        assert.ok(execArgs);
        assert.equal(execArgs.length, 1);
    });

    // ============================================
    // ENABLE Command Tests
    // ============================================
    it('Commands: enable success', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            exec: async () => ({ next: () => {} })
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        // Returns Set of enabled extensions
        assert.ok(result instanceof Set);
    });
    it('Commands: enable skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.equal(result, undefined);
    });
    it('Commands: enable skips when ENABLE not supported', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map() // No ENABLE capability
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.equal(result, undefined);
    });
    it('Commands: enable handles error', async () => {
        const connection: any = createMockConnection({
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
        assert.equal(result, false);
    });
    it('Commands: enable passes IMAP4rev2 through the capability prefilter', async () => {
        let enableAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['IMAP4rev1', true],
                // Canonical mixed-case key as stored by updateCapabilities
                ['IMAP4rev2', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                enableAttrs = attrs;
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({ attributes: [{ value: 'IMAP4rev2' }] });
                }
                return { next: () => {} };
            }
        });

        const result: any = await enableCommand(connection, ['IMAP4rev2']);
        // The mixed-case capability key must not trip the case-sensitive lookup
        assert.ok(enableAttrs);
        assert.ok(enableAttrs.some((attr: any) => attr.value === 'IMAP4REV2'));
        assert.ok((result as any).has('IMAP4REV2'));
    });
    it('Commands: enable merges into previously enabled extensions', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['IMAP4rev1', true],
                ['IMAP4rev2', true]
            ]),
            enabled: new Set(['CONDSTORE']),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({ attributes: [{ value: 'IMAP4rev2' }] });
                }
                return { next: () => {} };
            }
        });

        await enableCommand(connection, ['IMAP4rev2']);
        // The ENABLED response only lists newly enabled extensions - earlier grants
        // must survive
        assert.ok(connection.enabled.has('CONDSTORE'));
        assert.ok(connection.enabled.has('IMAP4REV2'));
    });
    it('Commands: enable works without the ENABLE token on rev2-only servers', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 2,
            // ENABLE is part of base IMAP4rev2 - rev2-only servers may omit the token
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                execCalled = true;
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({ attributes: [{ value: 'IMAP4rev2' }] });
                }
                return { next: () => {} };
            }
        });

        const result: any = await enableCommand(connection, ['IMAP4rev2']);
        assert.equal(execCalled, true);
        assert.ok((result as any).has('IMAP4REV2'));
    });

    // ============================================
    // COMPRESS Command Tests
    // ============================================
    it('Commands: compress success', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            capabilities: new Map([['COMPRESS=DEFLATE', true]]),
            exec: async () => {
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await compressCommand(connection);
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: compress skips when not supported', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map() // No COMPRESS=DEFLATE
        });

        const result = await compressCommand(connection);
        // Returns false when not supported (not undefined)
        assert.equal(result, false);
    });
    it('Commands: compress handles error', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['COMPRESS=DEFLATE', true]]),
            exec: async () => {
                throw new Error('Compress failed');
            }
        });

        const result = await compressCommand(connection);
        assert.equal(result, false);
    });
    it('Commands: compress fails the connection on trailing data', async () => {
        // Per RFC 4978 the server switches to DEFLATE at its tagged OK, so data already
        // buffered behind the OK was consumed as cleartext and the deflate stream is
        // truncated. Declining the upgrade is not a protocol option at that point - the
        // session is unrecoverable in both directions and must fail closed.
        let closeAfterCalled = false;
        let nextCalled = false;
        const connection: any = createMockConnection({
            capabilities: new Map([['COMPRESS=DEFLATE', true]]),
            closeAfter: () => {
                closeAfterCalled = true;
            },
            exec: async () => ({
                hasTrailingData: true,
                next: () => {
                    nextCalled = true;
                    assert.ok(closeAfterCalled, 'teardown must be scheduled before parser backpressure is released');
                }
            })
        });

        let err: any = null;
        try {
            await compressCommand(connection);
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'compress must throw');
        assert.equal(err && err.code, 'COMPRESS_TRAILING_DATA');
        assert.ok(closeAfterCalled, 'the connection must be closed');
        assert.ok(nextCalled, 'parser backpressure must still be released');
    });

    // ============================================
    // STARTTLS Command Tests
    // ============================================
    it('Commands: starttls success', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            capabilities: new Map([['STARTTLS', true]]),
            exec: async () => {
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await starttlsCommand(connection);
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: starttls skips when not supported', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map() // No STARTTLS
        });

        const result = await starttlsCommand(connection);
        // Returns false when not supported (not undefined)
        assert.equal(result, false);
    });
    it('Commands: starttls handles error', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['STARTTLS', true]]),
            exec: async () => {
                throw new Error('STARTTLS failed');
            }
        });

        const result = await starttlsCommand(connection);
        assert.equal(result, false);
    });

    // ============================================
    // FETCH Command Tests
    // ============================================
    it('Commands: fetch basic query', async () => {
        let execCalled = false;
        let execCommand = '';
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(execCalled, true);
        assert.equal(execCommand, 'FETCH');
        assert.ok(result);
        assert.equal(result.count, 1);
        assert.ok(Array.isArray(result.list));
    });
    it('Commands: fetch with UID option', async () => {
        let execCommand = '';
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any) => {
                execCommand = cmd;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1:*', { uid: true }, { uid: true });
        assert.equal(execCommand, 'UID FETCH');
    });
    it('Commands: fetch skips when not selected', async () => {
        const connection: any = createMockConnection({ state: 2 }); // AUTHENTICATED, not SELECTED

        const result = await fetchCommand(connection, '1:*', { uid: true });
        assert.equal(result, undefined);
    });
    it('Commands: fetch skips when no range', async () => {
        const connection: any = createMockConnection({ state: 3 });

        const result = await fetchCommand(connection, null as any, { uid: true });
        assert.equal(result, undefined);
    });
    it('Commands: fetch with envelope query', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { envelope: true });
        assert.ok(queryAttrs);
        // Check that ENVELOPE is in the query
        const hasEnvelope = JSON.stringify(queryAttrs).includes('ENVELOPE');
        assert.ok(hasEnvelope);
    });
    it('Commands: fetch with bodyStructure query', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { bodyStructure: true });
        assert.ok(queryAttrs);
        const hasBODYSTRUCTURE = JSON.stringify(queryAttrs).includes('BODYSTRUCTURE');
        assert.ok(hasBODYSTRUCTURE);
    });
    it('Commands: fetch with size query', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { size: true });
        assert.ok(queryAttrs);
        const hasRFC822SIZE = JSON.stringify(queryAttrs).includes('RFC822.SIZE');
        assert.ok(hasRFC822SIZE);
    });
    it('Commands: fetch with source query', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { source: true });
        assert.ok(queryAttrs);
        const hasBODYPEEK = JSON.stringify(queryAttrs).includes('BODY.PEEK');
        assert.ok(hasBODYPEEK);
    });
    it('Commands: fetch with source partial', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { source: { start: 0, maxLength: 1024 } });
        assert.ok(queryAttrs);
        // Partial should be set
        const queryStr = JSON.stringify(queryAttrs);
        assert.ok(queryStr.includes('BODY.PEEK'));
    });
    it('Commands: fetch with BINARY capability', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['BINARY', true]]),
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { source: true }, { binary: true });
        assert.ok(queryAttrs);
        const hasBINARYPEEK = JSON.stringify(queryAttrs).includes('BINARY.PEEK');
        assert.ok(hasBINARYPEEK);
    });
    it('Commands: fetch with binary uses BINARY on rev2-only servers without the token', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            // rev2-only server: no BINARY token, but RFC 9051 folds the FETCH side of
            // the BINARY extension into base IMAP4rev2
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { source: true }, { binary: true });
        assert.ok(queryAttrs);
        assert.ok(JSON.stringify(queryAttrs).includes('BINARY.PEEK'));
    });
    it('Commands: fetch with binary keeps BODY for non-numeric sections', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['BINARY', true]]),
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        // RFC 3516/RFC 9051: section-binary only allows numeric part specifiers -
        // BINARY[HEADER], BINARY[TEXT] and BINARY[n.MIME] are invalid syntax that
        // servers reject, so those sections must stay BODY fetches even with
        // options.binary set
        await fetchCommand(connection, '1', { headers: true, bodyParts: ['TEXT', '1.MIME', '1.2'] }, { binary: true });
        assert.ok(queryAttrs);
        const sections: any = [];
        const walk = (list: any) => {
            for (let entry of Array.isArray(list) ? list : [list]) {
                if (Array.isArray(entry)) {
                    walk(entry);
                } else if (entry && entry.section) {
                    sections.push({ value: entry.value, section: entry.section.length ? entry.section[0].value : '' });
                }
            }
        };
        walk(queryAttrs);

        for (let entry of sections) {
            if (['HEADER', 'TEXT', '1.MIME'].includes(entry.section)) {
                assert.equal(entry.value, 'BODY.PEEK', `${entry.section} must be fetched via BODY.PEEK`);
            }
            if (entry.section === '1.2') {
                assert.equal(entry.value, 'BINARY.PEEK', 'numeric part specifiers may use BINARY.PEEK');
            }
        }
        assert.ok(
            sections.some((entry: any) => entry.section === '1.2'),
            'numeric body part present'
        );
        assert.ok(
            sections.some((entry: any) => entry.section === 'TEXT'),
            'TEXT body part present'
        );
    });
    it('Commands: fetch with binary keeps BODY on unenabled dual rev1+rev2 servers', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            // dual server without ENABLE IMAP4rev2 - rev2 semantics are not active, so
            // the BINARY fold must not apply
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['IMAP4rev2', true]
            ]),
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { source: true }, { binary: true });
        assert.ok(queryAttrs);
        const queryStr = JSON.stringify(queryAttrs);
        assert.ok(queryStr.includes('BODY.PEEK'));
        assert.ok(!queryStr.includes('BINARY.PEEK'));
    });
    it('Commands: fetch with OBJECTID capability', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['OBJECTID', true]]),
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { flags: true });
        assert.ok(queryAttrs);
        const hasEMAILID = JSON.stringify(queryAttrs).includes('EMAILID');
        assert.ok(hasEMAILID);
    });
    it('Commands: fetch with X-GM-EXT-1 capability', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['X-GM-EXT-1', true]]),
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { flags: true });
        assert.ok(queryAttrs);
        const hasXGMMSGID = JSON.stringify(queryAttrs).includes('X-GM-MSGID');
        assert.ok(hasXGMMSGID);
    });
    it('Commands: fetch with threadId query', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['OBJECTID', true]]),
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { threadId: true });
        assert.ok(queryAttrs);
        const hasTHREADID = JSON.stringify(queryAttrs).includes('THREADID');
        assert.ok(hasTHREADID);
    });
    it('Commands: fetch with threadId and X-GM-EXT-1 fallback', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['X-GM-EXT-1', true]]), // No OBJECTID, but has X-GM-EXT-1
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { threadId: true });
        assert.ok(queryAttrs);
        const hasXGMTHRID = JSON.stringify(queryAttrs).includes('X-GM-THRID');
        assert.ok(hasXGMTHRID, 'Should use X-GM-THRID as fallback for threadId');
    });
    it('Commands: fetch with labels query', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['X-GM-EXT-1', true]]),
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { labels: true });
        assert.ok(queryAttrs);
        const hasXGMLABELS = JSON.stringify(queryAttrs).includes('X-GM-LABELS');
        assert.ok(hasXGMLABELS);
    });
    it('Commands: fetch with CONDSTORE enabled', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            enabled: new Set(['CONDSTORE']),
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { flags: true });
        assert.ok(queryAttrs);
        const hasMODSEQ = JSON.stringify(queryAttrs).includes('MODSEQ');
        assert.ok(hasMODSEQ);
    });
    it('Commands: fetch with headers array', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { headers: ['Subject', 'From', 'To'] });
        assert.ok(queryAttrs);
        const queryStr = JSON.stringify(queryAttrs);
        assert.ok(queryStr.includes('HEADER.FIELDS'));
    });
    it('Commands: fetch with headers true', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { headers: true });
        assert.ok(queryAttrs);
        const queryStr = JSON.stringify(queryAttrs);
        assert.ok(queryStr.includes('HEADER'));
    });
    it('Commands: fetch with bodyParts', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { bodyParts: ['1', '2'] });
        assert.ok(queryAttrs);
        const queryStr = JSON.stringify(queryAttrs);
        assert.ok(queryStr.includes('BODY.PEEK'));
    });
    it('Commands: fetch with bodyParts object', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { bodyParts: [{ key: '1', start: 0, maxLength: 100 }] });
        assert.ok(queryAttrs);
        const queryStr = JSON.stringify(queryAttrs);
        assert.ok(queryStr.includes('BODY.PEEK'));
    });
    it('Commands: fetch with bodyParts skips invalid', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        // Invalid entries: null, object without key, number
        await fetchCommand(connection, '1', { bodyParts: [null, { noKey: true }, 123, '1'] } as any);
        assert.ok(queryAttrs);
        // Should still work - just skips invalid entries
    });
    it('Commands: fetch with changedSince', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            enabled: new Set(['CONDSTORE']),
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { flags: true }, { changedSince: '12345' });
        assert.ok(queryAttrs);
        const queryStr = JSON.stringify(queryAttrs);
        assert.ok(queryStr.includes('CHANGEDSINCE'));
    });
    it('Commands: fetch with changedSince and QRESYNC', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            enabled: new Set(['CONDSTORE', 'QRESYNC']),
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { flags: true }, { changedSince: '12345', uid: true });
        assert.ok(queryAttrs);
        const queryStr = JSON.stringify(queryAttrs);
        assert.ok(queryStr.includes('VANISHED'));
    });
    it('Commands: fetch with onUntaggedFetch callback', async () => {
        let callbackCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(callbackCalled, true);
    });
    it('Commands: fetch callback error propagates', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.message, 'Callback error');
        }
    });
    it('Commands: fetch handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                throw new Error('Fetch failed');
            }
        });

        try {
            await fetchCommand(connection, '1', { uid: true });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.message, 'Fetch failed');
        }
    });
    it('Commands: fetch retries on throttle error', async () => {
        let attempts = 0;
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                attempts++;
                if (attempts < 3) {
                    const err: any = new Error('Throttled');
                    err.code = 'ETHROTTLE';
                    (err as any).throttleReset = 10; // 10ms for testing
                    throw err;
                }
                return { next: () => {} };
            }
        });

        const result = await fetchCommand(connection, '1', { uid: true });
        assert.ok(result);
        assert.equal(attempts, 3);
    });
    it('Commands: fetch with all/fast/full query', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                queryAttrs = attrs;
                return { next: () => {} };
            }
        });

        await fetchCommand(connection, '1', { all: true, fast: true, full: true, internalDate: true });
        assert.ok(queryAttrs);
        const queryStr = JSON.stringify(queryAttrs);
        assert.ok(queryStr.includes('ALL'));
        assert.ok(queryStr.includes('FAST'));
        assert.ok(queryStr.includes('FULL'));
        assert.ok(queryStr.includes('INTERNALDATE'));
    });

    // ============================================
    // LIST Command Tests
    // ============================================
    it('Commands: list basic', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(execCalled, true);
        assert.ok(Array.isArray(result));
    });
    it('Commands: list with XLIST capability', async () => {
        let usedListCommand = '';
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['XLIST', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(usedListCommand, 'XLIST');
    });
    it('Commands: list prefers LIST over XLIST when SPECIAL-USE available', async () => {
        let usedListCommand = '';
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['XLIST', true],
                ['SPECIAL-USE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(usedListCommand, 'LIST');
    });
    it('Commands: list with statusQuery', async () => {
        let listAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['LIST-STATUS', true],
                ['SPECIAL-USE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(listAttrs);
        const attrsStr = JSON.stringify(listAttrs);
        assert.ok(attrsStr.includes('RETURN'));
        assert.ok(attrsStr.includes('STATUS'));
        assert.ok(Array.isArray(result));
    });
    it('Commands: list statusQuery parses inline SIZE and DELETED on rev2 sessions', async () => {
        let listAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    listAttrs = attrs;
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                    if (opts && opts.untagged && opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [
                                { value: 'INBOX' },
                                [{ value: 'MESSAGES' }, { value: '10' }, { value: 'SIZE' }, { value: '12345678901234' }, { value: 'DELETED' }, { value: '3' }]
                            ]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', {
            statusQuery: { messages: true, size: true, deleted: true }
        });
        const attrsStr = JSON.stringify(listAttrs);
        assert.ok(attrsStr.includes('SIZE'));
        assert.ok(attrsStr.includes('DELETED'));
        const inbox: any = result.find(entry => entry.path === 'INBOX');
        assert.ok(inbox);
        assert.equal(inbox.status.messages, 10);
        // STATUS SIZE is a number64 - values beyond 2^32 must survive
        assert.strictEqual(inbox.status!.size, 12345678901234);
        assert.strictEqual(inbox.status!.deleted, 3);
    });
    it('Commands: list tolerates an OLDNAME extended data item', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // RFC 9051 6.3.9.7: a LIST response may carry an OLDNAME extended
                    // data item after a RENAME or name normalization - the client must
                    // parse the response without choking on the extra attribute
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'NewBox' }, [{ value: 'OLDNAME' }, [{ value: 'OldBox' }]]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const entry = result.find(folder => folder.path === 'NewBox');
        assert.ok(entry, 'mailbox with OLDNAME extended data must be listed');
        assert.ok(entry.flags.has('\\HasNoChildren'));
    });
    it('Commands: list with CONDSTORE status query', async () => {
        let listAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['LIST-STATUS', true],
                ['CONDSTORE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(listAttrs);
        const attrsStr = JSON.stringify(listAttrs);
        assert.ok(attrsStr.includes('HIGHESTMODSEQ'));
    });
    it('Commands: list with listOnly option', async () => {
        let lsubCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(lsubCalled, false);
        assert.ok(Array.isArray(result));
    });
    it('Commands: list with specialUseHints', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(Array.isArray(result));
        // The Sent Items folder should have specialUse set
        const sentFolder = result.find(e => e.path === 'Sent Items');
        assert.ok(sentFolder);
        assert.equal(sentFolder.specialUse, '\\Sent');
    });
    it('Commands: list handles INBOX specially', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(inbox);
        assert.equal(inbox.specialUse, '\\Inbox');
        // INBOX should always be subscribed
        assert.equal(inbox.subscribed, true);
    });
    it('Commands: list runs separate INBOX query when using namespace', async () => {
        let listCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(listCalls, 2);
    });
    it('Commands: list INBOX fixup propagates non-reducible failures', async () => {
        // Both sides of the fixup's retry guard: a NO on the extended call is an operational
        // failure (not a RETURN options rejection), and a BAD on a call that already ran plain
        // has no options left to reduce - neither may trigger the plain retry
        for (let { capabilities, status } of [
            {
                capabilities: [
                    ['IMAP4rev1', true],
                    ['LIST-EXTENDED', true]
                ],
                status: 'NO'
            },
            { capabilities: [['IMAP4rev1', true]], status: 'BAD' }
        ]) {
            let listCalls = 0;
            let lsubCalls = 0;
            const connection: any = createMockConnection({
                state: 3,
                capabilities: new (Map as any)(capabilities),
                exec: async (cmd: any, attrs: any) => {
                    if (cmd === 'LSUB') {
                        lsubCalls++;
                    }
                    if (cmd === 'LIST') {
                        listCalls++;
                        if (attrs[1] === 'INBOX') {
                            throw (commandError as any)('Command failed', status);
                        }
                    }
                    return { next: () => {} };
                }
            });

            try {
                await listCommand(connection, 'Mail/', '*');
                assert.ok(false, 'Should have thrown');
            } catch (err: any) {
                assert.equal(err.responseStatus, status);
            }
            // Main listing and the failed INBOX call - no plain retry, no LSUB merge
            assert.equal(listCalls, 2);
            assert.equal(lsubCalls, 0);
        }
    });
    it('Commands: list handles LSUB merging', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(folder);
        assert.equal(folder.subscribed, true);
        assert.equal(folder.listed, true);
    });
    it('Commands: list handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                throw new Error('List failed');
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.message, 'List failed');
        }
    });
    it('Commands: list handles empty attributes', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // Empty attributes - should be skipped
                    await opts.untagged.LIST({ attributes: [] });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 0);
    });
    it('Commands: list status fallback when LIST-STATUS not supported', async () => {
        let statusCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(), // No LIST-STATUS
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            run: async (cmd: any, path: any, query: any) => {
                if (cmd === 'STATUS') {
                    statusCalls++;
                    return { messages: 10, unseen: 5, path };
                }
            },
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(Array.isArray(result));
        // STATUS should have been called for each folder
        assert.equal(statusCalls, 1);
    });
    it('Commands: list handles STATUS errors gracefully', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(),
            run: async (cmd: any) => {
                if (cmd === 'STATUS') {
                    throw new Error('Status failed');
                }
            },
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        const inbox: any = result.find(e => e.path === 'INBOX');
        assert.ok(inbox);
        // Status should have error property
        assert.ok(inbox.status);
        assert.ok(inbox.status.error);
    });
    it('Commands: list sorts by special use', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(result[0].specialUse, '\\Inbox');
    });
    it('Commands: list handles delimiter in path', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(folder);
        // Leading delimiter should be removed
        assert.equal(folder.path, 'Leading/Slash');
    });
    it('Commands: list skips Noselect folders for status', async () => {
        let statusCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(),
            run: async (cmd: any) => {
                if (cmd === 'STATUS') {
                    statusCalls++;
                    return { messages: 10 };
                }
            },
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(statusCalls, 0);
    });
    it('Commands: list adds Noselect to NonExistent mailboxes', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\NonExistent' }], { value: '/' }, { value: 'Phantom' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const phantom = result.find(e => e.path === 'Phantom');
        assert.ok(phantom);
        // RFC 5258: \\NonExistent implies \\Noselect
        assert.equal(phantom.flags.has('\\Noselect'), true);
        // The original flag is preserved, not replaced
        assert.equal(phantom.flags.has('\\NonExistent'), true);
        const inbox = result.find(e => e.path === 'INBOX');
        assert.ok(inbox);
        assert.equal(inbox.flags.has('\\Noselect'), false);
    });
    it('Commands: list LSUB merge adds Noselect to NonExistent', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                    // Some servers only report \\NonExistent in LSUB responses
                    await opts.untagged.LSUB({
                        attributes: [[{ value: '\\NonExistent' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const folder = result.find(e => e.path === 'Folder1');
        assert.ok(folder);
        assert.equal(folder.subscribed, true);
        assert.equal(folder.flags.has('\\NonExistent'), true);
        // RFC 5258: \\NonExistent merged from LSUB implies \\Noselect
        assert.equal(folder.flags.has('\\Noselect'), true);
    });
    it('Commands: list uses RETURN (SUBSCRIBED) instead of LSUB on IMAP4rev2', async () => {
        let lsubCalled = false;
        let listAttrs = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                }
                if (cmd === 'LIST') {
                    listAttrs = attrs;
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                        });
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder2' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        // IMAP4rev2 removed LSUB, subscription state comes from RETURN (SUBSCRIBED)
        assert.equal(lsubCalled, false);
        assert.ok(JSON.stringify(listAttrs).includes('SUBSCRIBED'));
        const folder1 = result.find(e => e.path === 'Folder1');
        assert.ok(folder1);
        assert.equal(folder1.subscribed, true);
        // The \Subscribed attribute is folded into the subscribed property
        assert.equal(folder1.flags.has('\\Subscribed'), false);
        const folder2 = result.find(e => e.path === 'Folder2');
        assert.ok(folder2);
        assert.ok(!folder2.subscribed);
    });
    it('Commands: list uses RETURN (SUBSCRIBED) with LIST-EXTENDED', async () => {
        let lsubCalled = false;
        let listAttrs = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                }
                if (cmd === 'LIST') {
                    listAttrs = attrs;
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        assert.equal(lsubCalled, false);
        assert.ok(JSON.stringify(listAttrs).includes('SUBSCRIBED'));
        const inbox = result.find(e => e.path === 'INBOX');
        assert.ok(inbox);
        assert.equal(inbox.subscribed, true);
    });
    it('Commands: list listOnly does not add RETURN args on IMAP4rev2', async () => {
        let listAttrs: any = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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

        await listCommand(connection, '', '*', { listOnly: true });
        // Just reference and pattern, no RETURN block
        assert.equal(listAttrs.length, 2);
    });
    it('Commands: list survives LSUB rejection', async () => {
        let lsubCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalls++;
                    // e.g. Exchange responds "BAD Command Argument Error"
                    throw (commandError as any)('Command failed', 'BAD');
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.equal(result.length, 2);
        const inbox = result.find((e: any) => e.path === 'INBOX');
        assert.ok(inbox);
        // INBOX is always reported as subscribed even without LSUB data
        assert.equal(inbox.subscribed, true);
        // Nothing reported subscription state, so it is unknown rather than false - every
        // folder is reported as subscribed instead of none of them
        assert.equal(result.find((e: any) => e.path === 'Folder1').subscribed, true);

        // The rejection is remembered - a follow-up listing skips LSUB entirely
        assert.equal(connection.skipLsub, true);
        await listCommand(connection as any, '', '*');
        assert.equal(lsubCalls, 1);
    });
    it('Commands: list keeps a genuinely empty subscription set', async () => {
        // LSUB answers, it just has nothing to report. That is a real "nothing is
        // subscribed", not the unknown state, so it must not be overwritten
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.ok(!result.find((entry: any) => entry.path === 'Folder1').subscribed);
    });
    it('Commands: list treats an ignored RETURN (SUBSCRIBED) plus a rejected LSUB as unknown', async () => {
        // The server accepts the RETURN option but reports no \Subscribed at all, which is
        // why the listing falls back to LSUB - and that is rejected too. Accepting the
        // command is not the same as answering it, so this is the unknown state
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    throw (commandError as any)('Command failed', 'BAD');
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.equal(result.find((entry: any) => entry.path === 'Folder1').subscribed, true);
    });
    it('Commands: list leaves phantom folders out of the assumed subscription', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            enabled: new Set(['IMAP4REV2']),
            skipListSubscribedArg: true,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\NonExistent' }], { value: '/' }, { value: 'Ghost' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.equal(result.find((entry: any) => entry.path === 'Folder1').subscribed, true);
        // A folder the server says does not exist is not claimed to be subscribed
        assert.ok(!result.find((entry: any) => entry.path === 'Ghost').subscribed);
    });
    it('Commands: list keeps subscription flags volunteered by a plain LIST', async () => {
        // No RETURN option was granted and LSUB is not available on rev2, but the server
        // reported \Subscribed on its own - that is real state and must not be widened
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            enabled: new Set(['IMAP4REV2']),
            skipListSubscribedArg: true,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder2' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.equal(result.find((entry: any) => entry.path === 'Folder1').subscribed, true);
        assert.ok(!result.find((entry: any) => entry.path === 'Folder2').subscribed);
    });
    it('Commands: list fails when LSUB dies without a server rejection', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    // Transport failure, no tagged BAD/NO from the server
                    throw commandError('Connection not available', null, 'NoConnection');
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'NoConnection');
        }
        // A transport failure says nothing about LSUB support - must not latch
        assert.ok(!connection.skipLsub);
    });
    it('Commands: list rewrites a parsed error response into text', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                // Same shape as the reader loop attaches for a tagged BAD
                let err: any = (commandError as any)('Command failed', 'BAD');
                err.response = { tag: '5', command: 'BAD', attributes: [{ type: 'TEXT', value: 'Command Argument Error. 12' }] };
                throw err;
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            // enhanceCommandError folds the parsed object into a plain string
            assert.equal(typeof err.response, 'string');
            assert.ok(err.response.includes('Command Argument Error') as any);
        }
    });
    it('Commands: list retries with plain LIST when RETURN is rejected', async () => {
        let listCalls = 0;
        let lsubCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                    lsubCalled = true;
                    await opts.untagged.LSUB({
                        attributes: [[], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                if (cmd === 'LIST') {
                    listCalls++;
                    if (JSON.stringify(attrs).includes('SUBSCRIBED')) {
                        // Partial untagged response arrives before the tagged BAD
                        if (opts && opts.untagged && opts.untagged.LIST) {
                            await opts.untagged.LIST({
                                attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                            });
                        }
                        throw (commandError as any)('Command failed', 'BAD');
                    }
                    // Retry must be a plain LIST without RETURN args
                    assert.equal(attrs.length, 2);
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        // Extended attempt, auxiliary-free attempt, plain attempt
        assert.equal(listCalls, 3);
        assert.equal(lsubCalled, true);
        // Partial rejected-attempt results were discarded - no duplicate entries
        assert.equal(result.filter(e => e.path === 'Folder1').length, 1);
        const folder: any = result.find(e => e.path === 'Folder1');
        assert.equal(folder.subscribed, true);

        // The plain retry succeeding right after the rejection proves SUBSCRIBED was
        // the offending option - a follow-up listing goes straight to plain LIST
        assert.equal(connection.skipListSubscribedArg, true);
        assert.ok(!connection.skipListStatusArgs);
        await listCommand(connection as any, '', '*');
        assert.equal(listCalls, 4);
    });
    it('Commands: list never falls back to LSUB on a rev2 session', async () => {
        let lsubCalled = false;
        // An Exchange-alike that advertises both revisions and negotiates rev2 via ENABLE,
        // having already proved it rejects RETURN (SUBSCRIBED). The listing therefore
        // carries no subscription state - and the LSUB that rev1 would fall back to is not
        // part of rev2, so asking anyway only risks upsetting the session.
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev2', true],
                ['IMAP4rev1', true]
            ]),
            enabled: new Set(['IMAP4REV2']),
            skipListSubscribedArg: true,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.equal(lsubCalled, false);
        // Neither source could answer, so the folder is reported as subscribed rather than
        // claiming the server said it is not
        assert.equal(result.find((entry: any) => entry.path === 'Folder1').subscribed, true);
    });
    it('Commands: list does not retry extended LIST on transport errors', async () => {
        let listCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any) => {
                if (cmd === 'LIST') {
                    listCalls++;
                    // Dropped connection - no tagged BAD/NO from the server
                    throw commandError('Connection not available', null, 'NoConnection');
                }
                return { next: () => {} };
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'NoConnection');
        }
        // A doomed retry against a dead connection is pointless
        assert.equal(listCalls, 1);
        assert.ok(!connection.skipListSubscribedArg);
    });
    it('Commands: list does not retry extended LIST on NO responses', async () => {
        let listCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any) => {
                if (cmd === 'LIST') {
                    listCalls++;
                    // RFC 9051: unrecognized RETURN options are rejected with BAD;
                    // NO is a transient operational failure
                    throw (commandError as any)('Command failed', 'NO');
                }
                return { next: () => {} };
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.responseStatus, 'NO');
        }
        assert.equal(listCalls, 1);
        assert.ok(!connection.skipListSubscribedArg);
    });
    it('Commands: list does not treat throttling as a RETURN rejection', async () => {
        let listCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any) => {
                if (cmd === 'LIST') {
                    listCalls++;
                    // O365-style throttling surfaces as BAD plus code ETHROTTLE
                    throw commandError('Request is throttled', 'BAD', 'ETHROTTLE');
                }
                return { next: () => {} };
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'ETHROTTLE');
        }
        // Re-issuing against a throttled server and permanently downgrading the
        // connection would both be wrong
        assert.equal(listCalls, 1);
        assert.ok(!connection.skipListSubscribedArg);
    });
    it('Commands: list drops RETURN option groups one stage at a time', async () => {
        let listAttempts: any = [];
        let lsubCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true],
                ['LIST-STATUS', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                }
                if (cmd === 'LIST') {
                    let flat = JSON.stringify(attrs);
                    listAttempts.push(flat);
                    if (flat.includes('STATUS')) {
                        throw (commandError as any)('Command failed', 'BAD');
                    }
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', { statusQuery: { messages: true } });
        assert.equal(listAttempts.length, 4);
        // Stage 1: both option groups with the auxiliary options
        assert.ok(listAttempts[0].includes('STATUS'));
        assert.ok(listAttempts[0].includes('SUBSCRIBED'));
        assert.ok(listAttempts[0].includes('CHILDREN'));
        // Stage 2: the same groups without the auxiliary options - the rejection
        // might have been about the auxiliaries alone
        assert.ok(listAttempts[1].includes('STATUS'));
        assert.ok(listAttempts[1].includes('SUBSCRIBED'));
        assert.ok(!listAttempts[1].includes('CHILDREN'));
        // Stage 3: SUBSCRIBED dropped, STATUS kept
        assert.ok(listAttempts[2].includes('STATUS'));
        assert.ok(!listAttempts[2].includes('SUBSCRIBED'));
        // Stage 4: plain
        assert.ok(!listAttempts[3].includes('RETURN'));

        // Only the group whose removal was followed by success is latched - the BAD of
        // the earlier stages might have been caused by the STATUS group alone, so
        // SUBSCRIBED stays unproven and gets retried on the next listing
        assert.equal(connection.skipListStatusArgs, true);
        assert.ok(!connection.skipListSubscribedArg);
        assert.ok(!connection.skipListAuxArgs);
        assert.equal(lsubCalled, true);
        assert.equal(result.length, 1);

        // Next listing converges: SUBSCRIBED-only first, no STATUS args
        const result2 = await listCommand(connection as any, '', '*', { statusQuery: { messages: true } });
        assert.equal(listAttempts.length, 5);
        assert.ok(listAttempts[4].includes('SUBSCRIBED'));
        assert.ok(!listAttempts[4].includes('STATUS'));
        assert.equal(result2.length, 1);
    });
    it('Commands: list does not latch flags when the reduced retry also dies', async () => {
        let listCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true],
                ['LIST-STATUS', true]
            ]),
            exec: async (cmd: any) => {
                if (cmd === 'LIST') {
                    listCalls++;
                    if (listCalls === 1) {
                        throw (commandError as any)('Command failed', 'BAD');
                    }
                    // The reduced retry dies on a transport error
                    throw commandError('Connection not available', null, 'NoConnection');
                }
                return { next: () => {} };
            }
        });

        try {
            await listCommand(connection, '', '*', { statusQuery: { messages: true } });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'NoConnection');
        }
        // Nothing was proven - no flag may be latched
        assert.equal(listCalls, 2);
        assert.ok(!connection.skipListSubscribedArg);
        assert.ok(!connection.skipListStatusArgs);
        assert.ok(!connection.skipListAuxArgs);
    });
    it('Commands: list tolerates LSUB NO without latching', async () => {
        let lsubCalls = 0;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalls++;
                    // Transient operational failure, not a missing command
                    throw (commandError as any)('Server busy', 'NO');
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        assert.equal(result.length, 1);
        // NO is transient - the next listing must try LSUB again
        assert.ok(!connection.skipLsub);
        await listCommand(connection as any, '', '*');
        assert.equal(lsubCalls, 2);
    });
    it('Commands: list rethrows throttled LSUB without latching', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    throw commandError('Request is throttled', 'BAD', 'ETHROTTLE');
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        try {
            await listCommand(connection, '', '*');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'ETHROTTLE');
        }
        // Throttling says nothing about LSUB support
        assert.ok(!connection.skipLsub);
    });
    it('Commands: list folds LSUB-delivered Subscribed flag into the property', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                    // Some servers echo the RFC 5258 \Subscribed attribute in LSUB
                    await opts.untagged.LSUB({
                        attributes: [[{ value: '\\Subscribed' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const folder: any = result.find(e => e.path === 'Folder1');
        assert.equal(folder.subscribed, true);
        // The flag is folded into the property on the LSUB merge path too
        assert.equal(folder!.flags.has('\\Subscribed'), false);
    });
    it('Commands: list retries INBOX fixup plain without latching', async () => {
        let listAttempts: any = [];
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    let flat = JSON.stringify(attrs);
                    listAttempts.push(flat);
                    if (listAttempts.length === 2) {
                        // Fixup call with RETURN args is rejected by a quirky server
                        throw (commandError as any)('Command failed', 'BAD');
                    }
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        if (listAttempts.length === 1) {
                            await opts.untagged.LIST({
                                attributes: [[{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }], { value: '.' }, { value: 'Prefix.Folder1' }]
                            });
                        } else {
                            await opts.untagged.LIST({
                                attributes: [[{ value: '\\HasNoChildren' }], { value: '.' }, { value: 'INBOX' }]
                            });
                        }
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, 'Prefix.', '*');
        // Main listing + rejected fixup + plain fixup retry
        assert.equal(listAttempts.length, 3);
        assert.ok(listAttempts[1].includes('SUBSCRIBED'));
        assert.ok(!listAttempts[2].includes('RETURN'));
        // Entries from the successful main run were kept
        assert.ok(result.find(e => e.path === 'Prefix.Folder1'));
        assert.ok(result.find(e => e.path === 'INBOX'));
        // The main run succeeded with the same RETURN args - nothing may be latched
        assert.ok(!connection.skipListSubscribedArg);
        assert.ok(!connection.skipListStatusArgs);
    });
    it('Commands: list discards partial results from a rejected INBOX fixup', async () => {
        let listAttempts = [];
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true],
                ['SPECIAL-USE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    listAttempts.push(JSON.stringify(attrs));
                    if (listAttempts.length === 1) {
                        await opts.untagged.LIST({
                            attributes: [
                                [{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }, { value: '\\Sent' }],
                                { value: '.' },
                                { value: 'Prefix.Folder1' }
                            ]
                        });
                    } else if (listAttempts.length === 2) {
                        // The fixup attempt streams untagged lines and THEN gets the tagged
                        // BAD - the partial lines must not survive the retry. "Aliased" also
                        // claims \Sent and sorts ahead of the main run's Prefix.Folder1, so
                        // it would steal the special-use slot if it were not rolled back
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\Sent' }], { value: '.' }, { value: 'Aliased' }]
                        });
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '.' }, { value: 'INBOX' }]
                        });
                        throw (commandError as any)('Command failed', 'BAD');
                    } else {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '.' }, { value: 'INBOX' }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, 'Prefix.', '*');
        assert.equal(listAttempts.length, 3);
        // Exactly one INBOX entry - the rejected attempt's partial line was discarded
        assert.equal(result.filter((e: any) => e.path === 'INBOX').length, 1);
        assert.ok(!result.some((e: any) => e.path === 'Aliased'), 'the rejected attempt entry is gone');
        // The main run's special-use match survived the rollback of the rejected attempt
        assert.equal(result.find((e: any) => e.path === 'Prefix.Folder1').specialUse, '\\Sent');
    });
    it('Commands: list latches only the auxiliary options when the server rejects them', async () => {
        let listAttempts: any = [];
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true],
                ['LIST-STATUS', true],
                ['SPECIAL-USE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    let flat = JSON.stringify(attrs);
                    listAttempts.push(flat);
                    if (flat.includes('SPECIAL-USE') || flat.includes('CHILDREN')) {
                        throw (commandError as any)('Command failed', 'BAD');
                    }
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\Subscribed' }, { value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                    if (opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [{ value: 'Folder1' }, [{ value: 'MESSAGES' }, { value: '3' }]]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', { statusQuery: { messages: true } });
        // Extended attempt with auxiliaries, then the same groups without them
        assert.equal(listAttempts.length, 2);
        assert.ok(listAttempts[0].includes('SPECIAL-USE'));
        assert.ok(listAttempts[1].includes('STATUS'));
        assert.ok(listAttempts[1].includes('SUBSCRIBED'));
        assert.ok(!listAttempts[1].includes('SPECIAL-USE'));
        assert.ok(!listAttempts[1].includes('CHILDREN'));
        // Only the auxiliaries are latched - both option groups survived intact
        assert.equal(connection.skipListAuxArgs, true);
        assert.ok(!connection.skipListSubscribedArg);
        assert.ok(!connection.skipListStatusArgs);
        let folder: any = result.find(e => e.path === 'Folder1');
        assert.equal(folder.subscribed, true);
        assert.equal(folder!.status!.messages, 3);

        // The next listing goes straight to the auxiliary-free extended form
        await listCommand(connection as any, '', '*', { statusQuery: { messages: true } });
        assert.equal(listAttempts.length, 3);
        assert.ok(listAttempts[2].includes('STATUS'));
        assert.ok(listAttempts[2].includes('SUBSCRIBED'));
        assert.ok(!listAttempts[2].includes('SPECIAL-USE'));
    });
    it('Commands: list falls back to LSUB when RETURN (SUBSCRIBED) is silently ignored', async () => {
        let lsubCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['LIST-EXTENDED', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB' && opts && opts.untagged && opts.untagged.LSUB) {
                    lsubCalled = true;
                    await opts.untagged.LSUB({
                        attributes: [[], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // Server accepted RETURN (SUBSCRIBED) but returned no \Subscribed flags
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*');
        assert.equal(lsubCalled, true);
        assert.equal(result.find((e: any) => e.path === 'Folder1').subscribed, true);
    });
    it('Commands: list skips the LSUB safety net on rev2 sessions', async () => {
        let lsubCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LSUB') {
                    lsubCalled = true;
                }
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // No folder is subscribed - legitimate on a fresh account, and rev2
                    // removed LSUB so there is nothing to fall back to
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Folder1' }]
                    });
                }
                return { next: () => {} };
            }
        });

        await listCommand(connection, '', '*');
        assert.equal(lsubCalled, false);
    });
    it('Commands: list honors special-use flags on rev2-only servers', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // RFC 9051 folds the RFC 6154 attributes into base rev2 - no separate
                    // SPECIAL-USE capability token is required
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\Sent' }, { value: '\\HasNoChildren' }], { value: '/' }, { value: 'Custom-Sent-Name' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const folder: any = result.find(e => e.path === 'Custom-Sent-Name');
        assert.equal(folder.specialUse, '\\Sent');
    });
    it('Commands: list uses inline STATUS on rev2-only servers and omits RECENT', async () => {
        let listAttrs: any = false;
        let statusCommands = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IMAP4rev2', true]]),
            run: async (cmd: any) => {
                if (cmd === 'STATUS') {
                    statusCommands++;
                }
                return {};
            },
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    listAttrs = JSON.stringify(attrs);
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                    if (opts && opts.untagged && opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '5' }]]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result: any = await listCommand(connection, '', '*', { statusQuery: { messages: true, recent: true } });
        // LIST-STATUS is part of base rev2, so STATUS data arrives inline
        assert.ok((listAttrs as any).includes('STATUS'));
        // RECENT was removed in rev2 and must not be requested
        assert.ok(!(listAttrs as any).includes('RECENT'));
        assert.equal(statusCommands, 0);
        assert.equal(result.find((e: any) => e.path === 'INBOX').status.messages, 5);
        // The requested recent value is synthesized - rev2 defines it as always 0
        assert.equal(result.find((e: any) => e.path === 'INBOX').status.recent, 0);
    });
    it('Commands: list does not let NonExistent phantoms win special-use by name', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    // Phantom subscription leftover of a deleted folder
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\NonExistent' }, { value: '\\Subscribed' }], { value: '/' }, { value: 'Sent' }]
                    });
                    // The real sent-mail folder, matched by name
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'Sent Messages' }]
                    });
                }
                if (cmd === 'LSUB') {
                    throw (commandError as any)('Command failed', 'BAD');
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*');
        const phantom = result.find(e => e.path === 'Sent');
        const real: any = result.find(e => e.path === 'Sent Messages');
        assert.ok(phantom);
        assert.notEqual(phantom.specialUse, '\\Sent');
        assert.equal(real.specialUse, '\\Sent');
    });
    it('Commands: list does not STATUS NonExistent mailboxes', async () => {
        let statusPaths: any = [];
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(),
            run: async (cmd: any, path: any) => {
                if (cmd === 'STATUS') {
                    statusPaths.push(path);
                    return { messages: 10 };
                }
            },
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\NonExistent' }], { value: '/' }, { value: 'Phantom' }]
                    });
                }
                return { next: () => {} };
            }
        });

        await listCommand(connection, '', '*', { statusQuery: { messages: true } });
        // STATUS runs for the selectable mailbox only
        assert.deepEqual(statusPaths, ['INBOX']);
    });
    it('Commands: list XLIST removes Inbox flag from non-INBOX', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['XLIST', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(folder);
        // \\Inbox flag should be removed from flags set
        assert.equal(folder.flags.has('\\Inbox'), false);
        // But it should have \\Inbox special use
        assert.equal(folder.specialUse, '\\Inbox');
    });
    it('Commands: list LSUB path with leading delimiter', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(folder);
        assert.equal(folder.subscribed, true);
    });
    it('Commands: list sorts non-special-use after special-use', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(inboxIndex < zFolderIndex, 'Special use folders should sort before non-special-use');
    });
    it('Commands: list sorts alphabetically when no special use', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(alphaIndex < middleIndex, 'Alpha should come before Middle');
        assert.ok(middleIndex < zebraIndex, 'Middle should come before Zebra');
    });
    it('Commands: list sorts nested folders by parent path', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(aIndex < bIndex, 'A should come before B');
        assert.ok(aNestedIndex < bIndex, 'A/Nested should come before B');
        assert.ok(bIndex < bNestedIndex || aNestedIndex < bNestedIndex, 'Parent folders sort correctly');
    });
    it('Commands: list handles LSUB with empty attributes', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(result.length >= 1);
    });
    it('Commands: list handles STATUS NaN values in LSUB response', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['SPECIAL-USE', true],
                ['LIST-STATUS', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        const folder: any = result.find(e => e.path === 'TestFolder');
        assert.ok(folder);
        // NaN values should be filtered out (value === false check)
        assert.equal(folder.status.messages, undefined);
        assert.equal(folder.status!.recent, undefined);
    });
    it('Commands: list STATUS parses UIDVALIDITY UNSEEN HIGHESTMODSEQ', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['LIST-STATUS', true],
                ['CONDSTORE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(folder);
        assert.ok(folder.status);
        assert.equal(folder.status.uidValidity, BigInt(123456789));
        assert.equal(folder.status.unseen, 42);
        assert.equal(folder.status.highestModseq, BigInt(999999999));
    });
    it('Commands: list LSUB folder not in LIST entries', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(subscribedOnly, undefined);
        // INBOX should still be there
        const inbox = result.find(e => e.path === 'INBOX');
        assert.ok(inbox);
    });
    it('Commands: list sort b has specialUse a does not', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(result.length >= 2);
        assert.equal(result[0].path, 'INBOX');
        assert.equal(result[0].specialUse, '\\Inbox');
    });
    it('Commands: list sort fallback path comparison', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['SPECIAL-USE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(childIndex < deepIndex, 'Shorter path should sort before longer when parent matches');
    });
    it('Commands: list STATUS handles unknown key in response', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([
                ['SPECIAL-USE', true],
                ['LIST-STATUS', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged) {
                    if (opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'TestFolder' }]
                        });
                    }
                    if (opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [{ value: 'TestFolder' }, [{ value: 'XUNKNOWN' }, { value: '999' }, { value: 'MESSAGES' }, { value: '10' }]]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', { statusQuery: { messages: true } });
        const folder: any = result.find(e => e.path === 'TestFolder');
        assert.ok(folder);
        assert.ok(folder.status);
        assert.equal(folder.status.messages, 10);
        assert.equal(folder.status.XUNKNOWN, undefined); // Unknown keys silently ignored
    });

    // ============================================
    // SELECT Command Tests
    // ============================================
    it('Commands: select basic', async () => {
        let execCalled = false;
        let execCommand = '';
        const connection: any = createMockConnection({
            state: 2, // AUTHENTICATED
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(execCalled, true);
        assert.equal(execCommand, 'SELECT');
        assert.ok(result);
        assert.equal(result.path, 'INBOX');
        assert.equal(result.exists, 100);
        assert.equal(result.readOnly, false);
    });
    it('Commands: select with readOnly option uses EXAMINE', async () => {
        let execCommand = '';
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async (cmd: any) => {
                execCommand = cmd;
                return {
                    next: () => {},
                    response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-ONLY' }] }] }
                };
            },
            emit: () => {}
        });

        const result: any = await selectCommand(connection, 'INBOX', { readOnly: true });
        assert.equal(execCommand, 'EXAMINE');
        assert.equal(result.readOnly, true);
    });
    it('Commands: select skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

        const result = await selectCommand(connection, 'INBOX');
        assert.equal(result, undefined);
    });
    it('Commands: select fetches folder list if not cached', async () => {
        let listCalled = false;
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map(), // Empty - will trigger LIST
            run: async (cmd: any) => {
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
        assert.equal(listCalled, true);
    });
    it('Commands: select throws when LIST fails', async () => {
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map(),
            run: async () => null // LIST returns null
        });

        try {
            await selectCommand(connection, 'INBOX');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.message, 'Failed to fetch folders');
        }
    });
    it('Commands: select with QRESYNC', async () => {
        let execAttrs = null;
        const connection: any = createMockConnection({
            state: 2,
            enabled: new Set(['QRESYNC']),
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
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

        const result: any = await selectCommand(connection, 'INBOX', {
            changedSince: '12345',
            uidValidity: BigInt(67890)
        });
        assert.ok(execAttrs);
        const attrsStr = JSON.stringify(execAttrs);
        assert.ok(attrsStr.includes('QRESYNC'));
        assert.equal((result as any).qresync, true);
    });
    it('Commands: select QRESYNC invalidated when UIDVALIDITY mismatch', async () => {
        const connection: any = createMockConnection({
            state: 2,
            enabled: new Set(['QRESYNC']),
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
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

        const result: any = await selectCommand(connection, 'INBOX', {
            changedSince: '12345',
            uidValidity: BigInt(67890) // Different from server's 99999
        });
        // QRESYNC should be invalidated due to UIDVALIDITY mismatch
        assert.equal((result as any).qresync, false);
    });
    it('Commands: select QRESYNC invalidated when NOMODSEQ', async () => {
        const connection: any = createMockConnection({
            state: 2,
            enabled: new Set(['QRESYNC']),
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
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

        const result: any = await selectCommand(connection, 'INBOX', {
            changedSince: '12345',
            uidValidity: BigInt(67890)
        });
        assert.equal(result.noModseq, true);
        assert.equal((result as any)!.qresync, false);
    });
    it('Commands: select parses HIGHESTMODSEQ', async () => {
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
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

        const result: any = await selectCommand(connection, 'INBOX');
        assert.equal(result.highestModseq, BigInt('9876543210'));
    });
    it('Commands: select parses MAILBOXID', async () => {
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
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

        const result: any = await selectCommand(connection, 'INBOX');
        assert.equal(result.mailboxId, 'abc123');
    });
    it('Commands: select emits mailboxOpen event', async () => {
        let emittedEvents: any = [];
        const connection: any = createMockConnection({
            state: 2,
            mailbox: false, // No current mailbox
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async () => ({
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            }),
            emit: (event: any) => {
                emittedEvents.push(event);
            }
        });

        await selectCommand(connection, 'INBOX');
        assert.ok(emittedEvents.includes('mailboxOpen'));
    });
    it('Commands: select emits mailboxClose when switching', async () => {
        let emittedEvents: any = [];
        const connection: any = createMockConnection({
            state: 3, // Already SELECTED
            mailbox: { path: 'OldFolder' },
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async () => ({
                next: () => {},
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            }),
            emit: (event: any) => {
                emittedEvents.push(event);
            }
        });

        await selectCommand(connection, 'INBOX');
        assert.ok(emittedEvents.includes('mailboxClose'));
        assert.ok(emittedEvents.includes('mailboxOpen'));
    });
    it('Commands: select handles error', async () => {
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async () => {
                const err: any = new Error('Select failed');
                err.response = { attributes: [] };
                throw err;
            },
            emit: () => {}
        });

        try {
            await selectCommand(connection, 'INBOX');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.message, 'Select failed');
        }
    });
    it('Commands: select resets state on error when SELECTED', async () => {
        let emittedEvent = '';
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'CurrentFolder' },
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async () => {
                const err: any = new Error('Select failed');
                err.response = { attributes: [] };
                throw err;
            },
            emit: (event: any) => {
                emittedEvent = event;
            }
        });

        try {
            await selectCommand(connection, 'INBOX');
        } catch (err: any) {
            // Expected - error is intentionally ignored
            err.expected = true;
        }
        assert.equal(connection.state, 2); // Reset to AUTHENTICATED
        assert.equal(connection.mailbox, false);
        assert.equal(emittedEvent, 'mailboxClose');
    });
    it('Commands: select copies folder metadata', async () => {
        const connection: any = createMockConnection({
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

        const result: any = await selectCommand(connection, 'INBOX');
        assert.equal(result.delimiter, '/');
        assert.equal(result!.specialUse, '\\Inbox');
        assert.equal(result!.subscribed, true);
        assert.equal(result!.listed, true);
    });
    it('Commands: select handles VANISHED untagged', async () => {
        let vanishedCalled = false;
        const connection: any = createMockConnection({
            state: 2,
            enabled: new Set(['QRESYNC']),
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(vanishedCalled, true);
    });
    it('Commands: select handles FETCH untagged', async () => {
        let fetchCalled = false;
        const connection: any = createMockConnection({
            state: 2,
            enabled: new Set(['QRESYNC']),
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(fetchCalled, true);
    });
    it('Commands: select encodes path with special characters', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['Test&Folder', { path: 'Test&Folder' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any) => {
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
        assert.ok(execAttrs);
        assert.equal(execAttrs[0].type, 'STRING');
    });
    it('Commands: select handles empty OK attributes', async () => {
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(result);
    });
    it('Commands: select handles null FLAGS attributes', async () => {
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(result);
        assert.equal(result.flags, undefined);
    });
    it('Commands: select handles NaN EXISTS', async () => {
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(result);
        assert.equal(result.exists, undefined);
    });
    it('Commands: select error with serverResponseCode', async () => {
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            exec: async () => {
                const err: any = new Error('Select failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.serverResponseCode, 'NONEXISTENT');
        }
    });

    // ============================================
    // STATUS Command Tests
    // ============================================
    it('Commands: status basic', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 2, // AUTHENTICATED
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.equal(execCalled, true);
        assert.ok(result);
        assert.equal(result.path, 'INBOX');
        assert.equal(result.messages, 100);
        assert.equal(result.unseen, 10);
    });
    it('Commands: status skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

        const result = await statusCommand(connection, 'INBOX', { messages: true });
        assert.equal(result, false);
    });
    it('Commands: status skips when no path', async () => {
        const connection: any = createMockConnection({ state: 2 });

        const result = await statusCommand(connection, '', { messages: true });
        assert.equal(result, false);
    });
    it('Commands: status skips when no query attributes', async () => {
        const connection: any = createMockConnection({ state: 2 });

        const result = await statusCommand(connection, 'INBOX', {});
        assert.equal(result, false);
    });
    it('Commands: status returns synthetic recent on rev2 sessions', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async () => {
                execCalled = true;
                return { next: () => {} };
            }
        });

        // RECENT does not exist in IMAP4rev2 - the caller still gets a status object
        // (recent is 0 by definition) instead of false, and no command is sent
        const result = await statusCommand(connection, 'INBOX', { recent: true });
        assert.equal(execCalled, false);
        assert.deepEqual(result, { path: 'INBOX', recent: 0 });
    });
    it('Commands: status merges synthetic recent into rev2 query results', async () => {
        let queryAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                queryAttrs = JSON.stringify(attrs);
                await opts.untagged.STATUS({
                    attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '100' }]]
                });
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'INBOX', { messages: true, recent: true });
        // RECENT must not be requested from a rev2 session, but the result keeps the
        // rev1 shape for the same query
        assert.ok(!queryAttrs.includes('RECENT'));
        assert.equal(result.messages, 100);
        assert.equal((result as any).recent, 0);
    });
    it('Commands: status requests and parses SIZE and DELETED on rev2 sessions', async () => {
        let queryAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            // rev2-only server: STATUS=SIZE is folded in and DELETED is a base rev2
            // status item (RFC 9051 Appendix E item 3)
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                queryAttrs = JSON.stringify(attrs);
                await opts.untagged.STATUS({
                    attributes: [
                        { value: 'INBOX' },
                        [{ value: 'MESSAGES' }, { value: '100' }, { value: 'SIZE' }, { value: '12345678901234' }, { value: 'DELETED' }, { value: '3' }]
                    ]
                });
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'INBOX', { messages: true, size: true, deleted: true });
        assert.ok(queryAttrs.includes('SIZE'));
        assert.ok(queryAttrs!.includes('DELETED'));
        assert.equal(result.messages, 100);
        // STATUS SIZE is a number64 - values beyond 2^32 must survive
        assert.strictEqual((result as any).size, 12345678901234);
        assert.strictEqual((result as any).deleted, 3);
    });
    it('Commands: status requests SIZE with the STATUS=SIZE token on rev1 sessions', async () => {
        let queryAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            // RFC 8438 server: SIZE is available via the capability token, DELETED is
            // rev2-only and must be dropped
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['STATUS=SIZE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                queryAttrs = JSON.stringify(attrs);
                await opts.untagged.STATUS({
                    attributes: [{ value: 'INBOX' }, [{ value: 'SIZE' }, { value: '2048' }]]
                });
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'INBOX', { size: true, deleted: true });
        assert.ok(queryAttrs.includes('SIZE'));
        assert.ok(!queryAttrs!.includes('DELETED'));
        assert.strictEqual(result.size, 2048);
    });
    it('Commands: status requests DELETED with QUOTA=RES-MESSAGE on rev1 sessions', async () => {
        let queryAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            // RFC 9208: the DELETED status item is mandatory when QUOTA=RES-MESSAGE
            // is advertised, even without IMAP4rev2
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['QUOTA=RES-MESSAGE', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                queryAttrs = JSON.stringify(attrs);
                await opts.untagged.STATUS({
                    attributes: [{ value: 'INBOX' }, [{ value: 'DELETED' }, { value: '4' }]]
                });
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'INBOX', { deleted: true });
        assert.ok(queryAttrs.includes('DELETED'));
        assert.strictEqual(result.deleted, 4);
    });
    it('Commands: status drops SIZE and DELETED on rev1 sessions without support', async () => {
        let queryAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any, opts: any) => {
                queryAttrs = JSON.stringify(attrs);
                await opts.untagged.STATUS({
                    attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '100' }]]
                });
                return { next: () => {} };
            }
        });

        // requesting them must not poison the whole STATUS command on a server that
        // does not know these items
        const result: any = await statusCommand(connection, 'INBOX', { messages: true, size: true, deleted: true });
        assert.ok(!queryAttrs.includes('SIZE'));
        assert.ok(!queryAttrs!.includes('DELETED'));
        assert.equal(result.messages, 100);
    });
    it('Commands: status skips when all query values are false', async () => {
        const connection: any = createMockConnection({ state: 2 });

        const result = await statusCommand(connection, 'INBOX', { messages: false, unseen: false });
        assert.equal(result, false);
    });
    it('Commands: status with all standard query attributes', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any, opts: any) => {
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

        const result: any = await statusCommand(connection, 'INBOX', {
            messages: true,
            recent: true,
            uidNext: true,
            uidValidity: true,
            unseen: true
        });
        assert.ok(queryAttrs);
        const queryStr = JSON.stringify(queryAttrs);
        assert.ok(queryStr.includes('MESSAGES'));
        assert.ok(queryStr.includes('RECENT'));
        assert.ok(queryStr.includes('UIDNEXT'));
        assert.ok(queryStr.includes('UIDVALIDITY'));
        assert.ok(queryStr.includes('UNSEEN'));

        assert.equal(result.messages, 100);
        assert.equal((result as any).recent, 5);
        assert.equal((result as any).uidNext, 1000);
        assert.equal((result as any).uidValidity, BigInt(12345));
        assert.equal((result as any).unseen, 10);
    });
    it('Commands: status with HIGHESTMODSEQ and CONDSTORE', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['CONDSTORE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                queryAttrs = attrs;
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [{ value: 'INBOX' }, [{ value: 'HIGHESTMODSEQ' }, { value: '9876543210' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'INBOX', { highestModseq: true });
        assert.ok(queryAttrs);
        const queryStr = JSON.stringify(queryAttrs);
        assert.ok(queryStr.includes('HIGHESTMODSEQ'));
        assert.equal(result.highestModseq, BigInt('9876543210'));
    });
    it('Commands: status ignores HIGHESTMODSEQ without CONDSTORE', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map(), // No CONDSTORE
            exec: async () => ({ next: () => {} })
        });

        const result = await statusCommand(connection, 'INBOX', { highestModseq: true });
        // Should return false since no valid query attributes
        assert.equal(result, false);
    });
    it('Commands: status updates current mailbox when SELECTED', async () => {
        let existsEmitted = false;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'INBOX', exists: 50, uidNext: 500 },
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '100' }, { value: 'UIDNEXT' }, { value: '1000' }]]
                    });
                }
                return { next: () => {} };
            },
            emit: (event: any) => {
                if (event === 'exists') existsEmitted = true;
            }
        });

        await statusCommand(connection, 'INBOX', { messages: true, uidNext: true });
        // Mailbox should be updated
        assert.equal(connection.mailbox.exists, 100);
        assert.equal(connection.mailbox.uidNext, 1000);
        // exists event should be emitted since count changed
        assert.equal(existsEmitted, true);
    });
    it('Commands: status does not emit exists when count unchanged', async () => {
        let existsEmitted = false;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 100 }, // Same as response
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '100' }]]
                    });
                }
                return { next: () => {} };
            },
            emit: (event: any) => {
                if (event === 'exists') existsEmitted = true;
            }
        });

        await statusCommand(connection, 'INBOX', { messages: true });
        assert.equal(existsEmitted, false);
    });
    it('Commands: status handles error with NO response', async () => {
        const connection: any = createMockConnection({
            state: 2,
            run: async () => [], // LIST returns empty - folder doesn't exist
            exec: async () => {
                const err: any = new Error('Mailbox not found');
                err.responseStatus = 'NO';
                throw err;
            }
        });

        try {
            await statusCommand(connection, 'NonExistent', { messages: true });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.code, 'NotFound');
        }
    });
    it('Commands: status returns false on other errors', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Some error');
                err.responseStatus = 'BAD';
                throw err;
            }
        });

        const result = await statusCommand(connection, 'INBOX', { messages: true });
        assert.equal(result, false);
    });
    it('Commands: status handles empty STATUS response', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(result);
        assert.equal(result.path, 'INBOX');
        // No messages property since response was empty
        assert.equal(result.messages, undefined);
    });
    it('Commands: status handles invalid entry values', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(result);
        // MESSAGES with invalid value should be skipped (isNaN check fails)
        assert.equal(result.messages, undefined);
        // UNSEEN should work
        assert.equal(result.unseen, 10);
        // RECENT with null value should be skipped
        assert.equal(result.recent, undefined);
    });
    it('Commands: status encodes path with special characters', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {} };
            }
        });

        await statusCommand(connection, 'Test&Folder', { messages: true });
        // Path with & should use STRING type instead of ATOM
        assert.ok(execAttrs);
        assert.equal(execAttrs[0].type, 'STRING');
    });
    it('Commands: status works from SELECTED state', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'OtherFolder' }, // Different folder
            exec: async (cmd: any, attrs: any, opts: any) => {
                execCalled = true;
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '50' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'INBOX', { messages: true });
        assert.equal(execCalled, true);
        assert.equal(result.messages, 50);
    });
    it('Commands: status updates HIGHESTMODSEQ for current mailbox', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['CONDSTORE', true]]),
            mailbox: { path: 'INBOX', highestModseq: BigInt(100) },
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [{ value: 'INBOX' }, [{ value: 'HIGHESTMODSEQ' }, { value: '200' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        await statusCommand(connection, 'INBOX', { highestModseq: true });
        assert.equal(connection.mailbox.highestModseq, BigInt(200));
    });
    it('Commands: status handles NaN values in response', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(result);
        assert.equal(result.path, 'TestFolder');
        // NaN values should not be set
        assert.equal(result.messages, undefined);
        assert.equal(result.recent, undefined);
        assert.equal(result.uidNext, undefined);
        assert.equal(result.uidValidity, undefined);
        assert.equal(result.unseen, undefined);
    });
    it('Commands: status handles NaN HIGHESTMODSEQ', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['CONDSTORE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [{ value: 'TestFolder' }, [{ value: 'HIGHESTMODSEQ' }, { value: 'notvalid' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await statusCommand(connection, 'TestFolder', { highestModseq: true });
        assert.ok(result);
        assert.equal(result.highestModseq, undefined);
    });
    it('Commands: status filters falsy query values', async () => {
        let queryAttrs = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any) => {
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
        } as any);
        assert.ok(result);
        // Query should only include messages and uidValidity
        assert.ok(queryAttrs);
        const queryList: any = queryAttrs[1];
        assert.equal(queryList.length, 2);
    });
    it('Commands: status handles missing entry value', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(result);
        assert.equal(result.messages, undefined); // Skipped due to null value
        assert.equal(result.recent, 5);
    });
    it('Commands: status handles missing key in response', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
        assert.ok(result);
        assert.equal(result.messages, 20);
    });
    it('Commands: status handles unknown key in response', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [{ value: 'TestFolder' }, [{ value: 'UNKNOWNKEY' }, { value: '999' }, { value: 'MESSAGES' }, { value: '10' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'TestFolder', { messages: true });
        assert.ok(result);
        assert.equal(result.messages, 10);
        assert.equal(result.UNKNOWNKEY, undefined); // Unknown keys ignored
    });

    // ============================================
    // APPEND Command Tests
    // ============================================
    it('Commands: append basic', async () => {
        let appendCalled = false;
        const connection: any = createMockConnection({
            state: 2, // AUTHENTICATED
            mailbox: { path: 'OtherFolder' }, // Different folder to avoid EXISTS handling
            exec: async (cmd: any) => {
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
        assert.equal(appendCalled, true);
        assert.ok(result);
        assert.equal(result.destination, 'INBOX');
    });
    it('Commands: append with Buffer content', async () => {
        let contentAttr: any = null;
        const connection: any = createMockConnection({
            state: 2,
            mailbox: { path: 'OtherFolder' },
            exec: async (cmd: any, attrs: any) => {
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
        assert.ok(contentAttr);
        assert.ok(Buffer.isBuffer(contentAttr.value));
        assert.equal((contentAttr as any).value.toString(), 'Test message');
    });
    it('Commands: append skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

        const result = await appendCommand(connection, 'INBOX', 'content');
        assert.equal(result, undefined);
    });
    it('Commands: append skips when no destination', async () => {
        const connection: any = createMockConnection({ state: 2 });

        const result = await appendCommand(connection, '', 'content');
        assert.equal(result, undefined);
    });
    it('Commands: append with flags', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            mailbox: { path: 'OtherFolder', permanentFlags: new Set(['\\*']) },
            exec: async (cmd: any, attrs: any) => {
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
        assert.ok(execAttrs);
        // Should have flags array between path and content
        const flagsAttr = execAttrs.find((a: any) => Array.isArray(a));
        assert.ok(flagsAttr);
        assert.ok(flagsAttr.some((f: any) => f.value === '\\Seen'));
        assert.ok(flagsAttr.some((f: any) => f.value === '\\Flagged'));
    });
    it('Commands: append with internal date', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            mailbox: { path: 'OtherFolder' },
            exec: async (cmd: any, attrs: any) => {
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
        assert.ok(execAttrs);
        // Should have date string
        const dateAttr = execAttrs.find((a: any) => a && a.type === 'STRING');
        assert.ok(dateAttr);
        assert.ok(dateAttr.value.includes('2024'));
    });
    it('Commands: append checks APPENDLIMIT', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['APPENDLIMIT', 100]]), // 100 byte limit
            mailbox: { path: 'INBOX' }
        });

        const largeContent = Buffer.alloc(200, 'x'); // 200 bytes, exceeds limit

        try {
            await appendCommand(connection, 'INBOX', largeContent);
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.serverResponseCode, 'APPENDLIMIT');
            assert.ok(err.message.includes('APPENDLIMIT') as any);
        }
    });
    it('Commands: append allows content within APPENDLIMIT', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
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
        assert.equal(execCalled, true);
    });
    it('Commands: append with APPENDUID response', async () => {
        const connection: any = createMockConnection({
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

        const result: any = await appendCommand(connection, 'INBOX', 'content');
        assert.equal(result.uidValidity, BigInt(12345));
        assert.equal(result!.uid, 100);
    });
    it('Commands: append to current mailbox triggers EXISTS', async () => {
        let existsEmitted = false;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'INBOX', exists: 10 },
            exec: async (cmd: any, attrs: any, opts: any) => {
                // Simulate EXISTS untagged response
                if (cmd === 'APPEND' && opts && opts.untagged && opts.untagged.EXISTS) {
                    await opts.untagged.EXISTS({ command: '11' });
                }
                return {
                    next: () => {},
                    response: { attributes: [] }
                };
            },
            emit: (event: any) => {
                if (event === 'exists') existsEmitted = true;
            },
            search: async () => [100] // Return UID
        });

        await appendCommand(connection, 'INBOX', 'content');
        assert.equal(existsEmitted, true);
        assert.equal(connection.mailbox.exists, 11);
    });
    it('Commands: append runs NOOP to get sequence if not in EXISTS', async () => {
        let noopCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 10 },
            exec: async (cmd: any, attrs: any, opts: any) => {
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

        const result: any = await appendCommand(connection, 'INBOX', 'content');
        assert.equal(noopCalled, true);
        assert.equal(result.seq, 11);
    });
    it('Commands: append searches for UID if seq but no uid', async () => {
        let searchCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 10 },
            exec: async (cmd: any, attrs: any, opts: any) => {
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

        const result: any = await appendCommand(connection, 'INBOX', 'content');
        assert.equal(searchCalled, true);
        assert.equal(result.uid, 100);
    });
    it('Commands: append with BINARY and NULL bytes', async () => {
        let literalAttr: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['BINARY', true]]),
            mailbox: { path: 'INBOX' },
            exec: async (cmd: any, attrs: any) => {
                literalAttr = attrs.find((a: any) => a.type === 'LITERAL');
                return {
                    next: () => {},
                    response: { attributes: [] }
                };
            }
        });

        // Content with NULL byte
        const content = Buffer.concat([Buffer.from('test'), Buffer.from([0]), Buffer.from('data')]);
        await appendCommand(connection, 'INBOX', content);
        assert.ok(literalAttr);
        assert.equal(literalAttr.isLiteral8, true);
    });
    it('Commands: append without BINARY uses regular literal', async () => {
        let literalAttr: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map(), // No BINARY
            mailbox: { path: 'INBOX' },
            exec: async (cmd: any, attrs: any) => {
                literalAttr = attrs.find((a: any) => a.type === 'LITERAL');
                return {
                    next: () => {},
                    response: { attributes: [] }
                };
            }
        });

        const content = Buffer.concat([Buffer.from('test'), Buffer.from([0]), Buffer.from('data')]);
        await appendCommand(connection, 'INBOX', content);
        assert.ok(literalAttr);
        assert.equal(literalAttr.isLiteral8, false);
    });
    it('Commands: append handles error', async () => {
        const connection: any = createMockConnection({
            state: 2,
            mailbox: { path: 'OtherFolder' },
            exec: async () => {
                const err: any = new Error('Append failed');
                err.response = { attributes: [] };
                throw err;
            }
        });

        try {
            await appendCommand(connection, 'INBOX', 'content');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.message, 'Append failed');
        }
    });
    it('Commands: append filters invalid flags', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            mailbox: {
                path: 'OtherFolder',
                permanentFlags: new Set(['\\Seen', '\\Flagged']) // Only allow these
            },
            exec: async (cmd: any, attrs: any) => {
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
        await appendCommand(connection, 'INBOX', 'content', ['\\Seen', '\\CustomFlag', null, '\\Flagged'] as any);
        assert.ok(execAttrs);
        const flagsAttr = execAttrs.find((a: any) => Array.isArray(a));
        assert.ok(flagsAttr);
        // Should only contain allowed flags
        assert.equal(flagsAttr.length, 2);
    });
    it('Commands: append works from SELECTED state', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
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
        const result: any = await appendCommand(connection, 'INBOX', 'content');
        assert.equal(execCalled, true);
        assert.equal(result.destination, 'INBOX');
    });
    it('Commands: append error with serverResponseCode', async () => {
        const connection: any = createMockConnection({
            state: 2,
            mailbox: { path: 'OtherFolder' },
            exec: async () => {
                const err: any = new Error('Append failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.serverResponseCode, 'TRYCREATE');
        }
    });
    it('Commands: append with invalid APPENDUID values', async () => {
        const connection: any = createMockConnection({
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
        assert.ok(result);
        assert.equal(result.uidValidity, undefined);
        assert.equal(result.uid, undefined);
    });
    it('Commands: append NOOP error is caught', async () => {
        let noopCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 10 },
            exec: async (cmd: any) => {
                if (cmd === 'APPEND') {
                    return {
                        next: () => {},
                        response: { attributes: [] }
                    };
                }
                if (cmd === 'NOOP') {
                    noopCalled = true;
                    const err: any = new Error('NOOP failed');
                    err.response = { attributes: [] };
                    throw err;
                }
            }
        });

        // Append to current mailbox, expectExists = true
        const result = await appendCommand(connection, 'INBOX', 'content');
        assert.ok(result);
        assert.equal(noopCalled, true);
        // Should not throw, NOOP error is caught
    });
    it('Commands: append EXISTS updates mailbox count', async () => {
        let emittedEvent: any = null;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 10 },
            exec: async (cmd: any, attrs: any, opts: any) => {
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
            emit: (event: any, data: any) => {
                if (event === 'exists') {
                    emittedEvent = data;
                }
            }
        });

        const result = await appendCommand(connection, 'INBOX', 'content');
        assert.ok(result);
        assert.equal(result.seq, 11);
        assert.equal(connection.mailbox.exists, 11);
        assert.ok(emittedEvent);
        assert.equal(emittedEvent.count, 11);
        assert.equal((emittedEvent as any).prevCount, 10);
    });
    it('Commands: append does not emit exists when count unchanged', async () => {
        let emittedEvent = null;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 10 },
            exec: async (cmd: any, attrs: any, opts: any) => {
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
            emit: (event: any, data: any) => {
                if (event === 'exists') {
                    emittedEvent = data;
                }
            }
        });

        await appendCommand(connection, 'INBOX', 'content');
        assert.equal(emittedEvent, null); // No event emitted
    });
    it('Commands: append with both flags and date', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            mailbox: { path: 'OtherFolder' },
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return {
                    next: () => {},
                    response: { attributes: [] }
                };
            }
        });

        const testDate = new Date('2024-01-15T10:30:00Z');
        await appendCommand(connection, 'INBOX', 'content', ['\\Seen'], testDate);
        assert.ok(execAttrs);
        // Should have: path, flags array, date string, literal
        assert.equal(execAttrs.length, 4);
        // Flags array
        assert.ok(Array.isArray(execAttrs[1]));
        // Date string
        assert.equal((execAttrs[2] as any).type, 'STRING');
    });
    it('Commands: append with disableBinary does not use literal8', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            mailbox: { path: 'OtherFolder' },
            capabilities: new Map([['BINARY', true]]),
            disableBinary: true,
            exec: async (cmd: any, attrs: any) => {
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
        assert.ok(execAttrs);
        const literalAttr = execAttrs.find((a: any) => a && a.type === 'LITERAL');
        assert.ok(literalAttr);
        assert.equal(literalAttr.isLiteral8, false); // Not literal8 due to disableBinary
    });

    // ============================================
    // IDLE Command Tests
    // ============================================
    it('Commands: idle with IDLE capability', async () => {
        let execCommand = '';
        let idlingSet = false;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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

        await idleCommand(connection as any);
        assert.equal(execCommand, 'IDLE');
        assert.equal(idlingSet, true);
    });
    it('Commands: idle uses IDLE on rev2-only servers without the IDLE token', async () => {
        let execCommand = '';
        const connection: any = createMockConnection({
            state: 3,
            // IDLE is part of base IMAP4rev2 - no separate token required
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                execCommand = cmd;
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection);
        assert.equal(execCommand, 'IDLE');
    });
    it('Commands: idle skips when not selected', async () => {
        const connection: any = createMockConnection({ state: 2 }); // AUTHENTICATED

        const result = await idleCommand(connection);
        assert.equal(result, undefined);
    });
    it('Commands: idle falls back to NOOP without IDLE capability', async () => {
        let noopCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(), // No IDLE
            currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
            exec: async (cmd: any) => {
                if (cmd === 'NOOP') {
                    noopCalled = true;
                    // Break out of the loop by calling preCheck
                    if (connection.preCheck) {
                        await (connection as any).preCheck();
                    }
                }
                return { next: () => {} };
            }
        });

        // Start idle - it will loop with NOOP
        const idlePromise = idleCommand(connection as any);

        // Give it a moment to start, then break the loop
        await new Promise(resolve => setTimeout(resolve, 10));
        if ((connection as any).preCheck) {
            await (connection as any).preCheck();
        }

        await idlePromise;
        assert.equal(noopCalled, true);
    });
    it('Commands: idle preCheck breaks IDLE', async () => {
        let doneSent = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // After IDLE is initiated, trigger preCheck
                if (connection.preCheck) {
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: (data: any) => {
                if (data === 'DONE') {
                    doneSent = true;
                }
            }
        });

        await idleCommand(connection as any);
        assert.equal(doneSent, true);
        assert.equal((connection as any).idling, false);
    });
    it('Commands: idle handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async () => {
                throw new Error('IDLE failed');
            }
        });

        const result = await idleCommand(connection);
        assert.equal(result, false);
        assert.equal((connection as any).idling, false);
    });
    it('Commands: idle with maxIdleTime restarts loop', async () => {
        let idleCount = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                idleCount++;
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // Break after second iteration
                if (idleCount >= 2 && connection.preCheck) {
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        // Very short maxIdleTime to trigger restart
        await idleCommand(connection as any, 5);
        assert.ok(idleCount >= 1);
    });
    it('Commands: idle without currentSelectCommand returns immediately', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(), // No IDLE
            currentSelectCommand: false // No select command
        });

        // Should resolve immediately
        await idleCommand(connection);
        assert.ok(true);
    });
    it('Commands: idle NOOP fallback uses STATUS when configured', async () => {
        let statusCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(),
            currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
            missingIdleCommand: 'STATUS',
            exec: async (cmd: any) => {
                if (cmd === 'STATUS') {
                    statusCalled = true;
                    if (connection.preCheck) {
                        await (connection as any).preCheck();
                    }
                }
                return { next: () => {} };
            }
        });

        await idleCommand(connection as any);
        assert.equal(statusCalled, true);
    });
    it('Commands: idle NOOP fallback uses SELECT when configured', async () => {
        // SELECT polling goes through the real select implementation, so it applies the same
        // mailbox state transitions as a caller-issued select instead of replaying wire arguments.
        let selectCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(),
            // The mailbox is already open, so its folder metadata is cached (no LIST round trip)
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
            missingIdleCommand: 'SELECT',
            exec: async (cmd: any) => {
                if (cmd === 'SELECT') {
                    selectCalled = true;
                    if (connection.preCheck) {
                        await (connection as any).preCheck();
                    }
                }
                return { next: () => {}, response: { attributes: [{ value: 'OK' }] } };
            }
        });

        await idleCommand(connection as any);
        assert.equal(selectCalled, true);
        assert.equal(connection.mailbox.path, 'INBOX', 'mailbox state was reapplied by the select implementation');
        assert.equal(connection.mailbox.delimiter, '/', 'cached folder metadata was merged in, as with a normal SELECT');
    });
    it('Commands: idle sets preCheck function', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // Check that preCheck is set
                assert.equal(typeof connection.preCheck, 'function');
                // Break the IDLE
                if ((connection as any).preCheck) {
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any);
    });
    it('Commands: idle clears preCheck on completion', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                if (connection.preCheck) {
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any);
        assert.equal((connection as any).preCheck, false);
    });
    it('Commands: idle NOOP fallback handles error', async () => {
        let errorLogged = false;
        const connection: any = createMockConnection({
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
        assert.equal(errorLogged, true);
    });
    it('Commands: idle clears wait queue on normal completion', async () => {
        let preCheckResolved = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // Simulate waiting preCheck request before completion
                if (connection.preCheck) {
                    // Queue a preCheck request
                    (connection as any).preCheck().then(() => {
                        preCheckResolved = true;
                    });
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any);
        // Wait a tick for the promise to resolve
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(preCheckResolved, true);
    });
    it('Commands: idle rejects wait queue on error', async () => {
        let preCheckRejected = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // Queue a preCheck request then throw
                if (connection.preCheck) {
                    (connection as any).preCheck().catch(() => {
                        preCheckRejected = true;
                    });
                }
                throw new Error('IDLE failed');
            }
        });

        const result = await idleCommand(connection as any);
        assert.equal(result, false);
        // Wait a tick for the promise to reject
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(preCheckRejected, true);
    });
    it('Commands: idle onPlusTag calls preCheck if doneRequested', async () => {
        let doneSent = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                // Request done before onPlusTag is called
                if (connection.preCheck) {
                    (connection as any).preCheck().catch(() => {});
                }
                // Then call onPlusTag which should send DONE
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                return { next: () => {} };
            },
            write: (data: any) => {
                if (data === 'DONE') {
                    doneSent = true;
                }
            }
        });

        await idleCommand(connection as any);
        assert.equal(doneSent, true);
    });
    it('Commands: idle calls onSend callback', async () => {
        let onSendCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
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
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any);
        assert.equal(onSendCalled, true);
    });
    it('Commands: idle clears preCheck and queue on normal completion', async () => {
        let waitQueueResolved = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // After onPlusTag, queue a preCheck but don't resolve yet
                if (connection.preCheck) {
                    (connection as any).preCheck().then(() => {
                        waitQueueResolved = true;
                    });
                }
                // Return to complete IDLE - this should clear the queue
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any);
        await new Promise(resolve => setImmediate(resolve));
        // preCheck should be cleared after completion
        assert.equal((connection as any).preCheck, false);
        assert.equal(waitQueueResolved, true);
    });
    it('Commands: idle with maxIdleTime triggers preCheck after timeout', async () => {
        let preCheckCalled = false;
        let loopCount = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            idling: false,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        // Use very short maxIdleTime
        await idleCommand(connection as any, 10);
        assert.ok(preCheckCalled || loopCount > 1, 'preCheck should be called by timer or loop should restart');
    });
    it('Commands: idle stillIdling triggers loop restart', async () => {
        let loopCount = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            idling: false,
            exec: async (cmd: any, attrs: any, opts: any) => {
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
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any, 5);
        // Loop should have run at least once (could run twice if timer works)
        assert.ok(loopCount >= 1, 'IDLE loop should have run');
    });

    // ============================================
    // ID Command Tests
    // ============================================
    it('Commands: id skips when no ID capability', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map() // No ID capability
        });

        const result = await idCommand(connection, { name: 'TestClient' });
        assert.equal(result, undefined);
    });
    it('Commands: id sends client info', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            }
        });

        await idCommand(connection, { name: 'TestClient', version: '1.0' });
        assert.equal(execArgs.cmd, 'ID');
        assert.ok(Array.isArray(execArgs!.args));
        assert.ok(execArgs!.args[0].includes('name'));
        assert.ok(execArgs!.args[0].includes('TestClient'));
    });
    it('Commands: id sends null when no clientInfo', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            }
        });

        await idCommand(connection, null);
        assert.equal(execArgs.cmd, 'ID');
        assert.equal(execArgs!.args[0], null);
    });
    it('Commands: id sends null for empty clientInfo', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            }
        });

        await idCommand(connection, {});
        assert.equal(execArgs.cmd, 'ID');
        assert.equal(execArgs!.args[0], null);
    });
    it('Commands: id parses server response', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ID) {
                    await opts.untagged.ID({
                        attributes: [
                            [{ value: 'name' }, { value: 'TestServer' }, { value: 'version' }, { value: '2.0' }, { value: 'vendor' }, { value: 'ACME' }]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await idCommand(connection, { name: 'TestClient' });
        assert.equal((result as any).name, 'TestServer');
        assert.equal((result as any)!.version, '2.0');
        assert.equal((result as any)!.vendor, 'ACME');
    });
    it('Commands: id updates serverInfo', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            serverInfo: {},
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ID) {
                    await opts.untagged.ID({
                        attributes: [[{ value: 'name' }, { value: 'ImapServer' }, { value: 'support-url' }, { value: 'https://example.com' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        await idCommand(connection, { name: 'TestClient' });
        assert.equal((connection as any).serverInfo.name, 'ImapServer');
        assert.equal((connection as any).serverInfo['support-url'], 'https://example.com');
    });
    it('Commands: id handles non-array server response', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.ok(result);
        assert.deepEqual(result, {});
    });
    it('Commands: id formats date value', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            }
        });

        const testDate = new Date('2024-06-15T10:30:00Z');
        await idCommand(connection, { date: testDate });

        assert.equal(execArgs.cmd, 'ID');
        // Date should be formatted, not passed as Date object
        assert.ok(execArgs!.args[0].includes('date'));
    });
    it('Commands: id normalizes key names to lowercase', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ID) {
                    await opts.untagged.ID({
                        attributes: [[{ value: 'NAME' }, { value: 'TestServer' }, { value: 'VERSION' }, { value: '1.0' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await idCommand(connection, { name: 'TestClient' });
        assert.equal((result as any).name, 'TestServer');
        assert.equal((result as any)!.version, '1.0');
    });
    it('Commands: id trims key names', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ID) {
                    await opts.untagged.ID({
                        attributes: [[{ value: ' name ' }, { value: 'TestServer' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await idCommand(connection, { name: 'TestClient' });
        assert.equal((result as any).name, 'TestServer');
    });
    it('Commands: id handles error', async () => {
        let warnLogged = false;
        const connection: any = createMockConnection({
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
        assert.equal(result, false);
        assert.ok(warnLogged);
    });
    it('Commands: id filters empty values', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            }
        });

        await idCommand(connection, { name: 'TestClient', empty: '', valid: 'value' });
        assert.equal(execArgs.cmd, 'ID');
        // Empty values should be filtered out
        assert.ok(execArgs!.args[0].includes('name'));
        assert.ok(execArgs!.args[0].includes('valid'));
    });
    it('Commands: id replaces whitespace in values', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            }
        });

        await idCommand(connection, { name: 'Test\nClient\tApp' });
        assert.equal(execArgs.cmd, 'ID');
        // Whitespace should be normalized to single spaces
        const nameIndex = execArgs!.args[0].indexOf('name');
        assert.ok(nameIndex >= 0);
        const nameValue = execArgs!.args[0][nameIndex + 1];
        assert.ok(!nameValue.includes('\n'));
        assert.ok(!nameValue.includes('\t'));
    });

    // ============================================
    // NAMESPACE Command Tests
    // ============================================
    it('Commands: namespace skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

        const result = await namespaceCommand(connection);
        assert.equal(result, undefined);
    });
    it('Commands: namespace with NAMESPACE capability', async () => {
        const connection: any = createMockConnection({
            state: 2, // AUTHENTICATED
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                assert.equal(cmd, 'NAMESPACE');
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

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.prefix, 'INBOX.');
        assert.equal((result as any).delimiter, '.');
        assert.equal((connection as any).namespaces.personal[0].prefix, 'INBOX.');
        assert.equal((connection as any).namespaces.other[0].prefix, 'Users.');
        assert.equal((connection as any).namespaces.shared[0].prefix, 'Shared.');
    });
    it('Commands: namespace uses the real command on rev2-only servers without the token', async () => {
        const connection: any = createMockConnection({
            state: 2,
            // NAMESPACE is folded into base IMAP4rev2 (RFC 9051 Appendix E) - a
            // rev2-only server gets a real NAMESPACE command, not the LIST fallback
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                assert.equal(cmd, 'NAMESPACE');
                if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                    await opts.untagged.NAMESPACE({
                        attributes: [[[{ value: '' }, { value: '/' }]], null, null]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.prefix, '');
        assert.equal((result as any).delimiter, '/');
    });
    it('Commands: namespace fallback without capability', async () => {
        const connection: any = createMockConnection({
            state: 2, // AUTHENTICATED
            capabilities: new Map(), // No NAMESPACE capability
            exec: async (cmd: any, args: any, opts: any) => {
                assert.equal(cmd, 'LIST');
                if (opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.delimiter, '/');
        assert.equal((connection as any).namespaces.other, false);
        assert.equal((connection as any).namespaces.shared, false);
    });
    it('Commands: namespace fallback adds delimiter to prefix', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '.' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.delimiter, '.');
    });
    it('Commands: namespace handles empty response', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.prefix, '');
        assert.equal((result as any).delimiter, '.');
    });
    it('Commands: namespace handles NIL namespaces', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.delimiter, '/');
        assert.equal((connection as any).namespaces.other, false);
        assert.equal((connection as any).namespaces.shared, false);
    });
    it('Commands: namespace handles NIL delimiter (RFC 2342)', (t, done) => {
        (async () => {
            // RFC 2342 §5: NIL delimiter means the namespace has no hierarchy.
            // The token parser emits a literal `null` for NIL.

            const connection: any = createMockConnection({
                state: 2,
                capabilities: new Map([['NAMESPACE', true]]),
                exec: async (cmd: any, args: any, opts: any) => {
                    if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                        await opts.untagged.NAMESPACE({
                            attributes: [
                                [
                                    [{ value: '' }, { value: '/' }],
                                    [{ value: '#hidden' }, null]
                                ],
                                null,
                                null
                            ]
                        });
                    }
                    return { next: () => {} };
                }
            });

            const result: any = await namespaceCommand(connection);

            // Guard against handler crash so a regression surfaces as a failed
            // assertion rather than fatal-halting the whole nodeunit suite.
            if (result && result.error) {
                assert.ok(false, 'namespace command returned error sentinel — likely crashed on NIL delimiter');
                done();
                return;
            }
            if (!Array.isArray((connection as any).namespaces && (connection as any).namespaces.personal)) {
                assert.ok(false, 'connection.namespaces.personal is not an array (handler crashed mid-untagged-callback)');
                done();
                return;
            }

            assert.equal((connection as any).namespaces.personal.length, 2, 'both personal entries should be parsed');

            assert.equal((connection as any).namespaces.personal[0].prefix, '');
            assert.equal((connection as any).namespaces.personal[0].delimiter, '/');

            // NIL-delimiter entry preserved with delimiter:null rather than dropped silently.
            assert.equal((connection as any).namespaces.personal[1].prefix, '#hidden');
            assert.equal((connection as any).namespaces.personal[1].delimiter, null);

            // Default namespace pointer resolves to the first valid personal entry.
            assert.equal(connection.namespace.prefix, '');
            assert.equal(connection.namespace.delimiter, '/');

            done();
        })().catch(done);
    });
    it('Commands: namespace handles NIL delimiter as only personal entry', (t, done) => {
        (async () => {
            // Edge case: only a NIL-delimiter entry in the personal section.
            // connection.namespace must still be set and usable downstream.

            const connection: any = createMockConnection({
                state: 2,
                capabilities: new Map([['NAMESPACE', true]]),
                exec: async (cmd: any, args: any, opts: any) => {
                    if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                        await opts.untagged.NAMESPACE({
                            attributes: [[[{ value: '#hidden' }, null]], null, null]
                        });
                    }
                    return { next: () => {} };
                }
            });

            const result: any = await namespaceCommand(connection);

            if (result && result.error) {
                assert.ok(false, 'namespace command returned error sentinel — likely crashed on NIL delimiter');
                done();
                return;
            }
            if (!Array.isArray((connection as any).namespaces && (connection as any).namespaces.personal)) {
                assert.ok(false, 'connection.namespaces.personal is not an array (handler crashed mid-untagged-callback)');
                done();
                return;
            }

            assert.equal((connection as any).namespaces.personal.length, 1);
            assert.equal((connection as any).namespaces.personal[0].prefix, '#hidden');
            assert.equal((connection as any).namespaces.personal[0].delimiter, null);

            assert.ok(connection.namespace);
            assert.equal(connection.namespace.prefix, '#hidden');
            assert.equal(connection.namespace.delimiter, null);

            done();
        })().catch(done);
    });
    it('Commands: namespace handles NIL delimiter in other and shared sections', (t, done) => {
        (async () => {
            // NIL delimiter is also valid in the `other` and `shared` sections,
            // not just `personal`.

            const connection: any = createMockConnection({
                state: 2,
                capabilities: new Map([['NAMESPACE', true]]),
                exec: async (cmd: any, args: any, opts: any) => {
                    if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                        await opts.untagged.NAMESPACE({
                            attributes: [[[{ value: '' }, { value: '/' }]], [[{ value: 'Other Users/' }, null]], [[{ value: 'Public/' }, null]]]
                        });
                    }
                    return { next: () => {} };
                }
            });

            const result: any = await namespaceCommand(connection);

            if (result && result.error) {
                assert.ok(false, 'namespace command returned error sentinel — likely crashed on NIL delimiter');
                done();
                return;
            }

            assert.ok(Array.isArray((connection as any).namespaces.other), 'other should be an array');
            assert.equal((connection as any).namespaces.other.length, 1);
            assert.equal((connection as any).namespaces.other[0].prefix, 'Other Users/');
            assert.equal((connection as any).namespaces.other[0].delimiter, null);

            assert.ok(Array.isArray((connection as any).namespaces.shared), 'shared should be an array');
            assert.equal((connection as any).namespaces.shared.length, 1);
            assert.equal((connection as any).namespaces.shared[0].prefix, 'Public/');
            assert.equal((connection as any).namespaces.shared[0].delimiter, null);

            done();
        })().catch(done);
    });
    it('Commands: namespace skips malformed entries without crashing', (t, done) => {
        (async () => {
            // The filter must reject entries that don't match either the
            // (string-prefix, string-delimiter) or (string-prefix, NIL) shape,
            // so a single broken entry from a buggy server doesn't poison
            // the whole namespace list or crash the handler.

            const connection: any = createMockConnection({
                state: 2,
                capabilities: new Map([['NAMESPACE', true]]),
                exec: async (cmd: any, args: any, opts: any) => {
                    if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                        await opts.untagged.NAMESPACE({
                            attributes: [
                                [
                                    [{ value: '' }, { value: '/' }], // valid
                                    [{ value: '#hidden' }, null], // valid (NIL delimiter)
                                    [{ value: 'broken' }], // too short — rejected
                                    [null, { value: '/' }], // null prefix — rejected
                                    [{ value: 123 }, { value: '/' }] // non-string prefix — rejected
                                ],
                                null,
                                null
                            ]
                        });
                    }
                    return { next: () => {} };
                }
            });

            const result: any = await namespaceCommand(connection);

            if (result && result.error) {
                assert.ok(false, 'namespace command returned error sentinel — likely crashed on malformed entry');
                done();
                return;
            }

            assert.equal((connection as any).namespaces.personal.length, 2, 'only the two well-formed entries should be kept');
            assert.equal((connection as any).namespaces.personal[0].prefix, '');
            assert.equal((connection as any).namespaces.personal[1].prefix, '#hidden');
            assert.equal((connection as any).namespaces.personal[1].delimiter, null);

            done();
        })().catch(done);
    });
    it('Commands: namespace handles multiple personal namespaces', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.ok(result);
        assert.equal((connection as any).namespaces.personal.length, 2);
        assert.equal((connection as any).namespaces.personal[0].prefix, 'INBOX.');
        assert.equal((connection as any).namespaces.personal[1].prefix, 'Mail/');
    });
    it('Commands: namespace works in SELECTED state', async () => {
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                    await opts.untagged.NAMESPACE({
                        attributes: [[[{ value: '' }, { value: '/' }]], null, null]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.delimiter, '/');
    });
    it('Commands: namespace handles error', async () => {
        let warnLogged = false;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async () => {
                const err: any = new Error('Namespace failed');
                err.responseStatus = 'NO';
                (err as any).responseText = 'Command not supported';
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

        const result: any = await namespaceCommand(connection);
        assert.ok((result as any).error);
        assert.equal((result as any)!.status, 'NO');
        assert.equal((result as any)!.text, 'Command not supported');
        assert.ok(warnLogged);
    });
    it('Commands: namespace fallback handles LIST error', async () => {
        let warnLogged = false;
        const connection: any = createMockConnection({
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

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        // Should return default namespace even on error
        assert.equal(result.prefix, '');
        assert.ok(warnLogged);
    });
    it('Commands: namespace appends delimiter to prefix if missing', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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

        const result: any = await namespaceCommand(connection);
        assert.equal((result as any).prefix, 'INBOX.');
    });
    it('Commands: namespace fallback strips leading delimiter from prefix', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
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

        const result: any = await namespaceCommand(connection);
        assert.equal((result as any).prefix, 'INBOX/');
    });
    it('Commands: namespace ignores empty NAMESPACE response attributes', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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

        const result: any = await namespaceCommand(connection);
        // Should return namespace from the second call
        assert.equal((result as any).prefix, 'INBOX.');
        assert.equal((result as any)!.delimiter, '.');
    });
    it('Commands: namespace sets default when personal namespace is empty array', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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

        const result: any = await namespaceCommand(connection);
        // Should set default personal namespace when personal[0] is falsy
        assert.equal((result as any).prefix, '');
        assert.equal((result as any)!.delimiter, '.');
    });
    it('Commands: namespace fallback ignores empty LIST attributes', async () => {
        let listCallCount = 0;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map(), // No NAMESPACE capability
            exec: async (cmd: any, args: any, opts: any) => {
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

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(listCallCount, 1);
        // With empty LIST, prefix and delimiter are undefined
        assert.equal(result.prefix, '');
    });

    // ============================================
    // QUOTA Command Tests
    // ============================================
    it('Commands: quota skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

        const result = await quotaCommand(connection, 'INBOX');
        assert.equal(result, undefined);
    });
    it('Commands: quota skips when no path', async () => {
        const connection: any = createMockConnection({ state: 2 });

        const result = await quotaCommand(connection, null as any);
        assert.equal(result, undefined);
    });
    it('Commands: quota returns false without capability', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map() // No QUOTA capability
        });

        const result = await quotaCommand(connection, 'INBOX');
        assert.equal(result, false);
    });
    it('Commands: quota with storage quota', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                assert.equal(cmd, 'GETQUOTAROOT');
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

        const result: any = await quotaCommand(connection, 'INBOX');
        assert.ok(result);
        assert.equal(result.path, 'INBOX');
        assert.equal(result.quotaRoot, 'user.root');
        assert.equal((result.storage as any).usage, 500 * 1024); // Converted to bytes
        assert.equal(result.storage!.limit, 1000 * 1024);
        assert.equal((result.storage as any)!.status, '50%');
    });
    it('Commands: quota with message quota', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.QUOTA) {
                    await opts.untagged.QUOTA({
                        attributes: [{ value: 'root' }, [{ value: 'MESSAGE' }, { value: '100' }, { value: '1000' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await quotaCommand(connection, 'INBOX');
        assert.ok(result);
        // MESSAGE quota is not multiplied by 1024
        assert.equal(result.message.usage, 100);
        assert.equal(result.message.limit, 1000);
        assert.equal(result.message.status, '10%');
    });
    it('Commands: quota with multiple quota types', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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

        const result: any = await quotaCommand(connection, 'INBOX');
        assert.ok((result as any).storage);
        assert.ok((result as any)!.message);
        assert.equal((result as any)!.storage.usage, 250 * 1024);
        assert.equal((result as any)!.message.usage, 50);
    });
    it('Commands: quota fetches GETQUOTA when quotaRoot but no QUOTA response', async () => {
        let getQuotaCalled = false;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (cmd === 'GETQUOTAROOT') {
                    if (opts && opts.untagged && opts.untagged.QUOTAROOT) {
                        await opts.untagged.QUOTAROOT({
                            attributes: [{ value: 'INBOX' }, { value: 'user.root' }]
                        });
                    }
                    // No QUOTA response
                } else if (cmd === 'GETQUOTA') {
                    getQuotaCalled = true;
                    assert.deepEqual(args, [{ type: 'ATOM', value: 'user.root' }]);
                    if (opts && opts.untagged && opts.untagged.QUOTA) {
                        await opts.untagged.QUOTA({
                            attributes: [{ value: 'user.root' }, [{ value: 'STORAGE' }, { value: '100' }, { value: '200' }]]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result: any = await quotaCommand(connection, 'INBOX');
        assert.ok(getQuotaCalled);
        assert.equal((result as any).quotaRoot, 'user.root');
        assert.equal((result as any)!.storage.usage, 100 * 1024);
    });
    it('Commands: quota handles zero limit', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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

        const result: any = await quotaCommand(connection, 'INBOX');
        assert.ok((result as any).storage);
        assert.equal((result as any)!.storage.usage, 0);
        assert.equal((result as any)!.storage.limit, 0);
        // No status when limit is 0
        assert.equal((result as any)!.storage.status, undefined);
    });
    it('Commands: quota handles empty attributes', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.ok(result);
        assert.equal(result.path, 'INBOX');
        assert.equal(result.storage, undefined);
    });
    it('Commands: quota works in SELECTED state', async () => {
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.QUOTA) {
                    await opts.untagged.QUOTA({
                        attributes: [{ value: '' }, [{ value: 'STORAGE' }, { value: '10' }, { value: '100' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await quotaCommand(connection, 'INBOX');
        assert.ok(result);
        assert.equal((result.storage as any).status, '10%');
    });
    it('Commands: quota handles error', async () => {
        let warnLogged = false;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async () => {
                const err: any = new Error('Quota failed');
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
        assert.equal(result, false);
        assert.ok(warnLogged);
    });
    it('Commands: quota handles error with status code', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async () => {
                const err: any = new Error('Quota failed');
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
        assert.equal(result, false);
    });
    it('Commands: quota normalizes path', async () => {
        let capturedArgs = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            namespace: { delimiter: '/', prefix: 'INBOX/' },
            exec: async (cmd: any, args: any) => {
                capturedArgs = args;
                return { next: () => {} };
            }
        });

        await quotaCommand(connection, 'Subfolder');
        assert.ok(capturedArgs);
    });
    it('Commands: quota handles non-numeric values', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.ok(result);
        // Non-numeric values should be skipped - no storage data set
        assert.equal(result.storage, undefined);
    });
    it('Commands: quota calculates percentage correctly', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.QUOTA) {
                    await opts.untagged.QUOTA({
                        attributes: [{ value: '' }, [{ value: 'MESSAGE' }, { value: '333' }, { value: '1000' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await quotaCommand(connection, 'INBOX');
        assert.equal((result as any).message.status, '33%'); // Rounded
    });
    it('Commands: quota handles falsy key in attributes', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.ok(result);
        // No quota data should be set since key was falsy
        assert.equal(Object.keys(result).filter(k => k !== 'path').length, 0);
    });
    it('Commands: quota sets limit without prior usage', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
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

        const result: any = await quotaCommand(connection, 'INBOX');
        assert.ok(result);
        assert.ok(result.storage);
        assert.equal(result.storage.limit, 1024000); // 1000 * 1024 for storage
        assert.equal(result.storage.usage, undefined);
    });

    // ============================================
    // AUTHENTICATE Command Tests
    // ============================================
    it('Commands: authenticate skips when already authenticated', async () => {
        const connection: any = createMockConnection({
            state: 2 // AUTHENTICATED
        });

        const result = await authenticateCommand(connection, 'user', { password: 'pass' });
        assert.equal(result, undefined);
    });
    it('Commands: authenticate with OAUTHBEARER', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1, // NOT_AUTHENTICATED
            capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            },
            write: () => {}
        });

        const result = await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });
        assert.equal(result, 'user@example.com');
        assert.equal(execArgs.cmd, 'AUTHENTICATE');
        assert.equal(execArgs!.args[0].value, 'OAUTHBEARER');
        assert.ok(connection.authCapabilities.has('AUTH=OAUTHBEARER'));
        assert.ok(decodeSaslPayload(execArgs).includes('port=993'), 'the payload should report the connection port');
    });
    it('Commands: OAUTHBEARER payload reports the port actually in use', async () => {
        // Regression: the port field was hardcoded to 993 - see lib/commands/authenticate.js.
        let execArgs = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
            servername: 'imap.example.com',
            port: 143,
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            },
            write: () => {}
        });

        await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });

        const payload = decodeSaslPayload(execArgs);
        assert.ok(payload.includes('port=143'), `expected port=143 in the SASL payload, got: ${JSON.stringify(payload)}`);
        assert.ok(payload.includes('host=imap.example.com'), 'the host field should still describe the connection');
    });
    it('Commands: OAUTHBEARER payload falls back to host when servername is false', async () => {
        // imap-flow.js sets servername = false for a bare-IP host, which rendered as "host=false".
        let execArgs = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
            servername: false,
            host: '198.51.100.7',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            },
            write: () => {}
        });

        await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });

        const payload = decodeSaslPayload(execArgs);
        assert.ok(payload.includes('host=198.51.100.7'), `expected the host as fallback, got: ${JSON.stringify(payload)}`);
        assert.ok(!payload.includes('host=false'), 'the literal "host=false" must never be sent');
    });
    it('Commands: authenticate with XOAUTH2', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=XOAUTH2', true]]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            },
            write: () => {}
        });

        const result = await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });
        assert.equal(result, 'user@example.com');
        assert.equal(execArgs.args[0].value, 'XOAUTH2');
        assert.ok(connection.authCapabilities.has('AUTH=XOAUTH2'));
    });
    it('Commands: authenticate with XOAUTH (legacy)', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=XOAUTH', true]]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            },
            write: () => {}
        });

        const result = await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });
        assert.equal(result, 'user@example.com');
        assert.equal(execArgs.args[0].value, 'XOAUTH2');
    });
    it('Commands: authenticate OAuth handles error response', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                // Simulate server sending error in plus tag
                if (opts && opts.onPlusTag) {
                    const errorJson = Buffer.from(JSON.stringify({ status: '401', error: 'invalid_token' })).toString('base64');
                    await opts.onPlusTag({
                        attributes: [{ type: 'TEXT', value: errorJson }]
                    });
                }
                const err: any = new Error('Authentication failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.authenticationFailed);
            assert.ok(err.oauthError as any);
            assert.equal(err.oauthError.status as any, '401');
        }
    });
    it('Commands: authenticate OAuth handles malformed error response', async () => {
        let debugLogged = false;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    // Malformed base64/JSON
                    await opts.onPlusTag({
                        attributes: [{ type: 'TEXT', value: 'not-valid-base64!' }]
                    });
                }
                const err: any = new Error('Authentication failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.authenticationFailed);
            assert.ok(debugLogged); // Should log the parse error
            assert.equal(err.oauthError as any, undefined); // No oauthError since parse failed
        }
    });
    it('Commands: authenticate OAuth error with serverResponseCode', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag({});
                }
                const err: any = new Error('Authentication failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.authenticationFailed);
            assert.equal(err.serverResponseCode as any, 'AUTHORIZATIONFAILED');
        }
    });
    it('Commands: authenticate with PLAIN', async () => {
        let execArgs: any = null;
        let writtenData = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=PLAIN', true]]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                execArgs = { cmd, args };
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag({});
                }
                return { next: () => {} };
            },
            write: (data: any) => {
                writtenData = data;
            },
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        const result = await authenticateCommand(connection, 'testuser', { password: 'testpass' });
        assert.equal(result, 'testuser');
        assert.equal(execArgs.cmd, 'AUTHENTICATE');
        assert.equal(execArgs!.args[0].value, 'PLAIN');
        // Verify PLAIN format: \x00username\x00password
        const decoded = (Buffer.from as any)(writtenData, 'base64').toString();
        assert.equal(decoded, '\x00testuser\x00testpass');
        assert.ok(connection.authCapabilities.has('AUTH=PLAIN'));
    });
    it('Commands: authenticate with PLAIN and authzid', async () => {
        let writtenData = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=PLAIN', true]]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag({});
                }
                return { next: () => {} };
            },
            write: (data: any) => {
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
        assert.equal(result, 'impersonated_user'); // Returns authzid when provided
        // Verify PLAIN format with authzid: authzid\x00username\x00password
        const decoded = (Buffer.from as any)(writtenData, 'base64').toString();
        assert.equal(decoded, 'impersonated_user\x00admin\x00adminpass');
    });
    it('Commands: authenticate with PLAIN forced via loginMethod', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([
                ['AUTH=LOGIN', true],
                ['AUTH=PLAIN', true]
            ]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.equal(execArgs.args[0].value, 'PLAIN');
    });
    it('Commands: authenticate with LOGIN', async () => {
        let execArgs: any = null;
        let writeCount = 0;
        let writtenValues: any = [];
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=LOGIN', true]]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
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
            write: (data: any) => {
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
        assert.equal(result, 'loginuser');
        assert.equal(execArgs.args[0].value, 'LOGIN');
        assert.equal(writeCount, 2);
        assert.equal(writtenValues[0], 'loginuser');
        assert.equal(writtenValues[1], 'loginpass');
        assert.ok(connection.authCapabilities.has('AUTH=LOGIN'));
    });
    it('Commands: authenticate with LOGIN handles user name prompt', async () => {
        let writtenValues: any = [];
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=LOGIN', true]]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
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
            write: (data: any) => {
                writtenValues.push(Buffer.from(data, 'base64').toString());
            },
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        await authenticateCommand(connection, 'testuser', { password: 'testpass' });
        assert.equal(writtenValues[0], 'testuser');
        assert.equal(writtenValues[1], 'testpass');
    });
    it('Commands: authenticate with LOGIN throws on unknown question', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=LOGIN', true]]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('Unknown LOGIN question'));
        }
    });
    it('Commands: authenticate with LOGIN forced via loginMethod', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([
                ['AUTH=PLAIN', true],
                ['AUTH=LOGIN', true]
            ]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.equal(execArgs.args[0].value, 'LOGIN');
    });
    it('Commands: authenticate PLAIN handles error', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=PLAIN', true]]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag({});
                }
                const err: any = new Error('Authentication failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.authenticationFailed);
            assert.equal(err.serverResponseCode as any, 'AUTHENTICATIONFAILED');
        }
    });
    it('Commands: authenticate LOGIN handles error', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=LOGIN', true]]),
            authCapabilities: new Map(),
            exec: async () => {
                const err: any = new Error('Login failed');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.authenticationFailed);
            assert.equal(err.serverResponseCode as any, 'AUTHENTICATIONFAILED');
        }
    });
    it('Commands: authenticate throws unsupported mechanism', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map() // No auth capabilities
        });

        try {
            await authenticateCommand(connection, 'user', { password: 'pass' });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('Unsupported authentication mechanism'));
        }
    });
    it('Commands: authenticate throws unsupported for accessToken without OAuth capability', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=PLAIN', true]]) // No OAuth capability
        });

        try {
            await authenticateCommand(connection, 'user', { accessToken: 'token123' });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('Unsupported authentication mechanism'));
        }
    });
    it('Commands: authenticate prefers PLAIN over LOGIN by default', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([
                ['AUTH=LOGIN', true],
                ['AUTH=PLAIN', true]
            ]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.equal(execArgs.args[0].value, 'PLAIN'); // PLAIN should be preferred
    });
    it('Commands: authenticate prefers OAuth when accessToken provided', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([
                ['AUTH=PLAIN', true],
                ['AUTH=OAUTHBEARER', true]
            ]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any) => {
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
        assert.equal(execArgs.args[0].value, 'OAUTHBEARER'); // OAuth preferred when token provided
    });

    // ============================================
    // CREATE Command Tests
    // ============================================
    it('Commands: create skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

        const result = await createCommand(connection, 'NewFolder');
        assert.equal(result, undefined);
    });
    it('Commands: create mailbox success', async () => {
        let execArgs: any = null;
        let subscribeCalled = false;
        const connection: any = createMockConnection({
            state: 2, // AUTHENTICATED
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return {
                    next: () => {},
                    response: { attributes: [] }
                };
            },
            run: async (cmd: any, path: any) => {
                if (cmd === 'SUBSCRIBE') {
                    subscribeCalled = true;
                    assert.equal(path, 'NewFolder');
                }
            }
        });

        const result = await createCommand(connection, 'NewFolder');
        assert.ok(result);
        assert.equal(result.path, 'NewFolder');
        assert.equal(result.created, true);
        assert.equal(execArgs.cmd, 'CREATE');
        assert.ok(subscribeCalled);
    });
    it('Commands: create works in SELECTED state', async () => {
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            exec: async () => ({
                next: () => {},
                response: { attributes: [] }
            }),
            run: async () => {}
        });

        const result = await createCommand(connection, 'NewFolder');
        assert.ok(result);
        assert.equal(result.created, true);
    });
    it('Commands: create with MAILBOXID response', async () => {
        const connection: any = createMockConnection({
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
        assert.ok(result);
        assert.equal(result.mailboxId, 'F12345');
        assert.equal(result.created, true);
    });
    it('Commands: create normalizes path', async () => {
        let capturedArgs = null;
        const connection: any = createMockConnection({
            state: 2,
            namespace: { delimiter: '/', prefix: 'INBOX/' },
            exec: async (cmd: any, args: any) => {
                capturedArgs = args;
                return {
                    next: () => {},
                    response: { attributes: [] }
                };
            },
            run: async () => {}
        });

        await createCommand(connection, 'Subfolder');
        assert.ok(capturedArgs);
    });
    it('Commands: create handles ALREADYEXISTS', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Mailbox already exists');
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
        assert.ok(result);
        assert.equal(result.path, 'ExistingFolder');
        assert.equal(result.created, false);
    });
    it('Commands: create throws on other errors', async () => {
        let warnLogged = false;
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Permission denied');
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
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.serverResponseCode, 'NOPERM');
            assert.ok(warnLogged);
        }
    });
    it('Commands: create handles empty section', async () => {
        const connection: any = createMockConnection({
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
        assert.ok(result);
        assert.equal(result.created, true);
        assert.equal(result.mailboxId, undefined);
    });
    it('Commands: create handles invalid MAILBOXID format', async () => {
        const connection: any = createMockConnection({
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
        assert.ok(result);
        assert.equal(result.created, true);
        // mailboxId should not be set due to invalid format
        assert.equal(result.mailboxId, undefined);
    });
    it('Commands: create handles null key in section', async () => {
        const connection: any = createMockConnection({
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
        assert.ok(result);
        assert.equal(result.created, true);
    });

    // ============================================
    // ENABLE Command Tests
    // ============================================
    it('Commands: enable skips without ENABLE capability', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map() // No ENABLE capability
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.equal(result, undefined);
    });
    it('Commands: enable skips when not authenticated', async () => {
        const connection: any = createMockConnection({
            state: 3, // SELECTED - not AUTHENTICATED
            capabilities: new Map([['ENABLE', true]])
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.equal(result, undefined);
    });
    it('Commands: enable skips when no supported extensions', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['ENABLE', true]]) // Has ENABLE but not CONDSTORE
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.equal(result, undefined);
    });
    it('Commands: enable single extension', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.ok(result instanceof Set);
        assert.ok(result.has('CONDSTORE'));
        assert.equal(execArgs.cmd, 'ENABLE');
        assert.equal(execArgs!.args[0].value, 'CONDSTORE');
        assert.ok(connection.enabled.has('CONDSTORE'));
    });
    it('Commands: enable multiple extensions', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true],
                ['QRESYNC', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.ok(result instanceof Set);
        assert.ok(result.has('CONDSTORE'));
        assert.ok(result.has('QRESYNC'));
        assert.equal(execArgs.args.length, 2);
    });
    it('Commands: enable filters unsupported extensions', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
                // QRESYNC not supported
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.ok(result instanceof Set);
        assert.ok(result.has('CONDSTORE'));
        assert.ok(!result.has('QRESYNC'));
        // Only CONDSTORE should be in the request
        assert.equal(execArgs.args.length, 1);
        assert.equal(execArgs!.args[0].value, 'CONDSTORE');
    });
    it('Commands: enable converts to uppercase', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.ok(result instanceof Set);
        assert.ok(result.has('CONDSTORE')); // Stored as uppercase
        assert.equal(execArgs.args[0].value, 'CONDSTORE'); // Sent as uppercase
    });
    it('Commands: enable handles empty ENABLED response', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: [] // Empty
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.ok(result instanceof Set);
        assert.equal(result.size, 0);
    });
    it('Commands: enable handles null attributes', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: null
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.ok(result instanceof Set);
        assert.equal(result.size, 0);
    });
    it('Commands: enable trims response values', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: [{ value: '  CONDSTORE  ' }] // With whitespace
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await enableCommand(connection, ['CONDSTORE']);
        assert.ok((result as any).has('CONDSTORE'));
    });
    it('Commands: enable handles error', async () => {
        let warnLogged = false;
        const connection: any = createMockConnection({
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
        assert.equal(result, false);
        assert.ok(warnLogged);
    });
    it('Commands: enable skips non-string attribute values', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
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
        assert.ok(result instanceof Set);
        assert.equal(result.size, 1);
        assert.ok(result.has('CONDSTORE'));
    });
    it('Commands: enable updates connection.enabled', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true],
                ['UTF8=ACCEPT', true]
            ]),
            enabled: new Set(['EXISTING']),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: [{ value: 'CONDSTORE' }, { value: 'UTF8=ACCEPT' }]
                    });
                }
                return { next: () => {} };
            }
        });

        await enableCommand(connection, ['CONDSTORE', 'UTF8=ACCEPT']);
        // New grants are merged in; earlier grants survive because the untagged
        // ENABLED response only lists extensions enabled by this command (RFC 5161)
        assert.ok(connection.enabled.has('CONDSTORE'));
        assert.ok(connection.enabled.has('UTF8=ACCEPT'));
        assert.ok(connection.enabled.has('EXISTING'));
    });

    // ============================================
    // Download / DownloadMany Tests
    // ============================================
    it('Commands: download returns empty when no mailbox selected', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });
        // mailbox is not set by default
        let result = await client.download('1', '1.2');
        assert.deepEqual(result, {});
    });
    it('Commands: downloadMany returns empty when no mailbox selected', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });
        let result = await client.downloadMany('1', ['2', '3']);
        assert.deepEqual(result, {});
    });
    it('Commands: download with fetchOne returning null', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });
        // Set mailbox so download doesn't return {} early
        client.mailbox = { path: 'INBOX' } as MailboxObject;
        // Mock fetchOne to return null (message not found)
        (client as any).fetchOne = async () => null;

        // part '1' triggers the bodyStructure check path
        let result: any = await client.download('1', '1');
        assert.equal(result.response, false);
        assert.equal((result as any).chunk, false);
    });
    it('Commands: downloadMany with fetchOne returning null', async () => {
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });
        client.mailbox = { path: 'INBOX' } as MailboxObject;
        (client as any).fetchOne = async () => null;

        let result = await client.downloadMany('1', ['2', '3']);
        assert.equal(result.response, false);
    });

    // ============================================
    // Security regression tests: hostile server input
    // ============================================
    it('Commands: quota ignores prototype-chain and fixed-field resource names', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.QUOTA) {
                    await opts.untagged.QUOTA({
                        attributes: [
                            { value: '' },
                            [
                                { value: '__PROTO__' },
                                { value: '10' },
                                { value: '100' },
                                { value: 'CONSTRUCTOR' },
                                { value: '1' },
                                { value: '2' },
                                { value: 'PATH' },
                                { value: '3' },
                                { value: '4' },
                                { value: 'STORAGE' },
                                { value: '250' },
                                { value: '500' }
                            ]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await quotaCommand(connection, 'INBOX');
        // Capture before cleaning up: deleting first would erase exactly the evidence the
        // assertion looks for, and the test would then pass with the guard removed. The cleanup
        // still has to happen so a regression cannot leak into the rest of the suite.
        let leaked = ['usage', 'limit', 'status'].filter(key => Object.hasOwn(Object.prototype, key));
        delete (Object.prototype as any).usage;
        delete (Object.prototype as any).limit;
        delete (Object.prototype as any).status;
        assert.deepEqual(leaked, [], 'Object.prototype must stay clean');
        assert.equal((result as any).path, 'INBOX', 'the fixed path field must not be overwritten');
        assert.ok(!Object.prototype.hasOwnProperty.call(result, 'constructor'));
        assert.equal((result as any)!.storage.usage, 250 * 1024);
        assert.equal((result as any)!.storage.limit, 500 * 1024);
    });
    it('Commands: select ignores unknown response codes on the mailbox object', async () => {
        const connection: any = createMockConnection({
            state: 2, // AUTHENTICATED
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged) {
                    if (opts.untagged.OK) {
                        // A response code the client does not know must not become a mailbox
                        // property: "PATH" would otherwise overwrite mailbox.path (defeating the
                        // DELETE/RENAME guards), and "__PROTO__" with a list value would replace
                        // the object's prototype
                        await opts.untagged.OK({
                            attributes: [{ section: [{ type: 'ATOM', value: 'PATH' }, { value: 'INBOX.evil' }] }]
                        });
                        await opts.untagged.OK({
                            attributes: [{ section: [{ type: 'ATOM', value: '__PROTO__' }, [{ value: 'polluted' }]] }]
                        });
                        await opts.untagged.OK({
                            attributes: [{ section: [{ type: 'ATOM', value: 'UIDNEXT' }, { value: '1000' }] }]
                        });
                        // malformed codes must not crash the handler or corrupt state either:
                        // a NIL key, a NIL value, and a UIDNEXT digit run that overflows to Infinity
                        await opts.untagged.OK({
                            attributes: [{ section: [null] }]
                        });
                        await opts.untagged.OK({
                            attributes: [{ section: [{ type: 'ATOM', value: 'UIDNEXT' }, null] }]
                        });
                        await opts.untagged.OK({
                            attributes: [{ section: [{ type: 'ATOM', value: 'UIDNEXT' }, { value: '9'.repeat(400) }] }]
                        });
                    }
                    if (opts.untagged.EXISTS) {
                        // an overflowing count must be ignored, not stored as Infinity
                        await opts.untagged.EXISTS({ command: '9'.repeat(400) });
                    }
                }
                return {
                    next: () => {},
                    response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
                };
            },
            emit: () => {}
        });

        const result: any = await selectCommand(connection, 'INBOX');
        assert.equal(result.path, 'INBOX', 'a PATH response code must not overwrite mailbox.path');
        assert.equal(result!.uidNext, 1000, 'malformed UIDNEXT values must not replace a good one');
        assert.equal(result!.exists, undefined, 'an overflowing EXISTS count must be ignored');
        assert.equal((result as any)!.polluted, undefined);
        // A "__proto__" key with a list value replaces the object's prototype rather than creating
        // an own property, so the own-property check alone would hold with the guard removed too -
        // the prototype identity is what actually detects it
        assert.equal(Object.getPrototypeOf(result), Object.prototype, 'the mailbox object must keep its prototype');
        assert.ok(!Object.prototype.hasOwnProperty.call(result, '__proto__'));
    });
    it('Commands: downloadMany ignores prototype-chain part keys', async () => {
        // The server chooses the BODY[...] keys in its FETCH answers: without a guard a
        // "__proto__" key wrote attacker-controlled content onto Object.prototype
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' }
        });
        client.mailbox = { path: 'INBOX' } as MailboxObject;
        (client as any).fetchOne = async () => ({
            bodyParts: new Map([
                ['__proto__', Buffer.from('polluted')],
                ['2.mime', Buffer.from('Content-Type: text/plain\r\n\r\n')],
                ['2', Buffer.from('real content')]
            ])
        });

        let result: any = await client.downloadMany('1', ['2']);
        // Capture before cleaning up: deleting first would erase exactly the evidence the
        // assertion looks for, and the test would then pass with the guard removed
        let leaked = Object.hasOwn(Object.prototype, 'content') || Object.hasOwn(Object.prototype, 'meta');
        delete (Object.prototype as any).content;
        delete (Object.prototype as any).meta;
        assert.equal(leaked, false, 'Object.prototype must stay clean');
        assert.ok(result['2']);
        assert.equal(result['2'].content.toString(), 'real content');
        assert.equal(result['2'].meta.contentType, 'text/plain');
    });
    it('Commands: select leaves permanentFlags unset for a NIL PERMANENTFLAGS', async () => {
        // An empty Set is not the same as "unset": canUseFlag() treats unset as permissive and an
        // empty set as deny-all, which would silently turn every later flag update into a no-op
        const result: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'PERMANENTFLAGS' }, null]]) as any, 'INBOX');
        assert.equal(result.permanentFlags, undefined, 'a NIL value must not produce an empty flag set');
        assert.ok(canUseFlag(result, '\\Seen'), 'flag updates must stay permitted');
    });
    it('Commands: select ignores an unparenthesized PERMANENTFLAGS value', async () => {
        // new Set('\\Seen') would be a set of the individual characters
        const result: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'PERMANENTFLAGS' }, { value: '\\Seen' }]]) as any, 'INBOX');
        assert.equal(result.permanentFlags, undefined);
        assert.ok(canUseFlag(result, '\\Seen'));
    });
    it('Commands: select survives NIL entries inside a PERMANENTFLAGS list', async () => {
        const result: any = await selectCommand(
            selectWithOkCodes([[{ type: 'ATOM', value: 'PERMANENTFLAGS' }, [{ value: '\\Seen' }, null, { value: '\\Draft' }]]]) as any,
            'INBOX'
        );
        assert.deepEqual((Array.from as any)(result.permanentFlags), ['\\Seen', '\\Draft']);
    });
    it('Commands: select survives NIL entries inside a FLAGS response', async () => {
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.FLAGS) {
                    await opts.untagged.FLAGS({ attributes: [[{ value: '\\Seen' }, null, { value: '\\Flagged' }]] });
                }
                return { next: () => {}, response: { attributes: [] } };
            },
            emit: () => {}
        });

        const result: any = await selectCommand(connection, 'INBOX');
        assert.deepEqual((Array.from as any)(result.flags), ['\\Seen', '\\Flagged'], 'a NIL entry must not cost the whole flag list');
    });
    it('Commands: select handles a tagged OK carrying no response text', async () => {
        // "A1 OK" parses to an object with no `attributes` property at all. Reading through it in
        // the command body would land in the outer catch, which tears down the mailbox state the
        // server has actually selected and rejects the caller with a TypeError.
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            run: async () => [],
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.EXISTS) {
                    await opts.untagged.EXISTS({ command: '42' });
                }
                return { next: () => {}, response: { tag: 'A1', command: 'OK' } };
            },
            emit: () => {}
        });

        const result: any = await selectCommand(connection, 'INBOX');
        assert.equal(result.path, 'INBOX');
        assert.equal(result!.exists, 42, 'collected mailbox data must survive');
        assert.equal(result!.readOnly, undefined);
        assert.equal(connection.state, connection.states.SELECTED, 'the mailbox must stay selected');
    });
    it('Commands: select exposes UNSEEN and APPENDLIMIT', async () => {
        const result: any = await selectCommand(
            selectWithOkCodes([
                [{ type: 'ATOM', value: 'UNSEEN' }, { value: '12' }],
                [{ type: 'ATOM', value: 'APPENDLIMIT' }, { value: '35651584' }]
            ]) as any,
            'INBOX'
        );
        assert.equal(result.unseen, 12);
        assert.equal(result!.appendlimit, 35651584);
    });
    it('Commands: select drops an unusable HIGHESTMODSEQ instead of storing it raw', async () => {
        // A non-numeric string stored in a BigInt field compares false in both directions, so the
        // value could never advance again and CONDSTORE/QRESYNC delta sync would stop for good
        for (let bad of ['none', '1e5', '-1', '', '9'.repeat(20)]) {
            const result: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'HIGHESTMODSEQ' }, { value: bad }]]) as any, 'INBOX');
            assert.equal(result.highestModseq, undefined, `HIGHESTMODSEQ ${JSON.stringify(bad)} must be dropped`);
        }

        const good: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'HIGHESTMODSEQ' }, { value: '9122' }]]) as any, 'INBOX');
        assert.equal(good.highestModseq, 9122n);
    });
    it('Commands: select accepts only decimal UIDNEXT values', async () => {
        for (let bad of ['0x10', '1e3', '  12  ', '-5', '1.5']) {
            const result: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'UIDNEXT' }, { value: bad }]]) as any, 'INBOX');
            assert.equal(result.uidNext, undefined, `UIDNEXT ${JSON.stringify(bad)} must be dropped`);
        }

        const good: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'UIDNEXT' }, { value: '1000' }]]) as any, 'INBOX');
        assert.equal(good.uidNext, 1000);
    });
    it('Commands: append survives a malformed APPENDUID', async () => {
        // BigInt('1e5') throws where isNaN('1e5') passes, and append rethrows - the message is
        // already stored at that point, so a retrying caller would duplicate it
        const connection: any = createMockConnection({
            state: 2,
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [
                        {
                            section: [{ type: 'ATOM', value: 'APPENDUID' }, { value: '1e5' }, { value: '7' }]
                        }
                    ]
                }
            })
        });

        const result = await appendCommand(connection, 'INBOX', Buffer.from('test'));
        assert.ok(result, 'append must not reject on an unusable APPENDUID');
        assert.equal(result.uidValidity, undefined, 'the unusable uidValidity is dropped');
        assert.equal(result.uid, 7, 'the usable uid is still reported');
    });
    it('Commands: append ignores an overflowing EXISTS count', async () => {
        // Number('9'.repeat(400)) is Infinity, and resolveRange('*') would then compile the literal
        // string "Infinity" into every later range-based command
        let emitted: any = [];
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 5, flags: new Set(), permanentFlags: new Set(['\\*']) },
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            emit: (name: any, payload: any) => emitted.push([name, payload]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.EXISTS) {
                    await opts.untagged.EXISTS({ command: '9'.repeat(400) });
                }
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await appendCommand(connection, 'INBOX', Buffer.from('test'));
        assert.equal(connection.mailbox.exists, 5, 'the live message count must be left alone');
        assert.equal(emitted.filter((entry: any) => entry[0] === 'exists').length, 0, 'no exists event may be emitted for an unusable count');
    });
    it('Commands: expunge survives a malformed HIGHESTMODSEQ', async () => {
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', highestModseq: 100n },
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [{ section: [{ type: 'ATOM', value: 'HIGHESTMODSEQ' }, { value: '1e5' }] }]
                }
            })
        });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, true, 'the expunge did happen, so it must not be reported as failed');
        assert.equal(connection.mailbox.highestModseq, 100n, 'the unusable value is not stored');
    });
    it('Commands: status skips one malformed field and keeps the rest', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [
                            { value: 'INBOX' },
                            [{ value: 'MESSAGES' }, { value: '1e5' }, { value: 'UIDNEXT' }, { value: '10' }, { value: 'UIDVALIDITY' }, { value: '99' }]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'INBOX', { messages: true, uidNext: true, uidValidity: true });
        assert.equal(result.messages, undefined, 'the unusable field is dropped');
        assert.equal((result as any).uidNext, 10, 'later fields must still be parsed');
        assert.equal((result as any).uidValidity, 99n);
    });
    it('Commands: status ignores an overflowing MESSAGES count for the selected mailbox', async () => {
        let emitted: any = [];
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 5 },
            emit: (name: any, payload: any) => emitted.push([name, payload]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [{ value: 'INBOX' }, [{ value: 'MESSAGES' }, { value: '9'.repeat(400) }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'INBOX', { messages: true });
        assert.equal(result.messages, undefined);
        assert.equal(connection.mailbox.exists, 5, 'the live message count must be left alone');
        assert.equal(emitted.filter((entry: any) => entry[0] === 'exists').length, 0);
    });
    it('Commands: search drops out-of-range values from an untagged SEARCH', async () => {
        // isNaN() passes '1e400' (Infinity), '-3' and '2.5'; a single one of those makes the
        // sequence set compiled from this result invalid and fails the caller's follow-up command
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.SEARCH) {
                    await opts.untagged.SEARCH({
                        attributes: [
                            { value: '1e400' },
                            { value: '-3' },
                            { value: '2.5' },
                            { value: '0' },
                            null, // a parsed NIL
                            { value: ['1'] }, // a parenthesized value where a number belongs
                            { value: '2' },
                            { value: '7' }
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await searchCommand(connection, { all: true }, {});
        assert.deepEqual(result, [2, 7], 'only valid nz-numbers may enter the result set');
    });
    it('Commands: downloadMany yields a part that arrived without its MIME headers', async () => {
        // A server may legally answer with fewer items than were requested. One part missing its
        // companion BODY[<part>.MIME] must not cost the caller the whole download.
        let client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });
        client.mailbox = { path: 'INBOX' } as MailboxObject;
        (client as any).fetchOne = async () => ({
            bodyParts: new Map([['2', Buffer.from('real content')]])
        });

        let result: any = await client.downloadMany('1', ['2']);
        assert.equal(result['2'].content.toString(), 'real content');
        assert.deepEqual(result['2'].meta, {}, 'a part with no MIME headers still gets a meta object');
    });
    it('Commands: list keeps a LIST-STATUS block when one field is malformed', async () => {
        // BigInt('1e5') throws where isNaN('1e5') passes, and the throw happened before the block
        // was stored - so one bad field made the whole mailbox's status vanish from the listing
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['LIST-STATUS', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST') {
                    if (opts && opts.untagged && opts.untagged.LIST) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                        });
                    }
                    if (opts && opts.untagged && opts.untagged.STATUS) {
                        await opts.untagged.STATUS({
                            attributes: [
                                { value: 'INBOX' },
                                [{ value: 'HIGHESTMODSEQ' }, { value: '1e5' }, { value: 'MESSAGES' }, { value: '10' }, { value: 'UNSEEN' }, { value: '5' }]
                            ]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', { statusQuery: { messages: true, unseen: true, highestModseq: true } });
        const inbox = result.find(entry => entry.path === 'INBOX');
        assert.ok(inbox && inbox.status, 'the status block must survive one unusable field');
        assert.equal(inbox.status.highestModseq, undefined, 'the unusable field is dropped');
        assert.equal(inbox.status.messages, 10);
        assert.equal(inbox.status.unseen, 5);
    });
    it('Commands: fetch stops retrying a throttled request once the client closes', async () => {
        // The retry used to wait on a bare setTimeout that close() could not abort: a short-lived
        // process stayed alive for up to five minutes after close(), still holding the retry
        let calls = 0;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 1, flags: new Set(), permanentFlags: new Set(), noModseq: true },
            // the wait reports aborted, which is what close() does to every tracked back-off
            throttleWait: async () => true,
            exec: async () => {
                calls++;
                const err: any = new Error('throttled');
                err.code = 'ETHROTTLE';
                (err as any).throttleReset = 60000;
                (err as any).responseText = 'throttled';
                throw err;
            }
        });

        let failure: any = null;
        try {
            await fetchCommand(connection, '1:*', { uid: true }, { uid: true });
        } catch (err) {
            failure = err;
        }

        assert.ok(failure, 'the caller is told the fetch did not happen');
        assert.equal(failure.code, 'NoConnection', 'an aborted back-off means the connection is gone');
        assert.equal(calls, 1, 'no retry may be issued on a closed connection');
    });
    it('Commands: select accepts an unparenthesized MAILBOXID', async () => {
        // RFC 8474 sends the id as a parenthesized list, but servers in the wild send it bare too
        const result: any = await selectCommand(selectWithOkCodes([[{ type: 'ATOM', value: 'MAILBOXID' }, { value: 'abc123' }]]) as any, 'INBOX');
        assert.equal(result.mailboxId, 'abc123');
    });
    it('Commands: quota ignores a NIL resource value', async () => {
        // A parsed NIL is null, which must not be recorded as a usage of 0
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'GETQUOTAROOT' && opts && opts.untagged && opts.untagged.QUOTA) {
                    await opts.untagged.QUOTA({
                        attributes: [{ value: 'root' }, [{ value: 'STORAGE' }, null, { value: '500' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await quotaCommand(connection, 'INBOX');
        assert.ok(result, 'the command must actually run');
        assert.equal((result.storage as any).usage, undefined, 'a NIL usage must not record a zero');
        assert.equal(result.storage!.limit, 500 * 1024, 'the limit that did parse is still reported');
    });
    it('Commands: status matches item names case-insensitively without reaching the prototype', async () => {
        // The item name is server-controlled and is used as a lookup key. Uppercasing it before the
        // lookup is what keeps a name like "constructor" from resolving to an inherited member, so
        // the matching has to stay case-insensitive AND prototype-safe at the same time.
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [
                            { value: 'INBOX' },
                            [
                                { value: 'constructor' },
                                { value: '1' },
                                { value: '__proto__' },
                                { value: '2' },
                                { value: 'toString' },
                                { value: '3' },
                                { value: 'messages' }, // lowercase: servers send uppercase, but be liberal
                                { value: '10' }
                            ]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'INBOX', { messages: true });
        assert.equal(result.messages, 10, 'a lowercase item name must still be recognized');
        assert.equal(Object.getPrototypeOf(result), Object.prototype, 'the status object must keep its prototype');
        assert.deepEqual(Object.keys(result).sort(), ['messages', 'path'], 'no prototype-chain name may become a field');
    });
    it('Commands: status does not touch live mailbox state for another mailbox', async () => {
        // The updaters exist to keep the selected mailbox current. Running them for a STATUS of a
        // different mailbox would overwrite exists/uidNext/highestModseq with another folder's counts.
        let emitted: any = [];
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 5, uidNext: 100, highestModseq: 7n },
            emit: (name: any, payload: any) => emitted.push([name, payload]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.STATUS) {
                    await opts.untagged.STATUS({
                        attributes: [
                            { value: 'Archive' },
                            [{ value: 'MESSAGES' }, { value: '999' }, { value: 'UIDNEXT' }, { value: '888' }, { value: 'HIGHESTMODSEQ' }, { value: '777' }]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await statusCommand(connection, 'Archive', { messages: true, uidNext: true, highestModseq: true });
        assert.equal(result.messages, 999, 'the queried mailbox is still reported');
        assert.equal(connection.mailbox.exists, 5, 'the selected mailbox count must be untouched');
        assert.equal(connection.mailbox.uidNext, 100);
        assert.equal(connection.mailbox.highestModseq, 7n);
        assert.equal(emitted.filter((entry: any) => entry[0] === 'exists').length, 0, 'no exists event for another mailbox');
    });
    it('Commands: search drops unusable ESEARCH COUNT, MIN and MAX values', async () => {
        // isNaN() passes '1e400' (Infinity) and '-1'; a COUNT of Infinity or a negative MIN is not a
        // usable answer and must not reach the caller
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['ESEARCH', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ESEARCH) {
                    await opts.untagged.ESEARCH({
                        attributes: [
                            [{ type: 'ATOM', value: 'TAG' }, { value: 'A1' }],
                            { type: 'ATOM', value: 'COUNT' },
                            { value: '1e400' },
                            { type: 'ATOM', value: 'MIN' },
                            { value: '-1' },
                            { type: 'ATOM', value: 'MAX' },
                            { value: '42' }
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await searchCommand(connection, { all: true }, { returnOptions: ['COUNT', 'MIN', 'MAX'] });
        assert.equal(result.count, undefined, 'an overflowing COUNT must be dropped');
        assert.equal((result as any).min, undefined, 'a negative MIN must be dropped');
        assert.equal((result as any).max, 42, 'a usable MAX is still reported');
    });
    it('Commands: quota drops unusable resource values', async () => {
        // isNaN() passes '1e5' and ' 12 '; neither is a usable octet count
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'GETQUOTAROOT' && opts && opts.untagged && opts.untagged.QUOTA) {
                    await opts.untagged.QUOTA({
                        attributes: [
                            { value: 'root' },
                            [{ value: 'STORAGE' }, { value: '1e5' }, { value: '500' }, { value: 'MESSAGE' }, { value: '10' }, { value: '20' }]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await quotaCommand(connection, 'INBOX');
        assert.ok(result, 'the command must actually run');
        assert.equal((result.storage as any).usage, undefined, 'an unusable usage must not be recorded');
        assert.equal(result.message.usage, 10, 'a usable resource is still reported');
        assert.equal(result.message.limit, 20);
    });
    it('Commands: list does not invent a special-use from a prototype-named mailbox', async () => {
        // The special-use hint map is keyed by server-supplied mailbox paths. On a plain object a
        // mailbox literally named "constructor" resolves to Object.prototype.constructor - truthy -
        // and the client would attach a special-use flag the server never sent.
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    for (let path of ['constructor', 'toString', '__proto__']) {
                        await opts.untagged.LIST({
                            attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: path }]
                        });
                    }
                }
                return { next: () => {} };
            }
        });

        const result = await listCommand(connection, '', '*', {});
        for (let path of ['constructor', 'toString', '__proto__']) {
            const entry = result.find(item => item.path === path);
            assert.ok(entry, `${path} must still be listed`);
            assert.equal(entry.specialUse, undefined, `${path} must not gain a special-use flag`);
        }
    });
});
