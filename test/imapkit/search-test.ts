import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startImapKit } from '../fixtures/imapkit.js';
import { packMessageRange } from '../../src/tools.js';
import type { SearchObject } from '../../src/types.js';

// The search keys against a mailbox with known content, under several capability profiles. The
// compiler tests check the command that is built, these check that the server finds what the
// query means: ImapKit implements the RFC 3501 / RFC 9051 search semantics, so a wrong key, a
// wrong date format or a lost negation shows up as a wrong result set.

const message = (headers: Record<string, string>, body: string) =>
    Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n') + `\r\n\r\n${body}\r\n`;

const MESSAGES = [
    {
        raw: message(
            {
                From: 'Alice <alice@a.example>',
                To: 'Bob <bob@b.example>',
                Cc: 'Carol <carol@c.example>',
                Subject: 'Quarterly report',
                Date: 'Mon, 5 Jan 2026 10:00:00 +0000',
                'X-Project': 'apollo'
            },
            'The numbers are inside.'
        ),
        flags: ['\\Seen', '\\Answered'],
        internaldate: '06-Jan-2026 09:00:00 +0000'
    },
    {
        raw: message(
            {
                From: 'Bob <bob@b.example>',
                To: 'Alice <alice@a.example>',
                Bcc: 'Dave <dave@d.example>',
                Subject: 'Re: Quarterly report',
                Date: 'Tue, 10 Feb 2026 12:00:00 +0000'
            },
            'Short.'
        ),
        flags: ['\\Flagged', '$Important'],
        internaldate: '11-Feb-2026 08:00:00 +0000'
    },
    {
        raw: message(
            { From: 'Carol <carol@c.example>', To: 'Bob <bob@b.example>', Subject: 'Holiday photos', Date: 'Sun, 15 Mar 2026 18:00:00 +0000' },
            'Photos attached. '.repeat(200)
        ),
        flags: ['\\Draft', '\\Deleted', '\\Seen'],
        internaldate: '15-Mar-2026 23:30:00 +0000'
    },
    {
        raw: message(
            {
                From: 'Dave <dave@d.example>',
                To: 'Carol <carol@c.example>',
                Subject: '=?UTF-8?Q?L=C3=B5una?=',
                Date: 'Wed, 1 Apr 2026 11:00:00 +0000',
                'X-Project': 'gemini'
            },
            'Pizza at noon.'
        ),
        flags: [],
        internaldate: '02-Apr-2026 07:00:00 +0000'
    }
];

const STORAGE = { INBOX: { messages: MESSAGES } };

