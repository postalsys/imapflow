import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import idleCommand from '../src/commands/idle.js';
import imapCommands from '../src/imap-commands.js';
import { withFakeTimers } from './fixtures/fake-timers.js';

// Fallback polling lifecycle (servers without IDLE): one explicitly identified polling session
// that cannot run or reschedule after cancellation, reuses the real STATUS/SELECT state
// handling, and always leaves `idling` describing reality.

const createConnection = (overrides = {}) => {
    const states: any = { NOT_AUTHENTICATED: 1, AUTHENTICATED: 2, SELECTED: 3, LOGOUT: 4 };

    const connection: any[] = {
        states,
        state: states.SELECTED,
        id: 'polling-test',
        capabilities: new Map((overrides as any).capabilities || []), // no IDLE -> polling fallback
        enabled: new Set((overrides as any).enabled || []),
        folders: new Map([['INBOX', { path: 'INBOX', delimiter: '/' }]]),
        mailbox: {
            path: 'INBOX',
            exists: 3,
            uidNext: 10,
            uidValidity: BigInt(1),
            highestModseq: BigInt(1)
        },
        namespace: { delimiter: '/', prefix: '' },
        socket: { destroyed: false },
        currentSelectCommand: { command: 'SELECT', arguments: [{ type: 'ATOM', value: 'INBOX' }] },
        missingIdleCommand: 'NOOP',
        idling: false,
        preCheck: false,
        events: [],
        commands: [],
        log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
        emit(event: any, payload: any) {
            (connection as any).events.push({ event, payload });
        },
        run: async () => false,
        // Fallback polling dispatches through runInternal(), which ImapFlow resolves against the
        // command registry - so a poll runs the real SELECT/STATUS implementation.
        runInternal: async (command: any, ...args: any[]) => {
            let handler = imapCommands.get(command.toUpperCase());
            return handler ? await handler(connection as any, ...args) : false;
        },
        exec: async (command: any, attributes: any, options: any) => {
            (connection as any).commands.push(command);
            return ((connection as any).respond as any)(command, attributes, options);
        },
        respond: async () => ({ next: () => {}, response: { attributes: [{ value: 'OK' }] } })
    } as any;

    // capabilities/enabled are already converted into a Map/Set above
    let rest: any = Object.assign({}, overrides);
    delete rest.capabilities;
    delete (rest as any).enabled;

    return Object.assign(connection, rest);
};

