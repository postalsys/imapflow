import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import expungeCommand from '../../src/commands/expunge.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/expunge', () => {
    it('Commands: expunge success', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            exec: async (cmd: any) => {
                assert.equal(cmd, 'EXPUNGE');
                execCalled = true;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: expunge with UID range', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['UIDPLUS', true]]),
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await expungeCommand(connection, '1:100', { uid: true });
        assert.equal(execCmd, 'UID EXPUNGE');
    });
    it('Commands: expunge uses UID EXPUNGE via folded rev2 capability', async () => {
        let execCmd = null;
        const connection: any = createMockConnection({
            state: 3,
            // No UIDPLUS token - RFC 9051 folds UIDPLUS into base IMAP4rev2. Falling
            // back to plain EXPUNGE here would purge every \Deleted message instead
            // of only the requested range.
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any) => {
                execCmd = cmd;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await expungeCommand(connection, '1:100', { uid: true });
        assert.equal(execCmd, 'UID EXPUNGE');
    });
    it('Commands: expunge skips when not selected', async () => {
        const connection: any = createMockConnection({ state: 2 });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, undefined);
    });
    it('Commands: expunge skips when no range', async () => {
        const connection: any = createMockConnection({ state: 3 });

        const result = await expungeCommand(connection, null as any, {});
        assert.equal(result, undefined);
    });
    it('Commands: expunge handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                const err: any = new Error('Expunge failed');
                err.response = { attributes: [] };
                throw err;
            }
        });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, false);
    });
    it('Commands: expunge parses HIGHESTMODSEQ response', async () => {
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { highestModseq: 100n },
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [
                        {
                            type: 'ATOM',
                            section: [
                                { type: 'ATOM', value: 'HIGHESTMODSEQ' },
                                { type: 'ATOM', value: '9122' }
                            ]
                        }
                    ]
                }
            })
        });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, true);
        assert.equal(connection.mailbox.highestModseq, 9122n);
    });
    it('Commands: expunge does not update lower HIGHESTMODSEQ', async () => {
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { highestModseq: 10000n },
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [
                        {
                            type: 'ATOM',
                            section: [
                                { type: 'ATOM', value: 'HIGHESTMODSEQ' },
                                { type: 'ATOM', value: '5000' }
                            ]
                        }
                    ]
                }
            })
        });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, true);
        assert.equal(connection.mailbox.highestModseq, 10000n); // Should not be updated
    });
    it('Commands: expunge handles invalid HIGHESTMODSEQ value', async () => {
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { highestModseq: 100n },
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [
                        {
                            type: 'ATOM',
                            section: [
                                { type: 'ATOM', value: 'HIGHESTMODSEQ' },
                                { type: 'ATOM', value: 'invalid' }
                            ]
                        }
                    ]
                }
            })
        });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, true);
        assert.equal(connection.mailbox.highestModseq, 100n); // Should not be updated
    });
    it('Commands: expunge updates HIGHESTMODSEQ when mailbox has none', async () => {
        const connection: any = createMockConnection({
            state: 3,
            mailbox: {}, // No highestModseq
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [
                        {
                            type: 'ATOM',
                            section: [
                                { type: 'ATOM', value: 'HIGHESTMODSEQ' },
                                { type: 'ATOM', value: '500' }
                            ]
                        }
                    ]
                }
            })
        });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, true);
        assert.equal(connection.mailbox.highestModseq, 500n);
    });
    it('Commands: expunge error with serverResponseCode', async () => {
        let capturedErr: any = null;
        const connection: any = createMockConnection({
            state: 3,
            exec: async () => {
                const err: any = new Error('Expunge failed');
                err.response = {
                    tag: '*',
                    command: 'NO',
                    attributes: [
                        {
                            type: 'SECTION',
                            section: [{ type: 'ATOM', value: 'CANNOT' }]
                        },
                        { type: 'TEXT', value: 'Cannot expunge' }
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

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, false);
        assert.ok(capturedErr);
        assert.equal(capturedErr.serverResponseCode, 'CANNOT');
    });
    it('Commands: expunge without UID when UIDPLUS not available', async () => {
        let execCmd = null;
        let execAttrs = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(), // No UIDPLUS
            exec: async (cmd: any, attrs: any) => {
                execCmd = cmd;
                execAttrs = attrs;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await expungeCommand(connection, '1:100', { uid: true });
        assert.equal(execCmd, 'EXPUNGE'); // Falls back to EXPUNGE
        assert.equal(execAttrs, false); // No attributes for regular EXPUNGE
    });
    it('Commands: expunge with UID EXPUNGE includes range', async () => {
        let execAttrs: any = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['UIDPLUS', true]]),
            exec: async (cmd: any, attrs: any) => {
                execAttrs = attrs;
                return { next: () => {}, response: { attributes: [] } };
            }
        });

        await expungeCommand(connection, '1:50', { uid: true });
        assert.ok(execAttrs);
        assert.equal(execAttrs[0].type, 'SEQUENCE');
        assert.equal((execAttrs[0] as any).value, '1:50');
    });
    it('Commands: expunge with non-HIGHESTMODSEQ response code', async () => {
        const connection: any = createMockConnection({
            state: 3,
            mailbox: { highestModseq: 100n },
            exec: async () => ({
                next: () => {},
                response: {
                    attributes: [
                        {
                            type: 'ATOM',
                            section: [{ type: 'ATOM', value: 'OTHERCODE' }]
                        }
                    ]
                }
            })
        });

        const result = await expungeCommand(connection, '1:*', {});
        assert.equal(result, true);
        assert.equal(connection.mailbox.highestModseq, 100n); // Should not be updated
    });
});
