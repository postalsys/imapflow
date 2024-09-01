'use strict';

const fs = require('fs');
const util = require('util');
const os = require('os');
const pathlib = require('path');
const { ImapFlow } = require('../lib/imap-flow');

console.log('VERSION');
console.log(ImapFlow.version);

let config = {
    host: 'ethereal.email',
    port: 993,
    secure: true,
    tls: {
        rejectUnauthorized: false
    },

    auth: {
        user: 'jamel8@ethereal.email',
        pass: 'SXkR8knUzn6mw1adNd'
    },

    //proxy: 'socks://localhost:1080',
    //proxy: 'http://localhost:3128',

    clientInfo: {
        name: false,
        'support-url': false,
        vendor: false,
        date: false
    }
};
/*
config = {
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: {
        user: 'andris.reinman@hotmail.com',
        accessToken:
            'EwBIA+l3BAAU0+FyEzrGK6gRIXxWPxCw8ZPo0GUAAfJnd8ckJ9zN/tPTeapMcKON0IGTjeCI5J+L/yB2gaKly2hqn1yPmWBUW+Por/GV90Obgz1GELy3QvuJXDGO1knu+RW44947rLhS/i/Tt4b3qu1fN4tbh4DwgWTbstNHNjL9qe6P8ZV2shV7Rr5dg0I1kXq4r4JVXVxL6+kYHmgP1ngS4N0HDC5ESuJe6/0HgmWlBGpY119c82g6k9gqi3IaNDoI3waZhOBYKPF9w1tNY0hkUHId1GxxdjQSu0jMSAl4DXawfpzA/oTpEyqmV3Bwl+G+ECv6P5EnHLkNDiw3zMW9+3tOBsapejgJ9f2rQ6T9KNBBmcseEMAeMf9Lj5wDZgAACOPxpQQ3BGYIGAJ+E5GyeCfzyHOCXsHFjL4qnKy16OdAwyUyPjW63Xmaqp0SWPRqA8jGF5OXGO9TfAP4oHFRcZMM6ERaH13BraCZ9uPxboApbhXWuo3Os6vyW6jtvZV8dSS+oMcvzAfgGQgk7MlAweNSyxXs1cEx7exANSVWsYFMaZGiNPVxnJ0EHcY31upAvRyqAbZPU2mP1/O3GLBp7QIc0CdpOMtcuSGqYJd4+jrfvAMpZvl0veLnSMCjlPwlWTwUUqut6IdG9LiaTTNQ4973b6SCZ2eYZAuPuqHAoA8C3XUwQhX34yizI4haQZkeOb2z0ntQHdjagV6mnbh8hy8cHG7yb4N5lcC5FlzARfmE6RSHvk6HvJOrXxVKMacmOEwq7GuJBtUl4vBwA4Xe98uSFo1Lak62obMuZgJuaYw4R4gDoKdz49xTfx7gtQy3HVCtvLRQvNYEd+RaMvuST2d8WwhnaMe/1GeBmQ1EV1z2bkXABw8lAEWkSR7a4fvI8lu0niC4iThQWe2Ci/fVMn0vSbNi9h1DhAIVRZ9eeHBe695cePMM5SnurbezaU1+EeTtRrWyU1BC9c1YTznYoY4U2MRvjX7hRmExR+FGajKWxCpm1rsabmC90uBJ5sdryqDcMxqK7wE8bTn1+WAh/03OJ/qPIA4O+6AcnRB8SbWxB/8Sb6ncEj7Ns12M5izsmKcsO0QrFMWHlcYJmUlk8VMHH0UC'
    },

    clientInfo: {
        name: 'Oauth-Test',
        'support-url': false,
        vendor: false,
        date: false
    },

    logRaw: true
};
*/
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

async function listAll(connection) {
    let t = Date.now();
    let m = 0;
    console.log('USE CHANGEDSINCE');
    console.log(connection.mailbox);
    console.log({
        uid: true,
        changedSince: connection.mailbox && connection.mailbox.highestModseq ? connection.mailbox.highestModseq - BigInt(10) : false
    });
    console.log('LISTALL');
    for await (let message of connection.fetch(
        '1:*',
        //{ unseen: false },
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
        console.log(`requestTagMap size: ${connection.requestTagMap.size}`, connection.requestTagMap);
        m++;
        console.log(message.headers);
        console.log(message.envelope.subject);
        console.log(message.envelope);
        //console.log(require('util').inspect(message, false, 22));

        // await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log('ALL LISTED');
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
        console.log('CONNECTION established');
        //console.log(c.folders);
        /*
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
*/

        let mboxName = 'AT&T';
        let created = await c.mailboxCreate(mboxName);
        console.log(created);
        let mbox = await c.mailboxOpen(mboxName);
        console.log(mbox);
        let deleted = await c.mailboxDelete(mboxName);
        console.log(deleted);

        let lock = await c.getMailboxLock('INBOX', { description: 'SELECT' });

        console.log('LIST ALL NEXT');
        await listAll(c);
        await listLast(c);

        lock.release();

        console.log('PRE_IDLE', Date.now());
        setTimeout(() => {
            c.noop();
        }, 10 * 1000);
        await c.idle();
        console.log('AFTER_IDLE', Date.now());
        await c.noop();

        /*
        c.messageFlagsAdd('1:3', ['foo'], { uid: true, useLabels: true });

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

        res = await c.search({ uid: '1:*' });
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
        // start IDLEing
        await new Promise(resolve => {
            setTimeout(() => {
                console.log('LOGOUT');
                resolve();
            }, 1 * 2 * 1000);
        });
        console.log('next');

        console.log('QUOTA');
        res = await c.getQuota('jupikas');
        console.log(res);


        await c.mailboxClose();

        await c.mailboxOpen('INBOX', { readOnly: true });

        let list = await c.list();
        let processMailbox = async path => {
            let lock = await c.getMailboxLock(path);
            try {
                console.log(`Processing ${path}`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                let msg = await c.fetchOne('*', { flags: true });
                console.log(msg);
                await new Promise(resolve => setTimeout(resolve, 1000));
                let stor = await c.messageFlagsAdd('*', ['test']);
                console.log(stor);
                await new Promise(resolve => setTimeout(resolve, 1000));
            } finally {
                lock.release();
            }
        };

        list.forEach(mailbox => {
            processMailbox(mailbox.path).then(() => {
                console.log(`Mailbox ${mailbox.path} processed`);
            });
        });

        let lock;
        lock = await c.getMailboxLock('supra?');
        console.log('lock');

        lock = await c.getMailboxLock('INBOX');
        await c.idle();
        lock.release();
*/
    })
    .catch(err => {
        console.error(err);
        c.close();
    });
