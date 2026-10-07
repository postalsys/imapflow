import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_PLUGINS, flagList, rfc822, startImapKit } from '../fixtures/imapkit.js';

// The same mailbox and message workflow against servers with very different capability sets, from a
// bare RFC 3501 server to one with every extension ImapKit has. Each profile pushes ImapFlow down a
// different code path (MOVE or COPY + EXPUNGE, ESEARCH or SEARCH, LIST-STATUS or STATUS, synchronizing
// or non-synchronizing literals, ENABLE or not) and ImapKit answers any syntax error with BAD, which
// fails the test.

const PROFILES: { name: string; plugins: string[]; client?: Record<string, any> }[] = [
    { name: 'bare IMAP4rev1', plugins: [] },
    { name: 'IMAP4rev1 with LITERAL-', plugins: ['LITERALMINUS'] },
    { name: 'IMAP4rev1 with LITERAL+', plugins: ['LITERALPLUS'] },
    { name: 'IMAP4rev1 with UIDPLUS, no MOVE', plugins: ['UIDPLUS', 'SPECIAL-USE'] },
    { name: 'IMAP4rev1 with MOVE, no UIDPLUS', plugins: ['MOVE', 'SPECIAL-USE'] },
    {
        name: 'typical IMAP4rev1 server',
        plugins: [
            'ID',
            'IDLE',
            'NAMESPACE',
            'UNSELECT',
            'UIDPLUS',
            'MOVE',
            'SPECIAL-USE',
            'ENABLE',
            'CONDSTORE',
            'LITERALPLUS',
            'ESEARCH',
            'SASL-IR',
            'AUTH-PLAIN'
        ]
    },
    { name: 'IMAP4rev2', plugins: ['IMAP4rev2'] },
    { name: 'IMAP4rev2 with disableIMAP4rev2', plugins: ['IMAP4rev2'], client: { disableIMAP4rev2: true } },
    { name: 'IMAP4rev2 with UTF8=ACCEPT and QRESYNC', plugins: ['IMAP4rev2', 'UTF8=ACCEPT', 'QRESYNC'] },
    { name: 'every plugin', plugins: ALL_PLUGINS },
    { name: 'every plugin, QRESYNC enabled', plugins: ALL_PLUGINS, client: { qresync: true } },
    { name: 'every plugin, compression and BINARY off', plugins: ALL_PLUGINS, client: { disableCompression: true, disableBinary: true } },
    { name: 'every plugin, no auto ENABLE', plugins: ALL_PLUGINS, client: { disableAutoEnable: true } }
];

// Larger than the 4096 octets LITERAL- allows for a non-synchronizing literal
const LARGE_BODY = 'Lorem ipsum dolor sit amet. '.repeat(400);

