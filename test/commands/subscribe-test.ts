import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import subscribeCommand from '../../src/commands/subscribe.js';
import unsubscribeCommand from '../../src/commands/unsubscribe.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/subscribe', () => {
    it('Commands: subscribe success', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await subscribeCommand(connection, 'Folder');
        assert.equal(result, true);
        assert.equal(execCmd, 'SUBSCRIBE');
    });
    it('Commands: subscribe skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 });

        const result = await subscribeCommand(connection, 'Folder');
        assert.equal(result, undefined);
    });
    it('Commands: unsubscribe success', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await unsubscribeCommand(connection, 'Folder');
        assert.equal(result, true);
        assert.equal(execCmd, 'UNSUBSCRIBE');
    });
    it('Commands: unsubscribe skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 });

        const result = await unsubscribeCommand(connection, 'Folder');
        assert.equal(result, undefined);
    });
    it('Commands: subscribe works in SELECTED state', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await subscribeCommand(connection, 'Folder');
        assert.equal(result, true);
        assert.equal(execCmd, 'SUBSCRIBE');
    });
    it('Commands: subscribe returns false on error', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Subscribe failed');
                err.response = {
                    tag: '*',
                    command: 'NO',
                    attributes: [{ type: 'TEXT', value: 'Subscribe failed' }]
                };
                throw err;
            }
        });

        const result = await subscribeCommand(connection, 'Folder');
        assert.equal(result, false);
    });
    it('Commands: subscribe error with serverResponseCode', async () => {
        let capturedErr: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Subscribe failed');
                err.response = {
                    tag: '*',
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
            log: {
                warn: (data: any) => {
                    capturedErr = data.err;
                }
            }
        });

        const result = await subscribeCommand(connection, 'NonExistent');
        assert.equal(result, false);
        assert.ok(capturedErr);
        assert.equal(capturedErr.serverResponseCode, 'NONEXISTENT');
    });
    it('Commands: subscribe normalizes path', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, args: any) => {
                execArgs = args;
                return { next: () => {} };
            }
        });

        const result = await subscribeCommand(connection, 'INBOX/Subfolder');
        assert.equal(result, true);
        assert.ok(execArgs);
        assert.equal(execArgs.length, 1);
    });
    it('Commands: unsubscribe works in SELECTED state', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await unsubscribeCommand(connection, 'Folder');
        assert.equal(result, true);
        assert.equal(execCmd, 'UNSUBSCRIBE');
    });
    it('Commands: unsubscribe returns false on error', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Unsubscribe failed');
                err.response = {
                    tag: '*',
                    command: 'NO',
                    attributes: [{ type: 'TEXT', value: 'Unsubscribe failed' }]
                };
                throw err;
            }
        });

        const result = await unsubscribeCommand(connection, 'Folder');
        assert.equal(result, false);
    });
    it('Commands: unsubscribe error with serverResponseCode', async () => {
        let capturedErr: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Unsubscribe failed');
                err.response = {
                    tag: '*',
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
            log: {
                warn: (data: any) => {
                    capturedErr = data.err;
                }
            }
        });

        const result = await unsubscribeCommand(connection, 'NonExistent');
        assert.equal(result, false);
        assert.ok(capturedErr);
        assert.equal(capturedErr.serverResponseCode, 'NONEXISTENT');
    });
    it('Commands: unsubscribe normalizes path', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, args: any) => {
                execArgs = args;
                return { next: () => {} };
            }
        });

        const result = await unsubscribeCommand(connection, 'INBOX/Subfolder');
        assert.equal(result, true);
        assert.ok(execArgs);
        assert.equal(execArgs.length, 1);
    });
});
