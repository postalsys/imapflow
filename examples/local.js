'use strict';

const util = require('util');
const { ImapFlow } = require('../lib/imap-flow');

let config = {
    host: '127.0.0.1',
    port: 9993,
    secure: true,
    tls: {
        rejectUnauthorized: false
    },

    auth: {
        user: 'myuser2',
        pass: 'verysecret'
    }
};

let c = new ImapFlow(config);
c.on('error', err => {
    c.log.error(err);
});
c.on('close', (...args) => {
    console.log('CLOSE', ...args);
});

c.on('mailboxOpen', (...args) => {
    console.log('MAILBOX:OPEN', ...args);
});

c.on('mailboxClose', (...args) => {
    console.log('MAILBOX:CLOSE', ...args);
});

c.on('flags', updateEvent => {
    console.log('FLAGS UPDATE', util.inspect(updateEvent, false, 22));
});

c.on('exists', updateEvent => {
    console.log('EXISTS UPDATE', util.inspect(updateEvent, false, 22));
});

c.on('expunge', updateEvent => {
    console.log('EXPUNGE UPDATE', util.inspect(updateEvent, false, 22));
});

let main = async () => {
    await c.connect();

    await c.mailboxOpen('inbox');
    for await (let msg of c.fetch('1:*', { uid: true })) {
        console.log(msg);
    }

    await c.mailboxOpen('testnomodseq');
    for await (let msg of c.fetch('1:*', { uid: true })) {
        console.log(msg);
    }

    await c.logout();
};

main().catch(err => console.error(err));
