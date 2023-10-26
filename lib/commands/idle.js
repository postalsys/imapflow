'use strict';

const NOOP_INTERVAL = 2 * 60 * 1000;

async function runIdle(connection) {
    let response;

    let preCheckWaitQueue = [];
    try {
        connection.idling = true;

        //let idleSent = false;
        let doneRequested = false;
        let doneSent = false;
        let canEnd = false;

        let preCheck = () => {
            doneRequested = true;
            if (canEnd && !doneSent) {
                connection.log.debug({
                    src: 'c',
                    msg: `DONE`,
                    comment: `breaking IDLE`,
                    lockId: connection.currentLockId,
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

        connection.preCheck = () => {
            let handler = new Promise((resolve, reject) => {
                preCheckWaitQueue.push({ resolve, reject });
            });

            connection.log.trace({
                msg: 'Requesting IDLE break',
                lockId: connection.currentLockId,
                path: connection.mailbox && connection.mailbox.path,
                queued: preCheckWaitQueue.length,
                doneRequested,
                canEnd,
                doneSent
            });

            preCheck();

            return handler;
        };

        response = await connection.exec('IDLE', false, {
            onPlusTag: async () => {
                connection.log.debug({ msg: `Initiated IDLE, waiting for server input`, doneRequested });
                canEnd = true;
                if (doneRequested) {
                    preCheck();
                }
            },
            onSend: () => {
                //idleSent = true;
            }
        });

        // unset before response.next()
        if (typeof connection.preCheck === 'function') {
            connection.log.trace({
                msg: 'Clearing pre-check function',
                lockId: connection.currentLockId,
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

// Listes for changes in mailbox
module.exports = async (connection, maxIdleTime) => {
    if (connection.state !== connection.states.SELECTED) {
        // nothing to do here
        return;
    }

    if (connection.capabilities.has('IDLE')) {
        let idleTimer;
        let stillIdling = false;
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

    let idleTimer;
    return new Promise(resolve => {
        if (!connection.currentSelectCommand) {
            return resolve();
        }

        // no IDLE support, fallback to NOOP'ing
        connection.preCheck = async () => {
            connection.preCheck = false; // unset itself
            clearTimeout(idleTimer);
            connection.log.debug({ src: 'c', msg: `breaking NOOP loop` });
            connection.idling = false;
            resolve();
        };

        let selectCommand = connection.currentSelectCommand;

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
