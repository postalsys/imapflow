import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import renameCommand from '../../src/commands/rename.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/rename', () => {
    it('Commands: rename success', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        const result = await renameCommand(connection, 'OldName', 'NewName');
        assert.ok(result);
        assert.equal(result.path, 'OldName');
        assert.equal(result.newPath, 'NewName');
        assert.equal(execArgs.cmd, 'RENAME');
    });
    it('Commands: rename skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 });

        const result = await renameCommand(connection, 'OldName', 'NewName');
        assert.equal(result, undefined);
    });
    it('Commands: rename throws on error', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Rename failed');
                err.response = {
                    tag: '*',
                    command: 'NO',
                    attributes: [{ type: 'TEXT', value: 'Rename failed' }]
                };
                throw err;
            }
        });

        try {
            await renameCommand(connection, 'OldName', 'NewName');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('Rename failed'));
        }
    });
    it('Commands: rename closes mailbox when renaming current mailbox', async () => {
        let closeCalled = false;
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'OldFolder' },
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

        const result = await renameCommand(connection, 'OldFolder', 'NewFolder');
        assert.ok(closeCalled, 'CLOSE should be called');
        assert.equal(execCmd, 'RENAME');
        assert.ok(result);
        assert.equal(result.path, 'OldFolder');
        assert.equal(result.newPath, 'NewFolder');
    });
    it('Commands: rename does not close when renaming different mailbox', async () => {
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

        const result = await renameCommand(connection, 'OtherFolder', 'NewName');
        assert.ok(!closeCalled, 'CLOSE should not be called');
        assert.ok(result);
    });
    it('Commands: rename works in SELECTED state', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            mailbox: { path: 'INBOX' },
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        const result = await renameCommand(connection, 'SomeFolder', 'NewName');
        assert.ok(result);
        assert.equal(execCmd, 'RENAME');
    });
    it('Commands: rename error with serverResponseCode', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Rename failed');
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
            await renameCommand(connection, 'NonExistent', 'NewName');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.serverResponseCode, 'NONEXISTENT');
        }
    });
    it('Commands: rename normalizes paths', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, args: any) => {
                execArgs = args;
                return { next: () => {} };
            }
        });

        const result = await renameCommand(connection, 'INBOX/Old', 'INBOX/New');
        assert.ok(result);
        assert.equal(result.path, 'INBOX/Old');
        assert.equal(result.newPath, 'INBOX/New');
        assert.ok(execArgs);
        assert.equal(execArgs.length, 2);
    });
});
