import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flagList, rfc822, startImapKit } from '../fixtures/imapkit.js';
import { FUZZ_SEED, FUZZ_ITERATIONS, Rng } from '../fixtures/imap-fuzz.js';

// One mailbox workflow run over output that the server writes in pieces of random size: every
// greeting, continuation request and response is split at points the seed picks. The client has
// to reassemble lines and literals across any boundary, with and without compression and TLS, and
// come out with exactly what the same workflow gives over unsplit output. FUZZ_SEED and
// FUZZ_ITERATIONS work as in the parser fuzz tests.

// every run is a full session, so far fewer than the parser fuzz cases
const ITERATIONS = Math.max(1, Math.ceil(FUZZ_ITERATIONS / 100));

// Piece sizes around the places that matter: single octets, a CRLF split in two, literal headers
const CHUNKS = [1, 2, 3, 5, 8, 13, 64, 1024];

// Each piece goes out 1 ms after the one before, without a gap the socket would merge them again.
// A rule only takes outputs it splits into at most MAX_PIECES pieces, which keeps a run short, the
// large FETCH answers go to the rules with larger pieces. `splits` counts the outputs really split.
const MAX_PIECES = 24;
const splitRules = (seed: number, counter: { splits: number }) => {
    const rng = new Rng(seed);
    return CHUNKS.flatMap(chunk =>
        (['greeting', 'continuation', 'response'] as const).map(on => ({
            on,
            chunk,
            chunkDelay: 1,
            // checked in order, so each rule takes a share of the output that is left
            when: (context: any) => {
                let fits = context.data.length > chunk && context.data.length <= chunk * MAX_PIECES && rng.chance(1 / 3);
                counter.splits += fits ? 1 : 0;
                return fits;
            }
        }))
    );
};

const ATTACHMENT = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256)).toString('base64');
const MULTIPART =
    'From: a@example.com\r\nTo: b@example.com\r\nSubject: chaos\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n' +
    '--b\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nT=C3=A4na =\r\non p=C3=A4ev\r\n' +
    `--b\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="data.bin"\r\n\r\n${ATTACHMENT.replace(/.{76}/g, '$&\r\n')}\r\n--b--\r\n`;
const STORAGE = {
    INBOX: { messages: [{ raw: MULTIPART, flags: ['\\Seen'] }, { raw: rfc822('second') }, { raw: rfc822('third', 'x'.repeat(3000)) }] },
    // storage keeps mailbox names in modified UTF-7, the client sees Ünicode
    '': { separator: '/', folders: { Archive: { 'special-use': '\\Archive' }, '&ANw-nicode': {} } }
};

const PROFILES = [
    { name: 'IMAP4rev1', plugins: ['UIDPLUS', 'MOVE', 'IDLE', 'SPECIAL-USE'], client: {} },
    { name: 'COMPRESS and LITERAL+', plugins: ['UIDPLUS', 'MOVE', 'IDLE', 'SPECIAL-USE', 'COMPRESS', 'LITERALPLUS', 'ENABLE', 'CONDSTORE'], client: {} },
    { name: 'IMAP4rev2 over STARTTLS', plugins: ['IMAP4rev2', 'STARTTLS', 'UTF8=ACCEPT', 'QRESYNC'], client: { qresync: true } }
];

const read = async (content: any) => Buffer.concat(await content.toArray());

// The workflow, returning everything it saw in a form that can be compared
const workflow = async (client: any) => {
    const seen: any = {};
    seen.folders = (await client.list()).map((folder: any) => [folder.path, folder.specialUse || null]).sort();
    const mailbox = await client.mailboxOpen('INBOX');
    seen.mailbox = { exists: mailbox.exists, uidNext: mailbox.uidNext };
    seen.messages = (await client.fetchAll('1:*', { uid: true, flags: true, envelope: true, bodyStructure: true, size: true, source: true })).map(
        (message: any) => ({
            uid: message.uid,
            flags: flagList(message.flags),
            subject: message.envelope.subject,
            size: message.size,
            parts: (message.bodyStructure.childNodes || []).map((node: any) => node.type),
            source: message.source.toString('base64')
        })
    );
    seen.text = (await read((await client.download('1', '1')).content)).toString();
    seen.attachment = (await read((await client.download('1', '2', { chunkSize: 1000 })).content)).toString('base64');
    seen.search = await client.search({ or: [{ seen: true }, { subject: 'third' }] }, { uid: true });
    await client.messageFlagsAdd('2', ['\\Flagged', '$Chaos']);
    seen.appended = (await client.append('INBOX', rfc822('appended', 'y'.repeat(2000)), ['\\Draft'])).uid;
    await client.messageMove('3', 'Archive');
    seen.after = (await client.fetchAll('1:*', { uid: true, flags: true })).map((message: any) => [message.uid, flagList(message.flags)]);
    seen.archive = (await client.status('Archive', { messages: true })).messages;
    seen.unicode = (await client.status('Ünicode', { messages: true })).messages;
    return seen;
};

const run = async (t: any, profile: (typeof PROFILES)[number], seed?: number) => {
    const counter = { splits: 0 };
    const script = seed === undefined ? [] : splitRules(seed, counter);
    const kit = await startImapKit(t, { server: { plugins: profile.plugins, storage: STORAGE, script } });
    const client = await kit.connect(profile.client);
    try {
        // the transport the profile is about is really in use
        assert.equal(!!client.secureConnection, profile.plugins.includes('STARTTLS'));
        assert.equal(kit.sent(/^\S+ COMPRESS DEFLATE$/), profile.plugins.includes('COMPRESS'));
        const seen = await workflow(client);
        assert.ok(seed === undefined || counter.splits > 30, `only ${counter.splits} outputs were split`);
        return seen;
    } finally {
        await client.logout();
    }
};

for (const profile of PROFILES) {
    describe(`imapkit chaos: ${profile.name}`, () => {
        it(`output split at random points gives the same results (seed ${FUZZ_SEED}, ${ITERATIONS} runs)`, async t => {
            const expected = await run(t, profile);
            assert.equal(expected.text.trim(), 'Täna on päev');
            assert.equal(expected.attachment, ATTACHMENT);
            for (let i = 0; i < ITERATIONS; i++) {
                const seed = FUZZ_SEED + i;
                assert.deepEqual(await run(t, profile, seed), expected, `seed ${seed}`);
            }
        });
    });
}
