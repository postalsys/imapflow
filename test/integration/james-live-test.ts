import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { buffer as collect } from 'node:stream/consumers';
import { ImapFlow } from '../../src/imap-flow.js';
import type { ImapFlowOptions } from '../../src/types.js';

// Live integration tests against Apache James (the in-memory distribution in Docker).
// Started via `npm run test:james` (see run-james-tests.sh) - excluded from the `npm test`
// file list so plain test runs stay Docker-free.
//
// James is the base of several hosted mail services (Twake Mail among them) and differs from
// Dovecot in ways mocks do not show, so these tests drive the public API end to end. Every
// test gets a fresh user, created through the WebAdmin API.

const HOST = process.env.IMAPFLOW_TEST_HOST || '127.0.0.1';
const PORT = Number(process.env.IMAPFLOW_TEST_PORT) || 31144;
const WEBADMIN = process.env.IMAPFLOW_JAMES_WEBADMIN || 'http://127.0.0.1:31180';
const WEBADMIN_PASSWORD = process.env.IMAPFLOW_JAMES_WEBADMIN_PASSWORD || 'imapflow-test';
const DOMAIN = 'example.com';
const PASSWORD = 'pass';

const webadmin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(WEBADMIN + path, {
        method,
        headers: { Password: WEBADMIN_PASSWORD, 'Content-Type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body)
    });
    if (!res.ok) {
        throw new Error(`WebAdmin ${method} ${path} failed with ${res.status}: ${await res.text()}`);
    }
};

let userCounter = 0;

const createUser = async (): Promise<string> => {
    const user = `livetest-${Date.now()}-${++userCounter}@${DOMAIN}`;
    await webadmin('PUT', `/users/${user}`, { password: PASSWORD });
    return user;
};

