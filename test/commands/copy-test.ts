import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import copyCommand from '../../src/commands/copy.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/copy', () => {
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
});
