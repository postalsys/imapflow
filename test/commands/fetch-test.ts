/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fetchCommand from '../../src/commands/fetch.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/fetch', () => {
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
    it('Commands: fetch throws once every retry was throttled', async () => {
        // Running out of retries used to fall out of the loop and resolve undefined, which
        // fetchOne() and download() read as "message not found"
        let calls = 0;
        let waits: number[] = [];
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 1, flags: new Set(), permanentFlags: new Set(), noModseq: true },
            throttleWait: async (delay: number) => {
                waits.push(delay);
                return false;
            },
            exec: async () => {
                calls++;
                const err: any = new Error('throttled');
                err.code = 'ETHROTTLE';
                throw err;
            }
        });

        await assert.rejects(fetchCommand(connection, '1:*', { uid: true }, { uid: true }), (err: any) => err.code === 'ETHROTTLE');
        assert.equal(calls, 4, 'four attempts in total');
        assert.deepEqual(waits, [1000, 2000, 4000], 'no back-off after the last attempt');
    });
    it('Commands: fetch only waits out the part of the back-off the connection has not', async () => {
        let waits: number[] = [];
        let calls = 0;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX', exists: 1, flags: new Set(), permanentFlags: new Set(), noModseq: true },
            throttleWait: async (delay: number) => {
                waits.push(delay);
                return false;
            },
            exec: async () => {
                calls++;
                if (calls === 1) {
                    const err: any = new Error('throttled');
                    err.code = 'ETHROTTLE';
                    err.throttleReset = 10000;
                    err.throttleWaited = 6000;
                    throw err;
                }
                if (calls === 2) {
                    const err: any = new Error('throttled');
                    err.code = 'ETHROTTLE';
                    err.throttleReset = 500;
                    err.throttleWaited = 500;
                    throw err;
                }
                return { next: () => {} };
            }
        });

        let result = await fetchCommand(connection, '1', { uid: true });
        assert.ok(result);
        // 10000 hinted, 6000 already waited; then the 2000 back-off exceeds the 500 already waited
        assert.deepEqual(waits, [4000, 1500]);
    });
});
