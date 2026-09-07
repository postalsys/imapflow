import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import searchCmd from '../src/commands/search.js';
import { parseEsearchResponse } from '../src/commands/esearch-parser.js';
import { ImapFlow } from '../src/imap-flow.js';
import type { MailboxObject } from '../src/types.js';

// Mock connection — capabilities is Map (matches real ImapFlow)
function makeConnection({ hasEsearch = true } = {}) {
    const caps = new Map();
    if (hasEsearch) {
        caps.set('ESEARCH', true);
    }
    return {
        state: 'SELECTED',
        states: { SELECTED: 'SELECTED' },
        capabilities: caps,
        enabled: new Set(),
        exec: async () => ({ next: () => {} }),
        log: { warn: () => {} }
    };
}

describe('search', () => {
    // ── Parser tests ───────────────────────────────────────────────────────────
    it('ESEARCH: parseEsearchResponse COUNT only', () => {
        const attrs = [
            { type: 'ATOM', value: 'COUNT' },
            { type: 'ATOM', value: '42' }
        ];
        const result = parseEsearchResponse(attrs);
        assert.equal(result.count, 42);
        assert.equal(result.min, undefined);
        assert.equal(result.max, undefined);
    });
    it('ESEARCH: parseEsearchResponse MIN MAX', () => {
        const attrs = [
            { type: 'ATOM', value: 'MIN' },
            { type: 'ATOM', value: '1001' },
            { type: 'ATOM', value: 'MAX' },
            { type: 'ATOM', value: '9876' }
        ];
        const result = parseEsearchResponse(attrs);
        assert.equal(result.min, 1001);
        assert.equal(result.max, 9876);
    });
    it('ESEARCH: parseEsearchResponse ALL keeps compact string', () => {
        const attrs = [
            { type: 'ATOM', value: 'ALL' },
            { type: 'ATOM', value: '1001,1005:1010,1020' }
        ];
        const result = parseEsearchResponse(attrs);
        // Must be preserved as compact string — NOT an array
        assert.equal(typeof result.all, 'string');
        assert.equal(result.all, '1001,1005:1010,1020');
    });
    it('ESEARCH: parseEsearchResponse PARTIAL (Array form)', () => {
        // Parser represents parenthesized groups as plain Arrays
        const attrs = [
            { type: 'ATOM', value: 'PARTIAL' },
            [
                { type: 'ATOM', value: '1:100' },
                { type: 'ATOM', value: '1001,1003:1010,1015' }
            ]
        ];
        const result = parseEsearchResponse(attrs);
        assert.deepEqual(result.partial, { range: '1:100', messages: '1001,1003:1010,1015' });
    });
    it('ESEARCH: parseEsearchResponse COUNT + PARTIAL combined', () => {
        const attrs = [
            { type: 'ATOM', value: 'COUNT' },
            { type: 'ATOM', value: '34201' },
            { type: 'ATOM', value: 'PARTIAL' },
            [
                { type: 'ATOM', value: '1:100' },
                { type: 'ATOM', value: '2001,2003:2020' }
            ]
        ];
        const result = parseEsearchResponse(attrs);
        assert.equal(result.count, 34201);
        assert.deepEqual(result.partial, { range: '1:100', messages: '2001,2003:2020' });
    });

    // ── Command-building tests ─────────────────────────────────────────────────
    it('ESEARCH: emits RETURN clause when returnOptions present and server has ESEARCH', (t, done) => {
        const conn: any = makeConnection({ hasEsearch: true });
        let capturedCommand: any = null;
        let capturedAttributes: any = null;
        conn.exec = async (command: any, attributes: any) => {
            capturedCommand = command;
            capturedAttributes = JSON.stringify(attributes);
            return { next: () => {} };
        };
        searchCmd(conn as any, { seen: false }, { uid: true, returnOptions: ['COUNT'] })
            .then(() => {
                assert.equal(capturedCommand, 'UID SEARCH');
                assert.ok(capturedAttributes.includes('"RETURN"'), 'should include RETURN atom');
                assert.ok(capturedAttributes.includes('"COUNT"'), 'should include COUNT in return list');
                done();
            })
            .catch(err => done(err));
    });
    it('ESEARCH: RETURN clause includes PARTIAL range atom', (t, done) => {
        const conn: any = makeConnection({ hasEsearch: true });
        let capturedAttributes: any = null;
        conn.exec = async (command: any, attributes: any) => {
            capturedAttributes = JSON.stringify(attributes);
            return { next: () => {} };
        };
        searchCmd(conn as any, { seen: false }, { uid: true, returnOptions: [{ partial: '1:100' }] })
            .then(() => {
                assert.ok(capturedAttributes.includes('"PARTIAL"'), 'should include PARTIAL atom');
                assert.ok(capturedAttributes.includes('"1:100"'), 'should include range string');
                done();
            })
            .catch(err => done(err));
    });
    it('ESEARCH: no RETURN clause when server lacks ESEARCH capability', (t, done) => {
        const conn: any = makeConnection({ hasEsearch: false });
        let capturedAttributes: any = null;
        conn.exec = async (command: any, attributes: any, handlers: any) => {
            capturedAttributes = JSON.stringify(attributes);
            // Simulate plain SEARCH response
            const searchHandler = handlers && handlers.untagged && handlers.untagged.SEARCH;
            if (searchHandler) {
                await searchHandler({
                    attributes: [{ value: '1' }, { value: '2' }, { value: '3' }]
                });
            }
            return { next: () => {} };
        };
        searchCmd(conn as any, { seen: false }, { uid: true, returnOptions: ['COUNT', 'ALL'] })
            .then(result => {
                assert.ok(!capturedAttributes.includes('"RETURN"'), 'should NOT include RETURN when no ESEARCH');
                assert.ok(Array.isArray(result), 'should return number[] when ESEARCH unavailable');
                assert.deepEqual(result, [1, 2, 3]);
                done();
            })
            .catch(err => done(err));
    });
    it('ESEARCH: parseEsearchResponse skips non-ATOM tokens', () => {
        const attrs = [
            [{ type: 'ATOM', value: 'stray' }], // non-ATOM (Array) token is skipped
            { type: 'ATOM', value: 'COUNT' },
            { type: 'ATOM', value: '9' }
        ];
        const result = parseEsearchResponse(attrs);
        assert.equal(result.count, 9);
    });
    it('ESEARCH: parseEsearchResponse skips trailing key with no value', () => {
        const attrs = [{ type: 'ATOM', value: 'COUNT' }]; // dangling key, no value
        const result = parseEsearchResponse(attrs);
        assert.deepEqual(result, {});
    });
    it('ESEARCH: untagged handler parses ESEARCH response', (t, done) => {
        const conn: any = makeConnection({ hasEsearch: true });
        conn.exec = async (command: any, attributes: any, handlers: any) => {
            const esearch = handlers && handlers.untagged && handlers.untagged.ESEARCH;
            // leading (TAG "A1") list + UID atom are stripped before parsing
            await esearch({
                attributes: [
                    [
                        { type: 'ATOM', value: 'TAG' },
                        { type: 'STRING', value: 'A1' }
                    ],
                    { type: 'ATOM', value: 'UID' },
                    { type: 'ATOM', value: 'COUNT' },
                    { type: 'ATOM', value: '7' }
                ]
            });
            // also exercise the empty-attributes guard
            await esearch({ attributes: null });
            return { next: () => {} };
        };
        searchCmd(conn as any, { seen: false }, { uid: true, returnOptions: ['COUNT'] })
            .then(result => {
                assert.equal((result as any).count, 7);
                done();
            })
            .catch(err => done(err));
    });
    it('ESEARCH: command path returns false on exec error', (t, done) => {
        const conn: any = makeConnection({ hasEsearch: true });
        conn.exec = async () => {
            let err: any = new Error('search failed');
            err.responseStatus = 'NO';
            throw err;
        };
        searchCmd(conn, { seen: false }, { uid: true, returnOptions: ['COUNT'] })
            .then(result => {
                assert.equal(result, false);
                done();
            })
            .catch(err => done(err));
    });
    it('ESEARCH: parseEsearchResponse ignores unknown keywords', () => {
        // Unknown result keywords must be skipped with their value so the
        // key/value stream stays aligned for the entries that follow
        const attrs = [
            { type: 'ATOM', value: 'RELEVANCY' },
            { type: 'ATOM', value: '87' },
            { type: 'ATOM', value: 'COUNT' },
            { type: 'ATOM', value: '5' }
        ];
        const result: any = parseEsearchResponse(attrs);
        assert.equal(result.count, 5);
        assert.equal(result.relevancy, undefined, 'unknown keys should not appear in result');
    });
    it('ESEARCH: parseEsearchResponse parses MODSEQ as BigInt', () => {
        // RFC 7162: CONDSTORE sessions append MODSEQ to ESEARCH responses when the
        // search used a MODSEQ criterion
        const attrs = [
            { type: 'ATOM', value: 'COUNT' },
            { type: 'ATOM', value: '5' },
            { type: 'ATOM', value: 'MODSEQ' },
            { type: 'ATOM', value: '9007199254740993' }
        ];
        const result = parseEsearchResponse(attrs);
        assert.equal(result.count, 5);
        assert.strictEqual(result.modseq, 9007199254740993n, 'modseq should be an exact BigInt');
    });
    it('ESEARCH: parseEsearchResponse drops non-numeric MODSEQ', () => {
        const attrs = [
            { type: 'ATOM', value: 'MODSEQ' },
            { type: 'ATOM', value: 'bogus' },
            { type: 'ATOM', value: 'COUNT' },
            { type: 'ATOM', value: '3' }
        ];
        const result = parseEsearchResponse(attrs);
        assert.equal(result.modseq, undefined, 'invalid modseq must be dropped');
        assert.equal(result.count, 3, 'stream must stay aligned after a dropped value');
    });
    it('ESEARCH: backward compat — no returnOptions returns number[]', (t, done) => {
        const conn: any = makeConnection({ hasEsearch: true });
        conn.exec = async (command: any, attributes: any, handlers: any) => {
            const searchHandler = handlers && handlers.untagged && handlers.untagged.SEARCH;
            if (searchHandler) {
                await searchHandler({
                    attributes: [{ value: '10' }, { value: '20' }]
                });
            }
            return { next: () => {} };
        };
        // No returnOptions — must return number[] even if server has ESEARCH
        searchCmd(conn as any, { seen: true }, { uid: true })
            .then(result => {
                assert.ok(Array.isArray(result));
                assert.deepEqual(result, [10, 20]);
                done();
            })
            .catch(err => done(err));
    });

    // ── imap-flow.js public API fallback test ─────────────────────────────────
    it('imap-flow: search() derives ESearchResult when server has no ESEARCH', (t, done) => {
        const client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });

        // Simulate a selected mailbox and no ESEARCH capability
        client.mailbox = { path: 'INBOX' } as MailboxObject;
        client.state = client.states.SELECTED;
        client.capabilities = new Map(); // no ESEARCH

        // Stub run() to return a sorted number[]
        client.run = async () => [10, 20, 30, 40, 50];

        client
            .search({ seen: false }, { uid: true, returnOptions: ['COUNT', 'MIN', 'MAX', 'ALL'] })
            .then(result => {
                assert.equal(typeof result, 'object', 'should return object, not array');
                assert.ok(!Array.isArray(result), 'should not be an array');
                assert.equal((result as any)!.count, 5);
                assert.equal((result as any)!.min, 10);
                assert.equal((result as any)!.max, 50);
                // packMessageRange([10,20,30,40,50]) → "10,20,30,40,50" (non-contiguous)
                assert.ok(typeof (result as any)!.all === 'string' && (result as any)!.all.length > 0, 'all should be non-empty compact string');
                done();
            })
            .catch(err => done(err));
    });
    it('imap-flow: search() fallback with empty result set', (t, done) => {
        const client = new ImapFlow({
            host: 'imap.example.com',
            port: 993,
            auth: { user: 'test', pass: 'test' },
            logger: false
        });
        client.mailbox = { path: 'INBOX' } as MailboxObject;
        client.state = client.states.SELECTED;
        client.capabilities = new Map();
        client.run = async () => [];
        client
            .search({}, { uid: true, returnOptions: ['COUNT', 'ALL'] })
            .then(result => {
                assert.equal((result as any)!.count, 0);
                assert.equal((result as any)!.all, undefined, 'all should be absent for empty result');
                done();
            })
            .catch(err => done(err));
    });
});
