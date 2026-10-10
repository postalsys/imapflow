import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pipeline } from 'node:stream/promises';
import { closed, flagList, rfc822, startImapKit, within } from '../fixtures/imapkit.js';
import { slowConsumer } from '../fixtures/test-client.js';

// Changes made on the server, outside any IMAP session, through the ImapKit control API: they
// reach the client the way a change by another session would (EXISTS, EXPUNGE or VANISHED,
// unsolicited FETCH with MODSEQ, BYE), also in the middle of IDLE. Some states can only be made
// this way, like a new UIDVALIDITY for a mailbox the client knows.

const PLUGINS = ['IDLE', 'UIDPLUS', 'MOVE', 'ENABLE', 'CONDSTORE', 'QRESYNC', 'LITERALPLUS', 'BINARY'];
const STORAGE = { INBOX: { messages: [{ raw: rfc822('one') }, { raw: rfc822('two'), flags: ['\\Seen'] }, { raw: rfc822('three') }] } };

// Starts IDLE and resolves once the server has entered it. The IDLE promise comes wrapped, an
// async function would otherwise wait for it to settle, which takes the next command.
const idle = async (kit: any, client: any) => {
    const waiting = kit.serverEvent('session', (event: any) => event.type === 'waiting' && event.command === 'IDLE');
    const idling = client.idle();
    await waiting;
    return { idling };
};

describe('imapkit server changes: flags and expunges', () => {
    for (const qresync of [false, true]) {
        it(`a flag change on the server reaches an idling client (${qresync ? 'QRESYNC' : 'CONDSTORE'})`, async t => {
            const kit = await startImapKit(t, { server: { plugins: PLUGINS, storage: STORAGE } });
            const client = await kit.connect({ qresync });
            // a value, the mailbox object follows HIGHESTMODSEQ as changes come in
            const highestModseq = (await client.mailboxOpen('INBOX')).highestModseq;
            const { idling } = await idle(kit, client);
            const flags = within(client, 'flags');
            kit.control.setFlags('INBOX', [3], ['\\Flagged', '$Server'], 'add');
            const [event] = await flags;
            assert.equal(event.uid, 3);
            assert.equal(event.seq, 3);
            assert.deepEqual(flagList(event.flags), ['$Server', '\\Flagged']);
            assert.ok(event.modseq > highestModseq, 'the change comes with its MODSEQ');
            assert.equal(client.mailbox.highestModseq, event.modseq);
            await client.noop();
            await idling;
            await client.logout();
        });

        it(`an expunge on the server updates the count of an idling client (${qresync ? 'VANISHED' : 'EXPUNGE'})`, async t => {
            const kit = await startImapKit(t, { server: { plugins: PLUGINS, storage: STORAGE } });
            const client = await kit.connect({ qresync });
            await client.mailboxOpen('INBOX');
            const { idling } = await idle(kit, client);
            const expunge = within(client, 'expunge');
            kit.control.expungeMessages('INBOX', [2]);
            const [event] = await expunge;
            if (qresync) {
                assert.deepEqual(event, { path: 'INBOX', uid: 2, vanished: true, earlier: false });
            } else {
                assert.deepEqual(event, { path: 'INBOX', seq: 2, vanished: false });
            }
            assert.equal(client.mailbox.exists, 2);
            await client.noop();
            await idling;
            const subjects = (await client.fetchAll('1:*', { envelope: true })).map((message: any) => message.envelope.subject);
            assert.deepEqual(subjects, ['one', 'three']);
            await client.logout();
        });
    }

    it('changes made while the client is not looking arrive with its next command', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS, storage: STORAGE } });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        const events: any[] = [];
        for (const name of ['exists', 'expunge', 'flags']) {
            client.on(name, (event: any) => events.push([name, event.uid || event.seq || event.count]));
        }
        kit.control.addMessage('INBOX', { raw: rfc822('four') });
        kit.control.setFlags('INBOX', [1], ['\\Answered'], 'add');
        kit.control.expungeMessages('INBOX', [3]);
        await client.noop();
        assert.deepEqual(events.sort(), [
            ['exists', 4],
            ['expunge', 3],
            ['flags', 1]
        ]);
        assert.equal(client.mailbox.exists, 3);
        await client.logout();
    });
});

