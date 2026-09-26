/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import quotaCommand from '../../src/commands/quota.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/quota', () => {
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
});
