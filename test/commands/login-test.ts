import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import loginCommand from '../../src/commands/login.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/login', () => {
    it('Commands: login success', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1, // NOT_AUTHENTICATED
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        const result = await loginCommand(connection, 'testuser', 'testpass');
        assert.equal(result, 'testuser');
        assert.equal(execArgs.cmd, 'LOGIN');
        assert.equal(execArgs!.attrs[0].value, 'testuser');
        assert.equal(execArgs!.attrs[1].value, 'testpass');
        assert.equal(execArgs!.attrs[1].sensitive, true);
    });
    it('Commands: login skips when already authenticated', async () => {
        const connection: any = createMockConnection({
            state: 2 // AUTHENTICATED
        });

        const result = await loginCommand(connection, 'testuser', 'testpass');
        assert.equal(result, undefined);
    });
    it('Commands: login handles error', async () => {
        const connection: any = createMockConnection({
            state: 1,
            exec: async () => {
                const err: any = new Error('Auth failed');
                err.response = { attributes: [] };
                throw err;
            }
        });

        try {
            await loginCommand(connection, 'testuser', 'wrongpass');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.authenticationFailed, true);
        }
    });
    it('Commands: login error includes serverResponseCode', async () => {
        const connection: any = createMockConnection({
            state: 1,
            exec: async () => {
                const err: any = new Error('Auth failed');
                err.response = {
                    tag: 'A1',
                    command: 'NO',
                    attributes: [
                        {
                            type: 'SECTION',
                            section: [{ type: 'ATOM', value: 'AUTHENTICATIONFAILED' }]
                        },
                        { type: 'TEXT', value: 'Authentication failed' }
                    ]
                };
                throw err;
            }
        });

        try {
            await loginCommand(connection, 'testuser', 'wrongpass');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.authenticationFailed, true);
            assert.equal(err.serverResponseCode as any, 'AUTHENTICATIONFAILED');
        }
    });
});
