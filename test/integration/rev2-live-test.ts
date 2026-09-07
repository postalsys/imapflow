import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImapFlow } from '../../src/imap-flow.js';

// Live integration tests against a real IMAP4rev2 server (Dovecot 2.4+ in Docker).
// Started via `npm run test:rev2` (see run-rev2-tests.sh) - excluded from the
// `npm test` file list so plain test runs stay Docker-free.
//
// The container uses a static passdb: any username logs in with the password
// "pass", and every user gets a fresh mail home, so each test connects with a
// unique user for isolation.

const HOST = process.env.IMAPFLOW_TEST_HOST || '127.0.0.1';
const PORT = Number(process.env.IMAPFLOW_TEST_PORT) || 31143;

let userCounter = 0;

const connectClient = async (options: any, logs: any) => {
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

const wireLines = (logs: any) => logs.filter((entry: any) => entry && typeof entry.msg === 'string' && ['c', 's'].includes(entry.src));
const clientSent = (logs: any, needle: any) => wireLines(logs).some((entry: any) => entry.src === 'c' && entry.msg.includes(needle));
// Matches only an untagged response for the given command ("* ESEARCH ...").
// A plain substring check would false-positive on capability listings - the
// login response advertises tokens like ESEARCH in its CAPABILITY list.
const serverSentUntagged = (logs: any, command: any) => {
    let re = new RegExp(`^\\* ${command}( |$)`);
    return wireLines(logs).some((entry: any) => entry.src === 's' && re.test(entry.msg));
};

describe('rev2-live', () => {
    it('Live rev2: connect negotiates ENABLE IMAP4rev2', async () => {
        const client = await (connectClient as any)();
        try {
            assert.ok(client.capabilities.has('IMAP4rev2'), 'server should advertise IMAP4rev2');
            assert.ok(client.enabled.has('IMAP4REV2'), 'IMAP4rev2 should be enabled');
            // The single merged ENABLE call must not lose the other extensions
            assert.ok(client.enabled.has('CONDSTORE'), 'CONDSTORE should still be enabled');
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: list uses RETURN (SUBSCRIBED) and skips LSUB', async () => {
        const logs: any = [];
        const client: any = await connectClient(null, logs);
        try {
            const folders = await client.list();

            assert.ok(clientSent(logs, 'SUBSCRIBED'), 'LIST should request RETURN (SUBSCRIBED)');
            assert.ok(!clientSent(logs, 'LSUB'), 'LSUB must not be issued on a rev2 session');

            const sent = folders.find((folder: any) => folder.path === 'Sent');
            assert.ok(sent, 'Sent mailbox should be listed');
            assert.equal(sent.subscribed, true, 'Sent should be reported as subscribed');
            assert.equal(sent.specialUse, '\\Sent', 'special-use flag should be honored');
            // \HasNoChildren must survive the extended LIST (RETURN (CHILDREN) requested)
            assert.ok(sent.flags.has('\\HasNoChildren'), 'child info should be present');
            for (let folder of folders) {
                assert.ok(!folder.flags.has('\\Subscribed'), '\\Subscribed must be folded into the subscribed property');
            }

            const inbox = folders.find((folder: any) => folder.path === 'INBOX');
            assert.ok(inbox, 'INBOX should be listed');
            assert.equal(inbox.subscribed, true, 'INBOX is always reported as subscribed');
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: subscription state round-trips', async () => {
        const client = await (connectClient as any)();
        try {
            await client.mailboxCreate('RoundTrip');
            await client.mailboxSubscribe('RoundTrip');
            let folders: any = await client.list();
            assert.equal(folders.find((folder: any) => folder.path === 'RoundTrip').subscribed, true);

            await client.mailboxUnsubscribe('RoundTrip');
            folders = await client.list();
            assert.ok(!folders.find((folder: any) => folder.path === 'RoundTrip').subscribed);
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: deleted-but-subscribed folders stay out of listings', async () => {
        const client = await (connectClient as any)();
        try {
            await client.mailboxCreate('Ghost');
            await client.mailboxSubscribe('Ghost');
            await client.mailboxDelete('Ghost');

            const folders = await client.list();
            // The RETURN (SUBSCRIBED) option must not resurrect phantom subscriptions
            // the way a raw LSUB would
            assert.ok(!folders.find((folder: any) => folder.path === 'Ghost'), 'deleted folder must not be listed');
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: UTF-8 mailbox names round-trip', async () => {
        const client = await (connectClient as any)();
        try {
            const name = 'T\u00f5rva \u00f5un';
            await client.mailboxCreate(name);
            const folders = await client.list();
            const created = folders.find((folder: any) => folder.path === name);
            assert.ok(created, 'UTF-8 mailbox should be listed under its literal name');

            const mailbox = await client.mailboxOpen(name);
            assert.equal(mailbox.path, name);
            await client.mailboxClose();
            await client.mailboxDelete(name);
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: statusQuery is answered inline via LIST-STATUS', async () => {
        const logs: any = [];
        const client: any = await connectClient(null, logs);
        try {
            await client.append('INBOX', Buffer.from('Subject: status probe\r\n\r\nstatus probe body\r\n'));

            const folders = await client.list({ statusQuery: { messages: true, unseen: true } });

            // Pin the inline LIST-STATUS behavior: the STATUS request must ride on the
            // LIST command itself, and no standalone STATUS command may be issued -
            // a plain substring check would also pass on the fallback path
            const listLine: any = wireLines(logs).find((entry: any) => entry.src === 'c' && /^\S+ LIST /.test(entry.msg));
            assert.ok(listLine && listLine.msg.includes('RETURN') && listLine.msg.includes('STATUS'), 'LIST should carry RETURN (STATUS ...)');
            assert.ok(
                !wireLines(logs).some((entry: any) => entry.src === 'c' && /^\S+ STATUS /.test(entry.msg)),
                'no standalone STATUS command should be needed'
            );
            const inbox: any = folders.find((folder: any) => folder.path === 'INBOX');
            assert.equal(inbox.status!.messages, 1, 'inline STATUS should report the appended message');
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: plain search results are collected', async () => {
        const logs: any = [];
        const client: any = await connectClient(null, logs);
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
            assert.ok(
                serverSentUntagged(logs, 'SEARCH') || serverSentUntagged(logs, 'ESEARCH'),
                'results should arrive via an untagged SEARCH or ESEARCH response'
            );
            assert.deepEqual(results, [1, 2]);
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: returnOptions search is answered via a real ESEARCH response', async () => {
        const logs: any = [];
        const client: any = await connectClient(null, logs);
        try {
            await client.append('INBOX', Buffer.from('Subject: first\r\n\r\nfirst\r\n'));
            await client.append('INBOX', Buffer.from('Subject: second\r\n\r\nsecond\r\n'));

            await client.mailboxOpen('INBOX');
            const result: any = await client.search({ all: true }, { returnOptions: ['ALL', 'COUNT'] });

            // SEARCH RETURN (...) makes Dovecot answer with a genuine untagged
            // ESEARCH response - this exercises the ESEARCH parsing path against a
            // real server
            assert.ok(serverSentUntagged(logs, 'ESEARCH'), 'server should reply with an untagged ESEARCH response');
            assert.ok(!serverSentUntagged(logs, 'SEARCH'), 'no legacy untagged SEARCH response is expected');
            assert.equal((result as any).count, 2);
            assert.equal((result as any)!.all, '1:2');
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: SEARCHRES saved result is usable as a sequence set', async () => {
        // SEARCH RETURN (SAVE) stores the result server-side (RFC 5182) and '$'
        // references it in later commands. '$' has to make it through the outgoing
        // sequence-set validation for that to work at all.
        const client = await (connectClient as any)();
        try {
            assert.ok(client.capabilities.has('SEARCHRES'), 'Dovecot should advertise SEARCHRES');

            await client.append('INBOX', Buffer.from('Subject: first\r\n\r\nfirst\r\n'));
            await client.append('INBOX', Buffer.from('Subject: second\r\n\r\nsecond\r\n'));

            await client.mailboxOpen('INBOX');
            await client.search({ subject: 'second' }, { uid: true, returnOptions: ['SAVE'] } as any);

            let flagResult = await client.messageFlagsAdd('$', ['\\Flagged'], { uid: true });
            assert.ok(flagResult, 'STORE against the saved result must succeed');

            let messages: any = [];
            for await (let msg of client.fetch('$', { flags: true, envelope: true }, { uid: true })) {
                messages.push(msg);
            }
            assert.equal(messages.length, 1, 'the saved result references exactly the matched message');
            assert.equal(messages[0].envelope.subject, 'second');
            assert.ok(messages[0].flags.has('\\Flagged'), 'the flag change applied to the saved result');
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: MODSEQ search criterion surfaces modseq from the ESEARCH response', async () => {
        const client = await (connectClient as any)();
        try {
            await client.append('INBOX', Buffer.from('Subject: first\r\n\r\nfirst\r\n'));
            await client.append('INBOX', Buffer.from('Subject: second\r\n\r\nsecond\r\n'));

            await client.mailboxOpen('INBOX');
            // RFC 7162: a MODSEQ criterion on a CONDSTORE session makes the server
            // append MODSEQ to the ESEARCH response
            const result: any = await client.search({ modseq: 1 }, { returnOptions: ['ALL', 'COUNT'] });

            assert.equal((result as any).count, 2);
            assert.equal((result as any)!.all, '1:2');
            assert.ok(typeof (result as any)!.modseq === 'bigint' && (result as any)!.modseq > 0n, 'modseq should surface as a positive BigInt');
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: STATUS reports SIZE and DELETED', async () => {
        const logs: any = [];
        const client: any = await connectClient(null, logs);
        try {
            const raw = Buffer.from('Subject: sized\r\n\r\nsized body\r\n');
            await client.append('INBOX', raw, ['\\Deleted']);
            await client.append('INBOX', Buffer.from('Subject: kept\r\n\r\nkept body\r\n'));

            const status: any = await client.status('INBOX', { messages: true, size: true, deleted: true });

            assert.ok(clientSent(logs, 'SIZE'), 'STATUS should request SIZE');
            assert.ok(clientSent(logs, 'DELETED'), 'STATUS should request DELETED');
            assert.equal(status.messages, 2);
            assert.equal(status.deleted, 1, 'one message carries the \\Deleted flag');
            assert.ok(Number.isSafeInteger(status.size) && status.size >= raw.length, 'mailbox size should cover at least the first appended message');
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: statusQuery returns SIZE and DELETED inline via LIST-STATUS', async () => {
        const client = await (connectClient as any)();
        try {
            await client.append('INBOX', Buffer.from('Subject: probe\r\n\r\nprobe body\r\n'), ['\\Deleted']);

            const folders = await client.list({ statusQuery: { messages: true, size: true, deleted: true } });
            const inbox: any = folders.find((folder: any) => folder.path === 'INBOX');
            assert.equal(inbox.status!.messages, 1);
            assert.equal(inbox!.status!.deleted, 1);
            assert.ok(Number.isSafeInteger(inbox!.status!.size) && inbox!.status!.size! > 0);
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: SELECT response carries an untagged LIST and re-select gets CLOSED', async () => {
        const logs: any = [];
        const client: any = await connectClient(null, logs);
        try {
            await client.mailboxCreate('Closer');
            const mailbox = await client.mailboxOpen('INBOX');
            assert.equal(mailbox.path, 'INBOX');

            // RFC 9051 6.3.1: the SELECT response includes an untagged LIST for the
            // selected mailbox - the client must consume it without issue. Scoped to
            // the SELECT exchange itself: mailboxOpen() also issues its own LIST
            // command first, whose untagged replies would satisfy a global check
            // even if the SELECT response omitted the LIST
            const lines: any = wireLines(logs);
            const selectIdx = lines.findIndex((entry: any) => entry.src === 'c' && /^\S+ SELECT /.test(entry.msg));
            assert.ok(selectIdx >= 0, 'SELECT command should be on the wire');
            const selectTag = lines[selectIdx].msg.split(' ')[0];
            const doneIdx = lines.findIndex((entry: any, i: any) => i > selectIdx && entry.src === 's' && entry.msg.startsWith(`${selectTag} `));
            const listInSelect = lines.some((entry: any, i: any) => i > selectIdx && i < doneIdx && entry.src === 's' && /^\* LIST( |$)/.test(entry.msg));
            assert.ok(listInSelect, 'rev2 SELECT response should include an untagged LIST response');

            // switching mailboxes must produce a CLOSED response code for the old one
            await client.mailboxOpen('Closer');
            const closed: any = wireLines(logs).some((entry: any) => entry.src === 's' && entry.msg.includes('[CLOSED]'));
            assert.ok(closed, 're-select should carry a CLOSED response code');
            assert.equal((client.mailbox as any).path, 'Closer', 'client state should track the newly selected mailbox');

            await client.mailboxClose();
            await client.mailboxDelete('Closer');
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: binary fetch uses the folded-in FETCH BINARY', async () => {
        const logs: any = [];
        const client: any = await connectClient(null, logs);
        try {
            // BINARY sections only allow numeric part specifiers, so use a multipart
            // message - part "1" of a single-part message would resolve to the TEXT
            // section, which must stay a BODY fetch. The base64 encoding gives the
            // server-side BINARY decoding something to undo.
            const content = [
                'Subject: bin',
                'MIME-Version: 1.0',
                'Content-Type: multipart/mixed; boundary=bb',
                '',
                '--bb',
                'Content-Type: text/plain',
                'Content-Transfer-Encoding: base64',
                '',
                Buffer.from('binary body').toString('base64'),
                '--bb--',
                ''
            ].join('\r\n');
            await client.append('INBOX', Buffer.from(content));

            await client.mailboxOpen('INBOX');
            const { content: downloadStream }: any = await client.download('1', '1', { binary: true } as any);
            const chunks = [];
            for await (let chunk of downloadStream) {
                chunks.push(chunk);
            }

            assert.ok(clientSent(logs, 'BINARY.PEEK[1]'), 'client should issue a BINARY fetch for the numeric part on a rev2 session');
            assert.equal(Buffer.concat(chunks).toString().trim(), 'binary body', 'BINARY fetch should return the decoded content');
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: MOVE reports COPYUID from the untagged OK', async () => {
        const client = await (connectClient as any)();
        try {
            await client.append('INBOX', Buffer.from('Subject: mover\r\n\r\nmover body\r\n'));
            await client.mailboxCreate('Moved');

            await client.mailboxOpen('INBOX');
            const result = await client.messageMove('1', 'Moved');

            // RFC 9051 6.4.8: the server is REQUIRED to send COPYUID in an untagged OK
            // before the EXPUNGEs - verify the client captured it
            assert.ok(result, 'move should succeed');
            assert.equal(result.path, 'INBOX');
            assert.equal(result.destination, 'Moved');
            assert.ok(result.uidMap && result.uidMap.size === 1, 'COPYUID must be captured from the untagged OK');

            await client.mailboxClose();
            await client.mailboxDelete('Moved');
        } finally {
            await client.logout();
        }
    });
    it('Live rev2: message lifecycle smoke test', async () => {
        const client = await (connectClient as any)();
        try {
            await client.append('INBOX', Buffer.from('Subject: smoke\r\n\r\nsmoke body\r\n'), ['\\Seen']);

            await client.mailboxOpen('INBOX');
            const message: any = await client.fetchOne('1', { envelope: true, flags: true, uid: true });
            assert.equal((message as any).envelope.subject, 'smoke');
            assert.ok((message as any)!.flags.has('\\Seen'));

            await client.mailboxCreate('Smoke');
            await client.messageCopy('1', 'Smoke');
            await client.messageMove('1', 'Smoke');

            const status = await client.status('Smoke', { messages: true });
            assert.equal(status.messages, 2, 'copy plus move should land two messages');

            // uid expunge - UIDPLUS is folded into base rev2, so only the requested
            // message may disappear
            await client.mailboxOpen('Smoke');
            const first: any = await client.fetchOne('1', { uid: true });
            await client.messageDelete(`${(first as any).uid}`, { uid: true });
            const statusAfter = await client.status('Smoke', { messages: true });
            assert.equal(statusAfter.messages, 1, 'UID EXPUNGE must remove only the targeted message');

            await client.mailboxClose();
            await client.mailboxRename('Smoke', 'Smoke2');
            await client.mailboxDelete('Smoke2');
        } finally {
            await client.logout();
        }
    });
});
