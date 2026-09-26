/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import selectCommand from '../../src/commands/select.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

// BigInt() is a standard JS function but triggers new-cap rule

describe('commands/select', () => {
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
    it('Commands: a throwing mailboxOpen listener does not stall select', async () => {
        let released = false;
        let warned: any = null;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'OldFolder' },
            folders: new Map([['INBOX', { path: 'INBOX' }]]),
            run: async () => [],
            exec: async () => ({
                next: () => {
                    released = true;
                },
                response: { attributes: [{ section: [{ type: 'ATOM', value: 'READ-WRITE' }] }] }
            }),
            emit: () => {
                throw new Error('listener failed');
            }
        });
        connection.log = { ...connection.log, warn: (entry: any) => (warned = warned || entry) };

        let result: any = await selectCommand(connection, 'INBOX');
        assert.equal(result.path, 'INBOX');
        assert.ok(released, 'the response is released so the next command can run');
        assert.equal(connection.state, 3, 'the new mailbox stays selected');
        assert.equal(warned.event, 'mailboxClose');
    });
});
