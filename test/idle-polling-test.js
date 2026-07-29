'use strict';

// Fallback polling lifecycle (servers without IDLE): one explicitly identified polling session
// that cannot run or reschedule after cancellation, reuses the real STATUS/SELECT state
// handling, and always leaves `idling` describing reality.

const idleCommand = require('../lib/commands/idle.js');
const imapCommands = require('../lib/imap-commands.js');
const { withFakeTimers } = require('./fixtures/fake-timers');

const createConnection = (overrides = {}) => {
    const states = { NOT_AUTHENTICATED: 1, AUTHENTICATED: 2, SELECTED: 3, LOGOUT: 4 };

    const connection = {
        states,
        state: states.SELECTED,
        id: 'polling-test',
        capabilities: new Map(overrides.capabilities || []), // no IDLE -> polling fallback
        enabled: new Set(overrides.enabled || []),
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
        emit(event, payload) {
            connection.events.push({ event, payload });
        },
        run: async () => false,
        // Fallback polling dispatches through runInternal(), which ImapFlow resolves against the
        // command registry - so a poll runs the real SELECT/STATUS implementation.
        runInternal: async (command, ...args) => {
            let handler = imapCommands.get(command.toUpperCase());
            return handler ? await handler(connection, ...args) : false;
        },
        exec: async (command, attributes, options) => {
            connection.commands.push(command);
            return connection.respond(command, attributes, options);
        },
        respond: async () => ({ next: () => {}, response: { attributes: [{ value: 'OK' }] } })
    };

    // capabilities/enabled are already converted into a Map/Set above
    let rest = Object.assign({}, overrides);
    delete rest.capabilities;
    delete rest.enabled;

    return Object.assign(connection, rest);
};

module.exports['Polling: break before the first poll stops the loop'] = async test => {
    await withFakeTimers(async timers => {
        let connection = createConnection({
            exec: async command => {
                connection.commands.push(command);
                // break while the very first poll is still in flight
                await connection.preCheck();
                return { next: () => {} };
            }
        });

        let idlePromise = idleCommand(connection, 60000);
        await timers.drain();
        await idlePromise;

        test.deepEqual(connection.commands, ['NOOP'], 'only the immediate first poll ran');
        test.equal(connection.idling, false, 'idling reset after the break');
        test.equal(connection.preCheck, false, 'the session released preCheck');
        test.equal(timers.count(), 0, 'no polling timer is left armed');

        // Advancing several intervals must not produce another command
        await timers.fire();
        await timers.fire();
        test.deepEqual(connection.commands, ['NOOP'], 'a cancelled session never polls again');
        test.done();
    });
};

