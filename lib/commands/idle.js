'use strict';

const NOOP_INTERVAL = 2 * 60 * 1000;

// Listes for changes in mailbox
module.exports = async connection => {
    if (connection.state !== connection.states.SELECTED) {
        // nothing to do here
        return;
    }

    if (connection.capabilities.has('IDLE')) {
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
                    connection.log.debug({ msg: `Initiated IDLE, waiting for server input` });
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

    let idleTimer;

    return new Promise(resolve => {
        // no IDLE support, fallback to NOOP'ing
        connection.preCheck = async () => {
            connection.preCheck = false; // unset itself
            clearTimeout(idleTimer);
            connection.log.debug({ src: 'c', msg: `breaking NOOP loop` });
            connection.idling = false;
            resolve();
        };

        let idleCheck = async () => {
            let response = await connection.exec('NOOP', false, { comment: 'IDLE not supported' });
            response.next();
        };

        let runLoop = () => {
            idleCheck()
                .then(() => {
                    clearTimeout(idleTimer);
                    idleTimer = setTimeout(runLoop, NOOP_INTERVAL);
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
