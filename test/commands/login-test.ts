import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import loginCommand from '../../src/commands/login.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/login', () => {
    it('Commands: login success', async () => {
        let execArgs: any = null;
        const connection = createMockConnection({
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
        const connection = createMockConnection({
            state: 2 // AUTHENTICATED
        });

        const result = await loginCommand(connection, 'testuser', 'testpass');
        assert.equal(result, undefined);
    });
    it('Commands: a throttled login is not a rejected credential', async () => {
        // Microsoft 365 answers a throttled LOGIN with BAD and a back-off hint, the credential
        // was never judged, so a caller must not treat the account as needing new credentials
        const connection = createMockConnection({
            state: 1,
            exec: async () => {
                const err: any = new Error('Command failed');
                err.responseStatus = 'BAD';
                err.code = 'ETHROTTLE';
                err.throttleReset = 1000;
                err.response = { attributes: [{ type: 'TEXT', value: 'Request is throttled. Suggested Backoff Time: 1000 milliseconds' }] };
                throw err;
            }
        });

        await assert.rejects(loginCommand(connection, 'testuser', 'testpass'), (err: any) => {
            assert.equal(err.code, 'ETHROTTLE');
            assert.equal(err.authenticationFailed, undefined);
            return true;
        });
    });
    it('Commands: login handles error', async () => {
        const connection = createMockConnection({
            state: 1,
            exec: async () => {
                const err: any = new Error('Auth failed');
                err.responseStatus = 'NO';
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
        const connection = createMockConnection({
            state: 1,
            exec: async () => {
                const err: any = new Error('Auth failed');
                err.responseStatus = 'NO';
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
    it('Commands: login does not flag a connection failure as an authentication failure', async () => {
        const connection = createMockConnection({
            state: 1,
            exec: async () => {
                const err: any = new Error('Connection not available');
                err.code = 'NoConnection';
                throw err;
            }
        });

        await assert.rejects(loginCommand(connection, 'testuser', 'pass'), (err: any) => err.code === 'NoConnection' && err.authenticationFailed === undefined);
    });
});
