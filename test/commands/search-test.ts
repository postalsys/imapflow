/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import searchCommand from '../../src/commands/search.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/search', () => {
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
});
