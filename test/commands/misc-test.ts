import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import capabilityCommand from '../../src/commands/capability.js';
import noopCommand from '../../src/commands/noop.js';
import compressCommand from '../../src/commands/compress.js';
import starttlsCommand from '../../src/commands/starttls.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/misc', () => {
    // ============================================
    // CAPABILITY Command Tests
    // ============================================
    it('Commands: capability returns cached when available', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([
                ['IMAP4rev1', true],
                ['IDLE', true]
            ]),
            expectCapabilityUpdate: false
        });

        const result = await capabilityCommand(connection);
        assert.ok(result instanceof Map);
        assert.equal(result.get('IDLE'), true);
    });
    it('Commands: capability fetches when empty', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map(),
            exec: async () => ({ next: () => {} })
        });

        const result = await capabilityCommand(connection);
        assert.ok(result instanceof Map);
    });
    it('Commands: capability fetches when update expected', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            capabilities: new Map([['IMAP4rev1', true]]),
            expectCapabilityUpdate: true,
            exec: async () => {
                execCalled = true;
                return { next: () => {} };
            }
        });

        await capabilityCommand(connection);
        assert.equal(execCalled, true);
    });
    it('Commands: capability handles error', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map(),
            exec: async () => {
                throw new Error('Command failed');
            }
        });

        const result = await capabilityCommand(connection);
        assert.equal(result, false);
    });

    // ============================================
    // NOOP Command Tests
    // ============================================
    it('Commands: noop success', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            exec: async (cmd: any) => {
                assert.equal(cmd, 'NOOP');
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await noopCommand(connection);
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: noop handles error', async () => {
        const connection: any = createMockConnection({
            exec: async () => {
                throw new Error('Command failed');
            }
        });

        const result = await noopCommand(connection);
        assert.equal(result, false);
    });

    // ============================================
    // COMPRESS Command Tests
    // ============================================
    it('Commands: compress success', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            capabilities: new Map([['COMPRESS=DEFLATE', true]]),
            exec: async () => {
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await compressCommand(connection);
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: compress skips when not supported', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map() // No COMPRESS=DEFLATE
        });

        const result = await compressCommand(connection);
        // Returns false when not supported (not undefined)
        assert.equal(result, false);
    });
    it('Commands: compress handles error', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['COMPRESS=DEFLATE', true]]),
            exec: async () => {
                throw new Error('Compress failed');
            }
        });

        const result = await compressCommand(connection);
        assert.equal(result, false);
    });
    it('Commands: compress fails the connection on trailing data', async () => {
        // Per RFC 4978 the server switches to DEFLATE at its tagged OK, so data already
        // buffered behind the OK was consumed as cleartext and the deflate stream is
        // truncated. Declining the upgrade is not a protocol option at that point - the
        // session is unrecoverable in both directions and must fail closed.
        let closeAfterCalled = false;
        let nextCalled = false;
        const connection: any = createMockConnection({
            capabilities: new Map([['COMPRESS=DEFLATE', true]]),
            closeAfter: () => {
                closeAfterCalled = true;
            },
            exec: async () => ({
                hasTrailingData: true,
                next: () => {
                    nextCalled = true;
                    assert.ok(closeAfterCalled, 'teardown must be scheduled before parser backpressure is released');
                }
            })
        });

        let err: any = null;
        try {
            await compressCommand(connection);
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'compress must throw');
        assert.equal(err && err.code, 'COMPRESS_TRAILING_DATA');
        assert.ok(closeAfterCalled, 'the connection must be closed');
        assert.ok(nextCalled, 'parser backpressure must still be released');
    });

    // ============================================
    // STARTTLS Command Tests
    // ============================================
    it('Commands: starttls success', async () => {
        let execCalled = false;
        const connection: any = createMockConnection({
            capabilities: new Map([['STARTTLS', true]]),
            exec: async () => {
                execCalled = true;
                return { next: () => {} };
            }
        });

        const result = await starttlsCommand(connection);
        assert.equal(result, true);
        assert.equal(execCalled, true);
    });
    it('Commands: starttls skips when not supported', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map() // No STARTTLS
        });

        const result = await starttlsCommand(connection);
        // Returns false when not supported (not undefined)
        assert.equal(result, false);
    });
    it('Commands: starttls handles error', async () => {
        const connection: any = createMockConnection({
            capabilities: new Map([['STARTTLS', true]]),
            exec: async () => {
                throw new Error('STARTTLS failed');
            }
        });

        const result = await starttlsCommand(connection);
        assert.equal(result, false);
    });
});