module.exports['Polling: break during an in-flight poll cannot reschedule'] = async test => {
    await withFakeTimers(async timers => {
        let releasePoll;
        let pollStarted;
        let connection = createConnection({
            exec: async command => {
                connection.commands.push(command);
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
        let idlePromise = idleCommand(connection, 60000);
        await started;

        // Cancel while the poll is still awaiting its response, then let it finish
        await connection.preCheck();
        releasePoll();
        await idlePromise;

        test.deepEqual(connection.commands, ['NOOP'], 'the in-flight poll completed but scheduled nothing');
        test.equal(timers.count(), 0, 'the completing poll did not arm a new timer');
        test.equal(connection.idling, false, 'idling reset');

        await timers.fire();
        test.deepEqual(connection.commands, ['NOOP'], 'no later command is sent');
        test.done();
    });
};

module.exports['Polling: break after a poll but before the next timer fires stops the loop'] = async test => {
    await withFakeTimers(async timers => {
        let connection = createConnection();

        let idlePromise = idleCommand(connection, 60000);
        await timers.drain();

        test.deepEqual(connection.commands, ['NOOP'], 'the immediate first poll ran');
        test.equal(timers.count(), 1, 'the next poll is scheduled');
        test.ok(timers.pending()[0].unrefd, 'the background polling timer does not keep the process alive');

        await connection.preCheck();
        await idlePromise;

        test.equal(timers.count(), 0, 'the armed timer was cleared on cancellation');

        await timers.fire();
        await timers.fire();
        test.deepEqual(connection.commands, ['NOOP'], 'no command after cancellation');
        test.done();
    });
};

module.exports['Polling: an old session does not clear a newer session preCheck'] = async test => {
    await withFakeTimers(async timers => {
        let releasePoll;
        let pollStarted;
        let connection = createConnection({
            exec: async command => {
                connection.commands.push(command);
                if (connection.commands.length === 1) {
                    await new Promise(resolve => {
                        releasePoll = resolve;
                        pollStarted();
                    });
                }
                return { next: () => {} };
            }
        });

        let started = new Promise(resolve => (pollStarted = resolve));
        let firstSession = idleCommand(connection, 60000);
        await started;

        // Cancel the first session while its poll is in flight, then immediately re-enter IDLE
        await connection.preCheck();
        let secondSession = idleCommand(connection, 60000);
        await timers.drain();

        let newPreCheck = connection.preCheck;
        test.equal(typeof newPreCheck, 'function', 'the new session installed its own preCheck');

        // The stale poll now finishes: it must not touch the new session's ownership
        releasePoll();
        await firstSession;

        test.equal(connection.preCheck, newPreCheck, 'the stale session left the newer preCheck in place');
        test.equal(connection.idling, true, 'the stale session did not clear the newer idling state');

        await connection.preCheck();
        await secondSession;
        test.equal(connection.idling, false, 'the newer session cleaned up on its own break');
        test.done();
    });
};

module.exports['Polling: STATUS polling applies mailbox state and emits exists only on change'] = async test => {
    await withFakeTimers(async timers => {
        let messages = 3;
        let connection = createConnection({
            capabilities: [['CONDSTORE', true]],
            missingIdleCommand: 'STATUS',
            respond: async (command, attributes, options) => {
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

        test.deepEqual(connection.commands, ['STATUS'], 'STATUS was used for polling');
        test.equal(connection.mailbox.uidNext, 11, 'uidNext updated from the poll');
        test.equal(connection.mailbox.highestModseq, BigInt(42), 'highestModseq updated on a CONDSTORE session');
        test.deepEqual(connection.events, [], 'an unchanged message count emits no event');

        // Second poll reports a new count -> exactly one exists event
        messages = 5;
        await timers.fire();

        test.equal(connection.mailbox.exists, 5, 'exists updated from the poll');
        test.equal(connection.events.length, 1, 'one event for the changed count');
        test.equal(connection.events[0].event, 'exists');
        test.equal(connection.events[0].payload.count, 5);
        test.equal(connection.events[0].payload.prevCount, 3);

        await connection.preCheck();
        await idlePromise;
        test.done();
    });
};

module.exports['Polling: STATUS omits HIGHESTMODSEQ without CONDSTORE'] = async test => {
    await withFakeTimers(async timers => {
        let requestedItems = [];
        let connection = createConnection({
            missingIdleCommand: 'STATUS',
            respond: async (command, attributes) => {
                if (command === 'STATUS') {
                    requestedItems = attributes[1].map(entry => entry.value);
                }
                return { next: () => {}, response: { attributes: [{ value: 'OK' }] } };
            }
        });

        let idlePromise = idleCommand(connection, 60000);
        await timers.drain();

        test.ok(requestedItems.includes('MESSAGES'), 'MESSAGES is polled');
        test.ok(requestedItems.includes('UIDNEXT'), 'UIDNEXT is polled');
        test.ok(!requestedItems.includes('HIGHESTMODSEQ'), 'HIGHESTMODSEQ is not requested without CONDSTORE');

        await connection.preCheck();
        await idlePromise;
        test.done();
    });
};

module.exports['Polling: failed SELECT polling deselects and stops the loop'] = async test => {
    await withFakeTimers(async timers => {
        let connection = createConnection({
            missingIdleCommand: 'SELECT',
            respond: async command => {
                if (command === 'SELECT') {
                    let err = new Error('Command failed');
                    err.responseStatus = 'NO';
                    throw err;
                }
                return { next: () => {}, response: { attributes: [{ value: 'OK' }] } };
            }
        });

        let idlePromise = idleCommand(connection, 60000);
        await timers.drain();
        await idlePromise;

        test.equal(connection.state, connection.states.AUTHENTICATED, 'a failed reselect drops to AUTHENTICATED');
        test.equal(connection.mailbox, false, 'mailbox state cleared');
        test.equal(connection.currentSelectCommand, false, 'the saved select command is cleared');
        test.equal(connection.idling, false, 'idling reset');
        test.equal(connection.preCheck, false, 'preCheck released');
        test.equal(timers.count(), 0, 'polling stopped');
        test.ok(
            connection.events.some(entry => entry.event === 'mailboxClose'),
            'the mailbox close transition was emitted, as with a caller-issued SELECT'
        );
        test.done();
    });
};

module.exports['Polling: a closed connection stops the loop instead of polling'] = async test => {
    await withFakeTimers(async timers => {
        let connection = createConnection();

        let idlePromise = idleCommand(connection, 60000);
        await timers.drain();
        test.deepEqual(connection.commands, ['NOOP'], 'first poll ran on a live connection');

        // Transport dies between polls
        connection.socket.destroyed = true;
        await timers.fire();
        await idlePromise;

        test.deepEqual(connection.commands, ['NOOP'], 'no command is sent on a dead transport');
        test.equal(connection.idling, false, 'idling reset when the loop stops');
        test.equal(connection.preCheck, false, 'preCheck released');
        test.done();
    });
};

module.exports['Polling: a rejected poll resets idling'] = async test => {
    await withFakeTimers(async timers => {
        let connection = createConnection({
            exec: async command => {
                connection.commands.push(command);
                let err = new Error('Connection not available');
                err.code = 'NoConnection';
                throw err;
            }
        });

        let idlePromise = idleCommand(connection, 60000);
        await timers.drain();
        await idlePromise;

        test.equal(connection.idling, false, 'idling reset after a rejected poll');
        test.equal(connection.preCheck, false, 'preCheck released after a rejected poll');
        test.equal(timers.count(), 0, 'nothing left scheduled');
        test.done();
    });
};

module.exports['Polling: no polling session without a saved select command'] = async test => {
    let connection = createConnection({ currentSelectCommand: false });
    await idleCommand(connection, 60000);
    test.deepEqual(connection.commands, [], 'nothing polled');
    test.equal(connection.idling, false, 'idling untouched');
    test.done();
};

module.exports['Polling: a falsy STATUS result stops the loop as PollFailed'] = async test => {
    await withFakeTimers(async timers => {
        let warnings = [];
        let connection = createConnection({
            missingIdleCommand: 'STATUS',
            // Only STATUS is ever polled; a failure without a NO status makes the
            // real STATUS implementation swallow the error and return false
            respond: async () => {
                throw new Error('Command failed');
            }
        });
        connection.log.warn = entry => warnings.push(entry);

        let idlePromise = idleCommand(connection, 60000);
        await timers.drain();
        await idlePromise;

        test.ok(
            warnings.some(entry => entry && entry.err && entry.err.code === 'PollFailed'),
            'the falsy STATUS result surfaced as a PollFailed error'
        );
        test.equal(connection.idling, false, 'idling reset after the failed poll');
        test.equal(connection.preCheck, false, 'preCheck released');
        test.equal(timers.count(), 0, 'polling stopped');
        test.done();
    });
};

module.exports['Polling: a repeated break call is a no-op'] = async test => {
    await withFakeTimers(async timers => {
        let connection = createConnection();

        let idlePromise = idleCommand(connection, 60000);
        await timers.drain();
        test.deepEqual(connection.commands, ['NOOP'], 'the immediate first poll ran');

        // A caller may hold on to the break function and invoke it more than once
        let preCheck = connection.preCheck;
        await preCheck();
        await preCheck();
        await idlePromise;

        test.equal(connection.idling, false, 'idling reset');
        test.equal(connection.preCheck, false, 'preCheck released');
        test.equal(timers.count(), 0, 'no timer left armed');

        await timers.fire();
        test.deepEqual(connection.commands, ['NOOP'], 'no further poll after the duplicate break');
        test.done();
    });
};

module.exports['Polling: a break in the initiation tick prevents the first poll'] = async test => {
    await withFakeTimers(async timers => {
        let connection = createConnection();
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

        test.deepEqual(connection.commands, [], 'the already-cancelled session never polled');
        test.equal(connection.idling, false, 'idling reset');
        test.equal(connection.preCheck, false, 'preCheck released');
        test.equal(timers.count(), 0, 'no timer left armed');
        test.done();
    });
};
