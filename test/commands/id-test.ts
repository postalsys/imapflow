/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import idCommand from '../../src/commands/id.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/id', () => {
    it('Commands: id skips when no ID capability', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map() // No ID capability
        });

        const result = await idCommand(connection, { name: 'TestClient' });
        assert.equal(result, undefined);
    });
    it('Commands: id sends client info', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            }
        });

        await idCommand(connection, { name: 'TestClient', version: '1.0' });
        assert.equal(execArgs.cmd, 'ID');
        assert.ok(Array.isArray(execArgs!.args));
        assert.ok(execArgs!.args[0].includes('name'));
        assert.ok(execArgs!.args[0].includes('TestClient'));
    });
    it('Commands: id sends null when no clientInfo', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            }
        });

        await idCommand(connection, null);
        assert.equal(execArgs.cmd, 'ID');
        assert.equal(execArgs!.args[0], null);
    });
    it('Commands: id sends null for empty clientInfo', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            }
        });

        await idCommand(connection, {});
        assert.equal(execArgs.cmd, 'ID');
        assert.equal(execArgs!.args[0], null);
    });
    it('Commands: id parses server response', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ID) {
                    await opts.untagged.ID({
                        attributes: [
                            [{ value: 'name' }, { value: 'TestServer' }, { value: 'version' }, { value: '2.0' }, { value: 'vendor' }, { value: 'ACME' }]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await idCommand(connection, { name: 'TestClient' });
        assert.equal((result as any).name, 'TestServer');
        assert.equal((result as any)!.version, '2.0');
        assert.equal((result as any)!.vendor, 'ACME');
    });
    it('Commands: id updates serverInfo', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            serverInfo: {},
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ID) {
                    await opts.untagged.ID({
                        attributes: [[{ value: 'name' }, { value: 'ImapServer' }, { value: 'support-url' }, { value: 'https://example.com' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        await idCommand(connection, { name: 'TestClient' });
        assert.equal((connection as any).serverInfo.name, 'ImapServer');
        assert.equal((connection as any).serverInfo['support-url'], 'https://example.com');
    });
    it('Commands: id handles non-array server response', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ID) {
                    // Some servers might send NIL or a single value
                    await opts.untagged.ID({
                        attributes: [null]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await idCommand(connection, { name: 'TestClient' });
        assert.ok(result);
        assert.deepEqual(result, {});
    });
    it('Commands: id formats date value', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            }
        });

        const testDate = new Date('2024-06-15T10:30:00Z');
        await idCommand(connection, { date: testDate });

        assert.equal(execArgs.cmd, 'ID');
        // Date should be formatted, not passed as Date object
        assert.ok(execArgs!.args[0].includes('date'));
    });
    it('Commands: id normalizes key names to lowercase', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ID) {
                    await opts.untagged.ID({
                        attributes: [[{ value: 'NAME' }, { value: 'TestServer' }, { value: 'VERSION' }, { value: '1.0' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await idCommand(connection, { name: 'TestClient' });
        assert.equal((result as any).name, 'TestServer');
        assert.equal((result as any)!.version, '1.0');
    });
    it('Commands: id trims key names', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ID) {
                    await opts.untagged.ID({
                        attributes: [[{ value: ' name ' }, { value: 'TestServer' }]]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await idCommand(connection, { name: 'TestClient' });
        assert.equal((result as any).name, 'TestServer');
    });
    it('Commands: id handles error', async () => {
        let warnLogged = false;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async () => {
                throw new Error('ID command failed');
            },
            log: {
                warn: () => {
                    warnLogged = true;
                },
                debug: () => {},
                trace: () => {}
            }
        });

        const result = await idCommand(connection, { name: 'TestClient' });
        assert.equal(result, false);
        assert.ok(warnLogged);
    });
    it('Commands: id filters empty values', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            }
        });

        await idCommand(connection, { name: 'TestClient', empty: '', valid: 'value' });
        assert.equal(execArgs.cmd, 'ID');
        // Empty values should be filtered out
        assert.ok(execArgs!.args[0].includes('name'));
        assert.ok(execArgs!.args[0].includes('valid'));
    });
    it('Commands: id replaces whitespace in values', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            capabilities: new Map([['ID', true]]),
            exec: async (cmd: any, args: any) => {
                execArgs = { cmd, args };
                return { next: () => {} };
            }
        });

        await idCommand(connection, { name: 'Test\nClient\tApp' });
        assert.equal(execArgs.cmd, 'ID');
        // Whitespace should be normalized to single spaces
        const nameIndex = execArgs!.args[0].indexOf('name');
        assert.ok(nameIndex >= 0);
        const nameValue = execArgs!.args[0][nameIndex + 1];
        assert.ok(!nameValue.includes('\n'));
        assert.ok(!nameValue.includes('\t'));
    });
});