describe('idle-polling', () => {
    it('Polling: break before the first poll stops the loop', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let connection: any[] = createConnection({
                    exec: async (command: any) => {
                        (connection as any).commands.push(command);
                        // break while the very first poll is still in flight
                        await ((connection as any).preCheck as any)();
                        return { next: () => {} };
                    }
                });

                let idlePromise = idleCommand(connection as any, 60000);
                await timers.drain();
                await idlePromise;

                assert.deepEqual((connection as any).commands, ['NOOP'], 'only the immediate first poll ran');
                assert.equal((connection as any).idling, false, 'idling reset after the break');
                assert.equal((connection as any).preCheck, false, 'the session released preCheck');
                assert.equal(timers.count(), 0, 'no polling timer is left armed');

                // Advancing several intervals must not produce another command
                await timers.fire();
                await timers.fire();
                assert.deepEqual((connection as any).commands, ['NOOP'], 'a cancelled session never polls again');
                done();
            });
        })().catch(done);
    });
    it('Polling: break during an in-flight poll cannot reschedule', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let releasePoll: any;
                let pollStarted: any;
                let connection: any[] = createConnection({
                    exec: async (command: any) => {
                        (connection as any).commands.push(command);
                        await new Promise(resolve => {
                            releasePoll = resolve;
                            if (pollStarted) {
                                pollStarted();
                            }
                        });
                        return { next: () => {} };
                    }
                });

                let started = new Promise(resolve => (pollStarted = resolve));
                let idlePromise = idleCommand(connection as any, 60000);
                await started;

                // Cancel while the poll is still awaiting its response, then let it finish
                await ((connection as any).preCheck as any)();
                releasePoll();
                await idlePromise;

                assert.deepEqual((connection as any).commands, ['NOOP'], 'the in-flight poll completed but scheduled nothing');
                assert.equal(timers.count(), 0, 'the completing poll did not arm a new timer');
                assert.equal((connection as any).idling, false, 'idling reset');

                await timers.fire();
                assert.deepEqual((connection as any).commands, ['NOOP'], 'no later command is sent');
                done();
            });
        })().catch(done);
    });
    it('Polling: break after a poll but before the next timer fires stops the loop', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let connection: any = createConnection();

                let idlePromise = idleCommand(connection, 60000);
                await timers.drain();

                assert.deepEqual(connection.commands, ['NOOP'], 'the immediate first poll ran');
                assert.equal(timers.count(), 1, 'the next poll is scheduled');
                assert.ok(timers.pending()[0].unrefd, 'the background polling timer does not keep the process alive');

                await (connection.preCheck as any)();
                await idlePromise;

                assert.equal(timers.count(), 0, 'the armed timer was cleared on cancellation');

                await timers.fire();
                await timers.fire();
                assert.deepEqual(connection.commands, ['NOOP'], 'no command after cancellation');
                done();
            });
        })().catch(done);
    });
    it('Polling: an old session does not clear a newer session preCheck', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let releasePoll: any;
                let pollStarted: any;
                let connection: any[] = createConnection({
                    exec: async (command: any) => {
                        (connection as any).commands.push(command);
                        if ((connection as any).commands.length === 1) {
                            await new Promise(resolve => {
                                releasePoll = resolve;
                                pollStarted();
                            });
                        }
                        return { next: () => {} };
                    }
                });

                let started = new Promise(resolve => (pollStarted = resolve));
                let firstSession = idleCommand(connection as any, 60000);
                await started;

                // Cancel the first session while its poll is in flight, then immediately re-enter IDLE
                await ((connection as any).preCheck as any)();
                let secondSession = idleCommand(connection as any, 60000);
                await timers.drain();

                let newPreCheck = (connection as any).preCheck;
                assert.equal(typeof newPreCheck, 'function', 'the new session installed its own preCheck');

                // The stale poll now finishes: it must not touch the new session's ownership
                releasePoll();
                await firstSession;

                assert.equal((connection as any).preCheck, newPreCheck, 'the stale session left the newer preCheck in place');
                assert.equal((connection as any).idling, true, 'the stale session did not clear the newer idling state');

                await ((connection as any).preCheck as any)();
                await secondSession;
                assert.equal((connection as any).idling, false, 'the newer session cleaned up on its own break');
                done();
            });
        })().catch(done);
    });
    it('Polling: STATUS polling applies mailbox state and emits exists only on change', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let messages = 3;
                let connection: any = createConnection({
                    capabilities: [['CONDSTORE', true]],
                    missingIdleCommand: 'STATUS',
                    respond: async (command: any, attributes: any, options: any) => {
                        if (command === 'STATUS') {
                            let statusHandler = options.untagged.STATUS;
                            await statusHandler({
                                attributes: [
                                    { type: 'STRING', value: 'INBOX' },
                                    [
                                        { type: 'ATOM', value: 'MESSAGES' },
                                        { type: 'ATOM', value: String(messages) },
                                        { type: 'ATOM', value: 'UIDNEXT' },
                                        { type: 'ATOM', value: '11' },
                                        { type: 'ATOM', value: 'HIGHESTMODSEQ' },
                                        { type: 'ATOM', value: '42' }
                                    ]
                                ]
                            });
                        }
                        return { next: () => {}, response: { attributes: [{ value: 'OK' }] } };
                    }
                });

                let idlePromise = idleCommand(connection, 60000);
                await timers.drain();

                assert.deepEqual(connection.commands, ['STATUS'], 'STATUS was used for polling');
                assert.equal(connection.mailbox.uidNext, 11, 'uidNext updated from the poll');
                assert.equal(connection.mailbox.highestModseq, BigInt(42), 'highestModseq updated on a CONDSTORE session');
                assert.deepEqual(connection.events, [], 'an unchanged message count emits no event');

                // Second poll reports a new count -> exactly one exists event
                messages = 5;
                await timers.fire();

                assert.equal(connection.mailbox.exists, 5, 'exists updated from the poll');
                assert.equal(connection.events.length, 1, 'one event for the changed count');
                assert.equal((connection.events[0] as any).event, 'exists');
                assert.equal((connection.events[0] as any).payload.count, 5);
                assert.equal((connection.events[0] as any).payload.prevCount, 3);

                await (connection.preCheck as any)();
                await idlePromise;
                done();
            });
        })().catch(done);
    });
    it('Polling: STATUS omits HIGHESTMODSEQ without CONDSTORE', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let requestedItems: any = [];
                let connection: any = createConnection({
                    missingIdleCommand: 'STATUS',
                    respond: async (command: any, attributes: any) => {
                        if (command === 'STATUS') {
                            requestedItems = attributes[1].map((entry: any) => entry.value);
                        }
                        return { next: () => {}, response: { attributes: [{ value: 'OK' }] } };
                    }
                });

                let idlePromise = idleCommand(connection, 60000);
                await timers.drain();

                assert.ok(requestedItems.includes('MESSAGES'), 'MESSAGES is polled');
                assert.ok(requestedItems.includes('UIDNEXT'), 'UIDNEXT is polled');
                assert.ok(!requestedItems.includes('HIGHESTMODSEQ'), 'HIGHESTMODSEQ is not requested without CONDSTORE');

                await (connection.preCheck as any)();
                await idlePromise;
                done();
            });
        })().catch(done);
    });
    it('Polling: failed SELECT polling deselects and stops the loop', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let connection: any = createConnection({
                    missingIdleCommand: 'SELECT',
                    respond: async (command: any) => {
                        if (command === 'SELECT') {
                            let err: any = new Error('Command failed');
                            err.responseStatus = 'NO';
                            throw err;
                        }
                        return { next: () => {}, response: { attributes: [{ value: 'OK' }] } };
                    }
                });

                let idlePromise = idleCommand(connection, 60000);
                await timers.drain();
                await idlePromise;

                assert.equal(connection.state, connection.states.AUTHENTICATED, 'a failed reselect drops to AUTHENTICATED');
                assert.equal(connection.mailbox, false, 'mailbox state cleared');
                assert.equal(connection.currentSelectCommand, false, 'the saved select command is cleared');
                assert.equal(connection.idling, false, 'idling reset');
                assert.equal(connection.preCheck, false, 'preCheck released');
                assert.equal(timers.count(), 0, 'polling stopped');
                assert.ok(
                    connection.events.some((entry: any) => (entry as any).event === 'mailboxClose'),
                    'the mailbox close transition was emitted, as with a caller-issued SELECT'
                );
                done();
            });
        })().catch(done);
    });
    it('Polling: a closed connection stops the loop instead of polling', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let connection: any = createConnection();

                let idlePromise = idleCommand(connection, 60000);
                await timers.drain();
                assert.deepEqual(connection.commands, ['NOOP'], 'first poll ran on a live connection');

                // Transport dies between polls
                connection.socket.destroyed = true;
                await timers.fire();
                await idlePromise;

                assert.deepEqual(connection.commands, ['NOOP'], 'no command is sent on a dead transport');
                assert.equal(connection.idling, false, 'idling reset when the loop stops');
                assert.equal(connection.preCheck, false, 'preCheck released');
                done();
            });
        })().catch(done);
    });
    it('Polling: a rejected poll resets idling', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let connection: any[] = createConnection({
                    exec: async (command: any) => {
                        (connection as any).commands.push(command);
                        let err: any = new Error('Connection not available');
                        err.code = 'NoConnection';
                        throw err;
                    }
                });

                let idlePromise = idleCommand(connection as any, 60000);
                await timers.drain();
                await idlePromise;

                assert.equal((connection as any).idling, false, 'idling reset after a rejected poll');
                assert.equal((connection as any).preCheck, false, 'preCheck released after a rejected poll');
                assert.equal(timers.count(), 0, 'nothing left scheduled');
                done();
            });
        })().catch(done);
    });
    it('Polling: no polling session without a saved select command', async () => {
        let connection: any = createConnection({ currentSelectCommand: false });
        await idleCommand(connection, 60000);
        assert.deepEqual(connection.commands, [], 'nothing polled');
        assert.equal(connection.idling, false, 'idling untouched');
    });
    it('Polling: a falsy STATUS result stops the loop as PollFailed', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let warnings: any = [];
                let connection: any = createConnection({
                    missingIdleCommand: 'STATUS',
                    // Only STATUS is ever polled; a failure without a NO status makes the
                    // real STATUS implementation swallow the error and return false
                    respond: async () => {
                        throw new Error('Command failed');
                    }
                });
                connection.log.warn = (entry: any) => warnings.push(entry);

                let idlePromise = idleCommand(connection, 60000);
                await timers.drain();
                await idlePromise;

                assert.ok(
                    warnings.some((entry: any) => entry && entry.err && entry.err.code === 'PollFailed'),
                    'the falsy STATUS result surfaced as a PollFailed error'
                );
                assert.equal(connection.idling, false, 'idling reset after the failed poll');
                assert.equal(connection.preCheck, false, 'preCheck released');
                assert.equal(timers.count(), 0, 'polling stopped');
                done();
            });
        })().catch(done);
    });
    it('Polling: a repeated break call is a no-op', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let connection: any = createConnection();

                let idlePromise = idleCommand(connection, 60000);
                await timers.drain();
                assert.deepEqual(connection.commands, ['NOOP'], 'the immediate first poll ran');

                // A caller may hold on to the break function and invoke it more than once
                let preCheck = connection.preCheck;
                await (preCheck as any)();
                await (preCheck as any)();
                await idlePromise;

                assert.equal(connection.idling, false, 'idling reset');
                assert.equal(connection.preCheck, false, 'preCheck released');
                assert.equal(timers.count(), 0, 'no timer left armed');

                await timers.fire();
                assert.deepEqual(connection.commands, ['NOOP'], 'no further poll after the duplicate break');
                done();
            });
        })().catch(done);
    });
    it('Polling: a break in the initiation tick prevents the first poll', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let connection: any = createConnection();
                // Simulate a break request (e.g. a command being queued) landing in the same
                // tick the loop is initiated: trap the loop installing its own preCheck and
                // break through it immediately, before the first poll has started
                let installedPreCheck = connection.preCheck;
                Object.defineProperty(connection, 'preCheck', {
                    get: () => installedPreCheck,
                    set: value => {
                        installedPreCheck = value;
                        if (typeof value === 'function') {
                            value();
                        }
                    }
                });

                let idlePromise = idleCommand(connection, 60000);
                await timers.drain();
                await idlePromise;

                assert.deepEqual(connection.commands, [], 'the already-cancelled session never polled');
                assert.equal(connection.idling, false, 'idling reset');
                assert.equal(connection.preCheck, false, 'preCheck released');
                assert.equal(timers.count(), 0, 'no timer left armed');
                done();
            });
        })().catch(done);
    });
    it('Polling: a restarted session resumes the schedule instead of polling again', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let connection: any = createConnection();

                let first = idleCommand(connection, 60000);
                await timers.drain();
                assert.deepEqual(connection.commands, ['NOOP'], 'the first session polls immediately');

                await (connection.preCheck as any)();
                await first;

                // Auto-IDLE restarts the loop after every caller command. An unconditional first poll here
                // would tie the poll rate to how often the caller runs commands instead of to the poll
                // interval - with a short autoIdleDelay, a command every few seconds means a poll every
                // few seconds.
                let second = idleCommand(connection as any, 60000);
                await timers.drain();
                assert.deepEqual(connection.commands, ['NOOP'], 'the restarted session does not poll again');
                assert.equal(timers.count(), 1, 'it waits out the remainder of the interval instead');
                assert.ok(timers.pending()[0]!.delay! <= 60000, 'and never longer than a full interval');

                await (connection.preCheck as any)();
                await second;

                // Once a full interval has elapsed, a fresh session polls at once again
                (connection as any)._lastPollAt = Date.now() - 61000;
                let third = idleCommand(connection as any, 60000);
                await timers.drain();
                assert.deepEqual(connection.commands, ['NOOP', 'NOOP'], 'a session starting after the interval polls right away');

                await (connection.preCheck as any)();
                await third;
                done();
            });
        })().catch(done);
    });
    it('Polling: a failed poll does not defer the next session', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let failNext = true;
                let connection: any[] = createConnection({
                    exec: async (command: any) => {
                        (connection as any).commands.push(command);
                        if (failNext) {
                            failNext = false;
                            throw new Error('poll failed');
                        }
                        return { next: () => {} };
                    }
                });

                // The failing poll cancels its own session. The attempt checked nothing, so it must not
                // count as a poll: only a completed poll moves the schedule stamp forward.
                let first = idleCommand(connection as any, 60000);
                await timers.drain();
                await first;
                assert.deepEqual((connection as any).commands, ['NOOP'], 'the first poll ran and failed');

                let second = idleCommand(connection as any, 60000);
                await timers.drain();
                assert.deepEqual((connection as any).commands, ['NOOP', 'NOOP'], 'the next session retries immediately instead of waiting out an interval');

                await ((connection as any).preCheck as any)();
                await second;
                done();
            });
        })().catch(done);
    });
    it('Polling: a backward clock step never defers the next poll past one interval', (t, done) => {
        (async () => {
            await withFakeTimers(async timers => {
                let connection: any = createConnection();

                // A last-poll stamp in the future is what an NTP step or a VM clock sync leaves behind.
                // Without the clamp the remainder math would schedule the next poll a full clock jump
                // plus one interval away.
                connection._lastPollAt = Date.now() + 60 * 60 * 1000;

                let idlePromise = idleCommand(connection as any, 60000);
                await timers.drain();
                assert.deepEqual(connection.commands, [], 'no immediate poll - the schedule is resumed');
                assert.equal(timers.count(), 1, 'a poll timer is armed');
                assert.ok(timers.pending()[0]!.delay! <= 60000, 'and it is never more than one interval away');

                await (connection.preCheck as any)();
                await idlePromise;
                done();
            });
        })().catch(done);
    });
});
