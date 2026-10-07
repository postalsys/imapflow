import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rfc822, startImapKit } from '../fixtures/imapkit.js';

// Mailbox states that are set up from the ImapKit storage object instead of through IMAP: UID
// gaps, UIDVALIDITY values at the edge of the 32-bit range, mailboxes that refuse new keywords,
// \Noselect levels, other namespaces and separators, empty mailboxes.

const PLUGINS = ['UIDPLUS', 'MOVE', 'SPECIAL-USE', 'NAMESPACE', 'LIST-EXTENDED', 'CONDSTORE', 'ENABLE'];

describe('imapkit: preloaded storage', () => {
    it('UID gaps, a large UIDVALIDITY and preset internal dates', async t => {
        const kit = await startImapKit(t, {
            server: {
                plugins: PLUGINS,
                storage: {
                    INBOX: {
                        uidvalidity: 4294967295,
                        uidnext: 4294967000,
                        messages: [
                            { uid: 7, raw: rfc822('seven'), flags: ['\\Seen', 'Work'], internaldate: '01-Jan-2020 10:00:00 +0000' },
                            { uid: 300, raw: rfc822('three hundred'), internaldate: '15-Jun-2024 23:59:59 -0700' },
                            { uid: 4294966000, raw: rfc822('almost max'), flags: ['$Important'] }
                        ]
                    },
                    '': { separator: '/' }
                }
            }
        });
        const client = await kit.connect();
        const mailbox = await client.mailboxOpen('INBOX');
        assert.equal(mailbox.uidValidity, 4294967295n);
        assert.equal(mailbox.uidNext, 4294967000);
        assert.equal(mailbox.exists, 3);

        const messages = await client.fetchAll('1:*', { uid: true, flags: true, internalDate: true });
        assert.deepEqual(
            messages.map((message: any) => message.uid),
            [7, 300, 4294966000]
        );
        assert.equal(messages[1].internalDate.toISOString(), '2024-06-16T06:59:59.000Z');

        assert.deepEqual(await client.search({ uid: '8:299' }, { uid: true }), []);
        assert.deepEqual(await client.search({ uid: '300:*' }, { uid: true }), [300, 4294966000]);
        assert.deepEqual(await client.search({ before: new Date('2021-01-01') }, { uid: true }), [7]);
        assert.deepEqual(await client.search({ keyword: '$Important' }, { uid: true }), [4294966000]);

        const one = await client.fetchOne('4294966000', { envelope: true }, { uid: true });
        assert.equal(one.envelope.subject, 'almost max');

        const moved = await client.messageMove({ uid: '7,300' }, 'Archive', { uid: true });
        // Archive does not exist in this tree, the move must fail without touching INBOX
        assert.equal(moved, false);
        assert.equal(client.mailbox.exists, 3);
        await client.logout();
    });

    it('a mailbox that does not allow new keywords', async t => {
        const kit = await startImapKit(t, {
            server: {
                plugins: PLUGINS,
                storage: {
                    INBOX: { allowPermanentFlags: false, messages: [{ raw: rfc822('no keywords') }] },
                    '': { separator: '/' }
                }
            }
        });
        const client = await kit.connect();
        const mailbox = await client.mailboxOpen('INBOX');
        assert.ok(!mailbox.permanentFlags.has('\\*'));
        // a keyword the mailbox does not take is dropped by the client, the system flag is stored
        await client.messageFlagsAdd('1', ['\\Flagged', 'NewKeyword']);
        const message = await client.fetchOne('1', { flags: true });
        assert.ok(message.flags.has('\\Flagged'));
        assert.ok(!message.flags.has('NewKeyword'));
        await client.logout();
    });

    it('\\Noselect levels, unsubscribed mailboxes and odd names', async t => {
        const kit = await startImapKit(t, {
            server: {
                plugins: PLUGINS,
                storage: {
                    INBOX: {},
                    '': {
                        separator: '/',
                        folders: {
                            Level: { flags: ['\\Noselect'], folders: { Leaf: {} } },
                            Hidden: { subscribed: false },
                            'Quote "d': {},
                            'Back\\slash': {},
                            '[Brackets] {curly}': {},
                            '  spaced  ': {}
                        }
                    }
                }
            }
        });
        const client = await kit.connect();
        const folders = await client.list();
        const byPath = (path: string) => folders.find((folder: any) => folder.path === path);
        assert.ok(byPath('Level').flags.has('\\Noselect'));
        assert.ok(byPath('Level/Leaf'));
        assert.ok(!byPath('Hidden').subscribed);
        for (const name of ['Quote "d', 'Back\\slash', '[Brackets] {curly}', '  spaced  ']) {
            assert.ok(byPath(name), `${name} listed`);
            assert.equal((await client.status(name, { messages: true })).messages, 0);
            const mailbox = await client.mailboxOpen(name);
            assert.equal(mailbox.path, name);
        }
        await assert.rejects(client.mailboxOpen('Level'));
        await client.logout();
    });

    it('an empty mailbox: UID commands and SEARCH', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const client = await kit.connect();
        const mailbox = await client.mailboxOpen('INBOX');
        assert.equal(mailbox.exists, 0);
        assert.deepEqual(await client.fetchAll('1:*', { uid: true, flags: true }, { uid: true }), []);
        assert.equal(await client.fetchOne('*', { uid: true }), false);
        assert.deepEqual(await client.search({ all: true }), []);
        await client.messageFlagsAdd('1:*', ['\\Seen'], { uid: true });
        await client.messageDelete('1:*', { uid: true });
        await client.logout();
    });

    // RFC 9051 section 9 (seq-number): a message number above the number of messages, "*" in an
    // empty mailbox included, gets a tagged BAD.
    for (const [name, run] of [
        ['fetchAll', (client: any) => client.fetchAll('1:*', { uid: true })],
        ['messageFlagsAdd', (client: any) => client.messageFlagsAdd('1:*', ['\\Seen'])],
        ['messageDelete', (client: any) => client.messageDelete('1:*')],
        ['messageCopy', (client: any) => client.messageCopy('1:*', 'Sent')],
        ['messageMove', (client: any) => client.messageMove('1:*', 'Sent')]
    ] as const) {
        it(`an empty mailbox: ${name}('1:*') sends no command`, async t => {
            const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
            const client = await kit.connect();
            await client.mailboxOpen('INBOX');
            await run(client);
        });
    }

    it('message/rfc822 attachments and nested multiparts', async t => {
        const inner = rfc822('inner message', 'Inner body');
        const raw =
            'From: a@example.com\r\nSubject: outer\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="outer"\r\n\r\n' +
            '--outer\r\nContent-Type: multipart/alternative; boundary="alt"\r\n\r\n' +
            '--alt\r\nContent-Type: text/plain\r\n\r\nplain\r\n--alt\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n--alt--\r\n' +
            `--outer\r\nContent-Type: message/rfc822\r\n\r\n${inner}\r\n--outer--\r\n`;
        const kit = await startImapKit(t, { server: { plugins: PLUGINS, storage: { INBOX: { messages: [{ raw }] } } } });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        const message = await client.fetchOne('1', { bodyStructure: true, bodyParts: ['1.2', '2', '2.1'] });
        const structure = message.bodyStructure;
        assert.equal(structure.type, 'multipart/mixed');
        assert.equal(structure.childNodes[0].type, 'multipart/alternative');
        const attached = structure.childNodes[1];
        assert.equal(attached.type, 'message/rfc822');
        assert.equal(attached.envelope.subject, 'inner message');
        assert.equal(Buffer.from(message.bodyParts.get('1.2')).toString().trim(), '<p>html</p>');
        assert.match(Buffer.from(message.bodyParts.get('2')).toString(), /Subject: inner message/);
        assert.equal(Buffer.from(message.bodyParts.get('2.1')).toString().trim(), 'Inner body');
        await client.logout();
    });
});

