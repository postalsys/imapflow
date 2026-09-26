import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import deleteCommand from '../../src/commands/delete.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/delete', () => {
    it('Commands: delete success', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await deleteCommand(connection, 'OldFolder');
        assert.ok(result);
        assert.equal(result.path, 'OldFolder');
        assert.equal(execCmd, 'DELETE');
    });
    it('Commands: delete skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 });

        const result = await deleteCommand(connection, 'OldFolder');
        assert.equal(result, undefined);
    });
    it('Commands: delete throws on error', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Delete failed');
                err.response = {
                    tag: '*',
                    command: 'NO',
                    attributes: [{ type: 'TEXT', value: 'Delete failed' }]
                };
                throw err;
            }
        });

        try {
            await deleteCommand(connection, 'OldFolder');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('Delete failed'));
        }
    });
    it('Commands: delete closes mailbox when deleting current mailbox', async () => {
        let closeCalled = false;
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'FolderToDelete' },
            run: async (cmd: any) => {
                if (cmd === 'CLOSE') {
                    closeCalled = true;
                }
            },
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await deleteCommand(connection, 'FolderToDelete');
        assert.ok(closeCalled, 'CLOSE should be called');
        assert.equal(execCmd, 'DELETE');
        assert.ok(result);
        assert.equal(result.path, 'FolderToDelete');
    });
    it('Commands: delete does not close when deleting different mailbox', async () => {
        let closeCalled = false;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'INBOX' },
            run: async (cmd: any) => {
                if (cmd === 'CLOSE') {
                    closeCalled = true;
                }
            },
            exec: async () => ({ next: () => {} })
        });

        const result = await deleteCommand(connection, 'OtherFolder');
        assert.ok(!closeCalled, 'CLOSE should not be called');
        assert.ok(result);
        assert.equal(result.path, 'OtherFolder');
    });
    it('Commands: delete works in SELECTED state', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'INBOX' },
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await deleteCommand(connection, 'SomeFolder');
        assert.ok(result);
        assert.equal(execCmd, 'DELETE');
    });
    it('Commands: delete error with serverResponseCode', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Delete failed');
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
            }
        });

        try {
            await deleteCommand(connection, 'NonExistent');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.serverResponseCode, 'NONEXISTENT');
        }
    });
    it('Commands: delete normalizes path', async () => {
        let execArgs = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, args: any) => {
                execArgs = args;
                return { next: () => {} };
            }
        });

        const result = await deleteCommand(connection, 'INBOX/Subfolder');
        assert.ok(result);
        assert.equal(result.path, 'INBOX/Subfolder');
        assert.ok(execArgs);
    });
});
