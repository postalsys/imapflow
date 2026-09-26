/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import moveCommand from '../../src/commands/move.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

// BigInt() is a standard JS function but triggers new-cap rule

describe('commands/move', () => {
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
});
