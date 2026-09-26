import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import storeCommand from '../../src/commands/store.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/store', () => {
    it('Commands: store add flags', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        const result = await storeCommand(connection, '1:10', ['\\Seen'], { operation: 'add' });
        assert.equal(result, true);
        assert.equal(execArgs.cmd, 'STORE');
        assert.ok(execArgs!.attrs[1].value.startsWith('+'));
    });
    it('Commands: store drops the Recent flag from the wire', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        // \Recent is owned by the server (and removed entirely in IMAP4rev2) - a
        // client-side STORE must never try to set it
        const result = await storeCommand(connection, '1:10', ['\\Seen', '\\Recent'], { operation: 'add' });
        assert.equal(result, true);
        const attrsStr = JSON.stringify(execArgs.attrs);
        assert.ok(attrsStr.includes('\\\\Seen'));
        assert.ok(!attrsStr.toLowerCase().includes('recent'));
    });
    it('Commands: store remove flags', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        const result = await storeCommand(connection, '1:10', ['\\Seen'], { operation: 'remove' });
        assert.equal(result, true);
        assert.ok(execArgs.attrs[1].value.startsWith('-'));
    });
    it('Commands: store remove keeps a flag not in permanentFlags', async () => {
        // Mailbox permits only \Seen (no \*), so \Custom is not a permanent flag. Removal must still be
        // sent: a flag does not need to be permitted to be removed. Regression guard — the check used
        // to test the rewritten wire-form operation instead of options.operation and dropped the flag.
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { permanentFlags: new Set(['\\Seen']) },
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        const result = await storeCommand(connection, '1:10', ['\\Custom'], { operation: 'remove' });
        assert.equal(result, true);
        assert.ok(execArgs, 'a STORE command should be issued');
        assert.equal(execArgs.attrs[1].value, '-FLAGS');
        assert.deepEqual(
            (execArgs as any).attrs[2].map((flag: any) => flag.value),
            ['\\Custom'],
            'the removed flag must be present in the command'
        );
    });
    it('Commands: store add drops a flag not in permanentFlags', async () => {
        // Control for the regression above: the permanentFlags guard must still apply to non-remove
        // operations. Adding a flag the mailbox does not permit yields no command and a false result.
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { permanentFlags: new Set(['\\Seen']) },
            exec: async () => {
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await storeCommand(connection, '1:10', ['\\Custom'], { operation: 'add' });
        assert.equal(result, false, 'adding a non-permitted flag should fail');
        assert.equal(execCalled, false, 'no STORE command should be issued');
    });
    it('Commands: store set flags', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        const result = await storeCommand(connection, '1:10', ['\\Seen'], { operation: 'set' });
        assert.equal(result, true);
        assert.ok(!execArgs.attrs[1].value.startsWith('+'));
        assert.ok(!execArgs!.attrs[1].value.startsWith('-'));
    });
    it('Commands: store with UID', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {} };
            }
        });

        await storeCommand(connection, '100', ['\\Flagged'], { uid: true });
        assert.equal(execCmd, 'UID STORE');
    });
    it('Commands: store with silent', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        await storeCommand(connection, '1', ['\\Seen'], { silent: true });
        assert.ok(execArgs.attrs[1].value.includes('.SILENT'));
    });
    it('Commands: store with Gmail labels', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['X-GM-EXT-1', true]]),
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        await storeCommand(connection, '1', ['Important'], { useLabels: true });
        assert.ok(execArgs.attrs[1].value.includes('X-GM-LABELS'));
    });
    it('Commands: store skips when labels not supported', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map() // No X-GM-EXT-1
        });

        const result = await storeCommand(connection, '1', ['Label'], { useLabels: true });
        assert.equal(result, false);
    });
    it('Commands: store skips when not selected', async () => {
        const connection: any = createMockConnection({ state: 2 });

        const result = await storeCommand(connection, '1:10', ['\\Seen'], {});
        assert.equal(result, false);
    });
    it('Commands: store skips when no range', async () => {
        const connection: any = createMockConnection({ state: 3 });

        const result = await storeCommand(connection, null as any, ['\\Seen'], {});
        assert.equal(result, false);
    });
    it('Commands: store with CONDSTORE', async () => {
        let execArgs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            enabled: new Set(['CONDSTORE']),
            exec: async (cmd: any, attrs: any) => {
                execArgs = { cmd, attrs };
                return { next: () => {} };
            }
        });

        await storeCommand(connection, '1', ['\\Seen'], { unchangedSince: 12345 });
        assert.ok(execArgs.attrs.some((a: any) => Array.isArray(a) && a.some(x => x.value === 'UNCHANGEDSINCE')));
    });
    it('Commands: store handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                const err: any = new Error('Store failed');
                err.response = { attributes: [] };
                throw err;
            }
        });

        const result = await storeCommand(connection, '1', ['\\Seen'], {});
        assert.equal(result, false);
    });
    it('Commands: store error with serverResponseCode', async () => {
        let capturedErr: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                const err: any = new Error('Store failed');
                err.response = {
                    tag: '*',
                    command: 'NO',
                    attributes: [
                        {
                            type: 'SECTION',
                            section: [{ type: 'ATOM', value: 'CANNOT' }]
                        },
                        { type: 'TEXT', value: 'Cannot modify flags' }
                    ]
                };
                throw err;
            },
            log: {
                warn: (data: any) => {
                    capturedErr = data.err;
                }
            }
        });

        const result = await storeCommand(connection, '1', ['\\Seen'], {});
        assert.equal(result, false);
        assert.ok(capturedErr);
        assert.equal(capturedErr.serverResponseCode, 'CANNOT');
    });
    it('Commands: store filters flags that cannot be used', async () => {
        let execAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: {
                permanentFlags: new Set(['\\Seen']) // Only \\Seen is allowed
            },
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {} };
            }
        });

        // Try to add \\Deleted which is not in permanentFlags
        const result = await storeCommand(connection, '1', ['\\Seen', '\\Deleted'], { operation: 'add' });
        assert.equal(result, true);
        assert.ok(execAttrs);
        // Flags list should only contain \\Seen
        const flagsList: any = execAttrs[2];
        assert.equal(flagsList.length, 1);
        assert.equal((flagsList[0] as any).value, '\\Seen');
    });
    it('Commands: store remove operation uses minus prefix', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {} };
            }
        });

        const result = await storeCommand(connection, '1', ['\\Seen', '\\Deleted'], { operation: 'remove' });
        assert.equal(result, true);
        assert.ok(execAttrs);
        // Remove operation should use -FLAGS prefix
        assert.equal(execAttrs[1].value, '-FLAGS');
        const flagsList: any = execAttrs[2];
        assert.equal(flagsList.length, 2);
    });
    it('Commands: store returns false when no valid flags for add', async () => {
        const connection: any = createMockConnection({
            state: 3,
            mailbox: {
                permanentFlags: new Set() // No flags allowed
            }
        });

        // All flags get filtered out
        const result = await storeCommand(connection, '1', ['\\Seen', '\\Deleted'], { operation: 'add' });
        assert.equal(result, false);
    });
    it('Commands: store allows empty flags for set operation', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            mailbox: {
                permanentFlags: new Set() // No flags allowed, all get filtered
            },
            exec: async () => {
                execCalled = true;
                return { next: () => {} };
            }
        });

        // Set operation with empty flags should still proceed (to clear flags)
        const result = await storeCommand(connection, '1', ['\\Seen'], { operation: 'set' });
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: store returns false with empty flags for remove', async () => {
        const connection: any = createMockConnection({
            state: 3,
            mailbox: {
                permanentFlags: new Set()
            }
        });

        // Remove with no valid flags should return false (nothing to remove)
        const result = await storeCommand(connection, '1', [], { operation: 'remove' });
        assert.equal(result, false);
    });
    it('Commands: store default operation is add', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {} };
            }
        });

        await storeCommand(connection, '1', ['\\Seen'], {}); // No operation specified
        assert.ok(execAttrs);
        assert.equal(execAttrs[1].value, '+FLAGS');
    });
    it('Commands: store with labels uses X-GM-LABELS', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['X-GM-EXT-1', true]]),
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {} };
            }
        });

        await storeCommand(connection, '1', ['Important'], { useLabels: true, operation: 'add' });
        assert.ok(execAttrs);
        assert.equal(execAttrs[1].value, '+X-GM-LABELS');
    });
    it('Commands: store silent does not apply to labels', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['X-GM-EXT-1', true]]),
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {} };
            }
        });

        // When using labels, silent flag should not add .SILENT suffix
        await storeCommand(connection, '1', ['Important'], { useLabels: true, silent: true, operation: 'set' });
        assert.ok(execAttrs);
        assert.equal(execAttrs[1].value, 'X-GM-LABELS'); // Not X-GM-LABELS.SILENT
    });
});
