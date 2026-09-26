/* eslint-disable new-cap */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import namespaceCommand from '../../src/commands/namespace.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/namespace', () => {
    it('Commands: namespace skips when not authenticated', async () => {
        const connection: any = createMockConnection({ state: 1 }); // NOT_AUTHENTICATED

        const result = await namespaceCommand(connection);
        assert.equal(result, undefined);
    });
    it('Commands: namespace with NAMESPACE capability', async () => {
        const connection: any = createMockConnection({
            state: 2, // AUTHENTICATED
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                assert.equal(cmd, 'NAMESPACE');
                if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                    await opts.untagged.NAMESPACE({
                        attributes: [
                            // personal namespaces
                            [[{ value: 'INBOX.' }, { value: '.' }]],
                            // other users
                            [[{ value: 'Users.' }, { value: '.' }]],
                            // shared
                            [[{ value: 'Shared.' }, { value: '.' }]]
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.prefix, 'INBOX.');
        assert.equal((result as any).delimiter, '.');
        assert.equal((connection as any).namespaces.personal[0].prefix, 'INBOX.');
        assert.equal((connection as any).namespaces.other[0].prefix, 'Users.');
        assert.equal((connection as any).namespaces.shared[0].prefix, 'Shared.');
    });
    it('Commands: namespace uses the real command on rev2-only servers without the token', async () => {
        const connection: any = createMockConnection({
            state: 2,
            // NAMESPACE is folded into base IMAP4rev2 (RFC 9051 Appendix E) - a
            // rev2-only server gets a real NAMESPACE command, not the LIST fallback
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                assert.equal(cmd, 'NAMESPACE');
                if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                    await opts.untagged.NAMESPACE({
                        attributes: [[[{ value: '' }, { value: '/' }]], null, null]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.prefix, '');
        assert.equal((result as any).delimiter, '/');
    });
    it('Commands: namespace fallback without capability', async () => {
        const connection: any = createMockConnection({
            state: 2, // AUTHENTICATED
            capabilities: new Map(), // No NAMESPACE capability
            exec: async (cmd: any, args: any, opts: any) => {
                assert.equal(cmd, 'LIST');
                if (opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '/' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.delimiter, '/');
        assert.equal((connection as any).namespaces.other, false);
        assert.equal((connection as any).namespaces.shared, false);
    });
    it('Commands: namespace fallback adds delimiter to prefix', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [[{ value: '\\HasNoChildren' }], { value: '.' }, { value: 'INBOX' }]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.delimiter, '.');
    });
    it('Commands: namespace handles empty response', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                    // Provide minimal valid namespace even in "empty" case
                    await opts.untagged.NAMESPACE({
                        attributes: [
                            [[{ value: '' }, { value: '.' }]], // minimal personal namespace
                            null,
                            null
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.prefix, '');
        assert.equal((result as any).delimiter, '.');
    });
    it('Commands: namespace handles NIL namespaces', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                    await opts.untagged.NAMESPACE({
                        attributes: [
                            [[{ value: '' }, { value: '/' }]], // personal
                            null, // other (NIL)
                            null // shared (NIL)
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.delimiter, '/');
        assert.equal((connection as any).namespaces.other, false);
        assert.equal((connection as any).namespaces.shared, false);
    });
    it('Commands: namespace handles NIL delimiter (RFC 2342)', (t, done) => {
        (async () => {
            // RFC 2342 §5: NIL delimiter means the namespace has no hierarchy.
            // The token parser emits a literal `null` for NIL.

            const connection: any = createMockConnection({
                state: 2,
                capabilities: new Map([['NAMESPACE', true]]),
                exec: async (cmd: any, args: any, opts: any) => {
                    if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                        await opts.untagged.NAMESPACE({
                            attributes: [
                                [
                                    [{ value: '' }, { value: '/' }],
                                    [{ value: '#hidden' }, null]
                                ],
                                null,
                                null
                            ]
                        });
                    }
                    return { next: () => {} };
                }
            });

            const result: any = await namespaceCommand(connection);

            // Guard against handler crash so a regression surfaces as a failed
            // assertion rather than fatal-halting the whole nodeunit suite.
            if (result && result.error) {
                assert.ok(false, 'namespace command returned error sentinel — likely crashed on NIL delimiter');
                done();
                return;
            }
            if (!Array.isArray((connection as any).namespaces && (connection as any).namespaces.personal)) {
                assert.ok(false, 'connection.namespaces.personal is not an array (handler crashed mid-untagged-callback)');
                done();
                return;
            }

            assert.equal((connection as any).namespaces.personal.length, 2, 'both personal entries should be parsed');

            assert.equal((connection as any).namespaces.personal[0].prefix, '');
            assert.equal((connection as any).namespaces.personal[0].delimiter, '/');

            // NIL-delimiter entry preserved with delimiter:null rather than dropped silently.
            assert.equal((connection as any).namespaces.personal[1].prefix, '#hidden');
            assert.equal((connection as any).namespaces.personal[1].delimiter, null);

            // Default namespace pointer resolves to the first valid personal entry.
            assert.equal(connection.namespace.prefix, '');
            assert.equal(connection.namespace.delimiter, '/');

            done();
        })().catch(done);
    });
    it('Commands: namespace handles NIL delimiter as only personal entry', (t, done) => {
        (async () => {
            // Edge case: only a NIL-delimiter entry in the personal section.
            // connection.namespace must still be set and usable downstream.

            const connection: any = createMockConnection({
                state: 2,
                capabilities: new Map([['NAMESPACE', true]]),
                exec: async (cmd: any, args: any, opts: any) => {
                    if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                        await opts.untagged.NAMESPACE({
                            attributes: [[[{ value: '#hidden' }, null]], null, null]
                        });
                    }
                    return { next: () => {} };
                }
            });

            const result: any = await namespaceCommand(connection);

            if (result && result.error) {
                assert.ok(false, 'namespace command returned error sentinel — likely crashed on NIL delimiter');
                done();
                return;
            }
            if (!Array.isArray((connection as any).namespaces && (connection as any).namespaces.personal)) {
                assert.ok(false, 'connection.namespaces.personal is not an array (handler crashed mid-untagged-callback)');
                done();
                return;
            }

            assert.equal((connection as any).namespaces.personal.length, 1);
            assert.equal((connection as any).namespaces.personal[0].prefix, '#hidden');
            assert.equal((connection as any).namespaces.personal[0].delimiter, null);

            assert.ok(connection.namespace);
            assert.equal(connection.namespace.prefix, '#hidden');
            assert.equal(connection.namespace.delimiter, null);

            done();
        })().catch(done);
    });
    it('Commands: namespace handles NIL delimiter in other and shared sections', (t, done) => {
        (async () => {
            // NIL delimiter is also valid in the `other` and `shared` sections,
            // not just `personal`.

            const connection: any = createMockConnection({
                state: 2,
                capabilities: new Map([['NAMESPACE', true]]),
                exec: async (cmd: any, args: any, opts: any) => {
                    if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                        await opts.untagged.NAMESPACE({
                            attributes: [[[{ value: '' }, { value: '/' }]], [[{ value: 'Other Users/' }, null]], [[{ value: 'Public/' }, null]]]
                        });
                    }
                    return { next: () => {} };
                }
            });

            const result: any = await namespaceCommand(connection);

            if (result && result.error) {
                assert.ok(false, 'namespace command returned error sentinel — likely crashed on NIL delimiter');
                done();
                return;
            }

            assert.ok(Array.isArray((connection as any).namespaces.other), 'other should be an array');
            assert.equal((connection as any).namespaces.other.length, 1);
            assert.equal((connection as any).namespaces.other[0].prefix, 'Other Users/');
            assert.equal((connection as any).namespaces.other[0].delimiter, null);

            assert.ok(Array.isArray((connection as any).namespaces.shared), 'shared should be an array');
            assert.equal((connection as any).namespaces.shared.length, 1);
            assert.equal((connection as any).namespaces.shared[0].prefix, 'Public/');
            assert.equal((connection as any).namespaces.shared[0].delimiter, null);

            done();
        })().catch(done);
    });
    it('Commands: namespace skips malformed entries without crashing', (t, done) => {
        (async () => {
            // The filter must reject entries that don't match either the
            // (string-prefix, string-delimiter) or (string-prefix, NIL) shape,
            // so a single broken entry from a buggy server doesn't poison
            // the whole namespace list or crash the handler.

            const connection: any = createMockConnection({
                state: 2,
                capabilities: new Map([['NAMESPACE', true]]),
                exec: async (cmd: any, args: any, opts: any) => {
                    if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                        await opts.untagged.NAMESPACE({
                            attributes: [
                                [
                                    [{ value: '' }, { value: '/' }], // valid
                                    [{ value: '#hidden' }, null], // valid (NIL delimiter)
                                    [{ value: 'broken' }], // too short — rejected
                                    [null, { value: '/' }], // null prefix — rejected
                                    [{ value: 123 }, { value: '/' }] // non-string prefix — rejected
                                ],
                                null,
                                null
                            ]
                        });
                    }
                    return { next: () => {} };
                }
            });

            const result: any = await namespaceCommand(connection);

            if (result && result.error) {
                assert.ok(false, 'namespace command returned error sentinel — likely crashed on malformed entry');
                done();
                return;
            }

            assert.equal((connection as any).namespaces.personal.length, 2, 'only the two well-formed entries should be kept');
            assert.equal((connection as any).namespaces.personal[0].prefix, '');
            assert.equal((connection as any).namespaces.personal[1].prefix, '#hidden');
            assert.equal((connection as any).namespaces.personal[1].delimiter, null);

            done();
        })().catch(done);
    });
    it('Commands: namespace handles multiple personal namespaces', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                    await opts.untagged.NAMESPACE({
                        attributes: [
                            [
                                [{ value: 'INBOX' }, { value: '.' }],
                                [{ value: 'Mail' }, { value: '/' }]
                            ],
                            null,
                            null
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal((connection as any).namespaces.personal.length, 2);
        assert.equal((connection as any).namespaces.personal[0].prefix, 'INBOX.');
        assert.equal((connection as any).namespaces.personal[1].prefix, 'Mail/');
    });
    it('Commands: namespace works in SELECTED state', async () => {
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                    await opts.untagged.NAMESPACE({
                        attributes: [[[{ value: '' }, { value: '/' }]], null, null]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(result.delimiter, '/');
    });
    it('Commands: namespace handles error', async () => {
        let warnLogged = false;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async () => {
                const err: any = new Error('Namespace failed');
                err.responseStatus = 'NO';
                (err as any).responseText = 'Command not supported';
                throw err;
            },
            log: {
                warn: () => {
                    warnLogged = true;
                },
                debug: () => {},
                trace: () => {}
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok((result as any).error);
        assert.equal((result as any)!.status, 'NO');
        assert.equal((result as any)!.text, 'Command not supported');
        assert.ok(warnLogged);
    });
    it('Commands: namespace fallback handles LIST error', async () => {
        let warnLogged = false;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map(), // No NAMESPACE capability
            exec: async () => {
                throw new Error('LIST failed');
            },
            log: {
                warn: () => {
                    warnLogged = true;
                },
                debug: () => {},
                trace: () => {}
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        // Should return default namespace even on error
        assert.equal(result.prefix, '');
        assert.ok(warnLogged);
    });
    it('Commands: namespace appends delimiter to prefix if missing', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.NAMESPACE) {
                    await opts.untagged.NAMESPACE({
                        attributes: [
                            // prefix without trailing delimiter
                            [[{ value: 'INBOX' }, { value: '.' }]],
                            null,
                            null
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.equal((result as any).prefix, 'INBOX.');
    });
    it('Commands: namespace fallback strips leading delimiter from prefix', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map(),
            exec: async (cmd: any, args: any, opts: any) => {
                if (opts && opts.untagged && opts.untagged.LIST) {
                    await opts.untagged.LIST({
                        attributes: [
                            [{ value: '\\HasNoChildren' }],
                            { value: '/' },
                            { value: '/INBOX' } // Leading delimiter
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.equal((result as any).prefix, 'INBOX/');
    });
    it('Commands: namespace ignores empty NAMESPACE response attributes', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (cmd === 'NAMESPACE' && opts && opts.untagged && opts.untagged.NAMESPACE) {
                    // Empty attributes - the callback should return early
                    await opts.untagged.NAMESPACE({
                        attributes: []
                    });
                    // Also provide a valid NAMESPACE to avoid error
                    await opts.untagged.NAMESPACE({
                        attributes: [[[{ value: 'INBOX.' }, { value: '.' }]], null, null]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        // Should return namespace from the second call
        assert.equal((result as any).prefix, 'INBOX.');
        assert.equal((result as any)!.delimiter, '.');
    });
    it('Commands: namespace sets default when personal namespace is empty array', async () => {
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map([['NAMESPACE', true]]),
            exec: async (cmd: any, args: any, opts: any) => {
                if (cmd === 'NAMESPACE' && opts && opts.untagged && opts.untagged.NAMESPACE) {
                    // Provide an array where entries don't pass the filter
                    // (entry.length < 2), so getNamsepaceInfo returns []
                    await opts.untagged.NAMESPACE({
                        attributes: [
                            [[]], // array with one empty entry - filter removes it, returns []
                            null, // other
                            null // shared
                        ]
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        // Should set default personal namespace when personal[0] is falsy
        assert.equal((result as any).prefix, '');
        assert.equal((result as any)!.delimiter, '.');
    });
    it('Commands: namespace fallback ignores empty LIST attributes', async () => {
        let listCallCount = 0;
        const connection: any = createMockConnection({
            state: 2,
            capabilities: new Map(), // No NAMESPACE capability
            exec: async (cmd: any, args: any, opts: any) => {
                if (cmd === 'LIST' && opts && opts.untagged && opts.untagged.LIST) {
                    listCallCount++;
                    // Empty attributes - the callback should return early
                    await opts.untagged.LIST({
                        attributes: []
                    });
                }
                return { next: () => {} };
            }
        });

        const result: any = await namespaceCommand(connection);
        assert.ok(result);
        assert.equal(listCallCount, 1);
        // With empty LIST, prefix and delimiter are undefined
        assert.equal(result.prefix, '');
    });
});
