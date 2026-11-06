import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planSessionExpiry, DEFAULT_SESSION_EXPIRY_LEAD } from '../src/session-expiry.js';
import { closed, startImapKit } from './fixtures/imapkit.js';

// The `sessionExpires` option. Exchange Online ends an IMAP session when the OAuth2 access token it
// authenticated with expires and answers the next command with `BYE Session invalidated -
// AccessTokenExpired`, so the command an application sends at that moment fails. With the option
// set, the client closes the connection itself before that, at a moment nothing runs on it.

const NOW = Date.parse('2026-11-06T10:00:00.000Z');

describe('planSessionExpiry', () => {
    it('is null without a usable expiry', () => {
        assert.equal(planSessionExpiry(undefined, undefined, NOW), null);
        assert.equal(planSessionExpiry(null as any, undefined, NOW), null);
        assert.equal(planSessionExpiry(new Date('not a date'), undefined, NOW), null);
        assert.equal(planSessionExpiry(Number.NaN, undefined, NOW), null);
    });

    it('starts looking for a free moment the lead before the expiry and forces the close 30 seconds before it', () => {
        assert.deepEqual(planSessionExpiry(NOW + 60 * 60 * 1000, undefined, NOW), {
            dueIn: 60 * 60 * 1000 - DEFAULT_SESSION_EXPIRY_LEAD,
            closeIn: 60 * 60 * 1000 - 30 * 1000
        });
        // a Date works the same as milliseconds
        assert.deepEqual(planSessionExpiry(new Date(NOW + 60 * 60 * 1000), undefined, NOW), planSessionExpiry(NOW + 60 * 60 * 1000, undefined, NOW));
    });

    it('takes the lead from the option, and forces the close at half of a short lead', () => {
        assert.deepEqual(planSessionExpiry(NOW + 10 * 60 * 1000, 2 * 60 * 1000, NOW), { dueIn: 8 * 60 * 1000, closeIn: 10 * 60 * 1000 - 30 * 1000 });
        assert.deepEqual(planSessionExpiry(NOW + 1000, 400, NOW), { dueIn: 600, closeIn: 800 });
        assert.deepEqual(planSessionExpiry(NOW + 1000, 0, NOW), { dueIn: 1000, closeIn: 1000 });
    });

    it('falls back to the default lead for an invalid one', () => {
        for (const lead of [-1, Number.NaN, Number.POSITIVE_INFINITY, '100' as any]) {
            assert.equal(planSessionExpiry(NOW + 60 * 60 * 1000, lead, NOW)!.dueIn, 60 * 60 * 1000 - DEFAULT_SESSION_EXPIRY_LEAD, String(lead));
        }
    });

    it('fires at once for an expiry that is already close or past', () => {
        assert.deepEqual(planSessionExpiry(NOW + 1000, undefined, NOW), { dueIn: 0, closeIn: 0 });
        assert.deepEqual(planSessionExpiry(NOW - 1000, undefined, NOW), { dueIn: 0, closeIn: 0 });
    });
});

// What the client logged about closing the connection
const closeLogs = (client: any): string[] => {
    const entries: string[] = [];
    client.on('log', (entry: any) => {
        if (entry && /session (expires|is about to expire)/.test(entry.msg)) {
            entries.push(entry.msg);
        }
    });
    return entries;
};

