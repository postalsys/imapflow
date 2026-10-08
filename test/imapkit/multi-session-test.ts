import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rfc822, startImapKit, within } from '../fixtures/imapkit.js';

// Several sessions on one mailbox tree, and changes made from outside any session (a message
// delivered like an MTA would). ImapKit follows one consistent set of the RFC 2180 strategies, so
// these cases are deterministic, unlike against a real server with its own timing.

// Another session expunges message `seq` of INBOX
const expungeElsewhere = async (kit: any, seq: string) => {
    const other = await kit.connect();
    await other.mailboxOpen('INBOX');
    await other.messageDelete(seq);
    await other.logout();
};

const PLUGINS = ['IDLE', 'UIDPLUS', 'MOVE', 'CONDSTORE', 'ENABLE', 'UNSELECT', 'SPECIAL-USE'];

describe('imapkit: IDLE and notifications', () => {
    it('IDLE reports a delivered message', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const client = await kit.connect();
        await client.mailboxOpen('INBOX');
        const waiting = kit.serverEvent('session', event => event.type === 'waiting' && event.command === 'IDLE');
        const idling = client.idle();
        await waiting;
        const exists = within(client, 'exists');
        kit.control.addMessage('INBOX', { raw: rfc822('delivered') });
        const [event] = await exists;
        assert.deepEqual(event, { path: 'INBOX', count: 1, prevCount: 0 });
        assert.equal(client.mailbox.exists, 1);
        // any command breaks IDLE
        const message = await client.fetchOne('*', { envelope: true });
        assert.equal(message.envelope.subject, 'delivered');
        await idling;
        assert.ok(kit.sent(/^DONE$/));
        await client.logout();
    });

    it('auto-IDLE starts after autoIdleDelay and sees appends from another session', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const waiting = kit.serverEvent('session', event => event.type === 'waiting' && event.command === 'IDLE');
        const client = await kit.connect({ disableAutoIdle: false, autoIdleDelay: 50 });
        await client.mailboxOpen('INBOX');
        await waiting;
        const other = await kit.connect();
        const exists = within(client, 'exists');
        await other.append('INBOX', rfc822('from other session'));
        const [event] = await exists;
        assert.equal(event.count, 1);
        await other.logout();
        await client.logout();
    });

    it('without IDLE the client polls with NOOP', async t => {
        const kit = await startImapKit(t, { server: { plugins: ['UIDPLUS'] } });
        const client = await kit.connect({ maxIdleTime: 50 });
        await client.mailboxOpen('INBOX');
        const idling = client.idle();
        const exists = within(client, 'exists');
        kit.control.addMessage('INBOX', { raw: rfc822('polled') });
        const [event] = await exists;
        assert.equal(event.count, 1);
        assert.ok(kit.sent(/^\S+ NOOP$/));
        assert.ok(!kit.sent(/ IDLE$/));
        await client.noop();
        await idling;
        await client.logout();
    });

    it('expunges and flag changes by another session reach the selected client', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const client = await kit.connect();
        for (let i = 1; i <= 3; i++) {
            await client.append('INBOX', rfc822(`shared ${i}`));
        }
        await client.mailboxOpen('INBOX');

        const other = await kit.connect();
        await other.mailboxOpen('INBOX');
        await other.messageFlagsAdd('3', ['\\Flagged']);
        await other.messageDelete('1');
        await other.logout();

        const expunges: any[] = [];
        const flags: any[] = [];
        client.on('expunge', (event: any) => expunges.push(event));
        client.on('flags', (event: any) => flags.push(event));
        await client.noop();

        assert.deepEqual(expunges, [{ path: 'INBOX', seq: 1, vanished: false }]);
        assert.equal(client.mailbox.exists, 2);
        assert.ok(flags.some(event => event.flags.has('\\Flagged')));
        const subjects = (await client.fetchAll('1:*', { envelope: true })).map((message: any) => message.envelope.subject);
        assert.deepEqual(subjects, ['shared 2', 'shared 3']);
        await client.logout();
    });

    it('a FETCH of a message another session expunged ends with EXPUNGEISSUED and still returns it', async t => {
        // RFC 2180 section 4.1.1: the session keeps its message numbers until it is told about the expunge
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const client = await kit.connect();
        await client.append('INBOX', rfc822('doomed'));
        await client.append('INBOX', rfc822('survivor'));
        await client.mailboxOpen('INBOX');

        await expungeElsewhere(kit, '1');

        const messages = await client.fetchAll('1:2', { envelope: true });
        assert.ok(kit.received(/OK \[EXPUNGEISSUED\]/));
        assert.deepEqual(
            messages.map((message: any) => message.envelope.subject),
            ['doomed', 'survivor']
        );
        await client.noop();
        assert.equal(client.mailbox.exists, 1);
        await client.logout();
    });

    it('a STORE on a message another session expunged rejects with EXPUNGEISSUED, the rest is stored', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const client = await kit.connect();
        await client.append('INBOX', rfc822('doomed'));
        await client.append('INBOX', rfc822('survivor'));
        await client.mailboxOpen('INBOX');

        await expungeElsewhere(kit, '1');

        // flag methods report failure as false instead of throwing
        assert.equal(await client.messageFlagsAdd('1:2', ['\\Seen']), false);
        assert.ok(kit.received(/NO \[EXPUNGEISSUED\]/));
        await client.noop();
        const message = await client.fetchOne('1', { flags: true, envelope: true });
        assert.equal(message.envelope.subject, 'survivor');
        assert.ok(message.flags.has('\\Seen'));
        await client.logout();
    });
});

