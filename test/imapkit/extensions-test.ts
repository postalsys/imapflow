import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_PLUGINS, rfc822, startImapKit } from '../fixtures/imapkit.js';

// Extensions that neither Dovecot nor James in the Docker suites offer, or not in the combination
// a case needs: Gmail's X-GM-EXT-1, OBJECTID, QUOTA with tight limits, APPENDLIMIT, BINARY with
// encodings, UTF8=ACCEPT and the CONDSTORE/QRESYNC sync paths.

const GMAIL_STORAGE = {
    INBOX: {
        messages: [
            { raw: rfc822('gmail one'), flags: ['\\Seen'] },
            { raw: rfc822('gmail two', 'Hello', 'In-Reply-To: <gmailone@example.com>\r\nReferences: <gmailone@example.com>\r\n') }
        ]
    },
    '': {
        separator: '/',
        folders: {
            '[Gmail]': {
                flags: ['\\Noselect'],
                folders: {
                    'All Mail': { 'special-use': '\\All' },
                    Drafts: { 'special-use': '\\Drafts' },
                    Important: { 'special-use': '\\Important' },
                    'Sent Mail': { 'special-use': '\\Sent' },
                    Spam: { 'special-use': '\\Junk' },
                    Starred: { 'special-use': '\\Flagged' },
                    Trash: { 'special-use': '\\Trash' }
                }
            },
            Work: {},
            'Project X': {},
            'Õun ja pirn': {}
        }
    }
};

const GMAIL_PLUGINS = [
    'X-GM-EXT-1',
    'SPECIAL-USE',
    'UIDPLUS',
    'MOVE',
    'IDLE',
    'NAMESPACE',
    'ID',
    'UNSELECT',
    'CONDSTORE',
    'ENABLE',
    'AUTH-PLAIN',
    'SASL-IR',
    'XOAUTH2'
];

const startGmail = (t: any) => startImapKit(t, { server: { plugins: GMAIL_PLUGINS, storage: GMAIL_STORAGE } });

describe('imapkit: Gmail X-GM-EXT-1', () => {
    it('lists the Gmail tree with special-use folders', async t => {
        const kit = await startGmail(t);
        const client = await kit.connect();
        const folders = await client.list();
        const byUse = (use: string) => folders.find((folder: any) => folder.specialUse === use)?.path;
        assert.equal(byUse('\\All'), '[Gmail]/All Mail');
        assert.equal(byUse('\\Sent'), '[Gmail]/Sent Mail');
        assert.equal(byUse('\\Junk'), '[Gmail]/Spam');
        assert.equal(byUse('\\Trash'), '[Gmail]/Trash');
        assert.ok(folders.find((folder: any) => folder.path === '[Gmail]').flags.has('\\Noselect'));
        await client.logout();
    });

    it('labels can be added, removed and replaced', async t => {
        const kit = await startGmail(t);
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');

        const labelsOf = async (seq: string) => [...(await client.fetchOne(seq, { labels: true })).labels].sort();

        assert.deepEqual(await labelsOf('1'), ['\\Inbox']);
        assert.equal(await client.messageFlagsAdd('1', ['Work', 'Project X', '\\Important'], { useLabels: true }), true);
        assert.deepEqual(await labelsOf('1'), ['Project X', 'Work', '\\Important', '\\Inbox'].sort());

        assert.equal(await client.messageFlagsRemove('1', ['Work'], { useLabels: true }), true);
        assert.deepEqual(await labelsOf('1'), ['Project X', '\\Important', '\\Inbox'].sort());

        assert.equal(await client.messageFlagsSet('1', ['Work'], { useLabels: true }), true);
        assert.deepEqual(await labelsOf('1'), ['Work']);
        await client.logout();
    });

    it('non-ASCII labels are sent and read as modified UTF-7', async t => {
        const kit = await startGmail(t);
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        assert.equal(await client.messageFlagsAdd('1', ['Õun ja pirn'], { useLabels: true }), true);
        assert.ok(kit.sent('"&ANU-un ja pirn"'));
        assert.ok((await client.fetchOne('1', { labels: true })).labels.has('Õun ja pirn'));
    });

    it('message and thread ids from X-GM-MSGID and X-GM-THRID', async t => {
        const kit = await startGmail(t);
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        const messages = await client.fetchAll('1:*', { uid: true, threadId: true });
        assert.ok(kit.sent('X-GM-MSGID') && kit.sent('X-GM-THRID'));
        assert.ok(messages.every((message: any) => /^\d+$/.test(message.emailId) && /^\d+$/.test(message.threadId)));
        assert.notEqual(messages[0].emailId, messages[1].emailId);

        assert.deepEqual(await client.search({ emailId: messages[1].emailId }), [2]);
        assert.deepEqual(await client.search({ threadId: messages[0].threadId }), [1]);
        await client.logout();
    });

    it('gmraw and label search', async t => {
        const kit = await startGmail(t);
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        await client.messageFlagsAdd('2', ['Work'], { useLabels: true });

        assert.deepEqual(await client.search({ gmraw: 'subject:"gmail two"' }), [2]);
        assert.deepEqual(await client.search({ gmailraw: 'is:read' }), [1]);
        assert.deepEqual(await client.search({ labels: { has: ['Work'] } }), [2]);
        assert.deepEqual(await client.search({ labels: { not: ['Work'] } }), [1]);
        await client.logout();
    });

    it('OBJECTID is preferred over X-GM-MSGID when both are advertised', async t => {
        const kit = await startImapKit(t, { server: { plugins: [...GMAIL_PLUGINS, 'OBJECTID'], storage: GMAIL_STORAGE } });
        const client = await kit.connect();
        const mailbox = await client.mailboxOpen('INBOX');
        assert.ok(mailbox.mailboxId, 'MAILBOXID from SELECT');
        const messages = await client.fetchAll('1:*', { uid: true, threadId: true });
        assert.ok(kit.sent('EMAILID') && kit.sent('THREADID'));
        // the second message replies to the first one, so both share a thread
        assert.equal(messages[0].threadId, messages[1].threadId);
        assert.deepEqual(await client.search({ emailId: messages[1].emailId }), [2]);
        await client.logout();
    });
});

