'use strict';

const util = require('util');
const { ImapFlow } = require('../lib/imap-flow');

let config = {
    host: 'localhost',
    port: 9993,
    secure: true,
    tls: {
        rejectUnauthorized: false
    },

    auth: {
        user: 'myuser',
        pass: 'verysecret'
    },

    clientInfo: {
        name: false,
        'support-url': false,
        vendor: false,
        date: false
    },

    logRaw: true
};

let c = new ImapFlow(config);
c.on('error', err => {
    c.log.error(err);
});
c.on('close', (...args) => {
    console.log('CLOSE');
    console.log('args', ...args);
});

c.on('mailboxOpen', (...args) => {
    console.log('MAILBOX:OPEN');
    console.log('args', ...args);
});

c.on('mailboxClose', (...args) => {
    console.log('MAILBOX:CLOSE');
    console.log('args', ...args);
});

c.on('flags', updateEvent => {
    console.log('FLAGS UPDATE');
    console.log(util.inspect(updateEvent, false, 22));
});

c.on('exists', updateEvent => {
    console.log('EXISTS UPDATE');
    console.log(util.inspect(updateEvent, false, 22));
});

c.on('expunge', updateEvent => {
    console.log('EXPUNGE UPDATE');
    console.log(util.inspect(updateEvent, false, 22));
});

setTimeout(() => {
    console.log(c.stats());
}, 1000);

c.connect()
    //.then(() => c.list())
    .then(async () => {
        console.log('CONNECTION established');

        console.log(c.serverInfo);
        console.log(c.namespace);
        console.log(c.enabled);
        console.log(c.tls);

        await c.mailboxOpen('INBOX');

        setTimeout(() => {
            console.log('FETCHING');
            c.fetchOne('*', { uid: true })
                .then(msg => {
                    console.log('FIN');
                    console.log(msg);
                })
                .catch(err => {
                    console.log('ERR');
                    console.error(err);
                });
        }, 10 * 1000);

        for (let i = 0; i < 10; i++) {
            c.idle().catch(err => {
                console.error(err);
            });
        }

        //await c.idle();
    })
    .catch(err => {
        console.error(err);
        c.close();
    });
