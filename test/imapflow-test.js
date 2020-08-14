'use strict';

const { ImapFlow } = require('../lib/imap-flow');

module.exports['Create imapflow instance'] = test => {
    let imapFlow = new ImapFlow();
    test.ok(imapFlow);
    test.done();
};

module.exports['Create imapflow instance with custom logger'] = async test => {
    class CustomLogger {
        constructor() {}

        debug(obj) {
            console.log(JSON.stringify(obj));
        }

        info(obj) {
            console.log(JSON.stringify(obj));
        }

        warn(obj) {
            console.log(JSON.stringify(obj));
        }

        // eslint-disable-next-line no-unused-vars
        error(obj) {
            // we don't actually want to log anything here.
        }
    }

    let imapFlow = new ImapFlow({
        logger: new CustomLogger()
    });
    test.ok(imapFlow);
    try {
        await imapFlow.connect();
    } catch (ex) {
        // it is PERFECTLY okay to have an exception here. We expect an ECONNREFUSED if an exception occurs.
        test.equal(ex.code, 'ECONNREFUSED');
    }
    test.done();
};