describe('imapkit: OBJECTID', () => {
    it('ids survive COPY and MOVE, and new mailboxes get one', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['OBJECTID', 'MOVE', 'UIDPLUS', 'SPECIAL-USE'] } });
        const client = await kit.connect();
        const created = await client.mailboxCreate('Projects');
        assert.ok(created.mailboxId, 'MAILBOXID from CREATE');
        await client.append('INBOX', rfc822('object id'));
        await client.mailboxOpen('INBOX');
        const original = await client.fetchOne('1', { uid: true, threadId: true });
        await client.messageMove('1', 'Projects');
        await client.mailboxOpen('Projects');
        const moved = await client.fetchOne('1', { uid: true, threadId: true });
        assert.equal(moved.emailId, original.emailId);
        assert.equal(moved.threadId, original.threadId);
        await client.logout();
    });
});

describe('imapkit: QUOTA and APPENDLIMIT', () => {
    it('getQuota reports usage and limits', async t => {
        const kit = await startImapKit(t, {
            server: { plugins: ['QUOTA'], quota: { root: 'User quota', STORAGE: 10, MESSAGE: 5 } }
        });
        const client = await kit.connect();
        await client.append('INBOX', rfc822('quota', 'x'.repeat(2000)));
        const quota = await client.getQuota('INBOX');
        assert.equal(quota.path, 'INBOX');
        assert.equal(quota.quotaRoot, 'User quota');
        assert.equal(quota.storage.limit, 10 * 1024);
        assert.ok(quota.storage.usage > 2000);
        assert.deepEqual(quota.message, { usage: 1, limit: 5, status: '20%' });
        await client.logout();
    });

    it('APPEND over the quota fails with OVERQUOTA', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['QUOTA'], quota: { MESSAGE: 1 } } });
        const client = await kit.connect();
        await client.append('INBOX', rfc822('first'));
        await assert.rejects(client.append('INBOX', rfc822('second')), (err: any) => {
            assert.equal(err.serverResponseCode, 'OVERQUOTA');
            return true;
        });
        assert.equal((await client.status('INBOX', { messages: true })).messages, 1);
        await client.logout();
    });

    it('APPENDLIMIT is checked before the message is sent', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['APPENDLIMIT'], appendLimit: 1000 } });
        const client = await kit.connect();
        await client.append('INBOX', rfc822('small'));
        await assert.rejects(client.append('INBOX', rfc822('large', 'x'.repeat(2000))), (err: any) => {
            assert.equal(err.serverResponseCode, 'APPENDLIMIT');
            return true;
        });
        assert.ok(!kit.sent(/APPEND INBOX .*large/), 'too large message never sent');
        await client.logout();
    });

    it('a per-mailbox APPENDLIMIT is refused by the server with TOOBIG', async t => {
        const kit = await startImapKit(t, {
            server: {
                plugins: ['APPENDLIMIT', 'STATUS=SIZE'],
                storage: { INBOX: { appendLimit: 500 }, '': { separator: '/', folders: { Big: { appendLimit: null } } } }
            }
        });
        const client = await kit.connect();
        await assert.rejects(client.append('INBOX', rfc822('large', 'x'.repeat(2000))), (err: any) => {
            assert.equal(err.serverResponseCode, 'TOOBIG');
            return true;
        });
        await client.append('Big', rfc822('large', 'x'.repeat(2000)));
        await client.logout();
    });
});

