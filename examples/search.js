'use strict';

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

let client = new ImapFlow(config);

const SERACH_OBJS = [
    { to: 'mail1@domain.com' },
    { to: 'mail2@domain.com' },
    { to: 'mail3@domain.com' },
    { to: 'mail4@domain.com' },
    { to: 'mail5@domain.com' }
];

async function fetchMails() {
    await client.connect();
    let lock = await client.getMailboxLock('INBOX');
    try {
        for await (let message of client.fetch(
            { or: SERACH_OBJS } /* pass SEARCH_OBS here */,
            { envelope: true, uid: true, emailId: true } /* Another bug: emailID is not fetched! */,
            { uid: true }
        )) {
            /* DO STUFF HERE */
        }
    } finally {
        lock.release();
    }
    await client.logout();
}

fetchMails();
