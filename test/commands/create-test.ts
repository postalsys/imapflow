import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import createCommand from '../../src/commands/create.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/create', () => {
    // ============================================
    // CREATE Command Tests
    // ============================================
    it('Commands: create success', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        const result = await createCommand(connection, 'NewFolder');
        assert.ok(result);
        assert.equal(result.created, true);
        assert.equal(execArgs.cmd, 'CREATE');
    });
    it('Commands: create skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 });

        const result = await createCommand(connection, 'NewFolder');
        assert.equal(result, undefined);
    });
    it('Commands: create handles ALREADYEXISTS', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Mailbox already exists');
                err.response = {
                    tag: '*',
                    command: 'NO',
                    attributes: [
                        {
                            type: 'SECTION',
                            section: [{ type: 'ATOM', value: 'ALREADYEXISTS' }]
                        },
                        { type: 'TEXT', value: 'Mailbox already exists' }
                    ]
                };
                throw err;
            }
        });

        const result = await createCommand(connection, 'ExistingFolder');
        assert.ok(result);
        assert.equal(result.created, false);
    });
    it('Commands: create throws on other errors', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Create failed');
                err.response = {
                    tag: '*',
                    command: 'NO',
                    attributes: [{ type: 'TEXT', value: 'Create failed' }]
                };
                throw err;
            }
        });

        try {
            await createCommand(connection, 'NewFolder');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.ok(err.message.includes('Create failed'));
        }
    });

    // ============================================
    // CREATE Command Tests
    // ============================================
    it('Commands: create skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

        const result = await createCommand(connection, 'NewFolder');
        assert.equal(result, undefined);
    });
    it('Commands: create mailbox success', async () => {
        let execArgs: any = null;
        let subscribeCalled = false;
        const connection: any = createMockConnection({
            state: 2, // AUTHENTICATED
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return {
                    next: () => {},
                    response: { attributes: [] }
                };
            },
            run: async (cmd: any, path: any) => {
                if (cmd === 'SUBSCRIBE') {
                    subscribeCalled = true;
                    assert.equal(path, 'NewFolder');
                }
            }
        });

        const result = await createCommand(connection, 'NewFolder');
        assert.ok(result);
        assert.equal(result.path, 'NewFolder');
        assert.equal(result.created, true);
        assert.equal(execArgs.cmd, 'CREATE');
        assert.ok(subscribeCalled);
    });
    it('Commands: create works in SELECTED state', async () => {
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            exec: async () => ({
                next: () => {},
                response: { attributes: [] }
            }),
            run: async () => {}
        });

        const result = await createCommand(connection, 'NewFolder');
        assert.ok(result);
        assert.equal(result.created, true);
    });
    it('Commands: create with MAILBOXID response', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [
                        {
                            section: [{ value: 'MAILBOXID' }, [{ value: 'F12345' }]]
                        }
                    ]
                }
            }),
            run: async () => {}
        });

        const result = await createCommand(connection, 'NewFolder');
        assert.ok(result);
        assert.equal(result.mailboxId, 'F12345');
        assert.equal(result.created, true);
    });
    it('Commands: create normalizes path', async () => {
        let capturedArgs = null;
        const connection: any = createMockConnection({
            state: 2,
            namespace: { delimiter: '/', prefix: 'INBOX/' },
            exec: async (cmd: any, args: any) => {
                capturedArgs = args;
                return {
                    next: () => {},
                    response: { attributes: [] }
                };
            },
            run: async () => {}
        });

        await createCommand(connection, 'Subfolder');
        assert.ok(capturedArgs);
    });
    it('Commands: create handles ALREADYEXISTS', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Mailbox already exists');
                err.response = {
                    tag: 'A1',
                    command: 'NO',
                    attributes: [
                        {
                            type: 'ATOM',
                            value: '',
                            section: [{ type: 'ATOM', value: 'ALREADYEXISTS' }]
                        }
                    ]
                };
                throw err;
            },
            run: async () => {},
            log: {
                warn: () => {},
                debug: () => {},
                trace: () => {}
            }
        });

        const result = await createCommand(connection, 'ExistingFolder');
        assert.ok(result);
        assert.equal(result.path, 'ExistingFolder');
        assert.equal(result.created, false);
    });
    it('Commands: create throws on other errors', async () => {
        let warnLogged = false;
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => {
                const err: any = new Error('Permission denied');
                err.response = {
                    tag: 'A1',
                    command: 'NO',
                    attributes: [
                        {
                            type: 'ATOM',
                            value: '',
                            section: [{ type: 'ATOM', value: 'NOPERM' }]
                        }
                    ]
                };
                throw err;
            },
            run: async () => {},
            log: {
                warn: () => {
                    warnLogged = true;
                },
                debug: () => {},
                trace: () => {}
            }
        });

        try {
            await createCommand(connection, 'RestrictedFolder');
            assert.ok(false, 'Should have thrown');
        } catch (err: any) {
            assert.equal(err.serverResponseCode, 'NOPERM');
            assert.ok(warnLogged);
        }
    });
    it('Commands: create handles empty section', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [
                        {
                            section: [] // Empty section
                        }
                    ]
                }
            }),
            run: async () => {}
        });

        const result = await createCommand(connection, 'NewFolder');
        assert.ok(result);
        assert.equal(result.created, true);
        assert.equal(result.mailboxId, undefined);
    });
    it('Commands: create handles invalid MAILBOXID format', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [
                        {
                            section: [
                                { value: 'MAILBOXID' },
                                { value: 'not-an-array' } // Should be array
                            ]
                        }
                    ]
                }
            }),
            run: async () => {}
        });

        const result = await createCommand(connection, 'NewFolder');
        assert.ok(result);
        assert.equal(result.created, true);
        // mailboxId should not be set due to invalid format
        assert.equal(result.mailboxId, undefined);
    });
    it('Commands: create handles null key in section', async () => {
        const connection: any = createMockConnection({
            state: 2,
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [
                        {
                            section: [
                                null, // null key
                                [{ value: 'F12345' }]
                            ]
                        }
                    ]
                }
            }),
            run: async () => {}
        });

        const result = await createCommand(connection, 'NewFolder');
        assert.ok(result);
        assert.equal(result.created, true);
    });
});