// [query, UIDs it must find]; storage messages get UIDs 1 to 4 in order
const QUERIES: [string, SearchObject, number[]][] = [
    ['all', { all: true }, [1, 2, 3, 4]],
    ['seq', { seq: '2:3' }, [2, 3]],
    ['uid', { uid: '3:*' }, [3, 4]],
    ['answered', { answered: true }, [1]],
    ['unanswered', { answered: false }, [2, 3, 4]],
    ['deleted', { deleted: true }, [3]],
    ['undeleted', { deleted: false }, [1, 2, 4]],
    ['draft', { draft: true }, [3]],
    ['undraft', { draft: false }, [1, 2, 4]],
    ['flagged', { flagged: true }, [2]],
    ['unflagged', { flagged: false }, [1, 3, 4]],
    ['seen', { seen: true }, [1, 3]],
    ['unseen', { seen: false }, [2, 4]],
    ['keyword', { keyword: '$Important' }, [2]],
    ['unKeyword', { unKeyword: '$Important' }, [1, 3, 4]],
    ['from', { from: 'alice@a.example' }, [1]],
    ['from by name', { from: 'Carol' }, [3]],
    ['to', { to: 'bob@b.example' }, [1, 3]],
    ['cc', { cc: 'carol' }, [1]],
    ['bcc', { bcc: 'dave@d.example' }, [2]],
    ['subject', { subject: 'quarterly' }, [1, 2]],
    ['body', { body: 'pizza' }, [4]],
    ['text matches headers', { text: 'quarterly' }, [1, 2]],
    ['text matches the body', { text: 'pizza' }, [4]],
    ['body does not match headers', { body: 'quarterly' }, []],
    ['header with value', { header: { 'x-project': 'apollo' } }, [1]],
    ['header present', { header: { 'x-project': true } }, [1, 4]],
    ['larger', { larger: 1000 }, [3]],
    ['smaller', { smaller: 1000 }, [1, 2, 4]],
    ['before', { before: new Date('2026-02-11T00:00:00Z') }, [1]],
    // a time of day moves BEFORE to the next day, so the day itself is included
    ['before with a time of day', { before: new Date('2026-02-11T15:00:00Z') }, [1, 2]],
    ['on', { on: new Date('2026-02-11T15:00:00Z') }, [2]],
    ['since', { since: new Date('2026-03-15T00:00:00Z') }, [3, 4]],
    ['sentBefore', { sentBefore: new Date('2026-02-10T00:00:00Z') }, [1]],
    ['sentOn', { sentOn: new Date('2026-03-15T00:00:00Z') }, [3]],
    ['sentSince', { sentSince: new Date('2026-02-10T00:00:00Z') }, [2, 3, 4]],
    ['not', { not: { seen: true } }, [2, 4]],
    ['not with several keys', { not: { seen: true, answered: true } }, [2, 3, 4]],
    ['or', { or: [{ flagged: true }, { draft: true }] }, [2, 3]],
    ['or with three branches', { or: [{ from: 'alice' }, { from: 'bob' }, { from: 'dave' }] }, [1, 2, 4]],
    ['keys are ANDed', { seen: true, subject: 'quarterly' }, [1]],
    ['or inside not', { not: { or: [{ seen: true }, { flagged: true }] } }, [4]],
    ['nothing matches', { subject: 'no such subject' }, []]
];

// Profiles that only differ in how the query or the answer travels add the cases that use it
const UTF8_QUERIES: [string, SearchObject, number[]][] = [['non-ASCII subject', { subject: 'Lõuna' }, [4]]];

const PROFILES = [
    { name: 'IMAP4rev1', plugins: [], queries: QUERIES },
    // returnOptions makes the client ask for an ESEARCH answer, compared through its ALL set
    { name: 'ESEARCH', plugins: ['ESEARCH'], queries: QUERIES, esearch: true },
    { name: 'IMAP4rev2', plugins: ['IMAP4rev2'], queries: [...QUERIES, ...UTF8_QUERIES] },
    { name: 'IMAP4rev2 with UTF8=ACCEPT', plugins: ['IMAP4rev2', 'UTF8=ACCEPT'], queries: [...QUERIES, ...UTF8_QUERIES] }
];

for (const profile of PROFILES) {
    describe(`imapkit search: ${profile.name}`, () => {
        it('each search key finds what the query means', async t => {
            const kit = await startImapKit(t, { server: { plugins: profile.plugins, storage: STORAGE } });
            const client = await kit.connect();
            await client.mailboxOpen('INBOX');
            const results: Record<string, unknown> = {};
            const expected: Record<string, unknown> = {};
            for (const [name, query, uids] of profile.queries) {
                if (profile.esearch) {
                    const result = await client.search(query, { uid: true, returnOptions: ['ALL', 'COUNT'] });
                    results[name] = [result.count, result.all];
                    expected[name] = [uids.length, uids.length ? packMessageRange(uids) : undefined];
                } else {
                    results[name] = await client.search(query, { uid: true });
                    expected[name] = uids;
                }
            }
            assert.deepEqual(results, expected);
            if (profile.esearch) {
                assert.ok(kit.received(/^\* ESEARCH /), 'answered with ESEARCH');
            }
            await client.logout();
        });
    });
}
