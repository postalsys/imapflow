/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import statusCommand from '../../src/commands/status.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

// BigInt() is a standard JS function but triggers new-cap rule

describe('commands/status', () => {
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
});
