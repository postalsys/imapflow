import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import closeCommand from '../../src/commands/close.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/close', () => {
    it('Commands: close success', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            exec: async (cmd: any) => {
                assert.equal(cmd, 'CLOSE');
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await closeCommand(connection);
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: close skips when not selected', async () => {
        const connection: any = createMockConnection({
            state: 2 // AUTHENTICATED, not SELECTED
        });

        const result = await closeCommand(connection);
        assert.equal(result, undefined);
    });
    it('Commands: close handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                throw new Error('Command failed');
            }
        });

        const result = await closeCommand(connection);
        assert.equal(result, false);
    });
    it('Commands: close emits mailboxClose event', async () => {
        let emittedMailbox: any = null;
        const testMailbox = { path: 'INBOX', uidValidity: 12345n };
        const connection: any = createMockConnection({
            state: 3,
            mailbox: testMailbox,
            currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
            exec: async () => ({ next: () => {} }),
            emit: (event: any, data: any) => {
                if (event === 'mailboxClose') {
                    emittedMailbox = data;
                }
            }
        });

        const result = await closeCommand(connection);
        assert.equal(result, true);
        assert.ok(emittedMailbox);
        assert.equal(emittedMailbox.path, 'INBOX');
        assert.equal(connection.mailbox, false);
        assert.equal(connection.currentSelectCommand, false);
        assert.equal(connection.state, 2); // AUTHENTICATED
    });
    it('Commands: close without mailbox does not emit event', async () => {
        let eventEmitted = false;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: false, // No mailbox
            exec: async () => ({ next: () => {} }),
            emit: (event: any) => {
                if (event === 'mailboxClose') {
                    eventEmitted = true;
                }
            }
        });

        const result = await closeCommand(connection);
        assert.equal(result, true);
        assert.equal(eventEmitted, false);
    });
    it('Commands: close reports success when the mailboxClose listener throws', async () => {
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { path: 'INBOX' },
            exec: async () => ({ next: () => {} }),
            emit: () => {
                throw new Error('listener failed');
            }
        });

        assert.equal(await closeCommand(connection), true);
        assert.equal(connection.mailbox, false);
    });
});