describe('imapkit server changes: UIDVALIDITY', () => {
    it('a new UIDVALIDITY for the selected mailbox ends the session with BYE', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS, storage: STORAGE } });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        const closing = closed(client);
        kit.control.resetUidValidity('INBOX');
        await closing;
        assert.equal(client.usable, false);
        await assert.rejects(client.noop(), (err: any) => {
            assert.equal(err.code, 'NoConnection');
            return true;
        });
    });

    for (const uids of ['keep', 'renumber', 'shuffle', 'offset'] as const) {
        it(`a QRESYNC resync after a UIDVALIDITY change (${uids}) reports the new value and no stale changes`, async t => {
            const kit = await startImapKit(t, { server: { plugins: PLUGINS, storage: STORAGE } });
            const first = await kit.connect({ qresync: true });
            const known = await first.mailboxOpen('INBOX');
            await first.logout();

            const reset = kit.control.resetUidValidity('INBOX', { uids, seed: 7 });
            // changes after the reset that a resync with the old state must not report as such
            kit.control.setFlags('INBOX', [reset.uids[0]!.newUid], ['\\Flagged'], 'add');

            const client = await kit.connect({ qresync: true });
            const events: any[] = [];
            client.on('expunge', (event: any) => events.push(['expunge', event]));
            client.on('flags', (event: any) => events.push(['flags', event]));
            const mailbox = await client.mailboxOpen('INBOX', { uidValidity: known.uidValidity, changedSince: known.highestModseq });
            // the server ignores the QRESYNC parameters of another UIDVALIDITY (RFC 7162 3.2.5.2),
            // so the client can only tell from the value it reports
            assert.equal(mailbox.uidValidity, BigInt(reset.uidvalidity));
            assert.notEqual(mailbox.uidValidity, known.uidValidity);
            assert.deepEqual(events, []);
            assert.equal(mailbox.exists, 3);

            const listed = (await client.fetchAll('1:*', { uid: true, envelope: true })).map((message: any) => [message.uid, message.envelope.subject]);
            const moved = new Map(reset.uids.map(entry => [entry.uid, entry.newUid]));
            assert.deepEqual(
                listed,
                [1, 2, 3].map((oldUid, i) => [moved.get(oldUid), ['one', 'two', 'three'][i]]).sort((a: any, b: any) => a[0] - b[0])
            );
            if (uids === 'offset') {
                // every old UID finds nothing
                assert.equal(await client.fetchOne('1', { uid: true }, { uid: true }), false);
            }
            await client.logout();
        });
    }
});

describe('imapkit server changes: unsolicited output', () => {
    it('an ALERT injected between commands and during IDLE reaches the alert event', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS, storage: STORAGE } });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        const session = kit.control.sessions()[0]!.session;

        const between = within(client, 'alert');
        kit.control.inject(session, '* OK [ALERT] System shutdown in 10 minutes\r\n');
        assert.deepEqual((await between)[0], { message: 'System shutdown in 10 minutes', response: 'OK' });

        const { idling } = await idle(kit, client);
        const during = within(client, 'alert');
        kit.control.inject(session, '* OK [ALERT] Mailbox moves to another server\r\n');
        assert.equal((await during)[0].message, 'Mailbox moves to another server');
        await client.noop();
        await idling;
        await client.logout();
    });

    it('an autologout during a long IDLE closes the session with its reason', async t => {
        const kit = await startImapKit(t, {
            server: {
                plugins: PLUGINS,
                storage: STORAGE,
                script: { on: 'quiet', command: 'IDLE', quietFor: 50, send: '* BYE Autologout; idle for too long\r\n', close: true }
            }
        });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        const closing = closed(client);
        await client.idle().catch(() => false);
        await closing;
        assert.equal(client.usable, false);
        assert.equal(client.byeReason, 'Autologout; idle for too long');
    });

    it('a server side disconnect with BYE reports the reason', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS, storage: STORAGE } });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        const closing = closed(client);
        kit.control.disconnect({ user: 'testuser' }, { text: 'Server maintenance' });
        await closing;
        assert.equal(client.byeReason, 'Server maintenance');
    });

    it('a disconnect while a download waits for its consumer fails the download as a lost connection', async t => {
        const raw = rfc822('large', 'x'.repeat(300 * 1024));
        const kit = await startImapKit(t, { server: { plugins: PLUGINS, storage: { INBOX: { messages: [{ raw }] } } } });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        // nothing reads the content yet, so the download stops after the head chunk
        const { content } = await client.download('1', undefined, { uid: true, chunkSize: 64 * 1024 });
        const closing = closed(client);
        kit.control.disconnect({ user: 'testuser' });
        await closing;

        // Before, the next chunk found no mailbox and was reported as an expunged message
        // (DownloadIncomplete). The pipeline rejecting also shows the content stream was
        // destroyed: a plain pipe() destination would otherwise wait forever.
        const received: Buffer[] = [];
        await assert.rejects(pipeline(content, slowConsumer({ onChunk: chunk => received.push(chunk) })), (err: any) => err.code === 'NoConnection');
        assert.ok(content.destroyed);
        // what did arrive is the start of the message
        const got = Buffer.concat(received);
        assert.ok(Buffer.from(raw).subarray(0, got.length).equals(got));
    });
});

