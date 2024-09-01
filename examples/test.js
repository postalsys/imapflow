'use strict';

const util = require('util');
const { ImapFlow } = require('../lib/imap-flow');

let config = {
    host: 'ethereal.email',
    port: 993,
    secure: true,
    tls: {
        rejectUnauthorized: false
    },

    auth: {
        user: 'camylle.gleason@ethereal.email',
        pass: 'Cy1gQEWEWC6MSRmj51'
    },

    clientInfo: {
        name: false,
        'support-url': false,
        vendor: false,
        date: false
    }
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

c.connect()
    //.then(() => c.list())
    .then(async () => {
        console.log('CONNECTION established');
        //console.log(c.folders);
        let path = 'INBOX';
        setTimeout(() => c.writeSocket.destroy(), 100);
        try {
            await c.mailboxOpen(path);
            console.log('success 1');
        } catch (err) {
            console.error(3, err);
        }
        try {
            await c.logout();
            console.log('success 2');
        } catch (err) {
            console.error(1, err);
        }
        console.log('done');
    })
    .then(() => console.log('ready'))
    .catch(err => {
        console.log('failed');
        console.error(2, err);
        c.close();
    });