describe('imapkit: capability matrix', () => {
    for (const profile of PROFILES) {
        it(`mailbox and message workflow (${profile.name})`, async t => {
            const kit = await startImapKit(t, { server: { plugins: profile.plugins } });
            const client = await kit.connect(profile.client || {});

            // mailbox management
            let folders = await client.list();
            const paths = folders.map((folder: any) => folder.path);
            for (const path of ['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive']) {
                assert.ok(paths.includes(path), `${path} listed in ${JSON.stringify(paths)}`);
            }
            assert.equal(folders.find((folder: any) => folder.path === 'Sent').specialUse, '\\Sent');

            await client.mailboxCreate(['Work', 'Projects']);
            await client.mailboxRename('Work/Projects', 'Work/Done');
            await client.mailboxSubscribe('Work/Done');
            folders = await client.list();
            const done = folders.find((folder: any) => folder.path === 'Work/Done');
            assert.ok(done, 'renamed mailbox listed');
            assert.equal(done.subscribed, true);
            assert.ok(!folders.some((folder: any) => folder.path === 'Work/Projects'), 'old name gone');

            const tree = await client.listTree();
            const work = tree.folders.find((folder: any) => folder.path === 'Work');
            assert.ok(work && work.folders.some((folder: any) => folder.path === 'Work/Done'), 'tree nests Work/Done under Work');

            // append: plain, 8-bit body, a literal over the LITERAL- limit, flags and internal date
            const first = await client.append('INBOX', rfc822('first message'), ['\\Seen'], new Date('2025-10-01T12:00:00Z'));
            await client.append('INBOX', rfc822('second message', 'Tere, õun ja äädikas'), ['\\Flagged', 'Custom1']);
            await client.append('INBOX', rfc822('third message', LARGE_BODY));
            assert.equal(first.destination, 'INBOX');

            const status = await client.status('INBOX', { messages: true, unseen: true, uidNext: true, uidValidity: true });
            assert.equal(status.messages, 3);
            assert.equal(status.unseen, 2);
            assert.equal(status.uidNext, 4);

            const listed = await client.list({ statusQuery: { messages: true, unseen: true } });
            assert.equal(listed.find((folder: any) => folder.path === 'INBOX').status.messages, 3);

            // select and fetch
            const mailbox = await client.mailboxOpen('INBOX');
            assert.equal(mailbox.exists, 3);
            assert.equal(mailbox.uidNext, 4);

            const messages = await client.fetchAll('1:*', {
                uid: true,
                flags: true,
                envelope: true,
                bodyStructure: true,
                size: true,
                internalDate: true
            });
            assert.deepEqual(
                messages.map((message: any) => message.envelope.subject),
                ['first message', 'second message', 'third message']
            );
            assert.deepEqual(messages[0].envelope.from, [{ name: 'Sender', address: 'sender@example.com' }]);
            assert.equal(messages[0].internalDate.toISOString(), '2025-10-01T12:00:00.000Z');
            assert.ok(messages[0].flags.has('\\Seen'));
            assert.ok(messages[1].flags.has('\\Flagged') && messages[1].flags.has('Custom1'));
            assert.equal(messages[0].bodyStructure.type, 'text/plain');
            assert.ok(messages[2].size > LARGE_BODY.length);

            const second = await client.fetchOne('2', { source: true, headers: ['subject'], bodyParts: ['1'] });
            assert.match(second.source.toString(), /Subject: second message/);
            assert.match(second.headers.toString(), /^Subject: second message/);
            assert.match(Buffer.from(second.bodyParts.get('1')).toString(), /õun ja äädikas/);

            const { content } = await client.download('3', '1');
            assert.equal(
                Buffer.concat(await content.toArray())
                    .toString()
                    .trim(),
                LARGE_BODY.trim()
            );

            // search
            assert.deepEqual(await client.search({ seen: false }), [2, 3]);
            assert.deepEqual(await client.search({ subject: 'second' }), [2]);
            assert.deepEqual(await client.search({ or: [{ flagged: true }, { seen: true }] }), [1, 2]);
            assert.deepEqual(await client.search({ keyword: 'Custom1' }, { uid: true }), [2]);
            assert.deepEqual(await client.search({ since: new Date('2020-01-01'), body: 'Lorem' }), [3]);
            assert.deepEqual(await client.search({ uid: '2:3', not: { flagged: true } }), [3]);

            // flags
            assert.equal(await client.messageFlagsAdd('3', ['\\Answered', 'Custom2']), true);
            assert.equal(await client.messageFlagsRemove('2', ['Custom1']), true);
            assert.equal(await client.messageFlagsSet({ uid: '1' }, ['\\Seen', '\\Draft'], { uid: true }), true);
            const flags = (await client.fetchAll('1:*', { flags: true })).map((message: any) => flagList(message.flags));
            assert.deepEqual(flags, [['\\Draft', '\\Seen'], ['\\Flagged'], ['Custom2', '\\Answered']]);

            // copy, move and delete
            const copied = await client.messageCopy('1:2', 'Work/Done');
            assert.equal(copied.destination, 'Work/Done');
            const moved = await client.messageMove('1', 'Archive');
            assert.equal(moved.destination, 'Archive');
            // with QRESYNC the expunge comes as VANISHED, which must update the count as well
            assert.equal(client.mailbox.exists, 2, 'moved message is gone from INBOX');
            assert.equal((await client.search({ all: true })).length, 2, 'moved message is gone from INBOX');

            // the remaining messages must survive a delete of another one, also without UIDPLUS
            assert.equal(await client.messageDelete({ uid: '3' }, { uid: true }), true);
            const remaining = await client.fetchAll('1:*', { envelope: true });
            assert.deepEqual(
                remaining.map((message: any) => message.envelope.subject),
                ['second message']
            );

            assert.equal((await client.status('Work/Done', { messages: true })).messages, 2);
            assert.equal((await client.status('Archive', { messages: true })).messages, 1);

            await client.mailboxClose();
            await client.mailboxDelete('Work/Done');
            assert.ok(!(await client.list()).some((folder: any) => folder.path === 'Work/Done'));

            await client.logout();
        });
    }
});
