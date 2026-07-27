'use strict';

const { hasCapability, unrefTimer } = require('../tools.js');

const NOOP_INTERVAL = 2 * 60 * 1000;

/**
 * Marks the connection as idling on behalf of one session and returns a release function.
 *
 * Both IDLE modes use this so ownership of the shared `idling` flag is explicit: a session that
 * finishes late (a poll that completes after cancellation, an IDLE that unwinds after a restart)
 * cannot clear the flag of the session that has since taken over.
 *
 * @param {Object} connection - IMAP connection instance
 * @returns {Function} Release function, safe to call more than once
 */
function claimIdling(connection) {
    let token = {};
    connection._idleSession = token;
    connection.idling = true;

    return () => {
        if (connection._idleSession === token) {
            connection._idleSession = null;
            connection.idling = false;
        }
    };
}

/**
 * Runs a single IDLE session on the connection.
 *
 * @param {Object} connection - IMAP connection instance
 * @returns {Promise<void|boolean>} Void on success, false on failure
 */
async function runIdle(connection) {
    let response;

    // Queue of promises waiting for IDLE to break. When another command needs to run,
    // it calls connection.preCheck() which queues a promise here and sends DONE to break IDLE.
    let preCheckWaitQueue = [];

    // The preCheck function this session owns. Only this session may clear it from the
    // connection, so a newer IDLE session that already installed its own is left alone.
    let ownPreCheck = null;
    let releaseIdling = claimIdling(connection);

    try {
        // State flags for the IDLE lifecycle:
        // - doneRequested: someone wants to break IDLE (e.g., to run another command)
        // - doneSent: we've already sent the DONE command to server
        // - canEnd: server has acknowledged IDLE with "+" continuation, so DONE can be sent
        let doneRequested = false;
        let doneSent = false;
        let canEnd = false;

        // preCheck sends DONE to break out of IDLE. Called when another command
        // needs to run on this connection (e.g., a FETCH or STORE from user code).
        let preCheck = async () => {
            doneRequested = true;
            if (canEnd && !doneSent) {
                connection.log.debug({
                    src: 'c',
                    msg: `DONE`,
                    comment: `breaking IDLE`,
                    lockId: connection.currentLock?.lockId,
                    path: connection.mailbox && connection.mailbox.path
                });
                connection.write('DONE');
                doneSent = true;

                releaseIdling();
                if (connection.preCheck === ownPreCheck) {
                    connection.preCheck = false; // unset itself
                }

                while (preCheckWaitQueue.length) {
                    let { resolve } = preCheckWaitQueue.shift();
                    resolve();
                }
            }
        };

        // Public interface for breaking IDLE. Returns a promise that resolves when
        // IDLE is actually broken and the connection is free for other commands.
        let connectionPreCheck = () => {
            let handler = new Promise((resolve, reject) => {
                preCheckWaitQueue.push({ resolve, reject });
            });

            connection.log.trace({
                msg: 'Requesting IDLE break',
                lockId: connection.currentLock?.lockId,
                path: connection.mailbox && connection.mailbox.path,
                queued: preCheckWaitQueue.length,
                doneRequested,
                canEnd,
                doneSent
            });

            preCheck().catch(err => connection.log.warn({ err, cid: connection.id }));

            return handler;
        };

        // Register preCheck on the connection so other code (e.g., getMailboxLock) can break IDLE
        ownPreCheck = connectionPreCheck;
        connection.preCheck = connectionPreCheck;

        response = await connection.exec('IDLE', false, {
            // Server responds with "+" continuation to acknowledge IDLE mode.
            // After this, the server will push untagged responses for mailbox changes.
            // We can now safely send DONE if a break was already requested.
            onPlusTag: async () => {
                connection.log.debug({ msg: `Initiated IDLE, waiting for server input`, lockId: connection.currentLock?.lockId, doneRequested });
                canEnd = true;
                if (doneRequested) {
                    try {
                        await preCheck();
                    } catch (err) {
                        connection.log.warn({ err, cid: connection.id });
                    }
                }
            },
            onSend: () => {}
        });

        response.next();
        return;
    } catch (err) {
        connection.log.warn({ err, cid: connection.id });
        while (preCheckWaitQueue.length) {
            let { reject } = preCheckWaitQueue.shift();
            reject(err);
        }
        return false;
    } finally {
        // Single ownership cleanup for every outcome: explicit break, tagged completion
        // (including a server-terminated IDLE, where preCheck never ran), rejected command,
        // parser failure and connection close. `idling` drives socket-timeout handling, so it
        // must always describe reality rather than being left over from a previous state.
        releaseIdling();
        if (connection.preCheck === ownPreCheck) {
            connection.preCheck = false;
        }
        while (preCheckWaitQueue.length) {
            let { resolve } = preCheckWaitQueue.shift();
            resolve();
        }
    }
}

/**
 * Runs one fallback poll. The real SELECT and STATUS commands are reused instead of replaying the
 * saved wire arguments, so a poll applies exactly the same mailbox state transitions, events and
 * failure handling as a caller-issued command. They go through connection.runInternal() rather
 * than connection.run(), because run() awaits preCheck() - and the preCheck it would await is the
 * one this very polling session installed, so the session would cancel itself.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {Object} session - Polling session state
 * @returns {Promise<void>}
 */
