'use strict';

const NOOP_INTERVAL = 30 * 1000;

// Listes for changes in mailbox
module.exports = async connection => {
    if (connection.state !== connection.states.SELECTED) {
        // nothing to do here
        return;
    }

    if (connection.capabilities.has('IDLE')) {
        let response;
        try {
            connection.onPlusTag = async () => {
                connection.log.info({ src: 'c', msg: `initiated IDLE` });
            };

            connection.preCheck = async () => {
                connection.write('DONE');
                connection.log.info({ src: 'c', msg: `breaking IDLE` });
            };

            response = await connection.exec('IDLE', false, {});

            response.next();
            return;
        } catch (err) {
            connection.log.error(err);
            return false;
        } finally {
            connection.onPlusTag = false;
            connection.preCheck = false;
        }
    }

    let idleTimer;

    return new Promise(resolve => {
        // no IDLE support, fallback to NOOP'ing
        connection.preCheck = async () => {
            clearTimeout(idleTimer);
            connection.preCheck = false;
            connection.log.info({ src: 'c', msg: `breaking NOOP loop` });
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
                    connection.log.error(err);
                    resolve();
                });
        };

        connection.log.info({ src: 'c', msg: `initiated NOOP loop` });
        runLoop();
    });
};