describe('imapkit: mailbox changes by another session', () => {
    it('DELETE of the selected mailbox disconnects the client with BYE', async t => {
        // RFC 2180 section 3.3
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const client = await kit.connect();
        await client.mailboxCreate('Doomed');
        await client.mailboxOpen('Doomed');
        const closed = within(client, 'close');

        const other = await kit.connect();
        await other.mailboxDelete('Doomed');
        await other.logout();

        await closed;
        assert.equal(client.usable, false);
        assert.equal(client.mailbox, false);
        await assert.rejects(client.noop(), (err: any) => err.code === 'NoConnection');
    });

    it('RENAME of the selected mailbox keeps the session working', async t => {
        // RFC 2180 section 3.4
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const client = await kit.connect();
        await client.mailboxCreate('Before');
        await client.append('Before', rfc822('renamed'));
        await client.mailboxOpen('Before');

        const other = await kit.connect();
        await other.mailboxRename('Before', 'After');
        await other.logout();

        await client.noop();
        const message = await client.fetchOne('1', { envelope: true });
        assert.equal(message.envelope.subject, 'renamed');
        const paths = (await client.list()).map((folder: any) => folder.path);
        assert.ok(paths.includes('After') && !paths.includes('Before'));
        await client.logout();
    });

    it('CLOSE expunges \\Deleted messages, a re-select does not', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const client = await kit.connect();
        await client.append('INBOX', rfc822('deleted'), ['\\Deleted']);
        await client.append('INBOX', rfc822('kept'));

        await client.mailboxOpen('INBOX');
        await client.mailboxOpen('Sent');
        assert.equal((await client.status('INBOX', { messages: true })).messages, 2, 'switching mailboxes does not expunge');

        await client.mailboxOpen('INBOX');
        await client.mailboxClose();
        assert.equal((await client.status('INBOX', { messages: true })).messages, 1, 'CLOSE expunged the \\Deleted message');
        await client.logout();
    });

    it('a read-only EXAMINE refuses flag changes', async t => {
        const kit = await startImapKit(t, { server: { plugins: PLUGINS } });
        const client = await kit.connect();
        await client.append('INBOX', rfc822('read only'));
        const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
        assert.equal(mailbox.readOnly, true);
        assert.equal(await client.messageFlagsAdd('1', ['\\Seen']), false);
        const message = await client.fetchOne('1', { flags: true, source: true });
        assert.ok(!message.flags.has('\\Seen'), 'FETCH in an EXAMINEd mailbox does not set \\Seen');
        await client.logout();
    });
});
