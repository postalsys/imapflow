'use strict';

// Live integration tests against a real IMAP4rev2 server (Dovecot 2.4+ in Docker).
// Started via `npm run test:rev2` (see run-rev2-tests.sh) - excluded from the
// Gruntfile nodeunit config so `npm test` stays Docker-free.
//
// The container uses a static passdb: any username logs in with the password
// "pass", and every user gets a fresh mail home, so each test connects with a
// unique user for isolation.

const { ImapFlow } = require('../../lib/imap-flow');

const HOST = process.env.IMAPFLOW_TEST_HOST || '127.0.0.1';
const PORT = Number(process.env.IMAPFLOW_TEST_PORT) || 31143;

let userCounter = 0;

const connectClient = async (options, logs) => {
    let client = new ImapFlow(
        Object.assign(
            {
                host: HOST,
                port: PORT,
                secure: false,
                // The test container upgrades via STARTTLS with a self-signed cert
                tls: { rejectUnauthorized: false },
                auth: { user: `livetest-${Date.now()}-${++userCounter}`, pass: 'pass' },
                logger: false,
                emitLogs: !!logs
            },
            options || {}
        )
    );
    if (logs) {
        client.on('log', entry => logs.push(entry));
    }
    await client.connect();
    return client;
};

const wireLines = logs => logs.filter(entry => entry && typeof entry.msg === 'string' && ['c', 's'].includes(entry.src));
const clientSent = (logs, needle) => wireLines(logs).some(entry => entry.src === 'c' && entry.msg.includes(needle));
// Matches only an untagged response for the given command ("* ESEARCH ...").
// A plain substring check would false-positive on capability listings - the
// login response advertises tokens like ESEARCH in its CAPABILITY list.
const serverSentUntagged = (logs, command) => {
    let re = new RegExp(`^\\* ${command}( |$)`);
    return wireLines(logs).some(entry => entry.src === 's' && re.test(entry.msg));
};

module.exports['Live rev2: connect negotiates ENABLE IMAP4rev2'] = async test => {
    const client = await connectClient();
    try {
        test.ok(client.capabilities.has('IMAP4rev2'), 'server should advertise IMAP4rev2');
        test.ok(client.enabled.has('IMAP4REV2'), 'IMAP4rev2 should be enabled');
        // The single merged ENABLE call must not lose the other extensions
        test.ok(client.enabled.has('CONDSTORE'), 'CONDSTORE should still be enabled');
    } finally {
        await client.logout();
    }
    test.done();
};

module.exports['Live rev2: list uses RETURN (SUBSCRIBED) and skips LSUB'] = async test => {
    const logs = [];
    const client = await connectClient(null, logs);
    try {
        const folders = await client.list();

        test.ok(clientSent(logs, 'SUBSCRIBED'), 'LIST should request RETURN (SUBSCRIBED)');
        test.ok(!clientSent(logs, 'LSUB'), 'LSUB must not be issued on a rev2 session');

        const sent = folders.find(folder => folder.path === 'Sent');
        test.ok(sent, 'Sent mailbox should be listed');
        test.equal(sent.subscribed, true, 'Sent should be reported as subscribed');
        test.equal(sent.specialUse, '\\Sent', 'special-use flag should be honored');
        // \HasNoChildren must survive the extended LIST (RETURN (CHILDREN) requested)
        test.ok(sent.flags.has('\\HasNoChildren'), 'child info should be present');
        for (let folder of folders) {
            test.ok(!folder.flags.has('\\Subscribed'), '\\Subscribed must be folded into the subscribed property');
        }

        const inbox = folders.find(folder => folder.path === 'INBOX');
        test.ok(inbox, 'INBOX should be listed');
        test.equal(inbox.subscribed, true, 'INBOX is always reported as subscribed');
    } finally {
        await client.logout();
    }
    test.done();
};

module.exports['Live rev2: subscription state round-trips'] = async test => {
    const client = await connectClient();
    try {
        await client.mailboxCreate('RoundTrip');
        await client.mailboxSubscribe('RoundTrip');
        let folders = await client.list();
        test.equal(folders.find(folder => folder.path === 'RoundTrip').subscribed, true);

        await client.mailboxUnsubscribe('RoundTrip');
        folders = await client.list();
        test.ok(!folders.find(folder => folder.path === 'RoundTrip').subscribed);
    } finally {
        await client.logout();
    }
    test.done();
};

module.exports['Live rev2: deleted-but-subscribed folders stay out of listings'] = async test => {
    const client = await connectClient();
    try {
        await client.mailboxCreate('Ghost');
        await client.mailboxSubscribe('Ghost');
        await client.mailboxDelete('Ghost');

        const folders = await client.list();
        // The RETURN (SUBSCRIBED) option must not resurrect phantom subscriptions
        // the way a raw LSUB would
        test.ok(!folders.find(folder => folder.path === 'Ghost'), 'deleted folder must not be listed');
    } finally {
        await client.logout();
    }
    test.done();
};

