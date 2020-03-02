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
        try {
            connection.idling = true;

            connection.preCheck = async () => {
                await new Promise(resolve => {
                    // small delay to make sure we do not call preCheck before command is actually executed
                    setImmediate(() => {
                        connection.preCheck = false; // unset itself
                        connection.write('DONE');
                        connection.log.debug({ src: 'c', msg: `breaking IDLE` });
                        connection.idling = false;
                        resolve();
                    });
                });
            };

            response = await connection.exec('IDLE', false, {
                onPlusTag: async () => {
                    connection.log.debug({ src: 'c', msg: `initiated IDLE` });
                }
            });

            // unset before response.next()
            connection.preCheck = false;

            response.next();
            return;
        } catch (err) {
            connection.preCheck = false;

            connection.log.warn({ err, cid: connection.id });
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
            let response = await connection.exec('NOOP');
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
