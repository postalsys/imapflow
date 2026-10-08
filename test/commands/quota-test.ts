/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import quotaCommand from '../../src/commands/quota.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/quota', () => {
    it('Commands: quota skips when not authenticated', async () => {
        const connection = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

        const result = await quotaCommand(connection, 'INBOX');
        assert.equal(result, undefined);
    });
    it('Commands: quota skips when no path', async () => {
        const connection = createMockConnection({ state: 2 });

        const result = await quotaCommand(connection, null as any);
        assert.equal(result, undefined);
    });
    it('Commands: quota returns false without capability', async () => {
        const connection = createMockConnection({
            state: 2,
            capabilities: new Map() // No QUOTA capability
        });

        const result = await quotaCommand(connection, 'INBOX');
        assert.equal(result, false);
    });
    it('Commands: quota runs on an RFC 9208 server that only advertises QUOTA=RES-*', async () => {
        let sent: string[] = [];
        const connection = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA=RES-STORAGE', true]]),
            exec: async (cmd: any) => {
                sent.push(cmd);
                return { next: () => {} };
            }
        });

        assert.deepEqual(await quotaCommand(connection, 'INBOX'), { path: 'INBOX' });
        assert.deepEqual(sent, ['GETQUOTAROOT']);
    });
    it('Commands: quota takes a quota root sent as a literal', async () => {
        const connection = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (cmd === 'GETQUOTAROOT') {
                    // quota-root-name is an astring (RFC 9208), so it may come as a literal
                    await opts.untagged.QUOTAROOT({ attributes: [{ value: 'INBOX' }, { type: 'LITERAL', value: Buffer.from('user root') }] });
                }
                return { next: () => {} };
            }
        });

        const result: any = await quotaCommand(connection, 'INBOX');
        assert.equal(result.quotaRoot, 'user root');
    });
    it('Commands: quota with storage quota', async () => {
        const connection = createMockConnection({
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

        const result = await quotaCommand(connection, 'INBOX');
        assert.ok(result);
        assert.equal(result.path, 'INBOX');
        assert.equal(result.quotaRoot, 'user.root');
        assert.ok(result.storage);
        assert.equal(result.storage.usage, 500 * 1024); // Converted to bytes
        assert.equal(result.storage.limit, 1000 * 1024);
        assert.equal(result.storage.status, '50%');
    });
    it('Commands: quota with message quota', async () => {
        const connection = createMockConnection({
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
        assert.ok(result.message);
        // MESSAGE quota is not multiplied by 1024
        assert.equal(result.message.usage, 100);
        assert.equal(result.message.limit, 1000);
        assert.equal(result.message.status, '10%');
    });
    it('Commands: quota with multiple quota types', async () => {
        const connection = createMockConnection({
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

        const result = await quotaCommand(connection, 'INBOX');
        assert.ok(result);
        assert.ok(result.storage);
        assert.ok(result.message);
        assert.equal(result.storage.usage, 250 * 1024);
        assert.equal(result.message.usage, 50);
    });
    it('Commands: quota reports other resources under their lowercased name', async () => {
        const connection = createMockConnection({
            state: 2,
            capabilities: new Map([['QUOTA', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.QUOTA) {
                    // RFC 9208 resource types beyond STORAGE and MESSAGE
                    await opts.untagged.QUOTA({
                        attributes: [
                            { value: '' },
                            [{ value: 'MAILBOX' }, { value: '5' }, { value: '100' }, { value: 'ANNOTATION-STORAGE' }, { value: '3' }, { value: '12' }]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await quotaCommand(connection, 'INBOX');
        assert.ok(result);
        // counts are not scaled, only STORAGE is reported in kilobytes on the wire
        assert.deepEqual(result.mailbox, { usage: 5, limit: 100, status: '5%' });
        assert.deepEqual(result['annotation-storage'], { usage: 3, limit: 12, status: '25%' });
        assert.equal(result.storage, undefined);
    });
    it('Commands: quota fetches GETQUOTA when quotaRoot but no QUOTA response', async () => {
        let getQuotaCalled = false;
        const connection = createMockConnection({
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

        const result = await quotaCommand(connection, 'INBOX');
        assert.ok(getQuotaCalled);
        assert.ok(result);
        assert.equal(result.quotaRoot, 'user.root');
        assert.equal(result.storage?.usage, 100 * 1024);
    });
    it('Commands: quota handles zero limit', async () => {
        const connection = createMockConnection({
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

        const result = await quotaCommand(connection, 'INBOX');
        assert.ok(result);
        assert.ok(result.storage);
        assert.equal(result.storage.usage, 0);
        assert.equal(result.storage.limit, 0);
        // No status when limit is 0
        assert.equal(result.storage.status, undefined);
    });
    it('Commands: quota handles empty attributes', async () => {
        const connection = createMockConnection({
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
        const connection = createMockConnection({
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

        const result = await quotaCommand(connection, 'INBOX');
        assert.ok(result);
        assert.equal(result.storage?.status, '10%');
    });
    it('Commands: quota handles error', async () => {
        let warnLogged = false;
        const connection = createMockConnection({
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
        const connection = createMockConnection({
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
        const connection = createMockConnection({
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
        const connection = createMockConnection({
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
        const connection = createMockConnection({
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

        const result = await quotaCommand(connection, 'INBOX');
        assert.ok(result);
        assert.equal(result.message?.status, '33%'); // Rounded
    });
    it('Commands: quota handles falsy key in attributes', async () => {
        const connection = createMockConnection({
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
        const connection = createMockConnection({
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
                                { value: '1000' } // i=2, limit - should create the resource first
                            ]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await quotaCommand(connection, 'INBOX');
        assert.ok(result);
        assert.ok(result.storage);
        assert.equal(result.storage.limit, 1024000); // 1000 * 1024 for storage
        assert.equal(result.storage.usage, undefined);
    });
});
