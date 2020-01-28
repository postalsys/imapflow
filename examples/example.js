'use strict';

const fs = require('fs');
const util = require('util');
const os = require('os');
const pathlib = require('path');
const { ImapFlow } = require('../lib/imap-flow');

// random Ethereal account
let config = {
    host: 'ethereal.email',
    port: 993,
    secure: true,
    auth: {
        user: 'garland.mcclure71@ethereal.email',
        pass: 'mW6e4wWWnEd3H4hT5B'
    }
};

config = {
    host: 'localhost',
    port: 9993,
    secure: true,
    tls: {
        rejectUnauthorized: true
    },

    auth: {
        user: 'myuser',
        pass: 'verysecret'
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

async function listAll(connection) {
    let t = Date.now();
    let m = 0;
    console.log('USE CHANGEDSINCE');
    console.log(connection.mailbox);
    console.log({
        uid: true,
        changedSince: connection.mailbox && connection.mailbox.highestModseq ? connection.mailbox.highestModseq - BigInt(10) : false
    });
    for await (let message of connection.fetch(
        //'1:*',
        { unseen: false },
        {
            uid: true,
            flags: true,
            bodyStructure: true,
            envelope: true,
            internalDate: true,
            emailId: true,
            threadId: true,
            xGmLabels: true,
            headers: ['date', 'subject']
        },
        {
            uid: true,
            changedSince: connection.mailbox && connection.mailbox.highestModseq ? connection.mailbox.highestModseq - BigInt(10) : false
        }
    )) {
        m++;
        console.log(message.headers);
        console.log(message.envelope.subject);
        console.log(message.envelope);
        //console.log(require('util').inspect(message, false, 22));

        // await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log(m, Date.now() - t);
}

async function listLast(connection) {
    let t = Date.now();
    let message = await connection.fetchOne(
        '*',
        {
            uid: true,
            flags: true,
            bodyStructure: true,
            envelope: true,
            internalDate: true,
            size: true,
            headers: ['date', 'subject'],
            source: {
                start: 1024,
                maxLength: 100
            },

            emailId: true,
            threadId: true,
            xGmLabels: true,

            bodyParts: [
                'text',
                '1.mime',
                {
                    key: '1',
                    start: 2,
                    maxLength: 5
                }
            ]
        },
        { uid: false }
    );

    console.log(util.inspect(message, false, 22));
    if (!message) {
        return;
    }

    console.log(Date.now() - t);
}

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
        console.log('CONENCTION established');
        //console.log(c.folders);

        let fname = 'test-' + Date.now();

        let res = await c.mailboxCreate(fname);
        console.log(res);

        let newName = 'test-' + Date.now();
        let oldName = fname;
        res = await c.mailboxRename(oldName, newName);
        console.log(res);
        if (res) {
            fname = newName;
        }

        try {
            res = await c.mailboxRename(oldName, newName);
            console.log(res);
        } catch (err) {
            // ignore
        }

        res = await c.mailboxUnsubscribe(fname);
        console.log(res);

        res = await c.mailboxSubscribe(fname);
        console.log(res);

        console.log(c.serverInfo);
        console.log(c.namespace);
        console.log(c.enabled);
        console.log(c.tls);

        await c.mailboxOpen('INBOX');

        await listAll(c);
        await listLast(c);

        c.messageFlagsAdd('*', ['Zuulius', '\\FLAGGED'], { uid: true, silent: false });
        c.messageFlagsRemove('*', ['Zuulius', '\\FLAGGED'], { uid: true, silent: false });

        let { meta, content } = await c.download('*', '3');
        if (content) {
            let fname = pathlib.join(os.tmpdir(), meta.filename || `out-${Date.now()}.bin`);
            let out = fs.createWriteStream(fname);
            await new Promise(resolve => {
                content.pipe(out);
                out.once('finish', () => {
                    console.log('WRITTEN TO %s', fname);
                    resolve();
                });
            });
        }

        res = await c.search();
        console.log(res);

        res = await c.messageCopy('1:5', fname, {});
        console.log(res);

        await c.noop();

        await c.mailboxOpen('inbox');

        // reads decoded mime content for a format=flowed string
        res = await c.append(
            'inbox',
            `Subject: test\r\nFrom: mailder.daemon@example.com\r\nTo: mailder.daemon@example.com\r\nContent-Type: text/plain; format=flowed\r\n\r\nFirst line \r\ncontinued \r\nand so on\r\n`,
            ['\\Seen'],
            new Date()
        );
        console.log(1);
        console.log(res);
        console.log(2);

        if (res.uid) {
            let { meta, content } = await c.download(res.uid, '1', { uid: true });
            if (content) {
                console.log(meta);
                let buf = [];
                await new Promise(resolve => {
                    content.on('readable', () => {
                        let chunk;
                        while ((chunk = content.read()) !== null) {
                            buf.push(chunk);
                        }
                    });
                    content.once('end', () => {
                        let str = Buffer.concat(buf).toString();
                        console.log('RESULT: ' + JSON.stringify(str));
                        resolve();
                    });
                });
            }
        }

        res = await c.messageMove(res.uid, fname, { uid: true });
        console.log(res);

        if (res.uid) {
            res = await c.messageDelete(res.uid, { uid: true });
            console.log(3);
            console.log(res);
            console.log(4);
        }

        res = await c.status('inbox', {
            messages: true,
            uidNext: true,
            uidValidity: true,
            unseen: true,
            highestModseq: true
        });
        console.log(res);

        res = await c.mailboxDelete(fname);
        console.log(res);

        try {
            res = await c.mailboxDelete(fname);
            console.log(res);
        } catch (err) {
            // ignore
        }

        console.log('wait');
        // start IDLEind
        await new Promise(resolve => {
            setTimeout(() => {
                console.log('LOGOUT');
                resolve();
            }, 1 * 2 * 1000);
        });
        console.log('next');

        //res = await c.getQuota();
        //console.log(res);

        //await c.logout();
        /*        
setTimeout(() => {
            console.log('LOGOUT');
            c.status('INBOX', { messages: true });
        }, 1 * 60 * 1000);
*/
        await c.idle();
    })
    .catch(err => {
        console.error(err);
        c.close();
    });
