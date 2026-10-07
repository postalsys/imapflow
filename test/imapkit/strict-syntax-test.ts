import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { flagList, rfc822, startImapKit } from '../fixtures/imapkit.js';

// Values that need quoting, escaping or a literal, sent to a server that answers every grammar
// violation with BAD (the fixture fails the test on any BAD). Covers the command compiler and the
// search compiler end to end, with and without LITERAL+, LITERAL- and UTF8=ACCEPT.

const HOSTILE = ['quote " inside', 'back\\slash', 'percent % and star *', 'paren ( ) brace { }', 'tab\there', 'tere õun', '日本語', 'a'.repeat(5000)];

const PROFILES: { name: string; plugins: string[] }[] = [
    { name: 'synchronizing literals', plugins: ['UIDPLUS', 'ESEARCH'] },
    { name: 'LITERAL+', plugins: ['UIDPLUS', 'LITERALPLUS'] },
    { name: 'LITERAL-', plugins: ['UIDPLUS', 'LITERALMINUS'] },
    { name: 'UTF8=ACCEPT', plugins: ['UIDPLUS', 'ENABLE', 'UTF8=ACCEPT'] },
    { name: 'IMAP4rev2', plugins: ['IMAP4rev2'] }
];

describe('imapkit: strict syntax', () => {
    for (const profile of PROFILES) {
        it(`hostile search values are quoted or sent as literals (${profile.name})`, async t => {
            const kit = await startImapKit(t, { server: { plugins: profile.plugins } });
            const client = await kit.connect();
            for (const value of HOSTILE) {
                await client.append('INBOX', rfc822('plain', `body with ${value} in it`));
            }
            await client.mailboxOpen('INBOX');
            for (const [index, value] of HOSTILE.entries()) {
                const found = await client.search({ body: value });
                // ASCII values are matched exactly, ImapKit folds only ASCII case
                assert.ok(found.includes(index + 1), `${JSON.stringify(value.slice(0, 40))} found in ${JSON.stringify(found)}`);
                await client.search({ header: { 'X-Custom': value } });
                await client.search({ or: [{ from: value }, { to: value }, { cc: value }, { bcc: value }], not: { subject: value } });
            }
            await client.logout();
        });

        it(`hostile mailbox names round-trip (${profile.name})`, async t => {
            const kit = await startImapKit(t, { server: { plugins: profile.plugins } });
            const client = await kit.connect();
            const names = ['quote " inside', 'back\\slash', 'paren ( ) brace { }', 'tere õun', 'NIL', 'INBOXX', '~tilde'];
            for (const name of names) {
                await client.mailboxCreate(name);
                await client.append(name, rfc822('in hostile mailbox'));
                assert.equal((await client.status(name, { messages: true })).messages, 1, name);
                await client.mailboxOpen(name);
                await client.messageCopy('1', 'INBOX');
            }
            const paths = (await client.list()).map((folder: any) => folder.path);
            for (const name of names) {
                assert.ok(paths.includes(name), `${name} in ${JSON.stringify(paths)}`);
            }
            await client.logout();
        });
    }

    it('flags: \\Recent is never sent', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['UIDPLUS'] } });
        const client = await kit.connect();
        await client.append('INBOX', rfc822('flags'), ['\\Recent', '\\Seen', '$Label1']);
        await client.mailboxOpen('INBOX');
        await client.messageFlagsAdd('1', ['\\Recent', '$Label2']);
        await client.messageFlagsSet('1', ['\\Recent', '\\Seen', '$Label3']);
        const message = await client.fetchOne('1', { flags: true });
        assert.deepEqual(flagList(message.flags), ['$Label3', '\\Seen']);
        assert.ok(!kit.sent(/(STORE|APPEND) .*\\Recent/));
        await client.logout();
    });

    it('flags: keywords that are not atoms are dropped instead of quoted', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['UIDPLUS'] } });
        const client = await kit.connect();
        await client.append('INBOX', rfc822('flags'), ['\\Seen', 'with space']);
        await client.mailboxOpen('INBOX');
        assert.equal(await client.messageFlagsAdd('1', ['with space', 'paren(', '$Label2']), true);
        assert.equal(await client.messageFlagsSet('1', ['\\Seen', 'quote"d', '$Label3']), true);
        const message = await client.fetchOne('1', { flags: true });
        assert.deepEqual(flagList(message.flags), ['$Label3', '\\Seen']);
    });

    it('long sequence sets', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['UIDPLUS', 'ESEARCH'] } });
        const client = await kit.connect();
        for (let i = 0; i < 50; i++) {
            await client.append('INBOX', rfc822(`seq ${i}`));
        }
        await client.mailboxOpen('INBOX');
        const odd = Array.from({ length: 25 }, (_, i) => i * 2 + 1);
        const fetched = await client.fetchAll(odd.join(','), { uid: true });
        assert.deepEqual(
            fetched.map((message: any) => message.seq),
            odd
        );
        assert.deepEqual(await client.search({ uid: odd.join(',') }, { uid: true }), odd);
        await client.logout();
    });

    it('non-ASCII search matches RFC 2047 encoded headers', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['IMAP4rev2'] } });
        const client = await kit.connect();
        await client.append('INBOX', 'Subject: =?UTF-8?Q?R=C3=A9servation?=\r\n\r\nfirst\r\n');
        await client.mailboxOpen('INBOX');
        assert.deepEqual(await client.search({ subject: 'Réservation' }), [1]);
        await client.logout();
    });

    it('digit-led mailbox names', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['IMAP4rev2'] } });
        const client = await kit.connect();
        for (const name of ['2024:Q1', '1,a', '10:', '12:30:00']) {
            await client.mailboxCreate(name);
        }
        await client.logout();
    });
});