describe('imapkit server changes: what the client stored', () => {
    // A message of every kind a literal can carry: 8-bit, NUL octets (BINARY only), long lines
    const EIGHT_BIT = Buffer.concat([
        Buffer.from('Subject: =?UTF-8?Q?=C3=95un?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'),
        Buffer.from('Õun ja pirn\r\n'.repeat(500))
    ]);
    const BINARY = Buffer.concat([
        Buffer.from('Subject: binary\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\n\r\n'),
        Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 256))
    ]);

    for (const profile of [
        { name: 'synchronizing literals', plugins: ['UIDPLUS'] },
        { name: 'LITERAL+', plugins: ['UIDPLUS', 'LITERALPLUS'] },
        { name: 'LITERAL-', plugins: ['UIDPLUS', 'LITERALMINUS'] },
        { name: 'BINARY', plugins: ['UIDPLUS', 'BINARY', 'LITERALPLUS'] }
    ]) {
        it(`append stores the exact bytes and flags (${profile.name})`, async t => {
            const kit = await startImapKit(t, { server: { plugins: profile.plugins } });
            const client = await kit.connect();
            // A Uint8Array view into a larger buffer (fetch().arrayBuffer(), TextEncoder) is sent as
            // the bytes it covers; it used to be announced with the size of its stringified form
            // and sent as nothing. The large message is written without copying it to append the
            // closing CRLF.
            const padded = new TextEncoder().encode('xx' + rfc822('view') + 'yy');
            const view = padded.subarray(2, padded.length - 2);
            for (const source of [rfc822('plain'), EIGHT_BIT, view, rfc822('large', 'x'.repeat(200 * 1024))]) {
                const appended = await client.append('INBOX', source, ['\\Seen', '$Label'], new Date('2026-05-01T10:20:30Z'));
                const stored = kit.control.getMessage('INBOX', appended.uid);
                assert.ok(stored.raw!.equals(Buffer.from(source)), 'the stored message is byte for byte what was appended');
                assert.deepEqual(stored.flags.sort(), ['$Label', '\\Seen']);
                // date-day-fixed: a single digit day comes with a space
                assert.equal(stored.internaldate, ' 1-May-2026 10:20:30 +0000');
            }
            if (profile.plugins.includes('BINARY')) {
                // NUL octets need a literal8. ImapKit stores such a part base64 encoded so that
                // BODY[] stays valid IMAP4rev1, so the check is the round trip of the content
                // ImapKit answers NUL octets in an ordinary literal with BAD, which fails the test
                const appended = await client.append('INBOX', BINARY);
                await client.mailboxOpen('INBOX');
                const { content } = await client.download(String(appended.uid), 'TEXT', { uid: true, binary: true });
                assert.ok(Buffer.concat(await content.toArray()).equals(BINARY.subarray(BINARY.indexOf('\r\n\r\n') + 4)));
            }
            await client.logout();
        });
    }

    it('flag changes, copies and moves leave the server in the state the client reports', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS, storage: STORAGE } });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        await client.mailboxCreate('Archive');
        await client.messageFlagsAdd('1:2', ['\\Flagged']);
        await client.messageFlagsRemove('2', ['\\Seen']);
        const copied = await client.messageCopy('1', 'Archive');
        const moved = await client.messageMove('3', 'Archive');

        const server = (path: string) => kit.control.listMessages(path).map((message: any) => [message.uid, message.flags.sort()]);
        assert.deepEqual(server('INBOX'), [
            [1, ['\\Flagged']],
            [2, ['\\Flagged']]
        ]);
        assert.deepEqual(
            server('Archive').map(([uid]) => uid),
            [...copied.uidMap.values(), ...moved.uidMap.values()]
        );
        await client.logout();
    });
});