module.exports['Live rev2: UTF-8 mailbox names round-trip'] = async test => {
    const client = await connectClient();
    try {
        const name = 'T\u00f5rva \u00f5un';
        await client.mailboxCreate(name);
        const folders = await client.list();
        const created = folders.find(folder => folder.path === name);
        test.ok(created, 'UTF-8 mailbox should be listed under its literal name');

        const mailbox = await client.mailboxOpen(name);
        test.equal(mailbox.path, name);
        await client.mailboxClose();
        await client.mailboxDelete(name);
    } finally {
        await client.logout();
    }
    test.done();
};

module.exports['Live rev2: statusQuery is answered inline via LIST-STATUS'] = async test => {
    const logs = [];
    const client = await connectClient(null, logs);
    try {
        await client.append('INBOX', Buffer.from('Subject: status probe\r\n\r\nstatus probe body\r\n'));

        const folders = await client.list({ statusQuery: { messages: true, unseen: true } });

        test.ok(clientSent(logs, 'STATUS'), 'LIST should carry RETURN (STATUS ...)');
        const inbox = folders.find(folder => folder.path === 'INBOX');
        test.equal(inbox.status.messages, 1, 'inline STATUS should report the appended message');
    } finally {
        await client.logout();
    }
    test.done();
};

module.exports['Live rev2: plain search results are collected'] = async test => {
    const logs = [];
    const client = await connectClient(null, logs);
    try {
        await client.append('INBOX', Buffer.from('Subject: first\r\n\r\nfirst\r\n'));
        await client.append('INBOX', Buffer.from('Subject: second\r\n\r\nsecond\r\n'));

        await client.mailboxOpen('INBOX');
        const results = await client.search({ all: true });

        // RFC 9051 deprecates the untagged SEARCH response in favor of ESEARCH,
        // but Dovecot 2.4 still answers a plain SEARCH with the legacy form even
        // on an ENABLEd rev2 session (verified on the wire). The client accepts
        // both forms, so assert that the results arrived via one of them - the
        // ESEARCH-answered variant of a plain SEARCH is covered by the mock
        // suite, and a real ESEARCH response is exercised live in the
        // returnOptions test below.
        test.ok(serverSentUntagged(logs, 'SEARCH') || serverSentUntagged(logs, 'ESEARCH'), 'results should arrive via an untagged SEARCH or ESEARCH response');
        test.deepEqual(results, [1, 2]);
    } finally {
        await client.logout();
    }
    test.done();
};

module.exports['Live rev2: returnOptions search is answered via a real ESEARCH response'] = async test => {
    const logs = [];
    const client = await connectClient(null, logs);
    try {
        await client.append('INBOX', Buffer.from('Subject: first\r\n\r\nfirst\r\n'));
        await client.append('INBOX', Buffer.from('Subject: second\r\n\r\nsecond\r\n'));

        await client.mailboxOpen('INBOX');
        const result = await client.search({ all: true }, { returnOptions: ['ALL', 'COUNT'] });

        // SEARCH RETURN (...) makes Dovecot answer with a genuine untagged
        // ESEARCH response - this exercises the ESEARCH parsing path against a
        // real server
        test.ok(serverSentUntagged(logs, 'ESEARCH'), 'server should reply with an untagged ESEARCH response');
        test.ok(!serverSentUntagged(logs, 'SEARCH'), 'no legacy untagged SEARCH response is expected');
        test.equal(result.count, 2);
        test.equal(result.all, '1:2');
    } finally {
        await client.logout();
    }
    test.done();
};

module.exports['Live rev2: message lifecycle smoke test'] = async test => {
    const client = await connectClient();
    try {
        await client.append('INBOX', Buffer.from('Subject: smoke\r\n\r\nsmoke body\r\n'), ['\\Seen']);

        await client.mailboxOpen('INBOX');
        const message = await client.fetchOne('1', { envelope: true, flags: true, uid: true });
        test.equal(message.envelope.subject, 'smoke');
        test.ok(message.flags.has('\\Seen'));

        await client.mailboxCreate('Smoke');
        await client.messageCopy('1', 'Smoke');
        await client.messageMove('1', 'Smoke');

        const status = await client.status('Smoke', { messages: true });
        test.equal(status.messages, 2, 'copy plus move should land two messages');

        // uid expunge - UIDPLUS is folded into base rev2, so only the requested
        // message may disappear
        await client.mailboxOpen('Smoke');
        const first = await client.fetchOne('1', { uid: true });
        await client.messageDelete(`${first.uid}`, { uid: true });
        const statusAfter = await client.status('Smoke', { messages: true });
        test.equal(statusAfter.messages, 1, 'UID EXPUNGE must remove only the targeted message');

        await client.mailboxClose();
        await client.mailboxRename('Smoke', 'Smoke2');
        await client.mailboxDelete('Smoke2');
    } finally {
        await client.logout();
    }
    test.done();
};