// Starts IDLE and resolves once the server has entered it. The IDLE promise comes wrapped, an async
// function would otherwise wait for it to settle
const startIdle = async (kit: any, client: any) => {
    const waiting = kit.serverEvent('session', (event: any) => event.type === 'waiting' && event.command === 'IDLE');
    const idling = client.idle().catch(() => {});
    await waiting;
    return { idling };
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Arms the session expiry timers again, counted from now. The client arms them when it
// authenticates, and how long the session setup takes after that depends on the machine, so a
// test that needs the connection in a given state (idling, holding a lock) when they fire connects
// with a far expiry and moves it once that state is reached
const rearm = (client: any, expiresIn: number, lead: number) => {
    clearTimeout(client._sessionDueTimer);
    clearTimeout(client._sessionCloseTimer);
    client._sessionDueTimer = null;
    client.options.sessionExpires = Date.now() + expiresIn;
    client.options.sessionExpiryLead = lead;
    client.armSessionExpiry();
};

const farExpiry = () => Date.now() + 60 * 60 * 1000;

describe('sessionExpires', () => {
    it('closes an idling connection once the lead starts', async t => {
        const kit = await startImapKit(t);
        const client = await kit.connect({ sessionExpires: farExpiry() });
        const logs = closeLogs(client);
        const closing = closed(client);
        await client.mailboxOpen('INBOX');
        const { idling } = await startIdle(kit, client);
        // due after 100ms, forced only after 5 seconds
        rearm(client, 10 * 1000, 9900);
        await closing;
        await idling;

        assert.equal(client.usable, false);
        assert.equal(client.closedByClient, true, 'reported like close()');
        assert.equal(client.idlingAtClose, true);
        assert.deepEqual(logs, ['Closing connection before the session expires']);
    });

    it('waits while a mailbox lock is held, and closes once it is released', async t => {
        const kit = await startImapKit(t);
        const client = await kit.connect({ sessionExpires: farExpiry() });
        const logs = closeLogs(client);
        const lock = await client.getMailboxLock('INBOX');
        // due after 100ms, forced only after 5 seconds
        rearm(client, 10 * 1000, 9900);

        await sleep(400);
        assert.equal(client.usable, true, 'not closed under the lock holder');
        // the holder's commands still run
        await client.noop();

        const closing = closed(client);
        lock.release();
        await closing;
        assert.deepEqual(logs, ['Closing connection before the session expires']);
    });

    it('closes a connection busy to the end just before the expiry', async t => {
        const kit = await startImapKit(t);
        const client = await kit.connect({ sessionExpires: farExpiry() });
        const logs = closeLogs(client);
        const closing = closed(client);
        const lock = await client.getMailboxLock('INBOX');
        // due after 200ms, forced after 400ms (half the lead before the expiry)
        rearm(client, 600, 400);
        await closing;
        assert.deepEqual(logs, ['Closing busy connection, the session is about to expire']);
        lock.release();
    });

    it('does not close under a command that is waiting for IDLE to end', async t => {
        const kit = await startImapKit(t);
        // the expiry is far away, the due state is set by hand at the moment that matters
        const client = await kit.connect({ sessionExpires: farExpiry() });
        await client.mailboxOpen('INBOX');
        const { idling } = await startIdle(kit, client);

        // the NOOP first breaks IDLE, and is neither queued nor in flight until IDLE has ended
        const noop = client.noop();
        client._sessionExpiring = true;
        client.closeIfSessionExpiring();

        const closing = closed(client);
        await noop;
        await idling;
        await closing;
        assert.ok(kit.sent(/ NOOP$/), 'the NOOP reached the server before the close');
    });

    it('does not close under a command sent as soon as the previous one resolved', async t => {
        const kit = await startImapKit(t);
        const client = await kit.connect({ sessionExpires: farExpiry() });
        client._sessionExpiring = true;
        const closing = closed(client);

        await client.noop();
        // the previous NOOP finished and asked for a check, the connection is free for a moment
        await client.status('INBOX', { messages: true });
        await closing;
    });

    it('arms nothing without the option, for a verifyOnly connection, or before the expiry is due', async t => {
        const kit = await startImapKit(t);

        const plain = await kit.connect();
        assert.equal(plain._sessionDueTimer, undefined);

        const verify = await kit.connect({ verifyOnly: true, sessionExpires: farExpiry() });
        assert.equal(verify._sessionDueTimer, undefined);

        const later = await kit.connect({ sessionExpires: farExpiry() });
        assert.ok(later._sessionDueTimer);
        assert.equal(later._sessionDueTimer.hasRef(), false, 'a background timer does not keep the process alive');
        assert.equal(later._sessionCloseTimer.hasRef(), false);
        await later.noop();
        assert.equal(later.usable, true);
    });

    it('a connection closed earlier is left alone when the timers would have fired', async t => {
        const kit = await startImapKit(t);
        const client = await kit.connect({ sessionExpires: farExpiry() });
        const logs = closeLogs(client);
        rearm(client, 600, 400);
        await client.logout();
        await sleep(700);
        assert.deepEqual(logs, []);
    });
});