describe('imapkit: BINARY', () => {
    const ATTACHMENT = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256));
    // base64 in 76 character lines, as it is stored in the message
    const ATTACHMENT_BASE64 = ATTACHMENT.toString('base64').replace(/.{76}/g, '$&\r\n');
    const MULTIPART =
        'From: a@example.com\r\nSubject: binary\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n' +
        '--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nT=C3=A4na on p=C3=A4ikseline p=C3=A4ev\r\n' +
        `--b1\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="data.bin"\r\n\r\n${ATTACHMENT_BASE64}\r\n` +
        '--b1--\r\n';

    for (const plugins of [['BINARY'], ['IMAP4rev2'], []]) {
        it(`download() decodes parts (${plugins.join(',') || 'no BINARY'})`, async t => {
            const kit = await startImapKit(t, { server: { plugins, storage: { INBOX: { messages: [{ raw: MULTIPART }] } } } });
            const client = await kit.connect();
            await client.mailboxOpen('INBOX');

            const read = async (part: string) => {
                const { content, meta } = await client.download('1', part);
                return { data: Buffer.concat(await content.toArray()), meta };
            };
            const text = await read('1');
            assert.equal(text.data.toString().trim(), 'Täna on päikseline päev');
            const attachment = await read('2');
            assert.ok(attachment.data.equals(ATTACHMENT), 'attachment bytes match');
            assert.equal(attachment.meta.filename, 'data.bin');

            const fetched = await client.fetchOne('1', { bodyParts: ['2'] }, { binary: true });
            assert.ok(Buffer.from(fetched.bodyParts.get('2')).equals(plugins.length ? ATTACHMENT : Buffer.from(ATTACHMENT_BASE64)));
            await client.logout();
        });
    }
});

describe('imapkit: UTF-8 mailbox names', () => {
    for (const plugins of [[], ['ENABLE', 'UTF8=ACCEPT'], ['IMAP4rev2']]) {
        it(`create, list, select and rename (${plugins.join(',') || 'modified UTF-7'})`, async t => {
            const kit = await startImapKit(t, { server: { plugins: [...plugins, 'SPECIAL-USE'] } });
            const client = await kit.connect();
            const names = ['Õunad', 'Пример', '日本語/子', 'Tom & Jerry', 'a&b-c'];
            for (const name of names) {
                await client.mailboxCreate(name);
            }
            const paths = (await client.list()).map((folder: any) => folder.path);
            for (const name of names) {
                assert.ok(paths.includes(name), `${name} in ${JSON.stringify(paths)}`);
            }
            await client.append('Õunad', rfc822('apple'));
            const mailbox = await client.mailboxOpen('Õunad');
            assert.equal(mailbox.path, 'Õunad');
            assert.equal(mailbox.exists, 1);
            await client.mailboxClose();
            await client.mailboxRename('Õunad', 'Pirnid ja õunad');
            assert.equal((await client.status('Pirnid ja õunad', { messages: true })).messages, 1);
            if (!plugins.length) {
                assert.ok(kit.sent('&ANU-unad'), 'sent as modified UTF-7');
            }
            await client.logout();
        });
    }
});

