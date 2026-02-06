'use strict';

const NOOP_INTERVAL = 2 * 60 * 1000;

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
    try {
        connection.idling = true;

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

                connection.idling = false;
                connection.preCheck = false; // unset itself

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
            onSend: () => {
                //idleSent = true;
            }
        });

        // Clean up: unset preCheck and resolve any remaining waiters before processing the response.
        // Usually preCheck is already cleared by the DONE handler, but this handles edge cases.
        if (typeof connection.preCheck === 'function' && connection.preCheck === connectionPreCheck) {
            connection.log.trace({
                msg: 'Clearing pre-check function',
                lockId: connection.currentLock?.lockId,
                path: connection.mailbox && connection.mailbox.path,
                queued: preCheckWaitQueue.length,
                doneRequested,
                canEnd,
                doneSent
            });
            connection.preCheck = false;
            while (preCheckWaitQueue.length) {
                let { resolve } = preCheckWaitQueue.shift();
                resolve();
            }
        }

        response.next();
        return;
    } catch (err) {
        connection.preCheck = false;
        connection.idling = false;

        connection.log.warn({ err, cid: connection.id });
        while (preCheckWaitQueue.length) {
            let { reject } = preCheckWaitQueue.shift();
            reject(err);
        }
        return false;
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

    // If server supports IDLE (RFC 2177), use it for real-time push notifications.
    // Otherwise, fall back to periodic polling with NOOP/STATUS/SELECT.
    if (connection.capabilities.has('IDLE')) {
        let idleTimer;
        let stillIdling = false;
        // IDLE loop: runs IDLE, and if maxIdleTime is reached, breaks and restarts
        // to keep the connection alive (some servers drop long-running IDLEs).
        let runIdleLoop = async () => {
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
            }
            let resp = await runIdle(connection);
            clearTimeout(idleTimer);
            if (stillIdling) {
                stillIdling = false;
                return runIdleLoop();
            }
            return resp;
        };
        return runIdleLoop();
    }

    // Fallback for servers without IDLE support: poll at regular intervals using
    // NOOP (default), STATUS, or SELECT depending on missingIdleCommand config.
    let idleTimer;
    return new Promise(resolve => {
        if (!connection.currentSelectCommand) {
            return resolve();
        }

        // Set up preCheck so other commands can break the polling loop
        connection.preCheck = async () => {
            connection.preCheck = false; // unset itself
            clearTimeout(idleTimer);
            connection.log.debug({ src: 'c', msg: `breaking NOOP loop` });
            connection.idling = false;
            resolve();
        };

        let selectCommand = connection.currentSelectCommand;

        // Run one polling check. The method used depends on configuration:
        // SELECT re-selects the mailbox (may detect changes), STATUS queries mailbox counters,
        // NOOP is the simplest but relies on server pushing untagged responses.
        let idleCheck = async () => {
            let response;
            switch (connection.missingIdleCommand) {
                case 'SELECT':
                    // FIXME: somehow a loop occurs after some time of idling with SELECT
                    connection.log.debug({ src: 'c', msg: `Running SELECT to detect changes in folder` });
                    response = await connection.exec(selectCommand.command, selectCommand.arguments);
                    break;

                case 'STATUS':
                    {
                        let statusArgs = [selectCommand.arguments[0], []]; // path
                        for (let key of ['MESSAGES', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN']) {
                            statusArgs[1].push({ type: 'ATOM', value: key.toUpperCase() });
                        }
                        connection.log.debug({ src: 'c', msg: `Running STATUS to detect changes in folder` });
                        response = await connection.exec('STATUS', statusArgs);
                    }
                    break;

                case 'NOOP':
                default:
                    response = await connection.exec('NOOP', false, { comment: 'IDLE not supported' });
                    break;
            }
            response.next();
        };

        let noopInterval = maxIdleTime ? Math.min(NOOP_INTERVAL, maxIdleTime) : NOOP_INTERVAL;

        let runLoop = () => {
            idleCheck()
                .then(() => {
                    clearTimeout(idleTimer);
                    idleTimer = setTimeout(runLoop, noopInterval);
                })
                .catch(err => {
                    clearTimeout(idleTimer);
                    connection.preCheck = false;
                    connection.log.warn({ err, cid: connection.id });
                    resolve();
                });
        };

        connection.log.debug({ src: 'c', msg: `initiated NOOP loop` });
        connection.idling = true;
        runLoop();
    });
};
