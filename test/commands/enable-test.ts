/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import enableCommand from '../../src/commands/enable.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/enable', () => {
    // ============================================
    // ENABLE Command Tests
    // ============================================
    it('Commands: enable success', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            exec: async () => ({ next: () => {} })
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        // Returns Set of enabled extensions
        assert.ok(result instanceof Set);
    });
    it('Commands: enable skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.equal(result, undefined);
    });
    it('Commands: enable skips when ENABLE not supported', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map() // No ENABLE capability
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.equal(result, undefined);
    });
    it('Commands: enable handles error', async () => {
        const connection: any = createMockConnection({
            state: 2,
            // Need to include CONDSTORE so the filter doesn't skip it
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            exec: async () => {
                throw new Error('Enable failed');
            }
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.equal(result, false);
    });
    it('Commands: enable passes IMAP4rev2 through the capability prefilter', async () => {
        let enableAttrs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['IMAP4rev1', true],
                // Canonical mixed-case key as stored by updateCapabilities
                ['IMAP4rev2', true]
            ]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                enableAttrs = attrs;
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({ attributes: [{ value: 'IMAP4rev2' }] });
                }
                return { next: () => {} };
            }
        });

        const result: any = await enableCommand(connection, ['IMAP4rev2']);
        // The mixed-case capability key must not trip the case-sensitive lookup
        assert.ok(enableAttrs);
        assert.ok(enableAttrs.some((attr: any) => attr.value === 'IMAP4REV2'));
        assert.ok((result as any).has('IMAP4REV2'));
    });
    it('Commands: enable merges into previously enabled extensions', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['IMAP4rev1', true],
                ['IMAP4rev2', true]
            ]),
            enabled: new Set(['CONDSTORE']),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({ attributes: [{ value: 'IMAP4rev2' }] });
                }
                return { next: () => {} };
            }
        });

        await enableCommand(connection, ['IMAP4rev2']);
        // The ENABLED response only lists newly enabled extensions - earlier grants
        // must survive
        assert.ok(connection.enabled.has('CONDSTORE'));
        assert.ok(connection.enabled.has('IMAP4REV2'));
    });
    it('Commands: enable works without the ENABLE token on rev2-only servers', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 2,
            // ENABLE is part of base IMAP4rev2 - rev2-only servers may omit the token
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                execCalled = true;
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({ attributes: [{ value: 'IMAP4rev2' }] });
                }
                return { next: () => {} };
            }
        });

        const result: any = await enableCommand(connection, ['IMAP4rev2']);
        assert.equal(execCalled, true);
        assert.ok((result as any).has('IMAP4REV2'));
    });

    // ============================================
    // ENABLE Command Tests
    // ============================================
    it('Commands: enable skips without ENABLE capability', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map() // No ENABLE capability
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.equal(result, undefined);
    });
    it('Commands: enable skips when not authenticated', async () => {
        const connection: any = createMockConnection({
            state: 3, // SELECTED - not AUTHENTICATED
            capabilities: new Map([['ENABLE', true]])
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.equal(result, undefined);
    });
    it('Commands: enable skips when no supported extensions', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['ENABLE', true]]) // Has ENABLE but not CONDSTORE
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.equal(result, undefined);
    });
    it('Commands: enable single extension', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
                execArgs = { cmd, args };
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: [{ value: 'CONDSTORE' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.ok(result instanceof Set);
        assert.ok(result.has('CONDSTORE'));
        assert.equal(execArgs.cmd, 'ENABLE');
        assert.equal(execArgs!.args[0].value, 'CONDSTORE');
        assert.ok(connection.enabled.has('CONDSTORE'));
    });
    it('Commands: enable multiple extensions', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true],
                ['QRESYNC', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
                execArgs = { cmd, args };
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: [{ value: 'CONDSTORE' }, { value: 'QRESYNC' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await enableCommand(connection, ['CONDSTORE', 'QRESYNC']);
        assert.ok(result instanceof Set);
        assert.ok(result.has('CONDSTORE'));
        assert.ok(result.has('QRESYNC'));
        assert.equal(execArgs.args.length, 2);
    });
    it('Commands: enable filters unsupported extensions', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
                // QRESYNC not supported
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
                execArgs = { cmd, args };
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: [{ value: 'CONDSTORE' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await enableCommand(connection, ['CONDSTORE', 'QRESYNC']);
        assert.ok(result instanceof Set);
        assert.ok(result.has('CONDSTORE'));
        assert.ok(!result.has('QRESYNC'));
        // Only CONDSTORE should be in the request
        assert.equal(execArgs.args.length, 1);
        assert.equal(execArgs!.args[0].value, 'CONDSTORE');
    });
    it('Commands: enable converts to uppercase', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
                execArgs = { cmd, args };
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: [{ value: 'condstore' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await enableCommand(connection, ['condstore']); // lowercase
        assert.ok(result instanceof Set);
        assert.ok(result.has('CONDSTORE')); // Stored as uppercase
        assert.equal(execArgs.args[0].value, 'CONDSTORE'); // Sent as uppercase
    });
    it('Commands: enable handles empty ENABLED response', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: [] // Empty
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.ok(result instanceof Set);
        assert.equal(result.size, 0);
    });
    it('Commands: enable handles null attributes', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: null
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.ok(result instanceof Set);
        assert.equal(result.size, 0);
    });
    it('Commands: enable trims response values', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: [{ value: '  CONDSTORE  ' }] // With whitespace
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await enableCommand(connection, ['CONDSTORE']);
        assert.ok((result as any).has('CONDSTORE'));
    });
    it('Commands: enable handles error', async () => {
        let warnLogged = false;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async () => {
                throw new Error('Enable failed');
            },
            log: {
                warn: () => {
                    warnLogged = true;
                },
                debug: () => {},
                trace: () => {}
            }
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.equal(result, false);
        assert.ok(warnLogged);
    });
    it('Commands: enable skips non-string attribute values', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true]
            ]),
            enabled: new Set(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: [
                            { value: 'CONDSTORE' },
                            { value: null }, // null value
                            { value: 123 }, // number value
                            { notValue: 'test' } // missing value property
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await enableCommand(connection, ['CONDSTORE']);
        assert.ok(result instanceof Set);
        assert.equal(result.size, 1);
        assert.ok(result.has('CONDSTORE'));
    });
    it('Commands: enable updates connection.enabled', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([
                ['ENABLE', true],
                ['CONDSTORE', true],
                ['UTF8=ACCEPT', true]
            ]),
            enabled: new Set(['EXISTING']),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.ENABLED) {
                    await opts.untagged.ENABLED({
                        attributes: [{ value: 'CONDSTORE' }, { value: 'UTF8=ACCEPT' }]
                    });
                }
                return { next: () => {} };
            }
        });

        await enableCommand(connection, ['CONDSTORE', 'UTF8=ACCEPT']);
        // New grants are merged in; earlier grants survive because the untagged
        // ENABLED response only lists extensions enabled by this command (RFC 5161)
        assert.ok(connection.enabled.has('CONDSTORE'));
        assert.ok(connection.enabled.has('UTF8=ACCEPT'));
        assert.ok(connection.enabled.has('EXISTING'));
    });
});
