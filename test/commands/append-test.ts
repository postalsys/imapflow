/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import appendCommand from '../../src/commands/append.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

// BigInt() is a standard JS function but triggers new-cap rule

describe('commands/append', () => {
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
});