describe('imapkit: namespaces', () => {
    it('Cyrus style INBOX. namespace with a dot separator', async t => {
        const kit = await startImapKit(t, {
            server: {
                plugins: PLUGINS,
                storage: {
                    INBOX: {},
                    'INBOX.': { separator: '.', folders: { Sent: { 'special-use': '\\Sent' } } },
                    'user.': { type: 'user', separator: '.' },
                    '': { type: 'shared', separator: '.' }
                }
            }
        });
        const client = await kit.connect();
        assert.equal(client.namespace.prefix, 'INBOX.');
        assert.equal(client.namespace.delimiter, '.');

        // paths without the prefix get it added
        const created = await client.mailboxCreate(['Work', 'Projects']);
        assert.equal(created.path, 'INBOX.Work.Projects');
        const paths = (await client.list()).map((folder: any) => folder.path);
        assert.ok(paths.includes('INBOX.Sent'));
        assert.ok(paths.includes('INBOX.Work.Projects'));

        await client.append('INBOX.Work.Projects', rfc822('in namespace'));
        const mailbox = await client.mailboxOpen(['Work', 'Projects']);
        assert.equal(mailbox.path, 'INBOX.Work.Projects');
        assert.equal(mailbox.exists, 1);
        await client.logout();
    });

    it('a personal namespace without NAMESPACE support', async t => {
        const kit = await startImapKit(t, {
            server: { plugins: ['UIDPLUS'], storage: { INBOX: {}, '': { separator: '.', folders: { Drafts: {} } } } }
        });
        const client = await kit.connect();
        assert.equal(client.namespace.prefix, '');
        assert.equal(client.namespace.delimiter, '.');
        const created = await client.mailboxCreate(['A', 'B']);
        assert.equal(created.path, 'A.B');
        await client.logout();
    });
});