const connectClient = async (options?: Partial<ImapFlowOptions> | null, logs?: any[], user?: string) => {
    const client = new ImapFlow(
        Object.assign(
            {
                host: HOST,
                port: PORT,
                secure: false,
                // James advertises LOGINDISABLED until the STARTTLS upgrade, self-signed cert
                tls: { rejectUnauthorized: false },
                auth: { user: user || (await createUser()), pass: PASSWORD },
                logger: false as const,
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

const base64Lines = (data: Buffer) => data.toString('base64').replace(/.{76}/g, '$&\r\n');

// Random bytes, so a part that is cut short or decoded twice can not match by accident
const ATTACHMENT = Buffer.from(Array.from({ length: 200 * 1024 }, (_, i) => (i * 7919 + Math.floor(i / 256)) % 256));
const TEXT_BODY = 'Caf\u00e9 cr\u00e8me \u2013 line one\r\nline two with a long tail '.repeat(40) + 'end';

const MULTIPART = [
    'From: Sender <sender@example.com>',
    'To: Receiver <receiver@example.com>',
    'Subject: =?UTF-8?Q?Caf=C3=A9_report?=',
    'Message-ID: <multipart-1@example.com>',
    'Date: Wed, 07 Oct 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    // quoted-printable, soft line breaks keep every line short
    Buffer.from(TEXT_BODY)
        .toString('latin1')
        .replace(/[^\x20-\x7e\r\n]|=/g, c => '=' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
        .replace(/[^\r\n]{70}/g, '$&=\r\n'),
    '--outer',
    'Content-Type: application/octet-stream; name="data.bin"',
    'Content-Disposition: attachment; filename="data.bin"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(ATTACHMENT),
    '--outer',
    'Content-Type: message/rfc822',
    '',
    'From: inner@example.com',
    'Subject: inner',
    'Content-Type: text/plain',
    '',
    'inner body',
    '--outer--',
    ''
].join('\r\n');

describe('james-live', () => {
    before(async () => {
        await webadmin('PUT', `/domains/${DOMAIN}`);
    });

    it('Live James: STARTTLS session with SASL PLAIN', async () => {
        const client = await connectClient();
        try {
            assert.ok(client.secureConnection && client.tls, 'the session should have been upgraded with STARTTLS');
            assert.ok(client.authenticated);
            assert.ok(client.capabilities.has('IMAP4rev1'));
            assert.ok(!client.capabilities.has('LOGINDISABLED'), 'the post-TLS capability list replaced the cleartext one');
            assert.equal(client.namespace?.delimiter, '.');
        } finally {
            await client.logout();
        }
    });

    it('Live James: download() and downloadMany() return the full parts (combined MIME + content fetch)', async () => {
        const client = await connectClient();
        try {
            const appended = await client.append('INBOX', MULTIPART);
            assert.ok(appended && appended.uid);
            const uid = String(appended.uid);
            await client.mailboxOpen('INBOX');

            for (const chunkSize of [undefined, 1000]) {
                const options = chunkSize ? { uid: true, chunkSize } : { uid: true };

                const attachment = await client.download(uid, '2', options);
                assert.equal(attachment.meta?.filename, 'data.bin');
                assert.equal(attachment.meta?.encoding, 'base64');
                assert.ok((await collect(attachment.content!)).equals(ATTACHMENT), `attachment content (chunkSize ${chunkSize})`);

                const text = await client.download(uid, '1', options);
                assert.equal(text.meta?.contentType, 'text/plain');
                assert.equal(text.meta?.charset, 'utf-8');
                assert.equal((await collect(text.content!)).toString(), TEXT_BODY, `text content (chunkSize ${chunkSize})`);
            }

            const inner = await client.download(uid, '3', { uid: true });
            assert.equal(inner.meta?.contentType, 'message/rfc822');
            assert.match((await collect(inner.content!)).toString(), /Subject: inner[\s\S]*inner body/);

            const parts = await client.downloadMany(uid, ['1', '2'], { uid: true });
            assert.equal(parts['1']?.content?.toString(), TEXT_BODY);
            assert.ok(parts['2']?.content?.equals(ATTACHMENT));
            assert.equal(parts['2']?.meta?.filename, 'data.bin');

            const source = await client.download(uid, undefined, { uid: true, chunkSize: 4096 });
            assert.equal((await collect(source.content!)).toString(), MULTIPART);
        } finally {
            await client.logout();
        }
    });

    it('Live James: download() of a single part message', async () => {
        const client = await connectClient();
        try {
            await client.append('INBOX', 'Subject: single\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nsingle part body\r\n');
            await client.mailboxOpen('INBOX');
            const download = await client.download('1', '1');
            assert.equal(download.meta?.contentType, 'text/plain');
            assert.equal((await collect(download.content!)).toString(), 'single part body\r\n');
        } finally {
            await client.logout();
        }
    });

    it('Live James: fetch returns envelope, body structure and metadata', async () => {
        const client = await connectClient();
        try {
            const date = new Date('2026-01-02T03:04:05Z');
            await client.append('INBOX', MULTIPART, ['\\Flagged', '$Custom'], date);
            await client.mailboxOpen('INBOX');
            const message = await client.fetchOne('*', {
                uid: true,
                flags: true,
                envelope: true,
                bodyStructure: true,
                internalDate: true,
                size: true,
                headers: ['subject', 'message-id']
            });
            assert.ok(message);
            assert.equal(message.envelope?.subject, 'Caf\u00e9 report');
            assert.equal(message.envelope?.messageId, '<multipart-1@example.com>');
            assert.deepEqual(message.envelope?.from, [{ name: 'Sender', address: 'sender@example.com' }]);
            assert.ok(message.flags?.has('\\Flagged'));
            assert.ok(message.flags?.has('$Custom'));
            assert.equal((message.internalDate as Date).getTime(), date.getTime());
            assert.equal(message.size, Buffer.byteLength(MULTIPART));
            assert.ok(message.emailId, 'OBJECTID gives an EMAILID');
            assert.match(message.headers!.toString(), /Message-ID: <multipart-1@example.com>/i);

            const structure = message.bodyStructure!;
            assert.equal(structure.type, 'multipart/mixed');
            assert.deepEqual(
                structure.childNodes!.map(node => [node.part, node.type]),
                [
                    ['1', 'text/plain'],
                    ['2', 'application/octet-stream'],
                    ['3', 'message/rfc822']
                ]
            );
            assert.equal(structure.childNodes![1]!.dispositionParameters?.filename, 'data.bin');

            const all = await client.fetchAll('1:*', { uid: true, source: true });
            assert.equal(all.length, 1);
            assert.equal(all[0]!.source!.toString(), MULTIPART);
        } finally {
            await client.logout();
        }
    });

    it('Live James: mailbox management', async () => {
        const client = await connectClient();
        try {
            const created = await client.mailboxCreate(['Projects', 'Sub']);
            assert.equal(created.path, 'Projects.Sub');
            await client.mailboxCreate('T\u00f5rva \u00f5un');

            let folders = await client.list();
            const paths = folders.map(folder => folder.path);
            assert.ok(paths.includes('INBOX'));
            assert.ok(paths.includes('Projects'));
            assert.ok(paths.includes('Projects.Sub'));
            assert.ok(paths.includes('T\u00f5rva \u00f5un'), 'non-ASCII mailbox name round-trips');
            assert.ok(folders.find(folder => folder.path === 'Projects')!.flags.has('\\HasChildren'));

            await client.mailboxSubscribe('Projects.Sub');
            folders = await client.list();
            assert.equal(folders.find(folder => folder.path === 'Projects.Sub')!.subscribed, true);
            await client.mailboxUnsubscribe('Projects.Sub');
            folders = await client.list();
            assert.ok(!folders.find(folder => folder.path === 'Projects.Sub')!.subscribed);

            const renamed = await client.mailboxRename('Projects.Sub', 'Projects.Renamed');
            assert.equal(renamed.newPath, 'Projects.Renamed');
            await client.mailboxDelete('Projects.Renamed');
            await client.mailboxDelete('T\u00f5rva \u00f5un');
            folders = await client.list();
            assert.ok(!folders.find(folder => folder.path === 'Projects.Renamed'));
            assert.ok(!folders.find(folder => folder.path === 'T\u00f5rva \u00f5un'));

            const tree = await client.listTree();
            assert.ok(tree.folders?.find(folder => folder.path === 'Projects'));
        } finally {
            await client.logout();
        }
    });

    it('Live James: default special-use mailboxes', async () => {
        const client = await connectClient();
        try {
            const folders = await client.list();
            const specialUse = Object.fromEntries(folders.filter(folder => folder.specialUse).map(folder => [folder.specialUse, folder.path]));
            assert.deepEqual(specialUse, {
                '\\Inbox': 'INBOX',
                '\\Archive': 'Archive',
                '\\Drafts': 'Drafts',
                '\\Sent': 'Sent',
                '\\Junk': 'Spam',
                '\\Trash': 'Trash'
            });
            for (const folder of folders) {
                assert.equal(folder.subscribed, true, `${folder.path} is subscribed`);
                assert.ok(!folder.flags.has('\\Subscribed'), '\\Subscribed is folded into the subscribed property');
            }
        } finally {
            await client.logout();
        }
    });

    it('Live James: status and inline LIST-STATUS', async () => {
        const client = await connectClient();
        try {
            await client.append('INBOX', 'Subject: one\r\n\r\nbody one\r\n', ['\\Seen']);
            await client.append('INBOX', 'Subject: two\r\n\r\nbody two\r\n');
            const status: any = await client.status('INBOX', { messages: true, unseen: true, uidNext: true, uidValidity: true, size: true });
            assert.equal(status.messages, 2);
            assert.equal(status.unseen, 1);
            assert.equal(status.uidNext, 3);
            assert.ok(status.uidValidity);
            assert.ok(Number(status.size) > 0);

            const folders = await client.list({ statusQuery: { messages: true, unseen: true } });
            const inbox = folders.find(folder => folder.path === 'INBOX');
            assert.equal(inbox?.status?.messages, 2);
            assert.equal(inbox?.status?.unseen, 1);
        } finally {
            await client.logout();
        }
    });

    it('Live James: search', async () => {
        const client = await connectClient();
        try {
            await client.append('INBOX', 'From: alice@example.com\r\nSubject: =?UTF-8?Q?R=C3=A9servation?=\r\n\r\nfirst needle body\r\n', ['\\Seen']);
            await client.append('INBOX', 'From: bob@example.com\r\nSubject: second\r\n\r\nsecond body\r\n');
            await client.append('INBOX', 'From: carol@example.com\r\nSubject: third\r\n\r\nthird body ' + 'x'.repeat(5000) + '\r\n', ['\\Flagged']);
            await client.mailboxOpen('INBOX');

            assert.deepEqual(await client.search({ seen: false }), [2, 3]);
            assert.deepEqual(await client.search({ from: 'bob@example.com' }), [2]);
            assert.deepEqual(await client.search({ subject: 'r\u00e9servation' }), [1], 'non-ASCII value sent as a literal');
            assert.deepEqual(await client.search({ body: 'needle' }), [1]);
            assert.deepEqual(await client.search({ larger: 4000 }), [3]);
            assert.deepEqual(await client.search({ flagged: true }), [3]);
            assert.deepEqual(await client.search({ or: [{ from: 'alice@example.com' }, { flagged: true }] }), [1, 3]);
            assert.deepEqual(await client.search({ uid: '2:*' }, { uid: true }), [2, 3]);
            assert.deepEqual(await client.search({ since: new Date('2000-01-01') }), [1, 2, 3]);
            assert.deepEqual(await client.search({ header: { subject: 'third' } }), [3]);
        } finally {
            await client.logout();
        }
    });

    it('Live James: flags and CONDSTORE through QRESYNC', async () => {
        // James advertises QRESYNC without CONDSTORE and ignores a lone ENABLE CONDSTORE, so
        // modseq tracking needs ENABLE QRESYNC, which implies CONDSTORE (RFC 7162 3.2.3)
        const client = await connectClient({ qresync: true });
        try {
            await client.append('INBOX', 'Subject: flags\r\n\r\nbody\r\n');
            const mailbox = await client.mailboxOpen('INBOX');
            assert.ok(client.enabled.has('CONDSTORE'), 'ENABLE QRESYNC enabled CONDSTORE as well');
            assert.ok(mailbox.highestModseq, 'CONDSTORE through QRESYNC reports HIGHESTMODSEQ');
            const before = BigInt(mailbox.highestModseq!);

            assert.equal(await client.messageFlagsAdd('1', ['\\Seen', '$Label']), true);
            let message = await client.fetchOne('1', { flags: true });
            assert.ok(message && message.flags?.has('\\Seen') && message.flags.has('$Label'));

            await client.messageFlagsRemove('1', ['$Label']);
            message = await client.fetchOne('1', { flags: true });
            assert.ok(message && !message.flags?.has('$Label'));

            await client.messageFlagsSet('1', ['\\Answered']);
            message = await client.fetchOne('1', { flags: true, uid: true });
            assert.ok(message);
            // James also reports \Recent, which IMAP4rev1 allows
            assert.deepEqual(
                [...message.flags!].filter(flag => flag !== '\\Recent'),
                ['\\Answered']
            );

            const changed = await client.fetchAll('1:*', { flags: true }, { changedSince: before });
            assert.equal(changed.length, 1);
            assert.ok(BigInt(changed[0]!.modseq!) > before);
        } finally {
            await client.logout();
        }
    });

    it('Live James: copy, move and delete with UIDPLUS', async () => {
        const client = await connectClient();
        try {
            await client.mailboxCreate('Saved');
            await client.append('INBOX', 'Subject: one\r\n\r\nbody\r\n');
            await client.append('INBOX', 'Subject: two\r\n\r\nbody\r\n');
            await client.mailboxOpen('INBOX');

            const copied = await client.messageCopy('1', 'Saved');
            assert.ok(copied && copied.uidMap?.size === 1, 'COPYUID gives a UID map');

            const moved = await client.messageMove('2', 'Saved');
            assert.ok(moved && moved.uidMap?.size === 1, 'MOVE gives a UID map');
            assert.equal(client.mailbox && client.mailbox.exists, 1);

            assert.equal(await client.messageDelete('1'), true);
            assert.equal(client.mailbox && client.mailbox.exists, 0);

            const archive: any = await client.status('Saved', { messages: true });
            assert.equal(archive.messages, 2);
        } finally {
            await client.logout();
        }
    });

    it('Live James: IDLE reports a message another session appends', async () => {
        const user = await createUser();
        const client = await connectClient(null, undefined, user);
        const other = await connectClient(null, undefined, user);
        try {
            await client.mailboxOpen('INBOX');
            const exists = once(client, 'exists');
            const idle = client.idle();
            await other.append('INBOX', 'Subject: idle\r\n\r\nbody\r\n');
            const [event] = await exists;
            assert.equal(event.count, 1);
            await client.messageFlagsAdd('1', ['\\Seen']);
            await idle;
        } finally {
            await other.logout();
            await client.logout();
        }
    });

    it('Live James: QRESYNC reports expunges as VANISHED', async () => {
        const user = await createUser();
        const client = await connectClient({ qresync: true }, undefined, user);
        const other = await connectClient(null, undefined, user);
        try {
            await other.append('INBOX', 'Subject: one\r\n\r\nbody\r\n');
            await other.append('INBOX', 'Subject: two\r\n\r\nbody\r\n');
            await client.mailboxOpen('INBOX');
            assert.ok(client.enabled.has('QRESYNC'));

            const expunged = once(client, 'expunge');
            await other.mailboxOpen('INBOX');
            await other.messageDelete('1', { uid: true });
            await client.noop();
            const [event] = await expunged;
            assert.equal(event.uid, 1);
            assert.equal(event.vanished, true);
        } finally {
            await other.logout();
            await client.logout();
        }
    });

    it('Live James: quota', async () => {
        const user = await createUser();
        // without a limit James answers GETQUOTA with no QUOTA response at all
        await webadmin('PUT', `/quota/users/${user}/size`, 1024 * 1024);
        await webadmin('PUT', `/quota/users/${user}/count`, 100);
        const client = await connectClient(null, undefined, user);
        try {
            await client.append('INBOX', 'Subject: quota\r\n\r\nbody\r\n');
            const quota: any = await client.getQuota('INBOX');
            assert.ok(quota, 'QUOTA is advertised');
            // storage is counted in KiB, so one small message rounds down to 0
            assert.ok(quota.storage);
            assert.equal(quota.storage.limit, 1024 * 1024);
            assert.equal(quota.message?.usage, 1);
            assert.equal(quota.message?.limit, 100);
        } finally {
            await client.logout();
        }
    });
});
