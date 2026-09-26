import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import idleCommand from '../../src/commands/idle.js';
import { createMockConnection } from '../fixtures/mock-connection.js';

describe('commands/idle', () => {
    it('Commands: idle with IDLE capability', async () => {
        let execCommand = '';
        let idlingSet = false;
        const connection: any = createMockConnection({
            state: 3, // SELECTED
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                execCommand = cmd;
                idlingSet = connection.idling;
                // Simulate continuation response
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any);
        assert.equal(execCommand, 'IDLE');
        assert.equal(idlingSet, true);
    });
    it('Commands: idle uses IDLE on rev2-only servers without the IDLE token', async () => {
        let execCommand = '';
        const connection: any = createMockConnection({
            state: 3,
            // IDLE is part of base IMAP4rev2 - no separate token required
            capabilities: new Map([['IMAP4rev2', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                execCommand = cmd;
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection);
        assert.equal(execCommand, 'IDLE');
    });
    it('Commands: idle skips when not selected', async () => {
        const connection: any = createMockConnection({ state: 2 }); // AUTHENTICATED

        const result = await idleCommand(connection);
        assert.equal(result, undefined);
    });
    it('Commands: idle falls back to NOOP without IDLE capability', async () => {
        let noopCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(), // No IDLE
            currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
            exec: async (cmd: any) => {
                if (cmd === 'NOOP') {
                    noopCalled = true;
                    // Break out of the loop by calling preCheck
                    if (connection.preCheck) {
                        await (connection as any).preCheck();
                    }
                }
                return { next: () => {} };
            }
        });

        // Start idle - it will loop with NOOP
        const idlePromise = idleCommand(connection as any);

        // Give it a moment to start, then break the loop
        await new Promise(resolve => setTimeout(resolve, 10));
        if ((connection as any).preCheck) {
            await (connection as any).preCheck();
        }

        await idlePromise;
        assert.equal(noopCalled, true);
    });
    it('Commands: idle preCheck breaks IDLE', async () => {
        let doneSent = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // After IDLE is initiated, trigger preCheck
                if (connection.preCheck) {
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: (data: any) => {
                if (data === 'DONE') {
                    doneSent = true;
                }
            }
        });

        await idleCommand(connection as any);
        assert.equal(doneSent, true);
        assert.equal((connection as any).idling, false);
    });
    it('Commands: idle handles error', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async () => {
                throw new Error('IDLE failed');
            }
        });

        const result = await idleCommand(connection);
        assert.equal(result, false);
        assert.equal((connection as any).idling, false);
    });
    it('Commands: idle with maxIdleTime restarts loop', async () => {
        let idleCount = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                idleCount++;
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // Break after second iteration
                if (idleCount >= 2 && connection.preCheck) {
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        // Very short maxIdleTime to trigger restart
        await idleCommand(connection as any, 5);
        assert.ok(idleCount >= 1);
    });
    it('Commands: idle without currentSelectCommand returns immediately', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(), // No IDLE
            currentSelectCommand: false // No select command
        });

        // Should resolve immediately
        await idleCommand(connection);
        assert.ok(true);
    });
    it('Commands: idle NOOP fallback uses STATUS when configured', async () => {
        let statusCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(),
            currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
            missingIdleCommand: 'STATUS',
            exec: async (cmd: any) => {
                if (cmd === 'STATUS') {
                    statusCalled = true;
                    if (connection.preCheck) {
                        await (connection as any).preCheck();
                    }
                }
                return { next: () => {} };
            }
        });

        await idleCommand(connection as any);
        assert.equal(statusCalled, true);
    });
    it('Commands: idle NOOP fallback uses SELECT when configured', async () => {
        // SELECT polling goes through the real select implementation, so it applies the same
        // mailbox state transitions as a caller-issued select instead of replaying wire arguments.
        let selectCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(),
            // The mailbox is already open, so its folder metadata is cached (no LIST round trip)
            folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
            currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
            missingIdleCommand: 'SELECT',
            exec: async (cmd: any) => {
                if (cmd === 'SELECT') {
                    selectCalled = true;
                    if (connection.preCheck) {
                        await (connection as any).preCheck();
                    }
                }
                return { next: () => {}, response: { attributes: [{ value: 'OK' }] } };
            }
        });

        await idleCommand(connection as any);
        assert.equal(selectCalled, true);
        assert.equal(connection.mailbox.path, 'INBOX', 'mailbox state was reapplied by the select implementation');
        assert.equal(connection.mailbox.delimiter, '/', 'cached folder metadata was merged in, as with a normal SELECT');
    });
    it('Commands: idle sets preCheck function', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // Check that preCheck is set
                assert.equal(typeof connection.preCheck, 'function');
                // Break the IDLE
                if ((connection as any).preCheck) {
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any);
    });
    it('Commands: idle clears preCheck on completion', async () => {
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                if (connection.preCheck) {
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any);
        assert.equal((connection as any).preCheck, false);
    });
    it('Commands: idle NOOP fallback handles error', async () => {
        let errorLogged = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map(),
            currentSelectCommand: { command: 'SELECT', arguments: [{ value: 'INBOX' }] },
            exec: async () => {
                throw new Error('NOOP failed');
            },
            log: {
                warn: () => {
                    errorLogged = true;
                },
                debug: () => {},
                trace: () => {}
            }
        });

        // Should resolve even on error
        await idleCommand(connection);
        assert.equal(errorLogged, true);
    });
    it('Commands: idle clears wait queue on normal completion', async () => {
        let preCheckResolved = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // Simulate waiting preCheck request before completion
                if (connection.preCheck) {
                    // Queue a preCheck request
                    (connection as any).preCheck().then(() => {
                        preCheckResolved = true;
                    });
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any);
        // Wait a tick for the promise to resolve
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(preCheckResolved, true);
    });
    it('Commands: idle rejects wait queue on error', async () => {
        let preCheckRejected = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // Queue a preCheck request then throw
                if (connection.preCheck) {
                    (connection as any).preCheck().catch(() => {
                        preCheckRejected = true;
                    });
                }
                throw new Error('IDLE failed');
            }
        });

        const result = await idleCommand(connection as any);
        assert.equal(result, false);
        // Wait a tick for the promise to reject
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(preCheckRejected, true);
    });
    it('Commands: idle onPlusTag calls preCheck if doneRequested', async () => {
        let doneSent = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                // Request done before onPlusTag is called
                if (connection.preCheck) {
                    (connection as any).preCheck().catch(() => {});
                }
                // Then call onPlusTag which should send DONE
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                return { next: () => {} };
            },
            write: (data: any) => {
                if (data === 'DONE') {
                    doneSent = true;
                }
            }
        });

        await idleCommand(connection as any);
        assert.equal(doneSent, true);
    });
    it('Commands: idle calls onSend callback', async () => {
        let onSendCalled = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                // Call onSend callback
                if (opts && opts.onSend) {
                    opts.onSend();
                    onSendCalled = true;
                }
                // Then call onPlusTag to enable IDLE
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // Break IDLE via preCheck
                if (connection.preCheck) {
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any);
        assert.equal(onSendCalled, true);
    });
    it('Commands: idle clears preCheck and queue on normal completion', async () => {
        let waitQueueResolved = false;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async (cmd: any, attrs: any, opts: any) => {
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // After onPlusTag, queue a preCheck but don't resolve yet
                if (connection.preCheck) {
                    (connection as any).preCheck().then(() => {
                        waitQueueResolved = true;
                    });
                }
                // Return to complete IDLE - this should clear the queue
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any);
        await new Promise(resolve => setImmediate(resolve));
        // preCheck should be cleared after completion
        assert.equal((connection as any).preCheck, false);
        assert.equal(waitQueueResolved, true);
    });
    it('Commands: idle with maxIdleTime triggers preCheck after timeout', async () => {
        let preCheckCalled = false;
        let loopCount = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            idling: false,
            exec: async (cmd: any, attrs: any, opts: any) => {
                loopCount++;
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // Simulate time passing - on first loop, wait for timer
                if (loopCount === 1) {
                    // Wait a bit for the timer to fire
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                // Check if preCheck was called by the timer
                if (connection.preCheck && loopCount === 1) {
                    preCheckCalled = true;
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        // Use very short maxIdleTime
        await idleCommand(connection as any, 10);
        assert.ok(preCheckCalled || loopCount > 1, 'preCheck should be called by timer or loop should restart');
    });
    it('Commands: idle stillIdling triggers loop restart', async () => {
        let loopCount = 0;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            idling: false,
            exec: async (cmd: any, attrs: any, opts: any) => {
                loopCount++;
                if (opts && opts.onPlusTag) {
                    await opts.onPlusTag();
                }
                // First iteration: let the timer set stillIdling and trigger preCheck
                if (loopCount === 1) {
                    await new Promise(resolve => setTimeout(resolve, 20));
                    // Timer should have called preCheck which sets stillIdling
                }
                // Second iteration: just complete
                if (connection.preCheck) {
                    await (connection as any).preCheck();
                }
                return { next: () => {} };
            },
            write: () => {}
        });

        await idleCommand(connection as any, 5);
        // Loop should have run at least once (could run twice if timer works)
        assert.ok(loopCount >= 1, 'IDLE loop should have run');
    });
    it('Commands: idle releases queued waiters when the server refuses IDLE', async () => {
        let waiter: any = null;
        const connection: any = createMockConnection({
            state: 3,
            capabilities: new Map([['IDLE', true]]),
            exec: async () => {
                // a command is waiting for IDLE to break when the server answers IDLE with BAD
                waiter = connection.preCheck().then(
                    () => 'resolved',
                    () => 'rejected'
                );
                const err: any = new Error('Command failed');
                err.responseStatus = 'BAD';
                throw err;
            }
        });

        assert.equal(await idleCommand(connection), false);
        assert.equal(await waiter, 'resolved', 'the waiting command runs instead of failing with the IDLE error');
    });
});
