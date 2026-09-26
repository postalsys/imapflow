import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import authenticateCommand from '../../src/commands/authenticate.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

// Decodes the base64 SASL payload that authenticate() hands to exec().
const decodeSaslPayload = (execArgs: any) => Buffer.from(execArgs.args[1].value, 'base64').toString();

describe('commands/authenticate', () => {
    it('Commands: authenticate skips when already authenticated', async () => {
        const connection: any = createMockConnection({
            state: 2 // AUTHENTICATED
        });

        const result = await authenticateCommand(connection, 'user', { password: 'pass' });
        assert.equal(result, undefined);
    });
    it('Commands: authenticate with OAUTHBEARER', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1, // NOT_AUTHENTICATED
            capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            },
            write: () => {}
        });

        const result = await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });
        assert.equal(result, 'user@example.com');
        assert.equal(execArgs.cmd, 'AUTHENTICATE');
        assert.equal(execArgs!.args[0].value, 'OAUTHBEARER');
        assert.ok(connection.authCapabilities.has('AUTH=OAUTHBEARER'));
        assert.ok(decodeSaslPayload(execArgs).includes('port=993'), 'the payload should report the connection port');
    });
    it('Commands: OAUTHBEARER payload reports the port actually in use', async () => {
        // Regression: the port field was hardcoded to 993 - see lib/commands/authenticate.js.
        let execArgs = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
            servername: 'imap.example.com',
            port: 143,
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            },
            write: () => {}
        });

        await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });

        const payload = decodeSaslPayload(execArgs);
        assert.ok(payload.includes('port=143'), `expected port=143 in the SASL payload, got: ${JSON.stringify(payload)}`);
        assert.ok(payload.includes('host=imap.example.com'), 'the host field should still describe the connection');
    });
    it('Commands: OAUTHBEARER payload falls back to host when servername is false', async () => {
        // imap-flow.js sets servername = false for a bare-IP host, which rendered as "host=false".
        let execArgs = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
            servername: false,
            host: '198.51.100.7',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            },
            write: () => {}
        });

        await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });

        const payload = decodeSaslPayload(execArgs);
        assert.ok(payload.includes('host=198.51.100.7'), `expected the host as fallback, got: ${JSON.stringify(payload)}`);
        assert.ok(!payload.includes('host=false'), 'the literal "host=false" must never be sent');
    });
    it('Commands: authenticate with XOAUTH2', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=XOAUTH2', true]]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            },
            write: () => {}
        });

        const result = await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });
        assert.equal(result, 'user@example.com');
        assert.equal(execArgs.args[0].value, 'XOAUTH2');
        assert.ok(connection.authCapabilities.has('AUTH=XOAUTH2'));
    });
    it('Commands: authenticate with XOAUTH (legacy)', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=XOAUTH', true]]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            },
            write: () => {}
        });

        const result = await authenticateCommand(connection, 'user@example.com', { accessToken: 'token123' });
        assert.equal(result, 'user@example.com');
        assert.equal(execArgs.args[0].value, 'XOAUTH2');
    });
    it('Commands: authenticate OAuth handles error response', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                // Simulate server sending error in plus tag
                if (opts && opts.onPlusTag) {
                    const errorJson = Buffer.from(JSON.stringify({ status: '401', error: 'invalid_token' })).toString('base64');
                    await opts.onPlusTag({
                        attributes: [{ type: 'TEXT', value: errorJson }]
                    });
                }
                const err: any = new Error('Authentication failed');
                err.response = { attributes: [] };
                throw err;
            },
            write: () => {},
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        try {
            await authenticateCommand(connection, 'user@example.com', { accessToken: 'bad_token' });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.authenticationFailed);
            assert.ok(err.oauthError as any);
            assert.equal(err.oauthError.status as any, '401');
        }
    });
    it('Commands: authenticate OAuth handles malformed error response', async () => {
        let debugLogged = false;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    // Malformed base64/JSON
                    await opts.onPlusTag({
                        attributes: [{ type: 'TEXT', value: 'not-valid-base64!' }]
                    });
                }
                const err: any = new Error('Authentication failed');
                err.response = { attributes: [] };
                throw err;
            },
            write: () => {},
            log: {
                debug: () => {
                    debugLogged = true;
                },
                warn: () => {},
                trace: () => {}
            }
        });

        try {
            await authenticateCommand(connection, 'user@example.com', { accessToken: 'token' });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.authenticationFailed);
            assert.ok(debugLogged); // Should log the parse error
            assert.equal(err.oauthError as any, undefined); // No oauthError since parse failed
        }
    });
    it('Commands: authenticate OAuth error with serverResponseCode', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=OAUTHBEARER', true]]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag({});
                }
                const err: any = new Error('Authentication failed');
                err.response = {
                    tag: 'A1',
                    command: 'NO',
                    attributes: [
                        {
                            type: 'SECTION',
                            section: [{ type: 'ATOM', value: 'AUTHORIZATIONFAILED' }]
                        },
                        { type: 'TEXT', value: 'OAuth token expired' }
                    ]
                };
                throw err;
            },
            write: () => {},
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        try {
            await authenticateCommand(connection, 'user@example.com', { accessToken: 'expired_token' });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.authenticationFailed);
            assert.equal(err.serverResponseCode as any, 'AUTHORIZATIONFAILED');
        }
    });
    it('Commands: authenticate with PLAIN', async () => {
        let execArgs: any = null;
        let writtenData = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=PLAIN', true]]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                execArgs = { cmd, args };
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag({});
                }
                return { next: () => {} };
            },
            write: (data: any) => {
                writtenData = data;
            },
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        const result = await authenticateCommand(connection, 'testuser', { password: 'testpass' });
        assert.equal(result, 'testuser');
        assert.equal(execArgs.cmd, 'AUTHENTICATE');
        assert.equal(execArgs!.args[0].value, 'PLAIN');
        // Verify PLAIN format: \x00username\x00password
        const decoded = (Buffer.from as any)(writtenData, 'base64').toString();
        assert.equal(decoded, '\x00testuser\x00testpass');
        assert.ok(connection.authCapabilities.has('AUTH=PLAIN'));
    });
    it('Commands: authenticate with PLAIN and authzid', async () => {
        let writtenData = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=PLAIN', true]]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag({});
                }
                return { next: () => {} };
            },
            write: (data: any) => {
                writtenData = data;
            },
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        const result = await authenticateCommand(connection, 'admin', {
            password: 'adminpass',
            authzid: 'impersonated_user'
        });
        assert.equal(result, 'impersonated_user'); // Returns authzid when provided
        // Verify PLAIN format with authzid: authzid\x00username\x00password
        const decoded = (Buffer.from as any)(writtenData, 'base64').toString();
        assert.equal(decoded, 'impersonated_user\x00admin\x00adminpass');
    });
    it('Commands: authenticate with PLAIN forced via loginMethod', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([
                ['AUTH=LOGIN', true],
                ['AUTH=PLAIN', true]
            ]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                execArgs = { cmd, args };
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag({});
                }
                return { next: () => {} };
            },
            write: () => {},
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        await authenticateCommand(connection, 'user', { password: 'pass', loginMethod: 'AUTH=PLAIN' });
        assert.equal(execArgs.args[0].value, 'PLAIN');
    });
    it('Commands: authenticate with LOGIN', async () => {
        let execArgs: any = null;
        let writeCount = 0;
        let writtenValues: any = [];
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=LOGIN', true]]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                execArgs = { cmd, args };
                if (opts && opts.onPlusTag) {
                    // Simulate server prompts
                    await opts.onPlusTag({
                        attributes: [{ type: 'TEXT', value: Buffer.from('Username:').toString('base64') }]
                    });
                    await opts.onPlusTag({
                        attributes: [{ type: 'TEXT', value: Buffer.from('Password:').toString('base64') }]
                    });
                }
                return { next: () => {} };
            },
            write: (data: any) => {
                writeCount++;
                writtenValues.push(Buffer.from(data, 'base64').toString());
            },
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        const result = await authenticateCommand(connection, 'loginuser', { password: 'loginpass' });
        assert.equal(result, 'loginuser');
        assert.equal(execArgs.args[0].value, 'LOGIN');
        assert.equal(writeCount, 2);
        assert.equal(writtenValues[0], 'loginuser');
        assert.equal(writtenValues[1], 'loginpass');
        assert.ok(connection.authCapabilities.has('AUTH=LOGIN'));
    });
    it('Commands: authenticate with LOGIN handles user name prompt', async () => {
        let writtenValues: any = [];
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=LOGIN', true]]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    // Some servers use "User Name" instead of "Username"
                    await opts.onPlusTag({
                        attributes: [{ type: 'TEXT', value: Buffer.from('User Name:').toString('base64') }]
                    });
                    await opts.onPlusTag({
                        attributes: [{ type: 'TEXT', value: Buffer.from('Password').toString('base64') }]
                    });
                }
                return { next: () => {} };
            },
            write: (data: any) => {
                writtenValues.push(Buffer.from(data, 'base64').toString());
            },
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        await authenticateCommand(connection, 'testuser', { password: 'testpass' });
        assert.equal(writtenValues[0], 'testuser');
        assert.equal(writtenValues[1], 'testpass');
    });
    it('Commands: authenticate with LOGIN throws on unknown question', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=LOGIN', true]]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag({
                        attributes: [{ type: 'TEXT', value: Buffer.from('Unknown Question:').toString('base64') }]
                    });
                }
                return { next: () => {} };
            },
            write: () => {},
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        try {
            await authenticateCommand(connection, 'user', { password: 'pass' });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('Unknown LOGIN question'));
        }
    });
    it('Commands: authenticate with LOGIN forced via loginMethod', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([
                ['AUTH=PLAIN', true],
                ['AUTH=LOGIN', true]
            ]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                execArgs = { cmd, args };
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag({
                        attributes: [{ type: 'TEXT', value: Buffer.from('Username:').toString('base64') }]
                    });
                    await opts.onPlusTag({
                        attributes: [{ type: 'TEXT', value: Buffer.from('Password:').toString('base64') }]
                    });
                }
                return { next: () => {} };
            },
            write: () => {},
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        await authenticateCommand(connection, 'user', { password: 'pass', loginMethod: 'AUTH=LOGIN' });
        assert.equal(execArgs.args[0].value, 'LOGIN');
    });
    it('Commands: authenticate PLAIN handles error', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=PLAIN', true]]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag({});
                }
                const err: any = new Error('Authentication failed');
                err.response = {
                    tag: 'A1',
                    command: 'NO',
                    attributes: [
                        {
                            type: 'ATOM',
                            value: '',
                            section: [{ type: 'ATOM', value: 'AUTHENTICATIONFAILED' }]
                        }
                    ]
                };
                throw err;
            },
            write: () => {},
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        try {
            await authenticateCommand(connection, 'user', { password: 'wrongpass' });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.authenticationFailed);
            assert.equal(err.serverResponseCode as any, 'AUTHENTICATIONFAILED');
        }
    });
    it('Commands: authenticate LOGIN handles error', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=LOGIN', true]]),
            authCapabilities: new Map(),
            exec: async () => {
                const err: any = new Error('Login failed');
                err.response = {
                    tag: 'A1',
                    command: 'NO',
                    attributes: [
                        {
                            type: 'SECTION',
                            section: [{ type: 'ATOM', value: 'AUTHENTICATIONFAILED' }]
                        },
                        { type: 'TEXT', value: 'Invalid credentials' }
                    ]
                };
                throw err;
            },
            write: () => {},
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        try {
            await authenticateCommand(connection, 'user', { password: 'pass' });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.authenticationFailed);
            assert.equal(err.serverResponseCode as any, 'AUTHENTICATIONFAILED');
        }
    });
    it('Commands: authenticate throws unsupported mechanism', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map() // No auth capabilities
        });

        try {
            await authenticateCommand(connection, 'user', { password: 'pass' });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('Unsupported authentication mechanism'));
        }
    });
    it('Commands: authenticate throws unsupported for accessToken without OAuth capability', async () => {
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([['AUTH=PLAIN', true]]) // No OAuth capability
        });

        try {
            await authenticateCommand(connection, 'user', { accessToken: 'token123' });
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('Unsupported authentication mechanism'));
        }
    });
    it('Commands: authenticate prefers PLAIN over LOGIN by default', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([
                ['AUTH=LOGIN', true],
                ['AUTH=PLAIN', true]
            ]),
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                execArgs = { cmd, args };
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag({});
                }
                return { next: () => {} };
            },
            write: () => {},
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        await authenticateCommand(connection, 'user', { password: 'pass' });
        assert.equal(execArgs.args[0].value, 'PLAIN'); // PLAIN should be preferred
    });
    it('Commands: authenticate prefers OAuth when accessToken provided', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 1,
            capabilities: new Map([
                ['AUTH=PLAIN', true],
                ['AUTH=OAUTHBEARER', true]
            ]),
            servername: 'imap.example.com',
            authCapabilities: new Map(),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            },
            write: () => {},
            log: {
                debug: () => {},
                warn: () => {},
                trace: () => {}
            }
        });

        await authenticateCommand(connection, 'user', { accessToken: 'token', password: 'pass' });
        assert.equal(execArgs.args[0].value, 'OAUTHBEARER'); // OAuth preferred when token provided
    });
});