async function pollOnce(connection, session) {
    let path = connection.mailbox && connection.mailbox.path;

    switch (connection.missingIdleCommand) {
        case 'SELECT':
            connection.log.debug({ src: 'c', msg: `Running SELECT to detect changes in folder`, cid: connection.id });
            await connection.runInternal('SELECT', path, { readOnly: session.selectCommand.command === 'EXAMINE' });
            break;

        case 'STATUS': {
            connection.log.debug({ src: 'c', msg: `Running STATUS to detect changes in folder`, cid: connection.id });
            // HIGHESTMODSEQ is filtered out again unless the server advertises CONDSTORE, so a
            // CONDSTORE session keeps mailbox.highestModseq current without asking a plain
            // server for an item it does not know.
            let status = await connection.runInternal('STATUS', path, {
                messages: true,
                uidNext: true,
                uidValidity: true,
                unseen: true,
                highestModseq: true
            });
            if (!status) {
                let err = new Error('STATUS poll failed');
                err.code = 'PollFailed';
                throw err;
            }
            break;
        }

        case 'NOOP':
        default: {
            let response = await connection.exec('NOOP', false, { comment: 'IDLE not supported' });
            response.next();
            break;
        }
    }
}

/**
 * Polls the selected mailbox at a fixed interval, for servers without IDLE support.
 *
 * The loop is one explicitly identified session: cancellation is idempotent, is checked before
 * a poll starts and again before the next timer is scheduled, and a poll that completes after
 * cancellation can neither run again nor take ownership away from a newer IDLE session.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {number} [maxIdleTime] - Upper bound for the polling interval
 * @returns {Promise<void>}
 */
async function runPollingFallback(connection, maxIdleTime) {
    if (!connection.currentSelectCommand) {
        return;
    }

    let session = {
        cancelled: false,
        timer: null,
        preCheck: null,
        selectCommand: connection.currentSelectCommand
    };

    let interval = maxIdleTime ? Math.min(NOOP_INTERVAL, maxIdleTime) : NOOP_INTERVAL;
    let releaseIdling = claimIdling(connection);

    try {
        await new Promise(resolve => {
            // Idempotent cancellation. Never keyed off connection.preCheck, because a newer IDLE
            // session may already own that property by the time an old poll settles.
            const cancel = () => {
                if (session.cancelled) {
                    return;
                }
                session.cancelled = true;
                clearTimeout(session.timer);
                session.timer = null;
                resolve();
            };

            session.preCheck = async () => {
                connection.log.debug({ src: 'c', msg: `breaking NOOP loop`, cid: connection.id });
                cancel();
            };
            connection.preCheck = session.preCheck;

            const runPoll = () => {
                if (session.cancelled) {
                    return;
                }

                // The transport or the mailbox may be gone by the time the timer fires
                if (!connection.socket || connection.socket.destroyed || connection.state !== connection.states.SELECTED || !connection.mailbox) {
                    return cancel();
                }

                pollOnce(connection, session)
                    .then(() => {
                        // Cancellation is re-checked here: the session may have been broken while
                        // this poll was in flight, and an orphaned poller must not schedule again.
                        if (session.cancelled) {
                            return;
                        }
                        session.timer = setTimeout(runPoll, interval);
                        // Background polling must not keep the process alive
                        unrefTimer(session.timer);
                    })
                    .catch(err => {
                        connection.log.warn({ err, cid: connection.id });
                        cancel();
                    });
            };

            connection.log.debug({ src: 'c', msg: `initiated NOOP loop`, cid: connection.id });
            // Keep the immediate first poll
            runPoll();
        });
    } finally {
        session.cancelled = true;
        clearTimeout(session.timer);
        session.timer = null;
        releaseIdling();
        if (connection.preCheck === session.preCheck) {
            connection.preCheck = false;
        }
    }
}

/**
 * Listens for changes in the selected mailbox using IDLE or NOOP polling fallback.
 *
 * @param {Object} connection - IMAP connection instance
 * @param {number} [maxIdleTime] - Maximum time in milliseconds to stay in IDLE before restarting
 * @returns {Promise<void|boolean|undefined>} Void on success, false on failure, or undefined if not in SELECTED state
 */
module.exports = async (connection, maxIdleTime) => {
    if (connection.state !== connection.states.SELECTED) {
        // nothing to do here
        return;
    }

    // If server supports IDLE (RFC 2177, folded into base IMAP4rev2), use it for
    // real-time push notifications. Otherwise, fall back to periodic polling with
    // NOOP/STATUS/SELECT.
    if (hasCapability(connection, 'IDLE')) {
        let idleTimer;
        let stillIdling = false;
        // IDLE loop: runs IDLE, and if maxIdleTime is reached, breaks and restarts to keep the
        // connection alive (some servers drop long-running IDLEs). Iterative rather than
        // recursive, so a long-lived idling connection does not retain one pending frame per
        // restart.
        for (;;) {
            if (maxIdleTime) {
                idleTimer = setTimeout(() => {
                    if (connection.idling) {
                        if (typeof connection.preCheck === 'function') {
                            stillIdling = true;
                            // request IDLE break if IDLE has been running for allowed time
                            connection.log.trace({ msg: 'Max allowed IDLE time reached', cid: connection.id });
                            connection.preCheck().catch(err => connection.log.warn({ err, cid: connection.id }));
                        }
                    }
                }, maxIdleTime);
                // Background IDLE restart timer must not keep the process alive
                unrefTimer(idleTimer);
            }
            let resp = await runIdle(connection);
            clearTimeout(idleTimer);
            if (!stillIdling) {
                return resp;
            }
            stillIdling = false;
        }
    }

    // Fallback for servers without IDLE support: poll at regular intervals using
    // NOOP (default), STATUS, or SELECT depending on missingIdleCommand config.
    return runPollingFallback(connection, maxIdleTime);
};