describe('imapkit: CONDSTORE and QRESYNC', () => {
    it('changedSince fetch returns only the changed messages', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['CONDSTORE', 'ENABLE'] } });
        const client = await kit.connect();
        for (let i = 1; i <= 5; i++) {
            await client.append('INBOX', rfc822(`condstore ${i}`));
        }
        const mailbox = await client.mailboxOpen('INBOX');
        const modseq = mailbox.highestModseq;
        assert.equal(typeof modseq, 'bigint');
        await client.messageFlagsAdd('2,4', ['\\Flagged']);
        const changed = await client.fetchAll('1:*', { uid: true, flags: true }, { changedSince: modseq });
        assert.deepEqual(
            changed.map((message: any) => message.seq),
            [2, 4]
        );
        assert.ok(changed.every((message: any) => message.modseq > modseq));
        assert.ok(client.mailbox.highestModseq > modseq);
        await client.logout();
    });

    it('unchangedSince only stores unchanged messages', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['CONDSTORE', 'ENABLE'] } });
        const client = await kit.connect();
        await client.append('INBOX', rfc822('one'));
        await client.append('INBOX', rfc822('two'));
        const mailbox = await client.mailboxOpen('INBOX');
        const modseq = mailbox.highestModseq;
        await client.messageFlagsAdd('2', ['\\Seen']);
        // message 2 changed after modseq, so it must not be updated
        await client.messageFlagsAdd('1:2', ['\\Flagged'], { unchangedSince: modseq });
        const flags = (await client.fetchAll('1:*', { flags: true })).map((message: any) => message.flags.has('\\Flagged'));
        assert.deepEqual(flags, [true, false]);
        await client.logout();
    });

    it('QRESYNC SELECT reports what vanished while the client was away', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['QRESYNC', 'UIDPLUS'] } });
        const client = await kit.connect({ qresync: true });
        for (let i = 1; i <= 5; i++) {
            await client.append('INBOX', rfc822(`qresync ${i}`));
        }
        const first = await client.mailboxOpen('INBOX');
        const known = { uidValidity: first.uidValidity, highestModseq: first.highestModseq };
        await client.mailboxClose();

        // another session expunges and flags while the first one is not looking
        const other = await kit.connect();
        await other.mailboxOpen('INBOX');
        await other.messageDelete({ uid: '2,4' }, { uid: true });
        await other.messageFlagsAdd({ uid: '5' }, ['\\Seen'], { uid: true });
        await other.logout();

        const vanished: any[] = [];
        const flagUpdates: any[] = [];
        client.on('expunge', (event: any) => vanished.push(event));
        client.on('flags', (event: any) => flagUpdates.push(event));
        await client.mailboxOpen('INBOX', { changedSince: known.highestModseq, uidValidity: known.uidValidity });
        assert.ok(kit.sent(/SELECT INBOX \(QRESYNC \(\d+ \d+/), 'SELECT with QRESYNC parameters');
        assert.deepEqual(
            vanished.map(event => [event.uid, event.earlier]),
            [
                [2, true],
                [4, true]
            ]
        );
        assert.ok(flagUpdates.some(event => event.uid === 5 && event.flags.has('\\Seen')));
        await client.logout();
    });

    it('VANISHED from an EXPUNGE updates mailbox.exists', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['QRESYNC', 'UIDPLUS'] } });
        const client = await kit.connect({ qresync: true });
        for (let i = 1; i <= 3; i++) {
            await client.append('INBOX', rfc822(`vanished ${i}`));
        }
        await client.mailboxOpen('INBOX');
        await client.messageDelete('2');
        assert.ok(kit.received(/^\* VANISHED 2$/));
        assert.equal(client.mailbox.exists, 2);
    });
});

describe('imapkit: FETCH macros', () => {
    for (const macro of ['all', 'fast', 'full']) {
        it(`the ${macro.toUpperCase()} macro is expanded into its items`, async t => {
            const kit = await startImapKit(t, { server: { plugins: [] } });
            const client = await kit.connect();
            await client.append('INBOX', rfc822('macro'));
            await client.mailboxOpen('INBOX');
            const message = await client.fetchOne('1', { [macro]: true });
            assert.ok(message.flags && message.size && message.internalDate);
            assert.equal(!!message.envelope, macro !== 'fast');
            assert.equal(!!message.bodyStructure, macro === 'full');
        });
    }
});

describe('imapkit: every plugin at once', () => {
    it('a session with every extension sends no BAD', async t => {
        const kit = await startImapKit(t, { server: { plugins: ALL_PLUGINS } });
        const client = await kit.connect({ qresync: true });
        assert.ok(client.enabled.has('QRESYNC') && client.enabled.has('UTF8=ACCEPT') && client.enabled.has('IMAP4REV2'));
        await client.append('INBOX', rfc822('everything'), ['\\Seen', '$Forwarded']);
        await client.mailboxOpen('INBOX');
        await client.fetchAll('1:*', {
            flags: true,
            envelope: true,
            bodyStructure: true,
            size: true,
            threadId: true,
            labels: true,
            headers: true,
            bodyParts: ['1', '1.MIME', 'TEXT']
        });
        await client.search({ or: [{ header: { 'x-missing': '' } }, { larger: 1 }], sentSince: new Date('2020-01-01'), modseq: 1 }, { uid: true });
        await client.getQuota();
        await client.logout();
    });
});
