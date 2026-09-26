import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import logoutCommand from '../../src/commands/logout.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/logout', () => {
    it('Commands: logout success', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            exec: async (cmd: any) => {
                assert.equal(cmd, 'LOGOUT');
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await logoutCommand(connection);
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: logout handles error', async () => {
        const connection: any = createMockConnection({
            exec: async () => {
                throw new Error('Command failed');
            }
        });

        const result = await logoutCommand(connection);
        assert.equal(result, false);
    });
    it('Commands: logout returns early when already in LOGOUT state', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 4, // LOGOUT
            exec: async () => {
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await logoutCommand(connection);
        assert.equal(result, false);
        assert.equal(execCalled, false);
    });
    it('Commands: logout handles NOT_AUTHENTICATED state', async () => {
        let closeCalled = false;
        const connection: any = createMockConnection({
            state: 1, // NOT_AUTHENTICATED (mock states: 1=NOT_AUTH, 2=AUTH, 3=SELECTED, 4=LOGOUT)
            exec: async () => ({ next: () => {} }),
            close: () => {
                closeCalled = true;
            }
        });

        const result = await logoutCommand(connection);
        assert.equal(result, false);
        assert.equal(connection.state, connection.states.LOGOUT);
        assert.equal(closeCalled, true);
    });
    it('Commands: logout handles NoConnection error', async () => {
        const connection: any = createMockConnection({
            exec: async () => {
                const err: any = new Error('No connection');
                err.code = 'NoConnection';
                throw err;
            }
        });

        const result = await logoutCommand(connection);
        assert.equal(result, true);
    });
});
